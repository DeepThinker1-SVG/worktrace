import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  FileStylesConfig,
  MarkerStyle,
  StylesConfig,
  WorkspaceConfig,
} from '../../shared/workspace';

export const WORKBOARD_DIR = '.workboard';

const protocolContent = `# Worktrace 写作约定

Worktrace Markdown 是用户、普通编辑器和 Agent 共同维护的项目状态。它记录“项目现在处于什么状态”，不记录“某个 Agent 这一次执行了哪些瞬时动作”。

格式不是装饰：一级标题会成为可独立打开的模块，标题会显示为工作项，标题开头的标记会用于显示、颜色、统计和筛选。

## 基本结构

1. 一份文件通常只使用 1-3 个一级标题；一级标题表示可独立打开的模块。
2. 二级及以下标题表达工作项树；标题应尽量是一项可跟踪的工作。
3. 标题开头优先使用短标记表达可见状态，例如 \`## [进行中] 修复文件更新提示\`。
4. 标记用于显示和筛选，不承载复杂业务语义；原因、证据和细节写入正文。

## 更新原则

1. 当前状态应更新原有节点，不反复追加日报。
2. 没有内容的部分可以不写，不要为了填满格式制造空段落。
3. 多个线程或 Codex 窗口分别维护自己的 \`workboard/CURRENT.<scope>.md\`，避免相互覆盖。
4. 新窗口不默认读取全部 CURRENT，只读取任务指定、延续或避免冲突所需的文件。
5. 只沉淀值得跨会话保留的状态、验证、阻塞、决策和未覆盖内容，不记录读取文件、运行命令等瞬时步骤。

## 模板约束

1. 创建或更新 Worktrace 工作文件前，必须读取对应模板。
2. CURRENT 应按 \`current.md\` 写成工作项树，常用标记包括 [目标]、[进行中]、[待处理]、[待验证]、[已完成] 和 [受阻]。
3. 其他工作文件按 \`.workboard/templates/\` 中的对应模板写入；没有内容的示例章节应删除。

## 文件位置与命名

1. Worktrace 工作文件默认创建和维护在仓库根目录的 \`workboard/\` 下；普通项目开发文档仍可维护在 \`docs/\` 下。
2. 模板使用稳定的英文文件名，不创建同一模板的中文文件名副本。
`;

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return {
    schemaVersion: 2,
    managedDirectories: ['workboard'],
    managedFiles: [],
    excludedDirectories: [],
    excludedFiles: [],
    pinnedFiles: [],
    hiddenFiles: [],
    showHiddenFiles: false,
  };
}

export function defaultStylesConfig(): StylesConfig {
  return {
    schemaVersion: 1,
    files: {},
  };
}

export async function loadStylesConfig(workspacePath: string): Promise<StylesConfig> {
  const configPath = stylesConfigPath(workspacePath);

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    return validateStylesConfig(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return defaultStylesConfig();
    }

    await backupCorruptConfig(configPath);
    await writeStylesConfig(workspacePath, defaultStylesConfig());

    return defaultStylesConfig();
  }
}

export async function writeStylesConfig(workspacePath: string, config: StylesConfig): Promise<void> {
  await atomicWriteJson(stylesConfigPath(workspacePath), validateStylesConfig(config));
}

export async function initializeWorkspace(workspacePath: string): Promise<void> {
  const workboardDir = path.join(workspacePath, WORKBOARD_DIR);
  const templatesDir = path.join(workboardDir, 'templates');

  await fs.mkdir(templatesDir, { recursive: true });
  await writeFileIfMissing(path.join(workboardDir, 'PROTOCOL.md'), protocolContent);
  await writeJsonIfMissing(path.join(workboardDir, 'workspace.json'), defaultWorkspaceConfig());
  await writeJsonIfMissing(path.join(workboardDir, 'styles.json'), defaultStylesConfig());
}

export async function loadWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig> {
  const configPath = workspaceConfigPath(workspacePath);

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (isLegacyWorkspaceConfig(parsed)) {
      const migrated = migrateWorkspaceConfig(parsed);

      await writeWorkspaceConfig(workspacePath, migrated);
      return migrated;
    }

    return validateWorkspaceConfig(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return defaultWorkspaceConfig();
    }

    await backupCorruptConfig(configPath);
    await writeWorkspaceConfig(workspacePath, defaultWorkspaceConfig());

    return defaultWorkspaceConfig();
  }
}

export async function writeWorkspaceConfig(
  workspacePath: string,
  config: unknown,
): Promise<void> {
  const validated = validateWorkspaceConfig(config);

  await atomicWriteJson(workspaceConfigPath(workspacePath), validated);
}

export function validateWorkspaceConfig(input: unknown): WorkspaceConfig {
  if (!isRecord(input) || input.schemaVersion !== 2) {
    throw new Error('Invalid workspace config.');
  }

  const excludedDirectories = normalizeManagedDirectories(input.excludedDirectories);
  const managedDirectories = normalizeManagedDirectoriesWithExclusions(input.managedDirectories, excludedDirectories);

  return {
    schemaVersion: 2,
    managedDirectories,
    managedFiles: removeRedundantManagedFiles(
      normalizeConfigPathList(input.managedFiles, { markdownOnly: true }),
      managedDirectories,
      excludedDirectories,
    ),
    excludedDirectories,
    excludedFiles: removeDirectoryCoveredFiles(
      normalizeConfigPathList(input.excludedFiles, { markdownOnly: true }),
      excludedDirectories,
    ),
    pinnedFiles: normalizeConfigPathList(input.pinnedFiles, { markdownOnly: true }),
    hiddenFiles: normalizeConfigPathList(input.hiddenFiles, { markdownOnly: true }),
    showHiddenFiles: input.showHiddenFiles === true,
  };
}

export function migrateWorkspaceConfig(input: unknown): WorkspaceConfig {
  if (!isLegacyWorkspaceConfig(input)) {
    throw new Error('Invalid legacy workspace config.');
  }

  const pinnedFiles = normalizeConfigPathList(input.pinnedFiles, { markdownOnly: true });
  const hiddenFiles = normalizeConfigPathList(input.hiddenFiles, { markdownOnly: true });
  const managedDirectories = ['workboard'];

  return {
    schemaVersion: 2,
    managedDirectories,
    managedFiles: removeDirectoryCoveredFiles(
      normalizeConfigPathList([...pinnedFiles, ...hiddenFiles], { markdownOnly: true }),
      managedDirectories,
    ),
    excludedDirectories: [],
    excludedFiles: [],
    pinnedFiles,
    hiddenFiles,
    showHiddenFiles: input.showHiddenFiles === true,
  };
}

export function validateStylesConfig(input: unknown): StylesConfig {
  if (!isRecord(input) || input.schemaVersion !== 1 || !isRecord(input.files)) {
    throw new Error('Invalid styles config.');
  }

  const files: Record<string, FileStylesConfig> = {};

  for (const [filePath, fileStyles] of Object.entries(input.files)) {
    const markers: Record<string, MarkerStyle> = {};
    const rawMarkers = isRecord(fileStyles) && isRecord(fileStyles.markers) ? fileStyles.markers : {};

    for (const [markerName, markerStyle] of Object.entries(rawMarkers)) {
      if (typeof markerStyle === 'string') {
        markers[markerName] = { autoColor: normalizeColor(markerStyle) ?? '#6b7280' };
        continue;
      }

      if (!isRecord(markerStyle)) {
        continue;
      }

      const autoColor = normalizeColor(markerStyle.autoColor) ?? '#6b7280';
      const colorOverride = normalizeColor(markerStyle.colorOverride);

      markers[markerName] = {
        autoColor,
        ...(colorOverride ? { colorOverride } : {}),
      };
    }

    files[filePath.replaceAll('\\', '/')] = { markers };
  }

  return {
    schemaVersion: 1,
    files,
  };
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify(data, null, 2)}\n`;

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, content, 'utf8');

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function workspaceConfigPath(workspacePath: string): string {
  return path.join(workspacePath, WORKBOARD_DIR, 'workspace.json');
}

export function stylesConfigPath(workspacePath: string): string {
  return path.join(workspacePath, WORKBOARD_DIR, 'styles.json');
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' }).catch((error: unknown) => {
    if (!isExistingFileError(error)) {
      throw error;
    }
  });
}

async function writeJsonIfMissing(filePath: string, data: unknown): Promise<void> {
  await writeFileIfMissing(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function backupCorruptConfig(configPath: string): Promise<void> {
  const backupPath = `${configPath}.corrupt-${Date.now()}.bak`;

  await fs.rename(configPath, backupPath).catch(() => undefined);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function isExistingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function normalizeColor(input: unknown): string | undefined {
  if (typeof input !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input)) {
    return undefined;
  }

  return input.toLowerCase();
}

function normalizeManagedDirectories(input: unknown): string[] {
  const directories = normalizeConfigPathList(input, { allowWorkspaceRoot: true });
  const ordered = directories
    .map((directory, index) => ({ directory, index }))
    .sort((left, right) => pathDepth(left.directory) - pathDepth(right.directory) || left.index - right.index);
  const result: string[] = [];

  for (const { directory } of ordered) {
    if (!result.some((parent) => isPathCoveredByDirectory(directory, parent))) {
      result.push(directory);
    }
  }

  return result;
}

function normalizeManagedDirectoriesWithExclusions(input: unknown, excludedDirectories: string[]): string[] {
  const directories = normalizeConfigPathList(input, { allowWorkspaceRoot: true });
  const ordered = directories
    .map((directory, index) => ({ directory, index }))
    .sort((left, right) => pathDepth(left.directory) - pathDepth(right.directory) || left.index - right.index);
  const result: string[] = [];

  for (const { directory } of ordered) {
    const coveredByActiveParent = result.some((parent) => (
      isPathCoveredByDirectory(directory, parent)
      && !excludedDirectories.some((excluded) => (
        isPathCoveredByDirectory(directory, excluded)
        && isPathCoveredByDirectory(excluded, parent)
      ))
    ));

    if (!coveredByActiveParent) {
      result.push(directory);
    }
  }

  return result;
}

function normalizeConfigPathList(
  input: unknown,
  options: { allowWorkspaceRoot?: boolean; markdownOnly?: boolean } = {},
): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const value of input) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    const normalized = normalizeConfigRelativePath(value, options.allowWorkspaceRoot === true);

    if (options.markdownOnly && path.posix.extname(normalized).toLowerCase() !== '.md') {
      throw new Error('Managed files must be Markdown files.');
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    paths.push(normalized);
  }

  return paths;
}

function normalizeConfigRelativePath(input: string, allowWorkspaceRoot: boolean): string {
  if (input.includes('\0') || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new Error('Workspace config paths must be relative.');
  }

  const normalized = path.posix.normalize(input.replaceAll('\\', '/')).replace(/\/$/, '');

  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Workspace config paths must stay inside the workspace.');
  }

  if (normalized === '.' && !allowWorkspaceRoot) {
    throw new Error('Workspace config file paths cannot target the workspace root.');
  }

  return normalized;
}

function removeDirectoryCoveredFiles(files: string[], directories: string[]): string[] {
  return files.filter((file) => !directories.some((directory) => isPathCoveredByDirectory(file, directory)));
}

function removeRedundantManagedFiles(files: string[], managedDirectories: string[], excludedDirectories: string[]): string[] {
  return files.filter((file) => (
    !managedDirectories.some((directory) => isPathCoveredByDirectory(file, directory))
    || excludedDirectories.some((directory) => isPathCoveredByDirectory(file, directory))
  ));
}

function isPathCoveredByDirectory(candidate: string, directory: string): boolean {
  if (directory === '.') {
    return true;
  }

  const candidateKey = candidate.toLowerCase();
  const directoryKey = directory.toLowerCase();

  return candidateKey === directoryKey || candidateKey.startsWith(`${directoryKey}/`);
}

function pathDepth(input: string): number {
  return input === '.' ? 0 : input.split('/').length;
}

function isLegacyWorkspaceConfig(input: unknown): input is Record<string, unknown> & { schemaVersion: 1 } {
  return isRecord(input) && input.schemaVersion === 1;
}
