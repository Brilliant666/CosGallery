import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { z } from 'zod';

import {
  LOCAL_INGEST_ALLOWLIST_SETTING_KEY,
  LOCAL_INGEST_SETTINGS_SETTING_KEY
} from '../constants/app-setting-keys.js';
import { appConfig } from '../config/env.js';
import { appSettingsRepository } from '../db/repositories.js';

const localIngestSettingsSchema = z.object({
  libraryRoot: z.string().trim().min(1),
  inboxRoot: z.string().trim().min(1),
  processingRoot: z.string().trim().min(1),
  quarantineRoot: z.string().trim().min(1),
  sevenZipPath: z.string().trim().min(1),
  fileStableSeconds: z.number().int().min(1).max(3600),
  recycleAfterIngest: z.boolean(),
  maxExtractionDepth: z.literal(2)
});

const allowlistSchema = z.array(z.string().trim().min(1).max(255)).max(1000);

export type LocalIngestSettings = z.infer<typeof localIngestSettingsSchema>;

export type LocalIngestSettingsView = LocalIngestSettings & {
  allowlist: string[];
  archivePasswordConfigured: boolean;
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
  paths: Record<'libraryRoot' | 'inboxRoot' | 'processingRoot' | 'quarantineRoot', LocalIngestPathCheck>;
  sameVolume: boolean;
  errors: string[];
};

const DEFAULT_SEVEN_ZIP_PATH = 'C:\\Program Files\\NVIDIA Corporation\\NVIDIA app\\7z.exe';

function deriveSiblingRoot(name: string): string {
  const parsed = path.parse(appConfig.galleryRoot);
  if (parsed.root && appConfig.galleryRoot !== parsed.root) {
    return path.join(path.dirname(appConfig.galleryRoot), name);
  }
  return path.join(parsed.root || appConfig.galleryRoot, name);
}

export function defaultLocalIngestSettings(): LocalIngestSettings {
  return {
    libraryRoot: appConfig.galleryRoot,
    inboxRoot: deriveSiblingRoot('cos待入库'),
    processingRoot: deriveSiblingRoot('cos处理中'),
    quarantineRoot: deriveSiblingRoot('cos隔离区'),
    sevenZipPath: DEFAULT_SEVEN_ZIP_PATH,
    fileStableSeconds: 5,
    recycleAfterIngest: true,
    maxExtractionDepth: 2
  };
}

function normalizeAbsolutePath(value: string): string {
  const resolved = path.resolve(value.trim());
  return path.normalize(resolved);
}

function normalizeSettings(settings: LocalIngestSettings): LocalIngestSettings {
  return {
    ...settings,
    libraryRoot: normalizeAbsolutePath(settings.libraryRoot),
    inboxRoot: normalizeAbsolutePath(settings.inboxRoot),
    processingRoot: normalizeAbsolutePath(settings.processingRoot),
    quarantineRoot: normalizeAbsolutePath(settings.quarantineRoot),
    sevenZipPath: path.normalize(settings.sevenZipPath.trim()),
    maxExtractionDepth: 2
  };
}

function parseStoredSettings(raw: string | null): LocalIngestSettings {
  if (!raw) return defaultLocalIngestSettings();
  try {
    return normalizeSettings(localIngestSettingsSchema.parse(JSON.parse(raw)));
  } catch {
    return defaultLocalIngestSettings();
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

function configuredArchivePassword(): string | null {
  const value = process.env.LOCAL_INGEST_ARCHIVE_PASSWORD;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('command timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function validateSevenZip(executablePath: string): Promise<LocalIngestSettingsValidation['sevenZip']> {
  try {
    const result = await runCommand(executablePath, ['i'], 10_000);
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
  get(): LocalIngestSettingsView {
    return {
      ...parseStoredSettings(appSettingsRepository.get(LOCAL_INGEST_SETTINGS_SETTING_KEY)),
      allowlist: parseStoredAllowlist(appSettingsRepository.get(LOCAL_INGEST_ALLOWLIST_SETTING_KEY)),
      archivePasswordConfigured: configuredArchivePassword() !== null
    };
  }

  getArchivePassword(): string {
    const password = configuredArchivePassword();
    if (!password) {
      throw new Error('LOCAL_INGEST_ARCHIVE_PASSWORD is not configured');
    }
    return password;
  }

  save(input: LocalIngestSettings & { allowlist?: string[] }): LocalIngestSettingsView {
    const settings = normalizeSettings(localIngestSettingsSchema.parse(input));
    const allowlist = [...new Set(allowlistSchema.parse(input.allowlist ?? this.get().allowlist))];
    appSettingsRepository.setMany([
      { key: LOCAL_INGEST_SETTINGS_SETTING_KEY, value: JSON.stringify(settings) },
      { key: LOCAL_INGEST_ALLOWLIST_SETTING_KEY, value: JSON.stringify(allowlist) }
    ]);
    return { ...settings, allowlist, archivePasswordConfigured: configuredArchivePassword() !== null };
  }

  async validate(input?: LocalIngestSettings): Promise<LocalIngestSettingsValidation> {
    const settings = normalizeSettings(localIngestSettingsSchema.parse(input ?? this.get()));
    const [libraryRoot, inboxRoot, processingRoot, quarantineRoot, sevenZip] = await Promise.all([
      inspectPath(settings.libraryRoot, false),
      inspectPath(settings.inboxRoot, false),
      inspectPath(settings.processingRoot, true),
      inspectPath(settings.quarantineRoot, true),
      validateSevenZip(settings.sevenZipPath)
    ]);
    const paths = { libraryRoot, inboxRoot, processingRoot, quarantineRoot };
    const volumes = new Set(Object.values(paths).map((entry) => entry.volume));
    const sameVolume = volumes.size === 1 && !volumes.has('');
    const errors: string[] = [];
    for (const [name, entry] of Object.entries(paths)) {
      if (!entry.exists || !entry.readable) errors.push(`${name} is not readable`);
      if (!entry.writable) errors.push(`${name} is not writable`);
    }
    if (!sameVolume) errors.push('Configured roots are not on the same volume');
    if (!sevenZip.valid) errors.push('7-Zip validation failed');
    if (!configuredArchivePassword()) errors.push('Archive password secret is not configured');
    const normalizedRoots = Object.values(paths).map((entry) => path.normalize(entry.path).toLocaleLowerCase());
    if (new Set(normalizedRoots).size !== normalizedRoots.length) errors.push('Configured roots must be distinct');
    return {
      valid: errors.length === 0,
      passwordConfigured: configuredArchivePassword() !== null,
      sevenZip,
      paths,
      sameVolume,
      errors
    };
  }
}

export const localIngestSettingsService = new LocalIngestSettingsService();
