import type { RenderedHeadingNode } from './workspace-types';

export function filterHeadingsByMarker(
  headings: RenderedHeadingNode[],
  markerName: string,
): RenderedHeadingNode[] {
  return headings.flatMap((heading) => filterHeadingByMarker(heading, markerName));
}

function filterHeadingByMarker(
  heading: RenderedHeadingNode,
  markerName: string,
): RenderedHeadingNode[] {
  if (heading.markers.includes(markerName)) {
    return [heading];
  }

  const children = filterHeadingsByMarker(heading.children, markerName);

  if (children.length === 0) {
    return [];
  }

  return [{ ...heading, children }];
}
