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
  // A slash inside prose (including Chinese text) is not a path boundary.
  // Retain quoted/labelled absolute paths as well as whitespace-delimited ones.
  const absolutePath = /\b[A-Za-z]:[\\/]|\\\\|(?:^|[\s"'`(=：:])\/(?!\/)[^\s]/;
  return credentials.test(message) || absolutePath.test(message)
    ? '请求未能完成，请根据错误码和请求编号排查。' : message;
}

const descriptions: Record<number, [string, string]> = {
  400: ['INVALID_REQUEST', '请求参数不正确，请检查后重试。'],
  401: ['AUTHENTICATION_REQUIRED', '请先完成身份验证。'],
  403: ['FORBIDDEN', '当前不允许执行此操作。'],
  404: ['NOT_FOUND', '未找到请求的资源。'],
  409: ['CONFLICT', '请求与当前状态冲突，请刷新后重试。'],
  410: ['GONE', '此操作已停用。'],
  413: ['PAYLOAD_TOO_LARGE', '请求内容过大。'],
  415: ['UNSUPPORTED_MEDIA_TYPE', '不支持此请求编码。'],
  416: ['RANGE_NOT_SATISFIABLE', '请求的媒体范围无效。'],
  429: ['RATE_LIMITED', '请求过于频繁，请稍后重试。'],
  500: ['INTERNAL_ERROR', '服务端发生异常，请根据请求编号排查。'],
  503: ['SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试。']
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
  response.status(500).json({ code: 'INTERNAL_ERROR', message: descriptions[500]![1], requestId: response.locals.requestId });
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
        message: business.status >= 500 ? (descriptions[business.status]?.[1] ?? descriptions[500]![1]) : business.message,
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
