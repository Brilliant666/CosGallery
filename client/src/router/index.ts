import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { installRouteLoadRecovery } from '../utils/route-load-recovery';
import { isGalleryReadingRoute, sanitizedGalleryQuery } from '../utils/creator-gallery-labels';

import HomeView from '../views/HomeView.vue';
import PostView from '../views/PostView.vue';
import LibraryView from '../views/CosGalleryHomeView.vue';
import LikesView from '../views/LikesView.vue';
import CollectionsView from '../views/CollectionsView.vue';
import CollectionView from '../views/CollectionView.vue';
import ExploreView from '../views/ExploreView.vue';
import FolderView from '../views/FolderView.vue';
import WorkGalleryView from '../views/WorkGalleryView.vue';
import CanonicalCreatorView from '../views/CanonicalCreatorView.vue';
import MomentView from '../views/MomentView.vue';
import PlaceView from '../views/PlaceView.vue';
import PlacesView from '../views/PlacesView.vue';
import ReelsView from '../views/ReelsView.vue';
import SharedFolderView from '../views/SharedFolderView.vue';
import SharedPostView from '../views/SharedPostView.vue';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { pinia } from '../stores/pinia';
import { admissionDefaultDestination, legacyCatalogDestination } from '../utils/creator-admission-navigation';
import type { AuthCapabilities } from '../types/api';

type RouteCapability = keyof AuthCapabilities;

// Keep ordinary browsing in the entry; route-owned management modules load
// only after navigation/permission guards. Component identity and KeepAlive
// keys remain Vue Router's existing route components, not async wrappers.
const TrashView = () => import('../views/TrashView.vue');
const SettingsView = () => import('../views/SettingsView.vue');
const ArchiveCatalogView = () => import('../views/ArchiveCatalogView.vue');
const LocalAdmissionView = () => import('../views/LocalAdmissionView.vue');
const LocalAdmissionWorkspace = () => import('../views/LocalAdmissionWorkspace.vue');
const LocalReviewView = () => import('../views/LocalReviewView.vue');
const CreatorAdmissionView = () => import('../views/CreatorAdmissionView.vue');
const CostuanWorkspace = () => import('../views/CostuanWorkspace.vue');

function shouldPreserveModalScroll(to: RouteLocationNormalized, from: RouteLocationNormalized) {
  const appStore = useAppStore(pinia);
  const backgroundPath = appStore.imageModalBackgroundPath;

  if (!backgroundPath) {
    return false;
  }

  const isOpeningModal = to.name === 'image' && from.fullPath === backgroundPath;
  const isClosingModal = from.name === 'image' && to.fullPath === backgroundPath;
  const isNavigatingWithinModal = to.name === 'image' && from.name === 'image';

  return isOpeningModal || isClosingModal || isNavigatingWithinModal;
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
    },
    {
      path: '/post/:id',
      alias: '/image/:id',
      name: 'image',
      component: PostView,
      props: true
    },
    {
      path: '/library',
      name: 'library',
      component: LibraryView
    },
    {
      path: '/explore',
      name: 'explore',
      component: ExploreView,
      meta: {
        shell: 'explore'
      }
    },
    {
      path: '/reels',
      name: 'reels',
      component: ReelsView,
      meta: {
        shell: 'reels'
      }
    },
    {
      path: '/likes/posts',
      name: 'likes',
      component: LikesView,
      meta: {
        requiresSavedItems: true
      }
    },
    {
      path: '/collections',
      name: 'collections',
      component: CollectionsView,
      meta: {
        requiresSavedItems: true
      }
    },
    {
      path: '/collections/:slug',
      name: 'collection',
      component: CollectionView,
      props: true,
      meta: {
        requiresSavedItems: true
      }
    },
    {
      path: '/trash',
      name: 'trash',
      component: TrashView,
      meta: {
        requiredCapability: 'canDeleteMedia'
      }
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView,
      meta: {
        requiredCapability: 'canAccessSettings'
      }
    },
    {
      path: '/archive-catalog',
      name: 'archive-catalog',
      component: ArchiveCatalogView,
      meta: {
        requiredCapability: 'canAccessSettings'
      }
    },
    {
      path: '/creator-admission',
      name: 'creator-admission',
      component: CreatorAdmissionView,
      redirect: admissionDefaultDestination,
      meta: { requiredCapability: 'canAccessSettings', admission: true },
      children: [
        { path: 'local', name: 'local-admission-workspace', component: LocalAdmissionWorkspace },
        { path: 'local/:creatorId', name: 'local-admission', component: LocalAdmissionView },
        { path: 'costuan', name: 'costuan-admission', component: CostuanWorkspace },
        { path: 'review', name: 'local-review', component: LocalReviewView }
      ]
    },
    {
      path: '/local-admission',
      meta: { requiredCapability: 'canAccessSettings' },
      redirect: to => ({ name: 'local-admission-workspace', query: to.query, hash: to.hash })
    },
    {
      path: '/local-admission/:creatorId',
      meta: { requiredCapability: 'canAccessSettings' },
      redirect: to => ({ name: 'local-admission', params: to.params, query: to.query, hash: to.hash })
    },
    {
      path: '/local-review',
      meta: { requiredCapability: 'canAccessSettings' },
      redirect: to => ({ name: 'local-review', query: to.query, hash: to.hash })
    },
    {
      path: '/moments/:id',
      name: 'moment',
      component: MomentView,
      props: true
    },
    {
      path: '/places',
      name: 'places',
      component: PlacesView
    },
    {
      path: '/places/:slug',
      name: 'place',
      component: PlaceView,
      props: true
    },
    {
      path: '/library/:creatorId/works/:postId',
      name: 'canonical-work-gallery',
      component: WorkGalleryView,
      props: true
    },
    {
      path: '/library/:creatorId',
      name: 'canonical-creator',
      component: CanonicalCreatorView,
      props: true
    },
    {
      path: '/creators/:creatorId/works/:postId',
      redirect: to => ({ name: 'canonical-work-gallery', params: to.params, query: to.query })
    },
    {
      path: '/creators/:creatorId',
      redirect: to => ({ name: 'canonical-creator', params: to.params, query: to.query })
    },
    {
      path: '/f/:slug/works/:postId',
      name: 'work-gallery',
      component: WorkGalleryView,
      props: true
    },
    {
      path: '/f/:slug',
      alias: '/folders/:slug',
      name: 'folder',
      component: FolderView,
      props: true
    },
    {
      path: '/share/:slug',
      name: 'shared-folder',
      component: SharedFolderView,
      props: true,
      meta: {
        publicShare: true
      }
    },
    {
      path: '/share/:slug/posts/:id',
      name: 'shared-post',
      component: SharedPostView,
      props: true,
      meta: {
        publicShare: true
      }
    },
    {
      path: '/share/:slug/images/:id',
      name: 'shared-image',
      component: SharedPostView,
      props: true,
      meta: {
        publicShare: true
      }
    }
  ],
  scrollBehavior(to, from, savedPosition) {
    if (to.name === 'library' && from.name === 'library') {
      // The library owns filter/page navigation intent and its keyed reading
      // positions, including Back/Forward between filter combinations.
      return false;
    }
    if (to.path === '/archive-catalog' && from.path === to.path) {
      // Changing the selected management panel/tab must not move its list.
      return false;
    }
    if (to.name === 'canonical-work-gallery' && from.name === to.name
      && to.params.creatorId === from.params.creatorId && to.params.postId === from.params.postId) {
      // The same grid stays mounted while its query-driven viewer opens/switches/closes.
      return false;
    }
    if (to.name === 'canonical-creator' && from.name === to.name && to.params.creatorId === from.params.creatorId) {
      // Infinite loading records its range in the URL without jumping to the top.
      return false;
    }
    // Work modals keep the gallery mounted. Its exact locked position wins over
    // an older history position (e.g. after Back, re-opening and closing again).
    if ((to.query.context === 'work' || from.query.context === 'work') && shouldPreserveModalScroll(to, from)) {
      return false;
    }

    if (savedPosition) {
      return savedPosition;
    }

    if (shouldPreserveModalScroll(to, from)) {
      return false;
    }

    return { top: 0 };
  }
});

export function getRouteRequiredCapability(route: Pick<RouteLocationNormalized, 'meta'>): RouteCapability | null {
  const capability = route.meta.requiredCapability;
  return typeof capability === 'string' ? (capability as RouteCapability) : null;
}

export function routeRequiresSavedItems(route: Pick<RouteLocationNormalized, 'meta'>): boolean {
  return route.meta.requiresSavedItems === true;
}

export function routeAllowsPublicShareAccess(route: Pick<RouteLocationNormalized, 'meta'>): boolean {
  return route.meta.publicShare === true;
}

export function canAccessRoute(route: Pick<RouteLocationNormalized, 'meta'>): boolean {
  if (routeAllowsPublicShareAccess(route)) {
    return true;
  }

  const authStore = useAuthStore(pinia);
  const requiredCapability = getRouteRequiredCapability(route);

  if (requiredCapability) {
    return authStore.capabilities[requiredCapability] === true;
  }

  if (routeRequiresSavedItems(route)) {
    return authStore.canUseSavedItems;
  }

  return true;
}

router.beforeEach((to) => {
  if (to.name === 'archive-catalog') {
    const destination = legacyCatalogDestination(to);
    if (destination) return destination;
  }
  const authStore = useAuthStore(pinia);
  if (!authStore.ready) {
    return true;
  }

  if (isGalleryReadingRoute(to.name)) {
    const query = sanitizedGalleryQuery(to.query, authStore.isAdmin);
    if (JSON.stringify(query) !== JSON.stringify(to.query)) return { path: to.path, query, hash: to.hash, replace: true };
  }

  return canAccessRoute(to) ? true : { name: 'home' };
});

// Register before app.use(router) starts the initial navigation, including deep links.
export const routeLoadRecovery = installRouteLoadRecovery(router);
