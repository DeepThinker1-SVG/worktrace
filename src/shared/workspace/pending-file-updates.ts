import type {
  FileWindowV2FileUpdatePayload,
  ModuleUpdateSummary,
  ModuleWindowData,
  PendingFileUpdate,
  PendingModuleUpdate,
} from './workspace-types';

export type PendingFileUpdateIndex = Record<string, PendingFileUpdate>;

export const moduleBodyUpdateKey = '__module__';

export function mergePendingFileUpdates(
  current: PendingFileUpdateIndex,
  summaries: Record<string, ModuleUpdateSummary>,
): PendingFileUpdateIndex {
  let next = clonePendingFileUpdates(current);

  for (const [moduleKey, summary] of Object.entries(summaries)) {
    if (summary.phase === 'updating' || summary.phase === 'error') {
      continue;
    }

    const keys = new Set(summary.changedHeadingKeys);
    if (summary.leadingBodyChanged) {
      keys.add(moduleBodyUpdateKey);
    }

    if (keys.size === 0) {
      continue;
    }

    const fileUpdates = next[summary.relativePath] ?? { fileAttention: false, modules: {}, structureChanged: false };
    const modules = { ...fileUpdates.modules };
    const previousModuleUpdate = modules[moduleKey] ?? { attention: false, changedHeadingKeys: [], structureChanged: false };
    const moduleKeys = new Set(previousModuleUpdate.changedHeadingKeys);

    for (const key of keys) {
      moduleKeys.add(key);
    }

    modules[moduleKey] = {
      attention: true,
      changedHeadingKeys: [...moduleKeys],
      structureChanged: previousModuleUpdate.structureChanged || summary.structureChanged || summary.moduleAdded,
    };

    next = {
      ...next,
      [summary.relativePath]: {
        fileAttention: true,
        modules,
        structureChanged: fileUpdates.structureChanged || summary.fileStructureChanged,
      },
    };
  }

  return pruneEmptyPendingContainers(next);
}

export function prunePendingFileUpdatesForPayload(
  current: PendingFileUpdateIndex,
  relativePath: string,
  modules: ModuleWindowData[],
): PendingFileUpdateIndex {
  const fileUpdates = current[relativePath];

  if (!fileUpdates) {
    return current;
  }

  const moduleMap = new Map(modules.map((module) => [module.moduleKey, new Set(collectHeadingKeys(module.headings))]));
  const nextModules: Record<string, PendingModuleUpdate> = {};
  let structureChanged = fileUpdates.structureChanged;

  for (const [moduleKey, moduleUpdate] of Object.entries(fileUpdates.modules)) {
    const availableHeadingKeys = moduleMap.get(moduleKey);

    if (!availableHeadingKeys) {
      structureChanged = true;
      continue;
    }

    const nextKeys = moduleUpdate.changedHeadingKeys.filter(
      (key) => key === moduleBodyUpdateKey || availableHeadingKeys.has(key),
    );

    if (nextKeys.length > 0) {
      nextModules[moduleKey] = {
        attention: true,
        changedHeadingKeys: [...new Set(nextKeys)],
        structureChanged: moduleUpdate.structureChanged,
      };
    }
  }

  if (Object.keys(nextModules).length === 0 && !fileUpdates.fileAttention) {
    const rest = { ...current };
    delete rest[relativePath];
    return rest;
  }

  return {
    ...current,
    [relativePath]: {
      fileAttention: fileUpdates.fileAttention,
      modules: nextModules,
      structureChanged: Object.keys(nextModules).length > 0 && structureChanged,
    },
  };
}

export function clearPendingModule(
  current: PendingFileUpdateIndex,
  relativePath: string,
  moduleKey: string,
): PendingFileUpdateIndex {
  const fileUpdates = current[relativePath];

  if (!fileUpdates || !Object.hasOwn(fileUpdates.modules, moduleKey)) {
    return current;
  }

  const modules = { ...fileUpdates.modules };
  delete modules[moduleKey];

  return pruneEmptyPendingContainers({
    ...current,
    [relativePath]: {
      ...fileUpdates,
      modules,
    },
  });
}

export function clearPendingHeading(
  current: PendingFileUpdateIndex,
  relativePath: string,
  moduleKey: string,
  headingKey: string,
): PendingFileUpdateIndex {
  const fileUpdates = current[relativePath];

  if (!fileUpdates || !Object.hasOwn(fileUpdates.modules, moduleKey)) {
    return current;
  }

  const moduleUpdate = fileUpdates.modules[moduleKey];
  const nextKeys = moduleUpdate.changedHeadingKeys.filter((key) => key !== headingKey);

  return pruneEmptyPendingContainers({
    ...current,
    [relativePath]: {
      ...fileUpdates,
      modules: {
        ...fileUpdates.modules,
        [moduleKey]: {
          ...moduleUpdate,
          changedHeadingKeys: nextKeys,
        },
      },
    },
  });
}

export function clearFileAttention(current: PendingFileUpdateIndex, relativePath: string): PendingFileUpdateIndex {
  const fileUpdates = current[relativePath];

  if (!fileUpdates) {
    return current;
  }

  return pruneEmptyPendingContainers({
    ...current,
    [relativePath]: {
      ...fileUpdates,
      fileAttention: false,
    },
  });
}

export function clearModuleAttention(
  current: PendingFileUpdateIndex,
  relativePath: string,
  moduleKey: string,
): PendingFileUpdateIndex {
  const fileUpdates = current[relativePath];

  if (!fileUpdates || !Object.hasOwn(fileUpdates.modules, moduleKey)) {
    return current;
  }

  const moduleUpdate = fileUpdates.modules[moduleKey];

  return pruneEmptyPendingContainers({
    ...current,
    [relativePath]: {
      ...fileUpdates,
      modules: {
        ...fileUpdates.modules,
        [moduleKey]: {
          ...moduleUpdate,
          attention: false,
        },
      },
    },
  });
}

export function clearPendingFile(current: PendingFileUpdateIndex, relativePath: string): PendingFileUpdateIndex {
  if (!Object.hasOwn(current, relativePath)) {
    return current;
  }

  const next = { ...current };
  delete next[relativePath];

  return next;
}

export function clearAllPending(): PendingFileUpdateIndex {
  return {};
}

export function pruneEmptyPendingContainers(current: PendingFileUpdateIndex): PendingFileUpdateIndex {
  const next: PendingFileUpdateIndex = {};

  for (const [relativePath, fileUpdates] of Object.entries(current)) {
    const nextModules: Record<string, PendingModuleUpdate> = {};

    for (const [moduleKey, moduleUpdate] of Object.entries(fileUpdates.modules)) {
      if (moduleUpdate.changedHeadingKeys.length > 0) {
        nextModules[moduleKey] = {
          attention: true,
          changedHeadingKeys: [...moduleUpdate.changedHeadingKeys],
          structureChanged: moduleUpdate.structureChanged,
        };
      }
    }

    if (Object.keys(nextModules).length > 0) {
      next[relativePath] = {
        fileAttention: fileUpdates.fileAttention,
        modules: nextModules,
        structureChanged: fileUpdates.structureChanged,
      };
    }
  }

  return next;
}

export function getFileWindowV2UpdatePayload(
  current: PendingFileUpdateIndex,
  relativePath: string,
): FileWindowV2FileUpdatePayload | undefined {
  const fileUpdates = current[relativePath];

  if (!fileUpdates) {
    return undefined;
  }

  return {
    relativePath,
    fileAttention: fileUpdates.fileAttention,
    modules: cloneModuleUpdates(fileUpdates.modules),
    structureChanged: fileUpdates.structureChanged,
  };
}

export function deriveUpdatedFilePaths(current: PendingFileUpdateIndex): string[] {
  return Object.entries(current)
    .filter(([, fileUpdates]) => fileUpdates.fileAttention)
    .map(([relativePath]) => relativePath);
}

export function deriveUpdatedModuleKeys(payload?: FileWindowV2FileUpdatePayload): Set<string> {
  return new Set(
    Object.entries(payload?.modules ?? {})
      .filter(([, moduleUpdate]) => moduleUpdate.changedHeadingKeys.length > 0)
      .map(([moduleKey]) => moduleKey),
  );
}

export function deriveChangedHeadingKeys(
  payload: FileWindowV2FileUpdatePayload | undefined,
  moduleKey: string,
): Set<string> {
  return new Set((payload?.modules[moduleKey]?.changedHeadingKeys ?? []).filter((key) => key !== moduleBodyUpdateKey));
}

export function hasModuleBodyUpdate(
  payload: FileWindowV2FileUpdatePayload | undefined,
  moduleKey: string,
): boolean {
  return payload?.modules[moduleKey]?.changedHeadingKeys.includes(moduleBodyUpdateKey) === true;
}

export function hasPendingModuleUpdates(
  payload: FileWindowV2FileUpdatePayload | undefined,
  moduleKey: string,
): boolean {
  return (payload?.modules[moduleKey]?.changedHeadingKeys.length ?? 0) > 0;
}

export function hasPendingFileUpdates(payload: FileWindowV2FileUpdatePayload | undefined): boolean {
  return Object.values(payload?.modules ?? {}).some((moduleUpdate) => moduleUpdate.changedHeadingKeys.length > 0);
}

function clonePendingFileUpdates(current: PendingFileUpdateIndex): PendingFileUpdateIndex {
  return Object.fromEntries(
    Object.entries(current).map(([relativePath, fileUpdates]) => [
      relativePath,
      {
        fileAttention: fileUpdates.fileAttention,
        modules: cloneModuleUpdates(fileUpdates.modules),
        structureChanged: fileUpdates.structureChanged,
      },
    ]),
  );
}

function cloneModuleUpdates(modules: Record<string, PendingModuleUpdate>): Record<string, PendingModuleUpdate> {
  return Object.fromEntries(
    Object.entries(modules).map(([moduleKey, moduleUpdate]) => [moduleKey, clonePendingModuleUpdate(moduleUpdate)]),
  );
}

function clonePendingModuleUpdate(moduleUpdate: PendingModuleUpdate): PendingModuleUpdate {
  return {
    attention: moduleUpdate.attention,
    changedHeadingKeys: [...moduleUpdate.changedHeadingKeys],
    structureChanged: moduleUpdate.structureChanged,
  };
}

function collectHeadingKeys(headings: ModuleWindowData['headings']): string[] {
  return headings.flatMap((heading) => [heading.viewKey, ...collectHeadingKeys(heading.children)]);
}
