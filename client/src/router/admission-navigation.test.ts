import { beforeEach, describe, expect, it } from 'vitest';
import { router, canAccessRoute } from './index';
import { useAuthStore } from '../stores/auth';
import { pinia } from '../stores/pinia';

describe('creator admission routing compatibility', () => {
  beforeEach(() => {
    const auth = useAuthStore(pinia);
    auth.$patch({ ready: true, capabilities: { ...auth.capabilities, canAccessSettings: true } });
  });

  it.each(['source', 'staging', 'ingest'])('moves old %s stage links without dropping business context', async workspace => {
    await router.push(`/archive-catalog?workspace=${workspace}&creatorId=17&jobId=42&page=3#jobs`);
    expect(router.currentRoute.value.name).toBe('costuan-admission');
    expect(router.currentRoute.value.path).toBe('/creator-admission/costuan');
    expect(router.currentRoute.value.query).toEqual({ workspace, creatorId: '17', jobId: '42', page: '3' });
    expect(router.currentRoute.value.hash).toBe('#jobs');
  });

  it.each(['roster', 'resources'])('keeps %s inside the catalog', async workspace => {
    await router.push(`/archive-catalog?workspace=${workspace}&creatorId=17`);
    expect(router.currentRoute.value.name).toBe('archive-catalog');
    expect(router.currentRoute.value.query.creatorId).toBe('17');
  });

  it.each([
    ['/local-admission?collection=existing#results', 'local-admission-workspace', { collection: 'existing' }, '#results'],
    ['/local-admission/17?batch=original&sourceEvidenceId=9', 'local-admission', { batch: 'original', sourceEvidenceId: '9' }, ''],
    ['/local-review?kind=stage3&jobId=42&creatorId=17#files', 'local-review', { kind: 'stage3', jobId: '42', creatorId: '17' }, '#files'],
    ['/local-review?kind=admission&planId=original&itemKey=one&creatorId=17', 'local-review', { kind: 'admission', planId: 'original', itemKey: 'one', creatorId: '17' }, '']
  ])('preserves old %s context', async (url, name, query, hash) => {
    await router.push(url as string);
    expect(router.currentRoute.value.name).toBe(name);
    expect(router.currentRoute.value.query).toEqual(query);
    expect(router.currentRoute.value.hash).toBe(hash);
    expect(router.currentRoute.value.meta.admission).toBe(true);
  });

  it('defaults to local but does not override explicit context', async () => {
    await router.push('/creator-admission');
    expect(router.currentRoute.value.name).toBe('local-admission-workspace');
    await router.push('/creator-admission?creatorId=17&sourceEvidenceId=9');
    expect(router.currentRoute.value.name).toBe('local-admission');
    expect(router.currentRoute.value.params.creatorId).toBe('17');
    await router.push('/creator-admission?kind=stage3&jobId=42');
    expect(router.currentRoute.value.name).toBe('local-review');
  });

  it('retains admin protection for children and all compatibility links', async () => {
    const auth = useAuthStore(pinia);
    auth.$patch({ capabilities: { ...auth.capabilities, canAccessSettings: false } });
    for (const url of ['/archive-catalog', '/local-admission', '/local-admission/17', '/local-review', '/creator-admission', '/creator-admission/local', '/creator-admission/local/17', '/creator-admission/review', '/creator-admission/costuan']) {
      expect(canAccessRoute(router.resolve(url)), url).toBe(false);
      await router.push(url);
      expect(router.currentRoute.value.name, url).toBe('home');
    }
    await router.push('/archive-catalog?workspace=ingest&jobId=42');
    expect(router.currentRoute.value.name).toBe('home');
  });
});
