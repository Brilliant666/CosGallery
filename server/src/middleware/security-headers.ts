import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Only scripts present in the delivered build are authorized inline. */
export function contentSecurityPolicy(html = '', development = false): string {
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]!) && match[2]!.trim())
    .map((match) => `'sha256-${createHash('sha256').update(match[2]!.replace(/\r\n?/g, '\n')).digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // Vue uses dynamic style attributes; Inter remains on its existing origins.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ');
}

export function securityHeaders(html = '', development = false): RequestHandler {
  const policy = contentSecurityPolicy(html, development);
  return (_request, response, next) => {
    response.setHeader('Content-Security-Policy', policy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // No HSTS/upgrade-insecure-requests: local HTTP remains supported.
    next();
  };
}
