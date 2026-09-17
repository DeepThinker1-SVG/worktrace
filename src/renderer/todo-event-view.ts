import type { Event } from '../shared/events';

export type TodoEventLocation = {
  index: number;
  parentId?: string;
  siblingCount: number;
};

export function countTodoEvents(events: readonly Event[]): number {
  return events.reduce((count, event) => count + 1 + countTodoEvents(event.children), 0);
}

export function countTodoEventsByStatus(events: readonly Event[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
    for (const [status, count] of countTodoEventsByStatus(event.children)) {
      counts.set(status, (counts.get(status) ?? 0) + count);
    }
  }

  return counts;
}

export function filterTodoEventsByStatus(events: readonly Event[], status?: string): Event[] {
  if (!status) {
    return [...events];
  }

  return events.flatMap((event) => {
    const children = filterTodoEventsByStatus(event.children, status);
    if (event.status !== status && children.length === 0) {
      return [];
    }

    return [{ ...event, children }];
  });
}

export type TodoEventFilter = {
  status?: string;
  tag?: string;
  query?: string;
};

/**
 * Produces a tree suitable for rendering a narrowed work plan. Matching leaves
 * remain in place and their ancestors are retained for orientation.
 */
export function filterTodoEvents(events: readonly Event[], filter: TodoEventFilter): Event[] {
  const query = filter.query?.trim().toLocaleLowerCase();
  const matches = (event: Event) => {
    if (filter.status && event.status !== filter.status) return false;
    if (filter.tag && !event.tags.includes(filter.tag)) return false;
    if (!query) return true;
    return [event.title, event.note, ...event.tags]
      .some((value) => value.toLocaleLowerCase().includes(query));
  };

  const visit = (siblings: readonly Event[]): Event[] => siblings.flatMap((event) => {
    const children = visit(event.children);
    return matches(event) || children.length > 0 ? [{ ...event, children }] : [];
  });

  return visit(events);
}

export function collectTodoTags(events: readonly Event[]): string[] {
  return [...new Set(events.flatMap((event) => [...event.tags, ...collectTodoTags(event.children)]))]
    .sort((left, right) => left.localeCompare(right));
}

export function buildTodoEventLocations(events: readonly Event[]): Map<string, TodoEventLocation> {
  const locations = new Map<string, TodoEventLocation>();

  function visit(siblings: readonly Event[], parentId?: string) {
    siblings.forEach((event, index) => {
      locations.set(event.id, { index, parentId, siblingCount: siblings.length });
      visit(event.children, event.id);
    });
  }

  visit(events);
  return locations;
}
