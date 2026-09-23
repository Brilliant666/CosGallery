import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The database contains only authenticated ciphertext (or an explicit disabled
// marker). The key is separate, startup-owned, and never part of an API view.
export const LOCAL_INGEST_PASSWORD_SETTING_KEY = 'local_ingest.archive_password';
const AAD = Buffer.from('cosgallery.local-ingest.archive-password.v1');
const STORAGE_ERROR = 'Unable to read or protect the saved archive password';

export class LocalIngestPasswordStore {
  constructor(private readonly privateRoot: string) {}

  private key(create: boolean): Buffer {
    const root = path.resolve(this.privateRoot);
    const ancestors: string[] = [];
    for (let current = root;; current = path.dirname(current)) {
      ancestors.unshift(current);
      if (path.dirname(current) === current) break;
    }
    for (const current of ancestors) {
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(STORAGE_ERROR);
      }
    }
    if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const filename = path.join(root, 'local-ingest-archive-password.key');
    if (create && !fs.existsSync(filename)) {
      try {
        fs.writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(STORAGE_ERROR);
    const key = fs.readFileSync(filename);
    if (key.length !== 32) throw new Error(STORAGE_ERROR);
    return key;
  }

  encrypt(password: string): string {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key(true), iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
      return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    } catch {
      throw new Error(STORAGE_ERROR);
    }
  }

  decrypt(raw: string): string | null {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.version !== 1) throw new Error(STORAGE_ERROR);
      if (value.disabled === true && Object.keys(value).length === 2) return null;
      if (typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.data !== 'string') throw new Error(STORAGE_ERROR);
      const iv = Buffer.from(value.iv, 'base64');
      const tag = Buffer.from(value.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error(STORAGE_ERROR);
      const decipher = createDecipheriv('aes-256-gcm', this.key(false), iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const password = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
      if (!password) throw new Error(STORAGE_ERROR);
      return password;
    } catch {
      // No filesystem path, ciphertext, key bytes, or user input in errors.
      throw new Error(STORAGE_ERROR);
    }
  }
}
