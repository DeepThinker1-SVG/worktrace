export type ExtractedMarkers = {
  rawTitle: string;
  title: string;
  markers: string[];
};

export function extractLeadingMarkers(rawTitle: string): ExtractedMarkers {
  const markers: string[] = [];
  let cursor = rawTitle.trimStart();

  while (cursor.startsWith('[')) {
    const closeIndex = cursor.indexOf(']');

    if (closeIndex < 0) {
      break;
    }

    const marker = cursor.slice(1, closeIndex).trim();

    if (marker.length > 0) {
      markers.push(marker);
    }

    cursor = cursor.slice(closeIndex + 1).trimStart();
  }

  const title = cursor.trim();

  return {
    rawTitle,
    title: title.length > 0 ? title : '未命名标题',
    markers,
  };
}
