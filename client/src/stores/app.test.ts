import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LOCALE, i18n } from '../locales';
import { ACCENT_COLORS, type AppStatus } from '../types/api';
import { useAppStore } from './app';
import { useAuthStore } from './auth';

const {
  fetchAdminScanProgressMock,
  fetchAdminStatsMock,
  fetchScanProgressMock,
  fetchStatusMock
} = vi.hoisted(() => ({
  fetchAdminScanProgressMock: vi.fn(),
  fetchAdminStatsMock: vi.fn(),
  fetchScanProgressMock: vi.fn(),
  fetchStatusMock: vi.fn()
}));

vi.mock('../api/gallery', () => ({
  fetchAdminScanProgress: fetchAdminScanProgressMock,
  fetchAdminStats: fetchAdminStatsMock,
  fetchScanProgress: fetchScanProgressMock,
  fetchStats: fetchStatusMock
}));

function setNavigatorLocales(locales: string[], language = locales[0] ?? 'en-US') {
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    value: locales
  });

  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: language
  });
}

function createAppStatus(defaultLocale: AppStatus['preferences']['defaultLocale'] = null): AppStatus {
  return {
    folders: 3,
    indexedImages: 18,
    indexedVideos: 6,
    scan: {
      isScanning: false,
      scanReason: null,
      phase: 'idle',
      startedAt: null,
      runId: null,
      migrationTotalRows: 0,
      processedMigrationRows: 0,
      migratedDerivativeFiles: 0,
      missingDerivativeFiles: 0,
      repairedDerivativeFiles: 0,
      backfilledAssetKeys: 0,
      discoveredFolders: 0,
      processedFolders: 0,
      discoveredImages: 0,
      processedImages: 0,
      queuedDerivativeJobs: 0,
      processedDerivativeJobs: 0,
      generatedThumbnails: 0,
      generatedPreviews: 0,
      currentOperation: null,
      currentFile: null,
      currentPhaseMessage: null,
      currentFolder: null,
      lastCompletedScan: null
    },
    storage: {
      available: true,
      reason: null
    },
    libraryIndex: {
      rebuildRequired: false,
      reason: null,
      ignoredRootMediaCount: 0
    },
    preferences: {
      defaultLocale,
      defaultHomeFeedMode: 'random',
      defaultReelsFeedMode: 'random',
      defaultFolderImageOrder: 'newest',
      treatStoriesAsFolders: false
    },
    storiesMigration: {
      hasLegacyStoriesCandidates: false,
      decisionPending: false
    }
  };
}

describe('browser-local creator history', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  it('keeps legacy history and restores canonical creator visits in the latest order after reload', () => {
    window.localStorage.setItem('foldergram-last-opened-folder', 'legacy-a');
    window.localStorage.setItem('foldergram-recent-opened-folders', JSON.stringify(['legacy-b', 'legacy-a']));
    const store = useAppStore();
    store.initializeLastOpenedFolder();
    store.recordOpenedRoute({ name: 'canonical-creator', params: { creatorId: '42' } });
    store.recordOpenedRoute({ name: 'canonical-work-gallery', params: { creatorId: '7', postId: '900' } });
    store.recordOpenedRoute({ name: 'canonical-work-gallery', params: { creatorId: '42', postId: '901' } });
    expect(store.recentOpenedCreatorKeys).toEqual(['creator:42', 'creator:7', 'legacy-a', 'legacy-b']);
    expect(store.recentOpenedFolderSlugs).toEqual(['legacy-a', 'legacy-b']);
    expect(store.lastOpenedFolderSlug).toBe('legacy-a');
    expect(JSON.parse(window.localStorage.getItem('foldergram-recent-opened-folders')!)).toEqual(['legacy-a', 'legacy-b']);
    expect(window.localStorage.getItem('foldergram-last-opened-folder')).toBe('legacy-a');

    setActivePinia(createPinia());
    const reloaded = useAppStore();
    reloaded.initializeLastOpenedFolder();
    expect(reloaded.recentOpenedCreatorKeys).toEqual(store.recentOpenedCreatorKeys);
    expect(reloaded.recentOpenedFolderSlugs).toEqual(store.recentOpenedFolderSlugs);
  });

  it('records legacy folder and work routes while ignoring unrelated pages and malformed creator ids', () => {
    const store = useAppStore();
    store.recordOpenedRoute({ name: 'folder', params: { slug: 'legacy-a' } });
    store.recordOpenedRoute({ name: 'work-gallery', params: { slug: 'legacy-b', postId: '99' } });
    for (const creatorId of ['0', '-1', 'NaN', '12suffix', '9007199254740992', ['42']]) {
      store.recordOpenedRoute({ name: 'canonical-creator', params: { creatorId } });
    }
    store.recordOpenedRoute({ name: 'library', params: {} });
    store.recordOpenedRoute({ name: 'archive-catalog', params: { creatorId: '42' } });
    expect(store.recentOpenedFolderSlugs).toEqual(['legacy-b', 'legacy-a']);
    expect(store.recentOpenedCreatorKeys).toEqual(['legacy-b', 'legacy-a']);
    expect(JSON.parse(window.localStorage.getItem('foldergram-recent-opened-folders')!)).toEqual(['legacy-b', 'legacy-a']);
  });

  it('does not import old history again after a deliberately empty creator history is saved', () => {
    window.localStorage.setItem('foldergram-last-opened-folder', 'legacy-a');
    window.localStorage.setItem('cosgallery-recent-viewed-creators', '[]');
    const store = useAppStore();
    store.initializeLastOpenedFolder();
    expect(store.recentOpenedCreatorKeys).toEqual([]);
    expect(store.lastOpenedFolderSlug).toBe('legacy-a');
  });
});

describe('useAppStore locale preferences', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    setNavigatorLocales(['en-US']);
    document.documentElement.lang = '';
    document.documentElement.dataset.accent = 'blue';
    i18n.global.locale.value = DEFAULT_LOCALE;
    fetchAdminScanProgressMock.mockReset();
    fetchAdminStatsMock.mockReset();
    fetchScanProgressMock.mockReset();
    fetchStatusMock.mockReset();
  });

  it('ignores a late stats response after access reset and permits a new read', async () => {
    let resolve!: (value: AppStatus) => void;
    fetchAdminStatsMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolve = done; }));
    const store = useAppStore();
    const first = store.fetchStats();
    expect(fetchAdminStatsMock).toHaveBeenCalledTimes(1);
    store.resetProtectedState();
    resolve(createAppStatus());
    await first;
    expect(store.stats).toBeNull();
    fetchAdminStatsMock.mockResolvedValueOnce(createAppStatus());
    await store.fetchStats();
    expect(store.stats).not.toBeNull();
  });

  it.each(ACCENT_COLORS)('applies public site accent %s without changing browser theme or saving a local override', async (accentColor) => {
    useAuthStore().$patch({ role: 'anonymous', authenticated: false, accessMode: 'public', capabilities: { canAccessSettings: false } });
    const status = createAppStatus(); status.preferences.accentColor = accentColor;
    fetchStatusMock.mockResolvedValueOnce(status);
    const store = useAppStore(); store.setTheme('dark');
    await store.fetchStats();
    expect(store.accentColor).toBe(accentColor);
    expect(document.documentElement.dataset.accent).toBe(accentColor);
    expect(document.documentElement.dataset.theme).toBe('dark');
    store.setTheme('light');
    expect(document.documentElement.dataset.accent).toBe(accentColor);
    expect(window.localStorage.length).toBe(1);
    expect(fetchAdminStatsMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'unknown', 'RED'])('uses blue for an absent or invalid public accent (%s)', async (value) => {
    const status = createAppStatus();
    status.preferences.accentColor = value as AppStatus['preferences']['accentColor'];
    fetchAdminStatsMock.mockResolvedValueOnce(status);
    await useAppStore().fetchStats();
    expect(useAppStore().accentColor).toBe('blue');
    expect(document.documentElement.dataset.accent).toBe('blue');
  });

  it('does not apply a stale admin accent response after an anonymous refresh', async () => {
    let resolveOld!: (value: AppStatus) => void;
    fetchAdminStatsMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolveOld = done; }));
    const store = useAppStore(); const old = store.fetchStats();
    useAuthStore().$patch({ role: 'anonymous', capabilities: { canAccessSettings: false } });
    const current = createAppStatus(); current.preferences.accentColor = 'teal';
    fetchStatusMock.mockResolvedValueOnce(current); await store.fetchStats();
    const stale = createAppStatus(); stale.preferences.accentColor = 'rose'; resolveOld(stale); await old;
    expect(document.documentElement.dataset.accent).toBe('teal');
  });

  it('shares equivalent light initialization even for an administrator', async () => {
    let resolve!: (value: AppStatus) => void;
    fetchStatusMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolve = done; }));
    const store = useAppStore();
    const first = store.ensureStatus();
    const second = store.ensureStatus();
    expect(fetchStatusMock).toHaveBeenCalledTimes(1);
    expect(fetchAdminStatsMock).not.toHaveBeenCalled();
    resolve(createAppStatus());
    await Promise.all([first, second]);
    await store.ensureStatus();
    expect(fetchStatusMock).toHaveBeenCalledTimes(1);
  });

  it('retries failed initialization and detaches old initial reads after a forced refresh', async () => {
    fetchStatusMock.mockRejectedValueOnce(new Error('offline'));
    const store = useAppStore();
    await store.ensureStatus();
    expect(store.error).toBe('offline');
    let resolveOld!: (value: AppStatus) => void;
    fetchStatusMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolveOld = done; }))
      .mockResolvedValueOnce({ ...createAppStatus(), indexedPosts: 99 });
    const old = store.ensureStatus();
    await store.ensureStatus(true);
    resolveOld({ ...createAppStatus(), indexedPosts: 1 });
    await old;
    expect(fetchStatusMock).toHaveBeenCalledTimes(3);
    expect(store.stats?.indexedPosts).toBe(99);
    expect(store.error).toBeNull();
    expect(store.loadingStats).toBe(false);
  });

  it('does not share initial reads across permission contexts or accept old scan polling', async () => {
    const store = useAppStore();
    let resolveOld!: (value: AppStatus) => void;
    fetchStatusMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolveOld = done; }))
      .mockResolvedValueOnce(createAppStatus('es'));
    const old = store.ensureStatus();
    useAuthStore().capabilities.canAccessSettings = false;
    await store.ensureStatus();
    resolveOld(createAppStatus('en'));
    await old;
    expect(fetchStatusMock).toHaveBeenCalledTimes(2);
    expect(store.stats?.preferences.defaultLocale).toBe('es');
    let resolveScan!: (value: AppStatus['scan']) => void;
    fetchScanProgressMock.mockImplementationOnce(() => new Promise<AppStatus['scan']>(done => { resolveScan = done; }));
    const scan = store.refreshScanProgress();
    store.resetProtectedState();
    resolveScan(createAppStatus().scan);
    await scan;
    expect(store.stats).toBeNull();
    expect(fetchStatusMock).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate a newer post-mutation stats refresh into an older read', async () => {
    let resolveOld!: (value: AppStatus) => void;
    fetchAdminStatsMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolveOld = done; }))
      .mockResolvedValueOnce({ ...createAppStatus(), indexedPosts: 99 });
    const store = useAppStore();
    const old = store.fetchStats();
    await store.fetchStats({ background: true });
    expect(fetchAdminStatsMock).toHaveBeenCalledTimes(2);
    resolveOld({ ...createAppStatus(), indexedPosts: 1 });
    await old;
    expect(store.stats?.indexedPosts).toBe(99);
    expect(store.loadingStats).toBe(false);
  });

  it('does not reuse or accept an admin stats request after the endpoint capability changes', async () => {
    let resolveOld!: (value: AppStatus) => void;
    fetchAdminStatsMock.mockImplementationOnce(() => new Promise<AppStatus>(done => { resolveOld = done; }));
    fetchStatusMock.mockResolvedValueOnce(createAppStatus('fr'));
    const store = useAppStore();
    const old = store.fetchStats();
    useAuthStore().capabilities.canAccessSettings = false;
    await store.fetchStats();
    resolveOld(createAppStatus('en'));
    await old;
    expect(fetchStatusMock).toHaveBeenCalledTimes(1);
    expect(store.stats?.preferences.defaultLocale).toBe('fr');
  });

  it('initializes locale from localStorage before browser preferences', () => {
    window.localStorage.setItem('foldergram-locale', 'en');
    setNavigatorLocales(['fr-FR'], 'fr-FR');

    const store = useAppStore();
    store.initializeLocale();

    expect(store.locale).toBe('en');
    expect(i18n.global.locale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('normalizes stored region locales on startup', () => {
    window.localStorage.setItem('foldergram-locale', 'zh-TW');

    const store = useAppStore();
    store.initializeLocale();

    expect(store.locale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBe('zh');
  });

  it('falls back to Chinese when the stored locale is unsupported', () => {
    window.localStorage.setItem('foldergram-locale', 'fr');
    setNavigatorLocales(['de-DE'], 'de-DE');

    const store = useAppStore();
    store.initializeLocale();

    expect(store.locale).toBe(DEFAULT_LOCALE);
    expect(i18n.global.locale.value).toBe(DEFAULT_LOCALE);
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBeNull();
  });

  it('starts a fresh profile in Chinese even when the browser prefers Spanish', () => {
    setNavigatorLocales(['es-ES'], 'es-ES');

    const store = useAppStore();
    store.initializeLocale();

    expect(store.locale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBeNull();
  });

  it('normalizes Chinese browser locales to zh', () => {
    setNavigatorLocales(['zh-CN'], 'zh-CN');

    const store = useAppStore();
    store.initializeLocale();

    expect(store.locale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBeNull();
  });

  it('normalizes region locales before persisting them', () => {
    const store = useAppStore();
    store.setLocale('zh-TW');

    expect(store.locale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBe('zh');
  });

  it('applies the saved app default locale after stats load when no local override exists', async () => {
    setNavigatorLocales(['en-US'], 'en-US');
    fetchAdminStatsMock.mockResolvedValue(createAppStatus('zh'));

    const store = useAppStore();
    store.initializeLocale();
    await store.fetchStats();

    expect(store.locale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBeNull();
  });

  it('applies the auth-status app default locale when no local override exists', () => {
    setNavigatorLocales(['en-US'], 'en-US');

    const store = useAppStore();
    store.initializeLocale();
    store.syncLocaleFromAuthStatus('zh');

    expect(store.locale).toBe('zh');
    expect(i18n.global.locale.value).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('foldergram-locale')).toBeNull();
  });

  it('keeps the browser local override ahead of the saved app default locale', async () => {
    window.localStorage.setItem('foldergram-locale', 'es');
    fetchAdminStatsMock.mockResolvedValue(createAppStatus('zh'));

    const store = useAppStore();
    store.initializeLocale();
    await store.fetchStats();

    expect(store.locale).toBe('es');
    expect(i18n.global.locale.value).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(window.localStorage.getItem('foldergram-locale')).toBe('es');
  });

  it('honors an explicitly saved English app default without persisting a browser override', () => {
    const store = useAppStore();
    store.initializeLocale();
    expect(store.locale).toBe('zh');
    store.syncLocaleFromAuthStatus('en');
    expect(store.locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem('foldergram-locale')).toBeNull();
    store.setLocale('es');
    expect(window.localStorage.getItem('foldergram-locale')).toBe('es');
    store.syncLocaleFromAuthStatus('zh');
    expect(store.locale).toBe('es');
  });

  it('keeps the browser local override ahead of the auth-status app default locale', () => {
    window.localStorage.setItem('foldergram-locale', 'es');

    const store = useAppStore();
    store.initializeLocale();
    store.syncLocaleFromAuthStatus('zh');

    expect(store.locale).toBe('es');
    expect(i18n.global.locale.value).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(window.localStorage.getItem('foldergram-locale')).toBe('es');
  });
});
