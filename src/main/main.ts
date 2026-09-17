import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import type { PingResponse, WindowControlAction } from '../preload/api-types';
import {
  defaultAppPreferences,
  isAppLocale,
  translate,
  type AppLocale,
  type AppPreferences,
} from '../shared/i18n';
import type {
  BundledWorkflowPackageUpdateResult,
  WorkflowApplyPlan,
  WorkflowApplyResult,
  WorkflowPackageCatalog,
  UserWorkflowPackage,
} from '../shared/workflow';
import { isWorkflowPackageLocale } from '../shared/workflow';
import { AiCodingWorkflowService } from './services/ai-coding-workflow-service';
import type {
  FileWindowV2State,
  ArchiveManagedFileResult,
  FileWindowV2InitialPayload,
  LauncherPendingUpdatesPayload,
  LauncherViewState,
  ModuleUpdateSummary,
  OpenFileWindowV2Result,
  WindowBounds,
  WorkspaceUiState,
  WorkspaceState,
  PendingFileUpdateIndex,
} from '../shared/workspace';
import {
  clearAllPending,
  clearFileAttention,
  clearModuleAttention,
  clearPendingFile,
  clearPendingHeading,
  clearPendingModule,
  deriveUpdatedFilePaths,
  getFileWindowV2UpdatePayload,
  ensureWindowBoundsVisible,
  prunePendingFileUpdatesForPayload,
  resolvePersistedFileWindowV2ActiveModuleKey,
} from '../shared/workspace';
import { mergeFileUpdateSummaries } from './services/file-update-attention';
import { FileWindowV2Registry, normalizeFileWindowV2Path } from './services/file-window-v2-registry';
import { LocalStateService } from './services/local-state-service';
import { ManagedFileWatcher, type UpdateTrace } from './services/managed-file-watcher';
import { buildModuleUpdateSummaries } from './services/module-update-diff';
import { reconcileWorkspaceActivity, updateFileActivity } from './services/node-activity-state';
import { TransientUpdateState } from './services/transient-update-state';
import { type ManagedFileRefreshResult, WorkspaceSession } from './services/workspace-session';
import { pathsEqual } from './services/workspace-paths';
import { EventDocumentService } from './services/event-document-service';
import { EventMutationService } from './services/event-mutation-service';
import { archiveEvent, archiveExpiredRootEvents, createChildEvent, createEvent, createSiblingEvent, deleteEvent, indentEvent, moveEvent, outdentEvent, updateClosedAt, updateCreatedAt, updateDeadline, updateNote, updateStatus, updateTags, updateTitle } from '../shared/events';
import type { EventMutationRequest } from '../shared/workspace';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

if (process.env.NODE_ENV === 'development') {
  const devUserData = path.resolve(process.cwd(), '.electron-data');
  app.setPath('userData', devUserData);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

let launcherWindow: BrowserWindow | null = null;
const workspaceSession = new WorkspaceSession();
let eventMutationService: EventMutationService | null = null;
let eventMutationWorkspacePath: string | null = null;
const autoArchiveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let localStateService: LocalStateService;
let appLocale: AppLocale = defaultAppPreferences.locale;
let aiCodingWorkflowService: AiCodingWorkflowService;
let restoreWorkspacePromise: Promise<WorkspaceState> = Promise.resolve(workspaceSession.getState());
const fileWindowsV2 = new FileWindowV2Registry<BrowserWindow>();
let isQuitting = false;
let updateSequence = 0;
const updateDiagnosticsEnabled = process.env.WORKBOARD_UPDATE_DIAGNOSTICS === '1';
const preservingCloseFileWindowV2Paths = new Set<string>();
const purgingFileWindowV2Paths = new Set<string>();
const pendingFileWindowV2BoundsTimers = new Map<string, NodeJS.Timeout>();
let latestDiagnosticUpdate: WorkspaceState['diagnosticUpdate'];
let pendingFileUpdates: PendingFileUpdateIndex = {};
const transientUpdateState = new TransientUpdateState(() => broadcastWorkspaceState());
const managedFileWatcher = new ManagedFileWatcher(workspaceSession, async (relativePath) => {
  markFileUpdating(relativePath);
  broadcastWorkspaceState();
}, async (relativePath, result, trace) => {
  const summaries = await markFileUpdated(relativePath, result);
  mergeFileWindowV2PendingUpdates(relativePath, summaries);
  await sendFileWindowV2Payload(relativePath);
  sendFileWindowV2PendingUpdates(relativePath);
  broadcastLauncherPendingUpdates();
  broadcastWorkspaceState(trace);
  logUpdateTrace(trace);
}, {
  diagnostics: updateDiagnosticsEnabled,
}, handleManagedFileSetChange);

async function handleManagedFileSetChange(change: { added: string[]; removed: string[] }): Promise<void> {
  await reconcileActivityState();

  const normalizedRemoved = change.removed.map(normalizeFileWindowV2Path);
  const normalizedAdded = change.added.map(normalizeFileWindowV2Path);
  const addedSet = new Set(normalizedAdded);

  const state = workspaceSession.getState();

  for (const normalizedPath of normalizedAdded) {
    const addedFile = state.files.find((file) => normalizeFileWindowV2Path(file.path) === normalizedPath);

    if (!addedFile) {
      continue;
    }

    const summaries = await markFileUpdated(addedFile.path, { next: addedFile });
    mergeFileWindowV2PendingUpdates(addedFile.path, summaries);
    await sendFileWindowV2Payload(addedFile.path);
    sendFileWindowV2PendingUpdates(addedFile.path);
  }

  for (const normalizedPath of normalizedRemoved) {
    if (addedSet.has(normalizedPath)) {
      continue;
    }

    if (workspaceSession.getFileWindowV2InitialPayload(normalizedPath)) {
      continue;
    }

    await purgeManagedFileState(normalizedPath, 'deleted');
  }

  broadcastLauncherPendingUpdates();
  broadcastWorkspaceState();
}

function getWorkspaceState(): WorkspaceState {
  return workspaceSession.getState(transientUpdateState.getFileUpdateStatuses(), latestDiagnosticUpdate);
}

function broadcastWorkspaceState(trace?: UpdateTrace) {
  if (trace) {
    trace.marks.broadcast = Date.now();
    latestDiagnosticUpdate = {
      id: trace.id,
      relativePath: trace.relativePath,
      broadcastAt: trace.marks.broadcast,
    };
  }

  const state = getWorkspaceState();

  launcherWindow?.webContents.send('workboard:workspace-state-changed', state);
}

function broadcastAppPreferences(preferences: AppPreferences): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('workboard:app-preferences-changed', preferences);
  }
}

function logUpdateTrace(trace?: UpdateTrace) {
  if (!updateDiagnosticsEnabled || !trace) {
    return;
  }

  const marks = trace.marks;
  const span = (from: string, to: string) =>
    marks[from] !== undefined && marks[to] !== undefined ? `${(marks[to] - marks[from]).toFixed(1)}ms` : 'n/a';

  console.log(
    `[workboard:update-trace:${trace.id}] ${trace.relativePath} ` +
      `event->debounceStart=${span('event', 'debounce-start')} ` +
      `debounce=${span('debounce-start', 'debounce-end')} ` +
      `read=${span('read-start', 'read-end')} ` +
      `parse=${span('read-end', 'parse-end')} ` +
      `state=${span('parse-end', 'state-updated')} ` +
      `broadcast=${span('state-updated', 'broadcast')} ` +
      `total=${span('event', 'broadcast')}`,
  );
}

function markFileUpdating(relativePath: string) {
  const changedAt = Date.now();
  const file = workspaceSession.getState().files.find((candidate) => candidate.path === relativePath);

  transientUpdateState.markUpdating({
    relativePath,
    moduleKeys: file?.parsedFile?.modules.map((module) => module.moduleKey) ?? [],
    id: updateSequence + 1,
    changedAt,
  });
}

function clearTransientUpdateState() {
  transientUpdateState.clearAll();
  latestDiagnosticUpdate = undefined;
}

function moduleKeysForManagedFile(relativePath: string): string[] {
  const file = workspaceSession.getState().files.find((candidate) => candidate.path === relativePath);

  return file?.parsedFile?.modules.map((module) => module.moduleKey) ?? [];
}

async function cleanupRemovedRepositoryFileState(relativePath: string, mutateFileSet: () => Promise<void>): Promise<void> {
  const removedModuleKeys = moduleKeysForManagedFile(relativePath);

  await mutateFileSet();
  await managedFileWatcher.sync();
  await purgeManagedFileState(relativePath, 'archived');
  await Promise.all(
    removedModuleKeys.map((moduleKey) => localStateService.removeModuleViewState(workspaceSession.getWorkspacePath(), moduleKey)),
  );
}

export type PurgeManagedFileReason = 'renamed' | 'moved' | 'deleted' | 'archived';

async function purgeManagedFileState(relativePath: string, reason: PurgeManagedFileReason): Promise<void> {
  if (!localStateService) {
    return;
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);

  if (normalizedPath.length === 0) {
    return;
  }

  // 1. Mark the path for purge-close so that any close event fired by the
  //    window we are about to close cannot resurrect saved bounds/active
  //    module/alwaysOnTop state back into local state.
  purgingFileWindowV2Paths.add(normalizedPath);

  const fileWindow = fileWindowsV2.get(normalizedPath);

  if (fileWindow) {
    fileWindowsV2.delete(normalizedPath, fileWindow);
  }

  // 2. Cancel any pending debounced bounds save so the close handler cannot
  //    re-persist stale bounds during/after the close.
  const pendingBoundsTimer = pendingFileWindowV2BoundsTimers.get(normalizedPath);

  if (pendingBoundsTimer) {
    clearTimeout(pendingBoundsTimer);
    pendingFileWindowV2BoundsTimers.delete(normalizedPath);
  }

  // 3. Drop any in-memory transient state for the old path.
  transientUpdateState.clearFile(normalizedPath);

  // 4. Drop any in-memory pending updates and re-derive launcher payloads
  //    from the authoritative cleared state.
  pendingFileUpdates = clearPendingFile(pendingFileUpdates, normalizedPath);

  const workspacePath = workspaceSession.getWorkspacePath();

  // 5. Remove all persisted Workboard state that was keyed on the old path.
  //    The order of `Promise.all` does not matter; they all touch independent
  //    records so partial failure leaves the other records removed.
  await Promise.all([
    localStateService.removeModuleViewStatesForFile(workspacePath, normalizedPath),
    localStateService.removeActivityForFile(workspacePath, normalizedPath),
    localStateService.removeFileWindowV2State(workspacePath, normalizedPath),
    localStateService.removePendingFileUpdates(workspacePath, normalizedPath),
  ]);

  // 6. Workspace config (pinned/hidden) and per-file styles are owned by the
  //    WorkspaceSession and live in the workspace directory, not the userData
  //    session file. Clear them as part of the same authoritative purge.
  if (workspacePath) {
    try {
      await workspaceSession.removeFilePreferences(normalizedPath);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[purge] removeFilePreferences failed for ${normalizedPath}:`, error);
      }
    }

    try {
      await workspaceSession.removeFileStyles(normalizedPath);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[purge] removeFileStyles failed for ${normalizedPath}:`, error);
      }
    }
  }

  // 7. Persist the cleared in-memory pending state.
  persistPendingFileUpdates();

  // 8. Close the actual window. Because we already cleared registry/timer and
  //    the purge flag is set, the close handler will not write state.
  if (fileWindow && !fileWindow.isDestroyed()) {
    fileWindow.close();
  }

  // 9. Push cleared payloads to the launcher and any live V2 windows. These
  //    notifications are derived from the authoritative state, so an empty
  //    launcher update payload now correctly reflects the removed file.
  sendFileWindowV2PendingUpdates(normalizedPath);
  broadcastLauncherPendingUpdates();

  if (process.env.NODE_ENV === 'development') {
    console.log(`[purge:${reason}] ${normalizedPath}`);
  }

  if (!fileWindow) {
    purgingFileWindowV2Paths.delete(normalizedPath);
  }
}

async function markFileUpdated(
  relativePath: string,
  result: ManagedFileRefreshResult,
): Promise<Record<string, ModuleUpdateSummary>> {
  const changedAt = Date.now();
  const id = (updateSequence += 1);
  const phase = result.next.status === 'available' ? 'recentlyUpdated' : 'error';
  const fileRecovered = result.previous !== undefined && result.previous.status !== 'available' && result.next.status === 'available';

  const summaries = buildModuleUpdateSummaries({
    previous: result.previous?.parsedFile,
    next: result.next.parsedFile,
    fileRecovered,
    changedAt,
    id,
  });

  await updateActivityForRefresh(relativePath, result, summaries, changedAt);

  transientUpdateState.markCompleted({
    relativePath,
    phase,
    summaries,
    changedAt,
  });

  return summaries;
}

function getFileWindowV2Payload(relativePath: string): FileWindowV2InitialPayload | null {
  const payload = workspaceSession.getFileWindowV2InitialPayload(relativePath);

  if (!payload) {
    return null;
  }

  return {
    ...payload,
    pendingUpdates: getFileWindowV2UpdatePayload(pendingFileUpdates, payload.relativePath),
  };
}

async function getFileWindowV2PayloadWithStoredState(relativePath: string): Promise<FileWindowV2InitialPayload | null> {
  const payload = getFileWindowV2Payload(relativePath);

  if (!payload) {
    return null;
  }

  const eventDocument = await workspaceSession.getTodoDocument(payload.relativePath).catch(() => undefined);
  if (eventDocument) scheduleTodoAutoArchive(payload.relativePath, eventDocument);

  const state = await getStoredFileWindowV2State(payload.relativePath);
  const initialModuleKey = resolvePersistedFileWindowV2ActiveModuleKey(
    payload.modules,
    state?.activeModuleKey,
    payload.initialModuleKey,
  );

  if (state?.activeModuleKey !== initialModuleKey) {
    await updateFileWindowV2StateIfManaged(payload.relativePath, { activeModuleKey: initialModuleKey });
  }

  return {
    ...payload,
    ...(eventDocument ? { eventDocument } : {}),
    initialModuleKey,
  };
}

function workspaceMetadataKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return crypto.createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
}

async function openMarkdownFile(filePath: string): Promise<OpenFileWindowV2Result> {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile() || path.extname(absolutePath).toLowerCase() !== '.md') return { ok: false, reason: 'File is unavailable.' };
  const parentDirectory = path.dirname(absolutePath);
  const workspacePath = workspaceSession.getWorkspacePath();
  if (!workspacePath || !pathsEqual(workspacePath, parentDirectory)) {
    await managedFileWatcher.stop();
    await closeFileWindowsV2ForWorkspaceSwitch();
    clearTransientUpdateState();
    await workspaceSession.openWorkspace(parentDirectory);
    await managedFileWatcher.start();
  }
  const registered = await workspaceSession.registerTemporaryFile(absolutePath);
  await managedFileWatcher.sync();
  const payload = await getFileWindowV2PayloadWithStoredState(registered.relativePath);
  if (!payload) return { ok: false, reason: 'File is unavailable.' };
  if (!fileWindowsV2.focusExisting(registered.relativePath)) createFileWindowV2(registered.relativePath, payload);
  await localStateService.recordRecentFile(absolutePath);
  broadcastWorkspaceState();
  broadcastLauncherPendingUpdates();
  return { ok: true };
}

function scheduleTodoAutoArchive(relativePath: string, document: import('../shared/events').EventDocument): void {
  const previous = autoArchiveTimers.get(relativePath);
  if (previous) clearTimeout(previous);
  const dueAt = document.current
    .map((event) => event.closedAt ? Date.parse(event.closedAt) + 24 * 60 * 60 * 1000 : Number.NaN)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  if (dueAt === undefined) {
    autoArchiveTimers.delete(relativePath);
    return;
  }
  const delay = Math.max(0, dueAt - Date.now());
  autoArchiveTimers.set(relativePath, setTimeout(() => {
    autoArchiveTimers.delete(relativePath);
    void archiveDueTodoRoots(relativePath);
  }, delay));
}

async function archiveDueTodoRoots(relativePath: string): Promise<void> {
  const workspacePath = workspaceSession.getWorkspacePath();
  if (!workspacePath) return;
  if (!eventMutationService || eventMutationWorkspacePath !== workspacePath) {
    eventMutationService = new EventMutationService(new EventDocumentService(workspacePath, path.join(app.getPath('userData'), 'file-metadata', 'workspaces', workspaceMetadataKey(workspacePath), 'documents')));
    eventMutationWorkspacePath = workspacePath;
  }
  const result = await eventMutationService.mutate(relativePath, (document) => archiveExpiredRootEvents(document));
  await workspaceSession.refreshManagedFile(relativePath);
  broadcastWorkspaceState();
  const payload = await getFileWindowV2PayloadWithStoredState(relativePath);
  if (payload) fileWindowsV2.sendFileChanged(payload.relativePath, { ...payload, eventDocument: result });
}

function mergeFileWindowV2PendingUpdates(
  relativePath: string,
  summaries: Record<string, ModuleUpdateSummary>,
): void {
  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  pendingFileUpdates = mergeFileUpdateSummaries({
    current: pendingFileUpdates,
    relativePath: normalizedPath,
    summaries,
    fileWindowOpen: fileWindowsV2.hasLiveWindow(normalizedPath),
  });
  const payload = workspaceSession.getFileWindowV2InitialPayload(relativePath);

  if (!payload) {
    return;
  }

  pendingFileUpdates = prunePendingFileUpdatesForPayload(pendingFileUpdates, payload.relativePath, payload.modules);
  persistPendingFileUpdates();
}

async function sendFileWindowV2Payload(relativePath: string): Promise<number> {
  const start = process.env.NODE_ENV === 'development' ? Date.now() : 0;
  const payload = await getFileWindowV2PayloadWithStoredState(relativePath);

  if (!payload) {
    return 0;
  }

  const sent = fileWindowsV2.sendFileChanged(payload.relativePath, payload);

  if (process.env.NODE_ENV === 'development') {
    console.log(`[perf:sendFileWindowV2Payload] ${relativePath} ${Date.now() - start}ms`);
  }

  return sent;
}

function sendFileWindowV2PendingUpdates(relativePath: string): number {
  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  const pendingUpdates = getFileWindowV2UpdatePayload(pendingFileUpdates, normalizedPath) ?? {
    relativePath: normalizedPath,
    fileAttention: false,
    modules: {},
    structureChanged: false,
  };

  return fileWindowsV2.sendFilePendingUpdates(normalizedPath, pendingUpdates);
}

function broadcastEmptyFileWindowV2PendingUpdates(): number {
  return fileWindowsV2.broadcastPendingUpdates((relativePath) => ({
    relativePath,
    fileAttention: false,
    modules: {},
    structureChanged: false,
  }));
}

function persistPendingFileUpdates(): void {
  void localStateService.setPendingFileUpdates(workspaceSession.getWorkspacePath(), pendingFileUpdates);
}

async function restorePendingFileUpdatesFromState(
  pendingUpdates: PendingFileUpdateIndex,
): Promise<void> {
  const before = JSON.stringify(pendingUpdates);
  let next = pendingUpdates;

  for (const relativePath of Object.keys(next)) {
    const payload = workspaceSession.getFileWindowV2InitialPayload(relativePath);

    if (payload) {
      next = prunePendingFileUpdatesForPayload(next, payload.relativePath, payload.modules);
    } else {
      next = clearPendingFile(next, relativePath);
      await localStateService.removePendingFileUpdates(workspaceSession.getWorkspacePath(), relativePath);
      await localStateService.removeFileWindowV2State(workspaceSession.getWorkspacePath(), relativePath);
    }
  }

  pendingFileUpdates = next;

  if (JSON.stringify(next) !== before) {
    persistPendingFileUpdates();
  }
}

function broadcastLauncherPendingUpdates() {
  launcherWindow?.webContents.send('workboard:launcher-pending-updates-changed', getLauncherPendingUpdates());
}

function getLauncherPendingUpdates(): LauncherPendingUpdatesPayload {
  const updatedFilePaths = deriveUpdatedFilePaths(pendingFileUpdates);

  return {
    updatedFilePaths,
    openFilePaths: fileWindowsV2.getLiveRelativePaths(),
    hasHiddenUpdates: updatedFilePaths.some((relativePath) => {
      const file = workspaceSession.getState().files.find((candidate) => candidate.path === relativePath);

      return file?.hidden === true;
    }),
  };
}

function loadRenderer(window: BrowserWindow, params: Record<string, string>) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    let allowed = false;

    try {
      const target = new URL(navigationUrl);
      allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL
        ? target.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
        : target.protocol === 'file:';
    } catch {
      allowed = false;
    }

    if (!allowed) {
      event.preventDefault();
    }
  });

  if (updateDiagnosticsEnabled) {
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message.includes('workboard:update-renderer')) {
        console.log(message);
      }
    });
  }

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[loadRenderer] did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[loadRenderer] render-process-gone:', details.reason, details.exitCode);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.search = new URLSearchParams({ ...params, locale: appLocale }).toString();
    void window.loadURL(url.toString());
    return;
  }

  void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
    query: { ...params, locale: appLocale },
  });
}

function getWindowBounds(window: BrowserWindow): WindowBounds {
  const bounds = window.getBounds();

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function ensureVisibleBounds(bounds: WindowBounds | undefined): WindowBounds | undefined {
  return ensureWindowBoundsVisible(bounds, screen.getAllDisplays().map((display) => display.workArea));
}

function windowOptionsFromBounds(bounds: WindowBounds | undefined): Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height'> {
  const visibleBounds = ensureVisibleBounds(bounds);

  if (!visibleBounds) {
    return {};
  }

  return visibleBounds;
}

function focusWindow(window: BrowserWindow) {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
}

function focusExistingWorkboardWindow() {
  if (launcherWindow) {
    focusWindow(launcherWindow);
  }
}

function persistLauncherBounds(window: BrowserWindow) {
  void localStateService.updateLauncherViewState(workspaceSession.getWorkspacePath(), {
    bounds: getWindowBounds(window),
    alwaysOnTop: window.isAlwaysOnTop(),
  });
}

async function reconcileActivityState(): Promise<void> {
  const workspacePath = workspaceSession.getWorkspacePath();

  if (!localStateService || !workspacePath) {
    return;
  }

  const current = await localStateService.getWorkspaceActivityState(workspacePath);
  const result = reconcileWorkspaceActivity(current, workspaceSession.getState().files);
  workspaceSession.setActivityState(result.activity);

  if (result.changed) {
    await localStateService.setWorkspaceActivityState(workspacePath, result.activity);
  }
}

async function updateActivityForRefresh(
  relativePath: string,
  result: ManagedFileRefreshResult,
  summaries: ReturnType<typeof buildModuleUpdateSummaries>,
  changedAt: number,
): Promise<void> {
  const workspacePath = workspaceSession.getWorkspacePath();

  if (!localStateService || !workspacePath) {
    return;
  }

  const current = await localStateService.getWorkspaceActivityState(workspacePath);
  const fileActivity = updateFileActivity({
    currentFileActivity: current.files[relativePath],
    nextFile: result.next.parsedFile,
    summaries,
    changedAt,
    initialAt: result.next.sourceMtimeMs ?? changedAt,
  });
  const nextActivity = {
    files: {
      ...current.files,
      ...(fileActivity ? { [relativePath]: fileActivity } : {}),
    },
  };

  workspaceSession.setActivityState(nextActivity);
  await localStateService.setWorkspaceActivityState(workspacePath, nextActivity);
}

async function getStoredFileWindowV2State(relativePath: string): Promise<FileWindowV2State | undefined> {
  const uiState = await localStateService.getWorkspaceUiState(workspaceSession.getWorkspacePath());

  return uiState.fileWindowsV2[normalizeFileWindowV2Path(relativePath)];
}

async function updateFileWindowV2StateIfManaged(
  relativePath: string,
  state: Partial<FileWindowV2State>,
): Promise<void> {
  const normalizedPath = normalizeFileWindowV2Path(relativePath);

  if (workspaceSession.isTemporaryFile(normalizedPath)) {
    await localStateService.removeFileWindowV2State(workspaceSession.getWorkspacePath(), normalizedPath);
    return;
  }

  // If a purge is in progress for this path, the registry entry has already
  // been removed, the persisted state has been cleared, and the window is
  // about to close. Any in-flight write that has already passed the registry
  // check must still be dropped, otherwise it would resurrect the FileWindowV2
  // state we just purged. The flag is cleared in the 'closed' handler and at
  // the end of `purgeManagedFileState` itself, so the window only becomes
  // writable again on a future `open-file-window-v2` call.
  if (purgingFileWindowV2Paths.has(normalizedPath)) {
    return;
  }

  if (!workspaceSession.getFileWindowV2InitialPayload(normalizedPath)) {
    await localStateService.removeFileWindowV2State(workspaceSession.getWorkspacePath(), normalizedPath);
    return;
  }

  await localStateService.updateFileWindowV2State(workspaceSession.getWorkspacePath(), normalizedPath, state);
}

function persistFileWindowV2State(
  relativePath: string,
  window: BrowserWindow,
  state: Partial<FileWindowV2State> = {},
) {
  void updateFileWindowV2StateIfManaged(relativePath, {
    bounds: getWindowBounds(window),
    alwaysOnTop: window.isAlwaysOnTop(),
    ...state,
  });
}

function scheduleFileWindowV2BoundsSave(relativePath: string, window: BrowserWindow) {
  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  const existingTimer = pendingFileWindowV2BoundsTimers.get(normalizedPath);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    pendingFileWindowV2BoundsTimers.delete(normalizedPath);
    persistFileWindowV2State(normalizedPath, window);
  }, 200);

  pendingFileWindowV2BoundsTimers.set(normalizedPath, timer);
}

function flushFileWindowV2BoundsSave(relativePath: string, window: BrowserWindow) {
  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  const existingTimer = pendingFileWindowV2BoundsTimers.get(normalizedPath);

  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingFileWindowV2BoundsTimers.delete(normalizedPath);
  }

  persistFileWindowV2State(normalizedPath, window);
}

function findFileWindowV2PathByWindow(window: BrowserWindow): string | null {
  for (const [relativePath, fileWindow] of fileWindowsV2.entries()) {
    if (fileWindow === window) {
      return relativePath;
    }
  }

  return null;
}

function isRegisteredFileWindowV2(relativePath: string, window: BrowserWindow | null): boolean {
  return Boolean(window && fileWindowsV2.get(relativePath) === window);
}

function createLauncherWindow(initialState?: LauncherViewState) {
  const launcherBounds = initialState?.bounds && initialState.bounds.width >= 560 ? initialState.bounds : undefined;
  launcherWindow = new BrowserWindow({
    width: 680,
    height: 620,
    ...windowOptionsFromBounds(launcherBounds),
    autoHideMenuBar: true,
    frame: false,
    minWidth: 520,
    minHeight: 480,
    title: 'Worktrace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  launcherWindow.setAlwaysOnTop(initialState?.alwaysOnTop === true);
  loadRenderer(launcherWindow, { view: 'launcher' });

  launcherWindow.on('moved', () => persistLauncherBounds(launcherWindow!));
  launcherWindow.on('resized', () => persistLauncherBounds(launcherWindow!));
  launcherWindow.on('close', () => {
    if (launcherWindow) {
      persistLauncherBounds(launcherWindow);
    }
  });
  launcherWindow.on('closed', () => {
    launcherWindow = null;
  });
}

function createFileWindowV2(
  relativePath: string,
  payload: FileWindowV2InitialPayload,
  initialState?: FileWindowV2State,
): BrowserWindow {
  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  const fileWindow = new BrowserWindow({
    // Fit the calendar grid and its event sidebar without requiring a manual resize.
    width: 900,
    height: 700,
    ...windowOptionsFromBounds(initialState?.bounds),
    autoHideMenuBar: true,
    frame: false,
    minWidth: 360,
    minHeight: 260,
    title: `FileWindowV2 - ${payload.displayName}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  fileWindowsV2.set(normalizedPath, fileWindow);
  fileWindow.setAlwaysOnTop(initialState?.alwaysOnTop === true);
  persistFileWindowV2State(normalizedPath, fileWindow, {
    activeModuleKey: payload.initialModuleKey,
    alwaysOnTop: fileWindow.isAlwaysOnTop(),
    restoreOnLaunch: true,
  });
  loadRenderer(fileWindow, { view: 'file-v2', relativePath: normalizedPath });

  fileWindow.on('moved', () => scheduleFileWindowV2BoundsSave(normalizedPath, fileWindow));
  fileWindow.on('resized', () => scheduleFileWindowV2BoundsSave(normalizedPath, fileWindow));
  fileWindow.on('close', () => {
    // When a path is being purged from Workboard (rename/move/delete/archive),
    // the close handler must not flush bounds or re-persist the FileWindowV2
    // state. Otherwise the file we just cleared would be silently restored to
    // local state. The registry entry, debounced bounds timer, and persisted
    // state have already been removed by `purgeManagedFileState`, so this
    // close only needs to let Electron tear down the window.
    if (purgingFileWindowV2Paths.has(normalizedPath)) {
      return;
    }

    flushFileWindowV2BoundsSave(normalizedPath, fileWindow);
    persistFileWindowV2State(normalizedPath, fileWindow, {
      restoreOnLaunch: isQuitting || preservingCloseFileWindowV2Paths.has(normalizedPath),
    });
  });
  fileWindow.on('closed', () => {
    const workspaceSwitching = preservingCloseFileWindowV2Paths.has(normalizedPath);
    fileWindowsV2.delete(normalizedPath, fileWindow);
    preservingCloseFileWindowV2Paths.delete(normalizedPath);
    purgingFileWindowV2Paths.delete(normalizedPath);

    if (workspaceSession.unregisterTemporaryFile(normalizedPath)) {
      transientUpdateState.clearFile(normalizedPath);
      pendingFileUpdates = clearPendingFile(pendingFileUpdates, normalizedPath);
      const workspacePath = workspaceSession.getWorkspacePath();
      void Promise.all([
        localStateService.removePendingFileUpdates(workspacePath, normalizedPath),
        localStateService.removeFileWindowV2State(workspacePath, normalizedPath),
        localStateService.removeActivityForFile(workspacePath, normalizedPath),
        localStateService.removeModuleViewStatesForFile(workspacePath, normalizedPath),
        workspaceSession.removeFileStyles(normalizedPath),
      ]);
      if (!isQuitting && !workspaceSwitching) {
        void managedFileWatcher.sync();
      }
      broadcastWorkspaceState();
    }

    const fileUpdates = pendingFileUpdates[normalizedPath];
    if (fileUpdates) {
      const hasRemaining = Object.values(fileUpdates.modules).some((m) => m.changedHeadingKeys.length > 0);
      if (hasRemaining) {
        pendingFileUpdates = {
          ...pendingFileUpdates,
          [normalizedPath]: { ...fileUpdates, fileAttention: true },
        };
        persistPendingFileUpdates();
      }
    }

    broadcastLauncherPendingUpdates();
  });

  return fileWindow;
}

async function restoreFileWindowsV2OnLaunch(states: Record<string, FileWindowV2State>): Promise<void> {
  for (const state of Object.values(states)) {
    const normalizedPath = normalizeFileWindowV2Path(state.relativePath);

    if (!state.restoreOnLaunch || fileWindowsV2.get(normalizedPath)) {
      continue;
    }

    const payload = await getFileWindowV2PayloadWithStoredState(normalizedPath);

    if (!payload) {
      continue;
    }

    createFileWindowV2(normalizedPath, payload, state);
  }
}

async function closeFileWindowsV2ForWorkspaceSwitch(): Promise<void> {
  const closings: Array<Promise<void>> = [];

  for (const [relativePath, fileWindow] of fileWindowsV2.entries()) {
    preservingCloseFileWindowV2Paths.add(relativePath);
    flushFileWindowV2BoundsSave(relativePath, fileWindow);
    fileWindowsV2.delete(relativePath, fileWindow);
    closings.push(closeWindowAndWait(fileWindow));
  }

  await Promise.all(closings);
}

function closeWindowAndWait(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.once('closed', resolve);
    window.close();
  });
}

ipcMain.handle('workboard:ping', (): PingResponse => {
  return {
    appName: 'Worktrace',
    ok: true,
  };
});

ipcMain.handle('workboard:get-app-preferences', async (): Promise<AppPreferences> => {
  return localStateService.getAppPreferences();
});

ipcMain.handle('workboard:set-app-locale', async (_event, locale: unknown): Promise<AppPreferences> => {
  if (!isAppLocale(locale)) {
    throw new Error('Invalid application locale.');
  }

  const preferences = await localStateService.setAppLocale(locale);
  appLocale = preferences.locale;
  broadcastAppPreferences(preferences);

  return preferences;
});

ipcMain.handle('workboard:get-workspace-state', async (): Promise<WorkspaceState> => {
  await restoreWorkspacePromise;

  return getWorkspaceState();
});

ipcMain.handle('workboard:choose-workspace', async (): Promise<WorkspaceState> => {
  const options: OpenDialogOptions = {
    title: translate(appLocale, 'workspace.select'),
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = launcherWindow
    ? await dialog.showOpenDialog(launcherWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return getWorkspaceState();
  }

  await managedFileWatcher.stop();
  await closeFileWindowsV2ForWorkspaceSwitch();
  clearTransientUpdateState();
  const state = await workspaceSession.openWorkspace(result.filePaths[0]);
  await localStateService.setLastWorkspacePath(state.workspacePath);
  const uiState = await localStateService.getWorkspaceUiState(workspaceSession.getWorkspacePath());
  await restorePendingFileUpdatesFromState(uiState.pendingFileUpdates);
  await reconcileActivityState();
  await managedFileWatcher.start();
  broadcastWorkspaceState();
  broadcastLauncherPendingUpdates();

  return getWorkspaceState();
});

ipcMain.handle('workboard:create-todo-file', async (_event, name: unknown): Promise<{ relativePath: string; state: WorkspaceState }> => {
  await restoreWorkspacePromise;
  if (typeof name !== 'string') throw new Error('Invalid work plan name.');
  const relativePath = await workspaceSession.createTodoFile(name);
  await managedFileWatcher.sync();
  broadcastLauncherPendingUpdates();
  broadcastWorkspaceState();
  return { relativePath, state: getWorkspaceState() };
});

ipcMain.handle('workboard:create-todo-plan', async (_event, name: unknown): Promise<OpenFileWindowV2Result> => {
  await restoreWorkspacePromise;
  if (typeof name !== 'string' || !name.trim()) throw new Error('Invalid work plan name.');

  const baseName = name.trim().replace(/\.md$/i, '').trim();
  const defaultPlansPath = path.join(app.getPath('documents'), 'Worktrace');
  await fs.mkdir(defaultPlansPath, { recursive: true });
  const filePath = path.join(defaultPlansPath, `${baseName}.md`);
  const parentDirectory = path.dirname(filePath);
  const workspacePath = workspaceSession.getWorkspacePath();
  if (!workspacePath || !pathsEqual(workspacePath, parentDirectory)) {
    await managedFileWatcher.stop();
    await closeFileWindowsV2ForWorkspaceSwitch();
    clearTransientUpdateState();
    await workspaceSession.openWorkspace(parentDirectory);
    await managedFileWatcher.start();
  }

  await workspaceSession.createTodoFileAt(path.basename(filePath));
  const { relativePath } = await workspaceSession.registerTemporaryFile(filePath);
  await managedFileWatcher.sync();
  const payload = await getFileWindowV2PayloadWithStoredState(relativePath);
  if (!payload) return { ok: false, reason: 'File is unavailable.' };
  if (!fileWindowsV2.focusExisting(relativePath)) createFileWindowV2(relativePath, payload);
  await localStateService.recordRecentFile(filePath);
  broadcastWorkspaceState();
  broadcastLauncherPendingUpdates();
  return { ok: true };
});

ipcMain.handle('workboard:get-recent-files', async () => localStateService.getRecentFiles());

ipcMain.handle('workboard:open-recent-file', async (_event, filePath: unknown): Promise<OpenFileWindowV2Result> => {
  await restoreWorkspacePromise;
  if (typeof filePath !== 'string') return { ok: false, reason: 'Invalid file path.' };
  return openMarkdownFile(filePath);
});

ipcMain.handle('workboard:open-file-window-v2', async (_event, relativePath: unknown): Promise<OpenFileWindowV2Result> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, reason: 'Invalid managed file path.' };
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);

  if (fileWindowsV2.focusExisting(normalizedPath)) {
    pendingFileUpdates = clearFileAttention(pendingFileUpdates, normalizedPath);
    persistPendingFileUpdates();
    broadcastLauncherPendingUpdates();
    return { ok: true };
  }

  const payload = await getFileWindowV2PayloadWithStoredState(normalizedPath);

  if (!payload) {
    return { ok: false, reason: 'File is unavailable.' };
  }

  createFileWindowV2(normalizedPath, payload, await getStoredFileWindowV2State(normalizedPath));
  pendingFileUpdates = clearFileAttention(pendingFileUpdates, normalizedPath);
  persistPendingFileUpdates();
  broadcastLauncherPendingUpdates();

  return { ok: true };
});

ipcMain.handle('workboard:get-file-window-v2-initial-payload', async (
  _event,
  relativePath: unknown,
): Promise<FileWindowV2InitialPayload | null> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return null;
  }

  return getFileWindowV2PayloadWithStoredState(normalizeFileWindowV2Path(relativePath));
});

ipcMain.handle('workboard:mutate-event', async (_event, relativePath: unknown, request: unknown) => {
  await restoreWorkspacePromise;
  if (typeof relativePath !== 'string' || !request || typeof request !== 'object') return null;
  const workspacePath = workspaceSession.getWorkspacePath();
  if (!workspacePath) throw new Error('工作区尚未打开。');
  if (!eventMutationService || eventMutationWorkspacePath !== workspacePath) {
    eventMutationService = new EventMutationService(new EventDocumentService(workspacePath, path.join(app.getPath('userData'), 'file-metadata', 'workspaces', workspaceMetadataKey(workspacePath), 'documents')));
    eventMutationWorkspacePath = workspacePath;
  }
  const input = request as EventMutationRequest;
  if (input.kind === 'status-definition') {
    await eventMutationService.addStatusDefinition({ name: input.name, category: input.category });
    const payload = await getFileWindowV2PayloadWithStoredState(relativePath);
    return payload;
  }
  if (input.kind === 'restore-document') {
    const result = await eventMutationService.replace(relativePath, input.document);
    await workspaceSession.refreshManagedFile(relativePath);
    broadcastWorkspaceState();
    const payload = await getFileWindowV2PayloadWithStoredState(relativePath);
    if (payload) {
      const refreshed = { ...payload, eventDocument: result };
      fileWindowsV2.sendFileChanged(refreshed.relativePath, refreshed);
      return refreshed;
    }
    throw new Error('事件恢复成功，但工作计划窗口已不可用。');
  }
  const result = await eventMutationService.mutate(relativePath, (document) => {
    switch (input.kind) {
      case 'create': return createEvent(document, input);
      case 'create-child': return createChildEvent(document, input.parentId, input);
      case 'create-sibling': return createSiblingEvent(document, input.eventId, input);
      case 'title': return updateTitle(document, input.eventId, input.title);
      case 'status': return updateStatus(document, input.eventId, input.status);
      case 'tags': return updateTags(document, input.eventId, input.tags);
      case 'note': return updateNote(document, input.eventId, input.note);
      case 'deadline': return updateDeadline(document, input.eventId, input.deadline);
      case 'created-at': return updateCreatedAt(document, input.eventId, input.createdAt);
      case 'closed-at': return updateClosedAt(document, input.eventId, input.closedAt);
      case 'archive': return archiveEvent(document, input.eventId);
      case 'delete': return deleteEvent(document, input.eventId);
      case 'move': return moveEvent(document, input.eventId, { parentId: input.parentId, index: input.index });
      case 'indent': return indentEvent(document, input.eventId);
      case 'outdent': return outdentEvent(document, input.eventId);
      default: throw new Error('不支持的事件操作。');
    }
  });
  await workspaceSession.refreshManagedFile(relativePath);
  broadcastWorkspaceState();
  const payload = await getFileWindowV2PayloadWithStoredState(relativePath);
  if (payload) {
    const refreshed = { ...payload, eventDocument: result };
    fileWindowsV2.sendFileChanged(refreshed.relativePath, refreshed);
    return refreshed;
  }
  throw new Error('事件保存成功，但工作计划窗口已不可用。');
});

ipcMain.handle('workboard:get-launcher-pending-updates', async (): Promise<LauncherPendingUpdatesPayload> => {
  await restoreWorkspacePromise;

  return getLauncherPendingUpdates();
});

ipcMain.handle('workboard:clear-file-window-v2-module-updates', async (
  _event,
  relativePath: unknown,
  moduleKey: unknown,
): Promise<void> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return;
  }

  if (typeof moduleKey !== 'string' || moduleKey.length === 0) {
    return;
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  pendingFileUpdates = clearPendingModule(pendingFileUpdates, normalizedPath, moduleKey);
  persistPendingFileUpdates();
  sendFileWindowV2PendingUpdates(normalizedPath);
  broadcastLauncherPendingUpdates();
});

ipcMain.handle('workboard:clear-file-window-v2-heading-update', async (
  _event,
  relativePath: unknown,
  moduleKey: unknown,
  headingKey: unknown,
): Promise<void> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return;
  }

  if (typeof moduleKey !== 'string' || moduleKey.length === 0) {
    return;
  }

  if (typeof headingKey !== 'string' || headingKey.length === 0) {
    return;
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  pendingFileUpdates = clearPendingHeading(pendingFileUpdates, normalizedPath, moduleKey, headingKey);
  persistPendingFileUpdates();
  sendFileWindowV2PendingUpdates(normalizedPath);
  broadcastLauncherPendingUpdates();
});

ipcMain.handle('workboard:clear-file-window-v2-file-updates', async (
  _event,
  relativePath: unknown,
): Promise<void> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return;
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  pendingFileUpdates = clearPendingFile(pendingFileUpdates, normalizedPath);
  persistPendingFileUpdates();
  sendFileWindowV2PendingUpdates(normalizedPath);
  broadcastLauncherPendingUpdates();
});

ipcMain.handle('workboard:clear-file-attention', async (
  _event,
  relativePath: unknown,
): Promise<void> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return;
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  pendingFileUpdates = clearFileAttention(pendingFileUpdates, normalizedPath);
  persistPendingFileUpdates();
  sendFileWindowV2PendingUpdates(normalizedPath);
  broadcastLauncherPendingUpdates();
});

ipcMain.handle('workboard:clear-module-attention', async (
  _event,
  relativePath: unknown,
  moduleKey: unknown,
): Promise<void> => {
  await restoreWorkspacePromise;

  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return;
  }

  if (typeof moduleKey !== 'string' || moduleKey.length === 0) {
    return;
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  pendingFileUpdates = clearModuleAttention(pendingFileUpdates, normalizedPath, moduleKey);
  persistPendingFileUpdates();
  sendFileWindowV2PendingUpdates(normalizedPath);
  broadcastLauncherPendingUpdates();
});

ipcMain.handle('workboard:clear-all-file-window-v2-updates', async (): Promise<void> => {
  await restoreWorkspacePromise;

  pendingFileUpdates = clearAllPending();
  persistPendingFileUpdates();
  broadcastEmptyFileWindowV2PendingUpdates();
  broadcastLauncherPendingUpdates();
});

ipcMain.handle('workboard:get-workspace-ui-state', async (): Promise<WorkspaceUiState> => {
  await restoreWorkspacePromise;

  return localStateService.getWorkspaceUiState(workspaceSession.getWorkspacePath());
});

ipcMain.handle('workboard:update-launcher-view-state', async (_event, state: unknown): Promise<void> => {
  await localStateService.updateLauncherViewState(
    workspaceSession.getWorkspacePath(),
    typeof state === 'object' && state !== null ? (state as Partial<LauncherViewState>) : {},
  );
});

ipcMain.handle('workboard:update-file-window-v2-state', async (
  event,
  relativePath: unknown,
  state: unknown,
): Promise<void> => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid managed file path.');
  }

  const normalizedPath = normalizeFileWindowV2Path(relativePath);
  const currentWindow = BrowserWindow.fromWebContents(event.sender);

  if (!isRegisteredFileWindowV2(normalizedPath, currentWindow)) {
    return;
  }

  await updateFileWindowV2StateIfManaged(
    normalizedPath,
    typeof state === 'object' && state !== null ? (state as Partial<FileWindowV2State>) : {},
  );
});

ipcMain.handle(
  'workboard:set-marker-color',
  async (_event, relativePath: unknown, markerName: unknown, color: unknown): Promise<WorkspaceState> => {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new Error('Invalid file path.');
    }

    if (typeof markerName !== 'string' || markerName.length === 0) {
      throw new Error('Invalid marker name.');
    }

    if (color !== null && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) {
      throw new Error('Invalid marker color.');
    }

    await workspaceSession.setMarkerColor(relativePath, markerName, color);
    broadcastWorkspaceState();

    return getWorkspaceState();
  },
);

ipcMain.handle('workboard:set-current-window-always-on-top', (event, alwaysOnTop: unknown): boolean => {
  if (typeof alwaysOnTop !== 'boolean') {
    throw new Error('Invalid always-on-top value.');
  }

  const currentWindow = BrowserWindow.fromWebContents(event.sender);

  if (!currentWindow) {
    return false;
  }

  currentWindow.setAlwaysOnTop(alwaysOnTop);
  const fileWindowV2Path = findFileWindowV2PathByWindow(currentWindow);

  if (currentWindow === launcherWindow) {
    void localStateService.updateLauncherViewState(workspaceSession.getWorkspacePath(), {
      alwaysOnTop: currentWindow.isAlwaysOnTop(),
      bounds: getWindowBounds(currentWindow),
    });
  } else if (fileWindowV2Path) {
    persistFileWindowV2State(fileWindowV2Path, currentWindow, {
      alwaysOnTop: currentWindow.isAlwaysOnTop(),
    });
  }

  return currentWindow.isAlwaysOnTop();
});

ipcMain.handle('workboard:get-current-window-always-on-top', (event): boolean => {
  const currentWindow = BrowserWindow.fromWebContents(event.sender);

  return currentWindow?.isAlwaysOnTop() === true;
});

ipcMain.handle('workboard:control-current-window', (event, action: unknown): void => {
  if (action !== 'minimize' && action !== 'toggle-maximize' && action !== 'close') {
    throw new Error('Invalid window control action.');
  }

  const currentWindow = BrowserWindow.fromWebContents(event.sender);

  if (!currentWindow) {
    return;
  }

  const windowAction: WindowControlAction = action;

  switch (windowAction) {
    case 'minimize':
      currentWindow.minimize();
      break;
    case 'toggle-maximize':
      if (currentWindow.isMaximized()) {
        currentWindow.unmaximize();
      } else {
        currentWindow.maximize();
      }
      break;
    case 'close':
      currentWindow.close();
      break;
  }
});

ipcMain.handle('workboard:set-file-pinned', async (_event, relativePath: unknown, pinned: unknown): Promise<WorkspaceState> => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid managed file path.');
  }

  if (typeof pinned !== 'boolean') {
    throw new Error('Invalid pinned value.');
  }

  const state = await workspaceSession.setFilePinned(relativePath, pinned);
  broadcastWorkspaceState();

  return state;
});

ipcMain.handle('workboard:set-file-hidden', async (_event, relativePath: unknown, hidden: unknown): Promise<WorkspaceState> => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid managed file path.');
  }

  if (typeof hidden !== 'boolean') {
    throw new Error('Invalid hidden value.');
  }

  const state = await workspaceSession.setFileHidden(relativePath, hidden);
  broadcastWorkspaceState();

  return state;
});

ipcMain.handle('workboard:set-show-hidden-files', async (_event, showHiddenFiles: unknown): Promise<WorkspaceState> => {
  if (typeof showHiddenFiles !== 'boolean') {
    throw new Error('Invalid show-hidden value.');
  }

  const state = await workspaceSession.setShowHiddenFiles(showHiddenFiles);
  broadcastWorkspaceState();

  return state;
});

ipcMain.handle('workboard:archive-managed-file', async (_event, relativePath: unknown): Promise<ArchiveManagedFileResult> => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid managed file path.');
  }

  let archivedPath: string | null = null;

  try {
    await cleanupRemovedRepositoryFileState(relativePath, async () => {
      const result = await workspaceSession.archiveFile(relativePath);
      archivedPath = result.archivedPath;
    });
  } catch (error) {
    if (archivedPath) {
      const workspacePath = workspaceSession.getWorkspacePath();
      const archivedLocation = workspacePath ? path.join(workspacePath, archivedPath) : archivedPath;
      const reason = error instanceof Error ? error.message : 'Unknown cleanup failure.';

      throw new Error(`File was moved to ${archivedLocation}, but Worktrace cleanup failed: ${reason}`);
    }

    throw error;
  }

  broadcastWorkspaceState();

  if (!archivedPath) {
    throw new Error('Archive did not return a target path.');
  }

  return {
    archivedPath,
    state: getWorkspaceState(),
  };
});

ipcMain.handle('workboard:open-source-file', async (_event, relativePath: unknown): Promise<void> => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid managed file path.');
  }

  const absolutePath = await workspaceSession.getAbsoluteManagedFilePath(relativePath);
  await shell.openPath(absolutePath);
});

ipcMain.handle('workboard:show-file-in-folder', async (_event, relativePath: unknown): Promise<void> => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid managed file path.');
  }

  const absolutePath = await workspaceSession.getAbsoluteManagedFilePath(relativePath);
  shell.showItemInFolder(absolutePath);
});

ipcMain.handle('workboard:open-external-url', async (_event, url: unknown): Promise<void> => {
  if (typeof url !== 'string') {
    throw new Error('Invalid URL.');
  }

  const parsed = new URL(url);

  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw new Error('Unsupported link protocol.');
  }

  await shell.openExternal(parsed.toString());
});

ipcMain.handle(
  'workboard:get-workflow-package-catalog',
  (): Promise<WorkflowPackageCatalog> => aiCodingWorkflowService.getPackageCatalog(),
);

ipcMain.handle('workboard:open-bundled-workflow-package', async (_event, packageId: unknown): Promise<void> => {
  if (typeof packageId !== 'string') {
    throw new Error('Invalid bundled workflow package id.');
  }

  await shell.openPath(await aiCodingWorkflowService.getBundledPackageRootPath(packageId));
});

ipcMain.handle('workboard:add-managed-directory', async (_event, relativePath?: unknown): Promise<WorkspaceState> => {
  const workspacePath = workspaceSession.getWorkspacePath();

  if (!workspacePath) {
    throw new Error('No workspace is open.');
  }

  let directoryPath: string;

  if (typeof relativePath === 'string') {
    directoryPath = relativePath;
  } else {
    const options: OpenDialogOptions = { properties: ['openDirectory'], defaultPath: workspacePath };
    const result = launcherWindow ? await dialog.showOpenDialog(launcherWindow, options) : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return getWorkspaceState();
    }
    directoryPath = result.filePaths[0];
  }

  const change = await workspaceSession.addManagedDirectory(directoryPath);
  await managedFileWatcher.sync();
  await handleManagedFileSetChange(change);
  return getWorkspaceState();
});

ipcMain.handle('workboard:list-workspace-directory', async (_event, relativeDirectory: unknown) => {
  if (relativeDirectory !== undefined && typeof relativeDirectory !== 'string') {
    throw new Error('Invalid workspace directory path.');
  }

  return workspaceSession.listWorkspaceDirectory(relativeDirectory || '.');
});

ipcMain.handle('workboard:refresh-managed-files', async (): Promise<WorkspaceState> => {
  const change = await workspaceSession.reconcileDiscoveredFiles();
  await managedFileWatcher.sync();
  await handleManagedFileSetChange(change);
  return getWorkspaceState();
});

ipcMain.handle('workboard:remove-managed-directory', async (_event, relativePath: unknown): Promise<WorkspaceState> => {
  if (typeof relativePath !== 'string') {
    throw new Error('Invalid managed directory path.');
  }

  for (const openPath of fileWindowsV2.getLiveRelativePaths()) {
    if (relativePath === '.' || openPath.toLowerCase().startsWith(`${relativePath.toLowerCase()}/`)) {
      workspaceSession.retainTemporaryFile(openPath);
    }
  }

  const change = await workspaceSession.removeManagedDirectory(relativePath);
  await managedFileWatcher.sync();
  await handleManagedFileSetChange(change);
  return getWorkspaceState();
});

ipcMain.handle('workboard:add-managed-file', async (_event, relativePath?: unknown): Promise<WorkspaceState> => {
  const workspacePath = workspaceSession.getWorkspacePath();

  if (!workspacePath) {
    throw new Error('No workspace is open.');
  }

  let filePath: string;

  if (typeof relativePath === 'string') {
    filePath = path.resolve(workspacePath, relativePath);
  } else {
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      defaultPath: workspacePath,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const result = launcherWindow ? await dialog.showOpenDialog(launcherWindow, options) : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return getWorkspaceState();
    }
    filePath = result.filePaths[0];
  }

  const change = await workspaceSession.addManagedFile(filePath);
  await managedFileWatcher.sync();
  await handleManagedFileSetChange(change);
  if (typeof relativePath === 'string') {
    await sendFileWindowV2Payload(normalizeFileWindowV2Path(relativePath));
  }
  return getWorkspaceState();
});

ipcMain.handle('workboard:remove-managed-file', async (_event, relativePath: unknown): Promise<WorkspaceState> => {
  if (typeof relativePath !== 'string') {
    throw new Error('Invalid managed file path.');
  }

  if (fileWindowsV2.hasLiveWindow(relativePath)) {
    workspaceSession.retainTemporaryFile(relativePath);
  }

  const change = await workspaceSession.removeManagedFile(relativePath);
  await managedFileWatcher.sync();
  await handleManagedFileSetChange(change);
  return getWorkspaceState();
});

ipcMain.handle('workboard:open-managed-scope-path', async (_event, relativePath: unknown): Promise<void> => {
  const workspacePath = workspaceSession.getWorkspacePath();

  if (!workspacePath || typeof relativePath !== 'string') {
    throw new Error('Invalid managed scope path.');
  }

  const absolutePath = path.resolve(workspacePath, relativePath);
  const state = workspaceSession.getState();

  if (state.managedDirectories.some((directory) => pathsEqual(directory, relativePath))) {
    await shell.openPath(absolutePath);
    return;
  }

  if (state.managedFiles.some((file) => pathsEqual(file, relativePath))) {
    shell.showItemInFolder(absolutePath);
    return;
  }

  throw new Error('Managed scope path is unavailable.');
});

ipcMain.handle('workboard:open-temporary-file-window-v2', async (): Promise<OpenFileWindowV2Result> => {
  const workspacePath = workspaceSession.getWorkspacePath();

  const options: OpenDialogOptions = {
    properties: ['openFile'],
    defaultPath: workspacePath ?? undefined,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const result = launcherWindow ? await dialog.showOpenDialog(launcherWindow, options) : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: true };
  }

  return openMarkdownFile(result.filePaths[0]);
});

ipcMain.handle(
  'workboard:restore-bundled-workflow-package',
  async (_event, packageId: unknown): Promise<WorkflowPackageCatalog | null> => {
    if (typeof packageId !== 'string') {
      throw new Error('Invalid bundled workflow package id.');
    }

    const options = {
      type: 'warning' as const,
      buttons: [translate(appLocale, 'workflow.restorePackage'), translate(appLocale, 'common.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: translate(appLocale, 'workflow.dialog.restorePackageTitle'),
      message: translate(appLocale, 'workflow.dialog.restorePackageMessage'),
      detail: translate(appLocale, 'workflow.dialog.restorePackageDetail'),
    };
    const result = launcherWindow
      ? await dialog.showMessageBox(launcherWindow, options)
      : await dialog.showMessageBox(options);

    if (result.response !== 0) {
      return null;
    }

    return aiCodingWorkflowService.restoreBundledPackage(packageId);
  },
);

ipcMain.handle(
  'workboard:update-bundled-workflow-package',
  async (_event, packageId: unknown): Promise<BundledWorkflowPackageUpdateResult | null> => {
    if (typeof packageId !== 'string') {
      throw new Error('Invalid bundled workflow package id.');
    }

    const catalog = await aiCodingWorkflowService.getPackageCatalog();
    const workflowPackage = catalog.bundled.find((entry) => entry.id === packageId);

    if (!workflowPackage) {
      throw new Error('Bundled workflow package is unavailable.');
    }

    if (!workflowPackage.updateAvailable) {
      return { catalog };
    }

    const options = {
      type: 'warning' as const,
      buttons: [translate(appLocale, 'workflow.updatePackage'), translate(appLocale, 'common.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: translate(appLocale, 'workflow.dialog.updatePackageTitle'),
      message: translate(appLocale, 'workflow.dialog.updatePackageMessage'),
      detail: translate(
        appLocale,
        workflowPackage.hasLocalChanges
          ? 'workflow.dialog.updatePackageWithBackupDetail'
          : 'workflow.dialog.updatePackageDetail',
      ),
    };
    const result = launcherWindow
      ? await dialog.showMessageBox(launcherWindow, options)
      : await dialog.showMessageBox(options);

    if (result.response !== 0) {
      return null;
    }

    return aiCodingWorkflowService.updateBundledPackage(packageId);
  },
);

ipcMain.handle(
  'workboard:create-user-workflow-package',
  async (_event, name: unknown): Promise<UserWorkflowPackage> => {
    if (typeof name !== 'string') {
      throw new Error('Invalid workflow package name.');
    }

    return aiCodingWorkflowService.createUserPackage(name);
  },
);

ipcMain.handle(
  'workboard:import-folder-as-user-workflow-package',
  async (_event, name: unknown): Promise<UserWorkflowPackage | null> => {
    if (typeof name !== 'string') {
      throw new Error('Invalid workflow package import request.');
    }

    const options: OpenDialogOptions = {
      title: translate(appLocale, 'workflow.dialog.importPackageFolderTitle'),
      properties: ['openDirectory'],
    };
    const result = launcherWindow
      ? await dialog.showOpenDialog(launcherWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return aiCodingWorkflowService.importFolderAsUserPackage(result.filePaths[0], name);
  },
);

ipcMain.handle('workboard:open-user-workflow-package', async (_event, packageId: unknown): Promise<void> => {
  if (typeof packageId !== 'string') {
    throw new Error('Invalid user workflow package id.');
  }

  await shell.openPath(await aiCodingWorkflowService.getUserPackagePath(packageId));
});

ipcMain.handle(
  'workboard:delete-user-workflow-package',
  async (_event, packageId: unknown): Promise<WorkflowPackageCatalog | null> => {
    if (typeof packageId !== 'string') {
      throw new Error('Invalid user workflow package id.');
    }

    const workflowPackage = (await aiCodingWorkflowService.getPackageCatalog()).user.find((entry) => entry.id === packageId);

    if (!workflowPackage) {
      throw new Error('User workflow package is unavailable.');
    }

    const options = {
      type: 'warning' as const,
      buttons: [translate(appLocale, 'workflow.deletePackage'), translate(appLocale, 'common.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: translate(appLocale, 'workflow.dialog.deletePackageTitle'),
      message: translate(appLocale, 'workflow.dialog.deletePackageMessage', { name: workflowPackage.name }),
    };
    const result = launcherWindow
      ? await dialog.showMessageBox(launcherWindow, options)
      : await dialog.showMessageBox(options);

    if (result.response !== 0) {
      return null;
    }

    await aiCodingWorkflowService.deleteUserPackage(packageId);
    return aiCodingWorkflowService.getPackageCatalog();
  },
);

ipcMain.handle(
  'workboard:preview-bundled-ai-coding-workflow',
  async (_event, packageId: unknown, locale: unknown): Promise<WorkflowApplyPlan> => {
    const workspacePath = workspaceSession.getWorkspacePath();

    if (!workspacePath) {
      throw new Error('No workspace is open.');
    }

    if (typeof packageId !== 'string' || !isWorkflowPackageLocale(locale)) {
      throw new Error('Invalid bundled workflow package selection.');
    }

    return aiCodingWorkflowService.createBundledApplyPlan(workspacePath, packageId, locale);
  },
);

ipcMain.handle(
  'workboard:apply-bundled-ai-coding-workflow',
  async (_event, packageId: unknown, locale: unknown, allowOverwrite: unknown): Promise<WorkflowApplyResult> => {
    const workspacePath = workspaceSession.getWorkspacePath();

    if (!workspacePath) {
      throw new Error('No workspace is open.');
    }

    if (typeof packageId !== 'string' || !isWorkflowPackageLocale(locale)) {
      throw new Error('Invalid bundled workflow package selection.');
    }

    return aiCodingWorkflowService.applyBundledToWorkspace(workspacePath, packageId, locale, allowOverwrite === true);
  },
);

ipcMain.handle(
  'workboard:preview-user-workflow-package',
  async (_event, packageId: unknown): Promise<WorkflowApplyPlan> => {
    const workspacePath = workspaceSession.getWorkspacePath();

    if (!workspacePath) {
      throw new Error('No workspace is open.');
    }

    if (typeof packageId !== 'string') {
      throw new Error('Invalid user workflow package selection.');
    }

    return aiCodingWorkflowService.createUserPackageApplyPlan(workspacePath, packageId);
  },
);

ipcMain.handle(
  'workboard:apply-user-workflow-package',
  async (_event, packageId: unknown, allowOverwrite: unknown): Promise<WorkflowApplyResult> => {
    const workspacePath = workspaceSession.getWorkspacePath();

    if (!workspacePath) {
      throw new Error('No workspace is open.');
    }

    if (typeof packageId !== 'string') {
      throw new Error('Invalid user workflow package selection.');
    }

    return aiCodingWorkflowService.applyUserPackageToWorkspace(
      workspacePath,
      packageId,
      allowOverwrite === true,
    );
  },
);

if (hasSingleInstanceLock) {
  app.on('second-instance', () => focusExistingWorkboardWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    localStateService = new LocalStateService(app.getPath('userData'));
    workspaceSession.setMetadataRoot(path.join(app.getPath('userData'), 'file-metadata'));
    appLocale = (await localStateService.getAppPreferences()).locale;
    aiCodingWorkflowService = new AiCodingWorkflowService(app.getPath('userData'), undefined, app.getVersion());
    await aiCodingWorkflowService.ensurePackageLibraryInitialized();

    restoreWorkspacePromise = Promise.resolve().then(async () => {
      clearTransientUpdateState();
      broadcastWorkspaceState();
      return getWorkspaceState();
    });

    await restoreWorkspacePromise;
    const uiState = await localStateService.getWorkspaceUiState(workspaceSession.getWorkspacePath());
    await restorePendingFileUpdatesFromState(uiState.pendingFileUpdates);
    createLauncherWindow(uiState.launcher);

    await restoreFileWindowsV2OnLaunch(uiState.fileWindowsV2);
    broadcastLauncherPendingUpdates();

    broadcastWorkspaceState();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void localStateService.getWorkspaceUiState(workspaceSession.getWorkspacePath()).then((uiState) => {
          createLauncherWindow(uiState.launcher);
        });
      }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;

    for (const [relativePath, fileWindow] of fileWindowsV2.entries()) {
      flushFileWindowV2BoundsSave(relativePath, fileWindow);
      persistFileWindowV2State(relativePath, fileWindow, { restoreOnLaunch: true });
    }

    if (launcherWindow) {
      persistLauncherBounds(launcherWindow);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      void Promise.all([managedFileWatcher.stop(), localStateService?.flush()]).finally(() => app.quit());
    }
  });
}
