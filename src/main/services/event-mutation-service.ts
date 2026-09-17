import crypto from 'node:crypto';

import {
  type EventActivity,
  isClosedStatus,
  sidecarFromDocument,
  type Event,
  type EventDocument,
  statusDefinitionsWithDefaults,
  type StatusDefinition,
} from "../../shared/events";
import { EventDocumentService } from "./event-document-service";

export type EventMutation = (document: EventDocument) => EventDocument;

export class EventMutationService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly documents: EventDocumentService) {}
  mutate(
    relativePath: string,
    mutation: EventMutation,
  ): Promise<EventDocument> {
    const run = this.queue.then(async () => {
      const state = await this.documents.load(relativePath);
      if (state.status !== "ready")
        throw new Error(`Todo document is not writable: ${state.status}`);
      const next = mutation(state.document);
      const now = new Date().toISOString();
      const touched = touchChanged(next, state.document, now);
      const target = { ...touched, relativePath };
      const entry = sidecarFromDocument(target, state.sidecar);
      entry.activities = [...(entry.activities ?? []), ...describeChanges(state.document, next, now)];
      return this.documents.write(relativePath, target, entry);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  replace(relativePath: string, document: EventDocument): Promise<EventDocument> {
    const run = this.queue.then(async () => {
      const state = await this.documents.load(relativePath);
      if (state.status !== "ready") throw new Error(`Todo document is not writable: ${state.status}`);
      const target = { ...document, relativePath };
      return this.documents.write(relativePath, target, sidecarFromDocument(target, state.sidecar));
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  addStatusDefinition(definition: StatusDefinition): Promise<void> {
    const run = this.queue.then(async () => {
      const name = definition.name.trim();
      if (!name) throw new Error("状态名称不能为空");
      const sidecar = await this.documents.readSidecar();
      const definitions = statusDefinitionsWithDefaults(sidecar.statusDefinitions);
      if (definitions.some((item) => item.name === name)) throw new Error("状态名称已存在");
      sidecar.statusDefinitions = [...definitions, { name, category: definition.category }];
      for (const document of Object.values(sidecar.documents)) document.statusDefinitions = sidecar.statusDefinitions;
      await this.documents.writeSidecar(sidecar);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function touchChanged(document: EventDocument, previous: EventDocument, now: string): EventDocument {
  const previousById = new Map<string, Event>();
  const collect = (events: Event[]) => {
    for (const event of events) {
      previousById.set(event.id, event);
      collect(event.children);
    }
  };
  collect([...previous.current, ...previous.closed]);

  const visit = (events: Event[]): Event[] =>
    events.map((event) => {
      const previousEvent = previousById.get(event.id);
      const changed = !previousEvent || eventContent(event) !== eventContent(previousEvent);
      const closed = isClosedStatus(event.status, document.statusDefinitions);
      return {
        ...event,
        ...(changed ? { updatedAt: now } : {}),
        ...(closed
          ? { closedAt: event.closedAt ?? previousEvent?.closedAt ?? now }
          : { closedAt: undefined }),
        children: visit(event.children),
      };
    });
  return {
    ...document,
    current: visit(document.current),
    closed: visit(document.closed),
  };
}

function eventContent(event: Event): string {
  const content = { ...event };
  delete content.createdAt;
  delete content.updatedAt;
  delete content.closedAt;
  return JSON.stringify(content);
}

function describeChanges(previous: EventDocument, next: EventDocument, at: string): EventActivity[] {
  const before = eventMap(previous);
  const after = eventMap(next);
  const activities: EventActivity[] = [];
  for (const [eventId, event] of after) {
    const old = before.get(eventId);
    if (!old) {
      activities.push(activity(eventId, at, 'created'));
      continue;
    }
    if (old.title !== event.title) activities.push(activity(eventId, at, 'title', old.title, event.title));
    if (old.note !== event.note) activities.push(activity(eventId, at, 'note', old.note, event.note));
    if (old.status !== event.status) activities.push(activity(eventId, at, 'status', old.status, event.status));
    if (old.deadline !== event.deadline) activities.push(activity(eventId, at, 'deadline', old.deadline, event.deadline));
    const addedTags = event.tags.filter((tag) => !old.tags.includes(tag));
    const removedTags = old.tags.filter((tag) => !event.tags.includes(tag));
    if (addedTags.length || removedTags.length) activities.push({ ...activity(eventId, at, 'tags'), ...(addedTags.length ? { addedTags } : {}), ...(removedTags.length ? { removedTags } : {}) });
  }
  return activities;
}

function eventMap(document: EventDocument): Map<string, Event> {
  const result = new Map<string, Event>();
  const visit = (events: Event[]) => events.forEach((event) => { result.set(event.id, event); visit(event.children); });
  visit([...document.current, ...document.closed]);
  return result;
}

function activity(eventId: string, at: string, type: EventActivity['type'], before?: string, after?: string): EventActivity {
  return { id: crypto.randomUUID(), eventId, at, type, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}
