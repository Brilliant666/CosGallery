// Test-only entry: actual shell and gallery components, no production startup.
import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
import AppShell from '../src/components/AppShell.vue';
import CosGalleryHomeView from '../src/views/CosGalleryHomeView.vue';
import CanonicalCreatorView from '../src/views/CanonicalCreatorView.vue';
import HomeView from '../src/views/HomeView.vue';
import { useAuthStore } from '../src/stores/auth';
import { useAppStore } from '../src/stores/app';
import { useFeedStore } from '../src/stores/feed';
import { useMomentsStore } from '../src/stores/moments';
import type { AppStatus, MomentCapsule } from '../src/types/api';
import { i18n } from '../src/locales';
import '../src/styles/base.css';
import 'virtual:uno.css';

const placeholder = { render: () => h('p', 'Synthetic navigation placeholder') };
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/library', name: 'library', component: CosGalleryHomeView },
  { path: '/library/:creatorId', name: 'canonical-creator', component: CanonicalCreatorView, props: true },
  { path: '/', name: 'home', component: HomeView },
  ...['reels', 'explore', 'places', 'likes', 'collections', 'trash', 'archive-catalog', 'creator-admission', 'settings', 'folder']
    .map(name => ({ path: `/${name}`, name, component: placeholder }))
] });
const pinia = createPinia();
const app = createApp({ render: () => h(AppShell, null, { default: () => h(RouterView) }) });
app.use(pinia).use(i18n).use(router);
const auth = useAuthStore(pinia);
// Real HomeView markup, layout observers and styles; no production startup or home API.
useAppStore(pinia).stats = {
  folders: 0, indexedImages: 0, indexedVideos: 0,
  scan: { isScanning: false, lastCompletedScan: null },
  storage: { available: true, reason: null },
  libraryIndex: { rebuildRequired: false, reason: null, ignoredRootMediaCount: 0 },
  preferences: { defaultHomeFeedMode: 'random', defaultReelsFeedMode: 'recommended', treatStoriesAsFolders: false },
  storiesMigration: { hasLegacyStoriesCandidates: false, decisionPending: false }
} as AppStatus;
const feed = useFeedStore(pinia);
feed.initialized = true;
feed.hasMore = false;
feed.loadInitial = async () => {};
const moments = useMomentsStore(pinia);
moments.railKind = 'highlights';
moments.items = Array.from({ length: 3 }, (_, index) => ({
  id: `synthetic-batch-${index + 1}`, title: `合成近期批次${index + 1}`, subtitle: '隔离布局样本',
  dateContext: '2026-10-24', imageCount: 1,
  coverImage: { id: index + 1, folderId: 1, folderSlug: 'synthetic', folderName: '合成样本', folderPath: 'Synthetic',
    folderBreadcrumb: null, filename: 'synthetic.svg', width: 100, height: 100, mediaType: 'image', durationMs: null,
    thumbnailUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#b7d9ed"/><circle cx="50" cy="50" r="25" fill="#346b89"/></svg>')}`,
    previewUrl: '', sortTimestamp: 1792800000000, takenAt: 1792800000000 }
} satisfies MomentCapsule));
moments.fetchMoments = async () => {};
const role = new URLSearchParams(location.search).get('role') ?? 'admin';
auth.ready = true;
if (role !== 'admin') {
  auth.applyStatus({
    enabled: true, authenticated: role === 'viewer', role: role === 'viewer' ? 'viewer' : 'anonymous',
    accessMode: 'public', likesMode: role === 'viewer' ? 'shared' : 'local', defaultLocale: 'zh',
    capabilities: {
      canManageLibrary: false, canDeleteMedia: false, canAccessSettings: false,
      canUseSharedLikes: role === 'viewer', canUseLocalFavorites: role !== 'viewer',
      canUseSharedCollections: role === 'viewer', canUseLocalCollections: role !== 'viewer'
    }
  });
}
router.isReady().then(() => app.mount('#app'));
