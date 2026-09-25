import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  LOCAL_INGEST_ALLOWLIST_SETTING_KEY,
  LOCAL_INGEST_SETTINGS_SETTING_KEY
} from '../constants/app-setting-keys.js';
import { appConfig } from '../config/env.js';
import { appSettingsRepository } from '../db/repositories.js';
import {
  assertLocalIngestRootPolicy,
  assertLocalIngestRootPolicySync,
  normalizeAbsoluteLocalIngestPath
} from '../utils/local-ingest-paths.js';
import { trustedSevenZip } from '../utils/trusted-seven-zip.js';
import { RequestInputError } from '../utils/request-input-error.js';
import { LocalIngestPasswordStore, LOCAL_INGEST_PASSWORD_SETTING_KEY } from './local-ingest-password-store.js';

const localIngestSettingsSchema = z.object({
  libraryRoot: z.string().trim().min(1),
  inboxRoot: z.string().trim().min(1),
  processingRoot: z.string().trim().min(1),
  sevenZipPath: z.string().trim().max(500),
  fileStableSeconds: z.number().int().min(1).max(3600),
  recycleAfterIngest: z.boolean(),
  maxExtractionDepth: z.literal(2)
});

const allowlistSchema = z.array(z.string().trim().min(1).max(255)).max(1000);

export type LocalIngestSettings = z.infer<typeof localIngestSettingsSchema>;

export type LocalIngestSettingsView = LocalIngestSettings & {
  allowlist: string[];
  archivePasswordConfigured: boolean;
  archivePasswordSource?: 'environment' | 'local' | 'none';
  archivePasswordOverride: 'inherit' | 'local' | 'cleared';
};

export type LocalIngestPathCheck = {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  freeBytes: number | null;
  volume: string;
  error: string | null;
};

export type LocalIngestSettingsValidation = {
  valid: boolean;
  passwordConfigured: boolean;
  sevenZip: {
    valid: boolean;
    version: string | null;
    error: string | null;
  };
  paths: Record<'libraryRoot' | 'inboxRoot' | 'processingRoot', LocalIngestPathCheck>;
  sameVolume: boolean;
  errors: string[];
};

export type LocalIngestSettingsRepository = Pick<typeof appSettingsRepository, 'get' | 'setMany'>;

function deriveSiblingRoot(name: string, galleryRoot = appConfig.galleryRoot): string {
  const parsed = path.parse(galleryRoot);
  if (parsed.root && galleryRoot !== parsed.root) {
    return path.join(path.dirname(galleryRoot), name);
  }
  return path.join(parsed.root || galleryRoot, name);
}

export function defaultLocalIngestSettings(galleryRoot = appConfig.galleryRoot): LocalIngestSettings {
  return {
    libraryRoot: galleryRoot,
    inboxRoot: deriveSiblingRoot('cos待入库', galleryRoot),
    processingRoot: deriveSiblingRoot('cos处理中', galleryRoot),
    sevenZipPath: trustedSevenZip.executable,
    fileStableSeconds: 5,
    recycleAfterIngest: true,
    maxExtractionDepth: 2 as const
  };
}

function normalizeSettings(settings: LocalIngestSettings, expectedGalleryRoot = appConfig.galleryRoot): LocalIngestSettings {
  if (settings.sevenZipPath !== trustedSevenZip.executable) {
    throw new RequestInputError('7-Zip路径由LOCAL_INGEST_SEVEN_ZIP_PATH启动配置指定，网页不能修改。', 'SEVEN_ZIP_STARTUP_OWNED');
  }
  const normalized = {
    ...settings,
    libraryRoot: normalizeAbsoluteLocalIngestPath(settings.libraryRoot, 'libraryRoot'),
    inboxRoot: normalizeAbsoluteLocalIngestPath(settings.inboxRoot, 'inboxRoot'),
    processingRoot: normalizeAbsoluteLocalIngestPath(settings.processingRoot, 'processingRoot'),
    sevenZipPath: trustedSevenZip.executable,
    maxExtractionDepth: 2 as const
  };
  assertLocalIngestRootPolicySync(normalized, expectedGalleryRoot);
  return normalized;
}

function parseStoredSettings(raw: string | null, expectedGalleryRoot = appConfig.galleryRoot): LocalIngestSettings {
  if (!raw) return normalizeSettings(defaultLocalIngestSettings(expectedGalleryRoot), expectedGalleryRoot);
  try {
    const stored = localIngestSettingsSchema.parse(JSON.parse(raw));
    // libraryRoot became startup-owned in V1. Preserve the user's other legacy
    // settings while projecting the effective scanner root into the view.
    return normalizeSettings({ ...stored, libraryRoot: expectedGalleryRoot, sevenZipPath: trustedSevenZip.executable }, expectedGalleryRoot);
  } catch {
    return normalizeSettings(defaultLocalIngestSettings(expectedGalleryRoot), expectedGalleryRoot);
  }
}

function parseStoredAllowlist(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return [...new Set(allowlistSchema.parse(JSON.parse(raw)))];
  } catch {
    return [];
  }
}

function parseLegacyQuarantineRoot(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const value = (JSON.parse(raw) as { quarantineRoot?: unknown }).quarantineRoot;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function configuredArchivePassword(): string | null {
  const value = process.env.LOCAL_INGEST_ARCHIVE_PASSWORD;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function validateSevenZip(executablePath: string): Promise<LocalIngestSettingsValidation['sevenZip']> {
  try {
    const result = await trustedSevenZip.run(executablePath, ['i'], 10_000);
    if (result.code !== 0) {
      return { valid: false, version: null, error: '7-Zip returned a non-zero exit code' };
    }
    const version = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^7-Zip\b/i.test(line)) ?? null;
    return { valid: true, version, error: null };
  } catch (error) {
    return { valid: false, version: null, error: error instanceof Error ? error.message : 'Unable to run 7-Zip' };
  }
}

async function inspectPath(directoryPath: string, createIfMissing: boolean): Promise<LocalIngestPathCheck> {
  const volume = path.parse(directoryPath).root.toLocaleLowerCase();
  try {
    if (createIfMissing) {
      await fs.mkdir(directoryPath, { recursive: true });
    }
    await fs.access(directoryPath, 4);
    let writable = false;
    try {
      await fs.access(directoryPath, 2);
      writable = true;
    } catch {
      writable = false;
    }
    let freeBytes: number | null = null;
    try {
      const stats = await fs.statfs(directoryPath);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      freeBytes = null;
    }
    return { path: directoryPath, exists: true, readable: true, writable, freeBytes, volume, error: null };
  } catch (error) {
    return {
      path: directoryPath,
      exists: false,
      readable: false,
      writable: false,
      freeBytes: null,
      volume,
      error: error instanceof Error ? error.message : 'Path validation failed'
    };
  }
}

export class LocalIngestSettingsService {
  constructor(
    private readonly expectedGalleryRoot = appConfig.galleryRoot,
    private readonly repository: LocalIngestSettingsRepository = appSettingsRepository,
    private readonly passwordStore = new LocalIngestPasswordStore(path.join(appConfig.dataRoot, 'private'))
  ) {}

  private passwordState(): { password: string | null; source: 'environment' | 'local' | 'none'; override: 'inherit' | 'local' | 'cleared' } {
    const stored = this.repository.get(LOCAL_INGEST_PASSWORD_SETTING_KEY);
    if (stored !== null) {
      const password = this.passwordStore.decrypt(stored);
      return { password, source: password ? 'local' : 'none', override: password ? 'local' : 'cleared' };
    }
    const password = configuredArchivePassword();
    return { password, source: password ? 'environment' : 'none', override: 'inherit' };
  }

  get(): LocalIngestSettingsView {
    const password = this.passwordState();
    return {
      ...parseStoredSettings(this.repository.get(LOCAL_INGEST_SETTINGS_SETTING_KEY), this.expectedGalleryRoot),
      allowlist: parseStoredAllowlist(this.repository.get(LOCAL_INGEST_ALLOWLIST_SETTING_KEY)),
      archivePasswordConfigured: password.password !== null,
      archivePasswordSource: password.source,
      archivePasswordOverride: password.override
    };
  }

  getArchivePassword(): string {
    const { password } = this.passwordState();
    if (!password) {
      throw new Error('Archive password is not configured');
    }
    return password;
  }

  save(input: LocalIngestSettings & { allowlist?: string[]; quarantineRoot?: string; archivePassword?: string; clearArchivePassword?: boolean }): LocalIngestSettingsView {
    const settings = normalizeSettings(localIngestSettingsSchema.parse(input), this.expectedGalleryRoot);
    const allowlist = [...new Set(allowlistSchema.parse(input.allowlist ?? parseStoredAllowlist(this.repository.get(LOCAL_INGEST_ALLOWLIST_SETTING_KEY))))];
    const legacyQuarantineRoot = input.quarantineRoot
      ?? parseLegacyQuarantineRoot(this.repository.get(LOCAL_INGEST_SETTINGS_SETTING_KEY));
    const persistedSettings = legacyQuarantineRoot
      ? { ...settings, quarantineRoot: legacyQuarantineRoot }
      : settings;
    const password = input.archivePassword;
    if ((password !== undefined && (typeof password !== 'string' || password.length > 1024 || /[\r\n\0]/.test(password)))
      || (input.clearArchivePassword !== undefined && typeof input.clearArchivePassword !== 'boolean')
      || (input.clearArchivePassword && password)) throw new Error('Invalid archive password settings');
    const secretChanges = input.clearArchivePassword
      ? [{ key: LOCAL_INGEST_PASSWORD_SETTING_KEY, value: JSON.stringify({ version: 1, disabled: true }) }]
      : password ? [{ key: LOCAL_INGEST_PASSWORD_SETTING_KEY, value: this.passwordStore.encrypt(password) }] : [];
    if (secretChanges.length === 0) this.passwordState();
    this.repository.setMany([
      // V1 neither exposes nor validates quarantineRoot, but retaining a legacy
      // value avoids silently rewriting the user's stored configuration.
      { key: LOCAL_INGEST_SETTINGS_SETTING_KEY, value: JSON.stringify(persistedSettings) },
      { key: LOCAL_INGEST_ALLOWLIST_SETTING_KEY, value: JSON.stringify(allowlist) },
      ...secretChanges
    ]);
    return this.get();
  }

  saveAllowlist(input: string[]): LocalIngestSettingsView {
    const allowlist = [...new Set(allowlistSchema.parse(input))];
    // Validate the effective view before committing anything; this endpoint
    // deliberately cannot overwrite paths, tools, password, or other settings.
    const current = this.get();
    this.repository.setMany([{ key: LOCAL_INGEST_ALLOWLIST_SETTING_KEY, value: JSON.stringify(allowlist) }]);
    return { ...current, allowlist };
  }

  async validate(input?: LocalIngestSettings): Promise<LocalIngestSettingsValidation> {
    const settings = normalizeSettings(localIngestSettingsSchema.parse(input ?? this.get()), this.expectedGalleryRoot);
    const rootPolicyErrors: string[] = [];
    try {
      await assertLocalIngestRootPolicy(settings, this.expectedGalleryRoot);
    } catch (error) {
      rootPolicyErrors.push(error instanceof Error ? error.message : 'Configured roots violate the local ingest path policy');
    }
    const [libraryRoot, inboxRoot, processingRoot, sevenZip] = await Promise.all([
      inspectPath(settings.libraryRoot, false),
      inspectPath(settings.inboxRoot, false),
      inspectPath(settings.processingRoot, true),
      validateSevenZip(settings.sevenZipPath)
    ]);
    const paths = { libraryRoot, inboxRoot, processingRoot };
    const volumes = new Set(Object.values(paths).map((entry) => entry.volume));
    const sameVolume = volumes.size === 1 && !volumes.has('');
    const errors: string[] = [...rootPolicyErrors];
    for (const [name, entry] of Object.entries(paths)) {
      if (!entry.exists || !entry.readable) errors.push(`${name} is not readable`);
      if (!entry.writable) errors.push(`${name} is not writable`);
    }
    if (!sameVolume) errors.push('Configured roots are not on the same volume');
    if (!sevenZip.valid) errors.push('7-Zip validation failed');
    const passwordConfigured = this.passwordState().password !== null;
    if (!passwordConfigured) errors.push('Archive password secret is not configured');
    return {
      valid: errors.length === 0,
      passwordConfigured,
      sevenZip,
      paths,
      sameVolume,
      errors
    };
  }
}

export const localIngestSettingsService = new LocalIngestSettingsService();
