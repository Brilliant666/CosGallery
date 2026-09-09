import express from 'express';
import { z } from 'zod';
import { CreatorSyncQueryService } from '../services/creator-sync-query-service.js';

// Both authenticated clients use exactly the same filters and complete-count queries.
const filters = z.object({
  q: z.string().trim().max(200).optional(),
  preference: z.enum(['all', 'liked', 'kept', 'unset']).default('all'),
  rating: z.enum(['all', 'R15', 'R18', 'unclassified']).default('all'),
  enabled: z.enum(['all', 'enabled', 'disabled']).default('enabled'),
  local: z.enum(['all', 'present', 'absent']).default('all'),
  source: z.enum(['all', 'present', 'absent']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
const downloads = filters.extend({
  status: z.enum(['pending', 'claimed', 'staged', 'downloading', 'downloaded', 'ingested', 'failed', 'cancelled']).optional()
});

export function createCreatorSyncReadRouter() {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/creator-sync/roster', (request, response) => {
    response.json(new CreatorSyncQueryService().roster(filters.parse(request.query)));
  });
  router.get('/creator-sync/stats', (request, response) => {
    response.json(new CreatorSyncQueryService().stats(filters.parse(request.query)));
  });
  router.get('/creator-sync/metadata-creators', (request, response) => {
    response.json(new CreatorSyncQueryService().metadataCreators(filters.extend({
      status: z.enum(['pending', 'claimed', 'completed', 'not_found', 'failed', 'cancelled', 'no_task']).optional()
    }).parse(request.query)));
  });
  router.get('/download-creators', (request, response) => {
    response.json(new CreatorSyncQueryService().downloadCreators(downloads.parse(request.query)));
  });
  router.get('/download-task-page', (request, response) => {
    response.json(new CreatorSyncQueryService().downloadTaskPage(downloads.extend({
      creatorId: z.coerce.number().int().positive()
    }).parse(request.query)));
  });
  return router;
}
