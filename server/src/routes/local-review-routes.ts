import { Router } from 'express';
import { z } from 'zod';
import { LocalReviewError, LocalReviewWebService, localReviewTargetSchema } from '../services/local-review-web-service.js';

/** Mounted by the parent router behind canManageLibrary and the existing CSRF middleware. */
export function createLocalReviewRouter(service?: LocalReviewWebService) {
  const router = Router(), current = () => service ?? new LocalReviewWebService();
  const id = z.coerce.number().int().positive(), key = z.string().min(1).max(120);
  router.get('/target', (req, res) => {
    const creatorId = id.parse(req.query.creatorId);
    const target = localReviewTargetSchema.parse(req.query.kind === 'stage3'
      ? { kind: 'stage3', jobId: id.parse(req.query.jobId) }
      : { kind: 'admission', planId: req.query.planId, itemKey: req.query.itemKey });
    res.json(current().target(target, creatorId));
  });
  router.post('/sessions', (req, res) => { res.status(202).json(current().create(req.body)); });
  router.get('/sessions/:id', (req, res) => { res.json(current().get(key.parse(req.params.id))); });
  router.get('/sessions/:id/files', (req, res) => {
    res.json(current().files(key.parse(req.params.id), { page: req.query.page ? id.parse(req.query.page) : undefined,
      limit: req.query.limit ? id.max(100).parse(req.query.limit) : undefined, issuesOnly: req.query.issuesOnly === 'true' }));
  });
  router.post('/sessions/:id/execute', (req, res) => { res.status(202).json(current().execute(key.parse(req.params.id), req.body)); });
  router.post('/sessions/:id/retry', (req, res) => {
    const body = z.object({ requestKey: key }).strict().parse(req.body);
    res.status(202).json(current().retry(key.parse(req.params.id), body.requestKey));
  });
  router.use((error: unknown, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ ok: false, code: 'INVALID_REQUEST', message: 'Invalid review input.' }); return; }
    if (!(error instanceof LocalReviewError)) { next(error); return; }
    res.status(409).json({ ok: false, code: 'LOCAL_REVIEW_BLOCKED', message: error.message });
  });
  return router;
}
