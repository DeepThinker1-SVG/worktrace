import { toModuleWindowData } from '../../shared/markdown';
import type { ParsedFile, ParsedModule } from '../../shared/markdown';
import type { ManagedFileState, ModuleUpdateSummary, RenderedHeadingNode } from '../../shared/workspace';

export type WorkspaceActivityState = {
  files: Record<string, Record<string, number>>;
};

export type ReconcileActivityResult = {
  activity: WorkspaceActivityState;
  changed: boolean;
};

export function reconcileWorkspaceActivity(
  activity: WorkspaceActivityState,
  files: ManagedFileState[],
): ReconcileActivityResult {
  const nextFiles: Record<string, Record<string, number>> = {};

  for (const file of files) {
    if (!file.parsedFile) {
      continue;
    }

    nextFiles[file.path] = reconcileFileActivity(
      activity.files[file.path] ?? {},
      file.parsedFile,
      file.sourceMtimeMs ?? Date.now(),
    );
  }

  return {
    activity: { files: nextFiles },
    changed: JSON.stringify(activity.files) !== JSON.stringify(nextFiles),
  };
}

export function updateFileActivity(input: {
  currentFileActivity: Record<string, number> | undefined;
  nextFile: ParsedFile | undefined;
  summaries: Record<string, ModuleUpdateSummary>;
  changedAt: number;
  initialAt: number;
}): Record<string, number> | undefined {
  if (!input.nextFile) {
    return input.currentFileActivity;
  }

  const nextActivity = reconcileFileActivity(
    input.currentFileActivity ?? {},
    input.nextFile,
    input.initialAt,
  );

  const changedNodeKeys = new Set<string>();

  for (const [moduleKey, summary] of Object.entries(input.summaries)) {
    const module = input.nextFile.modules.find((candidate) => candidate.moduleKey === moduleKey);

    if (!module) {
      continue;
    }

    if (summary.moduleAdded) {
      for (const key of collectModuleNodeKeys(module)) {
        changedNodeKeys.add(key);
      }
      continue;
    }

    for (const viewKey of summary.changedHeadingKeys) {
      for (const nodeKey of nodeKeyWithAncestors(module.moduleKey, viewKey)) {
        changedNodeKeys.add(nodeKey);
      }
    }
  }

  for (const nodeKey of changedNodeKeys) {
    if (nodeKey in nextActivity) {
      nextActivity[nodeKey] = input.changedAt;
    }
  }

  return nextActivity;
}

export function fileLastActivityAt(fileActivity: Record<string, number> | undefined): number | undefined {
  if (!fileActivity) {
    return undefined;
  }

  const values = Object.values(fileActivity);

  return values.length > 0 ? Math.max(...values) : undefined;
}

export function applyActivityToHeadings(
  headings: RenderedHeadingNode[],
  fileActivity: Record<string, number> | undefined,
): RenderedHeadingNode[] {
  if (!fileActivity) {
    return headings;
  }

  return headings.map((heading) => ({
    ...heading,
    lastActivityAt: fileActivity[heading.nodeKey],
    children: applyActivityToHeadings(heading.children, fileActivity),
  }));
}

function reconcileFileActivity(
  current: Record<string, number>,
  parsedFile: ParsedFile,
  initialAt: number,
): Record<string, number> {
  const next: Record<string, number> = {};

  for (const nodeKey of collectFileNodeKeys(parsedFile)) {
    next[nodeKey] = finiteTimestamp(current[nodeKey]) ?? initialAt;
  }

  return next;
}

function collectFileNodeKeys(parsedFile: ParsedFile): string[] {
  return parsedFile.modules.flatMap(collectModuleNodeKeys);
}

function collectModuleNodeKeys(module: ParsedModule): string[] {
  return flattenHeadings(toModuleWindowData(filePathFromModuleKey(module.moduleKey), module).headings).map((heading) => heading.nodeKey);
}

function nodeKeyWithAncestors(moduleKey: string, viewKey: string): string[] {
  const parts = viewKey.split('/');

  return parts.map((_, index) => `${moduleKey}@@${parts.slice(0, index + 1).join('/')}`);
}

function flattenHeadings(headings: RenderedHeadingNode[]): RenderedHeadingNode[] {
  return headings.flatMap((heading) => [heading, ...flattenHeadings(heading.children)]);
}

function filePathFromModuleKey(moduleKey: string): string {
  return moduleKey.split('::')[0] ?? moduleKey;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
