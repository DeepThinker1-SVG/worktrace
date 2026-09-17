import {
  isClosedStatus,
  statusDefinitionsWithDefaults,
  type Event,
  type EventDocument,
  type EventStatus,
} from "./event-types";
import { assertValidEventNote } from "./todo-markdown";

export function createEvent(
  document: EventDocument,
  input: {
    title: string;
    status?: EventStatus;
    tags?: string[];
    note?: string;
    deadline?: string;
    createdAt?: string;
  },
): EventDocument {
  assertValidEventNote(input.note ?? "");
  validateTitle(input.title);
  validateStatus(input.status ?? "未开始", document);
  const event: Event = {
    id: nextId(document),
    title: input.title,
    status: input.status ?? "未开始",
    tags: input.tags ?? [],
    note: input.note ?? "",
    deadline: input.deadline,
    children: [],
    sourceOrder: 0,
    createdAt: input.createdAt,
  };
  return normalize({ ...document, current: [...document.current, event] });
}

export function updateTitle(
  document: EventDocument,
  id: string,
  title: string,
): EventDocument {
  validateTitle(title);
  return mapEvent(document, id, (event) => ({ ...event, title }));
}
export function updateStatus(
  document: EventDocument,
  id: string,
  status: EventStatus,
): EventDocument {
  validateStatus(status, document);
  const result = mapEvent(document, id, (event) => ({ ...event, status }));
  const found = findEvent(result, id);
  if (!found || found.parent || !document.closed.some((event) => event.id === id) || isClosedStatus(status, result.statusDefinitions)) return result;
  const removed = removeFrom(result.closed, id);
  return removed.event
    ? normalize({ ...result, closed: removed.rest, current: [...result.current, removed.event] })
    : result;
}
export function updateTags(
  document: EventDocument,
  id: string,
  tags: string[],
): EventDocument {
  return mapEvent(document, id, (event) => ({ ...event, tags: [...tags] }));
}
export function updateNote(
  document: EventDocument,
  id: string,
  note: string,
): EventDocument {
  assertValidEventNote(note);
  return mapEvent(document, id, (event) => ({ ...event, note }));
}
export function updateDeadline(
  document: EventDocument,
  id: string,
  deadline?: string,
): EventDocument {
  return mapEvent(document, id, (event) => ({ ...event, deadline }));
}
export function updateCreatedAt(document: EventDocument, id: string, createdAt: string): EventDocument {
  return mapEvent(document, id, (event) => ({ ...event, createdAt }));
}
export function updateClosedAt(document: EventDocument, id: string, closedAt: string): EventDocument {
  return mapEvent(document, id, (event) => ({ ...event, closedAt }));
}
export function deleteEvent(
  document: EventDocument,
  id: string,
): EventDocument {
  return mapRoots(document, (roots) => removeFrom(roots, id).rest);
}
export function archiveEvent(
  document: EventDocument,
  id: string,
): EventDocument {
  const removed = removeEverywhere(document, id);
  if (!removed.event) return document;
  return normalize({ ...removed.document, closed: [...removed.document.closed, removed.event] });
}
export function archiveExpiredRootEvents(
  document: EventDocument,
  now = Date.now(),
): EventDocument {
  const threshold = now - 24 * 60 * 60 * 1000;
  const expired = document.current.filter((event) =>
    isClosedStatus(event.status, document.statusDefinitions)
    && event.closedAt !== undefined
    && Date.parse(event.closedAt) <= threshold,
  );
  if (expired.length === 0) return document;
  const expiredIds = new Set(expired.map((event) => event.id));
  return normalize({
    ...document,
    current: document.current.filter((event) => !expiredIds.has(event.id)),
    closed: [...document.closed, ...expired],
  });
}

export function moveEvent(
  document: EventDocument,
  id: string,
  target: { parentId?: string; index?: number },
): EventDocument {
  const sourceRole = rootRole(document, id);
  const sourceEvent = findEvent(document, id)?.event;
  if (!sourceEvent) return document;
  if (target.parentId && !findEvent(document, target.parentId))
    throw new Error("目标父事件不存在");
  if (
    target.parentId &&
    (target.parentId === id || contains(sourceEvent, target.parentId))
  )
    return document;
  if (target.parentId) {
    const targetRole = rootRole(document, target.parentId);
    if (sourceRole && targetRole && sourceRole !== targetRole)
      throw new Error("子事件不能直接跨模块移动");
    if (eventDepth(document, target.parentId) + maxDepth(sourceEvent) > 6)
      throw new Error("事件深度不能超过 H6");
  }
  const removed = removeEverywhere(document, id);
  if (!removed.event) return document;
  const result = removed.document;
  if (!target.parentId) return insertRoot(result, removed.event, sourceRole ?? "current", target.index);
  return normalize(
    mapRoots(result, (roots) =>
      insertChild(roots, target.parentId!, removed.event!, target.index),
    ),
  );
}
export function indentEvent(
  document: EventDocument,
  id: string,
): EventDocument {
  if (eventDepth(document, id) >= 6) throw new Error("H6 事件不能继续缩进");
  const location = findLocation(document, id);
  if (!location || location.index === 0) return document;
  const previous = location.siblings[location.index - 1];
  return moveEvent(document, id, { parentId: previous.id });
}
export function outdentEvent(
  document: EventDocument,
  id: string,
): EventDocument {
  const location = findLocation(document, id);
  if (!location?.parent) return document;
  const grandparent = findEvent(document, location.parent.id)?.parent;
  return moveEvent(document, id, {
    parentId: grandparent?.id,
    index:
      (grandparent?.children ?? document[location.role]).findIndex(
        (event) => event.id === location.parent!.id,
      ) + 1,
  });
}
export function createChildEvent(
  document: EventDocument,
  parentId: string,
  input: {
    title: string;
    status?: EventStatus;
    tags?: string[];
    note?: string;
  },
): EventDocument {
  assertValidEventNote(input.note ?? "");
  validateTitle(input.title);
  validateStatus(input.status ?? "未开始", document);
  const parent = findEvent(document, parentId)?.event;
  if (!parent) return document;
  const depth = eventDepth(document, parentId);
  if (depth >= 6) throw new Error("事件深度不能超过 H6");
  const event: Event = {
    id: nextId(document),
    title: input.title,
    status: input.status ?? "未开始",
    tags: input.tags ?? [],
    note: input.note ?? "",
    children: [],
    sourceOrder: 0,
  };
  return normalize(
    mapEvent(document, parentId, (current) => ({
      ...current,
      children: [...current.children, event],
    })),
  );
}
export function createSiblingEvent(
  document: EventDocument,
  eventId: string,
  input: {
    title: string;
    status?: EventStatus;
    tags?: string[];
    note?: string;
  },
): EventDocument {
  assertValidEventNote(input.note ?? "");
  validateTitle(input.title);
  const location = findLocation(document, eventId);
  if (!location) return document;
  const status = input.status ?? "未开始";
  validateStatus(status, document);
  const event: Event = {
    id: nextId(document),
    title: input.title,
    status,
    tags: input.tags ?? [],
    note: input.note ?? "",
    children: [],
    sourceOrder: 0,
  };
  return mapRoots(document, (roots) => insertSiblingAfter(roots, eventId, event));
}
export const create = createEvent;
export const update = updateTitle;
export const remove = deleteEvent;

function mapEvent(
  document: EventDocument,
  id: string,
  change: (event: Event) => Event,
): EventDocument {
  return mapRoots(document, (roots) => mapTree(roots, id, change));
}
function mapTree(
  events: Event[],
  id: string,
  change: (event: Event) => Event,
): Event[] {
  return events.map((event) =>
    event.id === id
      ? change(event)
      : { ...event, children: mapTree(event.children, id, change) },
  );
}
function mapRoots(
  document: EventDocument,
  change: (roots: Event[]) => Event[],
): EventDocument {
  return normalize({
    ...document,
    current: change(document.current),
    closed: change(document.closed),
  });
}
function findEvent(
  document: EventDocument,
  id: string,
): { event: Event; parent?: Event } | undefined {
  const visit = (
    events: Event[],
    parent?: Event,
  ): { event: Event; parent?: Event } | undefined => {
    for (const event of events) {
      if (event.id === id) return { event, parent };
      const found = visit(event.children, event);
      if (found) return found;
    }
    return undefined;
  };
  return visit([...document.current, ...document.closed]);
}
function removeFrom(
  events: Event[],
  id: string,
): { rest: Event[]; event?: Event } {
  for (let i = 0; i < events.length; i++) {
    if (events[i].id === id)
      return {
        rest: [...events.slice(0, i), ...events.slice(i + 1)],
        event: events[i],
      };
    const nested = removeFrom(events[i].children, id);
    if (nested.event)
      return {
        rest: [
          ...events.slice(0, i),
          { ...events[i], children: nested.rest },
          ...events.slice(i + 1),
        ],
        event: nested.event,
      };
  }
  return { rest: events };
}
function removeEverywhere(
  document: EventDocument,
  id: string,
): { document: EventDocument; event?: Event } {
  const a = removeFrom(document.current, id);
  if (a.event)
    return { document: { ...document, current: a.rest }, event: a.event };
  const b = removeFrom(document.closed, id);
  return { document: { ...document, closed: b.rest }, event: b.event };
}
function insertRoot(
  document: EventDocument,
  event: Event,
  role: "current" | "closed",
  index?: number,
): EventDocument {
  const roots = document[role].slice();
  roots.splice(index ?? roots.length, 0, event);
  return normalize({ ...document, [role]: roots });
}
function insertChild(
  roots: Event[],
  parentId: string,
  event: Event,
  index?: number,
): Event[] {
  return roots.map((root) =>
    root.id === parentId
      ? { ...root, children: insertAt(root.children, event, index) }
      : {
          ...root,
          children: insertChild(root.children, parentId, event, index),
        },
  );
}
function insertAt(events: Event[], event: Event, index?: number): Event[] {
  const result = events.slice();
  result.splice(index ?? result.length, 0, event);
  return result;
}
function insertSiblingAfter(events: Event[], eventId: string, sibling: Event): Event[] {
  const index = events.findIndex((event) => event.id === eventId);
  if (index >= 0) {
    const result = events.slice();
    result.splice(index + 1, 0, sibling);
    return result;
  }
  return events.map((event) => ({
    ...event,
    children: insertSiblingAfter(event.children, eventId, sibling),
  }));
}
function nextId(document: EventDocument): string {
  const ids = new Set(
    collect(document.current)
      .concat(collect(document.closed))
      .map((event) => event.id),
  );
  let number = 1;
  while (ids.has(`event-${number}`)) number++;
  return `event-${number}`;
}
function collect(events: Event[]): Event[] {
  return events.flatMap((event) => [event, ...collect(event.children)]);
}
function contains(event: Event, id: string): boolean {
  return event.children.some((child) => child.id === id || contains(child, id));
}
function maxDepth(event: Event): number {
  return event.children.reduce(
    (max, child) => Math.max(max, 1 + maxDepth(child)),
    1,
  );
}
function rootRole(
  document: EventDocument,
  id: string,
): "current" | "closed" | undefined {
  for (const role of ["current", "closed"] as const) {
    if (document[role].some((root) => root.id === id || contains(root, id)))
      return role;
  }
  return undefined;
}
function eventDepth(document: EventDocument, id: string): number {
  let depth = 0;
  const visit = (events: Event[], current: number): boolean =>
    events.some((event) =>
      event.id === id
        ? ((depth = current), true)
        : visit(event.children, current + 1),
    );
  visit([...document.current, ...document.closed], 2);
  return depth;
}
function findLocation(
  document: EventDocument,
  id: string,
):
  | {
      role: "current" | "closed";
      siblings: Event[];
      index: number;
      parent?: Event;
    }
  | undefined {
  const visit = (
    events: Event[],
    role: "current" | "closed",
    parent?: Event,
  ):
    | {
        role: "current" | "closed";
        siblings: Event[];
        index: number;
        parent?: Event;
      }
    | undefined => {
    const index = events.findIndex((event) => event.id === id);
    if (index >= 0) return { role, siblings: events, index, parent };
    for (const event of events) {
      const found = visit(event.children, role, event);
      if (found) return found;
    }
    return undefined;
  };
  return visit(document.current, "current") ?? visit(document.closed, "closed");
}
function normalize(document: EventDocument): EventDocument {
  let order = 0;
  const visit = (events: Event[]): Event[] =>
    events.map((event) => {
      const normalized = { ...event, sourceOrder: order++ };
      return { ...normalized, children: visit(event.children) };
    });
  return {
    ...document,
    current: visit(document.current),
    closed: visit(document.closed),
  };
}
function validateTitle(title: string): void {
  if (title.includes("\r") || title.includes("\n"))
    throw new Error("事件标题必须是单行纯文本");
  if (title.trimStart().startsWith("["))
    throw new Error("事件标题不能以 marker 形态开头");
}
function validateStatus(status: EventStatus, document: EventDocument): void {
  if (!statusDefinitionsWithDefaults(document.statusDefinitions).some((definition) => definition.name === status)) throw new Error("未知事件状态");
}
