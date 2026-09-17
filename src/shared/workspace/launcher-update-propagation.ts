export function deriveUpdatedFolderPaths(updatedFilePaths: string[], visibleFilePaths: string[]): Set<string> {
  const visibleFiles = new Set(visibleFilePaths.map(normalizeUpdatePath));
  const folders = new Set<string>();

  for (const relativePath of updatedFilePaths) {
    const normalizedPath = normalizeUpdatePath(relativePath);

    if (!visibleFiles.has(normalizedPath)) {
      continue;
    }

    const parts = normalizedPath.split('/');
    parts.pop();

    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      folders.add(current);
    }
  }

  return folders;
}

export function normalizeUpdatePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/\/+$/g, '');
}
