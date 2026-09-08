import express from 'express';
import { z } from 'zod';

import { ArchiveBridgeService, isLoopbackAddress } from '../services/archive-bridge-service.js';
import {
  ArchiveDownloadTaskService,
  type ArchiveDownloadTaskStatus
} from '../services/archive-download-task-service.js';
import {
  ArchiveMetadataTaskService,
  type ArchiveMetadataTaskStatus
} from '../services/archive-metadata-task-service.js';
import { ArchiveCatalogPipelineService } from '../services/archive-catalog-pipeline-service.js';
import { createCreatorSyncReadRouter } from './creator-sync-read-routes.js';

const router = express.Router();
const TOKEN_HEADER = 'x-cosgallery-bridge-token';
const taskStatusSchema = z.enum([
  'pending',
  'claimed',
  'staged',
  'downloading',
  'downloaded',
  'ingested',
  'failed',
  'cancelled'
]);
const listQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  creatorId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
const claimBodySchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(500).default(500),
  seedTaskId: z.coerce.number().int().positive().optional()
});
const updateBodySchema = z.object({
  status: taskStatusSchema,
  workerId: z.string().trim().min(1).max(120).optional(),
  downloadId: z.union([z.string().trim().max(160), z.null()]).optional(),
  error: z.union([z.string().trim().max(1000), z.null()]).optional()
});
const idSchema = z.object({ id: z.coerce.number().int().positive() });
const metadataListQuerySchema = z.object({
  status: z.enum(['pending', 'claimed', 'completed', 'not_found', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  page: z.coerce.number().int().positive().default(1)
});
const metadataClaimBodySchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  taskIds: z.array(z.number().int().positive()).min(1).max(500),
  rounds: z.array(z.object({ taskId: z.number().int().positive(), checkRoundId: z.string().trim().min(1).max(120) }).strict()).min(1).max(500).optional()
}).strict();
const metadataResultBodySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    workerId: z.string().trim().min(1).max(120),
    record: z.record(z.unknown()),
    canonicalCreatorId:z.number().int().positive().optional(),
    receiptId:z.string().trim().min(1).max(120).optional(),
    expectedAttempt:z.number().int().positive().optional()
  }),
  z.object({
    status: z.enum(['not_found', 'failed', 'pending']),
    workerId: z.string().trim().min(1).max(120),
    error: z.union([z.string().trim().max(1000), z.null()]).optional(),
    expectedAttempt:z.number().int().positive().optional()
  })
]);

router.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', `Content-Type, ${TOKEN_HEADER}`);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  next();
});

router.use((request, response, next) => {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    response.status(403).json({ message: 'Archive bridge is available only on loopback.' });
    return;
  }
  const service = new ArchiveBridgeService();
  if (!service.verifyToken(request.get(TOKEN_HEADER) ?? '')) {
    response.status(401).json({ message: 'Invalid archive bridge token.' });
    return;
  }
  next();
});

router.get('/ping', (_request, response) => {
  response.json({ ok: true, service: 'cosgallery-archive-bridge', version: 4, capabilities:{rosterFirstCollectionV1:true, unifiedCreatorSyncV1:true} });
});

router.use(createCreatorSyncReadRouter());
router.post('/creator-sync/checks', (request, response) => {
  const body = z.object({ creatorIds: z.array(z.number().int().positive()).min(1).max(500),
    requestId: z.string().trim().min(1).max(120), retry: z.boolean().optional() }).strict().parse(request.body);
  response.json(new ArchiveMetadataTaskService().planSelected(body));
});

router.get('/metadata-tasks', (request, response) => {
  const query = metadataListQuerySchema.parse(request.query);
  const service = new ArchiveMetadataTaskService();
  response.json(service.list({
    source: 'costuan',
    status: query.status as ArchiveMetadataTaskStatus | undefined,
    limit: query.limit,
    page:query.page
  }));
});

router.post('/metadata-tasks/claim', (request, response) => {
  const body = metadataClaimBodySchema.parse(request.body);
  const service = new ArchiveMetadataTaskService();
  response.json({ items: service.claim({ ...body, source: 'costuan' }) });
});

router.patch('/metadata-tasks/:id', (request, response) => {
  const params = idSchema.parse(request.params);
  const body = metadataResultBodySchema.parse(request.body);
  const service = new ArchiveMetadataTaskService();
  if (body.status === 'completed') {
    response.json({ ok: true, ...service.complete({
      id: params.id,
      workerId: body.workerId,
      record: body.record,
      canonicalCreatorId:body.canonicalCreatorId,receiptId:body.receiptId,expectedAttempt:body.expectedAttempt
    }) });
    return;
  }
  response.json({ ok: true, task: service.report({
    id: params.id,
    workerId: body.workerId,
    status: body.status,
    error: body.error,expectedAttempt:body.expectedAttempt
  }) });
});

router.post('/metadata-tasks/:id/validate-source', (request,response) => {
  const {id}=idSchema.parse(request.params);
  const body=z.object({workerId:z.string().trim().min(1).max(120),canonicalCreatorId:z.number().int().positive(),
    postId:z.string().trim().min(1).max(255),title:z.string().trim().min(1).max(1000),expectedAttempt:z.number().int().positive().optional()}).strict().parse(request.body);
  response.json({ok:true,task:new ArchiveMetadataTaskService().validateSource({id,...body})});
});

router.post('/metadata-tasks/:id/validate-directory', (request, response) => {
  const { id } = idSchema.parse(request.params);
  const body = z.object({ workerId:z.string().trim().min(1).max(120), canonicalCreatorId:z.number().int().positive(),
    expectedAttempt:z.number().int().positive(), record:z.record(z.unknown()) }).strict().parse(request.body);
  response.json({ ok:true, ...new ArchiveMetadataTaskService().validateDirectory({id,...body}) });
});

router.post('/metadata-tasks/finalize-selected', async (request, response) => {
    const body=z.object({workerId:z.string().trim().min(1).max(120),creatorIds:z.array(z.number().int().positive()).min(1).max(500),
      taskIds:z.array(z.number().int().positive()).min(1).max(500),
      attempts:z.array(z.object({taskId:z.number().int().positive(),expectedAttempt:z.number().int().positive()}).strict()).min(1).max(500).optional()}).strict().parse(request.body);
    const catalog=await new ArchiveMetadataTaskService().finalizeSelected(body,
      creatorIds=>new ArchiveCatalogPipelineService().refreshAfterMetadataTasks({creatorIds}));
    response.json({ok:true,catalog});
});

router.post('/metadata-tasks/finalize', (_request, response) => {
  response.status(410).json({ message: 'Unscoped finalization is retired. Use finalize-selected with explicit tasks and accepted attempts.' });
});

router.get('/download-tasks', (request, response) => {
  const query = listQuerySchema.parse(request.query);
  const service = new ArchiveDownloadTaskService();
  response.json(service.list({
    status: query.status as ArchiveDownloadTaskStatus | undefined,
    creatorId: query.creatorId,
    limit: query.limit
  }));
});

router.post('/download-tasks/claim', (request, response) => {
  const body = claimBodySchema.parse(request.body);
  const service = new ArchiveDownloadTaskService();
  response.json({ items: service.claim(body) });
});

router.patch('/download-tasks/:id', (request, response) => {
  const params = idSchema.parse(request.params);
  const body = updateBodySchema.parse(request.body);
  const service = new ArchiveDownloadTaskService();
  const task = service.update(params.id, {
    status: body.status,
    workerId: body.workerId,
    downloadId: body.downloadId,
    error: body.error
  });
  if (!task) {
    response.status(404).json({ message: 'Archive download task not found.' });
    return;
  }
  response.json({ ok: true, task });
});

export { router as archiveBridgeRouter };
