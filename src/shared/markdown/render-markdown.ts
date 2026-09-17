import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { toString } from 'mdast-util-to-string';

import type { HeadingNode, MarkdownNode, ParsedModule } from './markdown-types';
import type { ManagedFileStatus, MarkerStat, ModuleWindowData, RenderedHeadingNode } from '../workspace';

export function toModuleWindowData(
  filePath: string,
  module: ParsedModule,
  fileStatus: ManagedFileStatus = 'available',
  statusMessage?: string,
  markerColors: Record<string, string> = {},
  markerStats: MarkerStat[] = [],
): ModuleWindowData {
  return {
    moduleKey: module.moduleKey,
    filePath,
    fileStatus,
    statusMessage,
    title: module.title,
    rawTitle: module.rawTitle,
    titleMarkers: module.markers,
    markerColors,
    markerStats,
    leadingBodyMarkdown: nodesToMarkdown(module.leadingBody),
    headings: module.headings.map((heading) => toRenderedHeadingNode(module.moduleKey, heading, '')),
  };
}

function toRenderedHeadingNode(moduleKey: string, heading: HeadingNode, parentKey: string): RenderedHeadingNode {
  const viewKey = parentKey ? `${parentKey}/${heading.headingKey}` : heading.headingKey;

  return {
    viewKey,
    headingKey: heading.headingKey,
    nodeKey: `${moduleKey}@@${viewKey}`,
    depth: heading.depth,
    rawTitle: heading.rawTitle,
    title: heading.title,
    markers: heading.markers,
    bodyMarkdown: nodesToMarkdown(heading.body),
    bodyPreview: nodesToPreview(heading.body),
    children: heading.children.map((child) => toRenderedHeadingNode(moduleKey, child, viewKey)),
    source: heading.source,
  };
}

function nodesToMarkdown(nodes: MarkdownNode[]): string {
  if (nodes.length === 0) {
    return '';
  }

  return toMarkdown(
    {
      type: 'root',
      children: nodes,
    },
    {
      extensions: [gfmToMarkdown()],
    },
).trim();
}

function nodesToPreview(nodes: MarkdownNode[]): string {
  const text = toString({
    type: 'root',
    children: nodes,
  }).replace(/\s+/g, ' ').trim();

  return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}
