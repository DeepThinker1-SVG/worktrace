import type { ManagedFileState } from './workspace-types';

export type ManagedFileGroup = {
  key: string;
  label: string;
  files: ManagedFileState[];
};

export function groupManagedFiles(files: ManagedFileState[], showHiddenFiles: boolean): ManagedFileGroup[] {
  const visibleFiles = files.filter((file) => showHiddenFiles || !file.hidden);
  const pinnedFiles = sortFiles(visibleFiles.filter((file) => file.source === 'repository' && file.pinned));
  const groups = new Map<string, ManagedFileState[]>();

  for (const file of visibleFiles) {
    if (file.source === 'repository' && file.pinned) {
      continue;
    }

    const key = fileFolderPath(file.path);
    const groupFiles = groups.get(key) ?? [];

    groupFiles.push(file);
    groups.set(key, groupFiles);
  }

  const result: ManagedFileGroup[] = [];

  if (pinnedFiles.length > 0) {
    result.push({ key: '__pinned__', label: '置顶', files: pinnedFiles });
  }

  return [
    ...result,
    ...[...groups.entries()]
      .map(([key, groupFiles]) => ({
        key,
        label: groupLabel(key),
        files: sortFiles(groupFiles),
      }))
      .sort((left, right) => compareGroupKeys(left.key, right.key)),
  ];
}

function sortFiles(files: ManagedFileState[]): ManagedFileState[] {
  return [...files].sort((left, right) => fileDisplayName(left.path).localeCompare(fileDisplayName(right.path), 'zh-Hans-CN'));
}

function compareGroupKeys(left: string, right: string): number {
  const leftRank = groupRank(left);
  const rightRank = groupRank(right);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.localeCompare(right, 'zh-Hans-CN');
}

function groupRank(key: string): number {
  if (key === 'workboard' || key.startsWith('workboard/')) {
    return 0;
  }

  if (key === '') {
    return 1;
  }

  return 2;
}

function groupLabel(key: string): string {
  if (key === '') {
    return '根目录';
  }

  return key;
}

function fileFolderPath(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');

  return index === -1 ? '' : normalized.slice(0, index);
}

function fileDisplayName(relativePath: string): string {
  return relativePath.split(/[\\/]/).pop() ?? relativePath;
}
