import type express from 'express';

import { describe, expect, it, vi } from 'vitest';

function createRequest(method: string): express.Request {
  return {
    method
  } as express.Request;
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

describe.sequential('blockPublicDemoMutations', () => {
  it('blocks mutating requests when public demo mode is enabled', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_DEMO_MODE', '1');

    const middleware = await import('../src/middleware/public-demo-mode.js');
    const request = createRequest('DELETE');
    const response = createResponse();
    const next = vi.fn();

    middleware.blockPublicDemoMutations(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ message: middleware.PUBLIC_DEMO_DISABLED_MESSAGE });
    vi.unstubAllEnvs();
  });

  it('allows safe requests in public demo mode', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_DEMO_MODE', '1');

    const middleware = await import('../src/middleware/public-demo-mode.js');
    const request = createRequest('GET');
    const response = createResponse();
    const next = vi.fn();

    middleware.blockPublicDemoMutations(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('allows mutating requests when public demo mode is disabled', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_DEMO_MODE', '0');

    const middleware = await import('../src/middleware/public-demo-mode.js');
    const request = createRequest('POST');
    const response = createResponse();
    const next = vi.fn();

    middleware.blockPublicDemoMutations(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
