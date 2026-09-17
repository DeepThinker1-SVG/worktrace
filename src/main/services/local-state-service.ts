import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson } from './config-service';
import {
  defaultAppPreferences,
  isAppLocale,
  type AppLocale,
  type AppPreferences,
} from '../../shared/i18n';
import type {
  FileWindowV2State,
  LauncherViewState,
  ModuleViewState,
  PendingFileUpdate,
  WindowBounds,
  WorkspaceUiState,
} from '../../shared/workspace';
import type { WorkspaceActivityState } from './node-activity-state';

type LocalState = {
  schemaVersion: 1;
  appPreferences: AppPreferences;
  lastWorkspacePath: string | null;
  workspaces: Record<string, StoredWorkspaceState>;
  recentFiles: RecentFileEntry[];
};

export type RecentFileEntry = { path: string; openedAt: number };

type StoredWorkspaceState = WorkspaceUiState & {
  activity?: WorkspaceActivityState;
};

const defaultLocalState: LocalState = {
  schemaVersion: 1,
  appPreferences: defaultAppPreferences,
  lastWorkspacePath: null,
  workspaces: {},
  recentFiles: [],
};

const defaultWorkspaceUiState: WorkspaceUiState = {
  schemaVersion: 1,
  launcher: {},
  modules: {},
  fileWindowsV2: {},
  pendingFileUpdates: {},
};

const defaultWorkspaceActivityState: WorkspaceActivityState = {
  files: {},
};

export class LocalStateService {
  private readonly filePath: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private pendingWriteState: LocalState | null = null;
  private latestState: LocalState | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'workboard-session.json');
  }

  async getLastWorkspacePath(): Promise<string | null> {
    const state = await this.read();

    return state.lastWorkspacePath;
  }

  async getAppPreferences(): Promise<AppPreferences> {
    const state = await this.read();

    return state.appPreferences;
  }

  async setAppLocale(locale: AppLocale): Promise<AppPreferences> {
    await this.updateState((state) => ({
      ...state,
      appPreferences: { ...state.appPreferences, locale },
    }), { immediate: true });

    return { locale };
  }

  async setLastWorkspacePath(workspacePath: string | null): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      lastWorkspacePath: workspacePath,
    }), { immediate: true });
  }

  async getRecentFiles(): Promise<RecentFileEntry[]> {
    return (await this.read()).recentFiles;
  }

  async recordRecentFile(filePath: string): Promise<void> {
    await this.updateState((state) => ({
      ...state,
      recentFiles: [{ path: filePath, openedAt: Date.now() }, ...state.recentFiles.filter((entry) => entry.path !== filePath)].slice(0, 20),
    }), { immediate: true });
  }

  async getWorkspaceUiState(workspacePath: string | null): Promise<WorkspaceUiState> {
    if (!workspacePath) {
      return defaultWorkspaceUiState;
    }

    const state = await this.read();

    return state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
  }

  async getWorkspaceActivityState(workspacePath: string | null): Promise<WorkspaceActivityState> {
    if (!workspacePath) {
      return defaultWorkspaceActivityState;
    }

    const state = await this.read();
    const workspaceState = state.workspaces[workspacePath];

    return sanitizeWorkspaceActivityState(isRecord(workspaceState) ? workspaceState.activity : undefined);
  }

  async setWorkspaceActivityState(
    workspacePath: string | null,
    activity: WorkspaceActivityState,
  ): Promise<void> {
    if (!workspacePath) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            activity: sanitizeWorkspaceActivityState(activity),
          },
        },
      };
    });
  }

  async removeActivityForFile(workspacePath: string | null, relativePath: string): Promise<void> {
    if (!workspacePath || relativePath.length === 0) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const activity = sanitizeWorkspaceActivityState(isRecord(workspaceState) ? workspaceState.activity : undefined);
      const files = { ...activity.files };
      delete files[relativePath];

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            activity: { files },
          },
        },
      };
    });
  }

  async updateLauncherViewState(
    workspacePath: string | null,
    launcher: Partial<LauncherViewState>,
  ): Promise<void> {
    if (!workspacePath) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            launcher: {
              ...workspaceState.launcher,
              ...sanitizeLauncherState(launcher),
            },
          },
        },
      };
    });
  }

  async updateModuleViewState(
    workspacePath: string | null,
    moduleKey: string,
    moduleState: Partial<ModuleViewState>,
  ): Promise<void> {
    if (!workspacePath || moduleKey.length === 0) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const previousModuleState = workspaceState.modules[moduleKey] ?? {
        moduleKey,
        alwaysOnTop: false,
        expandedHeadingKeys: [],
        scrollTop: 0,
        selectedMarker: undefined,
      };

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            modules: {
              ...workspaceState.modules,
              [moduleKey]: sanitizeModuleState({
                ...previousModuleState,
                ...moduleState,
                moduleKey,
              }),
            },
          },
        },
      };
    });
  }

  async updateFileWindowV2State(
    workspacePath: string | null,
    relativePath: string,
    fileWindowState: Partial<FileWindowV2State>,
  ): Promise<void> {
    if (!workspacePath || relativePath.length === 0) {
      return;
    }

    const normalizedPath = normalizeFileWindowV2StatePath(relativePath);

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const previousState = workspaceState.fileWindowsV2?.[normalizedPath] ?? {
        relativePath: normalizedPath,
        activeModuleKey: null,
        expandedEventIds: [],
        scrollTop: 0,
        alwaysOnTop: false,
        restoreOnLaunch: false,
      };

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            fileWindowsV2: {
              ...(workspaceState.fileWindowsV2 ?? {}),
              [normalizedPath]: sanitizeFileWindowV2State({
                ...previousState,
                ...fileWindowState,
                relativePath: normalizedPath,
              }),
            },
          },
        },
      };
    });
  }

  async removeFileWindowV2State(workspacePath: string | null, relativePath: string): Promise<void> {
    if (!workspacePath || relativePath.length === 0) {
      return;
    }

    const normalizedPath = normalizeFileWindowV2StatePath(relativePath);

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const fileWindowsV2 = { ...(workspaceState.fileWindowsV2 ?? {}) };
      delete fileWindowsV2[normalizedPath];

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            fileWindowsV2,
          },
        },
      };
    });
  }

  async setPendingFileUpdates(
    workspacePath: string | null,
    pendingFileUpdates: Record<string, PendingFileUpdate>,
  ): Promise<void> {
    if (!workspacePath) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            pendingFileUpdates: sanitizePendingFileUpdates(pendingFileUpdates),
          },
        },
      };
    });
  }

  async removePendingFileUpdates(workspacePath: string | null, relativePath: string): Promise<void> {
    if (!workspacePath || relativePath.length === 0) {
      return;
    }

    const normalizedPath = normalizeFileWindowV2StatePath(relativePath);

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const pendingFileUpdates = sanitizePendingFileUpdates(workspaceState.pendingFileUpdates);
      delete pendingFileUpdates[normalizedPath];

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            pendingFileUpdates,
          },
        },
      };
    });
  }

  async removeModuleViewState(workspacePath: string | null, moduleKey: string): Promise<void> {
    if (!workspacePath) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const modules = { ...workspaceState.modules };
      delete modules[moduleKey];

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            modules,
          },
        },
      };
    });
  }

  async removeModuleViewStatesForFile(workspacePath: string | null, relativePath: string): Promise<void> {
    if (!workspacePath || relativePath.length === 0) {
      return;
    }

    await this.updateState((state) => {
      const workspaceState = state.workspaces[workspacePath] ?? defaultWorkspaceUiState;
      const modules = { ...workspaceState.modules };
      const moduleKeyPrefix = normalizeModuleKeyPrefix(relativePath);

      for (const moduleKey of Object.keys(modules)) {
        if (normalizeModuleKeyPrefix(moduleKey).startsWith(moduleKeyPrefix)) {
          delete modules[moduleKey];
        }
      }

      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspacePath]: {
            ...workspaceState,
            modules,
          },
        },
      };
    });
  }

  async flush(): Promise<void> {
    await this.mutationQueue;

    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    const stateToWrite = this.pendingWriteState ?? this.latestState;
    this.pendingWriteState = null;

    if (stateToWrite) {
      this.enqueueWrite(stateToWrite);
    }

    await this.writeQueue;
  }

  private async updateState(
    updater: (state: LocalState) => LocalState,
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    const run = this.mutationQueue.then(async () => {
      const baseState = this.latestState ?? (await this.readFromDisk());
      const nextState = sanitizeLocalState(updater(baseState));
      this.latestState = nextState;

      if (options.immediate) {
        if (this.writeTimer) {
          clearTimeout(this.writeTimer);
          this.writeTimer = null;
        }

        this.pendingWriteState = null;
        this.enqueueWrite(nextState);
        await this.writeQueue;
        return;
      }

      this.writeDebounced(nextState);
    });

    this.mutationQueue = run.catch((error) => {
      console.error('[LocalStateService] mutation failed:', error);
    });
    await run;
  }

  private async readFromDisk(): Promise<LocalState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'schemaVersion' in parsed &&
        parsed.schemaVersion === 1 &&
        'lastWorkspacePath' in parsed &&
        (typeof parsed.lastWorkspacePath === 'string' || parsed.lastWorkspacePath === null)
      ) {
        return sanitizeLocalState(parsed);
      }
    } catch {
      return defaultLocalState;
    }

    return defaultLocalState;
  }

  private async read(): Promise<LocalState> {
    if (this.latestState) {
      return this.latestState;
    }

    const state = await this.readFromDisk();
    this.latestState = state;
    return state;
  }

  private writeDebounced(state: LocalState): void {
    this.pendingWriteState = state;

    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      const pending = this.pendingWriteState;
      this.pendingWriteState = null;
      this.writeTimer = null;

      if (pending) {
        this.enqueueWrite(pending);
      }
    }, 200);
  }

  private enqueueWrite(state: LocalState): void {
    this.writeQueue = this.writeQueue.then(async () => {
      await atomicWriteJson(this.filePath, sanitizeLocalState(state));
    }).catch((error) => {
      console.error('[LocalStateService] write failed:', error);
    });
  }
}

function sanitizeLocalState(input: unknown): LocalState {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    return defaultLocalState;
  }

  const workspaces: Record<string, WorkspaceUiState> = {};
  const rawWorkspaces = isRecord(input.workspaces) ? input.workspaces : {};

  for (const [workspacePath, workspaceState] of Object.entries(rawWorkspaces)) {
    workspaces[workspacePath] = sanitizeWorkspaceUiState(workspaceState);
  }

  return {
    schemaVersion: 1,
    appPreferences: sanitizeAppPreferences(input.appPreferences),
    lastWorkspacePath: typeof input.lastWorkspacePath === 'string' ? input.lastWorkspacePath : null,
    workspaces,
    recentFiles: sanitizeRecentFiles(input.recentFiles),
  };
}

function sanitizeRecentFiles(input: unknown): RecentFileEntry[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.flatMap((value) => {
    if (!isRecord(value) || typeof value.path !== 'string' || !value.path || typeof value.openedAt !== 'number' || !Number.isFinite(value.openedAt) || seen.has(value.path)) return [];
    seen.add(value.path);
    return [{ path: value.path, openedAt: value.openedAt }];
  }).sort((left, right) => right.openedAt - left.openedAt).slice(0, 20);
}

function sanitizeAppPreferences(input: unknown): AppPreferences {
  if (!isRecord(input) || !isAppLocale(input.locale)) {
    return defaultAppPreferences;
  }

  return { locale: input.locale };
}

function sanitizeWorkspaceUiState(input: unknown): WorkspaceUiState {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    return defaultWorkspaceUiState;
  }

  const modules: Record<string, ModuleViewState> = {};
  const rawModules = isRecord(input.modules) ? input.modules : {};

  for (const [moduleKey, moduleState] of Object.entries(rawModules)) {
    modules[moduleKey] = sanitizeModuleState({ ...(isRecord(moduleState) ? moduleState : {}), moduleKey });
  }

  const fileWindowsV2: Record<string, FileWindowV2State> = {};
  const rawFileWindowsV2 = isRecord(input.fileWindowsV2) ? input.fileWindowsV2 : {};

  for (const [relativePath, fileWindowState] of Object.entries(rawFileWindowsV2)) {
    if (relativePath.length > 0) {
      fileWindowsV2[relativePath] = sanitizeFileWindowV2State({
        ...(isRecord(fileWindowState) ? fileWindowState : {}),
        relativePath,
      });
    }
  }

  const output: WorkspaceUiState & { activity?: WorkspaceActivityState } = {
    schemaVersion: 1,
    launcher: sanitizeLauncherState(input.launcher),
    modules,
    fileWindowsV2,
    pendingFileUpdates: sanitizePendingFileUpdates(input.pendingFileUpdates),
  };

  const activity = sanitizeWorkspaceActivityState(input.activity);

  if (Object.keys(activity.files).length > 0) {
    output.activity = activity;
  }

  return output;
}

function sanitizeWorkspaceActivityState(input: unknown): WorkspaceActivityState {
  if (!isRecord(input)) {
    return defaultWorkspaceActivityState;
  }

  const files: Record<string, Record<string, number>> = {};
  const rawFiles = isRecord(input.files) ? input.files : {};

  for (const [relativePath, fileActivity] of Object.entries(rawFiles)) {
    if (!isRecord(fileActivity)) {
      continue;
    }

    const nodes: Record<string, number> = {};

    for (const [nodeKey, value] of Object.entries(fileActivity)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        nodes[nodeKey] = value;
      }
    }

    if (Object.keys(nodes).length > 0) {
      files[relativePath] = nodes;
    }
  }

  return { files };
}

function sanitizePendingFileUpdates(input: unknown): Record<string, PendingFileUpdate> {
  if (!isRecord(input)) {
    return {};
  }

  const pendingFileUpdates: Record<string, PendingFileUpdate> = {};

  for (const [relativePath, fileUpdate] of Object.entries(input)) {
    const normalizedPath = normalizeFileWindowV2StatePath(relativePath);

    if (normalizedPath.length === 0 || !isRecord(fileUpdate)) {
      continue;
    }

    const modules = sanitizePendingModules(fileUpdate.modules ?? fileUpdate);
    const structureChanged = fileUpdate.structureChanged === true;
    const hasModules = Object.keys(modules).length > 0;

    if (!hasModules) {
      continue;
    }

    pendingFileUpdates[normalizedPath] = {
      fileAttention: fileUpdate.fileAttention === true,
      modules,
      structureChanged,
    };
  }

  return pendingFileUpdates;
}

function sanitizePendingModules(input: unknown): PendingFileUpdate['modules'] {
  if (!isRecord(input)) {
    return {};
  }

  const modules: PendingFileUpdate['modules'] = {};

  for (const [moduleKey, moduleUpdate] of Object.entries(input)) {
    if (moduleKey.length === 0) {
      continue;
    }

    const changedHeadingKeys = Array.isArray(moduleUpdate)
      ? moduleUpdate.filter((key): key is string => typeof key === 'string')
      : isRecord(moduleUpdate) && Array.isArray(moduleUpdate.changedHeadingKeys)
        ? moduleUpdate.changedHeadingKeys.filter((key): key is string => typeof key === 'string')
        : [];
    const structureChanged = isRecord(moduleUpdate) && moduleUpdate.structureChanged === true;
    const uniqueHeadingKeys = [...new Set(changedHeadingKeys)];

    if (uniqueHeadingKeys.length > 0) {
      modules[moduleKey] = {
        attention: true,
        changedHeadingKeys: uniqueHeadingKeys,
        structureChanged,
      };
    }
  }

  return modules;
}

function sanitizeFileWindowV2State(input: unknown): FileWindowV2State {
  const record = isRecord(input) ? input : {};
  const relativePath = typeof record.relativePath === 'string' ? normalizeFileWindowV2StatePath(record.relativePath) : '';
  const activeModuleKey = typeof record.activeModuleKey === 'string' && record.activeModuleKey.length > 0
    ? record.activeModuleKey
    : null;

  const expandedEventIds = Array.isArray(record.expandedEventIds)
    ? [...new Set(record.expandedEventIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : undefined;
  const scrollTop = typeof record.scrollTop === 'number' && Number.isFinite(record.scrollTop)
    ? Math.max(0, record.scrollTop)
    : undefined;

  return {
    relativePath,
    activeModuleKey,
    ...(expandedEventIds ? { expandedEventIds } : {}),
    ...(scrollTop === undefined ? {} : { scrollTop }),
    bounds: sanitizeBounds(record.bounds),
    alwaysOnTop: record.alwaysOnTop === true,
    restoreOnLaunch: record.restoreOnLaunch === true,
  };
}

function sanitizeLauncherState(input: unknown): LauncherViewState {
  if (!isRecord(input)) {
    return {};
  }

  const bounds = sanitizeBounds(input.bounds);

  return {
    ...(bounds ? { bounds } : {}),
    ...(input.alwaysOnTop === true ? { alwaysOnTop: true } : {}),
  };
}

function normalizeFileWindowV2StatePath(input: string): string {
  return input.replaceAll('\\', '/');
}

function sanitizeModuleState(input: unknown): ModuleViewState {
  const record = isRecord(input) ? input : {};

  return {
    moduleKey: typeof record.moduleKey === 'string' ? record.moduleKey : '',
    bounds: sanitizeBounds(record.bounds),
    alwaysOnTop: record.alwaysOnTop === true,
    expandedHeadingKeys: Array.isArray(record.expandedHeadingKeys)
      ? record.expandedHeadingKeys.filter((key): key is string => typeof key === 'string')
      : [],
    scrollTop: typeof record.scrollTop === 'number' && Number.isFinite(record.scrollTop)
      ? Math.max(0, record.scrollTop)
      : 0,
    selectedMarker: typeof record.selectedMarker === 'string' && record.selectedMarker.length > 0
      ? record.selectedMarker
      : undefined,
  };
}

function sanitizeBounds(input: unknown): WindowBounds | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);

  if (width === undefined || height === undefined || width < 120 || height < 120) {
    return undefined;
  }

  const x = finiteNumber(input.x);
  const y = finiteNumber(input.y);

  return {
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    width,
    height,
  };
}

function finiteNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function normalizeModuleKeyPrefix(input: string): string {
  const normalized = input.replaceAll('\\', '/');
  const prefix = normalized.includes('::') ? normalized : `${normalized}::`;

  return process.platform === 'win32' ? prefix.toLowerCase() : prefix;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
