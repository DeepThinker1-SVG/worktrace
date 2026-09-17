import type { RootContent } from 'mdast';

export type MarkdownNode = RootContent;

export type ParsedFile = {
  relativePath: string;
  modules: ParsedModule[];
  markers: string[];
  parsedAt: number;
};

export type ParsedModule = {
  moduleKey: string;
  rawTitle: string;
  title: string;
  markers: string[];
  source: {
    kind: 'document' | 'h1';
    occurrence: number;
    lineStart?: number;
    lineEnd?: number;
  };
  headings: HeadingNode[];
  leadingBody: MarkdownNode[];
};

export type HeadingNode = {
  headingKey: string;
  depth: number;
  rawTitle: string;
  title: string;
  markers: string[];
  body: MarkdownNode[];
  children: HeadingNode[];
  source: {
    lineStart?: number;
    lineEnd?: number;
  };
};
