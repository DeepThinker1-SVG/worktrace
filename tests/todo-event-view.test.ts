import { describe, expect, test } from 'vitest';

import type { Event } from '../src/shared/events';
import {
  buildTodoEventLocations,
  collectTodoTags,
  filterTodoEvents,
  countTodoEvents,
  countTodoEventsByStatus,
  filterTodoEventsByStatus,
} from '../src/renderer/todo-event-view';

const events: Event[] = [
  {
    id: 'root',
    title: 'Root context',
    status: '未开始',
    tags: [],
    note: '',
    sourceOrder: 0,
    children: [
      {
        id: 'match',
        title: 'Matching child',
        status: '阻塞',
        tags: [],
        note: '',
        sourceOrder: 1,
        children: [],
      },
      {
        id: 'hidden',
        title: 'Unrelated child',
        status: '进行中',
        tags: [],
        note: '',
        sourceOrder: 2,
        children: [],
      },
    ],
  },
];

describe('todo event view helpers', () => {
  test('counts nested events and statuses', () => {
    expect(countTodoEvents(events)).toBe(3);
    expect(Object.fromEntries(countTodoEventsByStatus(events))).toEqual({
      未开始: 1,
      阻塞: 1,
      进行中: 1,
    });
  });

  test('keeps ancestor context while excluding unrelated branches', () => {
    expect(filterTodoEventsByStatus(events, '阻塞')).toEqual([
      {
        ...events[0],
        children: [events[0].children[0]],
      },
    ]);
    expect(filterTodoEventsByStatus(events, '取消')).toEqual([]);
    expect(filterTodoEventsByStatus(events)).toEqual(events);
  });

  test('keeps full-tree locations available for filtered row actions', () => {
    expect(Object.fromEntries(buildTodoEventLocations(events))).toEqual({
      root: { index: 0, parentId: undefined, siblingCount: 1 },
      match: { index: 0, parentId: 'root', siblingCount: 2 },
      hidden: { index: 1, parentId: 'root', siblingCount: 2 },
    });
  });

  test('combines search, tag, and status filters while retaining context', () => {
    expect(filterTodoEvents(events, { query: 'matching', tag: undefined })).toEqual([
      { ...events[0], children: [events[0].children[0]] },
    ]);
    expect(filterTodoEvents(events, { status: '阻塞', tag: '不存在' })).toEqual([]);
    expect(collectTodoTags([
      { ...events[0], tags: ['Root'], children: [{ ...events[0].children[0], tags: ['Delivery', 'Root'] }] },
    ])).toEqual(['Delivery', 'Root']);
  });
});
