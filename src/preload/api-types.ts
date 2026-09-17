import type {
  ArchiveManagedFileResult,
  FileWindowV2FileUpdatePayload,
  FileWindowV2InitialPayload,
  FileWindowV2State,
  LauncherPendingUpdatesPayload,
  OpenFileWindowV2Result,
  WorkspaceUiState,
  WorkspaceBrowseEntry,
  WorkspaceState,
  EventMutationRequest,
} from '../shared/workspace';
import type {
  BundledWorkflowPackageUpdateResult,
  WorkflowApplyPlan,
  WorkflowApplyResult,
  WorkflowPackageCatalog,
  WorkflowPackageLocale,
  UserWorkflowPackage,
} from '../shared/workflow';
import type { AppLocale, AppPreferences } from '../shared/i18n';
import type { RecentFileEntry } from '../main/services/local-state-service';

export type PingResponse = {
  appName: 'Worktrace';
  ok: true;
};

export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

export type WorkboardApi = {
  ping: () => Promise<PingResponse>;
  getAppPreferences: () => Promise<AppPreferences>;
  setAppLocale: (locale: AppLocale) => Promise<AppPreferences>;
  onAppPreferencesChanged: (callback: (preferences: AppPreferences) => void) => () => void;
  getWorkspaceState: () => Promise<WorkspaceState>;
  chooseWorkspace: () => Promise<WorkspaceState>;
  createTodoFile: (name: string) => Promise<{ relativePath: string; state: WorkspaceState }>;
  createTodoPlan: (name: string) => Promise<OpenFileWindowV2Result>;
  getRecentFiles: () => Promise<RecentFileEntry[]>;
  openRecentFile: (filePath: string) => Promise<OpenFileWindowV2Result>;
  listWorkspaceDirectory: (relativeDirectory?: string) => Promise<WorkspaceBrowseEntry[]>;
  refreshManagedFiles: () => Promise<WorkspaceState>;
  addManagedDirectory: (relativePath?: string) => Promise<WorkspaceState>;
  removeManagedDirectory: (relativePath: string) => Promise<WorkspaceState>;
  addManagedFile: (relativePath?: string) => Promise<WorkspaceState>;
  removeManagedFile: (relativePath: string) => Promise<WorkspaceState>;
  openManagedScopePath: (relativePath: string) => Promise<void>;
  openTemporaryFileWindowV2: () => Promise<OpenFileWindowV2Result>;
  openFileWindowV2: (relativePath: string) => Promise<OpenFileWindowV2Result>;
  getFileWindowV2InitialPayload: (relativePath: string) => Promise<FileWindowV2InitialPayload | null>;
  mutateEvent: (relativePath: string, request: EventMutationRequest) => Promise<FileWindowV2InitialPayload | null>;
  onFileWindowV2FileChanged: (callback: (payload: FileWindowV2InitialPayload) => void) => () => void;
  onFileWindowV2PendingUpdatesChanged: (callback: (payload: FileWindowV2FileUpdatePayload) => void) => () => void;
  clearFileWindowV2ModuleUpdates: (relativePath: string, moduleKey: string) => Promise<void>;
  clearFileWindowV2HeadingUpdate: (relativePath: string, moduleKey: string, headingKey: string) => Promise<void>;
  clearFileWindowV2FileUpdates: (relativePath: string) => Promise<void>;
  clearFileWindowV2Attention: (relativePath: string) => Promise<void>;
  clearFileWindowV2ModuleAttention: (relativePath: string, moduleKey: string) => Promise<void>;
  clearAllFileWindowV2Updates: () => Promise<void>;
  getLauncherPendingUpdates: () => Promise<LauncherPendingUpdatesPayload>;
  onLauncherPendingUpdatesChanged: (callback: (payload: LauncherPendingUpdatesPayload) => void) => () => void;
  getWorkspaceUiState: () => Promise<WorkspaceUiState>;
  updateLauncherViewState: (state: Partial<WorkspaceUiState['launcher']>) => Promise<void>;
  updateFileWindowV2State: (relativePath: string, state: Partial<FileWindowV2State>) => Promise<void>;
  setMarkerColor: (relativePath: string, markerName: string, color: string | null) => Promise<WorkspaceState>;
  getCurrentWindowAlwaysOnTop: () => Promise<boolean>;
  setCurrentWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<boolean>;
  setFilePinned: (relativePath: string, pinned: boolean) => Promise<WorkspaceState>;
  setFileHidden: (relativePath: string, hidden: boolean) => Promise<WorkspaceState>;
  setShowHiddenFiles: (showHiddenFiles: boolean) => Promise<WorkspaceState>;
  archiveManagedFile: (relativePath: string) => Promise<ArchiveManagedFileResult>;
  openSourceFile: (relativePath: string) => Promise<void>;
  showFileInFolder: (relativePath: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  getWorkflowPackageCatalog: () => Promise<WorkflowPackageCatalog>;
  openBundledWorkflowPackage: (packageId: string) => Promise<void>;
  restoreBundledWorkflowPackage: (packageId: string) => Promise<WorkflowPackageCatalog | null>;
  updateBundledWorkflowPackage: (packageId: string) => Promise<BundledWorkflowPackageUpdateResult | null>;
  createUserWorkflowPackage: (name: string) => Promise<UserWorkflowPackage>;
  importFolderAsUserWorkflowPackage: (name: string) => Promise<UserWorkflowPackage | null>;
  openUserWorkflowPackage: (packageId: string) => Promise<void>;
  deleteUserWorkflowPackage: (packageId: string) => Promise<WorkflowPackageCatalog | null>;
  previewBundledAiCodingWorkflow: (packageId: string, locale: WorkflowPackageLocale) => Promise<WorkflowApplyPlan>;
  applyBundledAiCodingWorkflow: (
    packageId: string,
    locale: WorkflowPackageLocale,
    allowOverwrite: boolean,
  ) => Promise<WorkflowApplyResult>;
  previewUserWorkflowPackage: (packageId: string) => Promise<WorkflowApplyPlan>;
  applyUserWorkflowPackage: (
    packageId: string,
    allowOverwrite: boolean,
  ) => Promise<WorkflowApplyResult>;
  controlCurrentWindow: (action: WindowControlAction) => Promise<void>;
  onWorkspaceStateChanged: (callback: (state: WorkspaceState) => void) => () => void;
};
