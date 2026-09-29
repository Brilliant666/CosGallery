import { Router } from 'express';
import { z } from 'zod';
import { requireCapability } from '../middleware/auth-protection.js';
import {
  MediaTrashError,
  MediaTrashService,
} from '../services/media-trash-service.js';
import { storageService } from '../services/storage-service.js';

export function createMediaTrashRouter() {
  const router = Router();
  const access = requireCapability(
    'canDeleteMedia',
    'Admin access is required.',
  );
  const ids = z.object({
    postId: z.coerce.number().int().positive(),
    mediaId: z.coerce.number().int().positive(),
  });
  function writable() {
    const state = storageService.getState();
    if (!state.libraryAvailable || state.usingInMemoryDatabase)
      throw new MediaTrashError(
        'STORAGE_UNAVAILABLE',
        '图库或持久数据库当前不可用。',
        503,
      );
  }
  router.get('/trash/media', access, (_req, res) =>
    res.json(new MediaTrashService().list()),
  );
  router.get('/trash/media/:mediaId/thumbnail', access, (req, res) => {
    const filename = new MediaTrashService().thumbnail(
      z.coerce.number().int().positive().parse(req.params.mediaId),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    if (!filename) {
      res.status(404).end();
      return;
    }
    res.sendFile(filename);
  });
  router.post(
    '/posts/:postId/media/:mediaId/trash',
    access,
    async (req, res, next) => {
      try {
        const target = ids.parse(req.params);
        const body = z
          .object({ confirmLastMedia: z.boolean().optional() })
          .strict()
          .parse(req.body ?? {});
        writable();
        res.json(
          await new MediaTrashService().trash(
            target.postId,
            target.mediaId,
            body.confirmLastMedia,
          ),
        );
      } catch (error) {
        if (error instanceof MediaTrashError)
          res
            .status(error.status)
            .json({ code: error.code, message: error.message });
        else next(error);
      }
    },
  );
  router.post(
    '/posts/:postId/media/:mediaId/restore',
    access,
    async (req, res, next) => {
      try {
        const target = ids.parse(req.params);
        writable();
        res.json(
          await new MediaTrashService().restore(target.postId, target.mediaId),
        );
      } catch (error) {
        if (error instanceof MediaTrashError)
          res
            .status(error.status)
            .json({ code: error.code, message: error.message });
        else next(error);
      }
    },
  );
  return router;
}
