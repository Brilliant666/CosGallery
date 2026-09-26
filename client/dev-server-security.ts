import { realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Plugin } from 'vite';

const proxyPrefix = /^\/(?:api|thumbnails|previews)(?:\/|$)/;
const privateSegment = /^(?:\.mocks|\.git|\.idea|\.run|private|data|db|data_backup|\.env(?:\..*)?)$/i;
const privateExtension = /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$|\.(?:key|pem|crt|pfx|p12|run\.xml)$/i;

export const developmentFileDeny = [
  '**/.env', '**/.env.*', '**/.git/**', '**/.idea/**', '**/.run/**',
  '**/.mocks/**', '**/private/**', '**/data/**', '**/db/**', '**/data_backup/**',
  '**/*.{sqlite,sqlite3,db,sqlite-wal,sqlite-shm,sqlite-journal,sqlite3-wal,sqlite3-shm,sqlite3-journal,db-wal,db-shm,db-journal,key,pem,crt,pfx,p12}',
  '**/*.run.xml'
];

export function resolveDevelopmentHost(value?: string): string {
  const host = value?.trim() || '127.0.0.1';
  // LAN access is an explicit operator choice, never the default. Do not turn
  // off Vite's Host validation or accept URLs as listen addresses.
  if (host !== 'localhost' && !net.isIP(host)) {
    throw new Error('DEV_CLIENT_HOST must be localhost or an explicit IP address.');
  }
  return host;
}

function normalizedFile(file: string): string {
  const resolved = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function developmentFileAllow(clientRoot: string, dependencyRoot: string): string[] {
  return [...new Set([clientRoot, dependencyRoot].flatMap(root => {
    try { return [path.resolve(root), realpathSync(root)]; }
    catch { return [path.resolve(root)]; }
  }))];
}

function isWithin(file: string, root: string): boolean {
  return file === root || file.startsWith(root.replace(/\/$/, '') + '/');
}

export function privateDevelopmentFiles(privateRoots: string[]): Plugin {
  return {
    name: 'deny-private-development-files',
    enforce: 'pre',
    configureServer(server) {
      const roots = privateRoots.flatMap(root => {
        try { return [normalizedFile(root), normalizedFile(realpathSync(root))]; }
        catch { return [normalizedFile(root)]; }
      });
      const allowedRoots = server.config.server.fs.allow.flatMap(root => {
        try { return [normalizedFile(root), normalizedFile(realpathSync(root))]; }
        catch { return [normalizedFile(root)]; }
      });
      server.middlewares.use((request, response, next) => {
        const rawPath = (request.url ?? '').split('?')[0]!;
        // These exact prefixes are exclusively handled by the backend proxy.
        // Album/file names inside them must not be treated as Vite file access.
        if (proxyPrefix.test(rawPath)) { next(); return; }
        let pathname = rawPath;
        try {
          for (let pass = 0; pass < 4; pass += 1) {
            const decoded = decodeURIComponent(pathname);
            if (decoded === pathname) break;
            pathname = decoded;
          }
          if (/%[0-9a-f]{2}/i.test(pathname) || /[\x00-\x1f\x7f]/.test(pathname)) throw new Error();
        } catch { response.statusCode = 400; response.end(); return; }
        pathname = pathname.replace(/\\/g, '/');
        // Also inspect after decoding encoded query/hash separators. Vite's raw
        // and URL transforms must not provide another route to a private file.
        const fileUrl = pathname.split(/[?#]/)[0]!;
        const isNullVirtualModule = fileUrl.startsWith('/@id/__x00__');
        const withoutDrive = fileUrl.replace(/^\/@fs\/\/?[a-z]:/i, '');
        // Windows alternate data streams are not asset names. Preserve Vite's
        // null-prefixed virtual IDs (e.g. virtual:uno.css), which are not files.
        if (!isNullVirtualModule && withoutDrive.includes(':')) {
          response.statusCode = 404; response.end(); return;
        }
        const sensitive = (value: string) => {
          const normalized = value.split('/').map(segment => segment.replace(/[. ]+$/, ''));
          return normalized.some(segment => privateSegment.test(segment)) || privateExtension.test(normalized.join('/'));
        };
        const blocked = (file: string) => sensitive(file) || roots.some(root => isWithin(normalizedFile(file), root));
        if (sensitive(fileUrl)) { response.statusCode = 404; response.end(); return; }
        let candidates: string[];
        if (fileUrl.startsWith('/@fs/')) {
          let absolute = fileUrl.slice('/@fs/'.length);
          if (/^\/[a-z]:\//i.test(absolute)) absolute = absolute.slice(1);
          candidates = [path.resolve(absolute.startsWith('/') || /^[a-z]:\//i.test(absolute) ? absolute : '/' + absolute)];
        } else {
          candidates = [path.resolve(server.config.root, '.' + fileUrl)];
          if (server.config.publicDir) candidates.push(path.resolve(server.config.publicDir, '.' + fileUrl));
        }
        for (const candidate of candidates) {
          if (blocked(candidate)) { response.statusCode = 404; response.end(); return; }
          try {
            const realFile = realpathSync(candidate);
            // Public directories can contain symlinks. Check their resolved
            // destination, not just the harmless-looking requested alias.
            if (blocked(realFile) || !allowedRoots.some(root => isWithin(normalizedFile(realFile), root))) {
              response.statusCode = 404; response.end(); return;
            }
          } catch { /* Missing files are left to Vite's normal resolution. */ }
        }
        next();
      });
    }
  };
}
