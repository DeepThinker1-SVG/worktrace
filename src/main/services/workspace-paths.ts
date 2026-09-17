import fs from 'node:fs/promises';
import path from 'node:path';

export type PathValidationResult =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; reason: string };

export async function validateWorkspacePath(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  const stat = await fs.stat(resolved);

  if (!stat.isDirectory()) {
    throw new Error('Workspace path is not a directory.');
  }

  return resolved;
}

export async function normalizeWorkspaceFilePath(
  workspacePath: string,
  filePath: string,
): Promise<PathValidationResult> {
  const workspaceResolved = path.resolve(workspacePath);
  const workspaceReal = await fs.realpath(workspaceResolved);
  const candidateResolved = path.resolve(workspaceResolved, filePath);

  if (!isInsidePath(workspaceResolved, candidateResolved)) {
    return { ok: false, reason: 'File is outside the workspace.' };
  }

  const stat = await fs.stat(candidateResolved).catch(() => null);

  if (!stat?.isFile()) {
    return { ok: false, reason: 'File does not exist.' };
  }

  const candidateReal = await fs.realpath(candidateResolved);

  if (!isInsidePath(workspaceReal, candidateReal)) {
    return { ok: false, reason: 'File is outside the workspace.' };
  }

  if (path.extname(candidateReal).toLowerCase() !== '.md') {
    return { ok: false, reason: 'Only Markdown files can be added.' };
  }

  return {
    ok: true,
    absolutePath: candidateReal,
    relativePath: toConfigRelativePath(workspaceReal, candidateReal),
  };
}

export async function normalizeWorkspaceDirectoryPath(
  workspacePath: string,
  directoryPath: string,
): Promise<PathValidationResult> {
  const workspaceResolved = path.resolve(workspacePath);
  const workspaceReal = await fs.realpath(workspaceResolved);
  const candidateResolved = path.resolve(workspaceResolved, directoryPath);

  if (!pathsEqual(workspaceResolved, candidateResolved) && !isInsidePath(workspaceResolved, candidateResolved)) {
    return { ok: false, reason: 'Directory is outside the workspace.' };
  }

  const stat = await fs.stat(candidateResolved).catch(() => null);

  if (!stat?.isDirectory()) {
    return { ok: false, reason: 'Directory does not exist.' };
  }

  const candidateReal = await fs.realpath(candidateResolved);

  if (!pathsEqual(workspaceReal, candidateReal) && !isInsidePath(workspaceReal, candidateReal)) {
    return { ok: false, reason: 'Directory is outside the workspace.' };
  }

  return {
    ok: true,
    absolutePath: candidateReal,
    relativePath: pathsEqual(workspaceReal, candidateReal) ? '.' : toConfigRelativePath(workspaceReal, candidateReal),
  };
}

export function pathsEqual(left: string, right: string): boolean {
  return normalizeCase(left) === normalizeCase(right);
}

export function toConfigRelativePath(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath).replaceAll(path.sep, '/');
}

export function isInsidePath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(normalizeCase(parentPath), normalizeCase(childPath));

  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeCase(inputPath: string): string {
  return process.platform === 'win32' ? inputPath.toLowerCase() : inputPath;
}
