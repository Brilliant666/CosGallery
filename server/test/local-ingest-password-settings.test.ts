import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalIngestPasswordStore, LOCAL_INGEST_PASSWORD_SETTING_KEY } from '../src/services/local-ingest-password-store.js';
import { LocalIngestSettingsService, defaultLocalIngestSettings } from '../src/services/local-ingest-settings-service.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosgallery-password-settings-'));
  roots.push(root);
  const gallery = path.join(root, 'gallery');
  fs.mkdirSync(gallery);
  const privateRoot = path.join(root, 'private');
  const values = new Map<string, string>();
  const repository = {
    get: (key: string) => values.get(key) ?? null,
    setMany: vi.fn((entries: { key: string; value: string }[]) => {
      for (const entry of entries) values.set(entry.key, entry.value);
    })
  };
  const restart = () => new LocalIngestSettingsService(gallery, repository, new LocalIngestPasswordStore(privateRoot));
  return { root, privateRoot, values, repository, restart, service: restart(), settings: defaultLocalIngestSettings(gallery) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('saved local ingest password and scoped allowlist settings', () => {
  it('preserves environment fallback until explicit local replacement; restarts decrypt ciphertext without exposing secrets', () => {
    vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', 'old-environment-secret');
    const f = fixture();
    expect(f.service.get()).toMatchObject({ archivePasswordConfigured: true, archivePasswordSource: 'environment', archivePasswordOverride: 'inherit' });
    const view = f.service.save({ ...f.settings, allowlist: ['One'], archivePassword: 'new-中文-secret' });
    expect(view).toMatchObject({ archivePasswordConfigured: true, archivePasswordSource: 'local', archivePasswordOverride: 'local' });
    expect(JSON.stringify(view)).not.toContain('new-中文-secret');
    expect(JSON.stringify([...f.values])).not.toContain('new-中文-secret');
    expect(JSON.stringify([...f.values])).not.toContain('old-environment-secret');
    expect(f.restart().getArchivePassword()).toBe('new-中文-secret');
    expect(fs.statSync(path.join(f.privateRoot, 'local-ingest-archive-password.key')).size).toBe(32);
    const stored = f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY);
    f.service.save({ ...f.settings, archivePassword: '' });
    expect(f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY)).toBe(stored);
    f.service.save({ ...f.settings, fileStableSeconds: 42 });
    expect(f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY)).toBe(stored);
  });

  it('explicit clearing suppresses environment fallback across restart and allows a later replacement', () => {
    vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', 'environment-secret');
    const f = fixture();
    f.service.save({ ...f.settings, clearArchivePassword: true });
    expect(f.restart().get()).toMatchObject({ archivePasswordConfigured: false, archivePasswordSource: 'none', archivePasswordOverride: 'cleared' });
    const disabled = f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY);
    f.service.save({ ...f.settings, archivePassword: '' });
    expect(f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY)).toBe(disabled);
    expect(() => f.restart().getArchivePassword()).toThrow('Archive password is not configured');
    f.service.save({ ...f.settings, archivePassword: 'replacement' });
    expect(f.restart().getArchivePassword()).toBe('replacement');
  });

  it('validates all settings before publishing any change or creating a secret key', () => {
    const f = fixture();
    expect(() => f.service.save({ ...f.settings, fileStableSeconds: 0, archivePassword: 'private-password' })).toThrow();
    expect(() => f.service.save({ ...f.settings, allowlist: [''], archivePassword: 'private-password' })).toThrow();
    expect(() => f.service.save({ ...f.settings, archivePassword: 'private-password', clearArchivePassword: true })).toThrow('Invalid archive password settings');
    expect(() => f.service.save({ ...f.settings, archivePassword: 'private\npassword' })).toThrow('Invalid archive password settings');
    expect(f.repository.setMany).not.toHaveBeenCalled();
    expect(fs.existsSync(f.privateRoot)).toBe(false);
  });

  it.each(['ciphertext', 'missing-key', 'invalid-key'])('fails closed on %s and cannot partly save ordinary settings', (failure) => {
    vi.stubEnv('LOCAL_INGEST_ARCHIVE_PASSWORD', 'must-not-fall-back');
    const f = fixture();
    f.service.save({ ...f.settings, archivePassword: 'private-password' });
    if (failure === 'ciphertext') f.values.set(LOCAL_INGEST_PASSWORD_SETTING_KEY, '{"version":1,"data":"private-password"}');
    else if (failure === 'missing-key') fs.unlinkSync(path.join(f.privateRoot, 'local-ingest-archive-password.key'));
    else fs.writeFileSync(path.join(f.privateRoot, 'local-ingest-archive-password.key'), 'bad-key');
    const before = new Map(f.values);
    expect(() => f.restart().get()).toThrow('Unable to read or protect the saved archive password');
    expect(() => f.service.save({ ...f.settings, allowlist: ['Other'], fileStableSeconds: 9 })).toThrow('Unable to read or protect the saved archive password');
    expect(f.values).toEqual(before);
  });

  it('rejects a linked private directory and does not write any settings', () => {
    const f = fixture();
    const elsewhere = path.join(f.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, f.privateRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => f.service.save({ ...f.settings, archivePassword: 'private-password' })).toThrow('Unable to read or protect the saved archive password');
    expect(f.repository.setMany).not.toHaveBeenCalled();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('saving only the allowlist preserves paths, options, legacy fields and encrypted password byte-for-byte', () => {
    const f = fixture();
    f.service.save({ ...f.settings, allowlist: ['Old'], quarantineRoot: 'legacy', archivePassword: 'private-password' });
    const settings = f.values.get('local_ingest.settings');
    const encrypted = f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY);
    f.repository.setMany.mockClear();
    expect(f.service.saveAllowlist([' New ', 'New'])).toMatchObject({ allowlist: ['New'], archivePasswordSource: 'local' });
    expect(f.repository.setMany).toHaveBeenCalledExactlyOnceWith([{ key: 'local_ingest.allowlist', value: '["New"]' }]);
    expect(f.values.get('local_ingest.settings')).toBe(settings);
    expect(f.values.get(LOCAL_INGEST_PASSWORD_SETTING_KEY)).toBe(encrypted);
  });
});
