import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AppConfigModule = typeof import('../src/config/env.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type ScannerServiceModule = typeof import('../src/services/scanner-service.js');
type DatabaseModule = typeof import('../src/db/database.js');

describe.sequential('carousel deterministic scanner ordering (Issue 12)', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let scannerService: ScannerServiceModule['scannerService'];
  let postRepository: RepositoriesModule['postRepository'];
  let databaseManager: DatabaseModule['databaseManager'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldergram-sort-test-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    databaseManager?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    vi.resetModules();

    ({ appConfig } = await import('../src/config/env.js'));
    ({ scannerService } = await import('../src/services/scanner-service.js'));
    ({ postRepository } = await import('../src/db/repositories.js'));
    ({ databaseManager } = await import('../src/db/database.js'));

    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });

  afterAll(async () => {
    databaseManager?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('consistently indexes carousel slides in natural numeric order regardless of discovery order', async () => {
    const carouselDir = path.join(appConfig.galleryRoot, 'album', 'carousels', 'post1');
    await fs.mkdir(carouselDir, { recursive: true });

    // Write 1x1 GIF files with names file2.jpg, file10.jpg, file1.jpg
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await fs.writeFile(path.join(carouselDir, 'file10.jpg'), gif);
    await fs.writeFile(path.join(carouselDir, 'file2.jpg'), gif);
    await fs.writeFile(path.join(carouselDir, 'file1.jpg'), gif);

    await scannerService.scanAll('manual');

    const posts = postRepository.listFeed(1, 10, 'newest');
    expect(posts).toHaveLength(1);
    expect(posts[0].mediaItems).toHaveLength(3);
    expect(posts[0].mediaItems![0].filename).toBe('file1.jpg');
    expect(posts[0].mediaItems![1].filename).toBe('file2.jpg');
    expect(posts[0].mediaItems![2].filename).toBe('file10.jpg');
  });

  it('deterministically breaks ties for numeric and accent variants with shuffled discovery', async () => {
    const carouselDir = path.join(appConfig.galleryRoot, 'album', 'carousels', 'post2');
    await fs.mkdir(carouselDir, { recursive: true });

    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    // Shuffled creation
    await fs.writeFile(path.join(carouselDir, 'item-10-b.jpg'), gif);
    await fs.writeFile(path.join(carouselDir, 'item-2-b.jpg'), gif);
    await fs.writeFile(path.join(carouselDir, 'item-1-á.jpg'), gif);
    await fs.writeFile(path.join(carouselDir, 'item-1-a.jpg'), gif);

    await scannerService.scanAll('manual');

    const posts = postRepository.listFeed(1, 10, 'newest');
    const post = posts.find((p) => p.sourcePath?.includes('post2'));
    expect(post).toBeDefined();
    expect(post!.mediaItems).toHaveLength(4);
    // 'item-1-a.jpg' before 'item-1-á.jpg' (base before accent), before 'item-2-b.jpg' and 'item-10-b.jpg'
    expect(post!.mediaItems![0].filename).toBe('item-1-a.jpg');
    expect(post!.mediaItems![1].filename).toBe('item-1-á.jpg');
    expect(post!.mediaItems![2].filename).toBe('item-2-b.jpg');
    expect(post!.mediaItems![3].filename).toBe('item-10-b.jpg');
  });
});
