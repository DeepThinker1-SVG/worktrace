import crypto from "node:crypto";

import {
  isClosedStatus,
  type Event,
  type EventActivity,
  type EventDocument,
  type TodoModuleRole,
  statusDefinitionsWithDefaults,
  type StatusDefinition,
} from "./event-types";

export const TODO_SIDECAR_SCHEMA_VERSION = 1 as const;

export type EventIdentityNode = { id: string; children: EventIdentityNode[] };
export type EventMetadata = {
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  deadline?: string;
};
export type TodoSidecarDocument = {
  documentId: string;
  relativePath: string;
  modules: Record<TodoModuleRole, EventIdentityNode[]>;
  metadata: Record<string, EventMetadata>;
  activities?: EventActivity[];
  statusDefinitions?: StatusDefinition[];
};
export type TodoSidecar = {
  schemaVersion: typeof TODO_SIDECAR_SCHEMA_VERSION;
  documents: Record<string, TodoSidecarDocument>;
  statusDefinitions: StatusDefinition[];
};

export function emptySidecar(): TodoSidecar {
  return { schemaVersion: 1, documents: {}, statusDefinitions: statusDefinitionsWithDefaults() };
}

export function validateTodoSidecar(input: unknown): TodoSidecar {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 1 ||
    !isRecord(input.documents)
  )
    throw new Error("Invalid Todo sidecar: schemaVersion must be 1.");
  const documents: Record<string, TodoSidecarDocument> = {};
  for (const [key, value] of Object.entries(input.documents)) {
    if (
      !isRecord(value) ||
      typeof value.documentId !== "string" ||
      typeof value.relativePath !== "string" ||
      !isRecord(value.modules) ||
      !isRecord(value.metadata)
    )
      throw new Error(`Invalid Todo sidecar document: ${key}`);
    documents[key] = {
      documentId: value.documentId,
      relativePath: value.relativePath,
      modules: {
        current: validateNodes(value.modules.current),
        closed: validateNodes(value.modules.closed),
      },
      metadata: validateMetadata(value.metadata),
      activities: validateActivities(value.activities),
      statusDefinitions: statusDefinitionsWithDefaults(validateDefinitions(value.statusDefinitions)),
    };
  }
  return { schemaVersion: 1, documents, statusDefinitions: statusDefinitionsWithDefaults(validateDefinitions(input.statusDefinitions)) };
}

export function identityTree(events: Event[]): EventIdentityNode[] {
  return events.map((event) => ({
    id: event.id,
    children: identityTree(event.children),
  }));
}

export function applyIdentityTree(
  document: EventDocument,
  sidecar: TodoSidecarDocument,
): EventDocument {
  const apply = (
    events: Event[],
    nodes: EventIdentityNode[],
    role: TodoModuleRole,
  ): Event[] =>
    events.map((event, index) => {
      const node = nodes[index];
      if (!node || event.children.length !== node.children.length)
        throw new Error(`Todo identity tree mismatch in ${role}.`);
      const metadata = sidecar.metadata[node.id];
      if (!metadata) throw new Error(`Missing metadata for event ${node.id}.`);
      return {
        ...event,
        id: node.id,
        children: apply(event.children, node.children, role),
        ...metadata,
      };
    });
  if (
    document.current.length !== sidecar.modules.current.length ||
    document.closed.length !== sidecar.modules.closed.length
  )
    throw new Error(
      "Todo identity tree is not structurally identical to Markdown.",
    );
  const ids = [
    ...flatten(sidecar.modules.current),
    ...flatten(sidecar.modules.closed),
  ].map((node) => node.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("Todo identity IDs must be globally unique.");
  if (Object.keys(sidecar.metadata).some((id) => !ids.includes(id)))
    throw new Error("Todo metadata contains an orphan event ID.");
  const result: EventDocument = {
    ...document,
    statusDefinitions: statusDefinitionsWithDefaults(sidecar.statusDefinitions),
    documentId: sidecar.documentId,
    current: apply(document.current, sidecar.modules.current, "current"),
    closed: apply(document.closed, sidecar.modules.closed, "closed"),
  };
  return { ...result, activities: sidecar.activities ?? initialActivities(result, sidecar.metadata) };
}

export function sidecarFromDocument(
  document: EventDocument,
  previous?: TodoSidecarDocument,
  now = new Date().toISOString(),
): TodoSidecarDocument {
  const documentId = previous?.documentId ?? crypto.randomUUID();
  const metadata: Record<string, EventMetadata> = {
    ...(previous?.metadata ?? {}),
  };
  const visit = (events: Event[]) => {
    for (const event of events) {
      const old = metadata[event.id];
      const deadline = Object.prototype.hasOwnProperty.call(event, "deadline")
        ? event.deadline
        : old?.deadline;
      metadata[event.id] = {
        createdAt: event.createdAt ?? old?.createdAt ?? now,
        updatedAt: event.updatedAt ?? old?.updatedAt ?? now,
        ...(isClosedStatus(event.status, document.statusDefinitions) && (event.closedAt ?? old?.closedAt)
          ? { closedAt: event.closedAt ?? old?.closedAt }
          : {}),
        ...(deadline ? { deadline } : {}),
      };
      visit(event.children);
    }
  };
  visit([...document.current, ...document.closed]);
  for (const id of Object.keys(metadata))
    if (
      !new Set(
        [
          ...flatten(identityTree(document.current)),
          ...flatten(identityTree(document.closed)),
        ].map((node) => node.id),
      ).has(id)
    )
      delete metadata[id];
  return {
    documentId,
    relativePath: document.relativePath ?? previous?.relativePath ?? "",
    modules: {
      current: identityTree(document.current),
      closed: identityTree(document.closed),
    },
    metadata,
    activities: previous?.activities ?? initialActivities(document, metadata),
    statusDefinitions: statusDefinitionsWithDefaults(document.statusDefinitions ?? previous?.statusDefinitions),
  };
}

function flatten(nodes: EventIdentityNode[]): EventIdentityNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function validateNodes(input: unknown): EventIdentityNode[] {
  if (!Array.isArray(input)) throw new Error("Invalid Todo identity tree.");
  return input.map((node) => {
    if (!isRecord(node) || typeof node.id !== "string" || node.id.length === 0)
      throw new Error("Invalid Todo identity node.");
    return { id: node.id, children: validateNodes(node.children) };
  });
}
function validateMetadata(
  input: Record<string, unknown>,
): Record<string, EventMetadata> {
  const output: Record<string, EventMetadata> = {};
  for (const [id, value] of Object.entries(input)) {
    if (
      !isRecord(value) ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      (value.closedAt !== undefined && typeof value.closedAt !== "string") ||
      (value.deadline !== undefined && typeof value.deadline !== "string")
    )
      throw new Error(`Invalid Todo metadata: ${id}`);
    output[id] = value as EventMetadata;
  }
  return output;
}

function initialActivities(document: EventDocument, metadata: Record<string, EventMetadata>): EventActivity[] {
  const visit = (events: Event[]): EventActivity[] => events.flatMap((event) => [
    { id: `created-${event.id}`, eventId: event.id, at: event.createdAt ?? metadata[event.id]?.createdAt ?? new Date().toISOString(), type: 'created' as const },
    ...visit(event.children),
  ]);
  return visit([...document.current, ...document.closed]);
}

function validateActivities(input: unknown): EventActivity[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error('Invalid Todo sidecar activities.');
  return input.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.eventId !== 'string' || typeof value.at !== 'string' || !['created', 'title', 'note', 'tags', 'deadline', 'status', 'structure'].includes(String(value.type))) return [];
    return [{
      id: value.id,
      eventId: value.eventId,
      at: value.at,
      type: value.type as EventActivity['type'],
      ...(typeof value.before === 'string' ? { before: value.before } : {}),
      ...(typeof value.after === 'string' ? { after: value.after } : {}),
      ...(Array.isArray(value.addedTags) && value.addedTags.every((tag) => typeof tag === 'string') ? { addedTags: value.addedTags } : {}),
      ...(Array.isArray(value.removedTags) && value.removedTags.every((tag) => typeof tag === 'string') ? { removedTags: value.removedTags } : {}),
    }];
  });
}
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
function validateDefinitions(input: unknown): StatusDefinition[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error("Invalid Todo status definitions.");
  return input.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() || (item.category !== "current" && item.category !== "closed"))
      throw new Error("Invalid Todo status definition.");
    return { name: item.name.trim(), category: item.category };
  });
}
