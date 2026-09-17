import type { Heading, Root, RootContent } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';

import { extractLeadingMarkers } from './extract-markers';
import type { HeadingNode, MarkdownNode, ParsedFile, ParsedModule } from './markdown-types';

type ModuleSlice = {
  heading?: Heading;
  occurrence: number;
  nodes: RootContent[];
};

type HeadingFrame = {
  node: HeadingNode;
  siblingCounts: Map<string, number>;
};

export function parseMarkdownFile(markdown: string, relativePath: string, parsedAt = Date.now()): ParsedFile {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const modules = buildModules(tree.children, relativePath);
  const markerSet = new Set<string>();

  for (const module of modules) {
    collectMarkers(module.headings, markerSet);
  }

  return {
    relativePath,
    modules,
    markers: [...markerSet].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    parsedAt,
  };
}

function buildModules(children: RootContent[], relativePath: string): ParsedModule[] {
  const h1Indexes = children
    .map((node, index) => ({ node, index }))
    .filter((entry): entry is { node: Heading; index: number } => isHeading(entry.node, 1));

  if (h1Indexes.length === 0) {
    return [
      createDocumentModule({
        relativePath,
        nodes: children,
      }),
    ];
  }

  const modules: ParsedModule[] = [];

  if (h1Indexes[0].index > 0) {
    const preH1Nodes = children.slice(0, h1Indexes[0].index);

    if (hasDisplayableContent(preH1Nodes)) {
      modules.push(
        createDocumentModule({
          relativePath,
          nodes: preH1Nodes,
        }),
      );
    }
  }

  if (h1Indexes.length === 1) {
    const h1 = h1Indexes[0].node;
    const afterH1 = children.slice(h1Indexes[0].index + 1);

    modules.push(
      createH1Module({
        relativePath,
        slice: {
          heading: h1,
          occurrence: 0,
          nodes: afterH1,
        },
      }),
    );
  } else {
    const seenTitles = new Map<string, number>();

    for (const [index, entry] of h1Indexes.entries()) {
      const nextH1Index = h1Indexes[index + 1]?.index ?? children.length;
      const rawTitle = toString(entry.node);
      const { title } = extractLeadingMarkers(rawTitle);
      const occurrence = seenTitles.get(title) ?? 0;

      seenTitles.set(title, occurrence + 1);

      modules.push(
        createH1Module({
          relativePath,
          slice: {
            heading: entry.node,
            occurrence,
            nodes: children.slice(entry.index + 1, nextH1Index),
          },
        }),
      );
    }
  }

  return modules;
}

function createDocumentModule(input: { relativePath: string; nodes: RootContent[] }): ParsedModule {
  const title = fileNameDisplay(input.relativePath);

  return {
    moduleKey: `${input.relativePath}::document::0`,
    rawTitle: title,
    title,
    markers: [],
    source: {
      kind: 'document',
      occurrence: 0,
      lineStart: input.nodes[0]?.position?.start.line,
      lineEnd: input.nodes.at(-1)?.position?.end.line,
    },
    ...buildHeadingTree(input.nodes),
  };
}

function createH1Module(input: { relativePath: string; slice: ModuleSlice }): ParsedModule {
  const heading = input.slice.heading;
  const rawTitle = heading ? toString(heading) : fileNameDisplay(input.relativePath);
  const { title, markers } = extractLeadingMarkers(rawTitle);

  return {
    moduleKey: `${input.relativePath}::${title}::${input.slice.occurrence}`,
    rawTitle,
    title,
    markers,
    source: {
      kind: 'h1',
      occurrence: input.slice.occurrence,
      lineStart: heading?.position?.start.line,
      lineEnd: input.slice.nodes.at(-1)?.position?.end.line ?? heading?.position?.end.line,
    },
    ...buildHeadingTree(input.slice.nodes),
  };
}

function buildHeadingTree(nodes: RootContent[]): Pick<ParsedModule, 'headings' | 'leadingBody'> {
  const leadingBody: MarkdownNode[] = [];
  const headings: HeadingNode[] = [];
  const stack: HeadingFrame[] = [];
  const rootCounts = new Map<string, number>();

  for (const node of nodes) {
    if (!isHeading(node)) {
      const current = stack.at(-1)?.node;

      if (current) {
        current.body.push(node);
      } else {
        leadingBody.push(node);
      }

      continue;
    }

    const headingNode = createHeadingNode(node);

    while (stack.length > 0 && stack.at(-1)!.node.depth >= headingNode.depth) {
      stack.pop();
    }

    const parentFrame = stack.at(-1);

    if (parentFrame) {
      headingNode.headingKey = createHeadingKey(parentFrame.siblingCounts, headingNode.title);
      parentFrame.node.children.push(headingNode);
    } else {
      headingNode.headingKey = createHeadingKey(rootCounts, headingNode.title);
      headings.push(headingNode);
    }

    stack.push({
      node: headingNode,
      siblingCounts: new Map<string, number>(),
    });
  }

  return { headings, leadingBody };
}

function createHeadingNode(heading: Heading): HeadingNode {
  const rawTitle = toString(heading);
  const { title, markers } = extractLeadingMarkers(rawTitle);

  return {
    headingKey: title,
    depth: heading.depth,
    rawTitle,
    title,
    markers,
    body: [],
    children: [],
    source: {
      lineStart: heading.position?.start.line,
      lineEnd: heading.position?.end.line,
    },
  };
}

function createHeadingKey(siblingCounts: Map<string, number>, title: string): string {
  const occurrence = siblingCounts.get(title) ?? 0;
  siblingCounts.set(title, occurrence + 1);

  return occurrence === 0 ? title : `${title}#${occurrence}`;
}

function collectMarkers(headings: HeadingNode[], markerSet: Set<string>) {
  for (const heading of headings) {
    for (const marker of heading.markers) {
      markerSet.add(marker);
    }

    collectMarkers(heading.children, markerSet);
  }
}

function isHeading(node: RootContent, depth?: Heading['depth']): node is Heading {
  return node.type === 'heading' && (depth === undefined || node.depth === depth);
}

function fileNameDisplay(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').split('/').at(-1) ?? relativePath;
}

function hasDisplayableContent(nodes: RootContent[]): boolean {
  const text = toString({
    type: 'root',
    children: nodes,
  }).trim();

  return text.length > 0;
}
