import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import {
  WorkRemovalError,
  WorkRemovalService,
} from '../services/work-removal-service.js';
import { requireCapability } from '../middleware/auth-protection.js';
export function createWorkRemovalRouter() {
  const router = Router();
  const service = new WorkRemovalService();
  const id = z.coerce.number().int().positive();
  const access = requireCapability('canDeleteMedia');
  router.get('/trash/works', access, (_req, res) =>
    res.json(service.listTrash()),
  );
  router.post(
    '/works/:workId/removal-preview',
    access,
    async (req, res, next) => {
      try {
        const input = z
          .object({
            mode: z.enum(['trash', 'permanent', 'restore']),
            revision: z.string().optional(),
            revisionScope: z.enum(['all', 'creator']).optional(),
          })
          .parse(req.body);
        res.json(
          await service.preview(
            id.parse(req.params.workId),
            input.mode,
            input.revision,
            input.revisionScope,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.post('/works/:workId/removal', access, async (req, res, next) => {
    try {
      const input = z
        .object({ previewToken: z.string().uuid() })
        .parse(req.body);
      res.json(
        await service.execute(id.parse(req.params.workId), input.previewToken),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get(
    '/work-removal-operations/:operationId',
    access,
    (req, res, next) => {
      try {
        res.json(
          service.status(z.string().uuid().parse(req.params.operationId)),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/work-removal-operations/:operationId/retry',
    access,
    async (req, res, next) => {
      try {
        res.json(
          await service.retry(z.string().uuid().parse(req.params.operationId)),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof WorkRemovalError)
      res
        .status(error.status)
        .json({ code: error.code, message: error.message });
    else if (error instanceof z.ZodError)
      res
        .status(400)
        .json({ code: 'INVALID_REMOVAL_REQUEST', message: '请求参数无效。' });
    else next(error);
  };
  router.use(errors);
  return router;
}
