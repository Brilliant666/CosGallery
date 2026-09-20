import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage3-review-cli-'));
  roots.push(root);
  const env = { ...process.env, NODE_ENV: 'test', DATA_ROOT: root,
    DB_DIR: path.join(root, 'db'), GALLERY_ROOT: path.join(root, 'gallery'),
    THUMBNAILS_DIR: path.join(root, 'thumbs'), PREVIEWS_DIR: path.join(root, 'previews') };
  const request = path.join(root, 'request.json');
  await fs.writeFile(request, JSON.stringify({ jobId: 1, removedFiles: [], retainedFiles: [], note: 'synthetic test' }));
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    ['--import', 'tsx', 'src/scripts/local-ingest.ts', ...args],
    { cwd: serverRoot, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { root, env, request, run };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('Stage3 review CLI import and read-only boundary', () => {
  it('shows help without importing configuration or initializing storage', async () => {
    const f = await fixture();
    const result = f.run(['--help'], { NODE_ENV: 'invalid', DB_DIR: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('preview-review');
    expect(result.stdout).toContain('resume-review');
    expect(await fs.readdir(f.root)).toEqual(['request.json']);
  });
  it('rejects missing explicit paths before opening a database', async () => {
    const f = await fixture();
    const result = f.run(['preview-review', f.request], { DB_DIR: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Explicit absolute DB_DIR is required');
    expect(await fs.readdir(f.root)).toEqual(['request.json']);
  });
  it('reads an existing database without migration, configuration writes or directory creation', async () => {
    const f = await fixture();
    await fs.mkdir(f.env.DB_DIR);
    const databasePath = path.join(f.env.DB_DIR, 'gallery.sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec(schemaSql);
    db.close();
    const before = await fs.readFile(databasePath);
    const result = f.run(['preview-review', f.request]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/job.*not found/i);
    expect(result.stdout).not.toMatch(/Applying:|migration|validation stage/);
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect((await fs.readdir(f.root)).sort()).toEqual(['db', 'request.json']);
    expect(await fs.readdir(f.env.DB_DIR)).toEqual(['gallery.sqlite']);
  });
});
