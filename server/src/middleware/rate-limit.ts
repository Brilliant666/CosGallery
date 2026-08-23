import type { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

export function createRateLimiter(options: RateLimitOptions) {
  const store = new Map<string, RateLimitInfo>();

  // Periodically clean up expired entries to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, info] of store.entries()) {
      if (now > info.resetTime) {
        store.delete(ip);
      }
    }
  }, options.windowMs);

  // Ensure the interval doesn't prevent the process from exiting
  cleanupInterval.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const info = store.get(ip);

    if (!info || now > info.resetTime) {
      store.set(ip, {
        count: 1,
        resetTime: now + options.windowMs
      });
      next();
      return;
    }

    info.count++;

    if (info.count > options.max) {
      res.status(429).json({
        message: options.message || 'Too many requests, please try again later.'
      });
      return;
    }

    next();
  };
}
