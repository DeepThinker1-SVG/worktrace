import type { WindowBounds } from './workspace-types';

export type WindowWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function ensureWindowBoundsVisible(
  bounds: WindowBounds | undefined,
  workAreas: WindowWorkArea[],
): WindowBounds | undefined {
  if (!bounds) {
    return undefined;
  }

  const visible = workAreas.some((area) => {
    const right = bounds.x === undefined ? area.x + bounds.width : bounds.x + bounds.width;
    const bottom = bounds.y === undefined ? area.y + bounds.height : bounds.y + bounds.height;

    return (
      bounds.x !== undefined &&
      bounds.y !== undefined &&
      bounds.x < area.x + area.width &&
      right > area.x &&
      bounds.y < area.y + area.height &&
      bottom > area.y
    );
  });

  if (visible) {
    return bounds;
  }

  const primary = workAreas[0];

  if (!primary) {
    return bounds;
  }

  return {
    x: primary.x + 24,
    y: primary.y + 24,
    width: Math.min(bounds.width, primary.width),
    height: Math.min(bounds.height, primary.height),
  };
}
