import type express from 'express';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { appConfig } from '../src/config/env.js';
import {
  CSRF_INTENT_HEADER,
  CSRF_INTENT_VALUE,
  isAllowedLocalOrigin,
  requireTrustedMutationRequest
} from '../src/middleware/csrf-protection.js';

function createRequest(method: string, headers: Record<string, string | undefined> = {}): express.Request {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    method,
    protocol: 'http',
    get(name: string) {
      return normalizedHeaders.get(name.toLowerCase());
    }
  } as unknown as express.Request;
}

function createResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as express.Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('isAllowedLocalOrigin', () => {
  it('allows loopback origins for the app port and the dev-client port range', () => {
    expect(isAllowedLocalOrigin(`http://localhost:${appConfig.port}`)).toBe(true);
    expect(isAllowedLocalOrigin(`http://127.0.0.1:${appConfig.devClientPort}`)).toBe(true);
    expect(isAllowedLocalOrigin(`http://localhost:${appConfig.devClientPorts.at(-1)}`)).toBe(true);
    expect(isAllowedLocalOrigin(`http://[::1]:${appConfig.port}`)).toBe(true);
  });

  it('rejects non-loopback or unexpected ports', () => {
    expect(isAllowedLocalOrigin('http://example.com:4141')).toBe(false);
    expect(isAllowedLocalOrigin(`http://localhost:${appConfig.devClientPorts.at(-1)! + 1}`)).toBe(false);
    expect(isAllowedLocalOrigin('http://localhost:9999')).toBe(false);
    expect(isAllowedLocalOrigin('not-a-url')).toBe(false);
  });
});

describe('requireTrustedMutationRequest', () => {
  it.each([
    { origin: 'null' }, { origin: '' }, { origin: 'http://localhost:4141/path' },
    { referer: 'not-a-url' }, { referer: 'null' }, { origin: 'http:localhost:4141' }, { referer: 'http:localhost:4141' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-mode': 'navigate' },
    { origin: `http://localhost:${appConfig.devClientPort}`, referer: `http://127.0.0.1:${appConfig.devClientPort}/page` },
    { origin: `http://localhost:${appConfig.devClientPort}`, referer: 'broken' }
  ])('rejects invalid or contradictory browser provenance %j', (headers) => {
    const response = createResponse(), next = vi.fn();
    requireTrustedMutationRequest(createRequest('POST', { [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE, ...headers }), response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows matching browser provenance from a supported Vite port', () => {
    const response = createResponse(), next = vi.fn();
    const origin = `http://localhost:${appConfig.devClientPorts.at(-1)}`;
    requireTrustedMutationRequest(createRequest('POST', {
      [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE, origin, referer: `${origin}/settings`, 'sec-fetch-site': 'same-origin'
    }), response, next);
    expect(next).toHaveBeenCalledOnce();
  });
  it('allows safe methods without the CSRF header', () => {
    const request = createRequest('GET');
    const response = createResponse();
    const next = vi.fn();

    requireTrustedMutationRequest(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('blocks mutating requests without the intent header', () => {
    const request = createRequest('POST');
    const response = createResponse();
    const next = vi.fn();

    requireTrustedMutationRequest(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it('allows mutating requests with the intent header and an allowed origin', () => {
    const request = createRequest('DELETE', {
      [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE,
      origin: `http://localhost:${appConfig.devClientPort}`
    });
    const response = createResponse();
    const next = vi.fn();

    requireTrustedMutationRequest(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('allows mutating requests with the intent header and no browser origin metadata', () => {
    const request = createRequest('POST', {
      [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE
    });
    const response = createResponse();
    const next = vi.fn();

    requireTrustedMutationRequest(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('preserves Node fetch CLI mode without treating mode alone as browser identity', () => {
    const response = createResponse(), next = vi.fn();
    requireTrustedMutationRequest(createRequest('POST', {
      [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE, 'sec-fetch-mode': 'cors'
    }), response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks mutating requests when the origin is not trusted', () => {
    const request = createRequest('POST', {
      [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE,
      origin: 'http://evil.example:4142'
    });
    const response = createResponse();
    const next = vi.fn();

    requireTrustedMutationRequest(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it('blocks mutating requests when only an untrusted referer is present', () => {
    const request = createRequest('POST', {
      [CSRF_INTENT_HEADER]: CSRF_INTENT_VALUE,
      referer: 'http://evil.example:4142/path'
    });
    const response = createResponse();
    const next = vi.fn();

    requireTrustedMutationRequest(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });
});

describe.sequential('production mutation origin checks', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('allows production mutations from the same non-loopback host even when Docker maps a different host port', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SERVER_PORT', '4141');

    const middleware = await import('../src/middleware/csrf-protection.js');
    const request = createRequest('DELETE', {
      [middleware.CSRF_INTENT_HEADER]: middleware.CSRF_INTENT_VALUE,
      host: '192.168.100.2:4142',
      origin: 'http://192.168.100.2:4142'
    });
    const response = createResponse();
    const next = vi.fn();

    middleware.requireTrustedMutationRequest(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('rejects production mutations forged through forwarded public https headers', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SERVER_PORT', '4141');

    const middleware = await import('../src/middleware/csrf-protection.js');
    const request = createRequest('DELETE', {
      [middleware.CSRF_INTENT_HEADER]: middleware.CSRF_INTENT_VALUE,
      host: '127.0.0.1:4141',
      'x-forwarded-host': 'foldergram.intentdeep.com',
      'x-forwarded-proto': 'https',
      origin: 'https://foldergram.intentdeep.com'
    });
    const response = createResponse();
    const next = vi.fn();

    middleware.requireTrustedMutationRequest(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    vi.unstubAllEnvs();
  });

  it('compares actual protocol and explicit port without trusting forwarded protocol', async () => {
    vi.resetModules(); vi.stubEnv('NODE_ENV', 'production');
    const { isAllowedLocalOrigin: allowed } = await import('../src/middleware/csrf-protection.js');
    expect(allowed('https://localhost:4141', 'localhost:4141', 'http')).toBe(false);
    expect(allowed('https://localhost', 'localhost', 'https')).toBe(true);
    expect(allowed('https://localhost', 'localhost:80', 'https')).toBe(false);
    expect(allowed('https://localhost:80', 'localhost:80', 'https')).toBe(true);
    expect(allowed('http://localhost:4141', 'localhost:4141', 'http')).toBe(true);
    expect(allowed('http://localhost:4141', 'localhost:4141/ignored', 'http')).toBe(false);
  });

  it('allows production mutations from a configured trusted origin', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SERVER_PORT', '4141');
    vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'https://foldergram.intentdeep.com');

    const middleware = await import('../src/middleware/csrf-protection.js');
    const request = createRequest('DELETE', {
      [middleware.CSRF_INTENT_HEADER]: middleware.CSRF_INTENT_VALUE,
      host: '127.0.0.1:4141',
      origin: 'https://foldergram.intentdeep.com'
    });
    const response = createResponse();
    const next = vi.fn();

    middleware.requireTrustedMutationRequest(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('rejects production mutations when the origin host does not match the serving host', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SERVER_PORT', '4141');

    const middleware = await import('../src/middleware/csrf-protection.js');
    const request = createRequest('DELETE', {
      [middleware.CSRF_INTENT_HEADER]: middleware.CSRF_INTENT_VALUE,
      host: '192.168.100.2:4142',
      origin: 'http://192.168.100.3:4142'
    });
    const response = createResponse();
    const next = vi.fn();

    middleware.requireTrustedMutationRequest(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    vi.unstubAllEnvs();
  });
});
