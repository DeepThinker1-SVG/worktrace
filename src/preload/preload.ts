import { contextBridge, ipcRenderer } from 'electron';

import type { WorkboardApi } from './api-types';

const api: WorkboardApi = {
  ping: () => ipcRenderer.invoke('workboard:ping') as Promise<Awaited<ReturnType<WorkboardApi['ping']>>>,
  getAppPreferences: () =>
    ipcRenderer.invoke('workboard:get-app-preferences') as Promise<
      Awaited<ReturnType<WorkboardApi['getAppPreferences']>>
    >,
  setAppLocale: (locale) =>
    ipcRenderer.invoke('workboard:set-app-locale', locale) as Promise<
      Awaited<ReturnType<WorkboardApi['setAppLocale']>>
    >,
  onAppPreferencesChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, preferences: unknown) => {
      callback(preferences as Parameters<typeof callback>[0]);
    };

    ipcRenderer.on('workboard:app-preferences-changed', listener);

    return () => {
      ipcRenderer.removeListener('workboard:app-preferences-changed', listener);
    };
  },
  getWorkspaceState: () =>
    ipcRenderer.invoke('workboard:get-workspace-state') as Promise<
      Awaited<ReturnType<WorkboardApi['getWorkspaceState']>>
    >,
  chooseWorkspace: () =>
    ipcRenderer.invoke('workboard:choose-workspace') as Promise<
      Awaited<ReturnType<WorkboardApi['chooseWorkspace']>>
    >,
  createTodoFile: (name) =>
    ipcRenderer.invoke('workboard:create-todo-file', name) as Promise<
      Awaited<ReturnType<WorkboardApi['createTodoFile']>>
    >,
  createTodoPlan: (name) =>
    ipcRenderer.invoke('workboard:create-todo-plan', name) as Promise<
      Awaited<ReturnType<WorkboardApi['createTodoPlan']>>
    >,
  getRecentFiles: () => ipcRenderer.invoke('workboard:get-recent-files') as Promise<Awaited<ReturnType<WorkboardApi['getRecentFiles']>>>,
  openRecentFile: (filePath) => ipcRenderer.invoke('workboard:open-recent-file', filePath) as Promise<Awaited<ReturnType<WorkboardApi['openRecentFile']>>>,
  listWorkspaceDirectory: (relativeDirectory) =>
    ipcRenderer.invoke('workboard:list-workspace-directory', relativeDirectory) as Promise<
      Awaited<ReturnType<WorkboardApi['listWorkspaceDirectory']>>
    >,
  refreshManagedFiles: () =>
    ipcRenderer.invoke('workboard:refresh-managed-files') as Promise<
      Awaited<ReturnType<WorkboardApi['refreshManagedFiles']>>
    >,
  addManagedDirectory: (relativePath) =>
    ipcRenderer.invoke('workboard:add-managed-directory', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['addManagedDirectory']>>
    >,
  removeManagedDirectory: (relativePath) =>
    ipcRenderer.invoke('workboard:remove-managed-directory', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['removeManagedDirectory']>>
    >,
  addManagedFile: (relativePath) =>
    ipcRenderer.invoke('workboard:add-managed-file', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['addManagedFile']>>
    >,
  removeManagedFile: (relativePath) =>
    ipcRenderer.invoke('workboard:remove-managed-file', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['removeManagedFile']>>
    >,
  openManagedScopePath: (relativePath) =>
    ipcRenderer.invoke('workboard:open-managed-scope-path', relativePath) as Promise<void>,
  openTemporaryFileWindowV2: () =>
    ipcRenderer.invoke('workboard:open-temporary-file-window-v2') as Promise<
      Awaited<ReturnType<WorkboardApi['openTemporaryFileWindowV2']>>
    >,
  openFileWindowV2: (relativePath) =>
    ipcRenderer.invoke('workboard:open-file-window-v2', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['openFileWindowV2']>>
    >,
  getFileWindowV2InitialPayload: (relativePath) =>
    ipcRenderer.invoke('workboard:get-file-window-v2-initial-payload', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['getFileWindowV2InitialPayload']>>
    >,
  mutateEvent: (relativePath, request) =>
    ipcRenderer.invoke('workboard:mutate-event', relativePath, request) as Promise<
      Awaited<ReturnType<WorkboardApi['mutateEvent']>>
    >,
  onFileWindowV2FileChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload as Parameters<typeof callback>[0]);
    };

    ipcRenderer.on('workboard:file-window-v2-file-changed', listener);

    return () => {
      ipcRenderer.removeListener('workboard:file-window-v2-file-changed', listener);
    };
  },
  onFileWindowV2PendingUpdatesChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload as Parameters<typeof callback>[0]);
    };

    ipcRenderer.on('workboard:file-window-v2-pending-updates-changed', listener);

    return () => {
      ipcRenderer.removeListener('workboard:file-window-v2-pending-updates-changed', listener);
    };
  },
  clearFileWindowV2ModuleUpdates: (relativePath, moduleKey) =>
    ipcRenderer.invoke('workboard:clear-file-window-v2-module-updates', relativePath, moduleKey) as Promise<void>,
  clearFileWindowV2HeadingUpdate: (relativePath, moduleKey, headingKey) =>
    ipcRenderer.invoke('workboard:clear-file-window-v2-heading-update', relativePath, moduleKey, headingKey) as Promise<void>,
  clearFileWindowV2FileUpdates: (relativePath) =>
    ipcRenderer.invoke('workboard:clear-file-window-v2-file-updates', relativePath) as Promise<void>,
  clearFileWindowV2Attention: (relativePath) =>
    ipcRenderer.invoke('workboard:clear-file-attention', relativePath) as Promise<void>,
  clearFileWindowV2ModuleAttention: (relativePath, moduleKey) =>
    ipcRenderer.invoke('workboard:clear-module-attention', relativePath, moduleKey) as Promise<void>,
  clearAllFileWindowV2Updates: () =>
    ipcRenderer.invoke('workboard:clear-all-file-window-v2-updates') as Promise<void>,
  getLauncherPendingUpdates: () =>
    ipcRenderer.invoke('workboard:get-launcher-pending-updates') as Promise<
      Awaited<ReturnType<WorkboardApi['getLauncherPendingUpdates']>>
    >,
  onLauncherPendingUpdatesChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload as Parameters<typeof callback>[0]);
    };

    ipcRenderer.on('workboard:launcher-pending-updates-changed', listener);

    return () => {
      ipcRenderer.removeListener('workboard:launcher-pending-updates-changed', listener);
    };
  },
  getWorkspaceUiState: () =>
    ipcRenderer.invoke('workboard:get-workspace-ui-state') as Promise<
      Awaited<ReturnType<WorkboardApi['getWorkspaceUiState']>>
    >,
  updateLauncherViewState: (state) =>
    ipcRenderer.invoke('workboard:update-launcher-view-state', state) as Promise<void>,
  updateFileWindowV2State: (relativePath, state) =>
    ipcRenderer.invoke('workboard:update-file-window-v2-state', relativePath, state) as Promise<void>,
  setMarkerColor: (relativePath, markerName, color) =>
    ipcRenderer.invoke('workboard:set-marker-color', relativePath, markerName, color) as Promise<
      Awaited<ReturnType<WorkboardApi['setMarkerColor']>>
    >,
  getCurrentWindowAlwaysOnTop: () =>
    ipcRenderer.invoke('workboard:get-current-window-always-on-top') as Promise<boolean>,
  setCurrentWindowAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('workboard:set-current-window-always-on-top', alwaysOnTop) as Promise<boolean>,
  setFilePinned: (relativePath, pinned) =>
    ipcRenderer.invoke('workboard:set-file-pinned', relativePath, pinned) as Promise<
      Awaited<ReturnType<WorkboardApi['setFilePinned']>>
    >,
  setFileHidden: (relativePath, hidden) =>
    ipcRenderer.invoke('workboard:set-file-hidden', relativePath, hidden) as Promise<
      Awaited<ReturnType<WorkboardApi['setFileHidden']>>
    >,
  setShowHiddenFiles: (showHiddenFiles) =>
    ipcRenderer.invoke('workboard:set-show-hidden-files', showHiddenFiles) as Promise<
      Awaited<ReturnType<WorkboardApi['setShowHiddenFiles']>>
    >,
  archiveManagedFile: (relativePath) =>
    ipcRenderer.invoke('workboard:archive-managed-file', relativePath) as Promise<
      Awaited<ReturnType<WorkboardApi['archiveManagedFile']>>
    >,
  openSourceFile: (relativePath) =>
    ipcRenderer.invoke('workboard:open-source-file', relativePath) as Promise<void>,
  showFileInFolder: (relativePath) =>
    ipcRenderer.invoke('workboard:show-file-in-folder', relativePath) as Promise<void>,
  openExternalUrl: (url) => ipcRenderer.invoke('workboard:open-external-url', url) as Promise<void>,
  getWorkflowPackageCatalog: () =>
    ipcRenderer.invoke('workboard:get-workflow-package-catalog') as Promise<
      Awaited<ReturnType<WorkboardApi['getWorkflowPackageCatalog']>>
    >,
  openBundledWorkflowPackage: (packageId) =>
    ipcRenderer.invoke('workboard:open-bundled-workflow-package', packageId) as Promise<void>,
  restoreBundledWorkflowPackage: (packageId) =>
    ipcRenderer.invoke('workboard:restore-bundled-workflow-package', packageId) as Promise<
      Awaited<ReturnType<WorkboardApi['restoreBundledWorkflowPackage']>>
    >,
  updateBundledWorkflowPackage: (packageId) =>
    ipcRenderer.invoke('workboard:update-bundled-workflow-package', packageId) as Promise<
      Awaited<ReturnType<WorkboardApi['updateBundledWorkflowPackage']>>
    >,
  createUserWorkflowPackage: (name) =>
    ipcRenderer.invoke('workboard:create-user-workflow-package', name) as Promise<
      Awaited<ReturnType<WorkboardApi['createUserWorkflowPackage']>>
    >,
  importFolderAsUserWorkflowPackage: (name) =>
    ipcRenderer.invoke('workboard:import-folder-as-user-workflow-package', name) as Promise<
      Awaited<ReturnType<WorkboardApi['importFolderAsUserWorkflowPackage']>>
    >,
  openUserWorkflowPackage: (packageId) =>
    ipcRenderer.invoke('workboard:open-user-workflow-package', packageId) as Promise<void>,
  deleteUserWorkflowPackage: (packageId) =>
    ipcRenderer.invoke('workboard:delete-user-workflow-package', packageId) as Promise<
      Awaited<ReturnType<WorkboardApi['deleteUserWorkflowPackage']>>
    >,
  previewBundledAiCodingWorkflow: (packageId, locale) =>
    ipcRenderer.invoke('workboard:preview-bundled-ai-coding-workflow', packageId, locale) as Promise<
      Awaited<ReturnType<WorkboardApi['previewBundledAiCodingWorkflow']>>
    >,
  applyBundledAiCodingWorkflow: (packageId, locale, allowOverwrite) =>
    ipcRenderer.invoke('workboard:apply-bundled-ai-coding-workflow', packageId, locale, allowOverwrite) as Promise<
      Awaited<ReturnType<WorkboardApi['applyBundledAiCodingWorkflow']>>
    >,
  previewUserWorkflowPackage: (packageId) =>
    ipcRenderer.invoke('workboard:preview-user-workflow-package', packageId) as Promise<
      Awaited<ReturnType<WorkboardApi['previewUserWorkflowPackage']>>
    >,
  applyUserWorkflowPackage: (packageId, allowOverwrite) =>
    ipcRenderer.invoke('workboard:apply-user-workflow-package', packageId, allowOverwrite) as Promise<
      Awaited<ReturnType<WorkboardApi['applyUserWorkflowPackage']>>
    >,
  controlCurrentWindow: (action) => ipcRenderer.invoke('workboard:control-current-window', action) as Promise<void>,
  onWorkspaceStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      callback(state as Parameters<typeof callback>[0]);
    };

    ipcRenderer.on('workboard:workspace-state-changed', listener);

    return () => {
      ipcRenderer.removeListener('workboard:workspace-state-changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('workboard', api);
