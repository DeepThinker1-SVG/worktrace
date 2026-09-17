import type { Heading, Root, RootContent, Text } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { toString } from 'mdast-util-to-string';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';

import { statusDefinitionsWithDefaults, type Event, type EventDocument, type EventStatus, type StatusDefinition, type TodoModuleRole } from './event-types';

const parser = unified().use(remarkParse).use(remarkGfm);
export function parseTodoMarkdown(markdown: string, relativePath?: string, definitions?: readonly StatusDefinition[]): EventDocument {
  const tree = parser.parse(markdown) as Root;
  const h1s = tree.children
    .map((node, index) => ({ node, index }))
    .filter((entry): entry is { node: Heading; index: number } => entry.node.type === 'heading' && entry.node.depth === 1);
  const statusDefinitions = statusDefinitionsWithDefaults(definitions);
  const document: EventDocument = { relativePath, current: [], closed: [], statusDefinitions };
  const hasTodoModules = h1s.some((entry) => moduleRole(entry.node));

  const allocator = { next: 1 };
  for (const [index, entry] of h1s.entries()) {
    const role = moduleRole(entry.node);
    if (!role) continue;
    const end = h1s[index + 1]?.index ?? tree.children.length;
    const roots = parseEvents(tree.children.slice(entry.index + 1, end), allocator);
    document[role].push(...roots);
  }
  if (!hasTodoModules) document.current = parseGenericMarkdownEvents(tree.children, allocator, relativePath);
  return document;
}
export function serializeTodoMarkdown(document: EventDocument): string {
  validateNotes(document.current.concat(document.closed));
  return ['# 当前', ...serializeEvents(document.current, 2), '# 已结束', ...serializeEvents(document.closed, 2)].join('\n\n').trimEnd() + '\n';
}

export function assertValidEventNote(note: string): void {
  const tree = parser.parse(note) as Root;
  if (tree.children.some((node) => node.type === 'heading')) throw new Error('事件备注不能包含 Markdown 标题');
}

function parseEvents(nodes: RootContent[], allocator: { next: number }): Event[] {
  const roots: Event[] = [];
  const stack: Array<{ event: Event; depth: number }> = [];
  const parsedNodes: Array<{ index: number; event: Event; depth: number }> = [];
  for (const [index, node] of nodes.entries()) {
    if (node.type !== 'heading' || node.depth < 2 || node.depth > 6) continue;
    const parsed = parseHeading(node);
    const eventNumber = allocator.next++;
    const event: Event = { ...parsed, id: `event-${eventNumber}`, children: [], sourceOrder: eventNumber - 1 };
    while (stack.length && stack.at(-1)!.depth >= node.depth) stack.pop();
    if (stack.length) stack.at(-1)!.event.children.push(event);
    else roots.push(event);
    parsedNodes.push({ index, event, depth: node.depth });
    stack.push({ event, depth: node.depth });
  }
  for (const parsed of parsedNodes) {
    const metadata = extractTagMetadata(bodyUntilNextEventHeading(nodes, parsed.index));
    parsed.event.tags = [...parsed.event.tags, ...metadata.tags];
    parsed.event.note = nodesToMarkdown(metadata.remaining);
  }
  return roots;
}

function parseGenericMarkdownEvents(nodes: RootContent[], allocator: { next: number }, relativePath?: string): Event[] {
  const headings = nodes
    .map((node, index) => ({ node, index }))
    .filter((entry): entry is { node: Heading; index: number } => entry.node.type === 'heading');
  const roots: Event[] = [];
  const stack: Array<{ event: Event; depth: number }> = [];
  const firstHeadingIndex = headings[0]?.index ?? nodes.length;
  const preface = nodes.slice(0, firstHeadingIndex);

  if (preface.length > 0) {
    const note = nodesToMarkdown(preface);
    if (note) {
      const title = relativePath?.split('/').at(-1)?.replace(/\.md$/i, '') || '未命名事项';
      const event: Event = { id: `event-${allocator.next++}`, title, status: '未开始', tags: [], note, children: [], sourceOrder: allocator.next - 2 };
      roots.push(event);
      stack.push({ event, depth: 0 });
    }
  }

  for (const [headingIndex, entry] of headings.entries()) {
    const nextIndex = headings[headingIndex + 1]?.index ?? nodes.length;
    const parsed = parseHeading(entry.node);
    const metadata = extractTagMetadata(nodes.slice(entry.index + 1, nextIndex));
    const eventNumber = allocator.next++;
    const event: Event = { ...parsed, id: `event-${eventNumber}`, children: [], sourceOrder: eventNumber - 1, tags: metadata.tags, note: nodesToMarkdown(metadata.remaining) };
    while (stack.length && stack.at(-1)!.depth >= entry.node.depth) stack.pop();
    if (stack.length) stack.at(-1)!.event.children.push(event);
    else roots.push(event);
    stack.push({ event, depth: entry.node.depth });
  }
  return roots;
}

function bodyUntilNextEventHeading(nodes: RootContent[], start: number): RootContent[] {
  const result: RootContent[] = [];
  for (const node of nodes.slice(start + 1)) {
    if (node.type === 'heading' && node.depth >= 2 && node.depth <= 6) break;
    result.push(node);
  }
  return result;
}

function parseHeading(node: Heading): Omit<Event, 'id' | 'children' | 'sourceOrder'> {
  const raw = toString(node).trim();
  const markers: string[] = [];
  let rest = raw;
  while (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) break;
    markers.push(rest.slice(1, close).trim());
    rest = rest.slice(close + 1).trimStart();
  }
  const status = (markers[0] ?? '未开始') as EventStatus;
  return { title: rest || '未命名标题', status, tags: markers.filter((marker) => marker !== status), note: '' };
}

function serializeEvents(events: Event[], depth: 1 | 2 | 3 | 4 | 5 | 6): string[] {
  return events.map((event) => {
    if (depth > 6) throw new Error('事件深度不能超过 H6');
    const headingMarkdown = serializeHeading(event, depth);
    const note = event.note.trim();
    const tags = event.tags.filter((tag) => tag.trim()).map((tag) => `#${tag.trim().replaceAll(/\s+/g, '-')}`).join(' ');
    const children = serializeEvents(event.children, (depth + 1) as 1 | 2 | 3 | 4 | 5 | 6);
    return [headingMarkdown, ...(tags ? [tags] : []), ...(note ? [note] : []), ...children].join('\n\n');
  });
}

function serializeHeading(event: Event, depth: 1 | 2 | 3 | 4 | 5 | 6): string {
  validateTitle(event.title);
  const titleNode = heading(event.title.trim() || '未命名标题', depth);
  const titleLine = toMarkdown({ type: 'root', children: [titleNode] }, { extensions: [gfmToMarkdown()] }).trim();
  const headingPrefix = '#'.repeat(depth);
  return `${headingPrefix} [${event.status}] ${titleLine.slice(headingPrefix.length).trimStart()}`;
}
function extractTagMetadata(nodes: RootContent[]): { tags: string[]; remaining: RootContent[] } {
  const first = nodes[0];
  if (!first || first.type !== 'paragraph') return { tags: [], remaining: nodes };
  const parts = toString(first).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.some((part) => !part.startsWith('#') || part.length === 1)) return { tags: [], remaining: nodes };
  return { tags: parts.map((part) => part.slice(1)), remaining: nodes.slice(1) };
}

function validateNotes(events: Event[]): void {
  for (const event of events) {
    assertValidEventNote(event.note);
    validateNotes(event.children);
  }
}

function validateTitle(title: string): void {
  if (title.trimStart().startsWith('[')) throw new Error('事件标题不能以 marker 形态开头');
}

function nodesToMarkdown(nodes: RootContent[]): string {
  return nodes.length ? toMarkdown({ type: 'root', children: nodes }, { extensions: [gfmToMarkdown()] }).trim() : '';
}

function heading(value: string, depth: 1 | 2 | 3 | 4 | 5 | 6): Heading {
  return { type: 'heading', depth, children: [{ type: 'text', value } as Text] };
}

function moduleRole(node: Heading): TodoModuleRole | undefined {
  const title = toString(node).trim();
  return title === '当前' ? 'current' : title === '已结束' ? 'closed' : undefined;
}

