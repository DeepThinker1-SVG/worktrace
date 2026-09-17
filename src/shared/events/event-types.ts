export type EventStatus = string;
export type TodoModuleRole = "current" | "closed";
export type StatusDefinition = { name: EventStatus; category: TodoModuleRole };
export type EventActivity = {
  id: string;
  eventId: string;
  at: string;
  type: 'created' | 'title' | 'note' | 'tags' | 'deadline' | 'status' | 'structure';
  before?: string;
  after?: string;
  addedTags?: string[];
  removedTags?: string[];
};
export type Event = {
  id: string; title: string; status: EventStatus; tags: string[]; note: string;
  children: Event[]; sourceOrder: number; createdAt?: string; updatedAt?: string;
  closedAt?: string; deadline?: string;
};
export type EventDocument = {
  documentId?: string; relativePath?: string; current: Event[]; closed: Event[];
  statusDefinitions?: StatusDefinition[];
  activities?: EventActivity[];
};
export const DEFAULT_STATUS_DEFINITIONS: readonly StatusDefinition[] = [
  { name: "未开始", category: "current" }, { name: "进行中", category: "current" },
  { name: "等待", category: "current" }, { name: "阻塞", category: "current" },
  { name: "已完成", category: "closed" }, { name: "终止", category: "closed" },
  { name: "取消", category: "closed" },
];
export const EVENT_STATUSES: readonly EventStatus[] = DEFAULT_STATUS_DEFINITIONS.map((definition) => definition.name);
export function statusDefinitionsWithDefaults(definitions?: readonly StatusDefinition[]): StatusDefinition[] {
  const result = DEFAULT_STATUS_DEFINITIONS.map((definition) => ({ ...definition }));
  for (const definition of definitions ?? []) if (!result.some((item) => item.name === definition.name)) result.push({ ...definition });
  return result;
}
export function categoryForStatus(status: EventStatus, definitions?: readonly StatusDefinition[]): TodoModuleRole {
  return statusDefinitionsWithDefaults(definitions).find((item) => item.name === status)?.category ?? "current";
}
export function isClosedStatus(status: EventStatus, definitions?: readonly StatusDefinition[]): boolean {
  return categoryForStatus(status, definitions) === "closed";
}
