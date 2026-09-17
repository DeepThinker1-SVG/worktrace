import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import workboardLogo from './assets/workboard-logo.svg';
import {
  defaultAppPreferences,
  isAppLocale,
  translate,
  type AppLocale,
  type TranslationKey,
  type TranslationVariables,
} from '../shared/i18n';

import type {
  ManagedFileState,
  FileWindowV2FileUpdatePayload,
  FileWindowV2InitialPayload,
  FileUpdateStatus,
  ModuleWindowData,
  RenderedHeadingNode,
  WorkspaceBrowseEntry,
  WorkspaceState,
} from '../shared/workspace';
import { isClosedStatus, type Event, type EventActivity, type EventDocument } from '../shared/events';
import {
  buildTodoEventLocations,
  collectTodoTags,
  countTodoEvents,
  countTodoEventsByStatus,
  filterTodoEvents,
  type TodoEventLocation,
} from './todo-event-view';
import { formatActivityDateTime, formatRelativeActivityTime } from '../shared/workspace';
import type {
  WorkflowPackageFile,
  WorkflowPackageCatalog,
  WorkflowPackageLocale,
} from '../shared/workflow';
import {
  deriveChangedHeadingKeys,
  deriveUpdatedFolderPaths,
  deriveUpdatedModuleKeys,
  filterHeadingsByMarker,
  hasModuleBodyUpdate,
  hasPendingFileUpdates,
  hasPendingModuleUpdates,
  mergeHeadings,
  moduleBodyUpdateKey,
  modulesContentEqual,
  resolveFileWindowV2ActiveModuleKey,
  selectFileWindowV2Module,
} from '../shared/workspace';
import './styles/app.css';

type Notice = {
  kind: 'error' | 'info';
  text: string;
};

type ModuleLoadState = 'loading' | 'ready' | 'unavailable';
type LauncherPage = 'main' | 'settings';
type SettingsSection = 'general' | 'workflow' | 'about';
type LauncherSortMode = 'name-asc' | 'name-desc' | 'activity-desc' | 'activity-asc';

const markerColorPresets = [
  '#2f9b5f',
  '#28a69a',
  '#2997c8',
  '#3478e5',
  '#5967d8',
  '#7c4dff',
  '#a34fc4',
  '#cf4f91',
  '#d94c4c',
  '#e36b5d',
  '#e47f2f',
  '#d9a126',
  '#c2ad32',
  '#7da447',
  '#7b8797',
];

type LauncherFileTree = {
  folders: LauncherFileTreeFolder[];
  files: ManagedFileState[];
};

type LauncherFileTreeFolder = LauncherFileTree & {
  key: string;
  name: string;
  lastActivityAt?: number;
};

const route = new URLSearchParams(window.location.search);
const routeView = route.get('view');
const view = routeView === 'file-v2' ? routeView : 'launcher';
const routeRelativePath = route.get('relativePath');
const rawRouteLocale = route.get('locale');
const routeLocale = isAppLocale(rawRouteLocale) ? rawRouteLocale : defaultAppPreferences.locale;
const loggedRendererTraces = new Set<string>();
const themeStorageKey = 'workboard-ui-theme';
const minuteMs = 60_000;

type Theme = 'dark' | 'light';

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => Promise<void>;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function I18nProvider(props: React.PropsWithChildren) {
  const [locale, setLocaleState] = useState<AppLocale>(routeLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    void window.workboard.getAppPreferences().then((preferences) => setLocaleState(preferences.locale));
    return window.workboard.onAppPreferencesChanged((preferences) => setLocaleState(preferences.locale));
  }, []);

  const setLocale = useCallback(async (nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    try {
      const preferences = await window.workboard.setAppLocale(nextLocale);
      setLocaleState(preferences.locale);
    } catch (error) {
      const preferences = await window.workboard.getAppPreferences();
      setLocaleState(preferences.locale);
      console.error('[i18n] Failed to update application locale:', error);
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, variables?: TranslationVariables) => translate(locale, key, variables),
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{props.children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error('useI18n must be used within I18nProvider.');
  }

  return context;
}

function App() {
  if (view === 'file-v2' && routeRelativePath) {
    return <FileWindowV2App relativePath={routeRelativePath} />;
  }

  return <Launcher />;
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Theme persistence is a convenience; rendering should not depend on storage access.
    }
  }, [theme]);

  useEffect(() => {
    function syncTheme(event: StorageEvent) {
      if (event.key === themeStorageKey) {
        setTheme(readStoredTheme());
      }
    }

    window.addEventListener('storage', syncTheme);

    return () => window.removeEventListener('storage', syncTheme);
  }, []);

  function toggleTheme() {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  return { theme, toggleTheme };
}

function Launcher() {
  const { theme, toggleTheme } = useTheme();
  const { locale, t } = useI18n();
  const now = useRelativeTimeTick();
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [recentFiles, setRecentFiles] = useState<Array<{ path: string; openedAt: number }>>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [workflowCatalog, setWorkflowCatalog] = useState<WorkflowPackageCatalog>({ bundled: [], user: [] });
  const [launcherPage, setLauncherPage] = useState<LauncherPage>('main');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [openFileMenuPath, setOpenFileMenuPath] = useState<string | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [sortMode, setSortMode] = useState<LauncherSortMode>('activity-desc');
  const [updatedFilePaths, setUpdatedFilePaths] = useState<string[]>([]);
  const [openFilePaths, setOpenFilePaths] = useState<string[]>([]);
  const [workspaceBrowseEntries, setWorkspaceBrowseEntries] = useState<Record<string, WorkspaceBrowseEntry[]>>({});
  const [workspaceBrowseLoading, setWorkspaceBrowseLoading] = useState<Set<string>>(() => new Set());
  const [treeContextMenu, setTreeContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [newTodoName, setNewTodoName] = useState('');
  const [newTodoDialogOpen, setNewTodoDialogOpen] = useState(false);
  const browseWorkspacePathRef = useRef<string | null>(null);

  useEffect(() => {
    void runAction(() => window.workboard.getWorkspaceState(), setWorkspaceState, setNotice, setBusy, t('common.operationFailed'));
    void window.workboard.getRecentFiles().then(setRecentFiles);
    void window.workboard.getLauncherPendingUpdates().then((payload) => {
      setUpdatedFilePaths(payload.updatedFilePaths);
      setOpenFilePaths(payload.openFilePaths);
    });
    void window.workboard.getWorkflowPackageCatalog().then(setWorkflowCatalog).catch((error: unknown) => {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.loadFailed') });
    });

    const unsubscribeWorkspaceState = window.workboard.onWorkspaceStateChanged((state) => {
      logRendererUpdateTrace('launcher', state);
      setWorkspaceState(state);
    });
    const unsubscribePendingUpdates = window.workboard.onLauncherPendingUpdatesChanged((payload) => {
      setUpdatedFilePaths(payload.updatedFilePaths);
      setOpenFilePaths(payload.openFilePaths);
    });

    return () => {
      unsubscribeWorkspaceState();
      unsubscribePendingUpdates();
    };
  }, []);

  const hasPendingUpdates = updatedFilePaths.length > 0;

  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const files = [...(workspaceState?.files ?? [])].sort((left, right) => left.order - right.order);

    return (normalizedQuery
      ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
      : files)
      .filter((file) => workspaceState?.showHiddenFiles || !file.hidden);
  }, [query, workspaceState]);
  const fileTree = useMemo(() => buildLauncherFileTree(filteredFiles, sortMode), [filteredFiles, sortMode]);
  const allFolderKeys = useMemo(() => collectLauncherFolderKeys(fileTree), [fileTree]);
  const updatedFileSet = useMemo(() => new Set(updatedFilePaths), [updatedFilePaths]);
  const openFileSet = useMemo(() => new Set(openFilePaths), [openFilePaths]);
  const updatedFolderSet = useMemo(
    () => deriveUpdatedFolderPaths(updatedFilePaths, filteredFiles.map((file) => file.path)),
    [filteredFiles, updatedFilePaths],
  );
  const totalFiles = useMemo(
    () => (workspaceState?.files ?? []).filter((file) => workspaceState?.showHiddenFiles || !file.hidden).length,
    [workspaceState],
  );
  const managedFileByPath = useMemo(
    () => new Map((workspaceState?.files ?? []).map((file) => [file.path.toLowerCase(), file])),
    [workspaceState?.files],
  );

  const loadWorkspaceDirectory = useCallback(async (relativeDirectory: string, force = false) => {
    const directoryKey = relativeDirectory || '.';

    if (!workspaceState?.workspacePath || (!force && workspaceBrowseEntries[directoryKey])) {
      return;
    }

    setWorkspaceBrowseLoading((current) => new Set(current).add(directoryKey));
    try {
      const entries = await window.workboard.listWorkspaceDirectory(directoryKey);
      setWorkspaceBrowseEntries((current) => ({ ...current, [directoryKey]: entries }));
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('common.operationFailed') });
    } finally {
      setWorkspaceBrowseLoading((current) => {
        const next = new Set(current);
        next.delete(directoryKey);
        return next;
      });
    }
  }, [t, workspaceBrowseEntries, workspaceState?.workspacePath]);

  useEffect(() => {
    const workspacePath = workspaceState?.workspacePath ?? null;
    const workspaceChanged = browseWorkspacePathRef.current !== workspacePath;

    if (workspaceChanged) {
      browseWorkspacePathRef.current = workspacePath;
      setWorkspaceBrowseEntries({});
      setWorkspaceBrowseLoading(new Set());
    }

    if (!workspaceState?.showHiddenFiles || !workspacePath) {
      return;
    }

    void loadWorkspaceDirectory('.', workspaceChanged);
  }, [loadWorkspaceDirectory, workspaceState?.showHiddenFiles, workspaceState?.workspacePath]);

  useEffect(() => {
    if (query.trim().length === 0) {
      return;
    }

    setExpandedFolders(new Set(allFolderKeys));
  }, [allFolderKeys, query]);

  useEffect(() => {
    if (!openFileMenuPath) {
      return undefined;
    }

    function closeFileMenuOnOutsidePointer(event: PointerEvent) {
      const target = event.target;

      if (target instanceof Element && target.closest('.file-menu')) {
        return;
      }

      setOpenFileMenuPath(null);
    }

    document.addEventListener('pointerdown', closeFileMenuOnOutsidePointer);

    return () => document.removeEventListener('pointerdown', closeFileMenuOnOutsidePointer);
  }, [openFileMenuPath]);

  useEffect(() => {
    if (!sortMenuOpen) {
      return undefined;
    }

    function closeSortMenuOnOutsidePointer(event: PointerEvent) {
      const target = event.target;

      if (target instanceof Element && target.closest('.sort-menu')) {
        return;
      }

      setSortMenuOpen(false);
    }

    document.addEventListener('pointerdown', closeSortMenuOnOutsidePointer);

    return () => document.removeEventListener('pointerdown', closeSortMenuOnOutsidePointer);
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!treeContextMenu) {
      return undefined;
    }

    const closeContextMenu = () => setTreeContextMenu(null);
    window.addEventListener('pointerdown', closeContextMenu, { once: true });
    window.addEventListener('blur', closeContextMenu, { once: true });

    return () => {
      window.removeEventListener('pointerdown', closeContextMenu);
      window.removeEventListener('blur', closeContextMenu);
    };
  }, [treeContextMenu]);

  function toggleFolder(folderKey: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);

      if (next.has(folderKey)) {
        next.delete(folderKey);
      } else {
        next.add(folderKey);
        if (workspaceState?.showHiddenFiles) {
          void loadWorkspaceDirectory(folderKey);
        }
      }

      return next;
    });
  }

  function toggleLauncherTree() {
    const allExpanded = allFolderKeys.length > 0 && allFolderKeys.every((folderKey) => expandedFolders.has(folderKey));

    setExpandedFolders(allExpanded ? new Set() : new Set(allFolderKeys));
  }

  function selectSortMode(mode: LauncherSortMode) {
    setSortMode(mode);
    setSortMenuOpen(false);
  }

  function toggleFileMenu(relativePath: string, open: boolean) {
    if (open) {
      setOpenFileMenuPath(relativePath);
      return;
    }

    setOpenFileMenuPath((current) => (current === relativePath ? null : current));
  }

  async function chooseWorkspace() {
    await runAction(
      async () => {
        const state = await window.workboard.chooseWorkspace();
        setNotice(null);
        return state;
      },
      setWorkspaceState,
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function openFileWindowV2(relativePath: string) {
    setBusy(true);
    setNotice(null);

    try {
      const result = await window.workboard.openFileWindowV2(relativePath);

      if (!result.ok) {
        setNotice({ kind: 'error', text: result.reason });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('file.openFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function openRecentFile(filePath: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.workboard.openRecentFile(filePath);
      if (!result.ok) throw new Error(result.reason);
      setRecentFiles(await window.workboard.getRecentFiles());
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('file.openFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function chooseMarkdownFile() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.workboard.openTemporaryFileWindowV2();
      if (!result.ok) throw new Error(result.reason);
      setRecentFiles(await window.workboard.getRecentFiles());
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('file.openFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function createTodoFile() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.workboard.createTodoPlan(newTodoName);
      if (!result.ok) throw new Error(result.reason);
      setNewTodoDialogOpen(false);
      setNewTodoName('');
      setRecentFiles(await window.workboard.getRecentFiles());
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('todo.createFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function clearAllFileWindowV2Updates() {
    setBusy(true);
    setNotice(null);

    try {
      await window.workboard.clearAllFileWindowV2Updates();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('file.clearUpdatesFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function setFilePinned(relativePath: string, pinned: boolean) {
    await runAction(
      () => window.workboard.setFilePinned(relativePath, pinned),
      setWorkspaceState,
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function setFileHidden(relativePath: string, hidden: boolean) {
    await runAction(
      () => window.workboard.setFileHidden(relativePath, hidden),
      setWorkspaceState,
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function toggleShowHiddenFiles() {
    await runAction(
      () => window.workboard.setShowHiddenFiles(!(workspaceState?.showHiddenFiles === true)),
      setWorkspaceState,
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function refreshProjectTree(relativeDirectory?: string) {
    setTreeContextMenu(null);
    setOpenFileMenuPath(null);
    await updateManagedScope(() => window.workboard.refreshManagedFiles());

    if (workspaceState?.showHiddenFiles) {
      const loadedDirectories = relativeDirectory
        ? Object.keys(workspaceBrowseEntries).filter((directory) => directory === relativeDirectory || directory.startsWith(`${relativeDirectory}/`))
        : Object.keys(workspaceBrowseEntries);
      await Promise.all((loadedDirectories.length > 0 ? loadedDirectories : ['.']).map((directory) => loadWorkspaceDirectory(directory, true)));
    }
  }

  async function archiveFile(relativePath: string) {
    const confirmed = window.confirm(t('file.archiveConfirm', { name: fileDisplayName(relativePath) }));

    if (!confirmed) {
      return;
    }

    await runAction(
      async () => {
        const result = await window.workboard.archiveManagedFile(relativePath);
        return result.state;
      },
      setWorkspaceState,
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function openSource(relativePath: string) {
    await runCommand(() => window.workboard.openSourceFile(relativePath), setNotice, setBusy, t('common.operationFailed'));
  }

  async function showInFolder(relativePath: string) {
    await runCommand(() => window.workboard.showFileInFolder(relativePath), setNotice, setBusy, t('common.operationFailed'));
  }

  function openWorkflowSettings() {
    setSettingsSection('workflow');
    setLauncherPage('settings');
  }

  function openSettings() {
    setSettingsSection('general');
    setLauncherPage('settings');
  }

  async function refreshWorkflowCatalog() {
    setWorkflowCatalog(await window.workboard.getWorkflowPackageCatalog());
  }

  async function updateManagedScope(action: () => Promise<WorkspaceState>) {
    await runAction(action, setWorkspaceState, setNotice, setBusy, t('common.operationFailed'));
  }

  async function updateProjectScope(action: () => Promise<WorkspaceState>) {
    await updateManagedScope(action);
    await Promise.all(Object.keys(workspaceBrowseEntries).map((directory) => loadWorkspaceDirectory(directory, true)));
  }

  async function setDirectoryManaged(relativePath: string, managed: boolean) {
    await updateProjectScope(() => managed
      ? window.workboard.addManagedDirectory(relativePath)
      : window.workboard.removeManagedDirectory(relativePath));
  }

  async function setMarkdownManaged(relativePath: string, managed: boolean) {
    await updateProjectScope(() => managed
      ? window.workboard.addManagedFile(relativePath)
      : window.workboard.removeManagedFile(relativePath));
  }

  async function importWorkflowPackage(
    source: 'bundled' | 'user',
    packageId: string,
    packageName: string,
    locale?: WorkflowPackageLocale,
  ) {
    setBusy(true);
    setNotice(null);

    try {
      if (source === 'bundled' && !locale) {
        throw new Error('Bundled workflow package language is required.');
      }

      const plan = source === 'bundled'
        ? await window.workboard.previewBundledAiCodingWorkflow(packageId, locale as WorkflowPackageLocale)
        : await window.workboard.previewUserWorkflowPackage(packageId);
      const overwriteText = plan.overwrite.length > 0
        ? t('workflow.overwriteSuffix', { count: plan.overwrite.length })
        : '';
      const confirmed = source === 'bundled'
        ? window.confirm(t('workflow.bundledApplyConfirm', {
            name: packageName,
            language: workflowLocaleLabel(locale as WorkflowPackageLocale, t),
            createCount: plan.create.length,
            overwriteText,
          }))
        : window.confirm(t('workflow.userApplyConfirm', {
            name: packageName,
            createCount: plan.create.length,
            overwriteText,
          }));

      if (!confirmed) {
        return;
      }

      if (source === 'bundled') {
        await window.workboard.applyBundledAiCodingWorkflow(
          packageId,
          locale as WorkflowPackageLocale,
          plan.overwrite.length > 0,
        );
      } else {
        await window.workboard.applyUserWorkflowPackage(packageId, plan.overwrite.length > 0);
      }
      setNotice(null);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.applyFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function createUserWorkflowPackage(name: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);

    try {
      const created = await window.workboard.createUserWorkflowPackage(name);
      await refreshWorkflowCatalog();
      await window.workboard.openUserWorkflowPackage(created.id);
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.operationFailed') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function importFolderAsUserWorkflowPackage(name: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);

    try {
      const created = await window.workboard.importFolderAsUserWorkflowPackage(name);

      if (!created) {
        return false;
      }

      await refreshWorkflowCatalog();
      await window.workboard.openUserWorkflowPackage(created.id);
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.operationFailed') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openUserWorkflowPackage(packageId: string) {
    await runCommand(
      () => window.workboard.openUserWorkflowPackage(packageId),
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function openBundledWorkflowPackage(packageId: string) {
    await runCommand(
      () => window.workboard.openBundledWorkflowPackage(packageId),
      setNotice,
      setBusy,
      t('common.operationFailed'),
    );
  }

  async function restoreBundledWorkflowPackage(packageId: string) {
    await runWorkflowCatalogAction(() => window.workboard.restoreBundledWorkflowPackage(packageId));
  }

  async function updateBundledWorkflowPackage(packageId: string) {
    setBusy(true);
    setNotice(null);

    try {
      const result = await window.workboard.updateBundledWorkflowPackage(packageId);

      if (!result) {
        return;
      }

      setWorkflowCatalog(result.catalog);
      setNotice({
        kind: 'info',
        text: result.backupPath
          ? t('workflow.updateCompletedWithBackup', { path: result.backupPath })
          : t('workflow.updateCompleted'),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.operationFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function deleteUserWorkflowPackage(packageId: string) {
    await runWorkflowCatalogAction(() => window.workboard.deleteUserWorkflowPackage(packageId));
  }

  async function refreshWorkflowPackages() {
    setBusy(true);
    setNotice(null);

    try {
      await refreshWorkflowCatalog();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.loadFailed') });
    } finally {
      setBusy(false);
    }
  }

  async function runWorkflowCatalogAction(action: () => Promise<unknown | null>) {
    setBusy(true);
    setNotice(null);

    try {
      const result = await action();

      if (result === null) {
        return;
      }

      setNotice(null);
      await refreshWorkflowCatalog();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('workflow.operationFailed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell desktop-shell" data-theme={theme}>
      <section className="window-shell launcher-window focused">
        <header className="titlebar" onDoubleClick={() => window.workboard.controlCurrentWindow('toggle-maximize')}>
          <AppLogo />
          <div className="title-copy">
            <strong>Worktrace</strong>
          </div>
          <button className="titlebar-settings" type="button" onClick={openSettings} title={t('settings.title')} aria-label={t('settings.open')}><SettingsIcon /></button>
          <WindowControls />
        </header>

        {notice && <p className={`notice ${notice.kind}`}>{notice.text}</p>}
        {workspaceState?.error && <p className="notice error">{workspaceState.error}</p>}

        {launcherPage === 'settings' ? (
          <LauncherSettings
            busy={busy}
            section={settingsSection}
            workflowCatalog={workflowCatalog}
            workspaceReady={Boolean(workspaceState?.workspacePath)}
            onBack={() => setLauncherPage('main')}
            onCreateUserPackage={createUserWorkflowPackage}
            onDeleteUserPackage={deleteUserWorkflowPackage}
            onImportFolderAsPackage={importFolderAsUserWorkflowPackage}
            onImportPackage={importWorkflowPackage}
            onOpenBundledPackage={openBundledWorkflowPackage}
            onOpenUserPackage={openUserWorkflowPackage}
            onRefreshPackages={refreshWorkflowPackages}
            onRestoreBundledPackage={restoreBundledWorkflowPackage}
            onUpdateBundledPackage={updateBundledWorkflowPackage}
            onSelectSection={setSettingsSection}
            theme={theme}
            onThemeToggle={toggleTheme}
          />
        ) : (
          <>
            <section className="launcher-home">
              <div className="launcher-home-mark" aria-hidden="true"><AppLogo /></div>
              <h1>{t('workspace.welcomeTitle')}</h1>
              <p>{t('workspace.welcomeDescription')}</p>
              <div className="launcher-home-actions">
                <button className="launcher-home-open" type="button" onClick={() => void chooseMarkdownFile()} disabled={busy}><MarkdownFileIcon />{t('workspace.openFile')}</button>
                <button className="launcher-home-create" type="button" onClick={() => setNewTodoDialogOpen(true)} disabled={busy}><span aria-hidden="true">＋</span>{t('todo.newPlan')}</button>
              </div>
              <div className="launcher-recent-head"><strong>{t('workspace.recentFiles')}</strong></div>
              <div className="launcher-recent-list">
                {recentFiles.slice(0, 5).map((file) => {
                  const fileName = file.path.split(/[\\/]/).pop() ?? file.path;
                  return <button className="launcher-recent-item" type="button" key={file.path} onClick={() => void openRecentFile(file.path)} disabled={busy}>
                    <span className="launcher-recent-icon" aria-hidden="true"><MarkdownFileIcon /></span>
                    <strong>{fileName.replace(/\.md$/i, '')}</strong>
                    <time>{formatRelativeActivityTime(file.openedAt, now, locale)}</time>
                    <span className="launcher-recent-more" aria-hidden="true">•••</span>
                  </button>;
                })}
                {!recentFiles.length && <span className="launcher-recent-empty">{t('workspace.noFiles')}</span>}
              </div>
            </section>
            {newTodoDialogOpen && <div className="launcher-home-dialog-backdrop">
              <form className="launcher-home-dialog" onSubmit={(event) => { event.preventDefault(); void createTodoFile(); }}>
                <h2>{t('todo.newPlan')}</h2>
                <label><span>{t('todo.nameLabel')}</span><input autoFocus value={newTodoName} onChange={(event) => setNewTodoName(event.target.value)} placeholder={t('todo.namePlaceholder')} onKeyDown={(event) => { if (event.key === 'Escape') setNewTodoDialogOpen(false); }} /></label>
                <div className="dialog-actions"><button type="button" onClick={() => setNewTodoDialogOpen(false)}>{t('common.cancel')}</button><button type="submit" disabled={!newTodoName.trim() || busy}>{t('todo.create')}</button></div>
              </form>
            </div>}
            <div className="launcher-legacy-content" aria-hidden="true">
            <div className="launcher-head">
              <div className="repo-copy">
                <span className="repo-eyebrow">{t('workspace.current')}</span>
                <strong>{workspaceState?.workspaceName ?? t('workspace.select')}</strong>
                <span>{workspaceState?.workspacePath ?? t('workspace.selectPrompt')}</span>
              </div>
              <div className="workspace-actions" aria-label={t('workspace.actions')}>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => setNewTodoDialogOpen(true)}
                  disabled={busy || !workspaceState?.workspacePath}
                  title={t('todo.newPlan')}
                  aria-label={t('todo.newPlan')}
                >
                  ＋
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={openWorkflowSettings}
                  disabled={busy}
                  title={t('settings.workflow')}
                  aria-label={t('workspace.workflowSettings')}
                >
                  <WorkflowIcon />
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={chooseWorkspace}
                  disabled={busy}
                  title={workspaceState?.workspacePath ? t('workspace.change') : t('workspace.select')}
                  aria-label={workspaceState?.workspacePath ? t('workspace.change') : t('workspace.select')}
                >
                  <FolderSwitchIcon />
                </button>
                <button
                  className={`icon-btn ${workspaceState?.showHiddenFiles ? 'active' : ''}`}
                  type="button"
                  onClick={toggleShowHiddenFiles}
                  disabled={busy || !workspaceState?.workspacePath}
                  title={workspaceState?.showHiddenFiles ? t('workspace.hideHidden') : t('workspace.showHidden')}
                  aria-label={workspaceState?.showHiddenFiles ? t('workspace.hideHidden') : t('workspace.showHidden')}
                  aria-pressed={workspaceState?.showHiddenFiles === true}
                >
                  <EyeIcon />
                </button>
              </div>
            </div>

            <div className="search-row">
              <SearchIcon />
              <input
                aria-label={t('workspace.search')}
                className="search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workspace.searchPlaceholder')}
                value={query}
              />
            </div>

            {workspaceState?.workspacePath ? (
              workspaceState.showHiddenFiles ? (
                <div
                  className="file-tree workspace-browser-tree"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setTreeContextMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  {workspaceBrowseLoading.has('.') && !workspaceBrowseEntries['.'] ? (
                    <p className="file-message">{t('workspace.loadingProjectTree')}</p>
                  ) : (
                    <WorkspaceBrowserTree
                      relativeDirectory="."
                      depth={0}
                      entriesByDirectory={workspaceBrowseEntries}
                      expandedFolders={expandedFolders}
                      loadingDirectories={workspaceBrowseLoading}
                      managedFileByPath={managedFileByPath}
                      menuOpenPath={openFileMenuPath}
                      now={now}
                      openFilePaths={openFileSet}
                      query={query}
                      updateStatuses={workspaceState.fileUpdateStatuses}
                      updatedFilePaths={updatedFileSet}
                      updatedFolderPaths={updatedFolderSet}
                      onArchive={archiveFile}
                      onFileManagementChange={(relativePath, managed) => void setMarkdownManaged(relativePath, managed)}
                      onFolderManagementChange={(relativePath, managed) => void setDirectoryManaged(relativePath, managed)}
                      onFolderToggle={toggleFolder}
                      onHiddenChange={setFileHidden}
                      onMenuOpenChange={toggleFileMenu}
                      onOpenFileWindowV2={openFileWindowV2}
                      onOpenSource={openSource}
                      onPinnedChange={setFilePinned}
                      onShowInFolder={showInFolder}
                    />
                  )}
                </div>
              ) : filteredFiles.length === 0 ? (
                <div
                  className="empty-state"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setTreeContextMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  <h2>{query ? t('workspace.noMatches') : t('workspace.noFiles')}</h2>
                  <p>{query ? t('workspace.tryAnotherSearch') : t('workspace.managedFilesHint')}</p>
                </div>
              ) : (
                <>
                  <div className="file-tree-tools" aria-label={t('workspace.fileTreeTools')}>
                    <span className="file-tree-tools-label">{t('workspace.fileNavigation')}</span>
                    <div className="sort-menu">
                      <button
                        className={`tree-tool-btn ${sortMenuOpen ? 'active' : ''}`}
                        type="button"
                        onClick={() => setSortMenuOpen((current) => !current)}
                        title={t('workspace.sort', { mode: launcherSortLabel(sortMode, t) })}
                        aria-label={t('workspace.sort', { mode: launcherSortLabel(sortMode, t) })}
                        aria-expanded={sortMenuOpen}
                        aria-haspopup="menu"
                      >
                        <SortIcon />
                      </button>
                      {sortMenuOpen && (
                        <div className="sort-menu-panel" role="menu">
                          {(['name-asc', 'name-desc', 'activity-desc', 'activity-asc'] as LauncherSortMode[]).map((mode) => (
                            <button
                              className={sortMode === mode ? 'selected' : ''}
                              key={mode}
                              type="button"
                              role="menuitemradio"
                              aria-checked={sortMode === mode}
                              onClick={() => selectSortMode(mode)}
                            >
                              <span>{launcherSortLabel(mode, t)}</span>
                              {sortMode === mode && <span className="sort-menu-check" aria-hidden="true">✓</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className="tree-tool-btn tree-toggle-btn"
                      type="button"
                      onClick={toggleLauncherTree}
                      title={allFolderKeys.length > 0 && allFolderKeys.every((folderKey) => expandedFolders.has(folderKey)) ? t('workspace.collapseAll') : t('workspace.expandAll')}
                      aria-label={allFolderKeys.length > 0 && allFolderKeys.every((folderKey) => expandedFolders.has(folderKey)) ? t('workspace.collapseAll') : t('workspace.expandAll')}
                    >
                      <CollapseTreeIcon expanded={allFolderKeys.length > 0 && allFolderKeys.every((folderKey) => expandedFolders.has(folderKey))} />
                    </button>
                  </div>
                  <div
                    className="file-tree"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setTreeContextMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    <LauncherTree
                      depth={0}
                      expandedFolders={expandedFolders}
                      menuOpenPath={openFileMenuPath}
                      now={now}
                      openFilePaths={openFileSet}
                      tree={fileTree}
                      updateStatuses={workspaceState.fileUpdateStatuses}
                      updatedFilePaths={updatedFileSet}
                      updatedFolderPaths={updatedFolderSet}
                      onArchive={archiveFile}
                      onFileManagementChange={(relativePath, managed) => void setMarkdownManaged(relativePath, managed)}
                      onFolderManagementChange={(relativePath, managed) => void setDirectoryManaged(relativePath, managed)}
                      onFolderToggle={toggleFolder}
                      onHiddenChange={setFileHidden}
                      onMenuOpenChange={toggleFileMenu}
                      onOpenFileWindowV2={openFileWindowV2}
                      onOpenSource={openSource}
                      onPinnedChange={setFilePinned}
                      onShowInFolder={showInFolder}
                    />
                  </div>
                </>
              )
            ) : (
              <section className="empty-state">
                <h2>{t('workspace.select')}</h2>
                <p>{t('workspace.explicitFilesOnly')}</p>
              </section>
            )}

            {treeContextMenu && (
              <div className="tree-context-menu" style={{ left: treeContextMenu.x, top: treeContextMenu.y }}>
                <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => void refreshProjectTree()}>
                  {t('workspace.refreshTree')}
                </button>
              </div>
            )}

            {newTodoDialogOpen && (
              <div className="popover-panel" role="dialog" aria-label={t('todo.newPlan')}>
                <label>
                  {t('todo.nameLabel')}
                  <input
                    autoFocus
                    value={newTodoName}
                    onChange={(event) => setNewTodoName(event.target.value)}
                    placeholder={t('todo.namePlaceholder')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void createTodoFile();
                      if (event.key === 'Escape') setNewTodoDialogOpen(false);
                    }}
                  />
                </label>
                <div className="dialog-actions">
                  <button type="button" onClick={() => setNewTodoDialogOpen(false)}>{t('common.cancel')}</button>
                  <button type="button" onClick={() => void createTodoFile()} disabled={!newTodoName.trim() || busy}>{t('todo.create')}</button>
                </div>
              </div>
            )}

            <footer className="launcher-foot">
              <span>
                {workspaceState?.showHiddenFiles
                  ? t('workspace.projectBrowseMode')
                  : <>{t('workspace.fileCount', { count: totalFiles })} <span className="footer-separator">·</span> {t('workspace.folderCount', { count: allFolderKeys.length })}</>}
              </span>
              {hasPendingUpdates && (
                <button
                  className="clear-all-updates-btn"
                  type="button"
                  onClick={clearAllFileWindowV2Updates}
                  disabled={busy}
                  title={t('workspace.clearAllUpdates')}
                  aria-label={t('workspace.clearAllUpdates')}
                >
                  {t('workspace.clearUpdates')}
                </button>
              )}
            </footer>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function FolderMenu(props: {
  relativePath: string;
  managed: boolean;
  menuOpen: boolean;
  onManagementChange: (relativePath: string, managed: boolean) => void;
  onMenuOpenChange: (relativePath: string, open: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <details
      className="file-actions file-menu folder-menu"
      open={props.menuOpen}
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => props.onMenuOpenChange(props.relativePath, event.currentTarget.open)}
    >
      <summary className="tiny-btn" title={t('file.actions')} aria-label={t('file.actions')}>
        <span className="file-menu-glyph" aria-hidden="true">•••</span>
      </summary>
      <div className="file-menu-panel">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onMenuOpenChange(props.relativePath, false);
            props.onManagementChange(props.relativePath, !props.managed);
          }}
        >
          {props.managed ? t('scope.removeFromManagement') : t('scope.addToManagement')}
        </button>
      </div>
    </details>
  );
}

function LauncherTree(props: {
  depth: number;
  expandedFolders: Set<string>;
  menuOpenPath: string | null;
  now: number;
  openFilePaths: Set<string>;
  tree: LauncherFileTree;
  updateStatuses: WorkspaceState['fileUpdateStatuses'];
  updatedFilePaths: Set<string>;
  updatedFolderPaths: Set<string>;
  onArchive: (relativePath: string) => void;
  onFileManagementChange: (relativePath: string, managed: boolean) => void;
  onFolderManagementChange: (relativePath: string, managed: boolean) => void;
  onFolderToggle: (folderKey: string) => void;
  onHiddenChange: (relativePath: string, hidden: boolean) => void;
  onMenuOpenChange: (relativePath: string, open: boolean) => void;
  onOpenFileWindowV2: (relativePath: string) => void;
  onOpenSource: (relativePath: string) => void;
  onPinnedChange: (relativePath: string, pinned: boolean) => void;
  onShowInFolder: (relativePath: string) => void;
}) {
  const { locale } = useI18n();
  const {
    depth,
    expandedFolders,
    menuOpenPath,
    now,
    openFilePaths,
    tree,
    updateStatuses,
    updatedFilePaths,
    updatedFolderPaths,
    onArchive,
    onFileManagementChange,
    onFolderManagementChange,
    onFolderToggle,
    onHiddenChange,
    onMenuOpenChange,
    onOpenFileWindowV2,
    onOpenSource,
    onPinnedChange,
    onShowInFolder,
  } = props;

  return (
    <ul className={depth === 0 ? 'tree-list root-tree' : 'tree-list'}>
      {tree.folders.map((folder) => {
        const expanded = expandedFolders.has(folder.key);

        return (
          <li className={`tree-folder ${expanded ? '' : 'closed'} ${updatedFolderPaths.has(folder.key) ? 'pending-update' : ''}`} key={folder.key}>
            <div className="tree-folder-head" style={{ paddingLeft: treeDepthPadding(depth) }}>
              <button
                className="tree-folder-row"
                type="button"
                onClick={() => onFolderToggle(folder.key)}
                title={folder.key}
              >
                <ChevronIcon expanded={expanded} />
                <FolderIcon />
                <span className="tree-folder-name">{folder.name}</span>
                {folder.lastActivityAt && (
                  <span className="activity-time" title={formatActivityDateTime(folder.lastActivityAt, locale)}>
                    {formatRelativeActivityTime(folder.lastActivityAt, now, locale)}
                  </span>
                )}
              </button>
              <FolderMenu
                relativePath={folder.key}
                managed
                menuOpen={menuOpenPath === folder.key}
                onManagementChange={onFolderManagementChange}
                onMenuOpenChange={onMenuOpenChange}
              />
            </div>
            {expanded && (
              <LauncherTree
                depth={depth + 1}
                expandedFolders={expandedFolders}
                menuOpenPath={menuOpenPath}
                now={now}
                openFilePaths={openFilePaths}
                tree={folder}
                updateStatuses={updateStatuses}
                updatedFilePaths={updatedFilePaths}
                updatedFolderPaths={updatedFolderPaths}
                onArchive={onArchive}
                onFileManagementChange={onFileManagementChange}
                onFolderManagementChange={onFolderManagementChange}
                onFolderToggle={onFolderToggle}
                onHiddenChange={onHiddenChange}
                onMenuOpenChange={onMenuOpenChange}
                onOpenFileWindowV2={onOpenFileWindowV2}
                onOpenSource={onOpenSource}
                onPinnedChange={onPinnedChange}
                onShowInFolder={onShowInFolder}
              />
            )}
          </li>
        );
      })}
      {tree.files.map((file) => (
        <ManagedFileItem
          depth={depth}
          file={file}
          fileName={fileNameWithoutMarkdownExtension(file.path)}
          key={file.path}
          menuOpen={menuOpenPath === file.path}
          open={openFilePaths.has(file.path)}
          updateStatus={updateStatuses[file.path]}
          updated={updatedFilePaths.has(file.path)}
          now={now}
          onArchive={onArchive}
          onManagementChange={onFileManagementChange}
          onHiddenChange={onHiddenChange}
          onMenuOpenChange={onMenuOpenChange}
          onOpenFileWindowV2={onOpenFileWindowV2}
          onOpenSource={onOpenSource}
          onPinnedChange={onPinnedChange}
          onShowInFolder={onShowInFolder}
        />
      ))}
    </ul>
  );
}

function WorkspaceBrowserTree(props: {
  relativeDirectory: string;
  depth: number;
  entriesByDirectory: Record<string, WorkspaceBrowseEntry[]>;
  expandedFolders: Set<string>;
  loadingDirectories: Set<string>;
  managedFileByPath: Map<string, ManagedFileState>;
  menuOpenPath: string | null;
  now: number;
  openFilePaths: Set<string>;
  query: string;
  updateStatuses: WorkspaceState['fileUpdateStatuses'];
  updatedFilePaths: Set<string>;
  updatedFolderPaths: Set<string>;
  onArchive: (relativePath: string) => void;
  onFileManagementChange: (relativePath: string, managed: boolean) => void;
  onFolderManagementChange: (relativePath: string, managed: boolean) => void;
  onFolderToggle: (folderKey: string) => void;
  onHiddenChange: (relativePath: string, hidden: boolean) => void;
  onMenuOpenChange: (relativePath: string, open: boolean) => void;
  onOpenFileWindowV2: (relativePath: string) => void;
  onOpenSource: (relativePath: string) => void;
  onPinnedChange: (relativePath: string, pinned: boolean) => void;
  onShowInFolder: (relativePath: string) => void;
}) {
  const { locale, t } = useI18n();
  const entries = props.entriesByDirectory[props.relativeDirectory] ?? [];
  const normalizedQuery = props.query.trim().toLowerCase();
  const visibleEntries = entries.filter((entry) => entry.kind === 'directory' || !normalizedQuery || entry.path.toLowerCase().includes(normalizedQuery));

  return (
    <ul className={props.depth === 0 ? 'tree-list root-tree' : 'tree-list'}>
      {visibleEntries.map((entry) => {
        if (entry.kind === 'directory') {
          const expanded = props.expandedFolders.has(entry.path);
          return (
            <li className={`tree-folder ${expanded ? '' : 'closed'} browse-${entry.management} ${entry.hidden ? 'browse-hidden' : ''} ${props.updatedFolderPaths.has(entry.path) ? 'pending-update' : ''}`} key={entry.path}>
              <div className="tree-folder-head" style={{ paddingLeft: treeDepthPadding(props.depth) }}>
                <button
                  className="tree-folder-row"
                  type="button"
                  onClick={() => props.onFolderToggle(entry.path)}
                  title={entry.path}
                >
                  <ChevronIcon expanded={expanded} />
                  <FolderIcon />
                  <span className="tree-folder-name">{entry.name}</span>
                  {entry.management !== 'managed' && (
                    <small className="browse-management-label">
                      {t(entry.management === 'partial' ? 'workspace.partiallyManaged' : 'workspace.unmanaged')}
                    </small>
                  )}
                  {entry.management === 'managed' && entry.lastActivityAt && (
                    <span className="activity-time" title={formatActivityDateTime(entry.lastActivityAt, locale)}>
                      {formatRelativeActivityTime(entry.lastActivityAt, props.now, locale)}
                    </span>
                  )}
                </button>
                <FolderMenu
                  relativePath={entry.path}
                  managed={entry.management === 'managed'}
                  menuOpen={props.menuOpenPath === entry.path}
                  onManagementChange={props.onFolderManagementChange}
                  onMenuOpenChange={props.onMenuOpenChange}
                />
              </div>
              {expanded && (
                props.loadingDirectories.has(entry.path) && !props.entriesByDirectory[entry.path] ? (
                  <p className="file-message browse-loading" style={{ paddingLeft: treeDepthPadding(props.depth + 1) }}>
                    {t('workspace.loadingProjectTree')}
                  </p>
                ) : (
                  <WorkspaceBrowserTree {...props} relativeDirectory={entry.path} depth={props.depth + 1} />
                )
              )}
            </li>
          );
        }

        const managedFile = props.managedFileByPath.get(entry.path.toLowerCase());
        if (managedFile) {
          return (
            <ManagedFileItem
              depth={props.depth}
              file={managedFile}
              fileName={fileNameWithoutMarkdownExtension(managedFile.path)}
              key={managedFile.path}
              menuOpen={props.menuOpenPath === managedFile.path}
              open={props.openFilePaths.has(managedFile.path)}
              updateStatus={props.updateStatuses[managedFile.path]}
              updated={props.updatedFilePaths.has(managedFile.path)}
              now={props.now}
              onArchive={props.onArchive}
              onManagementChange={props.onFileManagementChange}
              onHiddenChange={props.onHiddenChange}
              onMenuOpenChange={props.onMenuOpenChange}
              onOpenFileWindowV2={props.onOpenFileWindowV2}
              onOpenSource={props.onOpenSource}
              onPinnedChange={props.onPinnedChange}
              onShowInFolder={props.onShowInFolder}
            />
          );
        }

        return (
          <li className={`file-group unmanaged-file ${entry.hidden ? 'browse-hidden' : ''} ${props.menuOpenPath === entry.path ? 'menu-open' : ''}`} key={entry.path}>
            <div className="file-head" style={{ paddingLeft: treeDepthPadding(props.depth) }}>
              <span className="file-icon"><MarkdownFileIcon /></span>
              <div className="file-name">
                <strong title={entry.path}>{fileNameWithoutMarkdownExtension(entry.path)}</strong>
                <small className="file-meta">{t('workspace.unmanaged')}</small>
              </div>
              <FolderMenu
                relativePath={entry.path}
                managed={false}
                menuOpen={props.menuOpenPath === entry.path}
                onManagementChange={props.onFileManagementChange}
                onMenuOpenChange={props.onMenuOpenChange}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ManagedFileItem(props: {
  depth: number;
  file: ManagedFileState;
  fileName: string;
  menuOpen: boolean;
  open: boolean;
  updateStatus?: FileUpdateStatus;
  updated: boolean;
  now: number;
  onArchive: (relativePath: string) => void;
  onManagementChange: (relativePath: string, managed: boolean) => void;
  onHiddenChange: (relativePath: string, hidden: boolean) => void;
  onMenuOpenChange: (relativePath: string, open: boolean) => void;
  onOpenFileWindowV2: (relativePath: string) => void;
  onOpenSource: (relativePath: string) => void;
  onPinnedChange: (relativePath: string, pinned: boolean) => void;
  onShowInFolder: (relativePath: string) => void;
}) {
  const { locale, t } = useI18n();
  const {
    depth,
    file,
    fileName,
    menuOpen,
    open,
    updateStatus,
    updated,
    now,
    onArchive,
    onManagementChange,
    onHiddenChange,
    onMenuOpenChange,
    onOpenFileWindowV2,
    onOpenSource,
    onPinnedChange,
    onShowInFolder,
  } = props;
  const unavailable = file.status !== 'available';
  const runMenuAction = (action: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onMenuOpenChange(file.path, false);
    action();
  };

  return (
    <li className={`file-group ${unavailable ? 'unavailable' : ''} ${file.hidden ? 'hidden-file' : ''} ${open ? 'open-file' : ''} ${updated ? 'pending-update' : ''}`}>
      <div className="file-head" style={{ paddingLeft: treeDepthPadding(depth) }} onClick={() => onOpenFileWindowV2(file.path)}>
        <span className="file-icon"><MarkdownFileIcon /></span>
        <div className="file-name">
          <strong title={file.path}>{fileName}</strong>
          <small className="file-meta">
            {statusLabel(file, t)}
            {file.lastActivityAt && (
              <span className="activity-time" title={formatActivityDateTime(file.lastActivityAt, locale)}>
                {formatRelativeActivityTime(file.lastActivityAt, now, locale)}
              </span>
            )}
            {updateStatus && updateStatus.phase !== 'updating' && (
              <span className={`inline-update ${updateStatus.phase}`}>{fileUpdateLabel(updateStatus, t)}</span>
            )}
          </small>
        </div>
        <details
          className="file-actions file-menu"
          open={menuOpen}
          onClick={(event) => event.stopPropagation()}
          onToggle={(event) => onMenuOpenChange(file.path, event.currentTarget.open)}
        >
          <summary className="tiny-btn" title={t('file.actions')} aria-label={t('file.actions')}>
            <span className="file-menu-glyph" aria-hidden="true">•••</span>
          </summary>
          <div className="file-menu-panel">
            <button type="button" onClick={runMenuAction(() => onManagementChange(file.path, false))}>
              {t('scope.removeFromManagement')}
            </button>
            <button type="button" onClick={runMenuAction(() => onPinnedChange(file.path, !file.pinned))}>
              {file.pinned ? t('window.unpin') : t('window.pin')}
            </button>
            <button type="button" onClick={runMenuAction(() => onOpenSource(file.path))} disabled={unavailable}>
              {t('file.openSource')}
            </button>
            <button type="button" onClick={runMenuAction(() => onShowInFolder(file.path))} disabled={unavailable}>
              {t('file.showInExplorer')}
            </button>
            <button type="button" onClick={runMenuAction(() => onHiddenChange(file.path, !file.hidden))}>
              {file.hidden ? t('file.restore') : t('file.hide')}
            </button>
            <button className="danger-action" type="button" onClick={runMenuAction(() => onArchive(file.path))}>
              {t('file.archive')}
            </button>
          </div>
        </details>
      </div>
    </li>
  );
}

function LauncherSettings(props: {
  busy: boolean;
  section: SettingsSection;
  workflowCatalog: WorkflowPackageCatalog;
  workspaceReady: boolean;
  onBack: () => void;
  onCreateUserPackage: (name: string) => Promise<boolean>;
  onDeleteUserPackage: (packageId: string) => void;
  onImportFolderAsPackage: (name: string) => Promise<boolean>;
  onImportPackage: (
    source: 'bundled' | 'user',
    packageId: string,
    packageName: string,
    locale?: WorkflowPackageLocale,
  ) => void;
  onOpenBundledPackage: (packageId: string) => void;
  onOpenUserPackage: (packageId: string) => void;
  onRefreshPackages: () => void;
  onRestoreBundledPackage: (packageId: string) => void;
  onUpdateBundledPackage: (packageId: string) => void;
  onSelectSection: (section: SettingsSection) => void;
  theme: Theme;
  onThemeToggle: () => void;
}) {
  const { locale, setLocale, t } = useI18n();
  const [selectingPackageKey, setSelectingPackageKey] = useState<string | null>(null);
  const [creationMode, setCreationMode] = useState<'blank' | 'folder' | null>(null);
  const [draftName, setDraftName] = useState('');
  const {
    busy,
    section,
    workflowCatalog,
    workspaceReady,
    onBack,
    onCreateUserPackage,
    onDeleteUserPackage,
    onImportFolderAsPackage,
    onImportPackage,
    onOpenBundledPackage,
    onOpenUserPackage,
    onRefreshPackages,
    onRestoreBundledPackage,
    onUpdateBundledPackage,
    onSelectSection,
    theme,
    onThemeToggle,
  } = props;

  function startCreating(mode: 'blank' | 'folder') {
    setCreationMode(mode);
    setDraftName('');
  }

  async function submitPackageCreation() {
    const name = draftName.trim();

    if (!name || !creationMode) {
      return;
    }

    const created = creationMode === 'blank'
      ? await onCreateUserPackage(name)
      : await onImportFolderAsPackage(name);

    if (!created) {
      return;
    }

    setCreationMode(null);
    setDraftName('');
  }

  return (
    <section className="settings-page">
      <header className="settings-head">
        <button className="icon-btn" type="button" onClick={onBack} title={t('settings.back')} aria-label={t('settings.back')}>
          <BackIcon />
        </button>
        <div>
          <h1>{t('settings.title')}</h1>
        </div>
      </header>

      <nav className="settings-tabs" aria-label={t('settings.categories')} hidden>
        <button
          className={`settings-tab ${section === 'general' ? 'active' : ''}`}
          type="button"
          onClick={() => onSelectSection('general')}
        >
          {t('settings.general')}
        </button>
        <button
          className={`settings-tab ${section === 'workflow' ? 'active' : ''}`}
          type="button"
          onClick={() => onSelectSection('workflow')}
        >
          {t('settings.workflow')}
        </button>
        <button
          className={`settings-tab ${section === 'about' ? 'active' : ''}`}
          type="button"
          onClick={() => onSelectSection('about')}
        >
          {t('settings.about')}
        </button>
      </nav>

      <div className="settings-content">
        {section === 'general' && (
          <section className="settings-section">
            <h2>{t('settings.general')}</h2>
            <label className="settings-field settings-language-field">
              <span>{t('settings.language')}</span>
              <select
                value={locale}
                onChange={(event) => void setLocale(event.target.value as AppLocale)}
              >
                <option value="zh-CN">{t('settings.languageChinese')}</option>
                <option value="en">{t('settings.languageEnglish')}</option>
              </select>
              <small>{t('settings.languageDescription')}</small>
            </label>
            <label className="settings-field">
              <span>{t('settings.theme')}</span>
              <button type="button" onClick={onThemeToggle}>{theme === 'dark' ? t('settings.themeLight') : t('settings.themeDark')}</button>
            </label>
          </section>
        )}

        {section === 'workflow' && (
          <section className="settings-section workflow-settings">
            <div className="settings-section-head workflow-library-head">
              <div>
                <h2>{t('workflow.title')}</h2>
                <p>{t('workflow.libraryDescription')}</p>
              </div>
              <div className="workflow-actions">
                <button className="toolbar-btn" type="button" onClick={onRefreshPackages} disabled={busy}>
                  {t('workflow.refreshPackages')}
                </button>
                <button className="toolbar-btn" type="button" onClick={() => startCreating('blank')} disabled={busy}>
                  {t('workflow.newPackage')}
                </button>
                <button className="toolbar-btn" type="button" onClick={() => startCreating('folder')} disabled={busy}>
                  {t('workflow.addFromFolder')}
                </button>
              </div>
            </div>

            {creationMode && (
              <div className="workflow-package-creation">
                <strong>{creationMode === 'blank' ? t('workflow.createPackage') : t('workflow.addFromFolder')}</strong>
                <input
                  type="text"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder={t('workflow.packageNamePlaceholder')}
                  autoFocus
                />
                <div className="workflow-actions">
                  <button className="primary-btn" type="button" onClick={() => void submitPackageCreation()} disabled={busy || !draftName.trim()}>
                    {creationMode === 'blank' ? t('workflow.createAndOpenPackage') : t('workflow.chooseFolder')}
                  </button>
                  <button className="toolbar-btn" type="button" onClick={() => setCreationMode(null)} disabled={busy}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}

            <div className="workflow-library-section">
              <div className="workflow-subsection-head">
                <h3>{t('workflow.bundledPackages')}</h3>
                <p>{t('workflow.bundledPackagesLibraryDescription')}</p>
              </div>
              <div className="workflow-package-grid">
                {workflowCatalog.bundled.map((workflow) => {
                  const packageName = bundledWorkflowPackageName(workflow.id, t);
                  const packageKey = `bundled:${workflow.id}`;

                  return (
                  <article className="workflow-package-card" key={workflow.id}>
                    <div className="workflow-package-copy">
                      <div className="workflow-package-title">
                        <h4>{packageName}</h4>
                        <span>{t('workflow.builtinBadge')}</span>
                        {workflow.updateAvailable && <span className="workflow-update-badge">{t('workflow.updateAvailable')}</span>}
                      </div>
                      <p>{bundledWorkflowPackageDescription(workflow.id, t)}</p>
                      {workflow.updateAvailable && (
                        <p className="workflow-update-note">
                          {t(workflow.hasLocalChanges
                            ? 'workflow.updateAvailableWithLocalChanges'
                            : 'workflow.updateAvailableDescription')}
                        </p>
                      )}
                    </div>
                    <div className="workflow-language-tags" aria-label={t('workflow.supportedLanguages')}>
                      {workflow.locales.map((supportedLocale) => (
                        <span key={supportedLocale}>{workflowLocaleLabel(supportedLocale, t)}</span>
                      ))}
                    </div>
                    <WorkflowPackageFiles
                      locales={workflow.locales}
                      filesByLocale={workflow.filesByLocale}
                    />
                    {selectingPackageKey === packageKey ? (
                      <div className="workflow-language-picker">
                        <strong>{t('workflow.chooseLanguage')}</strong>
                        <div className="workflow-actions">
                          {workflow.locales.map((supportedLocale) => (
                            <button
                              className="primary-btn"
                              type="button"
                              key={supportedLocale}
                              disabled={busy || !workspaceReady}
                              onClick={() => {
                                setSelectingPackageKey(null);
                                onImportPackage('bundled', workflow.id, packageName, supportedLocale);
                              }}
                            >
                              {workflowLocaleLabel(supportedLocale, t)}
                            </button>
                          ))}
                          <button className="toolbar-btn" type="button" onClick={() => setSelectingPackageKey(null)} disabled={busy}>
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="workflow-actions">
                        <button
                          className="primary-btn"
                          type="button"
                          onClick={() => setSelectingPackageKey(packageKey)}
                          disabled={busy || !workspaceReady}
                        >
                          {t('workflow.importToRepository')}
                        </button>
                        <button className="toolbar-btn" type="button" onClick={() => onOpenBundledPackage(workflow.id)} disabled={busy}>
                          {t('workflow.openFolder')}
                        </button>
                        {workflow.updateAvailable && (
                          <button className="toolbar-btn workflow-update-action" type="button" onClick={() => onUpdateBundledPackage(workflow.id)} disabled={busy}>
                            {t('workflow.updatePackage')}
                          </button>
                        )}
                        <button className="toolbar-btn danger-action" type="button" onClick={() => onRestoreBundledPackage(workflow.id)} disabled={busy}>
                          {t('workflow.restorePackage')}
                        </button>
                      </div>
                    )}
                  </article>
                  );
                })}
              </div>
            </div>

            <div className="workflow-library-section workflow-user-library">
              <div className="workflow-subsection-head">
                <h3>{t('workflow.myPackages')}</h3>
                <p>{t('workflow.myPackagesDescription')}</p>
              </div>
              {workflowCatalog.user.length === 0 ? (
                <p className="workflow-empty-library">{t('workflow.noUserPackages')}</p>
              ) : (
                <div className="workflow-package-grid">
                  {workflowCatalog.user.map((workflow) => (
                    <article className="workflow-package-card" key={workflow.id}>
                      <div className="workflow-package-copy">
                        <div className="workflow-package-title">
                          <h4>{workflow.name}</h4>
                          <span>{t('workflow.userBadge')}</span>
                        </div>
                        <p>{t('workflow.userPackageDescription')}</p>
                      </div>
                      <UserWorkflowPackageFiles files={workflow.files} />
                      <div className="workflow-actions">
                        <button
                          className="primary-btn"
                          type="button"
                          onClick={() => onImportPackage('user', workflow.id, workflow.name)}
                          disabled={busy || !workspaceReady}
                        >
                          {t('workflow.importToRepository')}
                        </button>
                        <button className="toolbar-btn" type="button" onClick={() => onOpenUserPackage(workflow.id)} disabled={busy}>
                          {t('workflow.openFolder')}
                        </button>
                        <button className="toolbar-btn danger-action" type="button" onClick={() => onDeleteUserPackage(workflow.id)} disabled={busy}>
                          {t('workflow.deletePackage')}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {section === 'about' && (
          <section className="settings-section">
            <h2>{t('settings.about')}</h2>
            <p>Worktrace</p>
          </section>
        )}
      </div>
    </section>
  );
}

function bundledWorkflowPackageName(packageId: string, t: I18nContextValue['t']): string {
  return packageId === 'workboard' ? t('workflow.package.workboard.name') : packageId;
}

function WorkflowPackageFiles(props: {
  locales: WorkflowPackageLocale[];
  filesByLocale: Partial<Record<WorkflowPackageLocale, WorkflowPackageFile[]>>;
}) {
  const { locales, filesByLocale } = props;
  const { t } = useI18n();
  const fileCount = locales.reduce((count, locale) => count + (filesByLocale[locale]?.length ?? 0), 0);

  return (
    <details className="workflow-package-files">
      <summary>
        <span>{t('workflow.packageFiles')}</span>
        <small>{t('workflow.fileCount', { count: fileCount })}</small>
      </summary>
      <div className="workflow-package-file-groups">
        {locales.map((locale) => {
          const files = filesByLocale[locale] ?? [];

          return (
            <section className="workflow-package-file-group" key={locale}>
              <h5>{workflowLocaleLabel(locale, t)}</h5>
              {files.length === 0 ? (
                <p>{t('workflow.noPackageFiles')}</p>
              ) : (
                <ul>
                  {files.map((file) => (
                    <li key={file.path}>
                      <span>{file.path}</span>
                      <small>{formatFileSize(file.size)}</small>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </details>
  );
}

function UserWorkflowPackageFiles(props: { files: WorkflowPackageFile[] }) {
  const { files } = props;
  const { t } = useI18n();

  return (
    <details className="workflow-package-files">
      <summary>
        <span>{t('workflow.packageFiles')}</span>
        <small>{t('workflow.fileCount', { count: files.length })}</small>
      </summary>
      <div className="workflow-package-file-groups">
        <section className="workflow-package-file-group">
          {files.length === 0 ? (
            <p>{t('workflow.noPackageFiles')}</p>
          ) : (
            <ul>
              {files.map((file) => (
                <li key={file.path}>
                  <span>{file.path}</span>
                  <small>{formatFileSize(file.size)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}

function bundledWorkflowPackageDescription(packageId: string, t: I18nContextValue['t']): string {
  return packageId === 'workboard'
    ? t('workflow.package.workboard.description')
    : t('workflow.package.genericDescription');
}

function workflowLocaleLabel(locale: WorkflowPackageLocale, t: I18nContextValue['t']): string {
  return locale === 'zh-CN' ? t('settings.languageChinese') : t('settings.languageEnglish');
}

function FileWindowV2App(props: { relativePath: string }) {
  const { relativePath } = props;
  const { theme } = useTheme();
  const { locale, t } = useI18n();
  const now = useRelativeTimeTick();
  const [payload, setPayload] = useState<FileWindowV2InitialPayload | null>(null);
  const [loadState, setLoadState] = useState<ModuleLoadState>('loading');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [activeModuleKey, setActiveModuleKey] = useState<string | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState<FileWindowV2FileUpdatePayload | undefined>();
  const [clearBusy, setClearBusy] = useState<'module' | 'file' | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());
  const [todoNotesExpanded, setTodoNotesExpanded] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedMarker, setSelectedMarker] = useState<string | undefined>();
  const [selectedTodoStatus, setSelectedTodoStatus] = useState<string | undefined>();
  const [selectedTodoTag, setSelectedTodoTag] = useState<string | undefined>();
  const [todoQuery, setTodoQuery] = useState('');
  const [activeTodoView, setActiveTodoView] = useState<'board' | 'timeline' | 'calendar' | 'statistics'>('board');
  const [statisticsPeriod, setStatisticsPeriod] = useState<'week' | 'month'>('week');
  const [showTodoViewMenu, setShowTodoViewMenu] = useState(false);
  const [showTodoFilters, setShowTodoFilters] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState<string | undefined>();
  const [calendarDateMode, setCalendarDateMode] = useState<'created' | 'completed'>('created');
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [draftEventIds, setDraftEventIds] = useState<Set<string>>(() => new Set());
  const [eventSaveState, setEventSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showMarkerSettings, setShowMarkerSettings] = useState(false);
  const markerFilterDragRef = useRef<{ startX: number; scrollLeft: number } | null>(null);
  const contentScrollRef = useRef<HTMLElement>(null);
  const payloadRef = useRef<FileWindowV2InitialPayload | null>(null);
  const activeModuleKeyRef = useRef<string | null>(null);
  const eventMutationCountRef = useRef(0);
  const eventUndoRef = useRef<EventDocument[]>([]);
  const eventRedoRef = useRef<EventDocument[]>([]);
  const eventOperationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const todoViewPickerRef = useRef<HTMLDivElement>(null);
  const todoFilterTriggerRef = useRef<HTMLButtonElement>(null);
  const todoFilterPanelRef = useRef<HTMLElement>(null);
  const markerSettingsRef = useRef<HTMLDivElement>(null);
  const activeModule = payload ? selectFileWindowV2Module(payload.modules, activeModuleKey) : null;

  useEffect(() => {
    if (!showTodoViewMenu && !showTodoFilters && !showMarkerSettings) return;
    const closeOutsideMenus = (event: PointerEvent) => {
      const target = event.target as Node;
      if (showTodoViewMenu && !todoViewPickerRef.current?.contains(target)) setShowTodoViewMenu(false);
      if (showTodoFilters && !todoFilterTriggerRef.current?.contains(target) && !todoFilterPanelRef.current?.contains(target)) setShowTodoFilters(false);
      if (showMarkerSettings && !markerSettingsRef.current?.contains(target)) setShowMarkerSettings(false);
    };
    document.addEventListener('pointerdown', closeOutsideMenus);
    return () => document.removeEventListener('pointerdown', closeOutsideMenus);
  }, [showMarkerSettings, showTodoFilters, showTodoViewMenu]);

  useEffect(() => {
    let disposed = false;

    function applyPayload(nextPayload: FileWindowV2InitialPayload, initial: boolean) {
      const previousModuleKey = activeModuleKeyRef.current;
      const nextActiveModuleKey = initial
        ? nextPayload.initialModuleKey
        : resolveFileWindowV2ActiveModuleKey(
            payloadRef.current?.modules ?? [],
            previousModuleKey,
            nextPayload.modules,
          );

      const mergedPayload = mergeFileWindowV2Payload(payloadRef.current, nextPayload);

      // 真实内容刷新或模块切换时，全部折叠
      setExpandedKeys(new Set());
      setExpandedEventIds((current) => {
        const validIds = new Set(nextPayload.eventDocument ? flattenTodoEventsFromDocument(nextPayload.eventDocument).map((event) => event.id) : []);
        return new Set([...current].filter((id) => validIds.has(id)));
      });

      payloadRef.current = mergedPayload;
      activeModuleKeyRef.current = nextActiveModuleKey;
      setPayload(mergedPayload);
      setPendingUpdates(mergedPayload.pendingUpdates);
      setActiveModuleKey(nextActiveModuleKey);

      // 只在 activeModuleKey 实际变化时写入状态
      if (nextActiveModuleKey !== previousModuleKey) {
        void window.workboard.updateFileWindowV2State(relativePath, { activeModuleKey: nextActiveModuleKey });
      }
    }

    async function loadPayload() {
      try {
        const [nextPayload, uiState] = await Promise.all([
          window.workboard.getFileWindowV2InitialPayload(relativePath),
          window.workboard.getWorkspaceUiState(),
        ]);

        if (disposed) {
          return;
        }

        if (nextPayload) {
          applyPayload(nextPayload, true);
          const stored = uiState.fileWindowsV2[nextPayload.relativePath];
          const allEventIds = nextPayload.eventDocument
            ? flattenTodoEventsFromDocument(nextPayload.eventDocument).map((event) => event.id)
            : [];
          setExpandedEventIds(new Set(stored?.expandedEventIds?.filter((id) => allEventIds.includes(id)) ?? allEventIds));
          setScrollTop(stored?.scrollTop ?? 0);
        } else {
          payloadRef.current = null;
          activeModuleKeyRef.current = null;
          setPayload(null);
          setPendingUpdates(undefined);
          setActiveModuleKey(null);
        }
        setLoadState(nextPayload ? 'ready' : 'unavailable');
        setNotice(nextPayload ? null : { kind: 'error', text: t('fileWindow.unavailableNotice') });
      } catch (error) {
        if (!disposed) {
          setLoadState('unavailable');
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('fileWindow.loadFailed') });
        }
      }
    }

    void loadPayload();
    void window.workboard.getCurrentWindowAlwaysOnTop().then((actual) => {
      if (!disposed) {
        setAlwaysOnTop(actual);
      }
    });

    const unsubscribe = window.workboard.onFileWindowV2FileChanged((nextPayload) => {
      if (disposed || nextPayload.relativePath !== relativePath) {
        return;
      }

      applyPayload(nextPayload, false);
      setLoadState('ready');
      setNotice(null);
    });
    const unsubscribePendingUpdates = window.workboard.onFileWindowV2PendingUpdatesChanged((nextPendingUpdates) => {
      if (disposed || nextPendingUpdates.relativePath !== relativePath) {
        return;
      }

      const hasModules = Object.keys(nextPendingUpdates.modules).length > 0;

      if (!hasModules && !nextPendingUpdates.structureChanged) {
        setPendingUpdates(undefined);
        setClearBusy(null);
        setNotice(null);
        return;
      }

      setPendingUpdates(nextPendingUpdates);
      setClearBusy(null);
      setNotice(null);
    });

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribePendingUpdates();
    };
  }, [relativePath]);

  function toggleHeading(headingKey: string) {
    setExpandedKeys((current) => {
      const next = new Set(current);

      if (next.has(headingKey)) {
        next.delete(headingKey);
      } else {
        next.add(headingKey);
      }

      return next;
    });
  }

  function toggleTodoEvent(eventId: string) {
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      void window.workboard.updateFileWindowV2State(relativePath, { expandedEventIds: [...next] });
      return next;
    });
  }

  function handleContentScroll(event: React.UIEvent<HTMLElement>) {
    const nextScrollTop = event.currentTarget.scrollTop;
    setScrollTop(nextScrollTop);
    void window.workboard.updateFileWindowV2State(relativePath, { scrollTop: nextScrollTop });
  }

  useEffect(() => {
    if (!contentScrollRef.current) {
      return;
    }
    contentScrollRef.current.scrollTop = scrollTop;
  }, [activeModuleKey, scrollTop]);

  function selectActiveModule(moduleKey: string) {
    activeModuleKeyRef.current = moduleKey;
    setActiveModuleKey(moduleKey);
    setExpandedKeys(new Set());
    setSelectedMarker(undefined);
    setSelectedTodoStatus(undefined);
    setSelectedTodoTag(undefined);
    setTodoQuery('');
    setShowTodoViewMenu(false);
    setEditingEventId(null);
    void window.workboard.updateFileWindowV2State(relativePath, { activeModuleKey: moduleKey });
  }

  function toggleAllHeadings() {
    setExpandedKeys(allHeadingsExpanded ? new Set() : new Set(expandableHeadingKeys));
  }

  async function updateMarkerColor(markerName: string, color: string | null) {
    if (!activeModule) {
      return;
    }

    const currentColor = activeModule.markerStats.find((stat) => stat.name === markerName)?.color;
    const nextColor = color ?? randomMarkerColor(currentColor);

    try {
      await window.workboard.setMarkerColor(relativePath, markerName, nextColor);
      setPayload((current) => {
        if (!current) {
          return current;
        }

        const nextPayload = {
          ...current,
          modules: current.modules.map((module) => {
            if (module.moduleKey !== activeModule.moduleKey) {
              return module;
            }

            return {
              ...module,
              markerColors: nextColor
                ? { ...module.markerColors, [markerName]: nextColor }
                : module.markerColors,
              markerStats: module.markerStats.map((stat) =>
                stat.name === markerName ? { ...stat, color: nextColor } : stat,
              ),
            };
          }),
        };

        payloadRef.current = nextPayload;
        return nextPayload;
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('module.markerColorUpdateFailed') });
    }
  }

  async function toggleAlwaysOnTop() {
    const actual = await window.workboard.setCurrentWindowAlwaysOnTop(!alwaysOnTop);
    setAlwaysOnTop(actual);
  }

  async function clearCurrentModuleUpdates() {
    if (!activeModule) {
      return;
    }

    setClearBusy('module');
    setNotice(null);

    try {
      await window.workboard.clearFileWindowV2ModuleUpdates(relativePath, activeModule.moduleKey);
    } catch (error) {
      setClearBusy(null);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('module.clearUpdatesFailed') });
    }
  }

  async function clearHeadingUpdate(headingKey: string) {
    if (!activeModule) {
      return;
    }

    setClearBusy('module');
    setNotice(null);

    try {
      await window.workboard.clearFileWindowV2HeadingUpdate(relativePath, activeModule.moduleKey, headingKey);
    } catch (error) {
      setClearBusy(null);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('module.clearHeadingFailed') });
    }
  }

  async function clearCurrentFileUpdates() {
    setClearBusy('file');
    setNotice(null);

    try {
      await window.workboard.clearFileWindowV2FileUpdates(relativePath);
    } catch (error) {
      setClearBusy(null);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('module.clearFileFailed') });
    }
  }

  const updatedModuleKeys = useMemo(() => deriveUpdatedModuleKeys(pendingUpdates), [pendingUpdates]);
  const expandableHeadingKeys = useMemo(
    () => (activeModule ? collectExpandableHeadingKeys(activeModule.headings) : []),
    [activeModule],
  );
  const allHeadingsExpanded =
    expandableHeadingKeys.length > 0 && expandableHeadingKeys.every((headingKey) => expandedKeys.has(headingKey));
  const changedHeadingKeys = useMemo(
    () => (activeModule ? deriveChangedHeadingKeys(pendingUpdates, activeModule.moduleKey) : new Set<string>()),
    [activeModule, pendingUpdates],
  );
  const hasCurrentModuleUpdates = activeModule
    ? hasPendingModuleUpdates(pendingUpdates, activeModule.moduleKey)
    : false;
  const hasFileUpdates = hasPendingFileUpdates(pendingUpdates);
  const leadingBodyChanged = activeModule ? hasModuleBodyUpdate(pendingUpdates, activeModule.moduleKey) : false;
  const moduleHeadingCount = activeModule ? countRenderedHeadings(activeModule.headings) : 0;
  const moduleWordCount = activeModule ? countModuleWords(activeModule) : 0;
  const moduleLastUpdated = payload?.lastActivityAt;
  const visibleHeadings = activeModule && selectedMarker
    ? filterHeadingsByMarker(activeModule.headings, selectedMarker)
    : activeModule?.headings ?? [];
  const activeTodoRole = activeModule ? todoModuleRole(activeModule.title) : undefined;
  const todoRoots = payload?.eventDocument && activeTodoRole
    ? payload.eventDocument[activeTodoRole]
    : [];
  const todoEvents = todoRoots.flatMap((root) => flattenTodoEvents(root));
  const allTodoEvents = payload?.eventDocument
    ? [...payload.eventDocument.current, ...payload.eventDocument.closed].flatMap((root) => flattenTodoEvents(root))
    : [];
  const visibleTodoRoots = useMemo(
    () => filterTodoEvents(todoRoots, { status: selectedTodoStatus, tag: selectedTodoTag, query: todoQuery }),
    [todoRoots, selectedTodoStatus, selectedTodoTag, todoQuery],
  );
  const todoStatusCounts = useMemo(() => countTodoEventsByStatus(todoRoots), [todoRoots]);
  const todoTags = useMemo(() => collectTodoTags(todoRoots), [todoRoots]);
  const statisticsEvents = useMemo(() => allTodoEvents.filter((event) => {
    if (!todoEventInStatisticsPeriod(event, statisticsPeriod)) return false;
    if (selectedTodoStatus && event.status !== selectedTodoStatus) return false;
    if (selectedTodoTag && !event.tags.includes(selectedTodoTag)) return false;
    const query = todoQuery.trim().toLowerCase();
    return !query || `${event.title} ${event.note} ${event.tags.join(' ')}`.toLowerCase().includes(query);
  }), [allTodoEvents, selectedTodoStatus, selectedTodoTag, statisticsPeriod, todoQuery]);
  const statisticsStatusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of statisticsEvents) counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
    return counts;
  }, [statisticsEvents]);
  const todoLocations = useMemo(() => buildTodoEventLocations(todoRoots), [todoRoots]);
  function queueEventOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = eventOperationQueueRef.current.then(operation);
    eventOperationQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }

  async function performEventMutation(request: Parameters<Window['workboard']['mutateEvent']>[1]): Promise<FileWindowV2InitialPayload | null> {
    setNotice(null);
    eventMutationCountRef.current += 1;
    setEventSaveState('saving');
    const before = payloadRef.current?.eventDocument;
    try {
      const next = await window.workboard.mutateEvent(relativePath, request);
      if (next) {
        payloadRef.current = next;
        setPayload(next);
        setPendingUpdates(next.pendingUpdates);
        if (before && request.kind !== 'restore-document') {
          eventUndoRef.current.push(JSON.parse(JSON.stringify(before)) as EventDocument);
          eventRedoRef.current = [];
        }
      }
      eventMutationCountRef.current -= 1;
      if (eventMutationCountRef.current === 0) {
        setEventSaveState('saved');
      }
      return next;
    } catch (error) {
      eventMutationCountRef.current = Math.max(0, eventMutationCountRef.current - 1);
      setEventSaveState('error');
      setNotice({ kind: 'error', text: t('todo.saveFailed') });
      console.error('[todo] Failed to save event mutation:', error);
      return null;
    }
  }

  function mutateEvent(request: Parameters<Window['workboard']['mutateEvent']>[1]): Promise<FileWindowV2InitialPayload | null> {
    return queueEventOperation(() => performEventMutation(request));
  }

  function undoEventMutation(): Promise<void> {
    return queueEventOperation(async () => {
      const current = payloadRef.current?.eventDocument;
      const previous = eventUndoRef.current.at(-1);
      if (!current || !previous) return;
      const restored = await performEventMutation({ kind: 'restore-document', document: previous });
      if (!restored) return;
      eventUndoRef.current.pop();
      eventRedoRef.current.push(JSON.parse(JSON.stringify(current)) as EventDocument);
    });
  }

  function redoEventMutation(): Promise<void> {
    return queueEventOperation(async () => {
      const current = payloadRef.current?.eventDocument;
      const next = eventRedoRef.current.at(-1);
      if (!current || !next) return;
      const restored = await performEventMutation({ kind: 'restore-document', document: next });
      if (!restored) return;
      eventRedoRef.current.pop();
      eventUndoRef.current.push(JSON.parse(JSON.stringify(current)) as EventDocument);
    });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || (event.key.toLowerCase() !== 'z' && event.key.toLowerCase() !== 'y')) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      if (event.key.toLowerCase() === 'z' && !event.shiftKey) void undoEventMutation();
      else void redoEventMutation();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function moveTodoEventByDrop(sourceId: string, targetId: string, position: 'before' | 'after' | 'inside') {
    if (sourceId === targetId) return;
    const source = todoEvents.find((event) => event.id === sourceId);
    const target = todoEvents.find((event) => event.id === targetId);
    const targetLocation = todoLocations.get(targetId);
    if (!source || !target || !targetLocation || containsTodoEvent(source, targetId)) return;
    const parentId = position === 'inside' ? targetId : targetLocation.parentId;
    let index = position === 'inside' ? target.children.length : targetLocation.index + (position === 'after' ? 1 : 0);
    const sourceLocation = todoLocations.get(sourceId);
    if (sourceLocation && sourceLocation.parentId === parentId && sourceLocation.index < index) index -= 1;
    await mutateEvent({ kind: 'move', eventId: sourceId, parentId, index });
  }

  async function createRootEvent() {
    if (!payload?.eventDocument) return;
    const previousIds = new Set(flattenTodoEventsFromDocument(payload.eventDocument).map((event) => event.id));
    const next = await mutateEvent({ kind: 'create', title: t('todo.untitledRoot') });
    const created = next?.eventDocument
      ? flattenTodoEventsFromDocument(next.eventDocument).find((event) => !previousIds.has(event.id))
      : undefined;
    if (created) {
      setDraftEventIds((current) => new Set(current).add(created.id));
      setEditingEventId(created.id);
    }
  }

  function selectTodoView(viewKey: 'board' | 'timeline' | 'calendar' | 'statistics') {
    setActiveTodoView(viewKey);
    setShowTodoViewMenu(false);
    setNotice(null);
  }

  function clearTodoFilters() {
    setSelectedTodoStatus(undefined);
    setSelectedTodoTag(undefined);
    setTodoQuery('');
    setShowTodoFilters(false);
  }

  function handleMarkerFilterWheel(event: React.WheelEvent<HTMLElement>) {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.currentTarget.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }

  function handleMarkerFilterPointerDown(event: React.PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button')) {
      return;
    }

    markerFilterDragRef.current = {
      startX: event.clientX,
      scrollLeft: event.currentTarget.scrollLeft,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleMarkerFilterPointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = markerFilterDragRef.current;
    if (!drag) {
      return;
    }

    event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
  }

  function handleMarkerFilterPointerEnd(event: React.PointerEvent<HTMLElement>) {
    markerFilterDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <main className="app-shell desktop-shell" data-theme={theme}>
      <section className="window-shell module-window file-window-v2 focused">
        <header className="titlebar" onDoubleClick={() => window.workboard.controlCurrentWindow('toggle-maximize')}>
          {payload?.eventDocument ? <>
            <div className="todo-titlebar-name"><strong>{payload.displayName.replace(/\.md$/i, '')}</strong></div>
            <div className="todo-titlebar-tools">
              <label className="todo-search-field">
                <span aria-hidden="true">⌕</span>
                <input value={todoQuery} onChange={(event) => setTodoQuery(event.target.value)} placeholder={t('todo.searchPlaceholder')} aria-label={t('todo.search')} />
                {todoQuery && <button type="button" onClick={() => setTodoQuery('')} aria-label={t('todo.clearSearch')}>×</button>}
              </label>
              <div className="todo-view-picker" ref={todoViewPickerRef}>
                <button className="todo-view-picker-trigger" type="button" aria-label={t('todo.views')} aria-expanded={showTodoViewMenu} onClick={() => setShowTodoViewMenu((current) => !current)}><span>{t('todo.views')}</span><i aria-hidden="true">⌄</i></button>
                {showTodoViewMenu && <div className="todo-view-picker-menu" role="menu">
                  {(['board', 'calendar', 'timeline', 'statistics'] as const).map((viewKey) => (
                    <button className={activeTodoView === viewKey ? 'active' : ''} key={viewKey} type="button" role="menuitem" onClick={() => selectTodoView(viewKey)}>
                      <span>{activeTodoView === viewKey ? '✓' : ''}</span>{t(`todo.view.${viewKey}`)}
                    </button>
                  ))}
                </div>}
              </div>
            </div>
          </> : <>
            <AppLogo />
            <div className="title-copy"><strong>{payload?.displayName ?? 'FileWindowV2'}</strong></div>
          </>}
          <button
            className={`win-btn pin ${alwaysOnTop ? 'active' : ''}`}
            type="button"
            onClick={toggleAlwaysOnTop}
            title={alwaysOnTop ? t('window.unpin') : t('window.pin')}
            aria-pressed={alwaysOnTop}
          >
            <PinIcon />
          </button>
          <WindowControls />
        </header>

        {notice && <p className={`notice ${notice.kind}`}>{notice.text}</p>}

        {loadState === 'loading' ? (
          <section className="empty-state">
            <h2>{t('fileWindow.loadingTitle')}</h2>
            <p>{t('fileWindow.loadingDescription')}</p>
          </section>
        ) : activeModule && payload ? (
          <>
            {payload.eventDocument ? (
              <section className="todo-command-shell">
                {activeTodoView === 'calendar' ? <div className="todo-primary-row todo-calendar-mode-row">
                  <nav className="todo-scope-tabs todo-calendar-mode-tabs" aria-label={t('todo.view.calendar')}>
                    <button className={`todo-scope-tab ${calendarDateMode === 'created' ? 'active' : ''}`} type="button" onClick={() => setCalendarDateMode('created')}>
                      <span>{t('todo.calendarModeCreated')}</span>
                    </button>
                    <button className={`todo-scope-tab ${calendarDateMode === 'completed' ? 'active' : ''}`} type="button" onClick={() => setCalendarDateMode('completed')}>
                      <span>{t('todo.calendarModeCompleted')}</span>
                    </button>
                  </nav>
                </div> : <>
                  <div className="todo-primary-row">
                    {activeTodoView === 'timeline' ? <div className="todo-projection-context">
                      <h2>{t('todo.timelineTitle')}</h2>
                      <p>{t('todo.timelineDescription')}</p>
                    </div> : activeTodoView === 'statistics' ? <nav className="todo-scope-tabs" aria-label={t('todo.statisticsPeriod')}>
                      <button className={`todo-scope-tab ${statisticsPeriod === 'week' ? 'active' : ''}`} type="button" onClick={() => setStatisticsPeriod('week')}>{t('todo.periodWeek')}</button>
                      <button className={`todo-scope-tab ${statisticsPeriod === 'month' ? 'active' : ''}`} type="button" onClick={() => setStatisticsPeriod('month')}>{t('todo.periodMonth')}</button>
                    </nav> : <nav className="todo-scope-tabs" aria-label={t('fileWindow.modules')}>
                    {(['current', 'closed'] as const).map((role) => {
                      const module = payload.modules.find((candidate) => todoModuleRole(candidate.title) === role);
                      if (!module) return null;
                      const count = countTodoEvents(payload.eventDocument![role]);
                      return <button
                        className={`todo-scope-tab ${activeTodoRole === role ? 'active' : ''}`}
                        key={role}
                        type="button"
                        onClick={() => selectActiveModule(module.moduleKey)}
                        aria-current={activeTodoRole === role ? 'page' : undefined}
                      >
                        <span>{t(role === 'current' ? 'todo.scope.current' : 'todo.scope.closed')}</span>
                        <small>{t('todo.scopeCount', { count })}</small>
                      </button>;
                    })}
                    </nav>}
                    {activeTodoView !== 'timeline' && activeTodoView !== 'statistics' && <div className="todo-primary-actions">
                    <button
                      className="todo-expand-all"
                      type="button"
                      onClick={() => setTodoNotesExpanded((current) => !current)}
                      title={todoNotesExpanded ? t('todo.collapseNotes') : t('todo.expandNotes')}
                      aria-label={todoNotesExpanded ? t('todo.collapseNotes') : t('todo.expandNotes')}
                    >
                      <CollapseTreeIcon expanded={todoNotesExpanded} />
                    </button>
                    {activeTodoRole === 'current' && <button className="todo-add-root" type="button" aria-label={t('todo.addEvent')} onClick={() => void createRootEvent()}>
                      <span aria-hidden="true">＋</span>{t('todo.addEvent')}
                    </button>}
                    <button ref={todoFilterTriggerRef} className={`todo-filter-trigger ${showTodoFilters ? 'active' : ''}`} type="button" onClick={() => setShowTodoFilters((current) => !current)} aria-expanded={showTodoFilters}>
                      {t('todo.filter')}
                    </button>
                    </div>}
                  </div>
                  {activeTodoView !== 'timeline' && <section className="todo-status-overview" aria-label={t('todo.statusOverview')}>
                  <button
                    className={`todo-status-filter ${selectedTodoStatus ? '' : 'active'}`}
                    type="button"
                    onClick={() => setSelectedTodoStatus(undefined)}
                  >
                    {t('todo.statusAll')} <strong>{activeTodoView === 'statistics' ? statisticsEvents.length : todoEvents.length}</strong>
                  </button>
                  {(payload.eventDocument.statusDefinitions ?? [])
                    .filter((definition) => (activeTodoView === 'statistics' || definition.category === activeTodoRole) && ((activeTodoView === 'statistics' ? statisticsStatusCounts : todoStatusCounts).get(definition.name) ?? 0) > 0)
                    .map((definition) => (
                      <button
                        className={`todo-status-filter ${selectedTodoStatus === definition.name ? 'active' : ''}`}
                        key={definition.name}
                        type="button"
                        onClick={() => setSelectedTodoStatus(definition.name)}
                        aria-label={t('todo.statusFilter', { status: todoStatusLabel(definition.name, t) })}
                        style={{ '--todo-status-color': todoStatusColor(definition.name, activeModule.markerColors) } as React.CSSProperties}
                      >
                        <span className="todo-status-dot" aria-hidden="true" />{todoStatusLabel(definition.name, t)} <strong>{(activeTodoView === 'statistics' ? statisticsStatusCounts : todoStatusCounts).get(definition.name)}</strong>
                      </button>
                    ))}
                  </section>}
                </>}
                {showTodoFilters && <section ref={todoFilterPanelRef} className="todo-filter-panel" aria-label={t('todo.filter')}>
                  <div>
                    <strong>{t('todo.filterByTag')}</strong>
                    <div className="todo-tag-filter-list">
                      {todoTags.length ? todoTags.map((tag) => <button className={selectedTodoTag === tag ? 'active' : ''} key={tag} type="button" onClick={() => setSelectedTodoTag((current) => current === tag ? undefined : tag)}>{tag}</button>) : <span>{t('todo.noTags')}</span>}
                    </div>
                  </div>
                  <div className="todo-filter-panel-actions">
                    <span>{t('todo.filterResultCount', { count: countTodoEvents(visibleTodoRoots) })}</span>
                    <button type="button" onClick={clearTodoFilters}>{t('todo.clearAllFilters')}</button>
                  </div>
                </section>}
              </section>
            ) : (
              <div className="file-v2-module-row">
                <FileModuleSwitcher
                  activeModuleKey={activeModule.moduleKey}
                  modules={payload.modules}
                  updatedModuleKeys={updatedModuleKeys}
                  onSelect={selectActiveModule}
                />
                <div className="file-v2-module-actions" ref={markerSettingsRef}>
                  <button
                    className="tree-tool-btn"
                    type="button"
                    onClick={toggleAllHeadings}
                    title={allHeadingsExpanded ? t('workspace.collapseAll') : t('workspace.expandAll')}
                    aria-label={allHeadingsExpanded ? t('workspace.collapseAll') : t('workspace.expandAll')}
                  >
                    <CollapseTreeIcon expanded={allHeadingsExpanded} />
                  </button>
                  <button
                    className={`tree-tool-btn ${showMarkerSettings ? 'active' : ''}`}
                    type="button"
                    onClick={() => setShowMarkerSettings((current) => !current)}
                    title={t('module.markerColors')}
                    aria-label={t('module.markerColors')}
                    aria-pressed={showMarkerSettings}
                  >
                    <TagIcon />
                  </button>
                  {showMarkerSettings && (
                    <div className="popover-panel marker-settings-popover">
                      <MarkerSettingsPanel markerStats={activeModule.markerStats} onChange={updateMarkerColor} />
                    </div>
                  )}
                </div>
              </div>
            )}
            {!payload.eventDocument && (
              <section
                className="module-meta"
                aria-label={t('module.markerFilter')}
                onWheel={handleMarkerFilterWheel}
                onPointerDown={handleMarkerFilterPointerDown}
                onPointerMove={handleMarkerFilterPointerMove}
                onPointerUp={handleMarkerFilterPointerEnd}
                onPointerCancel={handleMarkerFilterPointerEnd}
              >
                <button
                  className={`meta-chip button-chip ${selectedMarker ? '' : 'active'}`}
                  type="button"
                  onClick={() => setSelectedMarker(undefined)}
                >
                  {t('module.allMarkers', { count: countRenderedHeadings(activeModule.headings) })}
                </button>
                {activeModule.markerStats.map((stat) => (
                  <button
                    className={`meta-chip button-chip ${selectedMarker === stat.name ? 'active' : ''}`}
                    key={stat.name}
                    type="button"
                    onClick={() => setSelectedMarker(stat.name)}
                  >
                    <span className="marker-filter-dot" style={{ backgroundColor: stat.color }} aria-hidden="true" />
                    {stat.name} {stat.count}
                  </button>
                ))}
              </section>
            )}
            <section ref={contentScrollRef} className="module-content file-v2-content" onScroll={handleContentScroll}>
              {payload.eventDocument ? (
                activeTodoView === 'board' ? <div className="todo-event-board">
                  {visibleTodoRoots.length > 0 ? visibleTodoRoots.map((event) => (
                    <TodoEventEditor
                      key={event.id}
                      event={event}
                      depth={2}
                      locations={todoLocations}
                      parentOptions={todoEvents}
                      statusDefinitions={payload.eventDocument?.statusDefinitions ?? []}
                      markerColors={activeModule.markerColors}
                      expandedEventIds={expandedEventIds}
                      notesExpanded={todoNotesExpanded}
                      filterActive={selectedTodoStatus !== undefined}
                      editingEventId={editingEventId}
                      selectedEventId={selectedEventId}
                      isDraft={draftEventIds.has(event.id)}
                      draftEventIds={draftEventIds}
                      onEditingChange={setEditingEventId}
                      onSelect={setSelectedEventId}
                      onDraftCreated={(eventId) => setDraftEventIds((current) => new Set(current).add(eventId))}
                      onDraftResolved={(eventId) => setDraftEventIds((current) => {
                        const next = new Set(current); next.delete(eventId); return next;
                      })}
                      onToggle={toggleTodoEvent}
                      onDropMove={moveTodoEventByDrop}
                      onMutate={mutateEvent}
                    />
                  )) : <div className="todo-event-empty">
                    <p>{selectedTodoStatus || selectedTodoTag || todoQuery
                      ? t('todo.noFilterResults', { status: selectedTodoStatus ?? selectedTodoTag ?? todoQuery })
                      : t(activeTodoRole === 'closed' ? 'todo.emptyClosed' : 'todo.emptyCurrent')}</p>
                    {(selectedTodoStatus || selectedTodoTag || todoQuery) && <button type="button" onClick={clearTodoFilters}>{t('todo.clearAllFilters')}</button>}
                  </div>}
                </div> : activeTodoView === 'timeline' ? <TodoTimelineView events={allTodoEvents} activities={payload.eventDocument.activities ?? []} markerColors={activeModule.markerColors} t={t} locale={locale} />
                  : activeTodoView === 'calendar' ? <TodoCalendarView events={allTodoEvents} mode={calendarDateMode} markerColors={activeModule.markerColors} statusDefinitions={payload.eventDocument.statusDefinitions ?? []} cursor={calendarCursor} selectedDate={calendarSelectedDate} onCursorChange={setCalendarCursor} onSelectedDateChange={setCalendarSelectedDate} onMutate={mutateEvent} t={t} locale={locale} />
                    : <TodoStatisticsView events={statisticsEvents} markerColors={activeModule.markerColors} statusCounts={statisticsStatusCounts} period={statisticsPeriod} t={t} />
              ) : (
                <ModuleContentView
                  changedHeadingKeys={changedHeadingKeys}
                  expandedKeys={expandedKeys}
                  headings={visibleHeadings}
                  leadingBodyChanged={leadingBodyChanged}
                  moduleData={activeModule}
                  now={now}
                  onClearUpdateHighlight={clearHeadingUpdate}
                  onToggleHeading={toggleHeading}
                />
              )}
            </section>
            <footer className="statusline">
              <div className="status-summary">
                <span className="status-stat"><ClockIcon />{t('module.itemCount', { count: moduleHeadingCount.toLocaleString(locale) })}</span>
                <span className="status-stat">{t('module.wordCount', { count: moduleWordCount.toLocaleString(locale) })}</span>
                <span className="status-stat">{t('module.lastUpdated', { time: moduleLastUpdated ? formatRelativeActivityTime(moduleLastUpdated, now, locale) : '—' })}</span>
              </div>
              {payload.eventDocument && eventSaveState !== 'idle' && <span className={`todo-save-state ${eventSaveState}`} role="status">
                {eventSaveState === 'saving' ? t('todo.saving') : eventSaveState === 'error' ? t('todo.saveFailed') : t('todo.saved')}
              </span>}
              {hasCurrentModuleUpdates && (
                <button
                  className="statusline-btn"
                  type="button"
                  onClick={clearCurrentModuleUpdates}
                  disabled={clearBusy !== null}
                  title={t('module.clearModuleUpdates')}
                >
                  {t('module.clearModuleUpdates')}
                </button>
              )}
              {hasFileUpdates && (
                <button
                  className="statusline-btn"
                  type="button"
                  onClick={clearCurrentFileUpdates}
                  disabled={clearBusy !== null}
                  title={t('module.clearFileUpdates')}
                >
                  {t('module.clearFileUpdates')}
                </button>
              )}
            </footer>
          </>
        ) : (
          <section className="empty-state">
            <h2>{t('fileWindow.unavailableTitle')}</h2>
            <p>{t('fileWindow.unavailableDescription')}</p>
          </section>
        )}
      </section>
    </main>
  );
}

function TodoTimelineView(props: {
  events: Event[];
  activities: EventActivity[];
  markerColors: Record<string, string>;
  locale: string;
  t: I18nContextValue['t'];
}) {
  const { events, activities, markerColors, locale, t } = props;
  const eventById = new Map(events.map((event) => [event.id, event]));
  const grouped = new Map<string, EventActivity[]>();
  for (const activity of [...activities].filter((item) => eventById.has(item.eventId)).sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())) {
    const day = todoDateKey(activity.at);
    grouped.set(day, [...(grouped.get(day) ?? []), activity]);
  }
  return <section className="todo-projection todo-timeline" aria-label={t('todo.view.timeline')}>
    {grouped.size ? [...grouped].map(([day, items]) => <section className="todo-timeline-day" key={day}>
      <h3>{formatTodoProjectionDate(day, locale)}</h3>
      {items.map((activity) => { const event = eventById.get(activity.eventId)!; return <div className="todo-timeline-row" key={activity.id}>
        <time>{formatTodoProjectionTime(activity.at, locale)}</time>
        <span className="todo-projection-dot" style={{ backgroundColor: markerColors[event.status] }} />
        <strong>{event.title}</strong><span>{describeTodoActivity(activity, t)}</span>
        <span className="todo-timeline-tags">
          {event.tags.slice(0, 2).map((tag) => <span className="todo-tag" style={{ '--todo-tag-color': todoTagColor(tag) } as React.CSSProperties} key={tag}>{tag}</span>)}
        </span>
      </div>; })}
    </section>) : <TodoProjectionEmpty t={t} />}
  </section>;
}

function describeTodoActivity(activity: EventActivity, t: I18nContextValue['t']): string {
  if (activity.type === 'created') return t('todo.activityCreated');
  if (activity.type === 'tags') return [activity.addedTags?.length ? t('todo.activityTagsAdded', { tags: activity.addedTags.join('、') }) : '', activity.removedTags?.length ? t('todo.activityTagsRemoved', { tags: activity.removedTags.join('、') }) : ''].filter(Boolean).join('；');
  if (activity.type === 'deadline') return activity.after ? activity.before ? t('todo.activityDeadlineChanged', { before: activity.before, after: activity.after }) : t('todo.activityDeadlineSet', { value: activity.after }) : t('todo.activityDeadlineCleared');
  const labels: Record<'title' | 'note' | 'status' | 'structure', string> = { title: t('todo.activityTitle'), note: t('todo.activityNote'), status: t('todo.activityStatus'), structure: t('todo.activityStructure') };
  return t('todo.activityChanged', { field: labels[activity.type as keyof typeof labels], before: activity.before || '—', after: activity.after || '—' });
}

function TodoCalendarView(props: {
  events: Event[];
  mode: 'created' | 'completed';
  markerColors: Record<string, string>;
  statusDefinitions: { name: string; category: 'current' | 'closed' }[];
  cursor: Date;
  selectedDate?: string;
  onCursorChange: (date: Date) => void;
  onSelectedDateChange: (date?: string) => void;
  onMutate: (request: Parameters<Window['workboard']['mutateEvent']>[1]) => Promise<FileWindowV2InitialPayload | null>;
  locale: string;
  t: I18nContextValue['t'];
}) {
  const { events, mode, markerColors, statusDefinitions, cursor, selectedDate, onCursorChange, onSelectedDateChange, onMutate, locale, t } = props;
  type CalendarEntry = { event: Event; date: string; isDeadline: boolean };
  const [calendarContextMenu, setCalendarContextMenu] = useState<{ x: number; y: number; date: string } | null>(null);
  const calendarContextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!calendarContextMenu) return;
    const close = (pointerEvent: globalThis.Event) => {
      if (pointerEvent.target instanceof Node && calendarContextMenuRef.current?.contains(pointerEvent.target)) return;
      setCalendarContextMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [calendarContextMenu]);
  const addEventOnDate = async () => {
    if (!calendarContextMenu) return;
    const date = calendarContextMenu.date;
    const previousIds = new Set(events.map((event) => event.id));
    setCalendarContextMenu(null);
    const created = await onMutate({ kind: 'create', title: t('todo.untitledRoot'), createdAt: todoDateInputToIso(date) });
    const createdEvent = created?.eventDocument
      ? [...created.eventDocument.current, ...created.eventDocument.closed]
        .flatMap(flattenTodoEvents)
        .find((event) => !previousIds.has(event.id))
      : undefined;
    // Keep this explicit as a safeguard for older/default creation paths that
    // may assign the current timestamp while creating the event.
    if (createdEvent) await onMutate({ kind: 'created-at', eventId: createdEvent.id, createdAt: todoDateInputToIso(date) });
  };
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const visibleDays = Math.ceil((((first.getDay() + 6) % 7) + daysInMonth) / 7) * 7;
  const days = Array.from({ length: visibleDays }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  const byDate = new Map<string, CalendarEntry[]>();
  const addCalendarEntry = (key: string, event: Event, date: string, isDeadline = false) => {
    const entries = byDate.get(key) ?? [];
    const existing = entries.find((entry) => entry.event.id === event.id);
    if (existing) existing.isDeadline ||= isDeadline;
    else entries.push({ event, date, isDeadline });
    byDate.set(key, entries);
  };
  for (const event of events) {
    if (mode === 'created') {
      const createdAt = event.createdAt ?? event.updatedAt;
      if (createdAt) addCalendarEntry(todoDateKey(createdAt), event, createdAt);
      if (event.deadline) addCalendarEntry(todoDateKey(event.deadline), event, event.deadline, true);
    } else if (event.closedAt) {
      addCalendarEntry(todoDateKey(event.closedAt), event, event.closedAt);
    }
  }
  const orderCalendarEntries = (entries: CalendarEntry[]) => [...entries].sort((left, right) => {
    const leftTime = new Date(left.date).getTime();
    const rightTime = new Date(right.date).getTime();
    return rightTime - leftTime;
  });
  const selectedEvents = selectedDate ? orderCalendarEntries(byDate.get(selectedDate) ?? []) : [];
  return <section className="todo-projection todo-calendar" aria-label={t('todo.view.calendar')}>
    <header><div><h2>{t('todo.calendarTitle')}</h2><p>{t('todo.calendarDescription')}</p></div><span className="todo-readonly-badge">{t('todo.readonly')}</span></header>
    <div className="todo-calendar-layout"><section className="todo-calendar-grid-wrap">
      <div className="todo-calendar-nav"><button type="button" onClick={() => onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>‹</button><strong>{new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(cursor)}</strong><button type="button" onClick={() => onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>›</button><button type="button" onClick={() => { const today = new Date(); onCursorChange(today); onSelectedDateChange(todoDateKey(today.toISOString())); }}>{t('todo.today')}</button></div>
      <div className="todo-calendar-weekdays">{todoWeekdays(locale).map((day) => <span key={day}>{day}</span>)}</div>
      <div className="todo-calendar-grid">{days.map((date) => {
        const key = todoDateKey(date.toISOString()); const dayEvents = orderCalendarEntries(byDate.get(key) ?? []); const inMonth = date.getMonth() === cursor.getMonth();
         return <button type="button" className={`todo-calendar-cell ${inMonth ? '' : 'outside'} ${selectedDate === key ? 'selected' : ''}`} key={key} onClick={() => onSelectedDateChange(key)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onSelectedDateChange(key); setCalendarContextMenu({ x: event.clientX, y: event.clientY, date: key }); }}><time>{date.getDate()}</time>{dayEvents.slice(0, 3).map(({ event, isDeadline }) => <span className={isDeadline ? 'deadline' : ''} key={event.id}><i style={{ backgroundColor: todoStatusColor(event.status, markerColors) }} /><b>{event.title}</b>{event.tags.length > 0 && <span className="todo-calendar-cell-tags">{event.tags.map((tag) => <span className="todo-tag" style={{ '--todo-tag-color': todoTagColor(tag) } as React.CSSProperties} key={tag}>{tag}</span>)}</span>}</span>)}{dayEvents.length > 3 && <small>+{dayEvents.length - 3}</small>}</button>;
       })}</div>
     </section><aside className="todo-calendar-agenda"><h3>{selectedDate ? formatTodoProjectionDate(selectedDate, locale) : t('todo.selectDate')}</h3>{selectedDate ? selectedEvents.length ? selectedEvents.map(({ event, date, isDeadline }) => <TodoCalendarAgendaItem key={event.id} event={event} date={date} isDeadline={isDeadline} mode={mode} markerColors={markerColors} statusDefinitions={statusDefinitions} locale={locale} onMutate={onMutate} t={t} />) : <p>{t('todo.noEventsOnDate')}</p> : <p>{t('todo.selectDate')}</p>}</aside></div>
    {calendarContextMenu && <div ref={calendarContextMenuRef} className="todo-calendar-context-menu" style={{ left: calendarContextMenu.x, top: calendarContextMenu.y }} role="menu"><button type="button" role="menuitem" onClick={() => void addEventOnDate()}>{t('todo.addEventToDate')}</button></div>}
  </section>;
}

function TodoCalendarAgendaItem(props: {
  event: Event;
  date: string;
  isDeadline: boolean;
  mode: 'created' | 'completed';
  markerColors: Record<string, string>;
  statusDefinitions: { name: string; category: 'current' | 'closed' }[];
  locale: string;
  t: I18nContextValue['t'];
  onMutate: (request: Parameters<Window['workboard']['mutateEvent']>[1]) => Promise<FileWindowV2InitialPayload | null>;
}) {
  const { event, date, isDeadline, mode, markerColors, statusDefinitions, locale, t, onMutate } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [timeMenuOpen, setTimeMenuOpen] = useState(false);
  const [timeEditor, setTimeEditor] = useState<'start' | 'deadline' | 'completed' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !timeMenuOpen && !timeEditor) return;
    const close = (pointerEvent: PointerEvent) => {
      if (pointerEvent.target instanceof Node && menuRef.current?.contains(pointerEvent.target)) return;
      setMenuOpen(false);
      setTimeMenuOpen(false);
      setTimeEditor(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen, timeEditor, timeMenuOpen]);
  const saveTime = async (value: string) => {
    if (!value || (timeEditor === 'completed' && value > todoDateInputValue(new Date().toISOString()))) return;
    const iso = todoDateInputToIso(value);
    if (timeEditor === 'completed' && !isClosedStatus(event.status, statusDefinitions)) {
      const status = statusDefinitions.find((definition) => definition.category === 'closed')?.name ?? '已完成';
      if (!await onMutate({ kind: 'status', eventId: event.id, status })) return;
    }
    const request = timeEditor === 'start'
      ? { kind: 'created-at' as const, eventId: event.id, createdAt: iso }
      : timeEditor === 'completed'
        ? { kind: 'closed-at' as const, eventId: event.id, closedAt: iso }
        : { kind: 'deadline' as const, eventId: event.id, deadline: value };
    if (await onMutate(request)) {
      setTimeEditor(null);
      setTimeMenuOpen(false);
      setMenuOpen(false);
    }
  };
  const editTags = () => {
    setMenuOpen(false);
    const input = window.prompt(t('todo.tagsPlaceholder'), event.tags.join(', '));
    if (input === null) return;
    const tags = [...new Set(input.split(/[,，、\n]/).map((tag) => tag.trim()).filter(Boolean))];
    void onMutate({ kind: 'tags', eventId: event.id, tags });
  };
  const editNote = () => {
    setMenuOpen(false);
    const note = window.prompt(t('todo.addNote'), event.note ?? '');
    if (note === null) return;
    void onMutate({ kind: 'note', eventId: event.id, note });
  };
  const deleteEvent = () => {
    setMenuOpen(false);
    if (window.confirm(t('todo.deleteConfirm'))) void onMutate({ kind: 'delete', eventId: event.id });
  };
  const selectedTime = timeEditor === 'start' ? todoDateInputValue(event.createdAt) : timeEditor === 'completed' ? todoDateInputValue(event.closedAt) : event.deadline ?? '';
  return <div ref={menuRef} className={`todo-calendar-agenda-item ${menuOpen || timeEditor ? 'menu-open' : ''}`}>
    <i style={{ backgroundColor: todoStatusColor(event.status, markerColors) }} />
    <strong>{event.title}</strong>
    <span>{todoStatusLabel(event.status, t)}</span>
    {event.note && <span className="todo-calendar-agenda-note">{todoPlainText(event.note)}</span>}
    <span className="todo-calendar-agenda-dates"><time className={isDeadline ? 'todo-calendar-deadline' : ''}>{isDeadline ? t('todo.deadline') : `${t(mode === 'created' ? 'todo.createdTime' : 'todo.completedTime')}: ${formatTodoProjectionTime(date, locale)}`}</time></span>
    {event.tags.length > 0 && <span className="todo-calendar-agenda-tags">{event.tags.map((tag) => <span className="todo-tag" style={{ '--todo-tag-color': todoTagColor(tag) } as React.CSSProperties} key={tag}>{tag}</span>)}</span>}
    <div className="todo-calendar-agenda-menu">
      <button type="button" className="todo-calendar-agenda-menu-toggle" aria-label={t('todo.moreActions')} aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}>•••</button>
      {menuOpen && <div className="todo-calendar-agenda-menu-panel" role="menu">
        <button type="button" role="menuitem" onClick={editTags}>{t('todo.addTags')}</button>
        {!event.note && <button type="button" role="menuitem" onClick={editNote}>{t('todo.addNote')}</button>}
        <div className="todo-event-time-menu">
          <button type="button" role="menuitem" aria-expanded={timeMenuOpen} onClick={() => setTimeMenuOpen((current) => !current)}>{t('todo.editTime')} <span aria-hidden="true">›</span></button>
          {timeMenuOpen && <div className="todo-event-time-submenu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setTimeMenuOpen(false); setTimeEditor('start'); }}>{t('todo.startTime')}</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setTimeMenuOpen(false); setTimeEditor('deadline'); }}>{t('todo.deadline')}</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setTimeMenuOpen(false); setTimeEditor('completed'); }}>{t('todo.completedTime')}</button>
          </div>}
        </div>
        {isClosedStatus(event.status, statusDefinitions) && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void onMutate({ kind: 'archive', eventId: event.id }); }}>{t('todo.archive')}</button>}
        <button className="danger" type="button" role="menuitem" onClick={deleteEvent}>{t('todo.delete')}</button>
      </div>}
    </div>
    {timeEditor && <div className="todo-calendar-time-popover"><label><span>{timeEditor === 'start' ? t('todo.startTime') : timeEditor === 'completed' ? t('todo.completedTime') : t('todo.deadline')}</span><input autoFocus type="date" max={timeEditor === 'completed' ? todoDateInputValue(new Date().toISOString()) : undefined} value={selectedTime} onChange={(e) => void saveTime(e.target.value)} /></label><button type="button" onClick={() => setTimeEditor(null)}>{t('common.cancel')}</button></div>}
  </div>;
}

function TodoStatisticsView(props: { events: Event[]; markerColors: Record<string, string>; statusCounts: Map<string, number>; period: 'week' | 'month'; t: I18nContextValue['t'] }) {
  const { events, markerColors, statusCounts, period, t } = props;
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const statuses = [...statusCounts.entries()];
  const total = events.length || 1;
  const allTags = collectTodoTags(events);
  const tags = allTags.map((tag) => [tag, events.filter((event) => event.tags.includes(tag)).length] as const).sort((left, right) => right[1] - left[1]).slice(0, 5);
  const chart = statuses.reduce((segments, [status, count]) => {
    const previous = segments.at(-1)?.end ?? 0;
    return [...segments, { status, count, start: previous, end: previous + count / total * 100 }];
  }, [] as { status: string; count: number; start: number; end: number }[]);
  const gradient = chart.length ? `conic-gradient(${chart.map((segment) => `${markerColors[segment.status] ?? '#8a94a3'} ${segment.start}% ${segment.end}%`).join(', ')})` : 'conic-gradient(#8a94a3 0 100%)';
  const createdInPeriod = events.filter((event) => todoEventInStatisticsPeriod({ ...event, updatedAt: event.createdAt }, period)).length;
  const completedInPeriod = events.filter((event) => todoEventInStatisticsPeriod({ ...event, updatedAt: event.closedAt }, period)).length;
  const closedEvents = events.filter((event) => isClosedStatus(event.status));
  const blockers = events.filter((event) => /阻塞|block/i.test(event.status)).length;
  const cycleDays = closedEvents.map(todoCycleDays).filter((value): value is number => value !== null);
  const averageCycle = cycleDays.length ? cycleDays.reduce((sum, value) => sum + value, 0) / cycleDays.length : 0;
  const trend = buildTodoTrend(events, trendDays);
  const cycleBuckets = [
    { label: `≤ 1 ${t('todo.stat.days')}`, count: cycleDays.filter((value) => value <= 1).length },
    { label: `1 - 3 ${t('todo.stat.days')}`, count: cycleDays.filter((value) => value > 1 && value <= 3).length },
    { label: `4 - 7 ${t('todo.stat.days')}`, count: cycleDays.filter((value) => value > 3 && value <= 7).length },
    { label: `> 7 ${t('todo.stat.days')}`, count: cycleDays.filter((value) => value > 7).length },
  ];
  const maxTrend = Math.max(1, ...trend.flatMap((day) => [day.created, day.completed]));
  const maxTag = Math.max(1, ...tags.map(([, count]) => count));
  const totalTagUses = tags.reduce((sum, [, count]) => sum + count, 0) || 1;
  const maxCycle = Math.max(1, ...cycleBuckets.map((bucket) => bucket.count));

  return <section className="todo-projection todo-statistics" aria-label={t('todo.view.statistics')}>
    <section className="todo-stat-cards todo-stat-cards-prototype">
      <TodoStatCard icon="☷" label={t('todo.stat.eventsInPeriod')} value={events.length} detail={period === 'week' ? t('todo.stat.activityThisWeek') : t('todo.stat.activityThisMonth')} tone="blue" />
      <TodoStatCard icon="✓" label={t('todo.stat.endedInPeriod')} value={closedEvents.length} detail={period === 'week' ? t('todo.stat.scopeThisWeek') : t('todo.stat.scopeThisMonth')} tone="green" />
      <TodoStatCard icon="＋" label={period === 'week' ? t('todo.stat.createdThisWeek') : t('todo.stat.createdThisMonth')} value={createdInPeriod} detail={t('todo.stat.byCreatedAt')} tone="green" />
      <TodoStatCard icon="✓" label={period === 'week' ? t('todo.stat.completedThisWeek') : t('todo.stat.completedThisMonth')} value={completedInPeriod} detail={t('todo.stat.byCompletedAt')} tone="green" />
      <TodoStatCard icon="!" label={t('todo.stat.blockers')} value={blockers} detail={period === 'week' ? t('todo.stat.scopeThisWeek') : t('todo.stat.scopeThisMonth')} tone="red" />
      <TodoStatCard icon="◷" label={t('todo.stat.averageCycle')} value={averageCycle ? averageCycle.toFixed(1) : '—'} suffix={averageCycle ? t('todo.stat.days') : undefined} detail={t('todo.stat.fromCreatedToCompleted')} tone="ink" />
    </section>
    <section className="todo-stat-overview-grid">
      <article className="todo-trend-card"><header><h3>{t('todo.stat.recentTrend')}</h3><label> <span className="sr-only">{t('todo.stat.trendRange')}</span><select value={trendDays} onChange={(event) => setTrendDays(Number(event.target.value) as 7 | 30)}><option value={7}>{t('todo.stat.last7Days')}</option><option value={30}>{t('todo.stat.last30Days')}</option></select></label></header><div className="todo-trend-legend"><span><i className="created" />{t('todo.stat.added')}</span><span><i className="completed" />{t('todo.stat.completed')}</span></div><div className="todo-trend-chart" style={{ '--trend-days': trendDays } as React.CSSProperties}>{trend.map((day) => <div className="todo-trend-day" key={day.key}><div className="todo-trend-values"><span className="created" style={{ height: `${Math.max(3, day.created / maxTrend * 100)}%` }} title={`${t('todo.stat.added')} ${day.created}`} /><span className="completed" style={{ height: `${Math.max(3, day.completed / maxTrend * 100)}%` }} title={`${t('todo.stat.completed')} ${day.completed}`} /></div><small>{day.label}</small></div>)}</div></article>
      <article className="todo-status-card"><h3>{t('todo.statusDistribution')}</h3><div className="todo-status-chart"><div className="todo-donut" style={{ background: gradient }}><strong>{events.length}</strong><span>{t('todo.statusAll')}</span></div><div className="todo-stat-legend">{statuses.map(([status, count]) => <span key={status}><i style={{ backgroundColor: markerColors[status] }} />{todoStatusLabel(status, t)}<b>{count}</b><small>{(count / total * 100).toFixed(1)}%</small></span>)}</div></div></article>
    </section>
    <section className="todo-stat-detail-grid">
      <article><h3>{t('todo.tagDistribution')} <small>({t('todo.stat.byTagUses')})</small></h3>{tags.length ? tags.map(([tag, count], index) => <div className="todo-stat-bar" key={tag}><span>{tag}</span><i><b className={`tag-${index % 4}`} style={{ width: `${count / maxTag * 100}%` }} /></i><strong>{count}</strong><small>{(count / totalTagUses * 100).toFixed(1)}%</small></div>) : <TodoProjectionEmpty t={t} />}</article>
      <article><h3>{t('todo.stat.cycleDistribution')} <small>({t('todo.stat.fromCreatedToCompleted')})</small></h3>{cycleBuckets.map((bucket) => <div className="todo-stat-bar todo-cycle-bar" key={bucket.label}><span>{bucket.label}</span><i><b style={{ width: `${bucket.count / maxCycle * 100}%` }} /></i><strong>{bucket.count}</strong><small>{cycleDays.length ? (bucket.count / cycleDays.length * 100).toFixed(1) : '0.0'}%</small></div>)}</article>
    </section>
  </section>;
}

function TodoStatCard(props: { icon: string; label: string; value: number | string; suffix?: string; detail: string; tone: 'blue' | 'green' | 'red' | 'ink' }) { return <article className={`todo-stat-card tone-${props.tone}`}><i aria-hidden="true">{props.icon}</i><div><span>{props.label}</span><strong>{props.value}{props.suffix && <small>{props.suffix}</small>}</strong><em>{props.detail}</em></div></article>; }
function todoStatusLabel(status: string, t: I18nContextValue['t']): string { const keys: Record<string, TranslationKey> = { '未开始': 'todo.status.notStarted', '进行中': 'todo.status.inProgress', '等待': 'todo.status.waiting', '阻塞': 'todo.status.blocked', '已完成': 'todo.status.completed', '终止': 'todo.status.terminated', '取消': 'todo.status.cancelled' }; return keys[status] ? t(keys[status]) : status; }
function todoDateValue(value?: string): number { const date = value ? new Date(value).getTime() : 0; return Number.isNaN(date) ? 0 : date; }
function todoCycleDays(event: Event): number | null { const start = todoDateValue(event.createdAt); const end = todoDateValue(event.closedAt); return start && end >= start ? (end - start) / 86_400_000 : null; }
function todoEventInStatisticsPeriod(event: Event, period: 'week' | 'month'): boolean { const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0); if (period === 'week') { const day = (start.getDay() + 6) % 7; start.setDate(start.getDate() - day); } else start.setDate(1); const timestamp = todoDateValue(event.updatedAt ?? event.createdAt ?? event.closedAt); return timestamp >= start.getTime() && timestamp <= now.getTime(); }
function buildTodoTrend(events: Event[], days: number): { key: string; label: string; created: number; completed: number }[] { const today = new Date(); today.setHours(0, 0, 0, 0); return Array.from({ length: days }, (_, index) => { const date = new Date(today); date.setDate(today.getDate() - (days - 1 - index)); const key = todoDateKey(date.toISOString()); return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, created: events.filter((event) => todoDateKey(event.createdAt) === key).length, completed: events.filter((event) => todoDateKey(event.closedAt) === key).length }; }); }
function TodoProjectionEmpty(props: { t: I18nContextValue['t'] }) { return <p className="todo-projection-empty">{props.t('todo.noFilterResults', { status: '' })}</p>; }

function todoDateKey(value?: string): string { const date = value ? new Date(value) : new Date(); return Number.isNaN(date.getTime()) ? 'unknown' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function formatTodoProjectionDate(value: string, locale: string): string { const date = new Date(`${value}T12:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(date); }
function formatTodoProjectionTime(value: string | undefined, locale: string): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date); }
function todoWeekdays(locale: string): string[] { const monday = new Date(2024, 0, 1); return Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index))); }

function TodoEventEditor(props: {
  event: Event;
  depth: number;
  locations: Map<string, TodoEventLocation>;
  parentOptions: Event[];
  statusDefinitions: { name: string; category: 'current' | 'closed' }[];
  markerColors: Record<string, string>;
  expandedEventIds: Set<string>;
  notesExpanded: boolean;
  filterActive: boolean;
  editingEventId: string | null;
  selectedEventId: string | null;
  isDraft: boolean;
  draftEventIds: Set<string>;
  onEditingChange: (eventId: string | null) => void;
  onSelect: (eventId: string) => void;
  onDraftCreated: (eventId: string) => void;
  onDraftResolved: (eventId: string) => void;
  onToggle: (eventId: string) => void;
  onDropMove: (sourceId: string, targetId: string, position: 'before' | 'after' | 'inside') => Promise<void>;
  onMutate: (request: Parameters<Window['workboard']['mutateEvent']>[1]) => Promise<FileWindowV2InitialPayload | null>;
}) {
  const { event, depth, locations, parentOptions, statusDefinitions, markerColors, expandedEventIds, notesExpanded, filterActive, editingEventId, selectedEventId, isDraft, draftEventIds, onEditingChange, onSelect, onDraftCreated, onDraftResolved, onToggle, onDropMove, onMutate } = props;
  const { locale, t } = useI18n();
  const expanded = filterActive || expandedEventIds.has(event.id);
  const [title, setTitle] = useState(event.title);
  const [note, setNote] = useState(event.note);
  const [tagInput, setTagInput] = useState('');
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [deadlineInput, setDeadlineInput] = useState(event.deadline ?? '');
  const [timeEditor, setTimeEditor] = useState<'start' | 'deadline' | 'completed' | null>(null);
  const [editingField, setEditingField] = useState<'title' | 'note' | null>(null);
  const [showStatusCreator, setShowStatusCreator] = useState(false);
  const [statusName, setStatusName] = useState('');
  const [statusCategory, setStatusCategory] = useState<'current' | 'closed'>('current');
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [eventMenuOpen, setEventMenuOpen] = useState(false);
  const [timeMenuOpen, setTimeMenuOpen] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [deadlineMenuOpen, setDeadlineMenuOpen] = useState(false);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside' | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const textEditCommitRef = useRef(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const eventMenuRef = useRef<HTMLDivElement>(null);
  const eventMenuPanelRef = useRef<HTMLDivElement>(null);
  const propertyMenuRef = useRef<HTMLDivElement>(null);
  const [eventMenuPosition, setEventMenuPosition] = useState<{ left: number; top: number } | null>(null);
  // Keep the editor's draft stable while the event tree is being refreshed.
  // File broadcasts can replace the event object while the user is typing;
  // syncing those values during an active edit makes the input appear to
  // randomly lose keystrokes.
  useEffect(() => {
    if (editingField !== 'title') setTitle(event.title);
    if (editingField !== 'note') setNote(event.note);
    setDeadlineInput(event.deadline ?? '');
  }, [editingField, event.title, event.note, event.deadline]);
  useEffect(() => {
    if (editingEventId === event.id && editingField === null) setEditingField('title');
  }, [editingEventId, editingField, event.id]);
  useEffect(() => {
    if (editingField === 'title') {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
    if (editingField === 'note') noteInputRef.current?.focus();
  }, [editingField]);
  useEffect(() => {
    if (!statusMenuOpen && !eventMenuOpen && !tagMenuOpen && !deadlineMenuOpen && !timeMenuOpen && !timeEditor) return;
    const closeOnOutsidePointer = (pointerEvent: PointerEvent) => {
      if (pointerEvent.target instanceof Node
        && (statusMenuRef.current?.contains(pointerEvent.target) || eventMenuRef.current?.contains(pointerEvent.target) || eventMenuPanelRef.current?.contains(pointerEvent.target) || propertyMenuRef.current?.contains(pointerEvent.target))) return;
      setStatusMenuOpen(false);
      setEventMenuOpen(false);
      setTagMenuOpen(false);
      setDeadlineMenuOpen(false);
      setTimeEditor(null);
      setTimeMenuOpen(false);
    };
    const closeOnEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        setStatusMenuOpen(false);
        setEventMenuOpen(false);
        setTagMenuOpen(false);
        setDeadlineMenuOpen(false);
        setTimeEditor(null);
        setTimeMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [deadlineMenuOpen, eventMenuOpen, statusMenuOpen, tagMenuOpen, timeEditor, timeMenuOpen]);
  useEffect(() => {
    if (!eventMenuOpen) {
      setEventMenuPosition(null);
      return;
    }
    const updateEventMenuPosition = () => {
      const bounds = eventMenuRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setEventMenuPosition({ left: Math.max(8, bounds.right - 178), top: bounds.bottom + 4 });
    };
    updateEventMenuPosition();
    window.addEventListener('resize', updateEventMenuPosition);
    window.addEventListener('scroll', updateEventMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateEventMenuPosition);
      window.removeEventListener('scroll', updateEventMenuPosition, true);
    };
  }, [eventMenuOpen]);
  const save = (request: Parameters<Window['workboard']['mutateEvent']>[1]) => onMutate(request);
  const beginTextEdit = (field: 'title' | 'note') => {
    setEventMenuOpen(false);
    setStatusMenuOpen(false);
    setTagMenuOpen(false);
    setDeadlineMenuOpen(false);
    setTimeEditor(null);
    setTimeMenuOpen(false);
    setEditingField(field);
    onEditingChange(event.id);
  };
  const openTagCreator = () => {
    setTagInput('');
    setEditingTag(null);
    setTagMenuOpen(true);
    setDeadlineMenuOpen(false);
    setTimeEditor(null);
    setTimeMenuOpen(false);
    setStatusMenuOpen(false);
    setEventMenuOpen(false);
  };
  const openTagEditor = (tag: string) => {
    setTagInput(tag);
    setEditingTag(tag);
    setTagMenuOpen(true);
    setDeadlineMenuOpen(false);
    setTimeEditor(null);
    setTimeMenuOpen(false);
    setStatusMenuOpen(false);
    setEventMenuOpen(false);
  };
  const saveTag = async () => {
    const value = tagInput.trim();
    const replacement = editingTag === null
      ? (value && !event.tags.includes(value) ? [...event.tags, value] : event.tags)
      : event.tags.flatMap((tag) => tag === editingTag ? (value ? [value] : []) : [tag]);
    const tags = [...new Set(replacement)];
    const next = await save({ kind: 'tags', eventId: event.id, tags });
    if (next) {
      setTagMenuOpen(false);
      setEditingTag(null);
      setTagInput('');
    }
  };
  const saveDeadline = async (value: string) => {
    setDeadlineInput(value);
    const next = await save({ kind: 'deadline', eventId: event.id, deadline: value || undefined });
    if (next) setDeadlineMenuOpen(false);
  };
  const saveTime = async (value: string) => {
    if (!value || (timeEditor === 'completed' && value > todoDateInputValue(new Date().toISOString()))) return;
    const iso = todoDateInputToIso(value);
    if (timeEditor === 'completed' && !isClosedStatus(event.status, statusDefinitions)) {
      const status = statusDefinitions.find((definition) => definition.category === 'closed')?.name ?? '已完成';
      if (!await onMutate({ kind: 'status', eventId: event.id, status })) return;
    }
    const request = timeEditor === 'start'
      ? { kind: 'created-at' as const, eventId: event.id, createdAt: iso }
      : timeEditor === 'completed'
        ? { kind: 'closed-at' as const, eventId: event.id, closedAt: iso }
        : { kind: 'deadline' as const, eventId: event.id, deadline: value };
    const next = await save(request);
    if (next) setTimeEditor(null);
  };
  const commitTextEdit = async (field: 'title' | 'note') => {
    if (textEditCommitRef.current) return;
    textEditCommitRef.current = true;
    try {
      const next = field === 'title'
        ? await save({ kind: 'title', eventId: event.id, title: title.trim() || event.title })
        : await save({ kind: 'note', eventId: event.id, note });
      if (!next) return;
      if (field === 'title' && isDraft) onDraftResolved(event.id);
      setEditingField(null);
      onEditingChange(null);
    } finally {
      textEditCommitRef.current = false;
    }
  };
  const cancelTextEdit = () => {
    const isUncommittedNewEvent = editingField === 'title' && isDraft;
    setTitle(event.title);
    setNote(event.note);
    setEditingField(null);
    onEditingChange(null);
    if (isUncommittedNewEvent) {
      onDraftResolved(event.id);
      void save({ kind: 'delete', eventId: event.id });
    }
  };
  const handleDrop = (dropEvent: React.DragEvent<HTMLDivElement>) => {
    dropEvent.preventDefault();
    const sourceId = dropEvent.dataTransfer.getData('text/plain');
    const position = dropPosition;
    setDropPosition(null);
    if (sourceId && position) void onDropMove(sourceId, event.id, position);
  };
  const chooseStatus = async (value: string) => {
    if (value === '__new__') {
      setStatusMenuOpen(false);
      setStatusCategory(statusDefinitions.find((definition) => definition.name === event.status)?.category ?? 'current');
      setShowStatusCreator(true);
      return;
    }
    const next = await save({ kind: 'status', eventId: event.id, status: value });
    if (next) setStatusMenuOpen(false);
  };
  async function createChild() {
    const previousIds = new Set(parentOptions.map((candidate) => candidate.id));
    const next = await save({ kind: 'create-child', parentId: event.id, title: t('todo.untitledChild') });
    const created = next?.eventDocument
      ? flattenTodoEventsFromDocument(next.eventDocument).find((candidate) => !previousIds.has(candidate.id))
      : undefined;
    if (created) {
      if (!expanded) onToggle(event.id);
      onDraftCreated(created.id);
      onEditingChange(created.id);
    }
  }
  async function createSibling() {
    const previousIds = new Set(parentOptions.map((candidate) => candidate.id));
    const next = await save({ kind: 'create-sibling', eventId: event.id, title: t('todo.untitledChild'), status: event.status });
    const created = next?.eventDocument
      ? flattenTodoEventsFromDocument(next.eventDocument).find((candidate) => !previousIds.has(candidate.id))
      : undefined;
    if (created) {
      onDraftCreated(created.id);
      onEditingChange(created.id);
    }
  }
  const hideEmptyChildMetadata = depth > 2 && !event.note && editingField !== 'note';
  return <section className={`todo-event-editor ${eventMenuOpen || timeMenuOpen || timeEditor ? 'menu-open' : ''}`} data-todo-event-id={event.id} style={{ marginLeft: depth > 2 ? '18px' : undefined }}>
    <div className={`todo-event-row ${depth > 2 ? 'child-event' : ''} ${hideEmptyChildMetadata ? 'child-without-metadata' : ''} ${!notesExpanded ? 'notes-collapsed' : ''} ${selectedEventId === event.id ? 'selected' : ''} ${dropPosition ? `drop-${dropPosition}` : ''}`} onClick={() => onSelect(event.id)} onDragOver={(e) => { e.preventDefault(); const bounds = e.currentTarget.getBoundingClientRect(); const ratio = (e.clientY - bounds.top) / bounds.height; setDropPosition(ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'inside'); }} onDragLeave={() => setDropPosition(null)} onDrop={handleDrop}>
      <button className="todo-drag-handle" type="button" draggable="true" aria-label={t('todo.dragEvent')} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', event.id); }} onDragEnd={() => setDropPosition(null)}>⠿</button>
      <button type="button" className={`todo-tree-toggle ${event.children.length === 0 ? 'empty' : ''}`} onClick={() => event.children.length > 0 && onToggle(event.id)} aria-label={event.children.length === 0 ? undefined : expanded ? t('todo.collapseChildren') : t('todo.expandChildren')} tabIndex={event.children.length === 0 ? -1 : 0}>{event.children.length === 0 ? '' : expanded ? '▾' : '▸'}</button>
      <div className={`todo-status-picker ${event.status === '已完成' ? 'completed' : ''}`} ref={statusMenuRef} style={{ '--todo-event-status-color': todoStatusColor(event.status, markerColors) } as React.CSSProperties}>
        <button className="todo-status-picker-trigger" type="button" aria-label={t('todo.eventStatus')} aria-expanded={statusMenuOpen} title={todoStatusLabel(event.status, t)} onClick={() => { setStatusMenuOpen((current) => !current); setEventMenuOpen(false); setTagMenuOpen(false); setDeadlineMenuOpen(false); }}><i aria-hidden="true" /></button>
        {statusMenuOpen && <div className="todo-status-picker-menu" role="menu">
          {statusDefinitions.map((definition) => <button type="button" key={definition.name} role="menuitem" className={definition.name === event.status ? 'active' : ''} onClick={() => void chooseStatus(definition.name)}><i style={{ backgroundColor: todoStatusColor(definition.name, markerColors) }} />{todoStatusLabel(definition.name, t)}</button>)}
          <button type="button" role="menuitem" className="new-status" onClick={() => void chooseStatus('__new__')}>＋ {t('todo.newStatus')}</button>
        </div>}
      </div>
      <div className={`todo-event-summary ${event.children.length > 0 ? 'can-toggle' : ''}`} role={event.children.length > 0 ? 'button' : undefined} tabIndex={event.children.length > 0 ? 0 : undefined} onClick={() => { if (event.children.length > 0) onToggle(event.id); }} onKeyDown={(keyEvent) => { if (event.children.length > 0 && (keyEvent.key === 'Enter' || keyEvent.key === ' ')) { keyEvent.preventDefault(); onToggle(event.id); } }} aria-expanded={event.children.length > 0 ? expanded : undefined}>
        <div className="todo-event-heading">
          {editingField === 'title' ? <input ref={titleInputRef} className="todo-inline-title" aria-label={t('todo.titleAria')} value={title} onChange={(e) => setTitle(e.target.value)} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onBlur={() => void commitTextEdit('title')} onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); void commitTextEdit('title'); } if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit(); } }} /> : <button className="todo-event-title todo-inline-action" type="button" title={t('todo.edit')} onClick={(e) => { e.stopPropagation(); beginTextEdit('title'); }}>{event.title}</button>}
          {event.tags.length > 0 && <span className="todo-tag-area" aria-label={t('todo.tagsAria')}>
            {event.tags.map((tag) => <button className="todo-tag" type="button" style={{ '--todo-tag-color': todoTagColor(tag) } as React.CSSProperties} key={tag} title={t('todo.edit')} onClick={(e) => { e.stopPropagation(); openTagEditor(tag); }}>{tag}</button>)}
          </span>}
        </div>
         {(!hideEmptyChildMetadata && (notesExpanded || editingField === 'note')) && <span className="todo-event-meta">
          {editingField === 'note' ? <textarea ref={noteInputRef} className="todo-inline-note" aria-label={t('todo.note')} value={note} onChange={(e) => setNote(e.target.value)} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onBlur={() => void commitTextEdit('note')} onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit(); } if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void commitTextEdit('note'); } }} /> : event.note ? <button className="todo-event-note todo-inline-action" type="button" title={t('todo.edit')} onClick={(e) => { e.stopPropagation(); beginTextEdit('note'); }}><TodoNotePreview markdown={event.note} /></button> : null}
          {!event.note && editingField !== 'note' && depth <= 2 && <button className="todo-event-note-placeholder todo-inline-action" type="button" onClick={(e) => { e.stopPropagation(); beginTextEdit('note'); }}>＋ {t('todo.note')}</button>}
        </span>
        }
      </div>
      <time className="todo-event-created" dateTime={event.createdAt} title={event.createdAt}>{formatTodoCreatedAt(event.createdAt, locale)}</time>
      <div className="todo-event-menu" ref={eventMenuRef}>
        <button className="todo-event-menu-toggle" type="button" aria-label={t('todo.moreActions')} aria-expanded={eventMenuOpen} onClick={() => { setEventMenuOpen((current) => !current); setStatusMenuOpen(false); setTagMenuOpen(false); setDeadlineMenuOpen(false); }}>•••</button>
        {eventMenuOpen && eventMenuPosition && createPortal(<div ref={eventMenuPanelRef} className="todo-event-menu-panel todo-event-menu-portal" role="menu" style={{ left: eventMenuPosition.left, top: eventMenuPosition.top }}>
          <button type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); void createChild(); }} disabled={depth >= 6}>{t('todo.addChild')}</button>
          <button type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); void createSibling(); }}>{t('todo.addSibling')}</button>
          <button type="button" role="menuitem" onClick={openTagCreator}>{t('todo.addTags')}</button>
          {depth > 2 && !event.note && <button type="button" role="menuitem" onClick={() => beginTextEdit('note')}>{t('todo.addNote')}</button>}
          <div className="todo-event-time-menu">
            <button type="button" role="menuitem" aria-expanded={timeMenuOpen} onClick={() => setTimeMenuOpen((current) => !current)}>{t('todo.editTime')} <span aria-hidden="true">›</span></button>
            {timeMenuOpen && <div className="todo-event-time-submenu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); setTimeMenuOpen(false); setTimeEditor('start'); setTagMenuOpen(false); setDeadlineMenuOpen(false); setStatusMenuOpen(false); }}>{t('todo.startTime')}</button>
              <button type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); setTimeMenuOpen(false); setTimeEditor('deadline'); setTagMenuOpen(false); setDeadlineMenuOpen(false); setStatusMenuOpen(false); }}>{t('todo.deadline')}</button>
              <button type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); setTimeMenuOpen(false); setTimeEditor('completed'); setTagMenuOpen(false); setDeadlineMenuOpen(false); setStatusMenuOpen(false); }}>{t('todo.completedTime')}</button>
            </div>}
          </div>
          {isClosedStatus(event.status, statusDefinitions) && <button type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); void save({ kind: 'archive', eventId: event.id }); }}>{t('todo.archive')}</button>}
          <button className="danger" type="button" role="menuitem" onClick={() => { setEventMenuOpen(false); if (window.confirm(t('todo.deleteConfirm'))) void save({ kind: 'delete', eventId: event.id }); }}>{t('todo.delete')}</button>
        </div>, document.querySelector<HTMLElement>('.desktop-shell') ?? document.body)}
      </div>
    </div>
    {(tagMenuOpen || deadlineMenuOpen || timeEditor) && <div className="todo-property-menu" ref={propertyMenuRef}>
      {tagMenuOpen && <div className="todo-property-popover"><label><span>{editingTag === null ? t('todo.addTags') : t('todo.tags')}</span><input autoFocus aria-label={t('todo.tagsAria')} value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); void saveTag(); } if (e.key === 'Escape') { e.preventDefault(); setTagMenuOpen(false); } }} placeholder={t('todo.tagsPlaceholder')} /></label><div className="todo-property-actions"><button type="button" onClick={() => setTagMenuOpen(false)}>{t('common.cancel')}</button><button type="button" onClick={() => void saveTag()}>{t('todo.saveTitle')}</button></div></div>}
      {deadlineMenuOpen && <div className="todo-property-popover"><label><span>{t('todo.deadline')}</span><input autoFocus aria-label={t('todo.deadline')} type="date" value={deadlineInput} onChange={(e) => void saveDeadline(e.target.value)} /></label><div className="todo-property-actions"><button type="button" onClick={() => void saveDeadline('')}>{t('todo.clearDeadline')}</button><button type="button" onClick={() => setDeadlineMenuOpen(false)}>{t('common.cancel')}</button></div></div>}
      {timeEditor && <div className="todo-property-popover"><label><span>{timeEditor === 'start' ? t('todo.startTime') : timeEditor === 'completed' ? t('todo.completedTime') : t('todo.deadline')}</span><input autoFocus aria-label={timeEditor === 'start' ? t('todo.startTime') : timeEditor === 'completed' ? t('todo.completedTime') : t('todo.deadline')} type="date" max={timeEditor === 'completed' ? todoDateInputValue(new Date().toISOString()) : undefined} defaultValue={timeEditor === 'start' ? todoDateInputValue(event.createdAt) : timeEditor === 'completed' ? todoDateInputValue(event.closedAt) : event.deadline ?? ''} onChange={(e) => void saveTime(e.target.value)} /></label><div className="todo-property-actions"><button type="button" onClick={() => setTimeEditor(null)}>{t('common.cancel')}</button></div></div>}
    </div>}
    {showStatusCreator && <form className="todo-status-creator" onSubmit={(e) => {
      e.preventDefault();
      const name = statusName.trim();
      if (!name) return;
      void save({ kind: 'status-definition', name, category: statusCategory }).then((next) => {
        if (!next) return;
        setStatusName('');
        setShowStatusCreator(false);
      });
    }}>
      <label><span>{t('todo.statusName')}</span><input value={statusName} onChange={(e) => setStatusName(e.target.value)} placeholder={t('todo.statusNamePlaceholder')} autoFocus /></label>
      <label><span>{t('todo.statusCategory')}</span><select value={statusCategory} onChange={(e) => setStatusCategory(e.target.value as 'current' | 'closed')}>
        <option value="current">{t('todo.categoryCurrent')}</option>
        <option value="closed">{t('todo.categoryClosed')}</option>
      </select></label>
      <div className="todo-status-creator-actions"><button type="button" onClick={() => setShowStatusCreator(false)}>{t('common.cancel')}</button><button type="submit" disabled={!statusName.trim()}>{t('todo.createStatus')}</button></div>
    </form>}
    {expanded && <div className="todo-event-children">{event.children.map((child) => <TodoEventEditor key={child.id} event={child} depth={depth + 1} locations={locations} parentOptions={parentOptions} statusDefinitions={statusDefinitions} markerColors={markerColors} expandedEventIds={expandedEventIds} notesExpanded={notesExpanded} filterActive={filterActive} editingEventId={editingEventId} selectedEventId={selectedEventId} isDraft={draftEventIds.has(child.id)} draftEventIds={draftEventIds} onEditingChange={onEditingChange} onSelect={onSelect} onDraftCreated={onDraftCreated} onDraftResolved={onDraftResolved} onToggle={onToggle} onDropMove={onDropMove} onMutate={onMutate} />)}</div>}
  </section>;
}

function flattenTodoEvents(event: Event): Event[] {
  return [event, ...event.children.flatMap(flattenTodoEvents)];
}

function flattenTodoEventsFromDocument(document: NonNullable<FileWindowV2InitialPayload['eventDocument']>): Event[] {
  return [...document.current, ...document.closed].flatMap(flattenTodoEvents);
}

function formatTodoCreatedAt(value: string | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

function todoDateInputValue(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todoDateInputToIso(value: string): string {
  return new Date(`${value}T12:00:00`).toISOString();
}

function todoPlainText(markdown: string): string {
  return markdown.replace(/[#*_`~>]/g, '').replace(/\s+/g, ' ').trim();
}

function todoStatusColor(status: string, markerColors: Record<string, string>): string {
  const defaults: Record<string, string> = {
    '未开始': '#a8b3c2',
    '进行中': '#3b82f6',
    '等待': '#f5a623',
    '阻塞': '#ef5350',
    '已完成': '#20a563',
    '终止': '#94a3b8',
    '取消': '#94a3b8',
  };
  return defaults[status] ?? markerColors[status] ?? '#8d99aa';
}

function todoTagColor(tag: string): string {
  const palette = ['#4f83ea', '#7d67e8', '#28a96b', '#d88631', '#b75fca', '#2e9fb8'];
  const hash = [...tag].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  return palette[hash % palette.length];
}

function todoModuleRole(title: string): 'current' | 'closed' | undefined {
  return title === '当前' ? 'current' : title === '已结束' ? 'closed' : undefined;
}

function containsTodoEvent(event: Event, id: string): boolean {
  return event.children.some((child) => child.id === id || containsTodoEvent(child, id));
}

function FileModuleSwitcher(props: {
  activeModuleKey: string;
  modules: ModuleWindowData[];
  updatedModuleKeys: Set<string>;
  onSelect: (moduleKey: string) => void;
}) {
  const { activeModuleKey, modules, updatedModuleKeys, onSelect } = props;
  const { t } = useI18n();
  const switcherRef = useRef<HTMLElement>(null);
  const activeButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const switcher = switcherRef.current;
    const row = switcher?.parentElement;

    if (!switcher || !row) {
      return undefined;
    }

    const switcherElement = switcher;
    const rowElement = row;

    function measureOverflow() {
      const actions = rowElement.querySelector<HTMLElement>('.file-v2-module-actions');
      const availableWithoutMenu = rowElement.clientWidth - (actions?.offsetWidth ?? 0);
      const nextHasOverflow = switcherElement.scrollWidth > availableWithoutMenu + 1;
      setHasOverflow(nextHasOverflow);

      if (!nextHasOverflow) {
        setMenuOpen(false);
      }
    }

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(rowElement);
    observer.observe(switcherElement);
    const frame = window.requestAnimationFrame(measureOverflow);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [modules]);

  useEffect(() => {
    activeButtonRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeModuleKey]);

  useEffect(() => {
    const switcher = switcherRef.current;

    if (!switcher) {
      return undefined;
    }

    const switcherElement = switcher;

    function handleWheel(event: WheelEvent) {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        switcherElement.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }

    switcherElement.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      switcherElement.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    function closeMenu(event: PointerEvent) {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
        return;
      }

      setMenuOpen(false);
    }

    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeMenuOnEscape);

    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeMenuOnEscape);
    };
  }, [menuOpen]);

  function selectModule(moduleKey: string) {
    setMenuOpen(false);
    onSelect(moduleKey);
  }

  return (
    <>
      <nav ref={switcherRef} className="file-v2-switcher" aria-label={t('fileWindow.modules')}>
        {modules.map((module) => (
          <button
            className={`file-v2-switcher-item ${module.moduleKey === activeModuleKey ? 'active' : ''} ${updatedModuleKeys.has(module.moduleKey) ? 'pending-update' : ''}`}
            key={module.moduleKey}
            ref={module.moduleKey === activeModuleKey ? activeButtonRef : undefined}
            type="button"
            onClick={() => selectModule(module.moduleKey)}
            title={module.rawTitle}
          >
            {module.title}
          </button>
        ))}
      </nav>
      {hasOverflow && (
        <div className="file-v2-overflow-menu" ref={menuRef}>
          <button
            className={`tree-tool-btn file-v2-overflow-trigger ${menuOpen ? 'active' : ''}`}
            type="button"
            title={t('fileWindow.moduleMenu')}
            aria-label={t('fileWindow.moduleMenu')}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <ModulesMenuIcon />
          </button>
          {menuOpen && (
            <div className="file-v2-overflow-panel" role="menu" aria-label={t('fileWindow.allModules')}>
              {modules.map((module) => (
                <button
                  className={`${module.moduleKey === activeModuleKey ? 'selected' : ''} ${updatedModuleKeys.has(module.moduleKey) ? 'pending-update' : ''}`}
                  key={module.moduleKey}
                  type="button"
                  role="menuitemradio"
                  aria-checked={module.moduleKey === activeModuleKey}
                  onClick={() => selectModule(module.moduleKey)}
                  title={module.rawTitle}
                >
                  <span>{module.title}</span>
                  {module.moduleKey === activeModuleKey && <span className="module-menu-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const ModuleContentView = React.memo(function ModuleContentView(props: {
  changedHeadingKeys: Set<string>;
  expandedKeys: Set<string>;
  headings: RenderedHeadingNode[];
  leadingBodyChanged: boolean;
  moduleData: ModuleWindowData;
  now: number;
  onClearUpdateHighlight: (headingKey: string) => void;
  onToggleHeading: (headingKey: string) => void;
}) {
  const {
    changedHeadingKeys,
    expandedKeys,
    headings,
    leadingBodyChanged,
    moduleData,
    now,
    onClearUpdateHighlight,
    onToggleHeading,
  } = props;

  return (
    <div className="file-v2-markdown-content">
      {moduleData.leadingBodyMarkdown && (
        <div
          className={`module-leading-body ${leadingBodyChanged ? 'updated-block update-clickable' : ''}`}
          onClick={leadingBodyChanged ? () => onClearUpdateHighlight(moduleBodyUpdateKey) : undefined}
        >
          <MarkdownBlock markdown={moduleData.leadingBodyMarkdown} />
        </div>
      )}
      {headings.length > 0 ? (
        headings.map((heading) => (
          <HeadingTree
            changedHeadingKeys={changedHeadingKeys}
            expandedKeys={expandedKeys}
            heading={heading}
            highlightActive={changedHeadingKeys.size > 0}
            markerColors={moduleData.markerColors}
            now={now}
            key={heading.viewKey}
            onClearUpdateHighlight={onClearUpdateHighlight}
            onToggle={onToggleHeading}
          />
        ))
      ) : null}
    </div>
  );
});

const HeadingTree = React.memo(function HeadingTree(props: {
  changedHeadingKeys: Set<string>;
  expandedKeys: Set<string>;
  heading: RenderedHeadingNode;
  highlightActive: boolean;
  markerColors: Record<string, string>;
  now: number;
  onClearUpdateHighlight: (headingKey: string) => void;
  onToggle: (headingKey: string) => void;
}) {
  const { locale, t } = useI18n();
  const {
    changedHeadingKeys,
    expandedKeys,
    heading,
    highlightActive,
    markerColors,
    now,
    onClearUpdateHighlight,
    onToggle,
  } = props;
  const expanded = expandedKeys.has(heading.viewKey);
  const hasBody = heading.bodyMarkdown.length > 0;
  const hasChildren = heading.children.length > 0;
  const changed = highlightActive && changedHeadingKeys.has(heading.viewKey);

  return (
    <section className={`heading-node depth-${heading.depth} ${changed ? 'updated-node' : ''}`}>
      <div
        className={`heading-row ${changed ? 'update-clickable' : ''}`}
        onClick={changed ? () => onClearUpdateHighlight(heading.viewKey) : undefined}
      >
        {hasBody ? (
          <button
            className="heading-toggle"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(heading.viewKey);
            }}
            title={expanded ? t('module.collapseDescription') : t('module.expandDescription')}
            aria-label={expanded ? t('module.collapseDescription') : t('module.expandDescription')}
          >
            <ChevronIcon expanded={expanded} />
          </button>
        ) : (
          <span className={`heading-toggle-placeholder ${hasChildren ? 'has-children' : ''}`} aria-hidden="true">
            {hasChildren && <ChevronIcon expanded />}
          </span>
        )}
        <div className="heading-title">
          <h2>{heading.title}</h2>
        </div>
        <div className="marker-row">
          {heading.markers.map((marker) => (
            <MarkerChip color={markerColors[marker]} key={marker} name={marker} />
          ))}
        </div>
        <span className="heading-activity-slot">
          {heading.lastActivityAt && (
            <time
              className="activity-time heading-activity"
              dateTime={new Date(heading.lastActivityAt).toISOString()}
              title={formatActivityDateTime(heading.lastActivityAt, locale)}
            >
              {formatRelativeActivityTime(heading.lastActivityAt, now, locale)}
            </time>
          )}
        </span>
        <button
          className="row-more-btn"
          type="button"
          title={t('common.more')}
          onClick={(event) => event.stopPropagation()}
        >
          ...
        </button>
      </div>

      {expanded && hasBody && (
        <div
          className="heading-body"
          onClick={changed ? () => onClearUpdateHighlight(heading.viewKey) : undefined}
        >
          <MarkdownBlock markdown={heading.bodyMarkdown} />
        </div>
      )}

      {hasChildren && (
        <div className="heading-children">
          {heading.children.map((child) => (
            <HeadingTree
              changedHeadingKeys={changedHeadingKeys}
              expandedKeys={expandedKeys}
              heading={child}
              highlightActive={highlightActive}
              markerColors={markerColors}
              now={now}
              key={child.viewKey}
              onClearUpdateHighlight={onClearUpdateHighlight}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
});

function MarkerChip(props: { color?: string; name: string }) {
  return (
    <span className="marker" style={markerInlineStyle(props.color)}>
      {props.name}
    </span>
  );
}

function MarkerSettingsPanel(props: {
  markerStats: ModuleWindowData['markerStats'];
  onChange: (markerName: string, color: string | null) => void;
}) {
  const { markerStats, onChange } = props;
  const { t } = useI18n();
  const [selectedMarkerName, setSelectedMarkerName] = useState<string>();
  const [draftColor, setDraftColor] = useState(markerColorPresets[0]);
  const selectedMarker = markerStats.find((stat) => stat.name === selectedMarkerName);
  const customHsl = hexToHsl(draftColor);

  function updateCustomColor(channel: keyof HslColor, value: number) {
    setDraftColor(hslToHex({ ...customHsl, [channel]: value }));
  }

  function openColorEditor(markerName: string, color: string) {
    setDraftColor(color);
    setSelectedMarkerName(markerName);
  }

  function closeColorEditor() {
    setSelectedMarkerName(undefined);
  }

  function saveCustomColor() {
    if (!selectedMarker) {
      return;
    }

    onChange(selectedMarker.name, draftColor);
    closeColorEditor();
  }

  return (
    <section className="marker-settings">
      <header className="marker-settings-head">
        {selectedMarker ? (
          <MarkerChip color={draftColor} name={selectedMarker.name} />
        ) : (
          <strong>{t('module.markerColors')}</strong>
        )}
      </header>
      {markerStats.length === 0 ? (
        <p className="file-message">{t('marker.noMarkers')}</p>
      ) : selectedMarker ? (
        <div className="marker-color-editor">
          <div className="marker-custom-head">
            <span>{t('marker.customColor')}</span>
          </div>
          <div className="marker-custom-controls">
            <label>
              <span>{t('marker.hue')}</span>
              <input
                className="marker-color-range hue"
                type="range"
                min="0"
                max="360"
                value={Math.round(customHsl.h)}
                onChange={(event) => updateCustomColor('h', Number(event.target.value))}
              />
            </label>
            <label>
              <span>{t('marker.saturation')}</span>
              <input
                className="marker-color-range"
                type="range"
                min="0"
                max="100"
                value={Math.round(customHsl.s)}
                style={{ background: `linear-gradient(90deg, ${hslToHex({ ...customHsl, s: 0 })}, ${hslToHex({ ...customHsl, s: 100 })})` }}
                onChange={(event) => updateCustomColor('s', Number(event.target.value))}
              />
            </label>
            <label>
              <span>{t('marker.lightness')}</span>
              <input
                className="marker-color-range"
                type="range"
                min="12"
                max="88"
                value={Math.round(customHsl.l)}
                style={{ background: `linear-gradient(90deg, ${hslToHex({ ...customHsl, l: 12 })}, ${hslToHex({ ...customHsl, l: 50 })}, ${hslToHex({ ...customHsl, l: 88 })})` }}
                onChange={(event) => updateCustomColor('l', Number(event.target.value))}
              />
            </label>
          </div>
          <div className="marker-presets-head">{t('marker.presetColors')}</div>
          <div className="marker-palette" aria-label={t('marker.presetsLabel', { name: selectedMarker.name })}>
            {markerColorPresets.map((color) => (
              <button
                className={`marker-swatch ${draftColor.toLowerCase() === color ? 'active' : ''}`}
                key={color}
                type="button"
                aria-label={t('marker.useColor', { name: selectedMarker.name, color })}
                aria-pressed={draftColor.toLowerCase() === color}
                onClick={() => setDraftColor(color)}
              >
                <span style={{ backgroundColor: color }} />
              </button>
            ))}
          </div>
          <div className="marker-editor-actions">
            <button className="marker-editor-cancel" type="button" onClick={closeColorEditor}>{t('common.cancel')}</button>
            <button className="marker-editor-save" type="button" onClick={saveCustomColor}>{t('common.done')}</button>
          </div>
        </div>
      ) : (
        <div className="marker-setting-list">
          {markerStats.map((stat) => (
            <div className="marker-setting-row" key={stat.name}>
              <button
                className="marker-setting-label"
                type="button"
                onClick={() => openColorEditor(stat.name, stat.color)}
              >
                <span
                  className="marker-color-preview"
                  style={{ backgroundColor: stat.color }}
                  aria-hidden="true"
                />
                <span>{stat.name}</span>
                <span className="marker-color-value">{stat.color.toUpperCase()}</span>
              </button>
              <button
                className="marker-auto-btn"
                type="button"
                title={t('marker.autoColor', { name: stat.name })}
                aria-label={t('marker.autoColor', { name: stat.name })}
                onClick={() => onChange(stat.name, null)}
              >
                <RefreshColorIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WindowControls() {
  const { t } = useI18n();
  return (
    <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
      <button
        className="window-control"
        type="button"
        title={t('common.minimize')}
        aria-label={t('common.minimize')}
        onClick={() => window.workboard.controlCurrentWindow('minimize')}
      >
        −
      </button>
      <button
        className="window-control"
        type="button"
        title={t('common.maximizeRestore')}
        aria-label={t('common.maximizeRestore')}
        onClick={() => window.workboard.controlCurrentWindow('toggle-maximize')}
      >
        □
      </button>
      <button
        className="window-control close"
        type="button"
        title={t('common.close')}
        aria-label={t('common.close')}
        onClick={() => window.workboard.controlCurrentWindow('close')}
      >
        ×
      </button>
    </div>
  );
}

function ChevronIcon(props: { expanded: boolean }) {
  return (
    <svg className={`tree-chevron ${props.expanded ? 'expanded' : ''}`} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.8 7.7 6 4.5 9.2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="tree-folder-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.4 3.3h3.9l1.3 1.6h6v7.9H2.4Z" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 3.2v9.6M4 12.8 2.2 11M4 12.8 5.8 11M8 4h5M8 8h3.8M8 12h2.2" />
    </svg>
  );
}

function ModulesMenuIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M3 8h10M3 11.5h7" />
    </svg>
  );
}

function CollapseTreeIcon(props: { expanded: boolean }) {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      {props.expanded ? (
        <path d="M4.5 2.5 8 5.5l3.5-3M4.5 13.5 8 10.5l3.5 3" />
      ) : (
        <path d="M4.5 5.5 8 2.5l3.5 3M4.5 10.5 8 13.5l3.5-3" />
      )}
    </svg>
  );
}

function PinIcon() {
  return (
    <svg className="pin-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.2 2.8h3.6M7 2.8v4.1L4.8 9.1h6.4L9 6.9V2.8M8 9.1v4.1" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.9 2.2h2.2l.4 1.5 1.2.5 1.4-.8 1.1 1.9-1.1 1 .1 1.4 1.2.9-1.1 1.9-1.5-.4-1 .8-.4 1.5H6.6l-.4-1.5-1-.8-1.5.4-1.1-1.9 1.2-.9.1-1.4-1.1-1 1.1-1.9 1.4.8 1.2-.5.4-1.5Z" />
      <path d="M6 8a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" />
    </svg>
  );
}

function RefreshColorIcon() {
  return (
    <svg className="marker-auto-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.8 6.2A5 5 0 1 0 13 9" />
      <path d="m10.5 3.8 2.5 2.5 1.8-2.8" />
    </svg>
  );
}

function AppLogo() {
  return <img className="app-icon" src={workboardLogo} alt="" aria-hidden="true" />;
}

function MarkdownFileIcon() {
  return (
    <svg className="markdown-file-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 1.8h6.1l3.5 3.5v8.9H3.2Z" />
      <path d="M9.3 1.8v3.5h3.5M5.4 8h5.2M5.4 10.5h4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3 3" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 3.5v4l6 6 5-5-6-6h-5Z" />
      <path d="M5.2 5.2h.1" />
    </svg>
  );
}

function WorkflowIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.2h3v3H3zM10 2.8h3v3h-3zM10 10.2h3v3h-3zM6 5.7h1.2c1.2 0 1.8-.5 2.2-1.4M6 5.7h1.2c1.2 0 1.8.5 2.2 1.7L10 9" />
    </svg>
  );
}

function FolderSwitchIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.2 5.2h11.6v6.6a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V5.2Z" />
      <path d="M2.2 5.2V4.1c0-.7.5-1.1 1.2-1.1h3l1.2 1.2h5c.7 0 1.2.5 1.2 1" />
      <path d="M6.2 8h4.1M8.7 6.6 10.3 8 8.7 9.4" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.8 4.2 6 8l3.8 3.8M6.4 8H13" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="status-clock-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8v3.5l2.2 1.3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg className="line-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.8 8s2.1-4 6.2-4 6.2 4 6.2 4-2.1 4-6.2 4-6.2-4-6.2-4Z" />
      <path d="M6.2 8a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 0 0-3.6 0Z" />
    </svg>
  );
}

const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <button
      className="markdown-link"
      type="button"
      onClick={() => {
        if (href) {
          void window.workboard.openExternalUrl(href);
        }
      }}
    >
      {children}
    </button>
  ),
};

function TodoNotePreview(props: { markdown: string }) {
  return (
    <span className="todo-note-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
          p: ({ children }: { children?: React.ReactNode }) => <span className="todo-note-paragraph">{children}</span>,
        }}
      >
        {props.markdown}
      </ReactMarkdown>
    </span>
  );
}

const MarkdownBlock = React.memo(function MarkdownBlock(props: { markdown: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
});

function collectExpandableHeadingKeys(headings: RenderedHeadingNode[]): string[] {
  return headings.flatMap((heading) => [
    ...(heading.bodyMarkdown.length > 0 ? [heading.viewKey] : []),
    ...collectExpandableHeadingKeys(heading.children),
  ]);
}

function mergeFileWindowV2Payload(
  previous: FileWindowV2InitialPayload | null,
  next: FileWindowV2InitialPayload,
): FileWindowV2InitialPayload {
  if (!previous || previous.relativePath !== next.relativePath) {
    return next;
  }

  const mergedModules = next.modules.map((nextModule) => {
    const prevModule = previous.modules.find((m) => m.moduleKey === nextModule.moduleKey);
    if (!prevModule) {
      return nextModule;
    }

    if (modulesContentEqual(prevModule, nextModule)) {
      return prevModule;
    }

    return {
      ...nextModule,
      headings: mergeHeadings(prevModule.headings, nextModule.headings),
    };
  });

  return {
    ...next,
    modules: mergedModules,
  };
}



function buildLauncherFileTree(files: ManagedFileState[], sortMode: LauncherSortMode): LauncherFileTree {
  const root: LauncherFileTree = { folders: [], files: [] };
  const folderMap = new Map<string, LauncherFileTreeFolder>();

  for (const file of files) {
    const parts = file.path.replaceAll('\\', '/').split('/');
    const fileName = parts.pop();

    if (!fileName) {
      continue;
    }

    let current = root;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folderMap.get(currentPath);

      if (!folder) {
        folder = {
          key: currentPath,
          name: part,
          folders: [],
          files: [],
        };
        folderMap.set(currentPath, folder);
        current.folders.push(folder);
      }

      folder.lastActivityAt = maxOptionalTimestamp(folder.lastActivityAt, file.lastActivityAt);
      current = folder;
    }

    current.files.push(file);
  }

  sortLauncherTree(root, sortMode);

  return root;
}

function launcherSortLabel(mode: LauncherSortMode, t: I18nContextValue['t']): string {
  switch (mode) {
    case 'name-asc':
      return t('sort.nameAsc');
    case 'name-desc':
      return t('sort.nameDesc');
    case 'activity-desc':
      return t('sort.activityDesc');
    case 'activity-asc':
      return t('sort.activityAsc');
  }
}

function sortLauncherTree(tree: LauncherFileTree, sortMode: LauncherSortMode): void {
  const compareFiles = (left: ManagedFileState, right: ManagedFileState) => {
    if (sortMode === 'activity-desc' || sortMode === 'activity-asc') {
      const activityCompare = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);

      if (activityCompare !== 0) {
        return sortMode === 'activity-desc' ? activityCompare : -activityCompare;
      }
    }

    const nameCompare = fileNameWithoutMarkdownExtension(left.path).localeCompare(fileNameWithoutMarkdownExtension(right.path), 'zh-Hans-CN');

    return sortMode === 'name-desc' ? -nameCompare : nameCompare;
  };
  const compareFolders = (left: LauncherFileTreeFolder, right: LauncherFileTreeFolder) => {
    if (sortMode === 'activity-desc' || sortMode === 'activity-asc') {
      const activityCompare = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);

      if (activityCompare !== 0) {
        return sortMode === 'activity-desc' ? activityCompare : -activityCompare;
      }
    }

    const nameCompare = left.name.localeCompare(right.name, 'zh-Hans-CN');

    return sortMode === 'name-desc' ? -nameCompare : nameCompare;
  };

  tree.folders.sort(compareFolders);
  tree.files.sort(compareFiles);

  for (const folder of tree.folders) {
    sortLauncherTree(folder, sortMode);
  }
}

function collectLauncherFolderKeys(tree: LauncherFileTree): string[] {
  return tree.folders.flatMap((folder) => [folder.key, ...collectLauncherFolderKeys(folder)]);
}

function maxOptionalTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return Math.max(left, right);
}

function treeDepthPadding(depth: number): number {
  return 8 + depth * 16;
}

function markerInlineStyle(color?: string): React.CSSProperties {
  if (!color) {
    return {};
  }

  return {
    borderColor: color,
    color,
    backgroundColor: `${color}18`,
  };
}

function countRenderedHeadings(headings: RenderedHeadingNode[]): number {
  return headings.reduce((count, heading) => count + 1 + countRenderedHeadings(heading.children), 0);
}


function countModuleWords(module: ModuleWindowData): number {
  const parts: string[] = [module.title, module.leadingBodyMarkdown];
  const collect = (headings: RenderedHeadingNode[]) => {
    for (const heading of headings) {
      parts.push(heading.title, heading.bodyMarkdown);
      collect(heading.children);
    }
  };
  collect(module.headings);
  return (parts.join(' ').match(/[\p{L}\p{N}\u3400-\u9fff]/gu) ?? []).length;
}

function randomMarkerColor(currentColor?: string): string {
  const normalizedCurrent = currentColor?.toLowerCase();
  const candidates = markerColorPresets.filter((color) => color !== normalizedCurrent);

  return candidates[Math.floor(Math.random() * candidates.length)] ?? markerColorPresets[0];
}

type HslColor = { h: number; s: number; l: number };

function hexToHsl(color: string): HslColor {
  const normalized = color.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;

  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }

  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function hslToHex(color: HslColor): string {
  const saturation = color.s / 100;
  const lightness = color.l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = color.h / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1 ? [chroma, secondary, 0]
    : segment < 2 ? [secondary, chroma, 0]
      : segment < 3 ? [0, chroma, secondary]
        : segment < 4 ? [0, secondary, chroma]
          : segment < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  const channel = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function useRelativeTimeTick(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), minuteMs);

    return () => window.clearInterval(timer);
  }, []);

  return now;
}

function logRendererUpdateTrace(scope: string, state: WorkspaceState) {
  const diagnostic = state.diagnosticUpdate;

  if (!diagnostic) {
    return;
  }

  const key = `${scope}:${diagnostic.id}`;

  if (loggedRendererTraces.has(key)) {
    return;
  }

  loggedRendererTraces.add(key);
  const receivedAt = Date.now();

  window.requestAnimationFrame(() => {
    const appliedAt = Date.now();

    console.log(
      `[workboard:update-renderer:${diagnostic.id}] ${scope} ${diagnostic.relativePath} ` +
        `mainBroadcast->rendererReceived=${receivedAt - diagnostic.broadcastAt}ms ` +
        `rendererApply=${appliedAt - receivedAt}ms ` +
        `mainBroadcast->applied=${appliedAt - diagnostic.broadcastAt}ms`,
    );
  });
}

function fileUpdateLabel(updateStatus: FileUpdateStatus, t: I18nContextValue['t']): string {
  if (updateStatus.phase === 'updating') {
    return t('file.updating');
  }

  if (updateStatus.phase === 'error') {
    return t('file.updateFailed');
  }

  return t('file.justUpdated');
}

function statusLabel(file: ManagedFileState, t: I18nContextValue['t']): string {
  if (file.status === 'missing') {
    return t('file.unavailableMissing');
  }

  if (file.status === 'unreadable') {
    return t('file.unavailableUnreadable');
  }

  if (file.status === 'parse-error') {
    return t('file.markdownParseFailed');
  }

  return '';
}

function fileDisplayName(relativePath: string): string {
  return relativePath.split(/[\\/]/).pop() ?? relativePath;
}

function fileNameWithoutMarkdownExtension(relativePath: string): string {
  return fileDisplayName(relativePath).replace(/\.md$/i, '');
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  return `${(size / 1024).toFixed(1)} KB`;
}

async function runAction(
  action: () => Promise<WorkspaceState>,
  setState: (state: WorkspaceState) => void,
  setNotice: (notice: Notice | null) => void,
  setBusy: (busy: boolean) => void,
  fallbackError: string,
) {
  setBusy(true);
  setNotice(null);

  try {
    setState(await action());
  } catch (error) {
    setNotice({ kind: 'error', text: error instanceof Error ? error.message : fallbackError });
  } finally {
    setBusy(false);
  }
}

async function runCommand(
  action: () => Promise<void>,
  setNotice: (notice: Notice | null) => void,
  setBusy: (busy: boolean) => void,
  fallbackError: string,
) {
  setBusy(true);
  setNotice(null);

  try {
    await action();
  } catch (error) {
    setNotice({ kind: 'error', text: error instanceof Error ? error.message : fallbackError });
  } finally {
    setBusy(false);
  }
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Renderer root element is missing.');
}

createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
