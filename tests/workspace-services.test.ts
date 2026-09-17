import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  defaultWorkspaceConfig,
  initializeWorkspace,
  loadStylesConfig,
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  writeWorkspaceConfig,
  workspaceConfigPath,
} from '../src/main/services/config-service';
import {
  buildModuleMarkerStats,
  setMarkerColorOverride,
} from '../src/main/services/marker-style-service';
import { LocalStateService } from '../src/main/services/local-state-service';
import { ManagedFileWatcher } from '../src/main/services/managed-file-watcher';
import { mergeFileUpdateSummaries } from '../src/main/services/file-update-attention';
import { FileWindowV2Registry } from '../src/main/services/file-window-v2-registry';
import { buildModuleUpdateSummaries } from '../src/main/services/module-update-diff';
import {
  fileLastActivityAt,
  reconcileWorkspaceActivity,
  updateFileActivity,
} from '../src/main/services/node-activity-state';
import { TransientUpdateState } from '../src/main/services/transient-update-state';
import { type ManagedFileRefreshResult, type ManagedFileRefreshTiming, WorkspaceSession } from '../src/main/services/workspace-session';
import { normalizeWorkspaceDirectoryPath, normalizeWorkspaceFilePath } from '../src/main/services/workspace-paths';
import { parseMarkdownFile, toModuleWindowData } from '../src/shared/markdown';
import {
  clearAllPending,
  clearFileAttention,
  clearModuleAttention,
  clearPendingFile,
  clearPendingModule,
  deriveChangedHeadingKeys,
  deriveUpdatedFilePaths,
  deriveUpdatedFolderPaths,
  deriveUpdatedModuleKeys,
  filterHeadingsByMarker,
  formatRelativeActivityTime,
  getInitialFileWindowV2ModuleKey,
  getFileWindowV2UpdatePayload,
  hasModuleBodyUpdate,
  hasPendingFileUpdates,
  hasPendingModuleUpdates,
  ensureWindowBoundsVisible,
  groupManagedFiles,
  headingNodeContentEqual,
  markerColorsEqual,
  markersEqual,
  mergeHeadings,
  mergePendingFileUpdates,
  moduleBodyUpdateKey,
  modulesContentEqual,
  pruneEmptyPendingContainers,
  prunePendingFileUpdatesForPayload,
  resolveFileWindowV2ActiveModuleKey,
  resolvePersistedFileWindowV2ActiveModuleKey,
  selectFileWindowV2Module,
} from '../src/shared/workspace';
import type { ManagedFileState, ModuleUpdateSummary, ModuleWindowData, PendingFileUpdate, RenderedHeadingNode } from '../src/shared/workspace';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-'));
  await initializeWorkspace(tempRoot);
  await writeWorkspaceConfig(tempRoot, {
    schemaVersion: 2,
    managedDirectories: ['.'],
    managedFiles: [],
    pinnedFiles: [],
    hiddenFiles: [],
    showHiddenFiles: false,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('workspace initialization', () => {
  test('creates .workboard files in an empty directory', async () => {
    await fs.rm(path.join(tempRoot, '.workboard'), { recursive: true, force: true });
    await initializeWorkspace(tempRoot);

    await expect(fs.stat(path.join(tempRoot, '.workboard', 'PROTOCOL.md'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(tempRoot, '.workboard', 'workspace.json'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(tempRoot, '.workboard', 'styles.json'))).resolves.toBeTruthy();
    await expect(fs.readdir(path.join(tempRoot, '.workboard', 'templates'))).resolves.toEqual([]);
  });

  test('does not overwrite existing initialization files', async () => {
    const protocolPath = path.join(tempRoot, '.workboard', 'PROTOCOL.md');

    await fs.mkdir(path.dirname(protocolPath), { recursive: true });
    await fs.writeFile(protocolPath, 'custom protocol', 'utf8');
    await initializeWorkspace(tempRoot);

    await expect(fs.readFile(protocolPath, 'utf8')).resolves.toBe('custom protocol');
  });

  test('surfaces initialization failure', async () => {
    const filePath = path.join(tempRoot, 'not-a-directory');

    await fs.writeFile(filePath, 'x', 'utf8');
    await expect(initializeWorkspace(filePath)).rejects.toThrow();
  });
});

describe('Todo phase 3 workspace integration', () => {
  test('creates a work plan through the shared events sidecar chain', async () => {
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    const relativePath = await session.createTodoFile('Release plan');
    const state = session.getState();
    const file = state.files.find((candidate) => candidate.path === relativePath);
    const payload = session.getFileWindowV2InitialPayload(relativePath);
    const sidecar = JSON.parse(await fs.readFile(path.join(tempRoot, '.workboard', 'events.json'), 'utf8'));

    expect(relativePath).toBe('workboard/Release plan.md');
    expect(file?.parsedFile?.modules.map((module) => module.title)).toEqual(['当前', '已结束']);
    expect(payload?.modules.map((module) => module.title)).toEqual(['当前', '已结束']);
    expect(sidecar.documents[relativePath].documentId).toBeTypeOf('string');
    await expect(fs.stat(path.join(tempRoot, 'workboard', 'Release plan.sidecar.json'))).rejects.toThrow();

    const reopened = new WorkspaceSession();
    await reopened.openWorkspace(tempRoot);
    expect(reopened.getFileWindowV2InitialPayload(relativePath)?.modules.map((module) => module.title)).toEqual([
      '当前',
      '已结束',
    ]);
  });

  test('registers an existing Markdown file as a work plan when it is opened', async () => {
    await fs.mkdir(path.join(tempRoot, 'workboard'), { recursive: true });
    const markdown = '# 当前\n\n## [进行中] [供应商] 任意格式标题\n\n正文中的 [括号] 保持普通内容。\n\n# 已结束\n';
    await fs.writeFile(path.join(tempRoot, 'workboard', 'ordinary.md'), markdown, 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    const file = session.getState().files.find((candidate) => candidate.path === 'workboard/ordinary.md');
    expect(file?.parsedFile?.modules[0].headings[0]).toMatchObject({
      title: '任意格式标题',
      markers: ['进行中', '供应商'],
    });
    const document = await session.getTodoDocument('workboard/ordinary.md');
    const sidecar = JSON.parse(await fs.readFile(path.join(tempRoot, '.workboard', 'events.json'), 'utf8'));
    expect(document?.current[0]).toMatchObject({ title: '任意格式标题', status: '进行中', tags: ['供应商'] });
    expect(sidecar.documents['workboard/ordinary.md'].documentId).toBeTypeOf('string');
    await expect(fs.readFile(path.join(tempRoot, 'workboard', 'ordinary.md'), 'utf8')).resolves.toBe(markdown);
  });

  test.each(['', 'bad/name', 'bad:name', 'CON'])('rejects invalid work plan name %s', async (name) => {
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await expect(session.createTodoFile(name)).rejects.toThrow();
  });

  test('reports duplicate work plan names', async () => {
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.createTodoFile('Duplicate');
    await expect(session.createTodoFile('Duplicate')).rejects.toThrow('同名');
  });
});

describe('workspace paths', () => {
  test('allows workspace files and normalizes Windows separators', async () => {
    const filePath = path.join(tempRoot, 'docs', 'A.md');

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '# A', 'utf8');

    const result = await normalizeWorkspaceFilePath(tempRoot, path.join('docs', 'A.md'));

    expect(result).toMatchObject({
      ok: true,
      relativePath: 'docs/A.md',
    });
  });

  test('rejects files outside the workspace', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.md');

    try {
      await fs.writeFile(outsideFile, '# Outside', 'utf8');

      await expect(normalizeWorkspaceFilePath(tempRoot, outsideFile)).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects .. path escapes', async () => {
    const outsideFile = path.join(path.dirname(tempRoot), 'escape.md');

    await fs.writeFile(outsideFile, '# Escape', 'utf8');

    try {
      await expect(normalizeWorkspaceFilePath(tempRoot, '..\\escape.md')).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      await fs.rm(outsideFile, { force: true });
    }
  });
});

describe('workspace config', () => {
  test('generates default config', () => {
    expect(defaultWorkspaceConfig()).toEqual({
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      excludedDirectories: [],
      excludedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
  });

  test('writes and reloads config', async () => {
    await initializeWorkspace(tempRoot);
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: ['docs/A.md'],
      excludedDirectories: [],
      excludedFiles: [],
      pinnedFiles: ['A.md'],
      hiddenFiles: ['B.md'],
      showHiddenFiles: true,
    });

    await expect(loadWorkspaceConfig(tempRoot)).resolves.toEqual({
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: ['docs/A.md'],
      excludedDirectories: [],
      excludedFiles: [],
      pinnedFiles: ['A.md'],
      hiddenFiles: ['B.md'],
      showHiddenFiles: true,
    });
  });

  test('backs up corrupt config and falls back to default', async () => {
    await initializeWorkspace(tempRoot);
    await fs.writeFile(workspaceConfigPath(tempRoot), '{ bad json', 'utf8');

    await expect(loadWorkspaceConfig(tempRoot)).resolves.toEqual(defaultWorkspaceConfig());

    const files = await fs.readdir(path.join(tempRoot, '.workboard'));
    expect(files.some((file) => file.startsWith('workspace.json.corrupt-'))).toBe(true);
  });

  test('rejects invalid config before writing so existing config remains usable', async () => {
    await initializeWorkspace(tempRoot);
    await writeWorkspaceConfig(tempRoot, defaultWorkspaceConfig());

    expect(() => validateWorkspaceConfig({ schemaVersion: 3 })).toThrow();
    await expect(loadWorkspaceConfig(tempRoot)).resolves.toEqual(defaultWorkspaceConfig());
  });

  test('normalizes workspace directories and rejects directory links outside the workspace', async () => {
    const docsPath = path.join(tempRoot, 'docs');
    await fs.mkdir(docsPath);

    await expect(normalizeWorkspaceDirectoryPath(tempRoot, docsPath)).resolves.toMatchObject({
      ok: true,
      relativePath: 'docs',
    });
    await expect(normalizeWorkspaceDirectoryPath(tempRoot, '..')).resolves.toMatchObject({ ok: false });
  });

  test('migrates schema 1 and preserves pinned or hidden files outside workboard', async () => {
    await initializeWorkspace(tempRoot);
    await fs.writeFile(
      workspaceConfigPath(tempRoot),
      JSON.stringify({
        schemaVersion: 1,
        managedFiles: [{ path: 'OLD.md', order: 0, moduleOrder: [] }],
        pinnedFiles: ['PIN.md', 'workboard/CURRENT.md'],
        hiddenFiles: ['notes/HIDDEN.md'],
        showHiddenFiles: true,
      }),
      'utf8',
    );

    await expect(loadWorkspaceConfig(tempRoot)).resolves.toEqual({
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: ['PIN.md', 'notes/HIDDEN.md'],
      excludedDirectories: [],
      excludedFiles: [],
      pinnedFiles: ['PIN.md', 'workboard/CURRENT.md'],
      hiddenFiles: ['notes/HIDDEN.md'],
      showHiddenFiles: true,
    });

    const raw = JSON.parse(await fs.readFile(workspaceConfigPath(tempRoot), 'utf8')) as Record<string, unknown>;

    expect(raw.schemaVersion).toBe(2);
    expect(raw.managedFiles).toEqual(['PIN.md', 'notes/HIDDEN.md']);
  });

  test('normalizes, deduplicates, and removes directory-covered scope entries', () => {
    expect(validateWorkspaceConfig({
      schemaVersion: 2,
      managedDirectories: ['docs/guides', 'workboard\\active', 'WORKBOARD', 'docs', 'docs'],
      managedFiles: ['README.md', 'readme.md', 'docs\\PLAN.md', 'workboard/CURRENT.md'],
      pinnedFiles: ['README.md'],
      hiddenFiles: [],
      showHiddenFiles: false,
    })).toEqual({
      schemaVersion: 2,
      managedDirectories: ['WORKBOARD', 'docs'],
      managedFiles: ['README.md'],
      excludedDirectories: [],
      excludedFiles: [],
      pinnedFiles: ['README.md'],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
  });

  test('keeps explicit inclusions that override broader directory exclusions', () => {
    expect(validateWorkspaceConfig({
      schemaVersion: 2,
      managedDirectories: ['workboard', 'workboard/archive/keep'],
      managedFiles: ['workboard/archive/ONE.md', 'workboard/OTHER.md'],
      excludedDirectories: ['workboard/archive'],
      excludedFiles: ['workboard/PRIVATE.md'],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    })).toEqual({
      schemaVersion: 2,
      managedDirectories: ['workboard', 'workboard/archive/keep'],
      managedFiles: ['workboard/archive/ONE.md'],
      excludedDirectories: ['workboard/archive'],
      excludedFiles: ['workboard/PRIVATE.md'],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
  });

  test('rejects absolute paths, workspace escapes, and non-Markdown explicit files', () => {
    const base = {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    };

    expect(() => validateWorkspaceConfig({ ...base, managedDirectories: ['../outside'] })).toThrow(
      'inside the workspace',
    );
    expect(() => validateWorkspaceConfig({ ...base, managedFiles: ['C:\\outside.md'] })).toThrow(
      'must be relative',
    );
    expect(() => validateWorkspaceConfig({ ...base, managedFiles: ['notes.txt'] })).toThrow(
      'must be Markdown',
    );
  });
});

describe('workspace session', () => {
  test('uses source mtime as launcher activity for a file without heading activity nodes', async () => {
    const filePath = path.join(tempRoot, 'NEW.md');

    await fs.writeFile(filePath, '# New file\n\nbody\n', 'utf8');

    const session = new WorkspaceSession();
    const state = await session.openWorkspace(tempRoot);
    const file = state.files[0];

    expect(file.sourceMtimeMs).toBeTypeOf('number');
    expect(file.lastActivityAt).toBe(file.sourceMtimeMs);
  });

  test('discovers and parses repository markdown without manual add', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const extraPath = path.join(tempRoot, 'EXTRA.md');

    await fs.writeFile(currentPath, '# 当前目标\n\n# 当前计划\n', 'utf8');
    await fs.writeFile(extraPath, '## No H1\n', 'utf8');

    const session = new WorkspaceSession();
    const state = await session.openWorkspace(tempRoot);

    expect(state.files).toHaveLength(2);
    expect(state.files[0].parsedFile?.modules.map((module) => module.title)).toEqual([
      '当前目标',
      '当前计划',
    ]);
    expect(state.files[1].parsedFile?.modules[0].title).toBe('EXTRA.md');

    const restored = new WorkspaceSession();
    const restoredState = await restored.openWorkspace(tempRoot);

    expect(restoredState.files).toHaveLength(2);
  });

  test('archives any repository markdown into workboard/archive and removes it from discovered files', async () => {
    const notePath = path.join(tempRoot, 'notes', 'random-note.md');
    const otherPath = path.join(tempRoot, 'KEEP.md');

    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, '# Random', 'utf8');
    await fs.writeFile(otherPath, '# Keep', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    const result = await session.archiveFile('notes/random-note.md');
    const archivedPath = path.join(tempRoot, 'workboard', 'archive', 'random-note.md');

    expect(result.archivedPath).toBe('workboard/archive/random-note.md');
    expect(result.state.files.map((file) => file.path)).toEqual(['KEEP.md']);
    await expect(fs.readFile(archivedPath, 'utf8')).resolves.toBe('# Random');
    await expect(fs.stat(notePath)).rejects.toThrow();
    await expect(fs.readFile(otherPath, 'utf8')).resolves.toBe('# Keep');
  });

  test('creates workboard/archive when archiving and does not auto re-add archived files on restore', async () => {
    const notePath = path.join(tempRoot, 'ANY.md');

    await fs.writeFile(notePath, '# Any', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    await expect(fs.stat(path.join(tempRoot, 'workboard', 'archive'))).rejects.toThrow();
    await session.archiveFile('ANY.md');
    await expect(fs.stat(path.join(tempRoot, 'workboard', 'archive'))).resolves.toBeTruthy();

    const restored = new WorkspaceSession();
    const restoredState = await restored.openWorkspace(tempRoot);

    expect(restoredState.files).toEqual([]);
    await expect(fs.readFile(path.join(tempRoot, 'workboard', 'archive', 'ANY.md'), 'utf8')).resolves.toBe('# Any');
  });

  test('does not overwrite an existing archive target', async () => {
    const notePath = path.join(tempRoot, 'ANY.md');
    const archivePath = path.join(tempRoot, 'workboard', 'archive', 'ANY.md');

    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(notePath, '# Source', 'utf8');
    await fs.writeFile(archivePath, '# Existing', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    await expect(session.archiveFile('ANY.md')).rejects.toThrow('Archive target already exists');
    expect(session.getState().files.map((file) => file.path)).toEqual(['ANY.md']);
    await expect(fs.readFile(notePath, 'utf8')).resolves.toBe('# Source');
    await expect(fs.readFile(archivePath, 'utf8')).resolves.toBe('# Existing');
  });

  test('keeps management state when archive move fails', async () => {
    const notePath = path.join(tempRoot, 'ANY.md');

    await fs.writeFile(notePath, '# Any', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await fs.rm(notePath);

    await expect(session.archiveFile('ANY.md')).rejects.toThrow('File does not exist');
    expect(session.getState().files.map((file) => file.path)).toEqual(['ANY.md']);
  });

  test('old managedFiles entries do not preserve the legacy whole-repository scope', async () => {
    const goodPath = path.join(tempRoot, 'GOOD.md');
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-outside-'));
    const outsidePath = path.join(outsideRoot, 'EXTERNAL.md');

    try {
      await fs.writeFile(goodPath, '# Good', 'utf8');
      await fs.writeFile(outsidePath, '# External', 'utf8');
      await initializeWorkspace(tempRoot);
      await fs.writeFile(
        workspaceConfigPath(tempRoot),
        JSON.stringify({
          schemaVersion: 1,
          managedFiles: [
            { path: 'MISSING.md', order: 0, moduleOrder: [] },
            { path: outsidePath, order: 1, moduleOrder: [] },
          ],
        }),
        'utf8',
      );

      const restored = new WorkspaceSession();
      const state = await restored.openWorkspace(tempRoot);

      expect(state.files).toEqual([]);
      await expect(loadWorkspaceConfig(tempRoot)).resolves.toMatchObject({
        schemaVersion: 2,
        managedDirectories: ['workboard'],
        managedFiles: [],
      });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('persists pin, hidden, and show-hidden preferences for repository files', async () => {
    const firstPath = path.join(tempRoot, 'A.md');
    const secondPath = path.join(tempRoot, 'B.md');

    await fs.writeFile(firstPath, '# A', 'utf8');
    await fs.writeFile(secondPath, '# B', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('A.md', true);
    await session.setFileHidden('B.md', true);
    const state = await session.setShowHiddenFiles(true);

    expect(state.showHiddenFiles).toBe(true);
    expect(state.files.find((file) => file.path === 'A.md')?.pinned).toBe(true);
    expect(state.files.find((file) => file.path === 'B.md')?.hidden).toBe(true);

    const restored = new WorkspaceSession();
    const restoredState = await restored.openWorkspace(tempRoot);

    expect(restoredState.showHiddenFiles).toBe(true);
    expect(restoredState.files.find((file) => file.path === 'A.md')?.pinned).toBe(true);
    expect(restoredState.files.find((file) => file.path === 'B.md')?.hidden).toBe(true);
  });

  test('renamed repository files do not inherit old pin state', async () => {
    const oldPath = path.join(tempRoot, 'OLD.md');
    const newPath = path.join(tempRoot, 'NEW.md');

    await fs.writeFile(oldPath, '# Old', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('OLD.md', true);
    await fs.rename(oldPath, newPath);
    const change = await session.reconcileDiscoveredFiles();

    expect(change.removed).toEqual(['OLD.md']);
    expect(change.added).toEqual(['NEW.md']);
    expect(session.getState().files).toMatchObject([{ path: 'NEW.md', pinned: false }]);
  });

  test('does not discover archive, git, node_modules, or linked directories', async () => {
    const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-linked-'));

    try {
      await fs.mkdir(path.join(tempRoot, 'workboard', 'archive'), { recursive: true });
      await fs.mkdir(path.join(tempRoot, '.git'), { recursive: true });
      await fs.mkdir(path.join(tempRoot, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(tempRoot, 'VISIBLE.md'), '# Visible', 'utf8');
      await fs.writeFile(path.join(tempRoot, 'workboard', 'archive', 'ARCHIVED.md'), '# Archived', 'utf8');
      await fs.writeFile(path.join(tempRoot, '.git', 'GIT.md'), '# Git', 'utf8');
      await fs.writeFile(path.join(tempRoot, 'node_modules', 'pkg', 'DEP.md'), '# Dep', 'utf8');
      await fs.writeFile(path.join(linkedRoot, 'LINKED.md'), '# Linked', 'utf8');

      await fs.symlink(linkedRoot, path.join(tempRoot, 'linked-dir'), 'junction').catch(() => undefined);

      const session = new WorkspaceSession();
      const state = await session.openWorkspace(tempRoot);

      expect(state.files.map((file) => file.path)).toEqual(['VISIBLE.md']);
    } finally {
      await fs.rm(linkedRoot, { recursive: true, force: true });
    }
  });

  test('new workspaces discover only workboard markdown by default', async () => {
    await fs.rm(path.join(tempRoot, '.workboard', 'workspace.json'));
    await initializeWorkspace(tempRoot);
    await fs.mkdir(path.join(tempRoot, 'workboard'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'OUTSIDE.md'), '# Outside', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'workboard', 'CURRENT.md'), '# Current', 'utf8');

    const session = new WorkspaceSession();
    const state = await session.openWorkspace(tempRoot);

    expect(state.files.map((file) => file.path)).toEqual(['workboard/CURRENT.md']);
  });

  test('loads explicit files outside managed directories and retains missing entries', async () => {
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: ['docs/EXPLICIT.md', 'notes/MISSING.md'],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    await fs.mkdir(path.join(tempRoot, 'workboard'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'docs', 'EXPLICIT.md'), '# Explicit', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'UNMANAGED.md'), '# Unmanaged', 'utf8');

    const session = new WorkspaceSession();
    const state = await session.openWorkspace(tempRoot);

    expect(state.files.map((file) => ({ path: file.path, status: file.status }))).toEqual([
      { path: 'docs/EXPLICIT.md', status: 'available' },
      { path: 'notes/MISSING.md', status: 'missing' },
    ]);
  });

  test('registers temporary files for file-window payloads without adding them to launcher state', async () => {
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    const temporaryPath = path.join(tempRoot, 'notes', 'TEMP.md');

    await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
    await fs.writeFile(temporaryPath, '# Temporary', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    await expect(session.registerTemporaryFile(temporaryPath)).resolves.toEqual({
      relativePath: 'notes/TEMP.md',
      added: true,
    });
    expect(session.getState().files).toEqual([]);
    expect(session.getFileWindowV2InitialPayload('notes/TEMP.md')?.modules[0].title).toBe('Temporary');
    expect(session.getManagedWatchTargets()).toContain(temporaryPath);

    expect(session.unregisterTemporaryFile('notes/TEMP.md')).toBe(true);
    expect(session.getFileWindowV2InitialPayload('notes/TEMP.md')).toBeNull();
    expect(session.getManagedWatchTargets()).not.toContain(temporaryPath);
  });

  test('adds and removes managed directories and explicit files at runtime', async () => {
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    const docsDir = path.join(tempRoot, 'docs');
    const docsFile = path.join(docsDir, 'PLAN.md');
    const explicitFile = path.join(tempRoot, 'README.md');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(docsFile, '# Plan', 'utf8');
    await fs.writeFile(explicitFile, '# Readme', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    await expect(session.addManagedDirectory(docsDir)).resolves.toEqual({ added: ['docs/PLAN.md'], removed: [] });
    await expect(session.addManagedFile(explicitFile)).resolves.toEqual({ added: ['README.md'], removed: [] });
    expect(session.getState()).toMatchObject({
      managedDirectories: ['workboard', 'docs'],
      managedFiles: ['README.md'],
    });

    await expect(session.removeManagedDirectory('docs')).resolves.toEqual({ added: [], removed: ['docs/PLAN.md'] });
    await expect(session.removeManagedFile('README.md')).resolves.toEqual({ added: [], removed: ['README.md'] });
    expect(session.getState()).toMatchObject({ managedDirectories: ['workboard'], managedFiles: [] });
  });

  test('excludes managed descendants and supports explicit nested re-inclusion', async () => {
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    const workboardDir = path.join(tempRoot, 'workboard');
    const notesDir = path.join(workboardDir, 'notes');
    const nestedDir = path.join(notesDir, 'sub');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(workboardDir, 'KEEP.md'), '# Keep', 'utf8');
    await fs.writeFile(path.join(notesDir, 'A.md'), '# A', 'utf8');
    await fs.writeFile(path.join(nestedDir, 'B.md'), '# B', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    await expect(session.removeManagedFile('workboard/KEEP.md')).resolves.toEqual({
      added: [],
      removed: ['workboard/KEEP.md'],
    });
    await expect(loadWorkspaceConfig(tempRoot)).resolves.toMatchObject({
      managedFiles: [],
      excludedFiles: ['workboard/KEEP.md'],
    });
    await expect(session.addManagedFile('workboard/KEEP.md')).resolves.toEqual({
      added: ['workboard/KEEP.md'],
      removed: [],
    });

    await expect(session.removeManagedDirectory('workboard/notes')).resolves.toEqual({
      added: [],
      removed: ['workboard/notes/A.md', 'workboard/notes/sub/B.md'],
    });
    await expect(loadWorkspaceConfig(tempRoot)).resolves.toMatchObject({
      excludedDirectories: ['workboard/notes'],
    });
    await expect(session.listWorkspaceDirectory('workboard')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'workboard/notes', management: 'unmanaged' }),
    ]));

    await expect(session.addManagedDirectory('workboard/notes/sub')).resolves.toEqual({
      added: ['workboard/notes/sub/B.md'],
      removed: [],
    });
    expect(session.getState().files.map((file) => file.path)).toEqual([
      'workboard/KEEP.md',
      'workboard/notes/sub/B.md',
    ]);
    await expect(loadWorkspaceConfig(tempRoot)).resolves.toMatchObject({
      managedDirectories: ['workboard', 'workboard/notes/sub'],
      excludedDirectories: ['workboard/notes'],
    });

    await expect(session.addManagedDirectory('workboard/notes')).resolves.toEqual({
      added: ['workboard/notes/A.md'],
      removed: [],
    });
    await expect(loadWorkspaceConfig(tempRoot)).resolves.toMatchObject({
      managedDirectories: ['workboard'],
      excludedDirectories: [],
    });
  });

  test('browses workspace directories lazily without reading unmanaged Markdown content', async () => {
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: ['docs/EXPLICIT.md'],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: true,
    });
    await fs.mkdir(path.join(tempRoot, 'workboard'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, '.workboardbu'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'README.md'), '# Unmanaged', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'notes.txt'), 'Not Markdown', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'docs', 'EXPLICIT.md'), '# Explicit', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    const readFile = vi.spyOn(fs, 'readFile');

    await expect(session.listWorkspaceDirectory('.')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'docs', kind: 'directory', management: 'partial' }),
      expect.objectContaining({
        path: 'workboard',
        kind: 'directory',
        management: 'managed',
        lastActivityAt: expect.any(Number),
      }),
      expect.objectContaining({ path: 'README.md', kind: 'file', management: 'unmanaged' }),
    ]));
    expect((await session.listWorkspaceDirectory('.')).some((entry) => entry.path.startsWith('.'))).toBe(false);
    expect((await session.listWorkspaceDirectory('.')).some((entry) => entry.path === 'notes.txt')).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    await expect(session.listWorkspaceDirectory('..')).rejects.toThrow('outside the workspace');
  });

  test('converts a temporary file to long-term management without rebuilding its window payload', async () => {
    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    const temporaryPath = path.join(tempRoot, 'TEMP.md');
    await fs.writeFile(temporaryPath, '# Temporary', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.registerTemporaryFile(temporaryPath);
    const previousParsedFile = session.getFileWindowV2InitialPayload('TEMP.md');

    await expect(session.addManagedFile(temporaryPath)).resolves.toEqual({ added: [], removed: [] });
    expect(session.isTemporaryFile('TEMP.md')).toBe(false);
    expect(session.getState().files.map((file) => file.path)).toEqual(['TEMP.md']);
    expect(session.getFileWindowV2InitialPayload('TEMP.md')?.modules).toEqual(previousParsedFile?.modules);
  });

  test('reconcile reads only newly discovered files and preserves existing parse results', async () => {
    const firstPath = path.join(tempRoot, 'FIRST.md');
    const secondPath = path.join(tempRoot, 'SECOND.md');

    await fs.writeFile(firstPath, '# First', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    const previousParsedFile = session.getState().files[0].parsedFile;
    await fs.writeFile(secondPath, '# Second', 'utf8');

    const readFile = vi.spyOn(fs, 'readFile');
    const change = await session.reconcileDiscoveredFiles();

    expect(change).toEqual({ added: ['SECOND.md'], removed: [] });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls[0][0]).toBe(secondPath);
    expect(session.getState().files.find((file) => file.path === 'FIRST.md')?.parsedFile).toBe(previousParsedFile);
  });
});

describe('file exit cleanup', () => {
  test('removeFilePreferences drops the file from pinned and hidden lists', async () => {
    const firstPath = path.join(tempRoot, 'A.md');
    const secondPath = path.join(tempRoot, 'B.md');

    await fs.writeFile(firstPath, '# A', 'utf8');
    await fs.writeFile(secondPath, '# B', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('A.md', true);
    await session.setFileHidden('B.md', true);

    await session.removeFilePreferences('A.md');
    await session.removeFilePreferences('B.md');
    const state = await session.openWorkspace(tempRoot);

    expect(state.files.find((file) => file.path === 'A.md')?.pinned).toBe(false);
    expect(state.files.find((file) => file.path === 'B.md')?.hidden).toBe(false);
  });

  test('removeFilePreferences is a no-op for files that have no preferences', async () => {
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    const before = session.getState();

    const state = await session.removeFilePreferences('A.md');

    expect(state).toEqual(before);
  });

  test('removeFileStyles drops only the targeted file from styles.json', async () => {
    const aPath = path.join(tempRoot, 'A.md');
    const bPath = path.join(tempRoot, 'B.md');

    await fs.writeFile(aPath, '# A', 'utf8');
    await fs.writeFile(bPath, '# B', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setMarkerColor('A.md', 'P1', '#123456');
    await session.setMarkerColor('B.md', 'P2', '#abcdef');

    await session.removeFileStyles('A.md');
    const styles = await loadStylesConfig(tempRoot);

    expect(styles.files['A.md']).toBeUndefined();
    expect(styles.files['B.md']?.markers.P2?.colorOverride).toBe('#abcdef');
  });

  test('removeFileStyles is a safe no-op for a file that has no styles', async () => {
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);

    await expect(session.removeFileStyles('A.md')).resolves.toBeUndefined();
    await expect(session.removeFileStyles('NOT_A_FILE.md')).resolves.toBeUndefined();

    const styles = await loadStylesConfig(tempRoot);

    expect(styles.files['A.md']).toBeUndefined();
  });

  test('a re-added file after archive starts with default preferences and styles', async () => {
    const notePath = path.join(tempRoot, 'NOTE.md');

    await fs.writeFile(notePath, '# A', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('NOTE.md', true);
    await session.setFileHidden('NOTE.md', true);
    await session.setMarkerColor('NOTE.md', 'P1', '#123456');

    await session.archiveFile('NOTE.md');

    await session.removeFilePreferences('NOTE.md');
    await session.removeFileStyles('NOTE.md');

    const restoredPath = path.join(tempRoot, 'NOTE.md');
    const archivedPath = path.join(tempRoot, 'workboard', 'archive', 'NOTE.md');

    await fs.rename(archivedPath, restoredPath);

    const restored = new WorkspaceSession();
    const restoredState = await restored.openWorkspace(tempRoot);

    const file = restoredState.files.find((candidate) => candidate.path === 'NOTE.md');

    expect(file).toMatchObject({ pinned: false, hidden: false });
    const styles = await loadStylesConfig(tempRoot);

    expect(styles.files['NOTE.md']).toBeUndefined();
  });

  test('preferences are dropped even when only normalized slashes differ', async () => {
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('A.md', true);
    await session.setFileHidden('A.md', true);

    await session.removeFilePreferences('A.md');
    const state = await session.getState();

    expect(state.files[0]).toMatchObject({ path: 'A.md', pinned: false, hidden: false });
  });

  test('archiveFile does not clear preferences or styles before reconcile succeeds', async () => {
    const notePath = path.join(tempRoot, 'ARCHIVE_TEST.md');

    await fs.writeFile(notePath, '# Archive', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('ARCHIVE_TEST.md', true);
    await session.setFileHidden('ARCHIVE_TEST.md', true);
    await session.setMarkerColor('ARCHIVE_TEST.md', 'P1', '#ff0000');

    await session.archiveFile('ARCHIVE_TEST.md');

    const config = await loadWorkspaceConfig(tempRoot);
    expect(config.pinnedFiles).toContain('ARCHIVE_TEST.md');
    expect(config.hiddenFiles).toContain('ARCHIVE_TEST.md');

    const styles = await loadStylesConfig(tempRoot);
    expect(styles.files['ARCHIVE_TEST.md']).toBeDefined();

    await session.removeFilePreferences('ARCHIVE_TEST.md');
    await session.removeFileStyles('ARCHIVE_TEST.md');

    const configAfter = await loadWorkspaceConfig(tempRoot);
    expect(configAfter.pinnedFiles).not.toContain('ARCHIVE_TEST.md');
    expect(configAfter.hiddenFiles).not.toContain('ARCHIVE_TEST.md');

    const stylesAfter = await loadStylesConfig(tempRoot);
    expect(stylesAfter.files['ARCHIVE_TEST.md']).toBeUndefined();
  });

  test('archiveFile keeps preferences and styles if reconcile fails', async () => {
    const notePath = path.join(tempRoot, 'ARCHIVE_FAIL.md');

    await fs.writeFile(notePath, '# Archive', 'utf8');

    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('ARCHIVE_FAIL.md', true);
    await session.setFileHidden('ARCHIVE_FAIL.md', true);
    await session.setMarkerColor('ARCHIVE_FAIL.md', 'P1', '#ff0000');

    await session.archiveFile('ARCHIVE_FAIL.md');

    const config = await loadWorkspaceConfig(tempRoot);
    expect(config.pinnedFiles).toContain('ARCHIVE_FAIL.md');
    expect(config.hiddenFiles).toContain('ARCHIVE_FAIL.md');

    const styles = await loadStylesConfig(tempRoot);
    expect(styles.files['ARCHIVE_FAIL.md']).toBeDefined();

    await session.removeFilePreferences('ARCHIVE_FAIL.md');
    await session.removeFileStyles('ARCHIVE_FAIL.md');
  });
});

describe('file grouping', () => {
  test('orders pinned, workboard, root, and other folders with stable file sorting', () => {
    const groups = groupManagedFiles([
      fileState('z/Two.md'),
      fileState('ROOT-B.md'),
      fileState('workboard/DECISIONS.md'),
      fileState('a/Alpha.md'),
      fileState('ROOT-A.md'),
      fileState('z/One.md'),
      fileState('Pinned.md', { pinned: true }),
    ], false);

    expect(groups.map((group) => group.label)).toEqual(['置顶', 'workboard', '根目录', 'a', 'z']);
    expect(groups[2].files.map((file) => file.path)).toEqual(['ROOT-A.md', 'ROOT-B.md']);
    expect(groups[4].files.map((file) => file.path)).toEqual(['z/One.md', 'z/Two.md']);
  });

  test('filters hidden files unless show hidden is enabled', () => {
    const files = [fileState('A.md'), fileState('B.md', { hidden: true })];

    expect(groupManagedFiles(files, false).flatMap((group) => group.files.map((file) => file.path))).toEqual(['A.md']);
    expect(groupManagedFiles(files, true).flatMap((group) => group.files.map((file) => file.path))).toEqual(['A.md', 'B.md']);
  });
});

describe('managed file watcher', () => {
  test('watches only configured directories and ignores unrelated repository files', async () => {
    const workboardDir = path.join(tempRoot, 'workboard');
    const managedPath = path.join(workboardDir, 'CURRENT.md');
    const unrelatedPath = path.join(tempRoot, 'UNRELATED.md');

    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    await fs.mkdir(workboardDir, { recursive: true });
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined, { debounceMs: 20 });

    try {
      await watcher.start();
      expect(watcher.getWatchTargets()).toEqual([workboardDir]);

      await fs.writeFile(unrelatedPath, '# Unrelated', 'utf8');
      await delay(80);
      expect(session.getState().files).toEqual([]);

      await fs.writeFile(managedPath, '# Current', 'utf8');
      await waitFor(() => session.getState().files[0]?.path === 'workboard/CURRENT.md');
      expect(watcher.getWatchedRelativePaths()).toEqual(['workboard/CURRENT.md']);

      await fs.rm(workboardDir, { recursive: true, force: true });
      await waitFor(() => session.getState().files.length === 0);
      expect(watcher.getWatchTargets()).toEqual([workboardDir]);
    } finally {
      await watcher.stop();
    }
  });

  test('adds and releases a temporary file watch target dynamically', async () => {
    const workboardDir = path.join(tempRoot, 'workboard');
    const temporaryPath = path.join(tempRoot, 'TEMP.md');

    await writeWorkspaceConfig(tempRoot, {
      schemaVersion: 2,
      managedDirectories: ['workboard'],
      managedFiles: [],
      pinnedFiles: [],
      hiddenFiles: [],
      showHiddenFiles: false,
    });
    await fs.mkdir(workboardDir, { recursive: true });
    await fs.writeFile(temporaryPath, '# Temporary', 'utf8');
    const session = new WorkspaceSession();
    await session.openWorkspace(tempRoot);
    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined);

    try {
      await watcher.start();
      await session.registerTemporaryFile(temporaryPath);
      await watcher.sync();
      expect(watcher.getWatchTargets()).toEqual([workboardDir, temporaryPath]);

      expect(session.unregisterTemporaryFile('TEMP.md')).toBe(true);
      await watcher.sync();
      expect(watcher.getWatchTargets()).toEqual([workboardDir]);
    } finally {
      await watcher.stop();
    }
  });

  test('updates a managed file after an ordinary save', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const updates: string[] = [];
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# One', 'utf8');
    await session.openWorkspace(tempRoot);

    const watcher = new ManagedFileWatcher(session, () => undefined, (relativePath) => {
      updates.push(relativePath);
    }, {
      debounceMs: 60,
      retryDelayMs: 20,
    });

    try {
      await watcher.start();
      await fs.writeFile(currentPath, '# Two', 'utf8');
      await waitFor(() => updates.length > 0);

      expect(session.getModuleData('CURRENT.md::Two::0')?.title).toBe('Two');
    } finally {
      await watcher.stop();
    }
  });

  test('merges consecutive saves for the same file', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const updates: string[] = [];
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# One', 'utf8');
    await session.openWorkspace(tempRoot);

    const watcher = new ManagedFileWatcher(session, () => undefined, (relativePath) => {
      updates.push(relativePath);
    }, {
      debounceMs: 80,
      retryDelayMs: 10,
    });

    try {
      await watcher.start();
      watcher.schedule('CURRENT.md');
      watcher.schedule('CURRENT.md');
      watcher.schedule('CURRENT.md');
      await waitFor(() => updates.length === 1);
      await delay(120);

      expect(updates).toEqual(['CURRENT.md']);
    } finally {
      await watcher.stop();
    }
  });

  test('handles atomic replacement saves', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const replacementPath = path.join(tempRoot, 'CURRENT.md.tmp');
    const updates: string[] = [];
    const fileSetChanges: Array<{ added: string[]; removed: string[] }> = [];
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# One', 'utf8');
    await session.openWorkspace(tempRoot);

    const watcher = new ManagedFileWatcher(session, () => undefined, (relativePath) => {
      updates.push(relativePath);
    }, {
      debounceMs: 60,
      retryDelayMs: 20,
    }, (change) => {
      fileSetChanges.push(change);
    });

    try {
      await watcher.start();
      await fs.writeFile(replacementPath, '# Replaced', 'utf8');
      await fs.rm(currentPath);
      await fs.rename(replacementPath, currentPath);
      await waitFor(() => updates.length > 0);
      await delay(120);

      expect(session.getModuleData('CURRENT.md::Replaced::0')?.title).toBe('Replaced');
      expect(fileSetChanges).toEqual([]);
    } finally {
      await watcher.stop();
    }
  });

  test('removes deleted repository files and recovers when they reappear', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const fileSetChanges: Array<{ added: string[]; removed: string[] }> = [];
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# One', 'utf8');
    await session.openWorkspace(tempRoot);

    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined, {
      debounceMs: 60,
      retryDelayMs: 20,
    }, (change) => {
      fileSetChanges.push(change);
    });

    try {
      await watcher.start();
      await fs.rm(currentPath);
      await waitFor(() => session.getState().files.length === 0);

      expect(fileSetChanges.at(-1)?.removed).toEqual(['CURRENT.md']);
      expect(session.getModuleData('CURRENT.md::One::0')).toBeNull();

      await fs.writeFile(currentPath, '# Back', 'utf8');
      await waitFor(() => session.getState().files[0]?.status === 'available');

      expect(session.getModuleData('CURRENT.md::Back::0')?.title).toBe('Back');
    } finally {
      await watcher.stop();
    }
  });

  test('retries transient unreadable results before broadcasting', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const fakeSession = {
      getManagedFileWatchEntries: () => [{ relativePath: 'CURRENT.md', absolutePath: path.join(tempRoot, 'CURRENT.md') }],
      refreshManagedFile: async () => {
        attempts += 1;

        return {
          next: {
            path: 'CURRENT.md',
            order: 0,
            source: 'repository',
            pinned: false,
            hidden: false,
            status: attempts < 3 ? 'unreadable' : 'available',
          },
        };
      },
    } as unknown as WorkspaceSession;
    const watcher = new ManagedFileWatcher(fakeSession, () => undefined, (relativePath) => {
      calls.push(relativePath);
    }, {
      debounceMs: 10,
      retryDelayMs: 10,
      retryCount: 3,
    });

    await watcher.start();
    watcher.schedule('CURRENT.md');
    await waitFor(() => calls.length === 1);
    await watcher.stop();

    expect(attempts).toBe(3);
    expect(calls).toEqual(['CURRENT.md']);
  });

  test('updates the discovered file set without a full reconciliation', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const extraPath = path.join(tempRoot, 'EXTRA.md');
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# One', 'utf8');
    await session.openWorkspace(tempRoot);

    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined);

    try {
      await watcher.start();
      expect(watcher.getWatchedRelativePaths()).toEqual(['CURRENT.md']);
      const reconcile = vi.spyOn(session, 'reconcileDiscoveredFiles');

      await fs.writeFile(extraPath, '# Extra', 'utf8');
      await waitFor(() => watcher.getWatchedRelativePaths().includes('EXTRA.md'));
      expect(watcher.getWatchedRelativePaths()).toEqual(['CURRENT.md', 'EXTRA.md']);

      await fs.rm(currentPath);
      await waitFor(() => !watcher.getWatchedRelativePaths().includes('CURRENT.md'));
      expect(watcher.getWatchedRelativePaths()).toEqual(['EXTRA.md']);
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await watcher.stop();
    }
  });

  test('starting a new workspace releases the old watcher set', async () => {
    const firstPath = path.join(tempRoot, 'FIRST.md');
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-second-'));
    const secondPath = path.join(secondRoot, 'SECOND.md');
    const session = new WorkspaceSession();
    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined);

    try {
      await fs.writeFile(firstPath, '# First', 'utf8');
      await fs.writeFile(secondPath, '# Second', 'utf8');
      await initializeWorkspace(secondRoot);
      await writeWorkspaceConfig(secondRoot, {
        schemaVersion: 2,
        managedDirectories: ['.'],
        managedFiles: [],
        pinnedFiles: [],
        hiddenFiles: [],
        showHiddenFiles: false,
      });
      await session.openWorkspace(tempRoot);
      await watcher.start();
      expect(watcher.getWatchedRelativePaths()).toEqual(['FIRST.md']);

      await session.openWorkspace(secondRoot);
      await watcher.start();
      expect(watcher.getWatchedRelativePaths()).toEqual(['SECOND.md']);
    } finally {
      await watcher.stop();
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });

  test('ignores stale refresh completion after a newer same-file refresh commits', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const refreshes: ControlledRefresh[] = [];
    const updates: string[] = [];
    const fakeSession = controlledRefreshSession(
      () => [{ relativePath: 'CURRENT.md', absolutePath: currentPath }],
      refreshes,
    );
    const watcher = new ManagedFileWatcher(fakeSession, () => undefined, (_relativePath, result) => {
      updates.push(result.next.parsedFile?.modules[0]?.title ?? result.next.status);
    }, {
      debounceMs: 1,
      retryDelayMs: 1,
    });

    await fs.writeFile(currentPath, '# Initial', 'utf8');

    try {
      await watcher.start();
      watcher.schedule('CURRENT.md');
      await waitFor(() => refreshes.length === 1);

      watcher.schedule('CURRENT.md');
      await waitFor(() => refreshes.length === 2);

      refreshes[1].resolve(availableRefresh('CURRENT.md', '# New'));
      await waitFor(() => updates.length === 1);

      refreshes[0].resolve(availableRefresh('CURRENT.md', '# Old'));
      await delay(30);

      expect(updates).toEqual(['New']);
      expect(fakeSession.getCommittedTitle()).toBe('New');
    } finally {
      await watcher.stop();
    }
  });

  test('ignores stale refresh failure after a newer same-file refresh commits', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const refreshes: ControlledRefresh[] = [];
    const updates: string[] = [];
    const fakeSession = controlledRefreshSession(
      () => [{ relativePath: 'CURRENT.md', absolutePath: currentPath }],
      refreshes,
    );
    const watcher = new ManagedFileWatcher(fakeSession, () => undefined, (_relativePath, result) => {
      updates.push(result.next.status);
    }, {
      debounceMs: 1,
      retryDelayMs: 1,
    });

    await fs.writeFile(currentPath, '# Initial', 'utf8');

    try {
      await watcher.start();
      watcher.schedule('CURRENT.md');
      await waitFor(() => refreshes.length === 1);

      watcher.schedule('CURRENT.md');
      await waitFor(() => refreshes.length === 2);

      refreshes[1].resolve(availableRefresh('CURRENT.md', '# New'));
      await waitFor(() => updates.length === 1);

      refreshes[0].resolve({
        next: {
          path: 'CURRENT.md',
          order: 0,
          source: 'repository',
          pinned: false,
          hidden: false,
          status: 'parse-error',
          statusMessage: 'old parse failure',
        },
      });
      await delay(30);

      expect(updates).toEqual(['available']);
      expect(fakeSession.getCommittedTitle()).toBe('New');
    } finally {
      await watcher.stop();
    }
  });

  test('invalidates running refresh when its file is removed from the watcher set', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const refreshes: ControlledRefresh[] = [];
    let entries = [{ relativePath: 'CURRENT.md', absolutePath: currentPath }];
    const updates: string[] = [];
    const fakeSession = controlledRefreshSession(() => entries, refreshes);
    const watcher = new ManagedFileWatcher(fakeSession, () => undefined, (_relativePath, result) => {
      updates.push(result.next.status);
    }, {
      debounceMs: 1,
      retryDelayMs: 1,
    });

    await fs.writeFile(currentPath, '# Initial', 'utf8');

    try {
      await watcher.start();
      watcher.schedule('CURRENT.md');
      await waitFor(() => refreshes.length === 1);

      entries = [];
      await watcher.sync();
      refreshes[0].resolve(availableRefresh('CURRENT.md', '# Old'));
      await delay(30);

      expect(updates).toEqual([]);
      expect(fakeSession.getCommittedTitle()).toBeUndefined();
    } finally {
      await watcher.stop();
    }
  });

  test('invalidates running refresh when the watcher stops for workspace switch', async () => {
    const currentPath = path.join(tempRoot, 'CURRENT.md');
    const refreshes: ControlledRefresh[] = [];
    const updates: string[] = [];
    const fakeSession = controlledRefreshSession(
      () => [{ relativePath: 'CURRENT.md', absolutePath: currentPath }],
      refreshes,
    );
    const watcher = new ManagedFileWatcher(fakeSession, () => undefined, (_relativePath, result) => {
      updates.push(result.next.status);
    }, {
      debounceMs: 1,
      retryDelayMs: 1,
    });

    await fs.writeFile(currentPath, '# Initial', 'utf8');
    await watcher.start();
    watcher.schedule('CURRENT.md');
    await waitFor(() => refreshes.length === 1);

    await watcher.stop();
    refreshes[0].resolve(availableRefresh('CURRENT.md', '# Old'));
    await delay(30);

    expect(updates).toEqual([]);
    expect(fakeSession.getCommittedTitle()).toBeUndefined();
  });
});

describe('module update diff', () => {
  test('marks every visible unit when a whole file is newly discovered', () => {
    const next = parseMarkdownFile('# M\n\nintro\n\n## A\n\n### Child\n\nnew', 'NEW.md', 1);
    const summaries = buildModuleUpdateSummaries({ next, fileRecovered: false, changedAt: 10, id: 1 });
    const summary = summaries['NEW.md::M::0'];
    const pending = mergePendingFileUpdates({}, summaries);

    expect(summary).toMatchObject({
      moduleAdded: true,
      leadingBodyChanged: true,
      changedHeadingKeys: ['A', 'A/Child'],
    });
    expect(deriveUpdatedFilePaths(pending)).toEqual(['NEW.md']);
    expect(deriveUpdatedModuleKeys(getFileWindowV2UpdatePayload(pending, 'NEW.md'))).toEqual(new Set(['NEW.md::M::0']));
  });

  test('marks only the heading whose direct body changed', () => {
    const previous = parseMarkdownFile('# M\n\n## A\n\nold\n\n## B\n\nsame', 'LIVE_TEST.md', 1);
    const next = parseMarkdownFile('# M\n\n## A\n\nnew\n\n## B\n\nsame', 'LIVE_TEST.md', 2);
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 10, id: 1 });

    expect(summaries['LIVE_TEST.md::M::0']).toMatchObject({
      leadingBodyChanged: false,
      changedHeadingKeys: ['A'],
    });
  });

  test('marks newly added heading nodes', () => {
    const previous = parseMarkdownFile('# M\n\n## A\n\nold', 'LIVE_TEST.md', 1);
    const next = parseMarkdownFile('# M\n\n## A\n\nold\n\n## B\n\nnew', 'LIVE_TEST.md', 2);
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 10, id: 1 });

    expect(summaries['LIVE_TEST.md::M::0']?.changedHeadingKeys).toEqual(['B']);
  });

  test('does not mark ancestors when only a child changed', () => {
    const previous = parseMarkdownFile('# M\n\n## A\n\n### C\n\nold', 'LIVE_TEST.md', 1);
    const next = parseMarkdownFile('# M\n\n## A\n\n### C\n\nnew', 'LIVE_TEST.md', 2);
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 10, id: 1 });

    expect(summaries['LIVE_TEST.md::M::0']?.changedHeadingKeys).toEqual(['A/C']);
  });

  test('marks module leading body changes separately', () => {
    const previous = parseMarkdownFile('# M\n\nintro\n\n## A\n\nsame', 'LIVE_TEST.md', 1);
    const next = parseMarkdownFile('# M\n\nintro changed\n\n## A\n\nsame', 'LIVE_TEST.md', 2);
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 10, id: 1 });

    expect(summaries['LIVE_TEST.md::M::0']).toMatchObject({
      leadingBodyChanged: true,
      changedHeadingKeys: [],
    });
  });

  test('marks changes in two modules independently', () => {
    const previous = parseMarkdownFile('# M1\n\n## A\n\nold\n\n# M2\n\n## B\n\nold', 'LIVE_TEST.md', 1);
    const next = parseMarkdownFile('# M1\n\n## A\n\nnew\n\n# M2\n\n## B\n\nnew', 'LIVE_TEST.md', 2);
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 10, id: 1 });

    expect(summaries['LIVE_TEST.md::M1::0']?.changedHeadingKeys).toEqual(['A']);
    expect(summaries['LIVE_TEST.md::M2::0']?.changedHeadingKeys).toEqual(['B']);
  });
});

describe('node activity state', () => {
  test('updates a changed leaf and its parents while keeping siblings unchanged', () => {
    const previous = parseMarkdownFile('# M\n\n## A\n\n### C\n\nold\n\n### D\n\nsame', 'LIVE_TEST.md', 1);
    const next = parseMarkdownFile('# M\n\n## A\n\n### C\n\nnew\n\n### D\n\nsame', 'LIVE_TEST.md', 2);
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 20, id: 1 });
    const activity = updateFileActivity({
      currentFileActivity: {
        [nodeKey('LIVE_TEST.md::M::0', 'A')]: 10,
        [nodeKey('LIVE_TEST.md::M::0', 'A/C')]: 10,
        [nodeKey('LIVE_TEST.md::M::0', 'A/D')]: 10,
      },
      nextFile: next,
      summaries,
      changedAt: 20,
      initialAt: 5,
    });

    expect(activity?.[nodeKey('LIVE_TEST.md::M::0', 'A')]).toBe(20);
    expect(activity?.[nodeKey('LIVE_TEST.md::M::0', 'A/C')]).toBe(20);
    expect(activity?.[nodeKey('LIVE_TEST.md::M::0', 'A/D')]).toBe(10);
  });

  test('keeps different files isolated and uses the latest consecutive update time', () => {
    const previous = parseMarkdownFile('# M\n\n## A\n\nold', 'A.md', 1);
    const first = parseMarkdownFile('# M\n\n## A\n\nnew', 'A.md', 2);
    const second = parseMarkdownFile('# M\n\n## A\n\nnewer', 'A.md', 3);
    const bFile = parseMarkdownFile('# M\n\n## B\n\nsame', 'B.md', 1);
    const initial = reconcileWorkspaceActivity({ files: {} }, [
      fileState('A.md', { parsedFile: previous, sourceMtimeMs: 5 }),
      fileState('B.md', { parsedFile: bFile, sourceMtimeMs: 6 }),
    ]).activity;
    const firstActivity = updateFileActivity({
      currentFileActivity: initial.files['A.md'],
      nextFile: first,
      summaries: buildModuleUpdateSummaries({ previous, next: first, fileRecovered: false, changedAt: 20, id: 1 }),
      changedAt: 20,
      initialAt: 5,
    });
    const secondActivity = updateFileActivity({
      currentFileActivity: firstActivity,
      nextFile: second,
      summaries: buildModuleUpdateSummaries({ previous: first, next: second, fileRecovered: false, changedAt: 30, id: 2 }),
      changedAt: 30,
      initialAt: 5,
    });

    expect(secondActivity?.[nodeKey('A.md::M::0', 'A')]).toBe(30);
    expect(initial.files['B.md'][nodeKey('B.md::M::0', 'B')]).toBe(6);
  });

  test('persists through local state reload and initializes new files from mtime', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const parsed = parseMarkdownFile('# M\n\n## A\n', 'A.md', 1);
      const activity = reconcileWorkspaceActivity({ files: {} }, [
        fileState('A.md', { parsedFile: parsed, sourceMtimeMs: 123 }),
      ]).activity;
      const service = new LocalStateService(userDataPath);

      await service.setWorkspaceActivityState(tempRoot, activity);
      await service.flush();

      const restored = new LocalStateService(userDataPath);

      await expect(restored.getWorkspaceActivityState(tempRoot)).resolves.toEqual(activity);
      expect(activity.files['A.md'][nodeKey('A.md::M::0', 'A')]).toBe(123);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('cleans removed files and deleted nodes during reconcile', () => {
    const next = parseMarkdownFile('# M\n\n## A\n', 'A.md', 1);
    const activity = reconcileWorkspaceActivity({
      files: {
        'A.md': {
          [nodeKey('A.md::M::0', 'A')]: 10,
          [nodeKey('A.md::M::0', 'Removed')]: 11,
        },
        'Removed.md': {
          [nodeKey('Removed.md::M::0', 'Old')]: 12,
        },
      },
    }, [
      fileState('A.md', { parsedFile: next, sourceMtimeMs: 5 }),
    ]).activity;

    expect(activity.files['A.md']).toEqual({ [nodeKey('A.md::M::0', 'A')]: 10 });
    expect(activity.files['Removed.md']).toBeUndefined();
  });

  test('transient highlight clearing does not remove persisted activity time', async () => {
    const activity = { files: { 'A.md': { [nodeKey('A.md::M::0', 'A')]: 10 } } };
    const transient = new TransientUpdateState(() => undefined, 20);

    transient.markCompleted({ relativePath: 'A.md', phase: 'recentlyUpdated', changedAt: 10, summaries: {} });
    await delay(40);

    expect(transient.getFileUpdateStatuses()['A.md']).toBeUndefined();
    expect(activity.files['A.md'][nodeKey('A.md::M::0', 'A')]).toBe(10);
  });

  test('file activity is the maximum node activity and relative formatting is stable', () => {
    const now = Date.parse('2026-07-04T12:00:00+08:00');

    expect(fileLastActivityAt({ A: 10, B: 20 })).toBe(20);
    expect(formatRelativeActivityTime(now - 20_000, now)).toBe('刚刚');
    expect(formatRelativeActivityTime(now - 8 * 60_000, now)).toBe('8 分钟前');
    expect(formatRelativeActivityTime(now - 3 * 60 * 60_000, now)).toBe('3 小时前');
    expect(formatRelativeActivityTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2 天前');
    expect(formatRelativeActivityTime(Date.parse('2026-06-20T12:00:00+08:00'), now)).toBe('2026-06-20');
  });
});

describe('transient update state', () => {
  test('marks only the updating file and keeps other files idle', () => {
    const state = new TransientUpdateState(() => undefined, 40);

    state.markUpdating({
      relativePath: 'A.md',
      moduleKeys: ['A.md::A::0'],
      id: 1,
      changedAt: 1,
    });

    expect(state.getFileUpdateStatuses()).toMatchObject({
      'A.md': { phase: 'updating' },
    });
    expect(state.getFileUpdateStatuses()['B.md']).toBeUndefined();
  });

  test('keeps A and B updating states independent', () => {
    const state = new TransientUpdateState(() => undefined, 40);

    state.markUpdating({ relativePath: 'A.md', moduleKeys: ['A.md::A::0'], id: 1, changedAt: 1 });
    state.markUpdating({ relativePath: 'B.md', moduleKeys: ['B.md::B::0'], id: 2, changedAt: 2 });

    expect(state.getFileUpdateStatuses()).toMatchObject({
      'A.md': { phase: 'updating' },
      'B.md': { phase: 'updating' },
    });
  });

  test('clears only the completed file after its lifecycle timer', async () => {
    let expired = 0;
    const state = new TransientUpdateState(() => {
      expired += 1;
    }, 30);

    state.markUpdating({ relativePath: 'A.md', moduleKeys: ['A.md::A::0'], id: 1, changedAt: 1 });
    state.markUpdating({ relativePath: 'B.md', moduleKeys: ['B.md::B::0'], id: 2, changedAt: 2 });
    state.markCompleted({
      relativePath: 'A.md',
      phase: 'recentlyUpdated',
      changedAt: 3,
      summaries: {
        'A.md::A::0': {
          id: 3,
          relativePath: 'A.md',
          phase: 'recentlyUpdated',
          changedAt: 3,
          moduleAdded: false,
          leadingBodyChanged: false,
          changedHeadingKeys: [],
          structureChanged: false,
          fileStructureChanged: false,
        },
      },
    });

    expect(state.getFileUpdateStatuses()).toMatchObject({
      'A.md': { phase: 'recentlyUpdated' },
      'B.md': { phase: 'updating' },
    });

    await delay(60);

    expect(expired).toBe(1);
    expect(state.getFileUpdateStatuses()['A.md']).toBeUndefined();
    expect(state.getFileUpdateStatuses()['B.md']).toMatchObject({ phase: 'updating' });
  });

  test('new update start cancels previous recently-updated timer', async () => {
    let expired = 0;
    const state = new TransientUpdateState(() => {
      expired += 1;
    }, 40);

    state.markCompleted({
      relativePath: 'A.md',
      phase: 'recentlyUpdated',
      changedAt: 1,
      summaries: {},
    });
    await delay(15);
    state.markUpdating({ relativePath: 'A.md', moduleKeys: ['A.md::A::0'], id: 2, changedAt: 2 });
    await delay(60);

    expect(expired).toBe(0);
    expect(state.getFileUpdateStatuses()['A.md']).toMatchObject({ phase: 'updating' });
  });

  test('last completion controls the final clear timer for rapid saves', async () => {
    const state = new TransientUpdateState(() => undefined, 40);

    state.markCompleted({ relativePath: 'A.md', phase: 'recentlyUpdated', changedAt: 1, summaries: {} });
    await delay(25);
    state.markCompleted({ relativePath: 'A.md', phase: 'recentlyUpdated', changedAt: 2, summaries: {} });
    await delay(25);
    expect(state.getFileUpdateStatuses()['A.md']).toMatchObject({ phase: 'recentlyUpdated', updatedAt: 2 });
    await delay(30);
    expect(state.getFileUpdateStatuses()['A.md']).toBeUndefined();
  });

  test('same-file module windows receive updates while other-file windows do not', () => {
    const state = new TransientUpdateState(() => undefined, 40);

    state.markUpdating({
      relativePath: 'A.md',
      moduleKeys: ['A.md::A::0', 'A.md::A2::0'],
      id: 1,
      changedAt: 1,
    });

    expect(state.getFileUpdateStatuses()['A.md']?.phase).toBe('updating');
    expect(state.getFileUpdateStatuses()['B.md']).toBeUndefined();
  });

  test('completed highlight summary does not appear in another file window', () => {
    const state = new TransientUpdateState(() => undefined, 40);

    state.markCompleted({
      relativePath: 'A.md',
      phase: 'recentlyUpdated',
      changedAt: 1,
      summaries: {
        'shared-key': {
          id: 1,
          relativePath: 'A.md',
          phase: 'recentlyUpdated',
          changedAt: 1,
          moduleAdded: false,
          leadingBodyChanged: false,
          changedHeadingKeys: ['X'],
          structureChanged: false,
          fileStructureChanged: false,
        },
      },
    });

    expect(state.getFileUpdateStatuses()['A.md']?.phase).toBe('recentlyUpdated');
    expect(state.getFileUpdateStatuses()['B.md']).toBeUndefined();
  });

  test('clearFile removes one managed file transient state without touching others', () => {
    const state = new TransientUpdateState(() => undefined, 40);

    state.markCompleted({
      relativePath: 'A.md',
      phase: 'recentlyUpdated',
      changedAt: 1,
      summaries: {
        'A.md::A::0': {
          id: 1,
          relativePath: 'A.md',
          phase: 'recentlyUpdated',
          changedAt: 1,
          moduleAdded: false,
          leadingBodyChanged: false,
          changedHeadingKeys: ['A'],
          structureChanged: false,
          fileStructureChanged: false,
        },
      },
    });
    state.markCompleted({
      relativePath: 'B.md',
      phase: 'recentlyUpdated',
      changedAt: 2,
      summaries: {
        'B.md::B::0': {
          id: 2,
          relativePath: 'B.md',
          phase: 'recentlyUpdated',
          changedAt: 2,
          moduleAdded: false,
          leadingBodyChanged: false,
          changedHeadingKeys: ['B'],
          structureChanged: false,
          fileStructureChanged: false,
        },
      },
    });

    state.clearFile('A.md');

    expect(state.getFileUpdateStatuses()['A.md']).toBeUndefined();
    expect(state.getFileUpdateStatuses()['B.md']).toMatchObject({ phase: 'recentlyUpdated' });
  });

  test('clearAll removes timers and does not restore transient state after restart', async () => {
    let expired = 0;
    const state = new TransientUpdateState(() => {
      expired += 1;
    }, 30);

    state.markCompleted({ relativePath: 'A.md', phase: 'recentlyUpdated', changedAt: 1, summaries: {} });
    state.clearAll();
    await delay(50);

    expect(expired).toBe(0);
    expect(state.getFileUpdateStatuses()).toEqual({});
    expect(new TransientUpdateState(() => undefined).getFileUpdateStatuses()).toEqual({});
  });
});

describe('marker styles and filtering', () => {
  test('assigns stable automatic colors and keeps same-file marker colors consistent', async () => {
    const currentPath = path.join(tempRoot, 'MARKERS.md');
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# M\n\n## [进行中] A\n\n## [进行中] B\n', 'utf8');
    await session.openWorkspace(tempRoot);

    const styles = await loadStylesConfig(tempRoot);
    const markerStyle = styles.files['MARKERS.md']?.markers['进行中'];

    expect(markerStyle?.autoColor).toMatch(/^#[0-9a-f]{6}$/);

    const data = session.getModuleData('MARKERS.md::M::0');

    expect(data?.markerStats).toEqual([
      {
        name: '进行中',
        count: 2,
        color: markerStyle?.autoColor,
        automaticColor: markerStyle?.autoColor,
      },
    ]);
    expect(data?.markerColors['进行中']).toBe(markerStyle?.autoColor);

    const restored = new WorkspaceSession();
    await restored.openWorkspace(tempRoot);

    expect(restored.getModuleData('MARKERS.md::M::0')?.markerColors['进行中']).toBe(markerStyle?.autoColor);
  });

  test('allows same marker names to have different colors across files', async () => {
    const firstPath = path.join(tempRoot, 'A.md');
    const secondPath = path.join(tempRoot, 'B.md');
    const session = new WorkspaceSession();

    await fs.writeFile(firstPath, '# M\n\n## [P1] A\n', 'utf8');
    await fs.writeFile(secondPath, '# M\n\n## [P1] B\n', 'utf8');
    await session.openWorkspace(tempRoot);
    await session.setMarkerColor('A.md', 'P1', '#123456');

    expect(session.getModuleData('A.md::M::0')?.markerColors.P1).toBe('#123456');
    expect(session.getModuleData('B.md::M::0')?.markerColors.P1).not.toBe('#123456');
  });

  test('restores automatic color and keeps deleted marker mapping', async () => {
    const currentPath = path.join(tempRoot, 'MARKERS.md');
    const session = new WorkspaceSession();

    await fs.writeFile(currentPath, '# M\n\n## [P1] A\n', 'utf8');
    await session.openWorkspace(tempRoot);
    const automaticColor = session.getModuleData('MARKERS.md::M::0')?.markerColors.P1;

    await session.setMarkerColor('MARKERS.md', 'P1', '#abcdef');
    expect(session.getModuleData('MARKERS.md::M::0')?.markerColors.P1).toBe('#abcdef');

    await session.setMarkerColor('MARKERS.md', 'P1', null);
    expect(session.getModuleData('MARKERS.md::M::0')?.markerColors.P1).toBe(automaticColor);

    await fs.writeFile(currentPath, '# M\n\n## A\n', 'utf8');
    await session.refreshManagedFile('MARKERS.md');

    const styles = await loadStylesConfig(tempRoot);
    expect(styles.files['MARKERS.md']?.markers.P1?.autoColor).toBe(automaticColor);
  });

  test('counts current module markers without body brackets or other modules', () => {
    const parsed = parseMarkdownFile(
      '# M1\n\nbody [P1]\n\n## [P1] [P2] A\n\n## B\n\n# M2\n\n## [P1] C\n',
      'MARKERS.md',
      1,
    );
    const styles = setMarkerColorOverride(
      {
        schemaVersion: 1,
        files: {},
      },
      'MARKERS.md',
      'P1',
      '#123456',
    );
    const stats = buildModuleMarkerStats(styles, 'MARKERS.md', parsed.modules[0]);

    expect(stats.map((stat) => [stat.name, stat.count])).toEqual([
      ['P1', 1],
      ['P2', 1],
    ]);
  });

  test('filters matching nodes, required ancestors, and hides unrelated branches', () => {
    const parsed = parseMarkdownFile('# M\n\n## Parent\n\n### [P1] Child\n\n## Other\n', 'MARKERS.md', 1);
    const data = toModuleWindowData('MARKERS.md', parsed.modules[0]);
    const filtered = filterHeadingsByMarker(data.headings, 'P1');

    expect(filtered.map((heading) => heading.title)).toEqual(['Parent']);
    expect(filtered[0].children.map((heading) => heading.title)).toEqual(['Child']);
  });

  test('reports rename or move as old path removed and new path added', async () => {
    const oldPath = path.join(tempRoot, 'OLD.md');
    const newPath = path.join(tempRoot, 'folder', 'NEW.md');
    const fileSetChanges: Array<{ added: string[]; removed: string[] }> = [];
    const session = new WorkspaceSession();

    await fs.writeFile(oldPath, '# Old', 'utf8');
    await session.openWorkspace(tempRoot);

    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined, {
      debounceMs: 60,
      retryDelayMs: 20,
    }, (change) => {
      fileSetChanges.push(change);
    });

    try {
      await watcher.start();
      await fs.mkdir(path.dirname(newPath), { recursive: true });
      await fs.rename(oldPath, newPath);
      await waitFor(() => fileSetChanges.some((change) => change.removed.includes('OLD.md')));
      await waitFor(() => session.getState().files.some((file) => file.path === 'folder/NEW.md'));

      expect(fileSetChanges.flatMap((change) => change.removed)).toContain('OLD.md');
      expect(fileSetChanges.flatMap((change) => change.added)).toContain('folder/NEW.md');
      expect(session.getFileWindowV2InitialPayload('OLD.md')).toBeNull();
      expect(session.getFileWindowV2InitialPayload('folder/NEW.md')?.modules[0].moduleKey).toBe('folder/NEW.md::Old::0');
    } finally {
      await watcher.stop();
    }
  });

  test('does not purge when the same normalized path appears in both removed and added', async () => {
    const notePath = path.join(tempRoot, 'NOTE.md');
    const session = new WorkspaceSession();

    await fs.writeFile(notePath, '# Note', 'utf8');
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('NOTE.md', true);

    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined, {
      debounceMs: 60,
      retryDelayMs: 20,
    }, () => undefined);

    try {
      await watcher.start();

      await fs.writeFile(notePath, '# Updated Note', 'utf8');

      await waitFor(() => {
        const state = session.getState();
        const file = state.files.find((f) => f.path === 'NOTE.md');
        return file?.parsedFile?.modules[0]?.title === 'Updated Note';
      });

      const state = session.getState();
      const file = state.files.find((f) => f.path === 'NOTE.md');

      expect(file).toBeDefined();
      expect(file?.pinned).toBe(true);
    } finally {
      await watcher.stop();
    }
  });

  test('atomic save with same path replacement does not clear file state', async () => {
    const notePath = path.join(tempRoot, 'ATOMIC.md');
    const fileSetChanges: Array<{ added: string[]; removed: string[] }> = [];
    const session = new WorkspaceSession();

    await fs.writeFile(notePath, '# Atomic', 'utf8');
    await session.openWorkspace(tempRoot);
    await session.setFilePinned('ATOMIC.md', true);
    await session.setMarkerColor('ATOMIC.md', 'P1', '#ff0000');

    const watcher = new ManagedFileWatcher(session, () => undefined, () => undefined, {
      debounceMs: 60,
      retryDelayMs: 20,
    }, (change) => {
      fileSetChanges.push(change);
    });

    try {
      await watcher.start();

      await fs.writeFile(notePath, '# Updated Atomic', 'utf8');

      await waitFor(() => {
        const state = session.getState();
        const file = state.files.find((f) => f.path === 'ATOMIC.md');
        return file?.parsedFile?.modules[0]?.title === 'Updated Atomic';
      });

      const state = session.getState();
      const file = state.files.find((f) => f.path === 'ATOMIC.md');

      expect(file).toBeDefined();
      expect(file?.pinned).toBe(true);

      const styles = await loadStylesConfig(tempRoot);
      expect(styles.files['ATOMIC.md']?.markers.P1?.colorOverride).toBe('#ff0000');
    } finally {
      await watcher.stop();
    }
  });
});

describe('file window v2', () => {
  test('reports only non-destroyed file windows as live', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const live = mockFileWindowV2();
    const destroyed = mockFileWindowV2({ destroyed: true });

    registry.set('LIVE.md', live);
    registry.set('DESTROYED.md', destroyed);

    expect(registry.hasLiveWindow('LIVE.md')).toBe(true);
    expect(registry.hasLiveWindow('DESTROYED.md')).toBe(false);
    expect(registry.getLiveRelativePaths()).toEqual(['LIVE.md']);
    expect(registry.get('DESTROYED.md')).toBeUndefined();
  });

  test('uses normalized relativePath as a singleton window identity', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2();

    const normalizedPath = registry.set('docs\\A.md', first);

    expect(normalizedPath).toBe('docs/A.md');
    expect(registry.focusExisting('docs/A.md')).toBe(true);
    expect(first.focusCount).toBe(1);
    expect(registry.entries()).toHaveLength(1);
  });

  test('keeps different file paths in different windows and removes closed windows', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2();
    const second = mockFileWindowV2();

    registry.set('A.md', first);
    registry.set('B.md', second);

    expect(registry.entries().map(([relativePath]) => relativePath)).toEqual(['A.md', 'B.md']);
    expect(registry.delete('A.md', first)).toBe(true);
    expect(registry.get('A.md')).toBeUndefined();
    expect(registry.get('B.md')).toBe(second);
  });

  test('sends file payloads only to the matching live V2 window', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2();
    const second = mockFileWindowV2();

    registry.set('A.md', first);
    registry.set('B.md', second);

    expect(registry.sendFileChanged('A.md', { relativePath: 'A.md' })).toBe(1);
    expect(first.sentPayloads).toEqual([{ channel: 'workboard:file-window-v2-file-changed', payload: { relativePath: 'A.md' } }]);
    expect(second.sentPayloads).toEqual([]);
  });

  test('sends pending-only payloads only to the matching live V2 window', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2();
    const second = mockFileWindowV2();

    registry.set('A.md', first);
    registry.set('B.md', second);

    expect(registry.sendFilePendingUpdates('A.md', { relativePath: 'A.md', modules: {} })).toBe(1);
    expect(first.sentPayloads).toEqual([
      {
        channel: 'workboard:file-window-v2-pending-updates-changed',
        payload: { relativePath: 'A.md', modules: {} },
      },
    ]);
    expect(second.sentPayloads).toEqual([]);
  });

  test('broadcasts pending-only payloads to every live V2 window without file content payloads', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2();
    const second = mockFileWindowV2();

    registry.set('A.md', first);
    registry.set('B.md', second);

    expect(registry.broadcastPendingUpdates((relativePath) => ({ relativePath, modules: {} }))).toBe(2);
    expect(first.sentPayloads).toEqual([
      {
        channel: 'workboard:file-window-v2-pending-updates-changed',
        payload: { relativePath: 'A.md', modules: {} },
      },
    ]);
    expect(second.sentPayloads).toEqual([
      {
        channel: 'workboard:file-window-v2-pending-updates-changed',
        payload: { relativePath: 'B.md', modules: {} },
      },
    ]);
  });

  test('does not send file payloads to destroyed V2 windows', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2({ destroyed: true });

    registry.set('A.md', first);

    expect(registry.sendFileChanged('A.md', { relativePath: 'A.md' })).toBe(0);
    expect(first.sentPayloads).toEqual([]);
    expect(registry.get('A.md')).toBeUndefined();
  });

  test('cleans a destroyed singleton before a later open can create a new window', () => {
    const registry = new FileWindowV2Registry<MockFileWindowV2>();
    const first = mockFileWindowV2({ destroyed: true });

    registry.set('A.md', first);

    expect(registry.focusExisting('A.md')).toBe(false);
    expect(registry.get('A.md')).toBeUndefined();
  });

  test('initial payload includes only target file modules in markdown order', async () => {
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A1\n\n## A child\n\n# A2\n\nBody', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'B.md'), '# B1\n\nBody', 'utf8');
    const session = new WorkspaceSession();

    await session.openWorkspace(tempRoot);
    const payload = session.getFileWindowV2InitialPayload('A.md');

    expect(payload?.relativePath).toBe('A.md');
    expect(payload?.displayName).toBe('A.md');
    expect(payload?.modules.map((module) => module.title)).toEqual(['A1', 'A2']);
    expect(payload?.modules.every((module) => module.filePath === 'A.md')).toBe(true);
    expect(payload?.modules.some((module) => module.moduleKey.startsWith('B.md::'))).toBe(false);
  });

  test('selects the first module by default and switches to matching module content', () => {
    const modules = [
      moduleDataStub('A.md', 'A.md::A::0'),
      { ...moduleDataStub('A.md', 'A.md::B::0'), leadingBodyMarkdown: 'B body' },
    ];

    expect(getInitialFileWindowV2ModuleKey(modules)).toBe('A.md::A::0');
    expect(selectFileWindowV2Module(modules, 'A.md::B::0')?.leadingBodyMarkdown).toBe('B body');
    expect(selectFileWindowV2Module(modules, 'missing')).toBeNull();
  });

  test('keeps active module when the current key still exists after refresh', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('A', 'B', 'C'),
      'B',
      moduleRefs('X', 'B', 'C'),
    )).toBe('B');
  });

  test('selects the same old index when the middle active module is removed', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('A', 'B', 'C'),
      'B',
      moduleRefs('A', 'C'),
    )).toBe('C');
  });

  test('selects the new last module when the last active module is removed', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('A', 'B', 'C'),
      'C',
      moduleRefs('A', 'B'),
    )).toBe('B');
  });

  test('selects the same index when an active H1 rename creates a new module key', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('A', 'B', 'C'),
      'B',
      moduleRefs('A', 'B2', 'C'),
    )).toBe('B2');
  });

  test('keeps the original active module when a new H1 is inserted elsewhere', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('A', 'B'),
      'B',
      moduleRefs('A', 'New', 'B'),
    )).toBe('B');
  });

  test('keeps current H1 active when a new preface document module appears', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('H1-A'),
      'H1-A',
      moduleRefs('::document::0', 'H1-A'),
    )).toBe('H1-A');
  });

  test('falls back to first real H1 when document module is deleted', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('::document::0', 'H1-A'),
      '::document::0',
      moduleRefs('H1-A'),
    )).toBe('H1-A');
  });

  test('falls back to first module when the previous active key cannot be located', () => {
    expect(resolveFileWindowV2ActiveModuleKey(
      moduleRefs('A', 'B'),
      'Missing',
      moduleRefs('C', 'D'),
    )).toBe('C');
  });

  test('returns null when refreshed modules are empty', () => {
    expect(resolveFileWindowV2ActiveModuleKey(moduleRefs('A'), 'A', [])).toBeNull();
  });

  test('restores a persisted active module when it still exists', () => {
    expect(resolvePersistedFileWindowV2ActiveModuleKey(moduleRefs('A', 'B'), 'B', 'A')).toBe('B');
  });

  test('falls back to the calibrated module when persisted active module is missing', () => {
    expect(resolvePersistedFileWindowV2ActiveModuleKey(moduleRefs('A renamed', 'B'), 'A', 'A renamed')).toBe('A renamed');
  });

  test('restores null active module when no modules exist', () => {
    expect(resolvePersistedFileWindowV2ActiveModuleKey([], 'A', 'B')).toBeNull();
  });

  test('refresh payload stays file-scoped and reflects the latest committed file content', async () => {
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A1\n\nOld\n\n# A2\n\nBody', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'B.md'), '# B1\n\nBody', 'utf8');
    const session = new WorkspaceSession();

    await session.openWorkspace(tempRoot);
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A1\n\nFirst\n\n# A2\n\nBody', 'utf8');
    await session.refreshManagedFile('A.md');
    await fs.writeFile(path.join(tempRoot, 'A.md'), '# A1\n\nSecond\n\n# A2 renamed\n\nBody', 'utf8');
    await session.refreshManagedFile('A.md');

    const payload = session.getFileWindowV2InitialPayload('A.md');

    expect(payload?.relativePath).toBe('A.md');
    expect(payload?.modules.map((module) => module.title)).toEqual(['A1', 'A2 renamed']);
    expect(payload?.modules[0].leadingBodyMarkdown).toBe('Second');
    expect(payload?.modules.every((module) => module.filePath === 'A.md')).toBe(true);
    expect(session.getFileWindowV2InitialPayload('B.md')?.modules.map((module) => module.title)).toEqual(['B1']);
  });

  test('accumulates pending updates across files, modules, and headings', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
      'A.md::Two::0': updateSummary('A.md', 'A.md::Two::0', ['h2']),
      'B.md::One::0': updateSummary('B.md', 'B.md::One::0', ['h3']),
    });

    expect(deriveUpdatedFilePaths(pending)).toEqual(['A.md', 'B.md']);
    expect(getFileWindowV2UpdatePayload(pending, 'A.md')?.modules).toEqual({
      'A.md::One::0': pendingModule(['h1']),
      'A.md::Two::0': pendingModule(['h2']),
    });
    expect(getFileWindowV2UpdatePayload(pending, 'B.md')?.modules).toEqual({
      'B.md::One::0': pendingModule(['h3']),
    });
  });

  test('keeps old pending updates when a later save has no diff', () => {
    const first = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
    });
    const second = mergePendingFileUpdates(first, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', []),
    });

    expect(second).toEqual(first);
  });

  test('deduplicates repeated heading updates and preserves later module updates', () => {
    const first = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1', 'h1']),
    });
    const second = mergePendingFileUpdates(first, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h2']),
      'A.md::Two::0': updateSummary('A.md', 'A.md::Two::0', ['h3']),
    });

    expect(getFileWindowV2UpdatePayload(second, 'A.md')?.modules).toEqual({
      'A.md::One::0': pendingModule(['h1', 'h2']),
      'A.md::Two::0': pendingModule(['h3']),
    });
  });

  test('tracks module-level changes without exposing the body sentinel as a heading key', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', [], { leadingBodyChanged: true }),
    });
    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');

    expect(payload?.modules['A.md::One::0']).toEqual(pendingModule([moduleBodyUpdateKey]));
    expect(deriveUpdatedModuleKeys(payload)).toEqual(new Set(['A.md::One::0']));
    expect(deriveChangedHeadingKeys(payload, 'A.md::One::0')).toEqual(new Set());
    expect(hasModuleBodyUpdate(payload, 'A.md::One::0')).toBe(true);
    expect(hasPendingModuleUpdates(payload, 'A.md::One::0')).toBe(true);
    expect(hasPendingFileUpdates(payload)).toBe(true);
  });

  test('clears one pending module while keeping sibling modules and files', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1', 'h2']),
      'A.md::Two::0': updateSummary('A.md', 'A.md::Two::0', ['h3']),
      'B.md::One::0': updateSummary('B.md', 'B.md::One::0', ['h4']),
    });
    const cleared = clearPendingModule(pending, 'A.md', 'A.md::One::0');

    expect(getFileWindowV2UpdatePayload(cleared, 'A.md')?.modules).toEqual({
      'A.md::Two::0': pendingModule(['h3']),
    });
    expect(getFileWindowV2UpdatePayload(cleared, 'B.md')?.modules).toEqual({
      'B.md::One::0': pendingModule(['h4']),
    });
    expect(deriveUpdatedFilePaths(cleared)).toEqual(['A.md', 'B.md']);
    expect(pending['A.md']?.modules['A.md::One::0']).toEqual(pendingModule(['h1', 'h2']));
  });

  test('clears the final pending module and removes the file container', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
    });
    const cleared = clearPendingModule(pending, 'A.md', 'A.md::One::0');

    expect(cleared['A.md']).toBeUndefined();
    expect(getFileWindowV2UpdatePayload(cleared, 'A.md')).toBeUndefined();
  });

  test('clearing a missing module or file is a safe no-op', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
    });

    expect(clearPendingModule(pending, 'A.md', 'missing')).toBe(pending);
    expect(clearPendingModule(pending, 'missing.md', 'A.md::One::0')).toBe(pending);
    expect(clearPendingFile(pending, 'missing.md')).toBe(pending);
  });

  test('clears all pending modules for one file without touching another file', () => {
    const pending = mergePendingFileUpdates({}, {
      'folder/A.md::One::0': updateSummary('folder/A.md', 'folder/A.md::One::0', ['h1']),
      'folder/A.md::Two::0': updateSummary('folder/A.md', 'folder/A.md::Two::0', ['h2']),
      'folder/B.md::One::0': updateSummary('folder/B.md', 'folder/B.md::One::0', ['h3']),
    });
    const cleared = clearPendingFile(pending, 'folder/A.md');

    expect(getFileWindowV2UpdatePayload(cleared, 'folder/A.md')).toBeUndefined();
    expect(getFileWindowV2UpdatePayload(cleared, 'folder/B.md')?.modules).toEqual({
      'folder/B.md::One::0': pendingModule(['h3']),
    });
    expect(deriveUpdatedFolderPaths(deriveUpdatedFilePaths(cleared), ['folder/A.md', 'folder/B.md'])).toEqual(new Set(['folder']));
  });

  test('clearing the last updated file removes launcher folder derivations', () => {
    const pending = mergePendingFileUpdates({}, {
      'folder/A.md::One::0': updateSummary('folder/A.md', 'folder/A.md::One::0', ['h1']),
      'folder/B.md::One::0': updateSummary('folder/B.md', 'folder/B.md::One::0', ['h2']),
    });
    const remaining = clearPendingFile(pending, 'folder/A.md');
    const cleared = clearPendingFile(remaining, 'folder/B.md');

    expect(deriveUpdatedFolderPaths(deriveUpdatedFilePaths(remaining), ['folder/A.md', 'folder/B.md'])).toEqual(new Set(['folder']));
    expect(deriveUpdatedFolderPaths(deriveUpdatedFilePaths(cleared), ['folder/A.md', 'folder/B.md'])).toEqual(new Set());
  });

  test('clears every pending file and prunes empty pending containers', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
      'B.md::One::0': updateSummary('B.md', 'B.md::One::0', ['h2']),
    });

    expect(clearAllPending()).toEqual({});
    expect(clearAllPending()).not.toBe(pending);
    expect(pruneEmptyPendingContainers({
      'A.md': { fileAttention: false, modules: { 'A.md::One::0': { attention: false, changedHeadingKeys: [], structureChanged: false } }, structureChanged: false },
      'B.md': { fileAttention: true, modules: { 'B.md::One::0': pendingModule(['h2']) }, structureChanged: false },
    })).toEqual({
      'B.md': { fileAttention: true, modules: { 'B.md::One::0': pendingModule(['h2']) }, structureChanged: false },
    });
  });

  test('clearing an old module key does not affect a renamed module key', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::Old::0': updateSummary('A.md', 'A.md::Old::0', ['old-heading']),
      'A.md::New::0': updateSummary('A.md', 'A.md::New::0', ['new-heading']),
    });
    const cleared = clearPendingModule(pending, 'A.md', 'A.md::Old::0');

    expect(getFileWindowV2UpdatePayload(cleared, 'A.md')?.modules).toEqual({
      'A.md::New::0': pendingModule(['new-heading']),
    });
  });

  test('prunes deleted modules and headings from pending updates', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['keep', 'remove']),
      'A.md::Two::0': updateSummary('A.md', 'A.md::Two::0', ['gone']),
    });
    const pruned = prunePendingFileUpdatesForPayload(pending, 'A.md', [
      moduleDataStub('A.md', 'A.md::One::0', [headingStub('keep')]),
    ]);

    expect(getFileWindowV2UpdatePayload(pruned, 'A.md')?.modules).toEqual({
      'A.md::One::0': pendingModule(['keep']),
    });
  });

  test('does not migrate pending updates across an H1 rename', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::Old::0': updateSummary('A.md', 'A.md::Old::0', ['old-heading']),
      'A.md::New::0': updateSummary('A.md', 'A.md::New::0', ['new-heading']),
    });
    const pruned = prunePendingFileUpdatesForPayload(pending, 'A.md', [
      moduleDataStub('A.md', 'A.md::New::0', [headingStub('new-heading')]),
    ]);

    expect(getFileWindowV2UpdatePayload(pruned, 'A.md')?.modules).toEqual({
      'A.md::New::0': pendingModule(['new-heading']),
    });
  });

  test('marks heading deletion as module structure without keeping ghost heading keys', () => {
    const previous = parseMarkdownFile('# One\n\n## Keep\n\nText\n\n## Remove\n\nGone', 'A.md');
    const next = parseMarkdownFile('# One\n\n## Keep\n\nText', 'A.md');
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 1, id: 1 });
    const pending = mergePendingFileUpdates({}, summaries);
    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');

    expect(payload).toBeUndefined();
    expect(deriveUpdatedModuleKeys(payload)).toEqual(new Set());
    expect(deriveChangedHeadingKeys(payload, 'A.md::One::0')).toEqual(new Set());
    expect(deriveUpdatedFilePaths(pending)).toEqual([]);
  });

  test('marks H1 deletion at file level without keeping a ghost module', () => {
    const previous = parseMarkdownFile('# Old\n\nText\n\n# Keep\n\nText', 'A.md');
    const next = parseMarkdownFile('# Keep\n\nText', 'A.md');
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 1, id: 1 });
    const pending = mergePendingFileUpdates({}, summaries);
    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');

    expect(payload).toBeUndefined();
    expect(deriveUpdatedModuleKeys(payload)).toEqual(new Set());
    expect(deriveUpdatedFilePaths(pending)).toEqual([]);
  });

  test('treats an H1 rename as old module deletion plus new module structure', () => {
    const previous = parseMarkdownFile('# Old\n\n## Existing\n\nText', 'A.md');
    const next = parseMarkdownFile('# New\n\n## Existing\n\nText', 'A.md');
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 1, id: 1 });
    const pending = mergePendingFileUpdates({
      'A.md': {
        fileAttention: true,
        modules: {
          'A.md::Old::0': pendingModule(['Existing']),
        },
        structureChanged: false,
      },
    }, summaries);
    const pruned = prunePendingFileUpdatesForPayload(pending, 'A.md', [
      moduleDataStub('A.md', 'A.md::New::0', [headingStub('Existing')]),
    ]);
    const payload = getFileWindowV2UpdatePayload(pruned, 'A.md');

    expect(payload?.modules).toEqual({
      'A.md::New::0': pendingModule(['Existing'], true),
    });
    expect(payload?.structureChanged).toBe(true);
    expect(payload?.modules['A.md::Old::0']).toBeUndefined();
  });

  test('derives launcher folder updates only from visible exact paths', () => {
    const updatedFilePaths = ['docs/a/One.md', 'docs/abc/Two.md', 'hidden/Secret.md'];
    const folders = deriveUpdatedFolderPaths(updatedFilePaths, ['docs/a/One.md', 'docs/abc/Two.md']);

    expect(folders).toEqual(new Set(['docs', 'docs/a', 'docs/abc']));
    expect(folders.has('hidden')).toBe(false);
  });

  test('does not match similar file path prefixes for launcher propagation', () => {
    const folders = deriveUpdatedFolderPaths(['docs/a.md'], ['docs/abc.md']);

    expect(folders).toEqual(new Set());
  });

  test('keeps hidden pending files in the file-level index even when launcher folders do not show them', () => {
    const pending = mergePendingFileUpdates({}, {
      'hidden/Secret.md::One::0': updateSummary('hidden/Secret.md', 'hidden/Secret.md::One::0', ['h1']),
    });

    expect(deriveUpdatedFilePaths(pending)).toEqual(['hidden/Secret.md']);
    expect(deriveUpdatedFolderPaths(deriveUpdatedFilePaths(pending), [])).toEqual(new Set());
  });

  test('document module body change produces pending', () => {
    const previous = parseMarkdownFile('preface\n\n# H1', 'A.md');
    const next = parseMarkdownFile('preface updated\n\n# H1', 'A.md');
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 1, id: 1 });
    const pending = mergePendingFileUpdates({}, summaries);

    expect(deriveUpdatedFilePaths(pending)).toEqual(['A.md']);
    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');
    expect(payload?.modules['A.md::document::0']?.changedHeadingKeys).toContain('__module__');
  });

  test('document module nested heading change produces node pending', () => {
    const previous = parseMarkdownFile('## A\n\ntext\n\n# H1', 'A.md');
    const next = parseMarkdownFile('## A\n\nupdated\n\n# H1', 'A.md');
    const summaries = buildModuleUpdateSummaries({ previous, next, fileRecovered: false, changedAt: 1, id: 1 });
    const pending = mergePendingFileUpdates({}, summaries);

    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');
    const changedKeys = payload?.modules['A.md::document::0']?.changedHeadingKeys ?? [];
    expect(changedKeys.includes('A')).toBe(true);
  });

  test('clearPendingModule on document module works', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::document::0': updateSummary('A.md', 'A.md::document::0', ['h1']),
    });
    const cleared = clearPendingModule(pending, 'A.md', 'A.md::document::0');

    expect(cleared['A.md']?.modules['A.md::document::0']).toBeUndefined();
  });

  test('clearPendingFile removes document module pending', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::document::0': updateSummary('A.md', 'A.md::document::0', ['h1']),
    });
    const cleared = clearPendingFile(pending, 'A.md');

    expect(cleared['A.md']).toBeUndefined();
  });
});

describe('local state service', () => {
  test('saves and reloads workspace UI state outside the workspace', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);
      await service.setLastWorkspacePath(tempRoot);
      await service.updateLauncherViewState(tempRoot, { bounds: { x: 1, y: 2, width: 390, height: 720 } });
      await service.updateModuleViewState(tempRoot, 'CURRENT.md::目标::0', {
        bounds: { x: 10, y: 20, width: 470, height: 680 },
        alwaysOnTop: true,
        expandedHeadingKeys: ['A', 'A/B'],
        scrollTop: 240,
      });
      await service.updateFileWindowV2State(tempRoot, 'docs\\A.md', {
        activeModuleKey: 'docs/A.md::Two::0',
        expandedEventIds: ['event-2', 'event-2', 'event-1'],
        scrollTop: 315,
        bounds: { x: 30, y: 40, width: 540, height: 700 },
        alwaysOnTop: true,
        restoreOnLaunch: true,
      });
      await service.flush();

      const restored = new LocalStateService(userDataPath);

      await expect(restored.getLastWorkspacePath()).resolves.toBe(tempRoot);
      await expect(restored.getWorkspaceUiState(tempRoot)).resolves.toMatchObject({
        launcher: { bounds: { x: 1, y: 2, width: 390, height: 720 } },
        modules: {
          'CURRENT.md::目标::0': {
            alwaysOnTop: true,
            expandedHeadingKeys: ['A', 'A/B'],
            scrollTop: 240,
          },
        },
        fileWindowsV2: {
          'docs/A.md': {
            relativePath: 'docs/A.md',
            activeModuleKey: 'docs/A.md::Two::0',
            expandedEventIds: ['event-2', 'event-1'],
            scrollTop: 315,
            bounds: { x: 30, y: 40, width: 540, height: 700 },
            alwaysOnTop: true,
            restoreOnLaunch: true,
          },
        },
      });
      await expect(fs.stat(path.join(tempRoot, '.workboard', 'workboard-session.json'))).rejects.toThrow();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('falls back when local state is corrupt or invalid', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      await fs.writeFile(path.join(userDataPath, 'workboard-session.json'), '{ bad json', 'utf8');

      const service = new LocalStateService(userDataPath);

      await expect(service.getLastWorkspacePath()).resolves.toBeNull();
      await expect(service.getWorkspaceUiState(tempRoot)).resolves.toEqual({
        schemaVersion: 1,
        launcher: {},
        modules: {},
        fileWindowsV2: {},
        pendingFileUpdates: {},
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('sanitizes invalid module state without blocking startup restore', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));
    const statePath = path.join(userDataPath, 'workboard-session.json');

    try {
      await fs.writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          lastWorkspacePath: tempRoot,
          workspaces: {
            [tempRoot]: {
              schemaVersion: 1,
              launcher: { bounds: { x: 1, y: 2, width: 1, height: 1 } },
              modules: {
                bad: {
                  moduleKey: 'bad',
                  alwaysOnTop: 'yes',
                  expandedHeadingKeys: ['A', 1],
                  scrollTop: -10,
                  bounds: { width: 0, height: 0 },
                },
              },
              fileWindowsV2: {
                'docs/A.md': {
                  relativePath: 'docs/A.md',
                  activeModuleKey: 12,
                  alwaysOnTop: 'yes',
                  restoreOnLaunch: true,
                  bounds: { width: 0, height: 0 },
                },
              },
            },
          },
        }),
        'utf8',
      );

      const service = new LocalStateService(userDataPath);
      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.launcher).toEqual({});
      expect(state.modules.bad).toEqual({
        moduleKey: 'bad',
        bounds: undefined,
        alwaysOnTop: false,
        expandedHeadingKeys: ['A'],
        scrollTop: 0,
      });
      expect(state.fileWindowsV2['docs/A.md']).toEqual({
        relativePath: 'docs/A.md',
        activeModuleKey: null,
        bounds: undefined,
        alwaysOnTop: false,
        restoreOnLaunch: true,
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('keeps FileWindowV2 states isolated by file path', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateFileWindowV2State(tempRoot, 'A.md', {
        activeModuleKey: 'A.md::Two::0',
        bounds: { x: 10, y: 20, width: 540, height: 700 },
        alwaysOnTop: true,
        restoreOnLaunch: true,
      });
      await service.updateFileWindowV2State(tempRoot, 'B.md', {
        activeModuleKey: 'B.md::One::0',
        bounds: { x: 60, y: 80, width: 620, height: 760 },
        alwaysOnTop: false,
        restoreOnLaunch: false,
      });

      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.fileWindowsV2['A.md']).toMatchObject({
        activeModuleKey: 'A.md::Two::0',
        alwaysOnTop: true,
        restoreOnLaunch: true,
      });
      expect(state.fileWindowsV2['B.md']).toMatchObject({
        activeModuleKey: 'B.md::One::0',
        alwaysOnTop: false,
        restoreOnLaunch: false,
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('removes one FileWindowV2 state without touching another file', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateFileWindowV2State(tempRoot, 'A.md', { restoreOnLaunch: true });
      await service.updateFileWindowV2State(tempRoot, 'B.md', { restoreOnLaunch: true });
      await service.removeFileWindowV2State(tempRoot, 'A.md');

      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.fileWindowsV2['A.md']).toBeUndefined();
      expect(state.fileWindowsV2['B.md']).toMatchObject({ relativePath: 'B.md', restoreOnLaunch: true });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('persists pending file updates and restores them after restart', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);
      const pending = mergePendingFileUpdates({}, {
        'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
      });

      await service.setPendingFileUpdates(tempRoot, pending);
      await service.flush();

      const restored = new LocalStateService(userDataPath);
      const state = await restored.getWorkspaceUiState(tempRoot);

      expect(state.pendingFileUpdates).toEqual({
        'A.md': {
          fileAttention: true,
          modules: {
            'A.md::One::0': pendingModule(['h1']),
          },
          structureChanged: false,
        },
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('removes one persisted pending file without touching another file', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);
      const pending = mergePendingFileUpdates({}, {
        'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
        'B.md::One::0': updateSummary('B.md', 'B.md::One::0', ['h2']),
      });

      await service.setPendingFileUpdates(tempRoot, pending);
      await service.removePendingFileUpdates(tempRoot, 'A.md');

      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.pendingFileUpdates['A.md']).toBeUndefined();
      expect(state.pendingFileUpdates['B.md']).toEqual({
        fileAttention: true,
        modules: {
          'B.md::One::0': pendingModule(['h2']),
        },
        structureChanged: false,
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('keeps visible bounds and moves completely offscreen bounds into the primary work area', () => {
    const workAreas = [{ x: 0, y: 0, width: 1280, height: 720 }];

    expect(ensureWindowBoundsVisible({ x: 20, y: 30, width: 540, height: 700 }, workAreas)).toEqual({
      x: 20,
      y: 30,
      width: 540,
      height: 700,
    });
    expect(ensureWindowBoundsVisible({ x: 4000, y: 4000, width: 540, height: 900 }, workAreas)).toEqual({
      x: 24,
      y: 24,
      width: 540,
      height: 720,
    });
  });

  test('removes all persisted module states for a managed file', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'docs/A.md::Old::0', { scrollTop: 10 });
      await service.updateModuleViewState(tempRoot, 'docs/A.md::New::0', { scrollTop: 20 });
      await service.updateModuleViewState(tempRoot, 'docs/B.md::Keep::0', { scrollTop: 30 });
      await service.removeModuleViewStatesForFile(tempRoot, 'docs/A.md');
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.modules['docs/A.md::Old::0']).toBeUndefined();
      expect(state.modules['docs/A.md::New::0']).toBeUndefined();
      expect(state.modules['docs/B.md::Keep::0']?.scrollTop).toBe(30);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('keeps concurrent updates for different module keys', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await Promise.all([
        service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 }),
        service.updateModuleViewState(tempRoot, 'B.md::B::0', { scrollTop: 20 }),
      ]);
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.modules['A.md::A::0']?.scrollTop).toBe(10);
      expect(state.modules['B.md::B::0']?.scrollTop).toBe(20);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('keeps the latest value for rapid updates to the same module key', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await Promise.all([
        service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 }),
        service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 40 }),
        service.updateModuleViewState(tempRoot, 'A.md::A::0', { selectedMarker: 'P1' }),
      ]);
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);

      expect(state.modules['A.md::A::0']).toMatchObject({
        scrollTop: 40,
        selectedMarker: 'P1',
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('continues merging updates while a debounced disk write is pending', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await service.updateModuleViewState(tempRoot, 'B.md::B::0', { scrollTop: 20 });
      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { expandedHeadingKeys: ['A'] });
      await service.flush();

      const restored = new LocalStateService(userDataPath);
      const state = await restored.getWorkspaceUiState(tempRoot);

      expect(state.modules['A.md::A::0']).toMatchObject({
        scrollTop: 10,
        expandedHeadingKeys: ['A'],
      });
      expect(state.modules['B.md::B::0']?.scrollTop).toBe(20);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});

describe('payload comparison', () => {
  test('reuses identical module references', () => {
    const a = moduleDataStub('A.md', 'A.md::One::0', [headingStub('h1')]);
    const b = moduleDataStub('A.md', 'A.md::One::0', [headingStub('h1')]);

    expect(modulesContentEqual(a, b)).toBe(true);
  });

  test('does not reuse when heading body changes in top-level heading', () => {
    const a = moduleDataStub('A.md', 'A.md::One::0', [{ ...headingStub('h1'), bodyMarkdown: 'old' }]);
    const b = moduleDataStub('A.md', 'A.md::One::0', [{ ...headingStub('h1'), bodyMarkdown: 'new' }]);

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('does not reuse when nested child heading body changes', () => {
    const deepA = headingStub('child', [{ ...headingStub('grandchild'), bodyMarkdown: 'old' }]);
    const deepB = headingStub('child', [{ ...headingStub('grandchild'), bodyMarkdown: 'new' }]);
    const a = moduleDataStub('A.md', 'A.md::One::0', [deepA]);
    const b = moduleDataStub('A.md', 'A.md::One::0', [deepB]);

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('does not reuse when nested heading title changes with same children count', () => {
    const childA = headingStub('H2', [headingStub('H3a'), headingStub('H3b')]);
    const childB = headingStub('H2-changed', [headingStub('H3a'), headingStub('H3b')]);
    const a = moduleDataStub('A.md', 'A.md::One::0', [childA]);
    const b = moduleDataStub('A.md', 'A.md::One::0', [childB]);

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('does not reuse when marker value changes but count is same', () => {
    const a = moduleDataStub('A.md', 'A.md::One::0', [{ ...headingStub('h1'), markers: ['P1'] }]);
    const b = moduleDataStub('A.md', 'A.md::One::0', [{ ...headingStub('h1'), markers: ['P2'] }]);

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('does not reuse when marker order changes', () => {
    const a = moduleDataStub('A.md', 'A.md::One::0', [{ ...headingStub('h1'), markers: ['P1', 'P2'] }]);
    const b = moduleDataStub('A.md', 'A.md::One::0', [{ ...headingStub('h1'), markers: ['P2', 'P1'] }]);

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('does not reuse when markerColors key color value changes', () => {
    const a: ModuleWindowData = { ...moduleDataStub('A.md', 'A.md::One::0'), markerColors: { P1: '#ff0000' } };
    const b: ModuleWindowData = { ...moduleDataStub('A.md', 'A.md::One::0'), markerColors: { P1: '#00ff00' } };

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('does not reuse when leadingBodyMarkdown changes', () => {
    const a = { ...moduleDataStub('A.md', 'A.md::One::0'), leadingBodyMarkdown: 'old body' };
    const b = { ...moduleDataStub('A.md', 'A.md::One::0'), leadingBodyMarkdown: 'new body' };

    expect(modulesContentEqual(a, b)).toBe(false);
  });

  test('recursively reuses identical references when all fields match', () => {
    const child = headingStub('H2', [headingStub('H3')]);
    const prev = moduleDataStub('A.md', 'A.md::One::0', [child]);
    const next = moduleDataStub('A.md', 'A.md::One::0', [headingStub('H2', [headingStub('H3')])]);

    expect(modulesContentEqual(prev, next)).toBe(true);
  });

  test('markersEqual compares by value and order', () => {
    expect(markersEqual(['P1'], ['P1'])).toBe(true);
    expect(markersEqual(['P1'], ['P2'])).toBe(false);
    expect(markersEqual(['P1', 'P2'], ['P2', 'P1'])).toBe(false);
    expect(markersEqual(['P1'], ['P1', 'P2'])).toBe(false);
    expect(markersEqual([], [])).toBe(true);
  });

  test('markerColorsEqual compares keys and values', () => {
    expect(markerColorsEqual({ P1: '#ff0000' }, { P1: '#ff0000' })).toBe(true);
    expect(markerColorsEqual({ P1: '#ff0000' }, { P1: '#00ff00' })).toBe(false);
    expect(markerColorsEqual({ P1: '#ff0000' }, { P2: '#ff0000' })).toBe(false);
    expect(markerColorsEqual({ P1: '#ff0000', P2: '#00ff00' }, { P1: '#ff0000' })).toBe(false);
    expect(markerColorsEqual({}, {})).toBe(true);
  });

  test('headingNodeContentEqual compares all rendering fields', () => {
    const base = headingStub('h1');
    expect(headingNodeContentEqual(base, headingStub('h1'))).toBe(true);
    expect(headingNodeContentEqual(base, { ...headingStub('h1'), title: 'changed' })).toBe(false);
    expect(headingNodeContentEqual(base, { ...headingStub('h1'), rawTitle: 'changed' })).toBe(false);
    expect(headingNodeContentEqual(base, { ...headingStub('h1'), bodyMarkdown: 'changed' })).toBe(false);
    expect(headingNodeContentEqual(base, { ...headingStub('h1'), depth: 3 })).toBe(false);
    expect(headingNodeContentEqual(base, { ...headingStub('h1'), markers: ['P1'] })).toBe(false);
  });

  test('mergeHeadings returns next when lengths differ', () => {
    const prev: RenderedHeadingNode[] = [headingStub('h1')];
    const next: RenderedHeadingNode[] = [headingStub('h1'), headingStub('h2')];

    expect(mergeHeadings(prev, next)).toBe(next);
  });

  test('mergeHeadings recursively reuses when children are identical', () => {
    const prevChild = headingStub('child');
    const prev: RenderedHeadingNode[] = [{ ...headingStub('h1'), children: [prevChild] }];
    const next: RenderedHeadingNode[] = [{ ...headingStub('h1'), children: [headingStub('child')] }];
    const merged = mergeHeadings(prev, next);

    expect(merged[0].children[0]).toBe(prevChild);
  });
});

describe('file-level structure pending', () => {
  test('ignores file structure changes when there is no visible pending unit', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', [], { fileStructureChanged: true }),
    });

    expect(pending).toEqual({});
    expect(deriveUpdatedFilePaths(pending)).toEqual([]);
    expect(getFileWindowV2UpdatePayload(pending, 'A.md')).toBeUndefined();
  });

  test('deriveUpdatedFilePaths ignores legacy fileAttention-only containers after pruning', () => {
    const pending: Record<string, PendingFileUpdate> = {
      'A.md': { fileAttention: true, modules: {}, structureChanged: true },
    };

    const paths = deriveUpdatedFilePaths(pruneEmptyPendingContainers(pending));
    expect(paths).toEqual([]);
  });

  test('clearPendingFile remains a no-op for ignored structure-only changes', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', [], { fileStructureChanged: true }),
    });
    const cleared = clearPendingFile(pending, 'A.md');

    expect(deriveUpdatedFilePaths(cleared)).toEqual([]);
    expect(cleared['A.md']).toBeUndefined();
  });

  test('structureChanged does not create fake module keys', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', [], { fileStructureChanged: true }),
    });
    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');

    expect(deriveUpdatedModuleKeys(payload).size).toBe(0);
    expect(payload).toBeUndefined();
  });

  test('structureChanged does not create fake heading keys', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', [], { fileStructureChanged: true }),
    });
    const payload = getFileWindowV2UpdatePayload(pending, 'A.md');

    expect(deriveChangedHeadingKeys(payload, 'A.md::One::0').size).toBe(0);
  });

  test('new visible diff reappears after clearing', () => {
    const first = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
    });
    const cleared = clearPendingFile(first, 'A.md');
    const reappeared = mergePendingFileUpdates(cleared, {
      'A.md::Two::0': updateSummary('A.md', 'A.md::Two::0', ['h2']),
    });

    expect(deriveUpdatedFilePaths(reappeared)).toEqual(['A.md']);
    expect(getFileWindowV2UpdatePayload(reappeared, 'A.md')?.modules['A.md::Two::0']).toEqual(pendingModule(['h2']));
  });

  test('launcher folder paths derived from visible pending file', () => {
    const pending = mergePendingFileUpdates({}, {
      'folder/A.md::One::0': updateSummary('folder/A.md', 'folder/A.md::One::0', ['h1']),
    });
    const filePaths = deriveUpdatedFilePaths(pending);
    const folderPaths = deriveUpdatedFolderPaths(filePaths, ['folder/A.md', 'folder/B.md']);

    expect(folderPaths.has('folder')).toBe(true);
  });

  test('clearing visible pending file removes launcher folder hints', () => {
    const pending = mergePendingFileUpdates({}, {
      'folder/A.md::One::0': updateSummary('folder/A.md', 'folder/A.md::One::0', ['h1']),
    });
    const cleared = clearPendingFile(pending, 'folder/A.md');
    const filePaths = deriveUpdatedFilePaths(cleared);
    const folderPaths = deriveUpdatedFolderPaths(filePaths, ['folder/A.md', 'folder/B.md']);

    expect(folderPaths.size).toBe(0);
  });

  test('open file windows keep content updates without relighting launcher attention', () => {
    const merged = mergeFileUpdateSummaries({
      current: {},
      relativePath: 'A.md',
      summaries: {
        'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
      },
      fileWindowOpen: true,
    });

    expect(deriveUpdatedFilePaths(merged)).toEqual([]);
    expect(deriveUpdatedModuleKeys(getFileWindowV2UpdatePayload(merged, 'A.md'))).toEqual(new Set(['A.md::One::0']));
    expect(deriveChangedHeadingKeys(getFileWindowV2UpdatePayload(merged, 'A.md'), 'A.md::One::0')).toEqual(new Set(['h1']));
  });

  test('clearFileAttention only clears file-level attention', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1', 'h2']),
    });
    const cleared = clearFileAttention(pending, 'A.md');

    expect(cleared['A.md'].fileAttention).toBe(false);
    expect(cleared['A.md'].modules['A.md::One::0'].attention).toBe(true);
    expect(cleared['A.md'].modules['A.md::One::0'].changedHeadingKeys).toEqual(['h1', 'h2']);
    expect(deriveUpdatedFilePaths(cleared)).toEqual([]);
  });

  test('clearModuleAttention is ignored by derived module highlights', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1', 'h2']),
    });
    const cleared = clearModuleAttention(pending, 'A.md', 'A.md::One::0');

    expect(cleared['A.md'].fileAttention).toBe(true);
    expect(cleared['A.md'].modules['A.md::One::0'].attention).toBe(true);
    expect(cleared['A.md'].modules['A.md::One::0'].changedHeadingKeys).toEqual(['h1', 'h2']);
    expect(deriveUpdatedModuleKeys(getFileWindowV2UpdatePayload(cleared, 'A.md'))).toEqual(new Set(['A.md::One::0']));
  });

  test('clearModuleAttention does not affect other modules', () => {
    const pending = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
      'A.md::Two::0': updateSummary('A.md', 'A.md::Two::0', ['h2']),
    });
    const cleared = clearModuleAttention(pending, 'A.md', 'A.md::One::0');

    expect(cleared['A.md'].modules['A.md::One::0'].attention).toBe(true);
    expect(cleared['A.md'].modules['A.md::Two::0'].attention).toBe(true);
  });

  test('clearFileAttention then new diff re-lights file attention', () => {
    const first = mergePendingFileUpdates({}, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h1']),
    });
    const cleared = clearFileAttention(first, 'A.md');
    expect(deriveUpdatedFilePaths(cleared)).toEqual([]);

    const reappeared = mergePendingFileUpdates(cleared, {
      'A.md::One::0': updateSummary('A.md', 'A.md::One::0', ['h2']),
    });
    expect(reappeared['A.md'].fileAttention).toBe(true);
    expect(deriveUpdatedFilePaths(reappeared)).toEqual(['A.md']);
  });
});

describe('local state concurrency', () => {
  test('second mutation sees first mutation in memory before write completes', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const writes: string[] = [];
      const originalWriteFile = fs.writeFile as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const [filePath] = args;
        writes.push(path.basename(filePath as string));
        await delay(50);
        await originalWriteFile(...args);
      });

      const service = new LocalStateService(userDataPath);

      const firstPromise = service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await delay(10);
      const secondPromise = service.updateModuleViewState(tempRoot, 'A.md::A::0', { alwaysOnTop: true });
      await Promise.all([firstPromise, secondPromise]);
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);
      expect(state.modules['A.md::A::0']).toMatchObject({
        scrollTop: 10,
        alwaysOnTop: true,
      });

      vi.restoreAllMocks();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('two mutations to different fields both appear in final disk state', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { selectedMarker: 'P1' });
      await service.flush();

      const restored = new LocalStateService(userDataPath);
      const state = await restored.getWorkspaceUiState(tempRoot);

      expect(state.modules['A.md::A::0']).toMatchObject({
        scrollTop: 10,
        selectedMarker: 'P1',
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('debounced writes are serialized', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const writeOrder: number[] = [];
      let writeCount = 0;
      const originalWriteFile = fs.writeFile as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        writeCount++;
        writeOrder.push(writeCount);
        await delay(10);
        await originalWriteFile(...args);
      });

      const service = new LocalStateService(userDataPath);

      void service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 1 });
      void service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 2 });
      void service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 3 });
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);
      expect(state.modules['A.md::A::0']?.scrollTop).toBe(3);

      vi.restoreAllMocks();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('older snapshot does not overwrite newer snapshot on disk', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const writeContents: unknown[] = [];
      const originalWriteFile = fs.writeFile as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const [, data] = args;
        writeContents.push(JSON.parse(data as string));
        await delay(10);
        await originalWriteFile(...args);
      });

      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 20 });
      await service.flush();

      const lastWrite = writeContents[writeContents.length - 1] as Record<string, unknown>;
      const workspaces = lastWrite.workspaces as Record<string, Record<string, unknown>>;
      const ws = workspaces[tempRoot];
      const modules = ws?.modules as Record<string, Record<string, unknown>>;
      expect(modules?.['A.md::A::0']?.scrollTop).toBe(20);

      vi.restoreAllMocks();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('flush waits for in-progress write', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      let writeResolve: (() => void) | null = null;
      const originalWriteFile = fs.writeFile as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const [filePath] = args;
        if (!String(filePath).startsWith(userDataPath)) {
          await originalWriteFile(...args);
          return;
        }

        await new Promise<void>((resolve) => {
          writeResolve = resolve;
        });
        await originalWriteFile(...args);
      });

      const service = new LocalStateService(userDataPath);
      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });

      const flushPromise = service.flush();
      await delay(20);

      expect(writeResolve).not.toBeNull();
      writeResolve!();
      await flushPromise;

      vi.restoreAllMocks();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('flush writes the latest pending state', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 20 });
      await service.flush();

      const restored = new LocalStateService(userDataPath);
      const state = await restored.getWorkspaceUiState(tempRoot);

      expect(state.modules['A.md::A::0']?.scrollTop).toBe(20);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('no late timer write after flush', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const writeSnapshots: number[] = [];
      const originalWriteFile = fs.writeFile as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const [, data] = args;
        const parsed = JSON.parse(data as string);
        const ws = (parsed.workspaces as Record<string, Record<string, unknown>>)?.[tempRoot];
        const mod = (ws?.modules as Record<string, Record<string, unknown>>)?.['A.md::A::0'];
        if (mod) {
          writeSnapshots.push(mod.scrollTop as number);
        }
        await originalWriteFile(...args);
      });

      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await service.flush();
      await delay(300);

      const lastValue = writeSnapshots[writeSnapshots.length - 1];
      expect(lastValue).toBe(10);

      vi.restoreAllMocks();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('purge does not resurrect from queued old snapshot', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateFileWindowV2State(tempRoot, 'A.md', { restoreOnLaunch: true });
      await service.removeFileWindowV2State(tempRoot, 'A.md');
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);
      expect(state.fileWindowsV2['A.md']).toBeUndefined();

      const restored = new LocalStateService(userDataPath);
      const restoredState = await restored.getWorkspaceUiState(tempRoot);
      expect(restoredState.fileWindowsV2['A.md']).toBeUndefined();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('two workspaces keep isolated states', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));
    const workspaceB = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-ws2-'));

    try {
      const service = new LocalStateService(userDataPath);

      await service.updateFileWindowV2State(tempRoot, 'A.md', { restoreOnLaunch: true });
      await service.updateFileWindowV2State(workspaceB, 'A.md', { restoreOnLaunch: false });
      await service.flush();

      const stateA = await service.getWorkspaceUiState(tempRoot);
      const stateB = await service.getWorkspaceUiState(workspaceB);

      expect(stateA.fileWindowsV2['A.md']?.restoreOnLaunch).toBe(true);
      expect(stateB.fileWindowsV2['A.md']?.restoreOnLaunch).toBe(false);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
      await fs.rm(workspaceB, { recursive: true, force: true });
    }
  });

  test('single write failure does not permanently block queue', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-user-data-'));

    try {
      let callCount = 0;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const originalWriteFile = fs.writeFile as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('simulated write failure');
        }
        await originalWriteFile(...args);
      });

      const service = new LocalStateService(userDataPath);

      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 10 });
      await service.flush();
      await service.updateModuleViewState(tempRoot, 'A.md::A::0', { scrollTop: 20 });
      await service.flush();

      const state = await service.getWorkspaceUiState(tempRoot);
      expect(state.modules['A.md::A::0']?.scrollTop).toBe(20);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) {
      return;
    }

    await delay(25);
  }

  throw new Error('Timed out waiting for condition.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type MockFileWindowV2 = {
  webContents: {
    send: (channel: string, payload: unknown) => void;
  };
  destroyed: boolean;
  minimized: boolean;
  focusCount: number;
  showCount: number;
  restoreCount: number;
  sentPayloads: Array<{ channel: string; payload: unknown }>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
};

function mockFileWindowV2(overrides: Partial<Pick<MockFileWindowV2, 'destroyed' | 'minimized'>> = {}): MockFileWindowV2 {
  const window: MockFileWindowV2 = {
    webContents: {
      send(channel, payload) {
        window.sentPayloads.push({ channel, payload });
      },
    },
    destroyed: overrides.destroyed ?? false,
    minimized: overrides.minimized ?? false,
    focusCount: 0,
    showCount: 0,
    restoreCount: 0,
    sentPayloads: [],
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    restore() {
      this.restoreCount += 1;
      this.minimized = false;
    },
    show() {
      this.showCount += 1;
    },
    focus() {
      this.focusCount += 1;
    },
  };

  return window;
}

function moduleRefs(...moduleKeys: string[]): Array<{ moduleKey: string }> {
  return moduleKeys.map((moduleKey) => ({ moduleKey }));
}

function moduleDataStub(filePath: string, moduleKey: string, headings: RenderedHeadingNode[] = []): ModuleWindowData {
  return {
    moduleKey,
    filePath,
    fileStatus: 'available',
    title: moduleKey,
    rawTitle: moduleKey,
    titleMarkers: [],
    markerColors: {},
    markerStats: [],
    leadingBodyMarkdown: '',
    headings,
  };
}

function headingStub(viewKey: string, children: RenderedHeadingNode[] = []): RenderedHeadingNode {
  return {
    viewKey,
    headingKey: viewKey,
    nodeKey: viewKey,
    depth: 2,
    rawTitle: viewKey,
    title: viewKey,
    markers: [],
    bodyMarkdown: '',
    bodyPreview: '',
    children,
    source: {},
  };
}

function pendingModule(changedHeadingKeys: string[], structureChanged = false) {
  return {
    attention: true,
    changedHeadingKeys,
    structureChanged,
  };
}

function updateSummary(
  relativePath: string,
  moduleKey: string,
  changedHeadingKeys: string[],
  overrides: Partial<ModuleUpdateSummary> = {},
): ModuleUpdateSummary {
  return {
    id: 1,
    relativePath,
    phase: 'recentlyUpdated',
    changedAt: 1,
    moduleAdded: false,
    leadingBodyChanged: false,
    changedHeadingKeys,
    structureChanged: false,
    fileStructureChanged: false,
    ...overrides,
  };
}

function fileState(pathValue: string, overrides: Partial<ManagedFileState> = {}): ManagedFileState {
  return {
    path: pathValue,
    order: 0,
    source: 'repository',
    pinned: false,
    hidden: false,
    status: 'available',
    ...overrides,
  };
}

function nodeKey(moduleKey: string, viewKey: string): string {
  return `${moduleKey}@@${viewKey}`;
}

type ControlledRefresh = {
  timing?: ManagedFileRefreshTiming;
  resolve: (result: ManagedFileRefreshResult) => void;
};

function controlledRefreshSession(
  getEntries: () => Array<{ relativePath: string; absolutePath: string }>,
  refreshes: ControlledRefresh[],
): WorkspaceSession & { getCommittedTitle: () => string | undefined } {
  let committedTitle: string | undefined;

  return {
    getManagedFileWatchEntries: getEntries,
    refreshManagedFile: async (_relativePath: string, timing?: ManagedFileRefreshTiming) => {
      const result = await new Promise<ManagedFileRefreshResult>((resolve) => {
        refreshes.push({ timing, resolve });
      });

      if (timing?.shouldCommit?.() === false) {
        return null;
      }

      committedTitle = result.next.parsedFile?.modules[0]?.title;

      return result;
    },
    getCommittedTitle: () => committedTitle,
  } as unknown as WorkspaceSession & { getCommittedTitle: () => string | undefined };
}

function availableRefresh(relativePath: string, markdown: string): ManagedFileRefreshResult {
  return {
    next: {
      path: relativePath,
      order: 0,
      source: 'repository',
      pinned: false,
      hidden: false,
      status: 'available',
      parsedFile: parseMarkdownFile(markdown, relativePath),
    },
  };
}
