import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
import { i18n } from '../src/locales';
import CanonicalCreatorView from '../src/views/CanonicalCreatorView.vue';
import ArchiveCatalogView from '../src/views/ArchiveCatalogView.vue';
import '../src/styles/base.css';
import 'virtual:uno.css';

const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/library/:creatorId', name: 'canonical-creator', component: CanonicalCreatorView, props: true },
  { path: '/library', name: 'library', component: { render: () => h('div', 'Synthetic library') } },
  { path: '/archive-catalog', name: 'archive-catalog', component: ArchiveCatalogView }
] });
const app = createApp({ render: () => h(RouterView) });
app.use(createPinia()).use(i18n).use(router);
router.isReady().then(() => app.mount('#app'));
