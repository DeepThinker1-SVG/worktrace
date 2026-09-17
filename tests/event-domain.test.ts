import { describe, expect, it } from 'vitest';

import {
  archiveEvent,
  archiveExpiredRootEvents,
  createChildEvent,
  createEvent,
  createSiblingEvent,
  indentEvent,
  moveEvent,
  outdentEvent,
  parseTodoMarkdown,
  serializeTodoMarkdown,
  updateNote,
  updateStatus,
  updateTags,
  updateTitle,
  deleteEvent,
} from '../src/shared/events';
import type { EventDocument } from '../src/shared/events';

describe('Todo event Markdown round-trip', () => {
  it('imports generic Markdown headings into the current work plan without dropping body text', () => {
    const document = parseTodoMarkdown('# 计划\n\n概览。\n\n## 子项\n\n执行说明。\n');
    expect(document.current).toHaveLength(1);
    expect(document.current[0]).toMatchObject({ title: '计划', note: '概览。' });
    expect(document.current[0].children[0]).toMatchObject({ title: '子项', note: '执行说明。' });
  });

  it('parses and canonically serializes empty modules', () => {
    expect(serializeTodoMarkdown(parseTodoMarkdown('# 当前\n\n# 已结束\n'))).toBe('# 当前\n\n# 已结束\n');
  });

  it('keeps notes, tags, duplicate titles and five levels', () => {
    const document = parseTodoMarkdown(`# 当前

## [阻塞] [项目 A] [高优先] 重复

中文备注。

### [已完成] [子标签] 重复

English note.

#### L3

##### L4

###### L5

# 已结束

## [取消] 已结束事件
`);
    expect(document.current[0].title).toBe('重复');
    expect(document.current[0].tags).toEqual(['项目 A', '高优先']);
    expect(document.current[0].children[0].status).toBe('已完成');
    expect(document.current[0].children[0].children[0].children[0].children[0].title).toBe('L5');
    expect(document.closed[0].status).toBe('取消');
    const roundTrip = parseTodoMarkdown(serializeTodoMarkdown(document));
    expect(roundTrip.current[0].note).toContain('中文备注');
    expect(roundTrip.current[0].children[0].note).toContain('English note');
  });

  it('supports all statuses and writes tags as body metadata', () => {
    const statuses = ['未开始', '进行中', '等待', '阻塞', '已完成', '终止', '取消'] as const;
    const document = statuses.reduce<EventDocument>((current, status, index) => createEvent(current, { title: `事件 ${index}`, status, tags: ['标签'] }), { current: [], closed: [] });
    const markdown = serializeTodoMarkdown(document);
    for (const status of statuses) expect(markdown).toContain(`## [${status}] 事件`);
    expect(markdown).toContain('#标签');
    expect(parseTodoMarkdown(markdown).closed).toHaveLength(0);
    expect(parseTodoMarkdown(markdown).current).toHaveLength(7);
  });

  it('round-trips custom statuses and normalizes legacy heading tags', () => {
    const definitions = [{ name: '审阅中', category: 'current' as const }, { name: '已交付', category: 'closed' as const }];
    const document = parseTodoMarkdown('# 当前\n\n## [审阅中] [旧标签] 标题\n\n#新标签 #第二个\n\n备注\n', undefined, definitions);
    expect(document.current[0]).toMatchObject({ status: '审阅中', tags: ['旧标签', '新标签', '第二个'], note: '备注' });
    const serialized = serializeTodoMarkdown(document);
    expect(serialized).toContain('## [审阅中] 标题');
    expect(serialized).toContain('#旧标签 #新标签 #第二个');
    expect(serialized).not.toContain('[旧标签]');
    expect(parseTodoMarkdown(serialized, undefined, definitions).current[0].status).toBe('审阅中');
  });

  it('keeps a completed root current until it is archived', () => {
    let document = parseTodoMarkdown('# 当前\n\n## 任务\n\n备注\n\n### [等待] [子] 子任务\n\n子备注\n\n#### [阻塞] 孙任务\n\n孙备注\n');
    const root = document.current[0]; const child = root.children[0];
    const original = serializeTodoMarkdown(document);
    document = updateTitle(document, root.id, '新标题');
    document = updateTags(document, root.id, ['甲', '乙']);
    document = updateNote(document, root.id, '新备注');
    document = updateStatus(document, root.id, '已完成');
    expect(document.current).toHaveLength(1);
    expect(document.current[0].children[0]).toMatchObject({ id: child.id, title: '子任务', status: '等待', tags: ['子'], note: '子备注' });
    document = archiveEvent(document, root.id);
    expect(document.closed[0].children[0].children[0]).toMatchObject({ title: '孙任务', status: '阻塞', note: '孙备注', children: [] });
    expect(serializeTodoMarkdown(parseTodoMarkdown(original))).toBe(original);
  });

  it('supports create child, indent, outdent, move and delete', () => {
    let document = createEvent({ current: [], closed: [] }, { title: 'A' });
    document = createEvent(document, { title: 'B' });
    const a = document.current[0]; const b = document.current[1];
    document = indentEvent(document, b.id);
    expect(document.current[0].children[0].id).toBe(b.id);
    document = outdentEvent(document, b.id);
    document = createChildEvent(document, a.id, { title: 'C', note: 'note' });
    const c = document.current[0].children[0];
    document = moveEvent(document, c.id, { parentId: b.id });
    expect(document.current[1].children[0].title).toBe('C');
    document = deleteEvent(document, b.id);
    expect(document.current).toHaveLength(1);
  });

  it('rejects indentation beyond H6', () => {
    const document = parseTodoMarkdown('# 当前\n\n## A\n\n### B\n\n#### C\n\n##### D\n\n###### E\n\n###### E2\n');
    const e = document.current[0].children[0].children[0].children[0].children[0];
    expect(() => indentEvent(document, e.id)).toThrow('H6');
  });

  it('assigns exact parent and child notes without duplication', () => {
    const document = parseTodoMarkdown(`# 当前

## Parent

Parent note.

### Child

Child note.

#### Grandchild

Grandchild note.
`);
    const parent = document.current[0];
    expect(parent.note).toBe('Parent note.');
    expect(parent.children[0].note).toBe('Child note.');
    expect(parent.children[0].children[0].note).toBe('Grandchild note.');
    const reparsed = parseTodoMarkdown(serializeTodoMarkdown(document));
    expect(reparsed.current[0].note).toBe('Parent note.');
    expect(reparsed.current[0].children[0].note).toBe('Child note.');
    expect(reparsed.current[0].children[0].children[0].note).toBe('Grandchild note.');
  });

  it('keeps note escapes, links and code blocks isolated from marker normalization', () => {
    const note = ['Use \\[literal\\] and [a link](https://example.com).', '', '```', '\\[inside code\\]', '```'].join('\n');
    const document = parseTodoMarkdown(`# 当前

## [等待] [标签] 标题

${note}
`);
    const serialized = serializeTodoMarkdown(document);
    expect(serialized).toContain('Use \\[literal]');
    expect(serialized).toContain('[a link](https://example.com)');
    expect(serialized).toContain('\\[inside code\\]');
    expect(parseTodoMarkdown(serialized).current[0].note).toContain('Use \\[literal]');
  });

  it('uses unique ids across modules and after deletion, and maintains preorder sourceOrder', () => {
    let document = parseTodoMarkdown('# 当前\n\n## A\n\n### A child\n\n# 已结束\n\n## B\n');
    const ids = [document.current[0].id, document.current[0].children[0].id, document.closed[0].id];
    expect(new Set(ids).size).toBe(3);
    document = deleteEvent(document, document.current[0].children[0].id);
    document = createEvent(document, { title: 'C' });
    expect(new Set([document.current[0].id, document.current[1].id, document.closed[0].id]).size).toBe(3);
    expect([document.current[0].sourceOrder, document.current[1].sourceOrder, document.closed[0].sourceOrder]).toEqual([0, 1, 2]);
    document = moveEvent(document, document.current[1].id, { index: 0 });
    expect(document.current.map((event) => event.sourceOrder)).toEqual([0, 1]);
  });

  it('rejects direct cross-module child moves and allows archived children to become ended roots', () => {
    let document = parseTodoMarkdown('# 当前\n\n## Open\n\n### Child\n\n# 已结束\n\n## Closed\n\n### Closed child\n');
    const open = document.current[0]; const child = open.children[0]; const closed = document.closed[0];
    const before = serializeTodoMarkdown(document);
    expect(() => moveEvent(document, child.id, { parentId: closed.id })).toThrow('跨模块');
    expect(serializeTodoMarkdown(document)).toBe(before);
    document = outdentEvent(document, child.id);
    document = updateStatus(document, child.id, '已完成');
    expect(document.current.some((event) => event.id === child.id)).toBe(true);
    document = archiveEvent(document, child.id);
    expect(document.closed.some((event) => event.id === child.id)).toBe(true);
    expect(document.closed.find((event) => event.id === child.id)?.title).toBe('Child');
  });

  it('inserts a sibling immediately after the selected event', () => {
    let document = createEvent({ current: [], closed: [] }, { title: 'A' });
    document = createChildEvent(document, document.current[0].id, { title: 'A child' });
    document = createEvent(document, { title: 'B' });
    const a = document.current[0];
    const created = createSiblingEvent(document, a.id, { title: 'A sibling' });
    expect(created.current.map((event) => event.title)).toEqual(['A', 'A sibling', 'B']);
    expect(created.current[0].children[0].title).toBe('A child');
  });

  it('archives only completed current roots after one day and never auto-archives children', () => {
    const completedAt = '2026-09-06T08:00:00.000Z';
    const document: EventDocument = {
      current: [{ id: 'root', title: 'Root', status: '已完成', tags: [], note: '', sourceOrder: 0, closedAt: completedAt, children: [
        { id: 'child', title: 'Child', status: '已完成', tags: [], note: '', sourceOrder: 1, closedAt: completedAt, children: [] },
      ] }],
      closed: [],
    };
    const beforeDue = archiveExpiredRootEvents(document, Date.parse('2026-09-07T07:59:59.999Z'));
    expect(beforeDue.current).toHaveLength(1);
    const archived = archiveExpiredRootEvents(document, Date.parse('2026-09-07T08:00:00.000Z'));
    expect(archived.current).toHaveLength(0);
    expect(archived.closed[0]).toMatchObject({ id: 'root', children: [{ id: 'child', status: '已完成' }] });
  });

  it('keeps child status in place and reopens a closed root at current-module end', () => {
    let document = parseTodoMarkdown('# 当前\n\n## Open\n\n### Child\n\n# 已结束\n\n## Closed\n\n### Closed child\n');
    const child = document.current[0].children[0];
    document = updateStatus(document, child.id, '已完成');
    expect(document.current).toHaveLength(1);
    expect(document.current[0].children[0].status).toBe('已完成');
    const closedRoot = document.closed[0];
    document = updateStatus(document, closedRoot.id, '进行中');
    expect(document.current.map((event) => event.title)).toEqual(['Open', 'Closed']);
    expect(document.current[1].children[0]).toMatchObject({ title: 'Closed child' });
  });

  it('rejects heading notes, marker-shaped titles, missing move targets and excessive subtree depth', () => {
    const empty: EventDocument = { current: [], closed: [] };
    expect(() => createEvent(empty, { title: 'A', note: '# module heading' })).toThrow('备注');
    expect(() => createEvent(empty, { title: '[ambiguous]' })).toThrow('marker');
    const titleDocument = createEvent(empty, { title: String.raw`修复 *星号* 与 _下划线_ \[字面\]` });
    expect(parseTodoMarkdown(serializeTodoMarkdown(titleDocument)).current[0].title).toBe(String.raw`修复 *星号* 与 _下划线_ \[字面\]`);
    expect(() => createEvent(empty, { title: '换\n行' })).toThrow('单行');
    const document = createEvent(empty, { title: 'A' });
    const before = serializeTodoMarkdown(document);
    expect(() => moveEvent(document, document.current[0].id, { parentId: 'missing' })).toThrow('不存在');
    expect(serializeTodoMarkdown(document)).toBe(before);
    expect(() => updateNote(document, document.current[0].id, '## invalid')).toThrow('备注');
    expect(() => createChildEvent(document, document.current[0].id, { title: 'B', note: '### invalid' })).toThrow('备注');
    const deep = parseTodoMarkdown('# 当前\n\n## A\n\n### B\n\n#### C\n\n##### D\n\n###### E\n\n## Target\n');
    expect(() => moveEvent(deep, deep.current[0].id, { parentId: deep.current[1].id })).toThrow('H6');
    expect(() => serializeTodoMarkdown({ current: [{ ...deep.current[0], note: '## invalid' }], closed: [] })).toThrow('备注');
  });

  it('moves a complete nested subtree while preserving identity and sibling order', () => {
    let document = parseTodoMarkdown(`# 当前

## A

### A child

#### A grandchild

## B

### B child
`);
    const a = document.current[0];
    const child = a.children[0];
    const grandchild = child.children[0];
    const b = document.current[1];
    document = moveEvent(document, child.id, { parentId: b.id });
    expect(document.current[0].children).toHaveLength(0);
    expect(document.current[1].children[1]).toMatchObject({ id: child.id, title: 'A child' });
    expect(document.current[1].children[1].children[0]).toMatchObject({ id: grandchild.id, title: 'A grandchild' });
    document = moveEvent(document, child.id, { parentId: a.id });
    expect(document.current[0].children[0].children[0].id).toBe(grandchild.id);
  });
});
