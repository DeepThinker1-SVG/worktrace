import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseMarkdownFile, toModuleWindowData } from '../../shared/markdown';
import { getInitialFileWindowV2ModuleKey } from '../../shared/workspace';
import { EventDocumentService } from './event-document-service';
import { archiveExpiredRootEvents, sidecarFromDocument, type EventDocument } from '../../shared/events';
import type {
  ArchiveManagedFileResult,
  FileWindowV2InitialPayload,
  ManagedFileState,
  ModuleWindowData,
  StylesConfig,
  WorkspaceBrowseEntry,
  WorkspaceConfig,
  WorkspaceState,
} from '../../shared/workspace';
import {
  initializeWorkspace,
  loadStylesConfig,
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  writeStylesConfig,
  writeWorkspaceConfig,
} from './config-service';
import {
  buildModuleMarkerStats,
  ensureMarkerStylesForFile,
  getMarkerColors,
  setMarkerColorOverride,
} from './marker-style-service';
import {
  applyActivityToHeadings,
  fileLastActivityAt,
  type WorkspaceActivityState,
} from './node-activity-state';
import {
  isInsidePath,
  normalizeWorkspaceDirectoryPath,
  normalizeWorkspaceFilePath,
  pathsEqual,
  toConfigRelativePath,
  validateWorkspacePath,
} from './workspace-paths';

export type ManagedFileWatchEntry = {
  relativePath: string;
  absolutePath: string;
};

export type ManagedFileRefreshResult = {
  previous?: ManagedFileState;
  next: ManagedFileState;
};

export type ManagedFileRefreshTiming = {
  mark: (stage: 'read-start' | 'read-end' | 'parse-end' | 'state-updated') => void;
  shouldCommit?: () => boolean;
};

export type ManagedFileSetChange = {
  added: string[];
  removed: string[];
};

export type ManagedFilePathChange = {
  change: ManagedFileSetChange;
  refreshed?: ManagedFileRefreshResult;
};

type RepositoryFileEntry = {
  path: string;
  order: number;
  absolutePath: string;
};

const defaultWorkspaceConfig: WorkspaceConfig = {
  schemaVersion: 2,
  managedDirectories: ['workboard'],
  managedFiles: [],
  excludedDirectories: [],
  excludedFiles: [],
  pinnedFiles: [],
  hiddenFiles: [],
  showHiddenFiles: false,
};

export class WorkspaceSession {
  private workspacePath: string | null = null;
  private config: WorkspaceConfig = defaultWorkspaceConfig;
  private styles: StylesConfig = { schemaVersion: 1, files: {} };
  private entries: RepositoryFileEntry[] = [];
  private files: ManagedFileState[] = [];
  private temporaryFiles = new Map<string, string>();
  private activity: WorkspaceActivityState = { files: {} };
  private error?: string;
  private eventDocuments: EventDocumentService | null = null;
  private metadataRoot: string | null = null;

  setMetadataRoot(metadataRoot: string): void {
    this.metadataRoot = metadataRoot;
  }

  getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  setActivityState(activity: WorkspaceActivityState): void {
    this.activity = activity;
  }

  getState(
    fileUpdateStatuses: WorkspaceState['fileUpdateStatuses'] = {},
    diagnosticUpdate?: WorkspaceState['diagnosticUpdate'],
  ): WorkspaceState {
    return {
      workspacePath: this.workspacePath,
      workspaceName: this.workspacePath ? path.basename(this.workspacePath) : null,
      initialized: Boolean(this.workspacePath),
      files: this.files
        .filter((file) => !this.temporaryFiles.has(normalizePathKey(file.path)))
        .sort((left, right) => left.order - right.order)
        .map((file) => this.withFileActivity(file)),
      managedDirectories: [...this.config.managedDirectories],
      managedFiles: [...this.config.managedFiles],
      showHiddenFiles: this.config.showHiddenFiles,
      fileUpdateStatuses,
      diagnosticUpdate,
      error: this.error,
    };
  }

  getModuleData(moduleKey: string): ModuleWindowData | null {
    for (const file of this.files) {
      const module = file.parsedFile?.modules.find((candidate) => candidate.moduleKey === moduleKey);

      if (module) {
        const data = toModuleWindowData(
          file.path,
          module,
          file.status,
          file.statusMessage,
          getMarkerColors(this.styles, file.path),
          buildModuleMarkerStats(this.styles, file.path, module),
        );

        return {
          ...data,
          headings: applyActivityToHeadings(data.headings, this.activity.files[file.path]),
        };
      }
    }

    return null;
  }

  getFileWindowV2InitialPayload(relativePath: string): FileWindowV2InitialPayload | null {
    const file = this.files.find((candidate) => pathsEqual(candidate.path, relativePath));

    if (!file?.parsedFile) {
      return null;
    }

    const toDataStart = process.env.NODE_ENV === 'development' ? Date.now() : 0;
    const modules = file.parsedFile.modules.map((module) => {
      const data = toModuleWindowData(
        file.path,
        module,
        file.status,
        file.statusMessage,
        getMarkerColors(this.styles, file.path),
        buildModuleMarkerStats(this.styles, file.path, module),
      );

      return {
        ...data,
        headings: applyActivityToHeadings(data.headings, this.activity.files[file.path]),
      };
    });

    if (process.env.NODE_ENV === 'development') {
      console.log(`[perf:toModuleWindowData] ${relativePath} ${Date.now() - toDataStart}ms (${modules.length} modules)`);
    }

    return {
      relativePath: file.path,
      displayName: fileDisplayName(file.path),
      temporary: this.isTemporaryFile(file.path),
      lastActivityAt: fileLastActivityAt(this.activity.files[file.path]) ?? file.sourceMtimeMs,
      modules,
      initialModuleKey: getInitialFileWindowV2ModuleKey(modules),
    };
  }

  async getTodoDocument(relativePath: string): Promise<EventDocument | undefined> {
    if (!this.eventDocuments) return undefined;
    const state = await this.eventDocuments.load(relativePath);
    if (state.status === 'ready') {
      const archived = archiveExpiredRootEvents(state.document);
      if (archived === state.document) return state.document;
      return this.eventDocuments.write(relativePath, archived, sidecarFromDocument(archived, state.sidecar));
    }
    return (await this.eventDocuments.initialize(relativePath)).document;
  }

  getManagedFileWatchEntries(): ManagedFileWatchEntry[] {
    return this.entries.map((entry) => ({
      relativePath: entry.path,
      absolutePath: entry.absolutePath,
    }));
  }

  getManagedWatchTargets(): string[] {
    if (!this.workspacePath) {
      return [];
    }

    return deduplicateAbsolutePaths([
      ...this.config.managedDirectories.map((directory) => path.resolve(this.workspacePath!, directory)),
      ...this.config.managedFiles.map((file) => path.resolve(this.workspacePath!, file)),
      ...[...this.temporaryFiles.values()].map((file) => path.resolve(this.workspacePath!, file)),
    ]);
  }

  async registerTemporaryFile(filePath: string): Promise<{ relativePath: string; added: boolean }> {
    const workspacePath = this.requireWorkspacePath();
    const validation = await normalizeWorkspaceFilePath(workspacePath, filePath);

    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    if (!this.isConfiguredManagedFile(validation.relativePath)) {
      this.temporaryFiles.set(normalizePathKey(validation.relativePath), validation.relativePath);
    }

    const existing = this.entries.find((entry) => pathsEqual(entry.path, validation.relativePath));

    if (existing) {
      await this.refreshManagedFile(existing.path);
      return { relativePath: existing.path, added: false };
    }

    const result = await this.handleDiscoveredFileAdded(validation.relativePath);

    return {
      relativePath: validation.relativePath,
      added: result.change.added.length > 0,
    };
  }

  unregisterTemporaryFile(relativePath: string): boolean {
    const key = normalizePathKey(relativePath);

    if (!this.temporaryFiles.delete(key)) {
      return false;
    }

    if (this.isConfiguredManagedFile(relativePath)) {
      return false;
    }

    this.entries = orderRepositoryEntries(this.entries.filter((entry) => !pathsEqual(entry.path, relativePath)));
    this.files = orderManagedFiles(
      this.files.filter((file) => !pathsEqual(file.path, relativePath)),
      this.entries,
    );

    return true;
  }

  isTemporaryFile(relativePath: string): boolean {
    return this.temporaryFiles.has(normalizePathKey(relativePath));
  }

  async listWorkspaceDirectory(relativeDirectory = '.'): Promise<WorkspaceBrowseEntry[]> {
    const workspacePath = this.requireWorkspacePath();
    const validation = await normalizeWorkspaceDirectoryPath(workspacePath, relativeDirectory || '.');

    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    const entries = await fs.readdir(validation.absolutePath, { withFileTypes: true });
    const parentPath = validation.relativePath === '.' ? '' : validation.relativePath;
    const results: WorkspaceBrowseEntry[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('.')) {
        continue;
      }

      if (entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md'))) {
        continue;
      }

      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const directoryMtimeMs = entry.isDirectory()
        ? (await fs.stat(path.join(validation.absolutePath, entry.name)).catch(() => null))?.mtimeMs
        : undefined;
      const managedActivityAt = entry.isDirectory()
        ? this.files
          .filter((file) => isPathWithinDirectory(file.path, relativePath))
          .map((file) => this.withFileActivity(file).lastActivityAt ?? 0)
          .reduce((latest, timestamp) => Math.max(latest, timestamp), 0)
        : 0;
      results.push({
        kind: entry.isDirectory() ? 'directory' : 'file',
        name: entry.name,
        path: relativePath,
        hidden: entry.name.startsWith('.') || (!entry.isDirectory() && hasPath(this.config.hiddenFiles, relativePath)),
        management: entry.isDirectory() ? this.directoryManagement(relativePath) : this.isConfiguredManagedFile(relativePath) ? 'managed' : 'unmanaged',
        lastActivityAt: entry.isDirectory() ? managedActivityAt || directoryMtimeMs : undefined,
      });
    }

    return results.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
  }

  retainTemporaryFile(relativePath: string): boolean {
    const entry = this.entries.find((candidate) => pathsEqual(candidate.path, relativePath));

    if (!entry) {
      return false;
    }

    this.temporaryFiles.set(normalizePathKey(entry.path), entry.path);
    return true;
  }

  async addManagedDirectory(directoryPath: string): Promise<ManagedFileSetChange> {
    const workspacePath = this.requireWorkspacePath();
    const validation = await normalizeWorkspaceDirectoryPath(workspacePath, directoryPath);

    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    await this.updateScope({
      managedDirectories: [...this.config.managedDirectories, validation.relativePath],
      excludedDirectories: this.config.excludedDirectories.filter((directory) => !isPathAtOrWithin(directory, validation.relativePath)),
      excludedFiles: this.config.excludedFiles.filter((file) => !isPathAtOrWithin(file, validation.relativePath)),
    });

    return this.reconcileDiscoveredFiles();
  }

  async removeManagedDirectory(relativePath: string): Promise<ManagedFileSetChange> {
    const exactManagedDirectory = hasPath(this.config.managedDirectories, relativePath);
    await this.updateScope({
      managedDirectories: exactManagedDirectory
        ? this.config.managedDirectories.filter((directory) => !pathsEqual(directory, relativePath))
        : this.config.managedDirectories,
      managedFiles: this.config.managedFiles.filter((file) => !isPathAtOrWithin(file, relativePath)),
      excludedDirectories: exactManagedDirectory || !this.isDirectoryIncluded(relativePath)
        ? this.config.excludedDirectories
        : [...this.config.excludedDirectories, relativePath],
    });

    return this.reconcileDiscoveredFiles();
  }

  async addManagedFile(filePath: string): Promise<ManagedFileSetChange> {
    const workspacePath = this.requireWorkspacePath();
    const validation = await normalizeWorkspaceFilePath(workspacePath, filePath);

    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    this.temporaryFiles.delete(normalizePathKey(validation.relativePath));
    await this.updateScope({
      managedFiles: [...this.config.managedFiles, validation.relativePath],
      excludedFiles: this.config.excludedFiles.filter((file) => !pathsEqual(file, validation.relativePath)),
    });

    return this.reconcileDiscoveredFiles();
  }

  async removeManagedFile(relativePath: string): Promise<ManagedFileSetChange> {
    const managedByDirectory = this.isDirectoryIncluded(relativePath);
    await this.updateScope({
      managedFiles: this.config.managedFiles.filter((file) => !pathsEqual(file, relativePath)),
      excludedFiles: managedByDirectory
        ? [...this.config.excludedFiles, relativePath]
        : this.config.excludedFiles,
    });

    return this.reconcileDiscoveredFiles();
  }

  async openWorkspace(workspacePath: string): Promise<WorkspaceState> {
    const validatedPath = await validateWorkspacePath(workspacePath);

    const metadataPath = this.metadataPath(validatedPath);
    await initializeWorkspace(metadataPath);

    this.workspacePath = validatedPath;
    this.eventDocuments = new EventDocumentService(validatedPath, this.metadataRoot ? path.join(metadataPath, 'documents') : undefined);
    this.temporaryFiles.clear();
    this.config = await loadWorkspaceConfig(metadataPath);
    this.styles = await loadStylesConfig(metadataPath);
    this.error = undefined;
    await this.reconcileDiscoveredFiles();

    return this.getState();
  }

  async createTodoFile(name: string): Promise<string> {
    const baseName = name.trim().replace(/\.md$/i, '').trim();
    const hasControlCharacter = [...baseName].some((character) => character.charCodeAt(0) < 32);
    if (!baseName || hasControlCharacter || /[<>:"/\\|?*]/.test(baseName) || baseName === '.' || baseName === '..') {
      throw new Error('工作计划名称包含非法字符。');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]+)?$/i.test(baseName)) {
      throw new Error('工作计划名称不可用。');
    }
    return this.createTodoFileAt(`workboard/${baseName}.md`);
  }

  async createTodoFileAt(relativePath: string): Promise<string> {
    const workspacePath = this.requireWorkspacePath();
    const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalizedPath || path.isAbsolute(normalizedPath) || normalizedPath.split('/').some((part) => part === '..') || path.extname(normalizedPath).toLowerCase() !== '.md') {
      throw new Error('工作计划保存路径不可用。');
    }
    const absolutePath = path.resolve(workspacePath, normalizedPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await fs.writeFile(absolutePath, '# 当前\n\n# 已结束\n', { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') {
        throw new Error('同名工作计划已存在。');
      }
      throw new Error('工作计划创建失败。', { cause: error });
    }
    if (!this.eventDocuments) this.eventDocuments = new EventDocumentService(workspacePath, this.metadataRoot ? path.join(this.metadataPath(workspacePath), 'documents') : undefined);
    await this.eventDocuments.initialize(normalizedPath);
    await this.reconcileDiscoveredFiles();
    return normalizedPath;
  }

  async restoreWorkspace(workspacePath: string | null): Promise<WorkspaceState> {
    if (!workspacePath) {
      return this.getState();
    }

    try {
      return await this.openWorkspace(workspacePath);
    } catch (error) {
      this.workspacePath = null;
      this.eventDocuments = null;
      this.config = defaultWorkspaceConfig;
      this.styles = { schemaVersion: 1, files: {} };
      this.entries = [];
      this.files = [];
      this.temporaryFiles.clear();
      this.error = error instanceof Error ? error.message : 'Workspace is unavailable.';

      return this.getState();
    }
  }

  async reconcileDiscoveredFiles(): Promise<ManagedFileSetChange> {
    const workspacePath = this.requireWorkspacePath();
    const before = new Set(this.entries.map((entry) => normalizePathKey(entry.path)));
    const previousFiles = new Map(this.files.map((file) => [normalizePathKey(file.path), file]));

    const nextEntries = await this.discoverEntries(workspacePath);
    const nextFiles = await Promise.all(nextEntries.map(async (entry) => {
      const previous = previousFiles.get(normalizePathKey(entry.path));

      if (previous) {
        return {
          ...previous,
          ...this.toFileStateBase(entry),
        };
      }

      return this.readManagedFile(workspacePath, entry);
    }));

    const after = new Set(nextEntries.map((entry) => normalizePathKey(entry.path)));
    const added = nextEntries.filter((entry) => !before.has(normalizePathKey(entry.path))).map((entry) => entry.path);
    const removed = [...before]
      .filter((key) => !after.has(key))
      .map((key) => previousFiles.get(key)?.path)
      .filter((file): file is string => typeof file === 'string');

    this.entries = nextEntries;
    this.files = nextFiles;
    await this.ensureMarkerStyles();

    return { added, removed };
  }

  async handleDiscoveredFileAdded(relativePath: string): Promise<ManagedFilePathChange> {
    const workspacePath = this.requireWorkspacePath();
    const normalizedPath = relativePath.replaceAll('\\', '/');
    const existing = this.entries.find((entry) => pathsEqual(entry.path, normalizedPath));

    if (existing) {
      return {
        change: { added: [], removed: [] },
        refreshed: await this.refreshManagedFile(existing.path) ?? undefined,
      };
    }

    if (
      (!this.isConfiguredManagedFile(normalizedPath) && !this.isTemporaryFile(normalizedPath))
      || shouldSkipRepositoryPath(normalizedPath)
    ) {
      return { change: { added: [], removed: [] } };
    }

    const entry: RepositoryFileEntry = {
      path: normalizedPath,
      order: 0,
      absolutePath: path.resolve(workspacePath, normalizedPath),
    };
    this.entries = orderRepositoryEntries([...this.entries, entry]);
    const orderedEntry = this.requireEntry(normalizedPath);
    const next = await this.readManagedFile(workspacePath, orderedEntry);
    this.files = orderManagedFiles([...this.files, next], this.entries);
    await this.ensureMarkerStyles();

    return {
      change: { added: [orderedEntry.path], removed: [] },
    };
  }

  async handleDiscoveredFileRemoved(relativePath: string): Promise<ManagedFilePathChange> {
    const normalizedPath = relativePath.replaceAll('\\', '/');
    const entry = this.entries.find((candidate) => pathsEqual(candidate.path, normalizedPath));

    if (!entry) {
      return { change: { added: [], removed: [] } };
    }

    if (hasPath(this.config.managedFiles, entry.path)) {
      return {
        change: { added: [], removed: [] },
        refreshed: await this.refreshManagedFile(entry.path) ?? undefined,
      };
    }

    this.entries = orderRepositoryEntries(this.entries.filter((candidate) => !pathsEqual(candidate.path, entry.path)));
    this.files = orderManagedFiles(
      this.files.filter((file) => !pathsEqual(file.path, entry.path)),
      this.entries,
    );

    return {
      change: { added: [], removed: [entry.path] },
    };
  }

  async archiveFile(relativePath: string): Promise<ArchiveManagedFileResult> {
    const workspacePath = this.requireWorkspacePath();
    const entry = this.requireEntry(relativePath);
    const archiveDir = path.join(workspacePath, 'workboard', 'archive');
    const archivePath = path.join(archiveDir, path.basename(relativePath));
    const archivedRelativePath = toConfigRelativePath(workspacePath, archivePath);
    const sourceStat = await fs.stat(entry.absolutePath).catch(() => null);

    if (!sourceStat?.isFile()) {
      throw new Error('File does not exist.');
    }

    await fs.mkdir(archiveDir, { recursive: true });

    const existingTarget = await fs.stat(archivePath).catch(() => null);

    if (existingTarget) {
      throw new Error(`Archive target already exists: ${archivedRelativePath}`);
    }

    await fs.rename(entry.absolutePath, archivePath);

    try {
      await this.reconcileDiscoveredFiles();

      return {
        archivedPath: archivedRelativePath,
        state: this.getState(),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown state update failure.';

      throw new Error(`File was moved to ${archivePath}, but Worktrace state update failed: ${reason}`);
    }
  }

  async refreshManagedFile(
    relativePath: string,
    timing?: ManagedFileRefreshTiming,
  ): Promise<ManagedFileRefreshResult | null> {
    if (!this.workspacePath) {
      return null;
    }

    const entry = this.entries.find((candidate) => pathsEqual(candidate.path, relativePath));

    if (!entry) {
      return null;
    }

    const previous = this.files.find((file) => pathsEqual(file.path, entry.path));
    const next = await this.readManagedFile(this.workspacePath, entry, previous, timing);
    const otherFiles = this.files.filter((file) => !pathsEqual(file.path, entry.path));

    if (timing?.shouldCommit?.() === false) {
      return null;
    }

    this.files = [...otherFiles, next].sort((left, right) => left.order - right.order);
    timing?.mark('state-updated');
    await this.ensureMarkerStyles();

    return { previous, next };
  }

  async setMarkerColor(relativePath: string, markerName: string, color: string | null): Promise<void> {
    const workspacePath = this.requireWorkspacePath();

    this.styles = setMarkerColorOverride(this.styles, relativePath, markerName, color);
    await writeStylesConfig(this.metadataPath(workspacePath), this.styles);
  }

  async getAbsoluteManagedFilePath(relativePath: string): Promise<string> {
    return this.requireEntry(relativePath).absolutePath;
  }

  async setFilePinned(relativePath: string, pinned: boolean): Promise<WorkspaceState> {
    const workspacePath = this.requireWorkspacePath();
    const entry = this.requireEntry(relativePath);

    this.config = {
      ...this.config,
      pinnedFiles: updatePathList(this.config.pinnedFiles, entry.path, pinned),
    };
    await writeWorkspaceConfig(this.metadataPath(workspacePath), this.config);
    this.updateFilePreferences();

    return this.getState();
  }

  async setFileHidden(relativePath: string, hidden: boolean): Promise<WorkspaceState> {
    const workspacePath = this.requireWorkspacePath();
    const entry = this.requireEntry(relativePath);

    this.config = {
      ...this.config,
      hiddenFiles: updatePathList(this.config.hiddenFiles, entry.path, hidden),
    };
    await writeWorkspaceConfig(this.metadataPath(workspacePath), this.config);
    this.updateFilePreferences();

    return this.getState();
  }

  async setShowHiddenFiles(showHiddenFiles: boolean): Promise<WorkspaceState> {
    const workspacePath = this.requireWorkspacePath();

    this.config = {
      ...this.config,
      showHiddenFiles,
    };
    await writeWorkspaceConfig(this.metadataPath(workspacePath), this.config);

    return this.getState();
  }

  async removeFilePreferences(relativePath: string): Promise<WorkspaceState> {
    const workspacePath = this.requireWorkspacePath();
    const normalizedPath = relativePath.replaceAll('\\', '/');

    const nextPinnedFiles = removePaths(this.config.pinnedFiles, [normalizedPath]);
    const nextHiddenFiles = removePaths(this.config.hiddenFiles, [normalizedPath]);

    if (
      nextPinnedFiles.length === this.config.pinnedFiles.length &&
      nextHiddenFiles.length === this.config.hiddenFiles.length
    ) {
      return this.getState();
    }

    this.config = {
      ...this.config,
      pinnedFiles: nextPinnedFiles,
      hiddenFiles: nextHiddenFiles,
    };
    await writeWorkspaceConfig(this.metadataPath(workspacePath), this.config);
    this.updateFilePreferences();

    return this.getState();
  }

  async removeFileStyles(relativePath: string): Promise<void> {
    const workspacePath = this.requireWorkspacePath();
    const normalizedPath = relativePath.replaceAll('\\', '/');

    if (!Object.hasOwn(this.styles.files, normalizedPath)) {
      return;
    }

    const nextFiles = { ...this.styles.files };

    delete nextFiles[normalizedPath];

    this.styles = {
      ...this.styles,
      files: nextFiles,
    };
    await writeStylesConfig(this.metadataPath(workspacePath), this.styles);
  }

  private async discoverEntries(workspacePath: string): Promise<RepositoryFileEntry[]> {
    const discoveredPaths = await discoverManagedMarkdownFiles(
      workspacePath,
      this.config.managedDirectories,
      (relativeDirectory) => this.isDirectoryIncluded(relativeDirectory),
    );
    const repositoryPaths = deduplicatePaths([
      ...discoveredPaths.filter((relativePath) => this.isConfiguredManagedFile(relativePath)),
      ...this.config.managedFiles.filter((relativePath) => this.isConfiguredManagedFile(relativePath)),
      ...this.temporaryFiles.values(),
    ]);

    return orderRepositoryEntries(repositoryPaths.map((relativePath) => ({
      path: relativePath,
      order: 0,
      absolutePath: path.resolve(workspacePath, relativePath),
    })));
  }

  private async readManagedFile(
    workspacePath: string,
    entry: RepositoryFileEntry,
    previous?: ManagedFileState,
    timing?: ManagedFileRefreshTiming,
  ): Promise<ManagedFileState> {
    const workspaceResolved = path.resolve(workspacePath);
    const baseState = this.toFileStateBase(entry);

    if (path.isAbsolute(entry.path) || !isInsidePath(workspaceResolved, entry.absolutePath)) {
      return {
        ...baseState,
        status: 'unreadable',
        statusMessage: path.isAbsolute(entry.path) ? 'Managed file path must be relative.' : 'File is outside the workspace.',
        parsedFile: previous?.parsedFile,
      };
    }

    const stat = await fs.stat(entry.absolutePath).catch(() => null);

    if (!stat?.isFile()) {
      return {
        ...baseState,
        status: stat ? 'unreadable' : 'missing',
        statusMessage: stat ? 'Managed path is not a file.' : 'File does not exist.',
        parsedFile: previous?.parsedFile,
      };
    }

    let realPath: string;

    try {
      realPath = await fs.realpath(entry.absolutePath);
    } catch (error) {
      return {
        ...baseState,
        status: 'unreadable',
        statusMessage: error instanceof Error ? error.message : 'Unable to resolve file.',
        parsedFile: previous?.parsedFile,
      };
    }

    if (!isInsidePath(workspaceResolved, realPath) || path.extname(realPath).toLowerCase() !== '.md') {
      return {
        ...baseState,
        status: 'unreadable',
        statusMessage: path.extname(realPath).toLowerCase() !== '.md'
          ? 'Only Markdown files can be managed.'
          : 'File is outside the workspace.',
        parsedFile: previous?.parsedFile,
      };
    }

    let markdown: string;

    try {
      timing?.mark('read-start');
      markdown = await fs.readFile(realPath, 'utf8');
      timing?.mark('read-end');
    } catch (error) {
      return {
        ...baseState,
        status: 'unreadable',
        statusMessage: error instanceof Error ? error.message : 'Unable to read file.',
        parsedFile: previous?.parsedFile,
      };
    }

    try {
      const relativePath = toConfigRelativePath(workspaceResolved, realPath);
      const parseStart = process.env.NODE_ENV === 'development' ? Date.now() : 0;
      const parsedFile = parseMarkdownFile(markdown, relativePath);

      if (process.env.NODE_ENV === 'development') {
        console.log(`[perf:parseMarkdownFile] ${relativePath} ${Date.now() - parseStart}ms`);
      }

      timing?.mark('parse-end');
      return {
        ...baseState,
        path: relativePath,
        status: 'available',
        sourceMtimeMs: stat.mtimeMs,
        parsedFile,
      };
    } catch (error) {
      return {
        ...baseState,
        status: 'parse-error',
        statusMessage: error instanceof Error ? error.message : 'Markdown parse failed.',
        parsedFile: previous?.parsedFile,
      };
    }
  }

  private requireWorkspacePath(): string {
    if (!this.workspacePath) {
      throw new Error('No workspace is open.');
    }

    return this.workspacePath;
  }

  private requireEntry(relativePath: string): RepositoryFileEntry {
    const entry = this.entries.find((candidate) => pathsEqual(candidate.path, relativePath));

    if (!entry) {
      throw new Error('Managed file is unavailable.');
    }

    return entry;
  }

  private toFileStateBase(entry: RepositoryFileEntry): Pick<ManagedFileState, 'path' | 'order' | 'source' | 'pinned' | 'hidden'> {
    return {
      path: entry.path,
      order: entry.order,
      source: 'repository',
      pinned: hasPath(this.config.pinnedFiles, entry.path),
      hidden: hasPath(this.config.hiddenFiles, entry.path),
    };
  }

  private withFileActivity(file: ManagedFileState): ManagedFileState {
    return {
      ...file,
      lastActivityAt: fileLastActivityAt(this.activity.files[file.path]) ?? file.sourceMtimeMs,
    };
  }

  private updateFilePreferences(): void {
    this.files = this.files.map((file) => ({
      ...file,
      pinned: hasPath(this.config.pinnedFiles, file.path),
      hidden: hasPath(this.config.hiddenFiles, file.path),
    }));
  }

  private isConfiguredManagedFile(relativePath: string): boolean {
    if (path.posix.extname(relativePath).toLowerCase() !== '.md') {
      return false;
    }

    if (hasPath(this.config.excludedFiles, relativePath)) {
      return false;
    }

    return hasPath(this.config.managedFiles, relativePath) || this.isDirectoryIncluded(relativePath);
  }

  isWorkspacePathExcluded(relativePath: string): boolean {
    if (path.posix.extname(relativePath).toLowerCase() === '.md') {
      return !this.isConfiguredManagedFile(relativePath) && !this.isTemporaryFile(relativePath);
    }

    return this.directoryManagement(relativePath) === 'unmanaged';
  }

  private isDirectoryIncluded(relativePath: string): boolean {
    const managedDepth = mostSpecificCoveringDepth(relativePath, this.config.managedDirectories);
    const excludedDepth = mostSpecificCoveringDepth(relativePath, this.config.excludedDirectories);

    return managedDepth >= 0 && managedDepth > excludedDepth;
  }

  private directoryManagement(relativePath: string): WorkspaceBrowseEntry['management'] {
    if (this.isDirectoryIncluded(relativePath)) {
      return 'managed';
    }

    if (
      this.config.managedDirectories.some((directory) => isPathWithinDirectory(directory, relativePath) && this.isDirectoryIncluded(directory))
      || this.config.managedFiles.some((file) => isPathWithinDirectory(file, relativePath) && this.isConfiguredManagedFile(file))
    ) {
      return 'partial';
    }

    return 'unmanaged';
  }

  private async clearPreferencesForRemovedFiles(relativePaths: string[]): Promise<void> {
    const workspacePath = this.requireWorkspacePath();
    const nextPinnedFiles = removePaths(this.config.pinnedFiles, relativePaths);
    const nextHiddenFiles = removePaths(this.config.hiddenFiles, relativePaths);

    if (nextPinnedFiles.length === this.config.pinnedFiles.length && nextHiddenFiles.length === this.config.hiddenFiles.length) {
      return;
    }

    this.config = {
      ...this.config,
      pinnedFiles: nextPinnedFiles,
      hiddenFiles: nextHiddenFiles,
    };
    await writeWorkspaceConfig(this.metadataPath(workspacePath), this.config);
  }

  private async ensureMarkerStyles(): Promise<void> {
    const workspacePath = this.requireWorkspacePath();
    let nextStyles = this.styles;
    let changed = false;

    for (const file of this.files) {
      const result = ensureMarkerStylesForFile(nextStyles, file.path, file.parsedFile);
      nextStyles = result.styles;
      changed = changed || result.changed;
    }

    this.styles = nextStyles;

    if (changed) {
      await writeStylesConfig(this.metadataPath(workspacePath), this.styles);
    }
  }

  private async updateScope(update: Partial<Pick<WorkspaceConfig, 'managedDirectories' | 'managedFiles' | 'excludedDirectories' | 'excludedFiles'>>): Promise<void> {
    const workspacePath = this.requireWorkspacePath();

    this.config = validateWorkspaceConfig({ ...this.config, ...update });
    await writeWorkspaceConfig(this.metadataPath(workspacePath), this.config);
  }

  private metadataPath(workspacePath: string): string {
    if (!this.metadataRoot) return workspacePath;
    const key = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(workspacePath).toLowerCase() : path.resolve(workspacePath)).digest('hex');
    return path.join(this.metadataRoot, 'workspaces', key);
  }
}

async function discoverManagedMarkdownFiles(
  workspacePath: string,
  managedDirectories: string[],
  shouldVisitDirectory: (relativeDirectory: string) => boolean = () => true,
): Promise<string[]> {
  const workspaceResolved = path.resolve(workspacePath);
  const results: string[] = [];

  await Promise.all(managedDirectories.map(async (relativeDirectory) => {
    const directoryPath = path.resolve(workspaceResolved, relativeDirectory);

    if (relativeDirectory !== '.' && !isInsidePath(workspaceResolved, directoryPath)) {
      return;
    }

    const directoryRealPath = await fs.realpath(directoryPath).catch(() => null);

    if (
      !directoryRealPath
      || (!pathsEqual(directoryRealPath, workspaceResolved) && !isInsidePath(workspaceResolved, directoryRealPath))
    ) {
      return;
    }

    await visitDirectory(directoryRealPath, relativeDirectory === '.' ? '' : relativeDirectory);
  }));

  return deduplicatePaths(results);

  async function visitDirectory(directoryPath: string, relativeDirectory: string): Promise<void> {
    if (relativeDirectory && !shouldVisitDirectory(relativeDirectory)) {
      return;
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipRepositoryPath(relativePath)) {
          continue;
        }

        await visitDirectory(absolutePath, relativePath);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        results.push(relativePath.replaceAll('\\', '/'));
      }
    }
  }
}

function shouldSkipRepositoryPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();

  return (
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized === 'node_modules' ||
    normalized.startsWith('node_modules/') ||
    normalized === '.workboard' ||
    normalized.startsWith('.workboard/') ||
    normalized === 'workboard/archive' ||
    normalized.startsWith('workboard/archive/')
  );
}

function orderRepositoryEntries(entries: RepositoryFileEntry[]): RepositoryFileEntry[] {
  return [...entries]
    .sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN'))
    .map((entry, order) => ({ ...entry, order }));
}

function orderManagedFiles(files: ManagedFileState[], entries: RepositoryFileEntry[]): ManagedFileState[] {
  const orderByPath = new Map(entries.map((entry) => [normalizePathKey(entry.path), entry.order]));

  return files
    .map((file) => ({ ...file, order: orderByPath.get(normalizePathKey(file.path)) ?? file.order }))
    .sort((left, right) => left.order - right.order);
}

function deduplicatePaths(paths: string[]): string[] {
  const seen = new Set<string>();

  return paths
    .filter((relativePath) => {
      const key = normalizePathKey(relativePath);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function deduplicateAbsolutePaths(paths: string[]): string[] {
  const seen = new Set<string>();

  return paths.filter((absolutePath) => {
    const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isPathWithinDirectory(relativePath: string, directory: string): boolean {
  if (directory === '.') {
    return true;
  }

  const pathKey = normalizePathKey(relativePath);
  const directoryKey = normalizePathKey(directory);

  return pathKey.startsWith(`${directoryKey}/`);
}

function isPathAtOrWithin(relativePath: string, directory: string): boolean {
  return pathsEqual(relativePath, directory) || isPathWithinDirectory(relativePath, directory);
}

function mostSpecificCoveringDepth(relativePath: string, directories: string[]): number {
  return directories.reduce((deepest, directory) => {
    if (!isPathAtOrWithin(relativePath, directory)) {
      return deepest;
    }

    return Math.max(deepest, directory === '.' ? 0 : directory.split('/').length);
  }, -1);
}

function updatePathList(paths: string[], relativePath: string, include: boolean): string[] {
  const withoutPath = paths.filter((pathValue) => !pathsEqual(pathValue, relativePath));

  return include ? [...withoutPath, relativePath.replaceAll('\\', '/')] : withoutPath;
}

function removePaths(paths: string[], removedPaths: string[]): string[] {
  return paths.filter((pathValue) => !removedPaths.some((removedPath) => pathsEqual(pathValue, removedPath)));
}

function hasPath(paths: string[], relativePath: string): boolean {
  return paths.some((pathValue) => pathsEqual(pathValue, relativePath));
}

function normalizePathKey(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');

  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function fileDisplayName(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');

  return normalized.split('/').at(-1) ?? normalized;
}
