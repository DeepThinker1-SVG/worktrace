export type FileWindowV2Handle = {
  webContents: {
    send: (channel: string, payload: unknown) => void;
  };
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
};

export const fileWindowV2FileChangedChannel = 'workboard:file-window-v2-file-changed';
export const fileWindowV2PendingUpdatesChangedChannel = 'workboard:file-window-v2-pending-updates-changed';

export class FileWindowV2Registry<TWindow extends FileWindowV2Handle> {
  private readonly windows = new Map<string, TWindow>();

  get(relativePath: string): TWindow | undefined {
    return this.windows.get(normalizeFileWindowV2Path(relativePath));
  }

  hasLiveWindow(relativePath: string): boolean {
    const window = this.get(relativePath);

    if (!window) {
      return false;
    }

    if (window.isDestroyed()) {
      this.delete(relativePath, window);
      return false;
    }

    return true;
  }

  getLiveRelativePaths(): string[] {
    const relativePaths: string[] = [];

    for (const [relativePath, window] of this.windows.entries()) {
      if (window.isDestroyed()) {
        this.windows.delete(relativePath);
        continue;
      }

      relativePaths.push(relativePath);
    }

    return relativePaths;
  }

  set(relativePath: string, window: TWindow): string {
    const normalizedPath = normalizeFileWindowV2Path(relativePath);
    this.windows.set(normalizedPath, window);

    return normalizedPath;
  }

  delete(relativePath: string, window?: TWindow): boolean {
    const normalizedPath = normalizeFileWindowV2Path(relativePath);

    if (window && this.windows.get(normalizedPath) !== window) {
      return false;
    }

    return this.windows.delete(normalizedPath);
  }

  focusExisting(relativePath: string): boolean {
    const window = this.get(relativePath);

    if (!window || !this.hasLiveWindow(relativePath)) {
      return false;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.show();
    window.focus();

    return true;
  }

  entries(): Array<[string, TWindow]> {
    return [...this.windows.entries()];
  }

  sendFileChanged(relativePath: string, payload: unknown): number {
    const window = this.get(relativePath);

    if (!window) {
      return 0;
    }

    if (window.isDestroyed()) {
      this.delete(relativePath, window);
      return 0;
    }

    window.webContents.send(fileWindowV2FileChangedChannel, payload);

    return 1;
  }

  sendFilePendingUpdates(relativePath: string, payload: unknown): number {
    const window = this.get(relativePath);

    if (!window) {
      return 0;
    }

    if (window.isDestroyed()) {
      this.delete(relativePath, window);
      return 0;
    }

    window.webContents.send(fileWindowV2PendingUpdatesChangedChannel, payload);

    return 1;
  }

  broadcastPendingUpdates(payloadForPath: (relativePath: string) => unknown): number {
    let sent = 0;

    for (const [relativePath, window] of this.entries()) {
      if (window.isDestroyed()) {
        this.delete(relativePath, window);
        continue;
      }

      window.webContents.send(fileWindowV2PendingUpdatesChangedChannel, payloadForPath(relativePath));
      sent += 1;
    }

    return sent;
  }
}

export function normalizeFileWindowV2Path(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}
