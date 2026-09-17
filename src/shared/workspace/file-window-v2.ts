import type { ModuleWindowData } from './workspace-types';

export type FileWindowV2ModuleRef = {
  moduleKey: string;
};

export function getInitialFileWindowV2ModuleKey(modules: ModuleWindowData[]): string | null {
  return modules[0]?.moduleKey ?? null;
}

export function selectFileWindowV2Module(
  modules: ModuleWindowData[],
  activeModuleKey: string | null,
): ModuleWindowData | null {
  if (!activeModuleKey) {
    return null;
  }

  return modules.find((module) => module.moduleKey === activeModuleKey) ?? null;
}

export function resolveFileWindowV2ActiveModuleKey(
  previousModules: FileWindowV2ModuleRef[],
  previousActiveModuleKey: string | null,
  nextModules: FileWindowV2ModuleRef[],
): string | null {
  if (nextModules.length === 0) {
    return null;
  }

  if (previousActiveModuleKey && nextModules.some((module) => module.moduleKey === previousActiveModuleKey)) {
    return previousActiveModuleKey;
  }

  const previousIndex = previousActiveModuleKey
    ? previousModules.findIndex((module) => module.moduleKey === previousActiveModuleKey)
    : -1;

  if (previousIndex >= 0) {
    return nextModules[Math.min(previousIndex, nextModules.length - 1)].moduleKey;
  }

  return nextModules[0].moduleKey;
}

export function resolvePersistedFileWindowV2ActiveModuleKey(
  modules: FileWindowV2ModuleRef[],
  persistedModuleKey: string | null | undefined,
  fallbackModuleKey: string | null,
): string | null {
  if (modules.length === 0) {
    return null;
  }

  if (persistedModuleKey && modules.some((module) => module.moduleKey === persistedModuleKey)) {
    return persistedModuleKey;
  }

  if (fallbackModuleKey && modules.some((module) => module.moduleKey === fallbackModuleKey)) {
    return fallbackModuleKey;
  }

  return modules[0].moduleKey;
}
