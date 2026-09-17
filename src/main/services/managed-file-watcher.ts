import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import type { ManagedFileRefreshResult, ManagedFileWatchEntry, WorkspaceSession } from './workspace-session';

type ManagedFileWatcherOptions = {
  debounceMs?: number;
  retryDelayMs?: number;
  retryCount?: number;
  diagnostics?: boolean;
};

export type UpdateTrace = {
  id: number;
  relativePath: string;
  marks: Record<string, number>;
};

export class ManagedFileWatcher {
  private watcher: FSWatcher | null = null;
  private entries = new Map<string, ManagedFileWatchEntry>();
  private watchTargets = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private removalTimers = new Map<string, NodeJS.Timeout>();
  private generations = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly retryDelayMs: number;
  private readonly retryCount: number;
  private readonly diagnostics: boolean;
  private traceId = 0;

  constructor(
    private readonly session: WorkspaceSession,
    private readonly onFileUpdating: (relativePath: string, trace?: UpdateTrace) => void | Promise<void>,
    private readonly onFileUpdated: (relativePath: string, result: ManagedFileRefreshResult, trace?: UpdateTrace) => void | Promise<void>,
    options: ManagedFileWatcherOptions = {},
    private readonly onFileSetChanged: (change: { added: string[]; removed: string[] }) => void | Promise<void> = () => undefined,
  ) {
    this.debounceMs = options.debounceMs ?? 220;
    this.retryDelayMs = options.retryDelayMs ?? 80;
    this.retryCount = options.retryCount ?? 3;
    this.diagnostics = options.diagnostics === true;
  }

  getWatchedRelativePaths(): string[] {
    return [...this.entries.keys()];
  }

  getWatchTargets(): string[] {
    return [...this.watchTargets];
  }

  async start(): Promise<void> {
    await this.stop();
    this.entries = this.createEntryMap();
    const paths = this.createWatchTargets();
    this.watchTargets = new Set(paths);

    if (paths.length === 0) {
      return;
    }

    this.watcher = chokidar.watch(paths, {
      awaitWriteFinish: false,
      followSymlinks: false,
      ignored: (candidatePath) => this.shouldIgnorePath(candidatePath),
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher.on('add', (filePath) => void this.handleAddedPath(filePath));
    this.watcher.on('change', (filePath) => this.scheduleByAbsolutePath(filePath));
    this.watcher.on('unlink', (filePath) => void this.handleRemovedPath(filePath));
    this.watcher.on('error', () => undefined);

    await new Promise<void>((resolve) => {
      this.watcher?.once('ready', resolve);
    });
  }

  async sync(): Promise<void> {
    const nextEntries = this.createEntryMap();
    const nextWatchTargets = new Set(this.createWatchTargets());

    if (!this.watcher) {
      this.entries = nextEntries;
      this.watchTargets = nextWatchTargets;
      await this.start();
      return;
    }

    for (const relativePath of this.entries.keys()) {
      if (!nextEntries.has(relativePath)) {
        this.clearTimer(relativePath);
        this.clearRemovalTimer(relativePath);
        this.bumpGeneration(relativePath);
      }
    }

    this.entries = nextEntries;

    const removedTargets = [...this.watchTargets].filter((target) => !nextWatchTargets.has(target));
    const addedTargets = [...nextWatchTargets].filter((target) => !this.watchTargets.has(target));

    if (removedTargets.length > 0) {
      await this.watcher.unwatch(removedTargets);
    }

    if (addedTargets.length > 0) {
      this.watcher.add(addedTargets);
    }

    this.watchTargets = nextWatchTargets;
  }

  async stop(): Promise<void> {
    for (const relativePath of this.timers.keys()) {
      this.clearTimer(relativePath);
    }

    for (const relativePath of this.removalTimers.keys()) {
      this.clearRemovalTimer(relativePath);
    }

    for (const relativePath of this.entries.keys()) {
      this.bumpGeneration(relativePath);
    }

    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.close();
    }

    this.entries.clear();
    this.watchTargets.clear();
  }

  schedule(relativePath: string): void {
    if (!this.entries.has(relativePath)) {
      return;
    }

    const trace = this.startTrace(relativePath);
    const generation = this.bumpGeneration(relativePath);

    void this.onFileUpdating(relativePath, trace);
    this.clearTimer(relativePath);
    this.timers.set(
      relativePath,
      setTimeout(() => {
        this.timers.delete(relativePath);
        if (trace) {
          trace.marks['debounce-end'] = Date.now();
        }
        void this.refreshWithRetry(relativePath, generation, trace);
      }, this.debounceMs),
    );
  }

  private scheduleByAbsolutePath(filePath: string): void {
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.absolutePath.toLowerCase() === filePath.toLowerCase(),
    );

    if (entry) {
      this.schedule(entry.relativePath);
    }
  }

  private async handleAddedPath(filePath: string): Promise<void> {
    if (!this.isRepositoryMarkdownPath(filePath)) {
      this.scheduleByAbsolutePath(filePath);
      return;
    }

    const relativePath = this.toWorkspaceRelativePath(filePath);

    this.clearRemovalTimer(relativePath);
    const result = await this.session.handleDiscoveredFileAdded(relativePath);
    this.entries = this.createEntryMap();

    if (result.refreshed) {
      await this.onFileUpdated(relativePath, result.refreshed);
    }

    if (result.change.added.length > 0 || result.change.removed.length > 0) {
      await this.onFileSetChanged(result.change);
    }
  }

  private async handleRemovedPath(filePath: string): Promise<void> {
    if (!this.isRepositoryMarkdownPath(filePath)) {
      this.scheduleByAbsolutePath(filePath);
      return;
    }

    const relativePath = this.toWorkspaceRelativePath(filePath);
    this.clearRemovalTimer(relativePath);
    this.removalTimers.set(
      relativePath,
      setTimeout(() => {
        this.removalTimers.delete(relativePath);
        void this.reconcileRemovedPath(relativePath);
      }, this.debounceMs),
    );
  }

  private async reconcileRemovedPath(relativePath: string): Promise<void> {
    const result = await this.session.handleDiscoveredFileRemoved(relativePath);
    this.entries = this.createEntryMap();

    if (!this.entries.has(relativePath)) {
      this.clearTimer(relativePath);
      this.bumpGeneration(relativePath);
    }

    if (result.refreshed) {
      await this.onFileUpdated(relativePath, result.refreshed);
    }

    if (result.change.added.length > 0 || result.change.removed.length > 0) {
      await this.onFileSetChanged(result.change);
    }
  }

  private async refreshWithRetry(relativePath: string, generation: number, trace?: UpdateTrace): Promise<void> {
    let lastResult: ManagedFileRefreshResult | null = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      if (!this.isCurrent(relativePath, generation)) {
        return;
      }

      const result = await this.session.refreshManagedFile(relativePath, {
        mark: (stage) => {
          if (trace) {
            trace.marks[stage] = Date.now();
          }
        },
        shouldCommit: () => this.isCurrent(relativePath, generation),
      });

      if (!result || !this.isCurrent(relativePath, generation)) {
        return;
      }

      lastResult = result;

      if (result.next.status !== 'unreadable') {
        await this.onFileUpdated(relativePath, result, trace);
        return;
      }

      if (attempt < this.retryCount) {
        await delay(this.retryDelayMs);
      }
    }

    if (lastResult && this.isCurrent(relativePath, generation)) {
      await this.onFileUpdated(relativePath, lastResult, trace);
    }
  }

  private bumpGeneration(relativePath: string): number {
    const next = (this.generations.get(relativePath) ?? 0) + 1;
    this.generations.set(relativePath, next);

    return next;
  }

  private isCurrent(relativePath: string, generation: number): boolean {
    return this.entries.has(relativePath) && this.generations.get(relativePath) === generation;
  }

  private startTrace(relativePath: string): UpdateTrace | undefined {
    if (!this.diagnostics) {
      return undefined;
    }

    const trace = {
      id: ++this.traceId,
      relativePath,
      marks: {
        event: Date.now(),
        'debounce-start': Date.now(),
      },
    };

    return trace;
  }

  private createEntryMap(): Map<string, ManagedFileWatchEntry> {
    return new Map(this.session.getManagedFileWatchEntries().map((entry) => [entry.relativePath, entry]));
  }

  private createWatchTargets(): string[] {
    if (typeof this.session.getManagedWatchTargets === 'function') {
      return this.session.getManagedWatchTargets();
    }

    return [...this.createEntryMap().values()].map((entry) => entry.absolutePath);
  }

  private isRepositoryMarkdownPath(filePath: string): boolean {
    const workspacePath = typeof this.session.getWorkspacePath === 'function' ? this.session.getWorkspacePath() : null;

    if (!workspacePath || path.extname(filePath).toLowerCase() !== '.md') {
      return false;
    }

    const relativePath = path.relative(workspacePath, filePath).replaceAll(path.sep, '/');

    return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) && !shouldIgnoreRepositoryPath(relativePath);
  }

  private shouldIgnorePath(candidatePath: string): boolean {
    const workspacePath = typeof this.session.getWorkspacePath === 'function' ? this.session.getWorkspacePath() : null;

    if (!workspacePath) {
      return false;
    }

    const relativePath = path.relative(workspacePath, candidatePath).replaceAll(path.sep, '/');

    return shouldIgnoreRepositoryPath(relativePath) || this.session.isWorkspacePathExcluded(relativePath);
  }

  private toWorkspaceRelativePath(filePath: string): string {
    const workspacePath = typeof this.session.getWorkspacePath === 'function' ? this.session.getWorkspacePath() : null;

    return workspacePath ? path.relative(workspacePath, filePath).replaceAll(path.sep, '/') : filePath;
  }

  private clearTimer(relativePath: string): void {
    const timer = this.timers.get(relativePath);

    if (timer) {
      clearTimeout(timer);
      this.timers.delete(relativePath);
    }
  }

  private clearRemovalTimer(relativePath: string): void {
    const timer = this.removalTimers.get(relativePath);

    if (timer) {
      clearTimeout(timer);
      this.removalTimers.delete(relativePath);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldIgnoreRepositoryPath(relativePath: string): boolean {
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
