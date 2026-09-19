import { Router } from 'express';
import { z } from 'zod';
import {
  ResourceCatalogError,
  ResourceCatalogService,
} from '../services/resource-catalog-service.js';
export function createResourceCatalogRouter() {
  const router = Router();
  const service = new ResourceCatalogService();
  const id = z.coerce.number().int().positive();
  const filters = z.object({
    q: z.string().max(500).optional(),
    localState: z
      .enum(['all', 'indexed', 'unavailable', 'unarranged'])
      .optional(),
    source: z.enum(['all', 'linked', 'unlinked']).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  });
  router.get('/creators', (req, res, next) => {
    try {
      res.json(
        service.searchCreators(
          z
            .string()
            .max(500)
            .parse(req.query.q ?? ''),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get('/:creatorId/export', (req, res, next) => {
    try {
      const creatorId = id.parse(req.params.creatorId);
      const format = z.enum(['txt', 'csv']).parse(req.query.format);
      const scope = z.enum(['all', 'filtered']).parse(req.query.scope);
      const filter = filters
        .extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(req.query);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="cosgallery-creator-${creatorId}.${format}"`,
      );
      res
        .type(
          format === 'txt'
            ? 'text/plain; charset=utf-8'
            : 'text/csv; charset=utf-8',
        )
        .send(service.export(creatorId, format, scope, filter));
    } catch (error) {
      next(error);
    }
  });
  router.get('/:creatorId/works/:workId', (req, res, next) => {
    try {
      res.json(
        service.detail(
          id.parse(req.params.creatorId),
          id.parse(req.params.workId),
          filters.parse(req.query).revision,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get('/:creatorId', (req, res, next) => {
    try {
      res.json(
        service.list(id.parse(req.params.creatorId), filters.parse(req.query)),
      );
    } catch (error) {
      next(error);
    }
  });
  router.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (error instanceof ResourceCatalogError) {
        res
          .status(error.status)
          .json({
            error: error.message,
            message: error.message,
            code: error.code,
          });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({
            error: '无效的目录读取参数。',
            code: 'INVALID_RESOURCE_CATALOG_INPUT',
          });
        return;
      }
      next(error);
    },
  );
  return router;
}
