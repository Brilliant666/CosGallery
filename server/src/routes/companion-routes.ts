import express from 'express';
import { z } from 'zod';
import { databaseManager } from '../db/database.js';
import { isLoopbackAddress } from '../services/archive-bridge-service.js';
import { CompanionGrantService, CompanionAccessError, extensionOriginSchema } from '../services/companion-grant-service.js';
import { CompanionReadService, CompanionReadError, COUNT_POLICY_VERSION, type CompanionIdentity } from '../services/companion-read-service.js';
import { CompanionDirectoryService } from '../services/companion-directory-service.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { companionAccessErrors } from './companion-grant-routes.js';

type Access = ReturnType<CompanionGrantService['authenticate']>;
const MAX_DIRECTORY_PAGE_BYTES = 262_144;
const directoryQuery = (max: number) => z.object({
  limit: z.coerce.number().int().min(1).max(max).default(max),
  cursor: z.string().min(1).max(512).optional(),
  identityVersion: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();

/** Independent bearer surface. Never accepts browser sessions/bridge tokens and
 * never mounts the ordinary mutation router under its narrow CORS policy. */
export function createCompanionRouter(
  grants = () => new CompanionGrantService(),
  reader = () => new CompanionReadService(databaseManager.connection),
  directory = () => new CompanionDirectoryService(databaseManager.connection, reader())
) {
  const router = express.Router();
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.vary('Origin');
    response.vary('Authorization');
    const json = response.json.bind(response);
    response.json = (body: unknown) => {
      if (response.statusCode >= 400) {
        const detail = body && typeof body === 'object' ? body : {};
        return json({ ...detail, collectedWorkCount: null });
      }
      return json(body);
    };
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new CompanionAccessError(403, 'COMPANION_LOCAL_ONLY', '只读连接仅对本机开放。');
    }
    const origin = request.get('origin');
    if (origin !== undefined) {
      if (!extensionOriginSchema.safeParse(origin).success || !grants().allowsOrigin(origin)) {
        throw new CompanionAccessError(403, 'COMPANION_ORIGIN_DENIED', '此扩展来源未获授权。');
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
    } else if (request.get('referer') !== undefined
      || request.get('sec-fetch-site') !== undefined && request.get('sec-fetch-site') !== 'none') {
      // Background extension/CLI requests may omit Origin. Website provenance
      // cannot use that omission to enter this surface, even with a bearer token.
      throw new CompanionAccessError(403, 'COMPANION_ORIGIN_DENIED', '此请求来源不受支持。');
    }
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.get('access-control-request-method');
      const headers = (request.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!origin || !['GET', 'POST'].includes(requestedMethod ?? '')
        || headers.some(h => !['authorization', 'content-type'].includes(h))) {
        throw new CompanionAccessError(403, 'COMPANION_PREFLIGHT_DENIED', '此跨域请求未获授权。');
      }
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      // No credentials flag, wildcard, origin reflection or ordinary API CORS.
      if (request.get('access-control-request-private-network') === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.status(204).end(); return;
    }
    response.locals.companion = grants().authenticate(request.get('authorization'), origin);
    next();
  });
  router.use(createRateLimiter({ windowMs: 60_000, max: 120, message: '只读查询过于频繁，请稍后重试。' }));
  router.use(express.json({ limit: '32kb', strict: true }));

  const access = (response: express.Response): Access => response.locals.companion as Access;
  const has = (response: express.Response, scope: Access['grant']['scopes'][number]) => access(response).grant.scopes.includes(scope);
  const context = (response: express.Response) => {
    const value = access(response);
    return {
      apiVersion: 'companion-v1', instanceId: value.instanceId, label: value.label,
      grantId: value.grant.id, permissionFingerprint: value.permissionFingerprint,
      scopes: value.grant.scopes, expiresAt: value.grant.expiresAt, countPolicyVersion: COUNT_POLICY_VERSION,
      queriedAt: new Date().toISOString()
    };
  };
  const links = (response: express.Response, creator: CompanionIdentity) => ({
    ...creator,
    links: {
      ...(has(response, 'library:link') ? { library: `/library/${creator.creatorId}` } : {}),
      ...(has(response, 'catalog:link') ? { catalog: `/archive-catalog?workspace=resources&creatorId=${creator.creatorId}` } : {})
    }
  });

  router.get('/connection', (_request, response) => {
    response.json({ ...context(response), capabilities: {
      batchResolve: true, creatorSearch: true, creatorSummary: has(response, 'summary:read'),
      libraryLink: has(response, 'library:link'), catalogLink: has(response, 'catalog:link'),
      maxBatchItems: 50, maxBodyBytes: 32_768, mutations: false,
      rosterSync: true, aliasSync: true, maxRosterPageSize: 50, maxAliasPageSize: 200,
      maxPageBytes: MAX_DIRECTORY_PAGE_BYTES
    } });
  });
  const sendDirectory = (response: express.Response, body: unknown) => {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_DIRECTORY_PAGE_BYTES) {
      throw new CompanionReadError(413, 'COMPANION_PAGE_TOO_LARGE', '只读同步页过大，请减小每页数量后重试。');
    }
    response.json(body);
  };
  router.get('/roster', (request, response) => {
    const input = directoryQuery(50).parse(request.query);
    const result = directory().roster(input, { includeSummary: has(response, 'summary:read') });
    sendDirectory(response, { ...context(response), ...result, items: result.items.map(item => links(response, item)) });
  });
  router.get('/aliases', (request, response) => {
    const input = directoryQuery(200).parse(request.query);
    sendDirectory(response, { ...context(response), ...directory().aliases(input) });
  });
  router.get('/creators', (request, response) => {
    const input = z.object({ q: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(1).max(30).default(20) }).strict().parse(request.query);
    const result = reader().search(input.q, input.limit);
    response.json({ ...context(response), ...result, items: result.items.map(item => links(response, item)) });
  });
  router.get('/creators/:id', (request, response) => {
    if (!has(response, 'summary:read')) throw new CompanionAccessError(403, 'COMPANION_SCOPE_DENIED', '此授权未包含作品摘要读取权限。');
    const id = z.coerce.number().int().positive().safe().parse(request.params.id);
    const summary = reader().summary(id);
    response.json({ ...context(response), ...summary, matchStatus: 'manual', matchedBy: 'explicit_creator_id', ...links(response, summary) });
  });
  router.post('/resolve', (request, response) => {
    const body = z.object({ items: z.array(z.unknown()).min(1).max(50) }).strict().parse(request.body);
    const items = reader().resolveBatch(body.items, { includeSummary: has(response, 'summary:read') }).map(item => 'error' in item ? item : {
      ...item,
      creator: item.creator ? links(response, item.creator) : null,
      candidates: item.candidates.map(candidate => links(response, candidate)),
      ...(!has(response, 'summary:read') ? { collectedWorkCount: null, readModel: { status: 'permission_denied', complete: false }, dataUpdatedAt: null } : {})
    });
    response.json({ ...context(response), batchStatus: items.some(item => 'error' in item) ? 'partial_failure' : 'complete', items });
  });
  router.use((_request, _response) => { throw new CompanionAccessError(404, 'COMPANION_ROUTE_NOT_FOUND', '未找到此只读接口。'); });
  router.use(((error, _request, response, next) => {
    if (error instanceof CompanionReadError) {
      response.status(error.status).json({ code: error.code, message: error.message, collectedWorkCount: null }); return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ code: 'INVALID_COMPANION_REQUEST', message: '只读查询参数不正确。', collectedWorkCount: null }); return;
    }
    next(error);
  }) satisfies express.ErrorRequestHandler);
  router.use(companionAccessErrors);
  return router;
}
