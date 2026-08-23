import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthServiceModule = typeof import('../src/services/auth-service.js');
type FolderShareServiceModule = typeof import('../src/services/folder-share-service.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type DatabaseModule = typeof import('../src/db/database.js');

interface MockResponse {
  cookie: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function createRequest(headers: Record<string, string | undefined> = {}): express.Request {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    secure: false,
    get(name: string) {
      return normalizedHeaders.get(name.toLowerCase());
    }
  } as unknown as express.Request;
}

function createResponse(): MockResponse {
  return {
    cookie: vi.fn().mockReturnThis(),
    setHeader: vi.fn()
  };
}

function extractCookieHeader(response: MockResponse): string {
  const [name, value] = response.cookie.mock.calls.at(-1) ?? [];
  if (typeof name !== 'string' || typeof value !== 'string') {
    throw new Error('Expected a share session cookie to be set');
  }

  return `${name}=${value}`;
}

describe.sequential('folder share service', () => {
  let tempRoot = '';
  let authService: AuthServiceModule['authService'];
  let folderShareService: FolderShareServiceModule['folderShareService'];
  let folderRepository: RepositoriesModule['folderRepository'];
  let folderShareLinkRepository: RepositoriesModule['folderShareLinkRepository'];
  let maintenanceRepository: RepositoriesModule['maintenanceRepository'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-folder-share-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    try {
      const dbModule: DatabaseModule = await import('../src/db/database.js');
      dbModule.databaseManager.close();
    } catch {
      // Ignore if not loaded
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
    await Promise.all([
      fs.mkdir(path.join(tempRoot, 'db'), { recursive: true }),
      fs.mkdir(path.join(tempRoot, 'gallery'), { recursive: true }),
      fs.mkdir(path.join(tempRoot, 'thumbnails'), { recursive: true }),
      fs.mkdir(path.join(tempRoot, 'previews'), { recursive: true })
    ]);

    vi.resetModules();
    ({ authService } = await import('../src/services/auth-service.js'));
    ({ folderShareService } = await import('../src/services/folder-share-service.js'));
    ({ folderRepository, folderShareLinkRepository, maintenanceRepository } = await import('../src/db/repositories.js'));
    maintenanceRepository.resetLibraryIndex();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    try {
      const dbModule: DatabaseModule = await import('../src/db/database.js');
      dbModule.databaseManager.close();
    } catch {
      // Ignore
    }
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('stores only a token hash and returns the raw token only in the created URL payload', () => {
    folderRepository.upsert({ slug: 'family', name: 'Family', folderPath: 'family' });

    const created = folderShareService.createLink('family', {
      expiresAt: new Date(Date.now() + 60_000)
    });

    expect(created).not.toBeNull();
    expect(created!.rawToken).toHaveLength(43);
    expect(created!.link.tokenPrefix).toBe(created!.rawToken.slice(0, 8));
    expect(Object.keys(created!.link)).not.toContain('token_hash');

    const stored = folderShareLinkRepository.listByFolder(created!.folder.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(created!.rawToken);
    expect(stored[0].token_hash).not.toContain(created!.rawToken);
  });

  it('creates a folder-scoped share session from a valid token', () => {
    authService.setAdminPassword('admin-pass-123');
    const folder = folderRepository.upsert({ slug: 'album', name: 'Album', folderPath: 'album' });
    const otherFolder = folderRepository.upsert({ slug: 'other', name: 'Other', folderPath: 'other' });
    const created = folderShareService.createLink('album', {
      expiresAt: new Date(Date.now() + 60_000)
    })!;
    const grant = folderShareService.verifyLinkToken('album', created.rawToken);
    const response = createResponse();

    expect(grant).toMatchObject({
      folderId: folder.id,
      kind: 'link'
    });

    folderShareService.setShareSession(response as unknown as express.Response, createRequest(), grant!);
    const request = createRequest({
      cookie: extractCookieHeader(response)
    });

    expect(folderShareService.getFolderGrant(request, folder.id)).toMatchObject({
      folderId: folder.id,
      kind: 'link'
    });
    expect(folderShareService.getFolderGrant(request, otherFolder.id)).toBeNull();
  });

  it('rejects expired and revoked link tokens', () => {
    folderRepository.upsert({ slug: 'album', name: 'Album', folderPath: 'album' });
    const expired = folderShareService.createLink('album', {
      expiresAt: new Date(Date.now() - 60_000)
    })!;
    const active = folderShareService.createLink('album', {
      expiresAt: null
    })!;

    expect(folderShareService.verifyLinkToken('album', expired.rawToken)).toBeNull();
    expect(folderShareService.verifyLinkToken('album', active.rawToken)).toMatchObject({
      kind: 'link'
    });

    folderShareService.revokeLink('album', active.link.id);
    expect(folderShareService.verifyLinkToken('album', active.rawToken)).toBeNull();
  });

  it('invalidates password sessions when the folder password changes or is removed', () => {
    authService.setAdminPassword('admin-pass-123');
    const folder = folderRepository.upsert({ slug: 'album', name: 'Album', folderPath: 'album' });

    folderShareService.setPassword('album', 'share-pass-123');
    const grant = folderShareService.verifyPassword('album', 'share-pass-123');
    const response = createResponse();

    expect(grant).toMatchObject({
      folderId: folder.id,
      kind: 'password'
    });

    folderShareService.setShareSession(response as unknown as express.Response, createRequest(), grant!);
    const request = createRequest({
      cookie: extractCookieHeader(response)
    });

    expect(folderShareService.getFolderGrant(request, folder.id)).toMatchObject({
      folderId: folder.id,
      kind: 'password'
    });

    folderShareService.setPassword('album', 'changed-pass-123');
    expect(folderShareService.getFolderGrant(request, folder.id)).toBeNull();
    expect(folderShareService.verifyPassword('album', 'share-pass-123')).toBeNull();
    expect(folderShareService.verifyPassword('album', 'changed-pass-123')).toMatchObject({
      kind: 'password'
    });

    const changedGrant = folderShareService.verifyPassword('album', 'changed-pass-123')!;
    const changedResponse = createResponse();
    folderShareService.setShareSession(changedResponse as unknown as express.Response, createRequest(), changedGrant);
    const changedRequest = createRequest({
      cookie: extractCookieHeader(changedResponse)
    });

    expect(folderShareService.getFolderGrant(changedRequest, folder.id)).toMatchObject({
      kind: 'password'
    });

    folderShareService.removePassword('album');
    expect(folderShareService.getFolderGrant(changedRequest, folder.id)).toBeNull();

    // Recreate password and verify original version-1 session cookie remains rejected
    folderShareService.setPassword('album', 'new-pass-456');
    expect(folderShareService.getFolderGrant(request, folder.id)).toBeNull();
    expect(folderShareService.getFolderGrant(changedRequest, folder.id)).toBeNull();
  });

  it('invalidates active share sessions when a full library reset occurs', () => {
    authService.setAdminPassword('admin-pass-123');
    const folder = folderRepository.upsert({ slug: 'album', name: 'Album', folderPath: 'album' });
    const created = folderShareService.createLink('album', { expiresAt: new Date(Date.now() + 60_000) })!;
    const grant = folderShareService.verifyLinkToken('album', created.rawToken)!;
    const response = createResponse();

    folderShareService.setShareSession(response as unknown as express.Response, createRequest(), grant);
    const request = createRequest({ cookie: extractCookieHeader(response) });

    expect(folderShareService.getFolderGrant(request, folder.id)).toMatchObject({
      folderId: folder.id,
      kind: 'link'
    });

    maintenanceRepository.resetLibraryIndex();

    expect(folderShareService.getFolderGrant(request, folder.id)).toBeNull();
  });
});
