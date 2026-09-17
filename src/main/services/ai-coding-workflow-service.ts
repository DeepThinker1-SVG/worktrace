import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type {
  AgentsSectionAction,
  BundledWorkflowPackage,
  BundledWorkflowPackageUpdateResult,
  WorkflowApplyPlan,
  WorkflowApplyResult,
  WorkflowImportResult,
  WorkflowPackageFile,
  WorkflowPackageCatalog,
  WorkflowPackageLocale,
  WorkflowPackageState,
  UserWorkflowPackage,
} from '../../shared/workflow';
import { isWorkflowPackageLocale } from '../../shared/workflow';
import {
  aiCodingWorkflowPackages,
  aiCodingWorkflowDefaultFilePaths,
  assertAiCodingWorkflowDefaultPackage,
  locateAiCodingWorkflowDefaultPackage,
} from './ai-coding-workflow-defaults';
import { atomicWriteJson } from './config-service';
import { isInsidePath, toConfigRelativePath } from './workspace-paths';

const legacyPackageRelativePath = path.join('workflow', 'ai-coding');
const userPackagesRelativePath = path.join('workflow', 'packages');
const bundledPackagesRelativePath = path.join('workflow', 'bundled');
const bundledPackageStateRelativePath = path.join('workflow', 'bundled-state.json');
const bundledPackageBackupsRelativePath = path.join('workflow', 'backups');
const userPackageManifestName = 'workflow-package.json';
const agentsStartMarker = '<!-- workboard-ai-coding:start -->';
const agentsEndMarker = '<!-- workboard-ai-coding:end -->';

type CopyPlanEntry = {
  sourcePath: string;
  relativePath: string;
  exists: boolean;
};

type ApplyEntry = {
  packageRelativePath: string;
  workspaceRelativePath: string;
};

type LegacyUserWorkflowPackageManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  locales: WorkflowPackageLocale[];
};

type UserWorkflowPackageManifest = {
  schemaVersion: 2;
  id: string;
  name: string;
};

type AnyUserWorkflowPackageManifest = LegacyUserWorkflowPackageManifest | UserWorkflowPackageManifest;

type PackageFileHashes = Record<string, string>;

type BundledPackageSnapshot = Partial<Record<WorkflowPackageLocale, PackageFileHashes>>;

type BundledPackageBaseline = {
  sourceVersion: string;
  filesByLocale: BundledPackageSnapshot;
};

type BundledPackageBaselineState = {
  schemaVersion: 1;
  packages: Record<string, BundledPackageBaseline>;
};

export class AiCodingWorkflowService {
  private readonly packagePath: string;
  private readonly userPackagesPath: string;
  private readonly bundledPackagesPath: string;
  private readonly bundledPackageStatePath: string;
  private readonly bundledPackageBackupsPath: string;
  private readonly defaultPackagePathPromise: Promise<string>;

  constructor(
    private readonly userDataPath: string,
    defaultPackagePath?: string,
    private readonly sourceVersion = 'unknown',
  ) {
    this.packagePath = path.join(userDataPath, legacyPackageRelativePath);
    this.userPackagesPath = path.join(userDataPath, userPackagesRelativePath);
    this.bundledPackagesPath = path.join(userDataPath, bundledPackagesRelativePath);
    this.bundledPackageStatePath = path.join(userDataPath, bundledPackageStateRelativePath);
    this.bundledPackageBackupsPath = path.join(userDataPath, bundledPackageBackupsRelativePath);
    this.defaultPackagePathPromise = defaultPackagePath
      ? Promise.resolve(defaultPackagePath)
      : locateAiCodingWorkflowDefaultPackage();
  }

  getPackagePath(): string {
    return this.packagePath;
  }

  async ensurePackageLibraryInitialized(): Promise<void> {
    await fs.mkdir(this.userPackagesPath, { recursive: true });
    await fs.mkdir(this.bundledPackagesPath, { recursive: true });

    const legacyFiles = await listSourceFiles(this.packagePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });

    for (const workflowPackage of aiCodingWorkflowPackages) {
      for (const locale of workflowPackage.locales) {
        const targetPath = this.resolveBundledPackageLocalePath(workflowPackage.id, locale);
        const currentFiles = await listSourceFiles(targetPath).catch((error: unknown) => {
          if (isNodeError(error) && error.code === 'ENOENT') {
            return [];
          }

          throw error;
        });

        if (currentFiles.length > 0) {
          continue;
        }

        const sourcePath = locale === 'zh-CN' && legacyFiles.length > 0
          ? this.packagePath
          : await this.getBundledDefaultPackagePath(workflowPackage.id, locale);

        await fs.mkdir(targetPath, { recursive: true });
        await copyPackageFiles(sourcePath, targetPath);
      }
    }

    await this.initializeMatchingBundledBaselines();
  }

  async getPackageCatalog(): Promise<WorkflowPackageCatalog> {
    await this.ensurePackageLibraryInitialized();

    return {
      bundled: await this.getBundledPackages(),
      user: await this.listUserPackages(),
    };
  }

  async createUserPackage(name: string): Promise<UserWorkflowPackage> {
    return this.createUserPackageFromSource(name);
  }

  async importFolderAsUserPackage(
    sourceRoot: string,
    name: string,
  ): Promise<UserWorkflowPackage> {
    const resolvedSource = path.resolve(sourceRoot);
    const stat = await fs.stat(resolvedSource);

    if (!stat.isDirectory()) {
      throw new Error('Workflow package source must be a directory.');
    }

    return this.createUserPackageFromSource(name, resolvedSource);
  }

  async deleteUserPackage(packageId: string): Promise<void> {
    await this.ensurePackageLibraryInitialized();
    const packagePath = await this.resolveExistingUserPackagePath(packageId);

    await fs.rm(packagePath, { recursive: true, force: true });
  }

  async getUserPackagePath(packageId: string): Promise<string> {
    await this.ensurePackageLibraryInitialized();

    return this.resolveExistingUserPackagePath(packageId);
  }

  async getBundledPackageRootPath(packageId: string): Promise<string> {
    await this.ensurePackageLibraryInitialized();
    this.getBundledPackageDefinition(packageId);

    return path.join(this.bundledPackagesPath, packageId);
  }

  async restoreBundledPackage(packageId: string): Promise<WorkflowPackageCatalog> {
    await this.replaceBundledPackageFromDefaults(packageId);

    return this.getPackageCatalog();
  }

  async updateBundledPackage(packageId: string): Promise<BundledWorkflowPackageUpdateResult> {
    const workflowPackage = this.getBundledPackageDefinition(packageId);
    await this.ensurePackageLibraryInitialized();
    const status = await this.getBundledPackageStatus(workflowPackage);

    if (!status.updateAvailable) {
      return { catalog: await this.getPackageCatalog() };
    }

    const backupPath = status.hasLocalChanges
      ? await this.backupBundledPackage(packageId)
      : undefined;

    await this.replaceBundledPackageFromDefaults(packageId);

    return {
      catalog: await this.getPackageCatalog(),
      ...(backupPath ? { backupPath } : {}),
    };
  }

  async getState(): Promise<WorkflowPackageState> {
    await this.ensureInitialized();

    return {
      packagePath: this.packagePath,
      files: await listFiles(this.packagePath),
    };
  }

  async ensureInitialized(): Promise<void> {
    const entries = await fs.readdir(this.packagePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (entries && entries.length > 0) {
      return;
    }

    await this.writeDefaultPackage();
  }

  async restoreDefaultPackage(): Promise<WorkflowPackageState> {
    await fs.rm(this.packagePath, { recursive: true, force: true });
    await this.writeDefaultPackage();

    return this.getState();
  }

  async planImport(sourcePaths: string[], sourceRoot?: string): Promise<CopyPlanEntry[]> {
    await this.ensureInitialized();

    const entries: CopyPlanEntry[] = [];
    const root = sourceRoot ? path.resolve(sourceRoot) : undefined;

    for (const sourcePath of sourcePaths) {
      const resolvedSource = path.resolve(sourcePath);
      const stat = await fs.stat(resolvedSource);

      if (stat.isDirectory()) {
        const folderRoot = root ?? resolvedSource;
        const children = await listSourceFiles(resolvedSource);

        for (const child of children) {
          entries.push(await this.toImportPlanEntry(child, folderRoot));
        }
      } else if (stat.isFile()) {
        entries.push(await this.toImportPlanEntry(resolvedSource, root ?? path.dirname(resolvedSource)));
      }
    }

    return entries;
  }

  async importPaths(sourcePaths: string[], sourceRoot?: string, overwrite = false): Promise<WorkflowImportResult> {
    const plan = await this.planImport(sourcePaths, sourceRoot);
    const conflicts = plan.filter((entry) => entry.exists);

    if (conflicts.length > 0 && !overwrite) {
      throw new Error('Import would overwrite existing workflow package files.');
    }

    const imported: string[] = [];
    const overwritten: string[] = [];

    for (const entry of plan) {
      const targetPath = this.resolvePackagePath(entry.relativePath);

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(entry.sourcePath, targetPath);
      imported.push(entry.relativePath);

      if (entry.exists) {
        overwritten.push(entry.relativePath);
      }
    }

    return {
      state: await this.getState(),
      imported,
      overwritten,
    };
  }

  async getBundledPackages(): Promise<BundledWorkflowPackage[]> {
    await this.ensurePackageLibraryInitialized();

    return Promise.all(aiCodingWorkflowPackages.map(async (workflowPackage) => {
      const filesByLocale: BundledWorkflowPackage['filesByLocale'] = {};

      for (const locale of workflowPackage.locales) {
        filesByLocale[locale] = await listFiles(await this.getBundledPackagePath(workflowPackage.id, locale));
      }

      const status = await this.getBundledPackageStatus(workflowPackage);

      return {
        ...workflowPackage,
        locales: [...workflowPackage.locales],
        filesByLocale,
        ...status,
      };
    }));
  }

  async createApplyPlan(workspacePath: string): Promise<WorkflowApplyPlan> {
    await this.ensureInitialized();

    return this.createApplyPlanFromPackage(workspacePath, this.packagePath);
  }

  async createBundledApplyPlan(
    workspacePath: string,
    packageId: string,
    locale: WorkflowPackageLocale,
  ): Promise<WorkflowApplyPlan> {
    const sourceRoot = await this.getBundledPackagePath(packageId, locale);

    return this.createApplyPlanFromPackage(workspacePath, sourceRoot);
  }

  async applyToWorkspace(workspacePath: string, allowOverwrite = false): Promise<WorkflowApplyResult> {
    await this.ensureInitialized();

    return this.applyPackageToWorkspace(workspacePath, this.packagePath, allowOverwrite);
  }

  async applyBundledToWorkspace(
    workspacePath: string,
    packageId: string,
    locale: WorkflowPackageLocale,
    allowOverwrite = false,
  ): Promise<WorkflowApplyResult> {
    const sourceRoot = await this.getBundledPackagePath(packageId, locale);

    return this.applyPackageToWorkspace(workspacePath, sourceRoot, allowOverwrite);
  }

  async createUserPackageApplyPlan(
    workspacePath: string,
    packageId: string,
  ): Promise<WorkflowApplyPlan> {
    const sourceRoot = await this.getUserPackageContentPath(packageId);

    return this.createApplyPlanFromPackage(workspacePath, sourceRoot);
  }

  async applyUserPackageToWorkspace(
    workspacePath: string,
    packageId: string,
    allowOverwrite = false,
  ): Promise<WorkflowApplyResult> {
    const sourceRoot = await this.getUserPackageContentPath(packageId);

    return this.applyPackageToWorkspace(workspacePath, sourceRoot, allowOverwrite);
  }

  private async createApplyPlanFromPackage(workspacePath: string, sourceRoot: string): Promise<WorkflowApplyPlan> {
    const workspaceRoot = path.resolve(workspacePath);
    const create: string[] = [];
    const overwrite: string[] = [];
    const same: string[] = [];
    const agentsSectionAction = await this.planAgentsAction(workspaceRoot, sourceRoot);

    for (const entry of await this.getApplyEntries(sourceRoot)) {
      const sourcePath = resolveSourcePackagePath(sourceRoot, entry.packageRelativePath);
      const targetPath = resolveWorkspaceTarget(workspaceRoot, entry.workspaceRelativePath);
      const sourceContent = await fs.readFile(sourcePath);
      const targetContent = await fs.readFile(targetPath).catch((error: unknown) => {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });

      if (targetContent === null) {
        create.push(entry.workspaceRelativePath);
      } else if (sourceContent.equals(targetContent)) {
        same.push(entry.workspaceRelativePath);
      } else {
        overwrite.push(entry.workspaceRelativePath);
      }
    }

    return {
      workspacePath: workspaceRoot,
      agentsSectionAction,
      create: create.sort(),
      overwrite: overwrite.sort(),
      same: same.sort(),
    };
  }

  private async applyPackageToWorkspace(
    workspacePath: string,
    sourceRoot: string,
    allowOverwrite: boolean,
  ): Promise<WorkflowApplyResult> {
    const plan = await this.createApplyPlanFromPackage(workspacePath, sourceRoot);

    if (plan.overwrite.length > 0 && !allowOverwrite) {
      throw new Error('Applying the workflow package would overwrite existing repository files.');
    }

    await this.applyAgentsSection(plan.workspacePath, sourceRoot);

    for (const entry of await this.getApplyEntries(sourceRoot)) {
      const sourcePath = resolveSourcePackagePath(sourceRoot, entry.packageRelativePath);
      const targetPath = resolveWorkspaceTarget(plan.workspacePath, entry.workspaceRelativePath);
      const sourceContent = await fs.readFile(sourcePath);
      const targetContent = await fs.readFile(targetPath).catch((error: unknown) => {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });

      if (targetContent !== null && sourceContent.equals(targetContent)) {
        continue;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }

    return plan;
  }

  private async writeDefaultPackage(): Promise<void> {
    const defaultPackagePath = await this.defaultPackagePathPromise;

    await assertAiCodingWorkflowDefaultPackage(defaultPackagePath);
    await fs.mkdir(this.packagePath, { recursive: true });

    for (const sourcePath of await listSourceFiles(defaultPackagePath)) {
      const relativePath = toConfigRelativePath(defaultPackagePath, sourcePath);
      const targetPath = this.resolvePackagePath(relativePath);

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }

  private async getBundledPackagePath(packageId: string, locale: WorkflowPackageLocale): Promise<string> {
    await this.ensurePackageLibraryInitialized();
    const workflowPackage = this.getBundledPackageDefinition(packageId);

    if (!workflowPackage.locales.includes(locale)) {
      throw new Error(`Bundled workflow package language is unavailable: ${locale}`);
    }

    return this.resolveBundledPackageLocalePath(packageId, locale);
  }

  private async initializeMatchingBundledBaselines(): Promise<void> {
    const state = await this.readBundledPackageBaselineState();
    let changed = false;

    for (const workflowPackage of aiCodingWorkflowPackages) {
      if (state.packages[workflowPackage.id]) {
        continue;
      }

      const [workingSnapshot, sourceSnapshot] = await Promise.all([
        this.createWorkingPackageSnapshot(workflowPackage),
        this.createDefaultPackageSnapshot(workflowPackage),
      ]);

      if (!packageSnapshotsEqual(workingSnapshot, sourceSnapshot)) {
        continue;
      }

      state.packages[workflowPackage.id] = {
        sourceVersion: this.sourceVersion,
        filesByLocale: sourceSnapshot,
      };
      changed = true;
    }

    if (changed) {
      await atomicWriteJson(this.bundledPackageStatePath, state);
    }
  }

  private async getBundledPackageStatus(
    workflowPackage: (typeof aiCodingWorkflowPackages)[number],
  ): Promise<Pick<BundledWorkflowPackage, 'updateAvailable' | 'hasLocalChanges'>> {
    const state = await this.readBundledPackageBaselineState();
    const baseline = state.packages[workflowPackage.id];
    const [workingSnapshot, sourceSnapshot] = await Promise.all([
      this.createWorkingPackageSnapshot(workflowPackage),
      this.createDefaultPackageSnapshot(workflowPackage),
    ]);

    if (!baseline) {
      const differsFromSource = !packageSnapshotsEqual(workingSnapshot, sourceSnapshot);

      return {
        updateAvailable: differsFromSource,
        hasLocalChanges: differsFromSource,
      };
    }

    return {
      updateAvailable: !packageSnapshotsEqual(baseline.filesByLocale, sourceSnapshot),
      hasLocalChanges: !packageSnapshotsEqual(baseline.filesByLocale, workingSnapshot),
    };
  }

  private async createDefaultPackageSnapshot(
    workflowPackage: (typeof aiCodingWorkflowPackages)[number],
  ): Promise<BundledPackageSnapshot> {
    const snapshot: BundledPackageSnapshot = {};

    for (const locale of workflowPackage.locales) {
      snapshot[locale] = await hashPackageFiles(await this.getBundledDefaultPackagePath(workflowPackage.id, locale));
    }

    return snapshot;
  }

  private async createWorkingPackageSnapshot(
    workflowPackage: (typeof aiCodingWorkflowPackages)[number],
  ): Promise<BundledPackageSnapshot> {
    const snapshot: BundledPackageSnapshot = {};

    for (const locale of workflowPackage.locales) {
      snapshot[locale] = await hashPackageFiles(this.resolveBundledPackageLocalePath(workflowPackage.id, locale));
    }

    return snapshot;
  }

  private async replaceBundledPackageFromDefaults(packageId: string): Promise<void> {
    const workflowPackage = this.getBundledPackageDefinition(packageId);
    const packageRoot = path.join(this.bundledPackagesPath, packageId);

    await fs.rm(packageRoot, { recursive: true, force: true });

    for (const locale of workflowPackage.locales) {
      const sourcePath = await this.getBundledDefaultPackagePath(packageId, locale);
      const targetPath = this.resolveBundledPackageLocalePath(packageId, locale);

      await fs.mkdir(targetPath, { recursive: true });
      await copyPackageFiles(sourcePath, targetPath);
    }

    const state = await this.readBundledPackageBaselineState();
    state.packages[packageId] = {
      sourceVersion: this.sourceVersion,
      filesByLocale: await this.createDefaultPackageSnapshot(workflowPackage),
    };
    await atomicWriteJson(this.bundledPackageStatePath, state);
  }

  private async backupBundledPackage(packageId: string): Promise<string> {
    const packageRoot = path.join(this.bundledPackagesPath, packageId);
    const backupName = `${packageId}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
    const backupPath = path.join(this.bundledPackageBackupsPath, backupName);

    await fs.mkdir(this.bundledPackageBackupsPath, { recursive: true });
    await fs.cp(packageRoot, backupPath, { recursive: true });

    return backupPath;
  }

  private async readBundledPackageBaselineState(): Promise<BundledPackageBaselineState> {
    const raw = await fs.readFile(this.bundledPackageStatePath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (raw === null) {
      return defaultBundledPackageBaselineState();
    }

    try {
      return validateBundledPackageBaselineState(JSON.parse(raw));
    } catch {
      return defaultBundledPackageBaselineState();
    }
  }

  private async getBundledDefaultPackagePath(packageId: string, locale: WorkflowPackageLocale): Promise<string> {
    const packagePath = packageId === 'workboard' && locale === 'zh-CN'
      ? await this.defaultPackagePathPromise
      : await locateAiCodingWorkflowDefaultPackage(packageId, locale);

    await assertAiCodingWorkflowDefaultPackage(packagePath);

    return packagePath;
  }

  private getBundledPackageDefinition(
    packageId: string,
  ): Omit<BundledWorkflowPackage, 'filesByLocale' | 'updateAvailable' | 'hasLocalChanges'> {
    const workflowPackage = aiCodingWorkflowPackages.find((entry) => entry.id === packageId);

    if (!workflowPackage) {
      throw new Error(`Bundled workflow package is unavailable: ${packageId}`);
    }

    return workflowPackage;
  }

  private resolveBundledPackageLocalePath(packageId: string, locale: WorkflowPackageLocale): string {
    return path.join(this.bundledPackagesPath, packageId, locale);
  }

  private async listUserPackages(): Promise<UserWorkflowPackage[]> {
    const entries = await fs.readdir(this.userPackagesPath, { withFileTypes: true });
    const packages = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const packagePath = path.join(this.userPackagesPath, entry.name);
        const manifest = await readUserPackageManifest(packagePath).catch(() => null);

        if (!manifest || manifest.id !== entry.name) {
          return null;
        }

        return this.toUserWorkflowPackage(manifest, packagePath);
      }));

    return packages
      .filter((workflowPackage): workflowPackage is UserWorkflowPackage => workflowPackage !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async createUserPackageFromSource(
    name: string,
    sourceRoot?: string,
  ): Promise<UserWorkflowPackage> {
    await fs.mkdir(this.userPackagesPath, { recursive: true });

    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error('Workflow package name is required.');
    }

    const id = `user-${randomUUID()}`;
    const packagePath = path.join(this.userPackagesPath, id);
    const temporaryPath = path.join(this.userPackagesPath, `.${id}.tmp`);
    const manifest: UserWorkflowPackageManifest = {
      schemaVersion: 2,
      id,
      name: normalizedName,
    };

    try {
      await fs.mkdir(temporaryPath, { recursive: true });

      if (sourceRoot) {
        await copyPackageFiles(sourceRoot, temporaryPath);
      }

      await fs.writeFile(
        path.join(temporaryPath, userPackageManifestName),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      await fs.rename(temporaryPath, packagePath);
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }

    return this.toUserWorkflowPackage(manifest, packagePath);
  }

  private async toUserWorkflowPackage(
    manifest: AnyUserWorkflowPackageManifest,
    packagePath: string,
  ): Promise<UserWorkflowPackage> {
    const contentPath = resolveUserPackageContentPath(manifest, packagePath);
    const files = (await listFiles(contentPath)).filter((file) => file.path !== userPackageManifestName);

    return {
      id: manifest.id,
      name: manifest.name,
      packagePath,
      files,
    };
  }

  private async resolveExistingUserPackagePath(packageId: string): Promise<string> {
    if (!/^user-[0-9a-f-]+$/i.test(packageId)) {
      throw new Error('Invalid user workflow package id.');
    }

    const packagePath = path.resolve(this.userPackagesPath, packageId);

    if (!isInsidePath(this.userPackagesPath, packagePath)) {
      throw new Error('User workflow package path escapes the package library.');
    }

    const manifest = await readUserPackageManifest(packagePath);

    if (manifest.id !== packageId) {
      throw new Error('User workflow package manifest id does not match its directory.');
    }

    return packagePath;
  }

  private async getUserPackageContentPath(packageId: string): Promise<string> {
    const packagePath = await this.resolveExistingUserPackagePath(packageId);
    const manifest = await readUserPackageManifest(packagePath);
    const contentPath = resolveUserPackageContentPath(manifest, packagePath);
    const stat = await fs.stat(contentPath);

    if (!stat.isDirectory()) {
      throw new Error('User workflow package content directory is missing.');
    }

    return contentPath;
  }

  private async toImportPlanEntry(sourcePath: string, sourceRoot: string): Promise<CopyPlanEntry> {
    const sourceReal = await fs.realpath(sourcePath);
    const rootReal = await fs.realpath(sourceRoot);

    if (!isInsidePath(rootReal, sourceReal)) {
      throw new Error('Imported file is outside the selected source directory.');
    }

    const relativePath = toConfigRelativePath(rootReal, sourceReal);
    const targetPath = this.resolvePackagePath(relativePath);
    const exists = await fs.stat(targetPath).then((stat) => stat.isFile()).catch(() => false);

    return {
      sourcePath: sourceReal,
      relativePath,
      exists,
    };
  }

  private resolvePackagePath(relativePath: string): string {
    return resolveSourcePackagePath(this.packagePath, relativePath);
  }

  private async getApplyEntries(sourceRoot: string): Promise<ApplyEntry[]> {
    const files = await listFiles(sourceRoot);

    return files
      .map((file): ApplyEntry | null => {
        if (file.path === 'AGENTS.workboard-section.md') {
          return null;
        }

        if (file.path.startsWith('.agents/')) {
          return {
            packageRelativePath: file.path,
            workspaceRelativePath: file.path,
          };
        }

        if (file.path.startsWith('.workboard/')) {
          if (file.path === '.workboard/workspace.json') {
            return null;
          }

          return {
            packageRelativePath: file.path,
            workspaceRelativePath: file.path,
          };
        }

        return null;
      })
      .filter((entry): entry is ApplyEntry => entry !== null);
  }

  private async planAgentsAction(workspacePath: string, sourceRoot: string): Promise<AgentsSectionAction> {
    const sectionContent = await this.readManagedAgentsSection(sourceRoot);
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    const current = await fs.readFile(agentsPath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (current === null) {
      return 'create';
    }

    const existing = replaceManagedSection(current, sectionContent);

    if (existing.changed) {
      return existing.hadSection ? 'replace' : 'append';
    }

    return 'unchanged';
  }

  private async applyAgentsSection(workspacePath: string, sourceRoot: string): Promise<void> {
    const sectionContent = await this.readManagedAgentsSection(sourceRoot);
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    const current = await fs.readFile(agentsPath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return '';
      }

      throw error;
    });
    const next = replaceManagedSection(current, sectionContent).content;

    if (next === current) {
      return;
    }

    await fs.writeFile(agentsPath, next, 'utf8');
  }

  private async readManagedAgentsSection(sourceRoot: string): Promise<string> {
    const content = await fs.readFile(resolveSourcePackagePath(sourceRoot, 'AGENTS.workboard-section.md'), 'utf8');

    return `${agentsStartMarker}\n${content.trimEnd()}\n${agentsEndMarker}`;
  }
}

async function listFiles(rootPath: string): Promise<WorkflowPackageFile[]> {
  const sourceFiles = await listSourceFiles(rootPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });
  const files = await Promise.all(
    sourceFiles.map(async (filePath) => {
      const stat = await fs.stat(filePath);

      return {
        path: toConfigRelativePath(rootPath, filePath),
        size: stat.size,
        updatedAt: stat.mtimeMs,
      };
    }),
  );

  return files.sort((left, right) => fixedFileOrder(left.path) - fixedFileOrder(right.path) || left.path.localeCompare(right.path));
}

async function listSourceFiles(rootPath: string): Promise<string[]> {
  const stat = await fs.stat(rootPath);

  if (stat.isFile()) {
    return [rootPath];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const childPath = path.join(rootPath, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(childPath);
      }

      if (entry.isFile()) {
        return Promise.resolve([childPath]);
      }

      return Promise.resolve([]);
    }),
  );

  return files.flat();
}

function fixedFileOrder(relativePath: string): number {
  const index = (aiCodingWorkflowDefaultFilePaths as readonly string[]).indexOf(relativePath);

  return index === -1 ? aiCodingWorkflowDefaultFilePaths.length : index;
}

function replaceManagedSection(
  current: string,
  sectionContent: string,
): { content: string; changed: boolean; hadSection: boolean } {
  const start = current.indexOf(agentsStartMarker);
  const end = current.indexOf(agentsEndMarker);

  if (start !== -1 && end !== -1 && end > start) {
    const endAfterMarker = end + agentsEndMarker.length;
    const content = `${current.slice(0, start).trimEnd()}\n\n${sectionContent}\n\n${current.slice(endAfterMarker).trimStart()}`.trimEnd() + '\n';

    return {
      content,
      changed: content !== current,
      hadSection: true,
    };
  }

  const content = current.trim().length > 0
    ? `${current.trimEnd()}\n\n${sectionContent}\n`
    : `${sectionContent}\n`;

  return {
    content,
    changed: content !== current,
    hadSection: false,
  };
}

function resolveWorkspaceTarget(workspacePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error('Workflow target path must be relative.');
  }

  const resolved = path.resolve(workspacePath, relativePath);

  if (!isInsidePath(workspacePath, resolved)) {
    throw new Error('Workflow target path escapes the workspace directory.');
  }

  return resolved;
}

function resolveSourcePackagePath(packagePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error('Workflow package path must be relative.');
  }

  const resolved = path.resolve(packagePath, relativePath);

  if (!isInsidePath(packagePath, resolved)) {
    throw new Error('Workflow package path escapes the package directory.');
  }

  return resolved;
}

function normalizeLocales(locales: WorkflowPackageLocale[]): WorkflowPackageLocale[] {
  const normalized = [...new Set(locales)];

  if (normalized.length === 0 || normalized.some((locale) => !isWorkflowPackageLocale(locale))) {
    throw new Error('At least one valid workflow package language is required.');
  }

  return normalized;
}

async function readUserPackageManifest(packagePath: string): Promise<AnyUserWorkflowPackageManifest> {
  const raw = await fs.readFile(path.join(packagePath, userPackageManifestName), 'utf8');
  const parsed = JSON.parse(raw) as {
    schemaVersion?: unknown;
    id?: unknown;
    name?: unknown;
    locales?: unknown;
  };

  if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
    throw new Error('Invalid user workflow package manifest.');
  }

  if (parsed.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      id: parsed.id,
      name: parsed.name,
    };
  }

  if (
    parsed.schemaVersion !== 1
    || !Array.isArray(parsed.locales)
    || parsed.locales.some((locale: unknown) => !isWorkflowPackageLocale(locale))
    || parsed.locales.length === 0
  ) {
    throw new Error('Invalid user workflow package manifest.');
  }

  return {
    schemaVersion: 1,
    id: parsed.id,
    name: parsed.name,
    locales: normalizeLocales(parsed.locales as WorkflowPackageLocale[]),
  };
}

function resolveUserPackageContentPath(
  manifest: AnyUserWorkflowPackageManifest,
  packagePath: string,
): string {
  return manifest.schemaVersion === 1
    ? path.join(packagePath, manifest.locales[0])
    : packagePath;
}

async function copyPackageFiles(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const sourcePath of await listSourceFiles(sourceRoot)) {
    const relativePath = toConfigRelativePath(sourceRoot, sourcePath);

    if (relativePath === userPackageManifestName) {
      continue;
    }

    const targetPath = resolveSourcePackagePath(targetRoot, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function hashPackageFiles(rootPath: string): Promise<PackageFileHashes> {
  const sourceFiles = await listSourceFiles(rootPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });
  const entries = await Promise.all(sourceFiles.map(async (filePath) => {
    const relativePath = toConfigRelativePath(rootPath, filePath);
    const content = await fs.readFile(filePath);

    return [relativePath, createHash('sha256').update(content).digest('hex')] as const;
  }));

  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function packageSnapshotsEqual(left: BundledPackageSnapshot, right: BundledPackageSnapshot): boolean {
  const locales = new Set<WorkflowPackageLocale>([
    ...Object.keys(left).filter(isWorkflowPackageLocale),
    ...Object.keys(right).filter(isWorkflowPackageLocale),
  ] as WorkflowPackageLocale[]);

  for (const locale of locales) {
    const leftFiles = left[locale] ?? {};
    const rightFiles = right[locale] ?? {};
    const paths = new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)]);

    for (const filePath of paths) {
      if (leftFiles[filePath] !== rightFiles[filePath]) {
        return false;
      }
    }
  }

  return true;
}

function defaultBundledPackageBaselineState(): BundledPackageBaselineState {
  return {
    schemaVersion: 1,
    packages: {},
  };
}

function validateBundledPackageBaselineState(input: unknown): BundledPackageBaselineState {
  if (!isRecord(input) || input.schemaVersion !== 1 || !isRecord(input.packages)) {
    throw new Error('Invalid bundled workflow package baseline state.');
  }

  const packages: Record<string, BundledPackageBaseline> = {};

  for (const [packageId, baseline] of Object.entries(input.packages)) {
    if (!isRecord(baseline) || typeof baseline.sourceVersion !== 'string' || !isRecord(baseline.filesByLocale)) {
      continue;
    }

    const filesByLocale: BundledPackageSnapshot = {};

    for (const [locale, files] of Object.entries(baseline.filesByLocale)) {
      if (!isWorkflowPackageLocale(locale) || !isRecord(files)) {
        continue;
      }

      const hashes = Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
      filesByLocale[locale] = Object.fromEntries(hashes);
    }

    packages[packageId] = {
      sourceVersion: baseline.sourceVersion,
      filesByLocale,
    };
  }

  return {
    schemaVersion: 1,
    packages,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
