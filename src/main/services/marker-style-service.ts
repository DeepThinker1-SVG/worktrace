import type { MarkerStat, MarkerStyle, StylesConfig } from '../../shared/workspace';
import type { ParsedFile, ParsedModule } from '../../shared/markdown';

export const markerPalette = [
  '#2f9b5f',
  '#36a89a',
  '#3576d3',
  '#4a9bd8',
  '#7b61d1',
  '#9b59b6',
  '#d98b33',
  '#e6b450',
  '#d94c4c',
  '#e06c75',
  '#8a94a3',
  '#929aa6',
];

export function ensureMarkerStylesForFile(
  styles: StylesConfig,
  relativePath: string,
  parsedFile: ParsedFile | undefined,
): { styles: StylesConfig; changed: boolean } {
  if (!parsedFile) {
    return { styles, changed: false };
  }

  const nextStyles: StylesConfig = {
    schemaVersion: 1,
    files: { ...styles.files },
  };
  const existingFileStyles = nextStyles.files[relativePath] ?? { markers: {} };
  const markers = { ...existingFileStyles.markers };
  let changed = false;

  for (const markerName of collectFileMarkers(parsedFile)) {
    if (!markers[markerName]) {
      markers[markerName] = { autoColor: assignAutoColor(relativePath, markerName) };
      changed = true;
    }
  }

  if (changed || !nextStyles.files[relativePath]) {
    nextStyles.files[relativePath] = { markers };
  }

  return { styles: nextStyles, changed };
}

export function getMarkerColors(styles: StylesConfig, relativePath: string): Record<string, string> {
  const markers = styles.files[relativePath]?.markers ?? {};

  return Object.fromEntries(
    Object.entries(markers).map(([markerName, style]) => [markerName, style.colorOverride ?? style.autoColor]),
  );
}

export function setMarkerColorOverride(
  styles: StylesConfig,
  relativePath: string,
  markerName: string,
  color: string | null,
): StylesConfig {
  const fileStyles = styles.files[relativePath] ?? { markers: {} };
  const previous = fileStyles.markers[markerName] ?? {
    autoColor: assignAutoColor(relativePath, markerName),
  };
  const nextStyle: MarkerStyle = {
    autoColor: previous.autoColor,
    ...(color ? { colorOverride: color.toLowerCase() } : {}),
  };

  return {
    schemaVersion: 1,
    files: {
      ...styles.files,
      [relativePath]: {
        markers: {
          ...fileStyles.markers,
          [markerName]: nextStyle,
        },
      },
    },
  };
}

export function buildModuleMarkerStats(
  styles: StylesConfig,
  relativePath: string,
  module: ParsedModule,
): MarkerStat[] {
  const counts = new Map<string, number>();
  const fileStyles = styles.files[relativePath]?.markers ?? {};

  collectModuleHeadingMarkers(module).forEach((markerName) => {
    counts.set(markerName, (counts.get(markerName) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0], 'zh-Hans-CN'))
    .map(([name, count]) => {
      const style = fileStyles[name] ?? { autoColor: markerPalette[0] };

      return {
        name,
        count,
        color: style.colorOverride ?? style.autoColor,
        automaticColor: style.autoColor,
        ...(style.colorOverride ? { overrideColor: style.colorOverride } : {}),
      };
    });
}

function collectFileMarkers(parsedFile: ParsedFile): string[] {
  return unique(parsedFile.modules.flatMap((module) => [...module.markers, ...collectModuleHeadingMarkers(module)]));
}

function collectModuleHeadingMarkers(module: ParsedModule): string[] {
  const markers: string[] = [];

  markers.push(...module.markers);

  for (const heading of module.headings) {
    markers.push(...heading.markers);
    markers.push(...collectHeadingMarkers(heading.children));
  }

  return markers;
}

function collectHeadingMarkers(headings: ParsedModule['headings']): string[] {
  return headings.flatMap((heading) => [...heading.markers, ...collectHeadingMarkers(heading.children)]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function assignAutoColor(relativePath: string, markerName: string): string {
  const hash = [...`${relativePath}:${markerName}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);

  return markerPalette[hash % markerPalette.length];
}
