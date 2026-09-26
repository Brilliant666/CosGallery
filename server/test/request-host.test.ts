import type express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createAllowedRequestHost } from '../src/middleware/request-host.js';

function check(host: string | undefined, options = { serverHost: '127.0.0.1' }, headers: Record<string, string> = {}) {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  const request = { get: (key: string) => key === 'host' ? host : headers[key] };
  createAllowedRequestHost(options)(request as express.Request, response as unknown as express.Response, next);
  return { response, next };
}

describe('request Host boundary', () => {
  it.each(['localhost:4141', '127.0.0.1:4241', '[::1]:4140', 'localhost:5173'])('allows loopback and Vite authorities %s', host => {
    expect(check(host).next).toHaveBeenCalledOnce();
  });
  it.each([undefined, '', 'attacker.invalid:4141', 'localhost.attacker.invalid:4141', 'localhost:4141/path',
    'user@localhost:4141', 'localhost:4141,evil.invalid', 'localhost:4141#evil', 'localhost:4141?evil', 'localhost :4141'])('rejects untrusted or malformed Host %s', host => {
    const { response, next } = check(host);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it('ignores forwarded headers and does not trust wildcard bind addresses', () => {
    expect(check('attacker.invalid', { serverHost: '0.0.0.0' }, { 'x-forwarded-host': 'localhost', forwarded: 'host=localhost' }).response.status).toHaveBeenCalledWith(403);
    expect(check('0.0.0.0', { serverHost: '0.0.0.0' }).response.status).toHaveBeenCalledWith(403);
  });
  it('allows exact explicit LAN or proxy hosts, not suffix matches', () => {
    const handler = createAllowedRequestHost({ serverHost: '192.0.2.1', allowedHosts: ['gallery.example', '::1'] });
    for (const host of ['192.0.2.1:8080', 'gallery.example:443']) {
      const next = vi.fn();
      handler({ get: () => host } as unknown as express.Request, {} as express.Response, next);
      expect(next).toHaveBeenCalledOnce();
    }
    expect(() => createAllowedRequestHost({ serverHost: '0.0.0.0', allowedHosts: ['*.example'] })).toThrow();
  });
});
