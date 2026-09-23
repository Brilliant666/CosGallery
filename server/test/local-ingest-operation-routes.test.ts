import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestTestApp as requestApp } from './http-test-utils.js';

describe.sequential('LocalIngest operation API exclusivity', () => {
  let tempRoot = '';
  let app: express.Application;
  let release!: () => void;
  let active: Promise<void>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-local-operation-routes-'));
    const dataRoot = path.join(tempRoot, 'data');
    const galleryRoot = path.join(tempRoot, 'gallery');
    await Promise.all([
      fs.mkdir(dataRoot, { recursive: true }),
      fs.mkdir(galleryRoot, { recursive: true })
    ]);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', dataRoot);
    vi.stubEnv('GALLERY_ROOT', galleryRoot);
    vi.stubEnv('DB_DIR', path.join(dataRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(dataRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(dataRoot, 'previews'));
    vi.resetModules();

    const { createApp } = await import('../src/app.js');
    const { databaseManager } = await import('../src/db/database.js');
    const { localIngestOperationCoordinator } = await import('../src/services/local-ingest-operation-coordinator.js');
    const database = databaseManager.connection;
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO archive_catalog_creators (
         id, canonical_name, normalized_name, preference, effective_rating,
         seed_source, seed_source_creator_id, created_at, updated_at
       ) VALUES (1, 'Creator Alpha', 'creatoralpha', 'liked', 'R15', 'test', 'creator-1', ?, ?)`
    ).run(now, now);
    database.prepare(
      `INSERT INTO local_ingest_jobs (
         id, creator_id, source_archive_path, source_archive_name, source_archive_size,
         source_archive_mtime, source_archive_sha256, status, phase,
         validation_status, cleanup_status, created_at, updated_at
       ) VALUES (1, 1, 'C:\\temp\\007.7z', '007.7z', 1, 1, 'hash',
                 'ingested', 'cleanup', 'passed', 'failed', ?, ?)`
    ).run(now, now);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    active = localIngestOperationCoordinator.run(
      { state: 'scanning', kind: 'scan', message: 'active scan' },
      () => gate
    );
    app = createApp();
  });

  afterEach(async () => {
    release();
    await active;
    const { databaseManager } = await import('../src/db/database.js');
    databaseManager.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('returns a small no-store operation snapshot', async () => {
    const response = await requestApp(app, 'GET', '/api/admin/local-ingest/operation');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.body).toMatchObject({ state: 'scanning', kind: 'scan', message: 'active scan' });
    expect(response.body).not.toHaveProperty('password');
  });

  it('returns 409 immediately from every protected route while another operation is active', async () => {
    const mutationHeaders = { 'x-foldergram-intent': '1' };
    const settings = {
      libraryRoot: path.join(tempRoot, 'gallery'),
      inboxRoot: path.join(tempRoot, 'inbox'),
      processingRoot: path.join(tempRoot, 'processing'),
      sevenZipPath: '7z',
      fileStableSeconds: 1,
      recycleAfterIngest: true,
      maxExtractionDepth: 2,
      allowlist: ['Creator Alpha']
    };
    const requests: Array<Promise<Awaited<ReturnType<typeof requestApp>>>> = [
      requestApp(app, 'GET', '/api/admin/local-ingest/inbox-creators'),
      requestApp(app, 'PUT', '/api/admin/local-ingest/settings', mutationHeaders, settings),
      requestApp(app, 'PUT', '/api/admin/local-ingest/allowlist', mutationHeaders, { allowlist: ['Creator Alpha'] }),
      requestApp(app, 'POST', '/api/admin/local-ingest/settings/validate', mutationHeaders, {}),
      requestApp(app, 'POST', '/api/admin/local-ingest/recycle-bin-smoke-test', mutationHeaders, {}),
      requestApp(app, 'POST', '/api/admin/local-ingest/scan', mutationHeaders, {}),
      requestApp(app, 'POST', '/api/admin/local-ingest/run', mutationHeaders, {}),
      requestApp(app, 'POST', '/api/admin/local-ingest/jobs/1/run', mutationHeaders, {}),
      requestApp(app, 'POST', '/api/admin/local-ingest/jobs/1/retry-cleanup', mutationHeaders, {})
    ];
    const responses = await Promise.all(requests);
    expect(responses).toHaveLength(9);
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'LOCAL_INGEST_OPERATION_ACTIVE',
        operation: { state: 'scanning', kind: 'scan' }
      });
    }
  });

  it('returns summary-only payloads after scan and batch operations complete', async () => {
    release();
    await active;
    const { localIngestService } = await import('../src/services/local-ingest-service.js');
    const existingJob = localIngestService.getJob(1);
    const scan = vi.spyOn(localIngestService, 'scanInboxWithStableRecheck').mockResolvedValue({
      allowlist: ['Creator Alpha'],
      discoveredCreators: 1,
      discoveredArchives: 558,
      createdJobs: 100,
      existingJobs: 458,
      waitingStable: 0,
      awaitingReview: 0,
      reconciledDownloadedTasks: 100,
      ignoredFiles: 2,
      jobs: Array.from({ length: 558 }, () => existingJob)
    });
    const run = vi.spyOn(localIngestService, 'runBatch').mockResolvedValue({
      total: 1,
      examined: 1,
      settled: 1,
      ingested: 1,
      failed: 0,
      awaitingReview: 0,
      reconciling: 0,
      claimUnavailable: 0,
      unchanged: 0,
      items: [{ job: existingJob, outcome: 'ingested' }]
    });
    const headers = { 'x-foldergram-intent': '1' };

    const scanResponse = await requestApp(app, 'POST', '/api/admin/local-ingest/scan', headers, {});
    expect(scanResponse.status).toBe(200);
    expect(scanResponse.body).toMatchObject({ discoveredArchives: 558, createdJobs: 100 });
    expect(scanResponse.body).not.toHaveProperty('jobs');
    expect(scanResponse.body).not.toHaveProperty('allowlist');

    const runResponse = await requestApp(app, 'POST', '/api/admin/local-ingest/run', headers, {});
    expect(runResponse.status).toBe(200);
    expect(runResponse.body).toEqual({
      total: 1,
      examined: 1,
      settled: 1,
      ingested: 1,
      failed: 0,
      awaitingReview: 0,
      reconciling: 0,
      claimUnavailable: 0,
      unchanged: 0
    });
    const creatorRunResponse = await requestApp(
      app,
      'POST',
      '/api/admin/local-ingest/run',
      headers,
      { creatorIds: [1, 1, 1] }
    );
    expect(creatorRunResponse.status).toBe(200);
    expect(run).toHaveBeenLastCalledWith(
      { jobIds: undefined, creatorIds: [1] },
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
    scan.mockRestore();
    run.mockRestore();
  });

  it('saves an encrypted password and a scoped allowlist without returning secret material or overwriting settings', async () => {
    release();
    await active;
    const { databaseManager } = await import('../src/db/database.js');
    const { localIngestSettingsService } = await import('../src/services/local-ingest-settings-service.js');
    const headers = { 'x-foldergram-intent': '1' };
    const settings = localIngestSettingsService.get();
    const secret = 'route-private-secret';
    const saved = await requestApp(app, 'PUT', '/api/admin/local-ingest/settings', headers, { ...settings, archivePassword: secret });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ archivePasswordConfigured: true, archivePasswordSource: 'local' });
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const before = databaseManager.connection.prepare("SELECT key,value FROM app_settings WHERE key IN ('local_ingest.settings','local_ingest.archive_password') ORDER BY key").all();
    expect(JSON.stringify(before)).not.toContain(secret);
    const allowlist = await requestApp(app, 'PUT', '/api/admin/local-ingest/allowlist', headers, { allowlist: ['Creator Alpha'] });
    expect(allowlist.status).toBe(200);
    expect(allowlist.body).toMatchObject({ allowlist: ['Creator Alpha'], archivePasswordSource: 'local' });
    expect(JSON.stringify(allowlist.body)).not.toContain(secret);
    expect(databaseManager.connection.prepare("SELECT key,value FROM app_settings WHERE key IN ('local_ingest.settings','local_ingest.archive_password') ORDER BY key").all()).toEqual(before);
    const read = await requestApp(app, 'GET', '/api/admin/local-ingest/settings');
    expect(JSON.stringify(read.body)).not.toContain(secret);
    const malformed = await requestApp(app, 'PUT', '/api/admin/local-ingest/settings', headers, { ...settings, archivePassword: `${secret}\n` });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain(secret);
    const invalidScope = await requestApp(app, 'PUT', '/api/admin/local-ingest/allowlist', headers, { allowlist: [], inboxRoot: 'other' });
    expect(invalidScope.status).toBe(400);
    const noIntent = await requestApp(app, 'PUT', '/api/admin/local-ingest/allowlist', {}, { allowlist: [] });
    expect(noIntent.status).toBe(403);
    expect(localIngestSettingsService.get().allowlist).toEqual(['Creator Alpha']);
  });

  it('reads the effective archive password only for the explicit management editor, including unset and disabled states', async () => {
    const { localIngestSettingsService } = await import('../src/services/local-ingest-settings-service.js');
    vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', 'synthetic-editor-password');
    const read = () => requestApp(app, 'GET', '/api/admin/local-ingest/archive-password');
    const environment = await read();
    expect(environment.status).toBe(200);
    expect(environment.headers.get('cache-control')).toContain('no-store');
    expect(environment.body).toEqual({ archivePassword: 'synthetic-editor-password' });
    // A read is available during a scan, but does not acquire/change its operation.
    expect((await requestApp(app, 'GET', '/api/admin/local-ingest/operation')).body.state).toBe('scanning');
    localIngestSettingsService.save({ ...localIngestSettingsService.get(), archivePassword: 'updated-archive-password' });
    expect((await read()).body).toEqual({ archivePassword: 'updated-archive-password' });
    localIngestSettingsService.save({ ...localIngestSettingsService.get(), clearArchivePassword: true });
    expect((await read()).body).toEqual({ archivePassword: '' });

    const { authService } = await import('../src/services/auth-service.js');
    authService.setAdminPassword('test-admin-password');
    authService.setViewerAccess('password', 'test-viewer-password');
    expect((await read()).status).toBe(401);
    const login = await requestApp(app, 'POST', '/api/auth/login', { 'x-foldergram-intent': '1' }, { password: 'test-viewer-password' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await requestApp(app, 'GET', '/api/admin/local-ingest/archive-password', { cookie })).status).toBe(403);
  });

  it('rejects empty, invalid, or mixed explicit scopes without falling back to a global batch', async () => {
    release();
    await active;
    const { localIngestService } = await import('../src/services/local-ingest-service.js');
    const run = vi.spyOn(localIngestService, 'runBatch');
    const headers = { 'x-foldergram-intent': '1' };
    const invalidBodies = [
      { jobIds: [] },
      { creatorIds: [] },
      { jobIds: [0] },
      { creatorIds: [-1] },
      { jobIds: [1], creatorIds: [1] }
    ];

    for (const body of invalidBodies) {
      const response = await requestApp(app, 'POST', '/api/admin/local-ingest/run', headers, body);
      expect(response.status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
    run.mockRestore();
  });
});
