import type express from 'express';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Parse only a Host authority, not a URL, userinfo or forwarded host chain. */
export function parseRequestAuthority(value: string, protocol = 'http'): URL | null {
  if (!value || /[\s,/@\\?#]/u.test(value)) return null;
  try {
    if (protocol !== 'http' && protocol !== 'https') return null;
    const parsed = new URL(`${protocol}://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return parsed;
  } catch { return null; }
}

function hostname(value: string): string {
  return value.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Binding to all interfaces must not implicitly trust every browser Host. */
export function createAllowedRequestHost(options: { serverHost: string; allowedHosts?: readonly string[] }): express.RequestHandler {
  const allowed = new Set(LOOPBACK_HOSTS);
  for (const value of [options.serverHost, ...(options.allowedHosts ?? [])]) {
    const normalized = hostname(value);
    if (normalized === '0.0.0.0' || normalized === '::') continue;
    const authority = parseRequestAuthority(normalized.includes(':') ? `[${normalized}]` : normalized);
    if (!authority || authority.port || normalized.includes('*')) throw new Error('SERVER_ALLOWED_HOSTS must contain exact hostnames or IP addresses without ports.');
    allowed.add(hostname(authority.hostname));
  }
  return (request, response, next) => {
    const value = request.get('host');
    const authority = value ? parseRequestAuthority(value) : null;
    if (!authority || !allowed.has(hostname(authority.hostname))) {
      response.status(403).json({ code: 'UNTRUSTED_HOST', message: '请求主机不在允许范围内。' });
      return;
    }
    next();
  };
}
