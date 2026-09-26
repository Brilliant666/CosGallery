import express from 'express';
import { z } from 'zod';
import { CompanionGrantService, CompanionAccessError } from '../services/companion-grant-service.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

/** Mounted only inside ordinary admin authentication, capability and CSRF. */
export function createCompanionGrantRouter(service = () => new CompanionGrantService()) {
  const router = express.Router();
  router.use(createRateLimiter({ windowMs: 60_000, max: 30 }));
  router.get('/', (_request, response) => { response.json(service().list()); });
  router.post('/', (request, response) => { response.status(201).json(service().create(request.body)); });
  router.delete('/:id', (request, response) => {
    response.json(service().revoke(z.string().uuid().parse(request.params.id)));
  });
  router.use(companionAccessErrors);
  return router;
}

export const companionAccessErrors: express.ErrorRequestHandler = (error, _request, response, next) => {
  if (!(error instanceof CompanionAccessError)) { next(error); return; }
  response.status(error.status).json({ code: error.code, message: error.message, collectedWorkCount: null });
};
