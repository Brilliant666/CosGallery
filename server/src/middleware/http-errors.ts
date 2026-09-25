import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { log } from '../services/log-service.js';
import { RequestInputError } from '../utils/request-input-error.js';
import { LocalIngestPathError } from '../utils/local-ingest-paths.js';

export const requestIdentity: RequestHandler = (_request, response, next) => {
  // Never trust an unbounded caller-controlled request id or log request secrets.
  response.locals.requestId = randomUUID();
  response.setHeader('X-Request-Id', response.locals.requestId);
  const json = response.json.bind(response);
  response.json = (body: unknown) => {
    // Existing typed route handlers retain their statuses/codes and normal
    // management data. Only error descriptions are scrubbed at this boundary.
    if (response.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      const output = { ...body } as Record<string, unknown>;
      for (const key of ['message', 'error']) if (typeof output[key] === 'string') output[key] = publicErrorText(output[key]);
      return json(output);
    }
    return json(body);
  };
  next();
};

export function publicErrorText(message: string): string {
  // Do not redact only a token: Bearer values, cookie lists, quoted strings and
  // paths with spaces have no reliable delimiter. Suppress the whole error
  // description; stable code/requestId remain available for diagnosis.
  const credentials = /\b(?:password|passwd|pwd|cookie|authorization|(?:access[_-]?|refresh[_-]?)?token|secret|api[_-]?key)["']?\s*[:=]|\bBearer\s+\S+/i;
  const absolutePath = /\b[A-Za-z]:[\\/]|\\\\|(?:^|[^A-Za-z0-9])\/(?!\/)[^\s]/;
  return credentials.test(message) || absolutePath.test(message)
    ? 'Request could not be completed. See the error code and request ID.' : message;
}

const descriptions: Record<number, [string, string]> = {
  400: ['INVALID_REQUEST', 'Invalid request.'],
  401: ['AUTHENTICATION_REQUIRED', 'Authentication is required.'],
  403: ['FORBIDDEN', 'This operation is not allowed.'],
  404: ['NOT_FOUND', 'Requested resource was not found.'],
  409: ['CONFLICT', 'The request conflicts with current state.'],
  410: ['GONE', 'This operation is no longer available.'],
  413: ['PAYLOAD_TOO_LARGE', 'Request body is too large.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding.'],
  416: ['RANGE_NOT_SATISFIABLE', 'Requested media range is not satisfiable.'],
  429: ['RATE_LIMITED', 'Too many requests. Please try again later.'],
  503: ['SERVICE_UNAVAILABLE', 'Service is temporarily unavailable.']
};

export function logRequestFailure(response: Response, error: unknown, status = 500): void {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNCLASSIFIED';
  // Deliberately omit message/stack/URL/body/headers: these may embed paths,
  // passwords, cookies, tokens, SQLite statements or user-supplied parameters.
  log.error('HTTP request failed', { requestId: response.locals.requestId, status, code });
}

export function sendUnexpectedError(response: Response, error: unknown): void {
  logRequestFailure(response, error);
  if (response.headersSent || response.destroyed || response.writableEnded || response.req?.aborted) return;
  response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected server error.', requestId: response.locals.requestId });
}

export function createHttpErrorHandler(known?: (error: unknown) => { status: number; message: string; code?: string } | null): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    if (response.destroyed || response.writableEnded || request.aborted) return;
    if (response.headersSent) {
      logRequestFailure(response, error);
      // Do not pass to Express's default logger (which prints raw stacks).
      response.destroy();
      return;
    }
    const business = error instanceof RequestInputError || error instanceof LocalIngestPathError
      ? { status: 400, message: error.message, code: error.code } : known?.(error);
    if (business) {
      if (business.status >= 500) logRequestFailure(response, error, business.status);
      response.status(business.status).json({
        code: business.code,
        message: business.status >= 500 ? (descriptions[business.status]?.[1] ?? 'Unexpected server error.') : business.message,
        requestId: response.locals.requestId
      });
      return;
    }
    const detail = error instanceof Error ? error as Error & { status?: number; type?: string; code?: string } : null;
    const parserStatuses: Record<string, number> = { 'entity.parse.failed': 400, 'entity.too.large': 413, 'encoding.unsupported': 415, 'charset.unsupported': 415 };
    const status = error instanceof ZodError ? 400
      : detail?.type && parserStatuses[detail.type] ? parserStatuses[detail.type]!
      : detail?.status && [401, 403, 404, 409, 410, 416, 429, 503].includes(detail.status) ? detail.status : 500;
    if (status === 500) { sendUnexpectedError(response, error); return; }
    if (status >= 500) logRequestFailure(response, error, status);
    const [code, message] = descriptions[status]!;
    response.status(status).json({ code, message, requestId: response.locals.requestId });
  };
}
