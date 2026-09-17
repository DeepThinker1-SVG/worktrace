import type { ParsedFile } from '../markdown';
import type { EventDocument, EventStatus } from '../events';

export type ModuleOrderEntry = {
  kind: 'h1' | 'document';
  title: string;
  occurrence: number;
};

export type WorkspaceConfig = {
  schemaVersion: 2;
  managedDirectories: string[];
  managedFiles: string[];
  excludedDirectories: string[];
  excludedFiles: string[];
  pinnedFiles: string[];
  hiddenFiles: string[];
  showHiddenFiles: boolean;
};

export type MarkerStyle = {
  autoColor: string;
  colorOverride?: string;
};

export type FileStylesConfig = {
  markers: Record<string, MarkerStyle>;
};

export type StylesConfig = {
  schemaVersion: 1;
  files: Record<string, FileStylesConfig>;
};

export type ManagedFileStatus = 'available' | 'missing' | 'unreadable' | 'parse-error';

export type ManagedFileState = {
  path: string;
  order: number;
  source: 'repository';
  pinned: boolean;
  hidden: boolean;
  status: ManagedFileStatus;
  statusMessage?: string;
  sourceMtimeMs?: number;
  lastActivityAt?: number;
  parsedFile?: ParsedFile;
};

export type WorkspaceBrowseEntry = {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  hidden: boolean;
  management: 'managed' | 'partial' | 'unmanaged';
  lastActivityAt?: number;
};

export type WorkspaceState = {
  workspacePath: string | null;
  workspaceName: string | null;
  initialized: boolean;
  files: ManagedFileState[];
  managedDirectories: string[];
  managedFiles: string[];
  showHiddenFiles: boolean;
  fileUpdateStatuses: Record<string, FileUpdateStatus>;
  diagnosticUpdate?: WorkspaceDiagnosticUpdate;
  error?: string;
};

export type FileUpdateStatus = {
  phase: 'updating' | 'recentlyUpdated' | 'error';
  updatedAt: number;
};

export type WorkspaceDiagnosticUpdate = {
  id: number;
  relativePath: string;
  broadcastAt: number;
};

export type ArchiveManagedFileResult = {
  archivedPath: string;
  state: WorkspaceState;
};

export type RenderedHeadingNode = {
  viewKey: string;
  headingKey: string;
  nodeKey: string;
  depth: number;
  rawTitle: string;
  title: string;
  markers: string[];
  lastActivityAt?: number;
  bodyMarkdown: string;
  bodyPreview: string;
  children: RenderedHeadingNode[];
  source: {
    lineStart?: number;
    lineEnd?: number;
  };
};

export type MarkerStat = {
  name: string;
  count: number;
  color: string;
  automaticColor: string;
  overrideColor?: string;
};

export type ModuleWindowData = {
  moduleKey: string;
  filePath: string;
  fileStatus: ManagedFileStatus;
  statusMessage?: string;
  lastUpdate?: ModuleUpdateSummary;
  title: string;
  rawTitle: string;
  titleMarkers: string[];
  markerColors: Record<string, string>;
  markerStats: MarkerStat[];
  leadingBodyMarkdown: string;
  headings: RenderedHeadingNode[];
};

export type FileWindowV2InitialPayload = {
  relativePath: string;
  displayName: string;
  temporary?: boolean;
  lastActivityAt?: number;
  modules: ModuleWindowData[];
  initialModuleKey: string | null;
  pendingUpdates?: FileWindowV2FileUpdatePayload;
  eventDocument?: EventDocument;
};

export type EventMutationRequest =
  | { kind: 'status-definition'; name: string; category: 'current' | 'closed' }
  | { kind: 'create'; title: string; status?: EventStatus; tags?: string[]; note?: string; deadline?: string; createdAt?: string }
  | { kind: 'create-child'; parentId: string; title: string; status?: EventStatus; tags?: string[]; note?: string }
  | { kind: 'create-sibling'; eventId: string; title: string; status?: EventStatus; tags?: string[]; note?: string }
  | { kind: 'title'; eventId: string; title: string }
  | { kind: 'status'; eventId: string; status: EventStatus }
  | { kind: 'tags'; eventId: string; tags: string[] }
  | { kind: 'note'; eventId: string; note: string }
  | { kind: 'deadline'; eventId: string; deadline?: string }
  | { kind: 'created-at'; eventId: string; createdAt: string }
  | { kind: 'closed-at'; eventId: string; closedAt: string }
  | { kind: 'archive'; eventId: string }
  | { kind: 'delete'; eventId: string }
  | { kind: 'move'; eventId: string; parentId?: string; index?: number }
  | { kind: 'indent'; eventId: string }
  | { kind: 'outdent'; eventId: string }
  | { kind: 'restore-document'; document: EventDocument };

export type FileWindowV2FileUpdatePayload = {
  relativePath: string;
  fileAttention: boolean;
  modules: Record<string, PendingModuleUpdate>;
  structureChanged: boolean;
};

export type LauncherPendingUpdatesPayload = {
  updatedFilePaths: string[];
  openFilePaths: string[];
  hasHiddenUpdates: boolean;
};

export type ModuleUpdateSummary = {
  id: number;
  relativePath: string;
  phase: 'updating' | 'recentlyUpdated' | 'restored' | 'error';
  changedAt: number;
  moduleAdded: boolean;
  leadingBodyChanged: boolean;
  changedHeadingKeys: string[];
  structureChanged: boolean;
  fileStructureChanged: boolean;
};

export type PendingModuleUpdate = {
  attention: boolean;
  changedHeadingKeys: string[];
  structureChanged: boolean;
};

export type PendingFileUpdate = {
  fileAttention: boolean;
  modules: Record<string, PendingModuleUpdate>;
  structureChanged: boolean;
};

export type WindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export type ModuleViewState = {
  moduleKey: string;
  bounds?: WindowBounds;
  alwaysOnTop: boolean;
  expandedHeadingKeys: string[];
  scrollTop: number;
  selectedMarker?: string;
};

export type LauncherViewState = {
  bounds?: WindowBounds;
  alwaysOnTop?: boolean;
};

export type FileWindowV2State = {
  relativePath: string;
  activeModuleKey: string | null;
  expandedEventIds?: string[];
  scrollTop?: number;
  bounds?: WindowBounds;
  alwaysOnTop: boolean;
  restoreOnLaunch: boolean;
};

export type WorkspaceUiState = {
  schemaVersion: 1;
  launcher: LauncherViewState;
  modules: Record<string, ModuleViewState>;
  fileWindowsV2: Record<string, FileWindowV2State>;
  pendingFileUpdates: Record<string, PendingFileUpdate>;
};

export type OpenFileWindowV2Result =
  | { ok: true }
  | { ok: false; reason: string };
