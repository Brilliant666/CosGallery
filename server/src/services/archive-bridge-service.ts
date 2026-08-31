import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { databaseManager } from '../db/database.js';

const ARCHIVE_BRIDGE_TOKEN_HASH_KEY = 'archive_bridge_token_sha256';

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class ArchiveBridgeService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  isConfigured(): boolean {
    return this.readTokenHash() !== null;
  }

  rotateToken(): string {
    const token = randomBytes(32).toString('base64url');
    this.database.prepare(
      `INSERT INTO app_settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(ARCHIVE_BRIDGE_TOKEN_HASH_KEY, hashToken(token).toString('hex'));
    return token;
  }

  verifyToken(token: string): boolean {
    if (!token) return false;
    const expected = this.readTokenHash();
    if (!expected) return false;
    const actual = hashToken(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private readTokenHash(): Buffer | null {
    const row = this.database.prepare(
      'SELECT value FROM app_settings WHERE key = ?'
    ).get(ARCHIVE_BRIDGE_TOKEN_HASH_KEY) as { value: string } | undefined;
    if (!row || !/^[a-f0-9]{64}$/iu.test(row.value)) return null;
    return Buffer.from(row.value, 'hex');
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLocaleLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}
