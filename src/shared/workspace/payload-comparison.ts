import type {
  MarkerStat,
  ModuleWindowData,
  RenderedHeadingNode,
} from './workspace-types';

export function markersEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

export function markerColorsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (let i = 0; i < aKeys.length; i++) {
    if (a[aKeys[i]] !== b[aKeys[i]]) {
      return false;
    }
  }

  return true;
}

export function markerStatsEqual(a: MarkerStat[], b: MarkerStat[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (
      a[i].name !== b[i].name ||
      a[i].count !== b[i].count ||
      a[i].color !== b[i].color ||
      a[i].automaticColor !== b[i].automaticColor
    ) {
      return false;
    }
  }

  return true;
}

export function headingNodeContentEqual(a: RenderedHeadingNode, b: RenderedHeadingNode): boolean {
  return (
    a.viewKey === b.viewKey &&
    a.headingKey === b.headingKey &&
    a.rawTitle === b.rawTitle &&
    a.title === b.title &&
    a.bodyMarkdown === b.bodyMarkdown &&
    a.depth === b.depth &&
    a.lastActivityAt === b.lastActivityAt &&
    markersEqual(a.markers, b.markers) &&
    headingsContentEqual(a.children, b.children)
  );
}

export function headingsContentEqual(a: RenderedHeadingNode[], b: RenderedHeadingNode[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (!headingNodeContentEqual(a[i], b[i])) {
      return false;
    }
  }

  return true;
}

export function modulesContentEqual(a: ModuleWindowData, b: ModuleWindowData): boolean {
  return (
    a.moduleKey === b.moduleKey &&
    a.title === b.title &&
    a.rawTitle === b.rawTitle &&
    a.leadingBodyMarkdown === b.leadingBodyMarkdown &&
    markersEqual(a.titleMarkers, b.titleMarkers) &&
    markerColorsEqual(a.markerColors, b.markerColors) &&
    markerStatsEqual(a.markerStats, b.markerStats) &&
    headingsContentEqual(a.headings, b.headings)
  );
}

export function mergeHeadings(
  previous: RenderedHeadingNode[],
  next: RenderedHeadingNode[],
): RenderedHeadingNode[] {
  if (previous.length !== next.length) {
    return next;
  }

  const result: RenderedHeadingNode[] = [];

  for (let i = 0; i < next.length; i++) {
    const prevHeading = previous[i];
    const nextHeading = next[i];

    if (!prevHeading || !headingNodeContentEqual(prevHeading, nextHeading)) {
      result.push(nextHeading);
      continue;
    }

    const mergedChildren = mergeHeadings(prevHeading.children, nextHeading.children);
    const childrenUnchanged = prevHeading.children.length === mergedChildren.length &&
      prevHeading.children.every((child, j) => child === mergedChildren[j]);

    if (childrenUnchanged) {
      result.push(prevHeading);
    } else {
      result.push({
        ...nextHeading,
        children: mergedChildren,
      });
    }
  }

  return result;
}
