import { computed, onActivated, shallowReactive, watch } from 'vue';
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw, type RouteLocationNormalizedLoaded, type RouteLocationRaw } from 'vue-router';

/** Choose one local scope, without carrying a previous plan/review/job identity. */
export function admissionScopeQuery(query: LocationQuery, scope: { batch?: string; collection?: string } = {}): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query };
  for (const key of ['batch', 'collection', 'session', 'planId', 'itemKey', 'jobId', 'kind', 'creatorId']) delete next[key];
  return { ...next, ...scope };
}

/** KeepAlive views must not consume another module's global query/params. */
export function useAdmissionRoute(name: string, identity: (route: RouteLocationNormalizedLoaded) => string = () => '') {
  const live = useRoute();
  const navigation = useRouter();
  const owner = identity(live);
  const current = computed(() => live.name === name && identity(live) === owner);
  const route = shallowReactive({ params: live.params, query: live.query, hash: live.hash, fullPath: live.fullPath });
  watch(() => [live.params, live.query, live.hash, live.name, live.fullPath], () => {
    if (current.value) Object.assign(route, { params: live.params, query: live.query, hash: live.hash, fullPath: live.fullPath });
  }, { flush: 'sync' });
  // An in-flight preview/session read may complete after a tab switch. Keep its
  // own state, but never redirect the currently visible module on that receipt.
  let pendingLocation: { from: string; to: RouteLocationRaw } | undefined;
  const router = { replace: (to: RouteLocationRaw) => {
    if (current.value) return navigation.replace(to);
    pendingLocation = { from: route.fullPath, to };
    return Promise.resolve();
  } };
  onActivated(async () => {
    const pending = pendingLocation;
    pendingLocation = undefined;
    // Returning to the same tab resumes its completed preview/session read. An
    // explicit link to another saved batch takes precedence over that receipt.
    if (pending && current.value && live.fullPath === pending.from) await navigation.replace(pending.to);
  });
  return { route, current, router };
}
