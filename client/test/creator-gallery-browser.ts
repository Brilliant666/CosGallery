// Test-only entry: actual shell and gallery components, no production startup.
import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
import AppShell from '../src/components/AppShell.vue';
import CosGalleryHomeView from '../src/views/CosGalleryHomeView.vue';
import CanonicalCreatorView from '../src/views/CanonicalCreatorView.vue';
import { useAuthStore } from '../src/stores/auth';
import { i18n } from '../src/locales';
import '../src/styles/base.css';
import 'virtual:uno.css';

const placeholder = { render: () => h('p', 'Synthetic navigation placeholder') };
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/library', name: 'library', component: CosGalleryHomeView },
  { path: '/library/:creatorId', name: 'canonical-creator', component: CanonicalCreatorView, props: true },
  { path: '/', name: 'home', component: placeholder },
  ...['reels', 'explore', 'places', 'likes', 'collections', 'trash', 'archive-catalog', 'creator-admission', 'settings', 'folder']
    .map(name => ({ path: `/${name}`, name, component: placeholder }))
] });
const pinia = createPinia();
const app = createApp({ render: () => h(AppShell, null, { default: () => h(RouterView) }) });
app.use(pinia).use(i18n).use(router);
const auth = useAuthStore(pinia);
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
