import type express from 'express';

import { appConfig } from '../config/env.js';
import { parseRequestAuthority } from './request-host.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CONFIGURED_TRUSTED_ORIGINS = new Set(appConfig.csrfTrustedOrigins);

export const CSRF_INTENT_HEADER = 'x-foldergram-intent';
export const CSRF_INTENT_VALUE = '1';

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizePort(protocol: string, port: string): string {
  if (port) {
    return port;
  }

  if (protocol === 'https:') {
    return '443';
  }

  if (protocol === 'http:') {
    return '80';
  }

  return '';
}

function normalizeOrigin(origin: string): URL | null {
  if (!/^https?:\/\//.test(origin) || /\s/.test(origin)) return null;
  try {
    const parsedOrigin = new URL(origin);
    if ((parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:')
      || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/'
      || parsedOrigin.search || parsedOrigin.hash) {
      return null;
    }

    return parsedOrigin;
  } catch {
    return null;
  }
}

function getAllowedPortSet(): Set<string> {
  const allowedPorts = new Set([String(appConfig.port)]);

  if (appConfig.nodeEnv !== 'production') {
    for (const port of appConfig.devClientPorts) {
      allowedPorts.add(String(port));
    }
  }

  return allowedPorts;
}

export function isAllowedLocalOrigin(origin: string, requestHost?: string, servingProtocol = 'http'): boolean {
  const parsedOrigin = normalizeOrigin(origin);
  if (!parsedOrigin) {
    return false;
  }

  if (CONFIGURED_TRUSTED_ORIGINS.has(parsedOrigin.origin)) {
    return true;
  }

  const hostname = normalizeHostname(parsedOrigin.hostname);
  const port = normalizePort(parsedOrigin.protocol, parsedOrigin.port);

  if (appConfig.nodeEnv === 'production') {
    const parsedRequestHost = requestHost ? parseRequestAuthority(requestHost, servingProtocol) : null;
    if (!parsedRequestHost) {
      return false;
    }

    const protocol = servingProtocol === 'https' ? 'https:' : 'http:';
    // Forwarded headers are client input; only the direct serving authority is
    // implicit trust. Reverse proxies use explicit CSRF_TRUSTED_ORIGINS.
    return parsedOrigin.protocol === protocol
      && hostname === normalizeHostname(parsedRequestHost.hostname)
      && port === normalizePort(protocol, parsedRequestHost.port);
  }

  if (!LOOPBACK_HOSTS.has(hostname)) {
    return false;
  }

  return getAllowedPortSet().has(port);
}

function getRefererOrigin(referer: string): string | null {
  if (!/^https?:\/\//.test(referer) || /\s/.test(referer)) return null;
  try {
    const parsed = new URL(referer);
    if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function requireTrustedMutationRequest(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
): void {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
    next();
    return;
  }

  if (request.get(CSRF_INTENT_HEADER) !== CSRF_INTENT_VALUE) {
    response.status(403).json({ message: 'Forbidden' });
    return;
  }

  const origin = request.get('origin');
  const requestHost = request.get('host') ?? undefined;
  if (origin !== undefined && !isAllowedLocalOrigin(origin, requestHost, request.protocol)) {
    response.status(403).json({ message: 'Forbidden' });
    return;
  }

  const referer = request.get('referer');
  const refererOrigin = referer ? getRefererOrigin(referer) : null;
  if (referer !== undefined && (!refererOrigin
    || !isAllowedLocalOrigin(refererOrigin, requestHost, request.protocol)
    || origin !== undefined && normalizeOrigin(origin)?.origin !== refererOrigin)) {
    response.status(403).json({ message: 'Forbidden' });
    return;
  }

  // CLI clients may omit browser metadata, but still need intent and the
  // downstream authentication/capability checks. Browser metadata must not
  // downgrade malformed or suppressed cross-site provenance to CLI trust.
  // Node's fetch sends Mode:cors without Site/Origin; that alone is not browser
  // provenance. Browsers cannot send the intent header cross-origin without a
  // CORS preflight, which the ordinary API does not grant.
  const fetchMode = request.get('sec-fetch-mode');
  if (origin === undefined && referer === undefined
    && (request.get('sec-fetch-site') !== undefined || fetchMode !== undefined && fetchMode !== 'cors')) {
    response.status(403).json({ message: 'Forbidden' });
    return;
  }

  next();
}
