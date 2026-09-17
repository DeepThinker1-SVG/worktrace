import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { LocalStateService } from '../src/main/services/local-state-service';
import { translate } from '../src/shared/i18n';
import { formatRelativeActivityTime } from '../src/shared/workspace';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
});

describe('application localization', () => {
  test('translates static and interpolated software-shell messages', () => {
    expect(translate('zh-CN', 'settings.language')).toBe('语言');
    expect(translate('en', 'settings.language')).toBe('Language');
    expect(translate('en', 'workspace.fileCount', { count: 3 })).toBe('3 files');
    expect(translate('en', 'workspace.fileCount', { count: 1 })).toBe('1 file');
  });

  test('formats relative activity time in both supported locales', () => {
    const now = Date.parse('2026-07-04T12:00:00+08:00');

    expect(formatRelativeActivityTime(now - 60_000, now, 'zh-CN')).toBe('1 分钟前');
    expect(formatRelativeActivityTime(now - 60_000, now, 'en')).toBe('1 minute ago');
    expect(formatRelativeActivityTime(now - 2 * 60_000, now, 'en')).toBe('2 minutes ago');
  });

  test('persists locale as an application preference outside workspace state', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-i18n-'));
    tempPaths.push(userDataPath);

    const service = new LocalStateService(userDataPath);
    await expect(service.getAppPreferences()).resolves.toEqual({ locale: 'zh-CN' });
    await service.setAppLocale('en');
    await service.flush();

    const restored = new LocalStateService(userDataPath);
    await expect(restored.getAppPreferences()).resolves.toEqual({ locale: 'en' });
  });

  test('sanitizes an unsupported persisted locale back to Chinese', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workboard-i18n-'));
    tempPaths.push(userDataPath);
    await fs.writeFile(path.join(userDataPath, 'workboard-session.json'), JSON.stringify({
      schemaVersion: 1,
      appPreferences: { locale: 'fr' },
      lastWorkspacePath: null,
      workspaces: {},
    }), 'utf8');

    const service = new LocalStateService(userDataPath);
    await expect(service.getAppPreferences()).resolves.toEqual({ locale: 'zh-CN' });
  });
});
