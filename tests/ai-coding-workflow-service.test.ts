import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AiCodingWorkflowService } from '../src/main/services/ai-coding-workflow-service';
import {
  aiCodingWorkflowDefaultFilePaths,
  assertAiCodingWorkflowDefaultPackage,
  locateAiCodingWorkflowDefaultPackage,
} from '../src/main/services/ai-coding-workflow-defaults';

let tempRoot: string;
let userDataPath: string;
let workspacePath: string;
let service: AiCodingWorkflowService;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-ai-flow-'));
  userDataPath = path.join(tempRoot, 'userData');
  workspacePath = path.join(tempRoot, 'repo');
  service = new AiCodingWorkflowService(userDataPath);

  await fs.mkdir(workspacePath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('AI coding workflow package', () => {
  test('initializes the user workflow package on first use', async () => {
    const state = await service.getState();

    expect(state.packagePath).toBe(path.join(userDataPath, 'workflow', 'ai-coding'));
    expect(state.files.map((file) => file.path)).toEqual(aiCodingWorkflowDefaultFilePaths);
  });

  test('does not overwrite user edits on restart', async () => {
    const agentsSectionPath = path.join(service.getPackagePath(), 'AGENTS.workboard-section.md');

    await service.getState();
    await fs.writeFile(agentsSectionPath, 'custom user rules', 'utf8');

    const restarted = new AiCodingWorkflowService(userDataPath);
    await restarted.getState();

    await expect(fs.readFile(agentsSectionPath, 'utf8')).resolves.toBe('custom user rules');
  });

  test('ships complete Chinese and English packages with matching file names', async () => {
    const chinesePath = await locateAiCodingWorkflowDefaultPackage('workboard', 'zh-CN');
    const englishPath = await locateAiCodingWorkflowDefaultPackage('workboard', 'en');

    await expect(assertAiCodingWorkflowDefaultPackage(chinesePath)).resolves.toBeUndefined();
    await expect(assertAiCodingWorkflowDefaultPackage(englishPath)).resolves.toBeUndefined();

    const chineseFiles = await relativeFiles(chinesePath);
    const englishFiles = await relativeFiles(englishPath);

    expect(chineseFiles).toEqual(aiCodingWorkflowDefaultFilePaths);
    expect(englishFiles).toEqual(aiCodingWorkflowDefaultFilePaths);
    const bundled = await service.getBundledPackages();
    expect(bundled[0]).toMatchObject({ id: 'workboard', locales: ['zh-CN', 'en'] });
    expect(bundled[0]).toMatchObject({ updateAvailable: false, hasLocalChanges: false });
    expect(bundled[0].filesByLocale['zh-CN']?.map((file) => file.path)).toEqual(aiCodingWorkflowDefaultFilePaths);
    expect(bundled[0].filesByLocale.en?.map((file) => file.path)).toEqual(aiCodingWorkflowDefaultFilePaths);
  });

  test('applies and retains edits made directly in the built-in workflow folder', async () => {
    await service.getPackageCatalog();
    const bundledRoot = await service.getBundledPackageRootPath('workboard');
    const editableTemplate = path.join(bundledRoot, 'zh-CN', '.workboard', 'templates', 'current.md');
    await service.applyBundledToWorkspace(workspacePath, 'workboard', 'zh-CN');
    const repositoryTemplate = path.join(workspacePath, '.workboard', 'templates', 'current.md');
    await expect(fs.readFile(repositoryTemplate, 'utf8')).resolves.toContain('## [目标]');

    const englishPlan = await service.createBundledApplyPlan(workspacePath, 'workboard', 'en');
    expect(englishPlan.overwrite).toContain('.workboard/templates/current.md');
    await expect(service.applyBundledToWorkspace(workspacePath, 'workboard', 'en')).rejects.toThrow('overwrite');
    await expect(fs.readFile(repositoryTemplate, 'utf8')).resolves.toContain('## [目标]');

    await service.applyBundledToWorkspace(workspacePath, 'workboard', 'en', true);
    await expect(fs.readFile(repositoryTemplate, 'utf8')).resolves.toContain('## [Goal]');

    await fs.writeFile(editableTemplate, '## [Edited built-in]\n', 'utf8');
    await service.applyBundledToWorkspace(workspacePath, 'workboard', 'zh-CN', true);
    await expect(fs.readFile(repositoryTemplate, 'utf8')).resolves.toBe('## [Edited built-in]\n');

    const restarted = new AiCodingWorkflowService(userDataPath);
    await restarted.getPackageCatalog();
    await expect(fs.readFile(editableTemplate, 'utf8')).resolves.toBe('## [Edited built-in]\n');
  });

  test('restores the editable built-in workflow from the packaged backup', async () => {
    await service.getPackageCatalog();
    const bundledRoot = await service.getBundledPackageRootPath('workboard');
    const editableTemplate = path.join(bundledRoot, 'zh-CN', '.workboard', 'templates', 'current.md');
    const extraFile = path.join(bundledRoot, 'zh-CN', 'extra.md');

    await fs.writeFile(editableTemplate, 'custom built-in template', 'utf8');
    await fs.writeFile(extraFile, 'remove on restore', 'utf8');
    const restored = await service.restoreBundledPackage('workboard');

    expect(restored.bundled[0].filesByLocale['zh-CN']?.map((file) => file.path)).toEqual(aiCodingWorkflowDefaultFilePaths);
    expect(restored.bundled[0]).toMatchObject({ updateAvailable: false, hasLocalChanges: false });
    await expect(fs.readFile(editableTemplate, 'utf8')).resolves.toContain('## [目标]');
    await expect(fs.stat(extraFile)).rejects.toThrow();
  });

  test('imports files and preserves selected folder structure', async () => {
    const sourceRoot = path.join(tempRoot, 'import');
    const nested = path.join(sourceRoot, 'custom', 'notes.md');

    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'custom verify', 'utf8');

    const result = await service.importPaths([sourceRoot], sourceRoot);

    expect(result.imported).toEqual(['custom/notes.md']);
    await expect(fs.readFile(path.join(service.getPackagePath(), 'custom', 'notes.md'), 'utf8')).resolves.toBe(
      'custom verify',
    );
  });

  test('rejects import paths outside the selected directory', async () => {
    const sourceRoot = path.join(tempRoot, 'import');
    const outsideRoot = path.join(tempRoot, 'outside');
    const outsideFile = path.join(outsideRoot, 'escape.md');

    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(outsideFile, 'escape', 'utf8');

    await expect(service.importPaths([outsideFile], sourceRoot)).rejects.toThrow('outside the selected source directory');
  });

  test('requires confirmation before overwriting same-name package files', async () => {
    const sourceFile = path.join(tempRoot, 'AGENTS.workboard-section.md');

    await service.getState();
    await fs.writeFile(sourceFile, 'replacement', 'utf8');

    await expect(service.importPaths([sourceFile])).rejects.toThrow('overwrite');

    const result = await service.importPaths([sourceFile], undefined, true);

    expect(result.overwritten).toEqual(['AGENTS.workboard-section.md']);
    await expect(fs.readFile(path.join(service.getPackagePath(), 'AGENTS.workboard-section.md'), 'utf8')).resolves.toBe(
      'replacement',
    );
  });

  test('adds and replaces the managed AGENTS section while preserving project content', async () => {
    await service.getState();
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), '# Project Rules\n\nKeep this.\n', 'utf8');

    const first = await service.applyToWorkspace(workspacePath);
    const firstAgents = await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');

    expect(first.agentsSectionAction).toBe('append');
    expect(firstAgents).toContain('# Project Rules');
    expect(firstAgents).toContain('<!-- workboard-ai-coding:start -->');

    await fs.writeFile(path.join(service.getPackagePath(), 'AGENTS.workboard-section.md'), 'changed rules', 'utf8');
    const second = await service.applyToWorkspace(workspacePath);
    const secondAgents = await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');

    expect(second.agentsSectionAction).toBe('replace');
    expect(secondAgents).toContain('# Project Rules');
    expect(secondAgents).toContain('changed rules');
    expect(countOccurrences(secondAgents, '<!-- workboard-ai-coding:start -->')).toBe(1);
  });

  test('creates AGENTS.md when missing and repeated apply does not duplicate the section', async () => {
    await service.applyToWorkspace(workspacePath);
    await service.applyToWorkspace(workspacePath);

    const agents = await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');

    expect(agents).toContain('<!-- workboard-ai-coding:start -->');
    expect(countOccurrences(agents, '<!-- workboard-ai-coding:start -->')).toBe(1);
  });

  test('creates, skips same, and requires confirmation for ordinary files', async () => {
    await service.applyToWorkspace(workspacePath);
    let plan = await service.createApplyPlan(workspacePath);

    expect(plan.same).toContain('.workboard/PROTOCOL.md');

    await fs.writeFile(path.join(workspacePath, '.workboard', 'PROTOCOL.md'), 'repo custom protocol', 'utf8');
    plan = await service.createApplyPlan(workspacePath);

    expect(plan.overwrite).toContain('.workboard/PROTOCOL.md');
    await expect(service.applyToWorkspace(workspacePath)).rejects.toThrow('overwrite');

    await service.applyToWorkspace(workspacePath, true);
    await expect(fs.readFile(path.join(workspacePath, '.workboard', 'PROTOCOL.md'), 'utf8')).resolves.not.toBe(
      'repo custom protocol',
    );
  });

  test('does not create real work documents or modify managed files', async () => {
    const configPath = path.join(workspacePath, '.workboard', 'workspace.json');
    const packageConfigPath = path.join(service.getPackagePath(), '.workboard', 'workspace.json');

    await service.getState();
    await fs.writeFile(packageConfigPath, '{"schemaVersion":1,"managedFiles":[]}\n', 'utf8');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{"schemaVersion":1,"managedFiles":[{"path":"docs/CURRENT.x.md","order":0,"moduleOrder":[]}]}\n', 'utf8');

    const before = await fs.readFile(configPath, 'utf8');
    await service.applyToWorkspace(workspacePath, true);

    await expect(fs.stat(path.join(workspacePath, 'CURRENT.ai-coding.md'))).rejects.toThrow();
    await expect(fs.stat(path.join(workspacePath, 'PROJECT-STATUS.md'))).rejects.toThrow();
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
  });

  test('lists the permanent built-in package and newly created user packages', async () => {
    const initialCatalog = await service.getPackageCatalog();

    expect(initialCatalog.bundled[0]).toMatchObject({ id: 'workboard', locales: ['zh-CN', 'en'] });
    expect(initialCatalog.user).toEqual([]);

    const created = await service.createUserPackage('My workflow');
    const catalog = await service.getPackageCatalog();

    expect(created.name).toBe('My workflow');
    expect(created.files).toEqual([]);
    expect(catalog.user).toEqual([created]);
    await expect(fs.stat(created.packagePath)).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(created.packagePath, 'workflow-package.json'), 'utf8')).resolves.toContain(
      '"name": "My workflow"',
    );
    await expect(fs.readFile(path.join(created.packagePath, 'workflow-package.json'), 'utf8')).resolves.toContain(
      '"schemaVersion": 2',
    );
  });

  test('creates a user package from a folder and applies later external edits', async () => {
    const sourceRoot = await locateAiCodingWorkflowDefaultPackage('workboard', 'en');
    const imported = await service.importFolderAsUserPackage(sourceRoot, 'Imported workflow');
    const importedTemplate = path.join(imported.packagePath, '.workboard', 'templates', 'current.md');

    expect(imported.files.map((file) => file.path)).toEqual(aiCodingWorkflowDefaultFilePaths);
    await fs.writeFile(importedTemplate, '## [Externally edited]\n', 'utf8');

    const plan = await service.createUserPackageApplyPlan(workspacePath, imported.id);
    expect(plan.create).toContain('.workboard/templates/current.md');

    await service.applyUserPackageToWorkspace(workspacePath, imported.id);
    await expect(fs.readFile(path.join(workspacePath, '.workboard', 'templates', 'current.md'), 'utf8')).resolves.toBe(
      '## [Externally edited]\n',
    );
  });

  test('reads existing language-based user packages as a single custom package', async () => {
    const packageId = 'user-11111111-1111-1111-1111-111111111111';
    const packageRoot = path.join(userDataPath, 'workflow', 'packages', packageId);
    const contentRoot = path.join(packageRoot, 'en');
    const sourceRoot = await locateAiCodingWorkflowDefaultPackage('workboard', 'en');

    await fs.mkdir(packageRoot, { recursive: true });
    await fs.cp(sourceRoot, contentRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'workflow-package.json'), JSON.stringify({
      schemaVersion: 1,
      id: packageId,
      name: 'Legacy custom package',
      locales: ['en'],
    }), 'utf8');

    const catalog = await service.getPackageCatalog();
    const legacyPackage = catalog.user.find((entry) => entry.id === packageId);

    expect(legacyPackage).toMatchObject({ name: 'Legacy custom package' });
    expect(legacyPackage?.files.map((file) => file.path)).toEqual(aiCodingWorkflowDefaultFilePaths);
    await service.applyUserPackageToWorkspace(workspacePath, packageId);
    await expect(fs.readFile(path.join(workspacePath, '.workboard', 'templates', 'current.md'), 'utf8')).resolves.toContain(
      '## [Goal]',
    );
  });

  test('deletes user packages without affecting the built-in package', async () => {
    const created = await service.createUserPackage('Disposable');

    await service.deleteUserPackage(created.id);

    await expect(fs.stat(created.packagePath)).rejects.toThrow();
    const catalog = await service.getPackageCatalog();
    expect(catalog.bundled[0]).toMatchObject({ id: 'workboard', locales: ['zh-CN', 'en'] });
    expect(catalog.user).toEqual([]);
  });

  test('uses a customized legacy singleton as the initial editable Chinese built-in package', async () => {
    await service.getState();
    const legacySectionPath = path.join(service.getPackagePath(), 'AGENTS.workboard-section.md');
    await fs.writeFile(legacySectionPath, 'custom legacy rules', 'utf8');

    const firstCatalog = await service.getPackageCatalog();
    const secondCatalog = await new AiCodingWorkflowService(userDataPath).getPackageCatalog();

    const bundledRoot = await service.getBundledPackageRootPath('workboard');

    expect(firstCatalog.user).toEqual([]);
    expect(secondCatalog.user).toEqual([]);
    expect(firstCatalog.bundled[0]).toMatchObject({ updateAvailable: true, hasLocalChanges: true });
    expect(secondCatalog.bundled[0]).toMatchObject({ updateAvailable: true, hasLocalChanges: true });
    await expect(fs.readFile(legacySectionPath, 'utf8')).resolves.toBe('custom legacy rules');
    await expect(
      fs.readFile(path.join(bundledRoot, 'zh-CN', 'AGENTS.workboard-section.md'), 'utf8'),
    ).resolves.toBe('custom legacy rules');
  });

  test('uses an untouched legacy default as the initial editable built-in package', async () => {
    await service.getState();

    const catalog = await service.getPackageCatalog();
    expect(catalog.bundled[0]).toMatchObject({ id: 'workboard', locales: ['zh-CN', 'en'] });
    expect(catalog.user).toEqual([]);
  });

  test('detects a changed bundled source and backs up local edits before an explicit update', async () => {
    const sourceRoot = await locateAiCodingWorkflowDefaultPackage('workboard', 'zh-CN');
    const mutableDefaultRoot = path.join(tempRoot, 'mutable-default-zh-CN');
    const mutableService = new AiCodingWorkflowService(userDataPath, mutableDefaultRoot, '0.1.2');

    await fs.cp(sourceRoot, mutableDefaultRoot, { recursive: true });
    let catalog = await mutableService.getPackageCatalog();
    expect(catalog.bundled[0]).toMatchObject({ updateAvailable: false, hasLocalChanges: false });

    const packagedTemplate = path.join(mutableDefaultRoot, '.workboard', 'templates', 'current.md');
    await fs.writeFile(packagedTemplate, '## [New bundled version]\n', 'utf8');
    catalog = await mutableService.getPackageCatalog();
    expect(catalog.bundled[0]).toMatchObject({ updateAvailable: true, hasLocalChanges: false });

    const bundledRoot = await mutableService.getBundledPackageRootPath('workboard');
    const editableSection = path.join(bundledRoot, 'zh-CN', 'AGENTS.workboard-section.md');
    await fs.writeFile(editableSection, 'local edits to preserve', 'utf8');
    catalog = await mutableService.getPackageCatalog();
    expect(catalog.bundled[0]).toMatchObject({ updateAvailable: true, hasLocalChanges: true });

    const result = await mutableService.updateBundledPackage('workboard');
    expect(result.backupPath).toBeTruthy();
    await expect(fs.readFile(path.join(result.backupPath!, 'zh-CN', 'AGENTS.workboard-section.md'), 'utf8')).resolves.toBe(
      'local edits to preserve',
    );
    await expect(fs.readFile(path.join(bundledRoot, 'zh-CN', '.workboard', 'templates', 'current.md'), 'utf8')).resolves.toBe(
      '## [New bundled version]\n',
    );
    expect(result.catalog.bundled[0]).toMatchObject({ updateAvailable: false, hasLocalChanges: false });

    const baseline = JSON.parse(await fs.readFile(path.join(userDataPath, 'workflow', 'bundled-state.json'), 'utf8')) as {
      packages: Record<string, { sourceVersion: string }>;
    };
    expect(baseline.packages.workboard.sourceVersion).toBe('0.1.2');
  });
});

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }

  return count;
}

async function relativeFiles(rootPath: string, currentPath = rootPath): Promise<string[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const childPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      return relativeFiles(rootPath, childPath);
    }

    return entry.isFile() ? [path.relative(rootPath, childPath).replaceAll('\\', '/')] : [];
  }));

  return files.flat().sort((left, right) => {
    const leftIndex = (aiCodingWorkflowDefaultFilePaths as readonly string[]).indexOf(left);
    const rightIndex = (aiCodingWorkflowDefaultFilePaths as readonly string[]).indexOf(right);

    return leftIndex - rightIndex;
  });
}
