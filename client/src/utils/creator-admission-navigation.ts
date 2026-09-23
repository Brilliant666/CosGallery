import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router';

export const costuanStages = ['source', 'staging', 'ingest'] as const;
export type CostuanStage = typeof costuanStages[number];
export function isCostuanStage(value: unknown): value is CostuanStage {
  return typeof value === 'string' && costuanStages.some(stage => stage === value);
}

/** Navigation only: preserve existing business parameters and never perform an action. */
export function legacyCatalogDestination(route: Pick<RouteLocationNormalized, 'query' | 'hash'>): RouteLocationRaw | null {
  return isCostuanStage(route.query.workspace)
    ? { name: 'costuan-admission', query: route.query, hash: route.hash, replace: true }
    : null;
}

export function admissionDefaultDestination(route: Pick<RouteLocationNormalized, 'query' | 'hash'>): RouteLocationRaw {
  const context = { query: route.query, hash: route.hash };
  if (route.query.kind === 'stage3' && route.query.jobId || route.query.kind === 'admission' && route.query.planId) {
    return { name: 'local-review', ...context };
  }
  if (isCostuanStage(route.query.workspace)) return { name: 'costuan-admission', ...context };
  if (typeof route.query.creatorId === 'string' && /^[1-9]\d*$/.test(route.query.creatorId) && !route.query.collection) {
    return { name: 'local-admission', params: { creatorId: route.query.creatorId }, ...context };
  }
  return { name: 'local-admission-workspace', ...context };
}

export function admissionModule(route: Pick<RouteLocationNormalized, 'name' | 'query'>): 'local' | 'costuan' {
  return route.name === 'costuan-admission' || (route.name === 'local-review' && route.query.kind === 'stage3') ? 'costuan' : 'local';
}
