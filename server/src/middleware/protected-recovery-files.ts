import path from 'node:path';
import type { RequestHandler } from 'express';
import { appConfig } from '../config/env.js';

export function denyRecoveryFileRequests(backupRoot = appConfig.backupRoot): RequestHandler {
  const backupName = path.basename(backupRoot).toLowerCase();
  return (request, response, next) => {
    let pathname: string;
    try { pathname = decodeURIComponent(request.path).replace(/\\/g, '/').toLowerCase(); }
    catch { response.status(400).end(); return; }
    const segments = pathname.split('/');
    const backupUrl = pathname === `/${backupName}` || pathname.startsWith(`/${backupName}/`);
    if (backupUrl || segments.some(segment => segment === 'data_backup'
      || segment === '.run' || segment === 'private' || /^\.env(?:\.|$)/.test(segment)
      || /\.(?:key|pem|pfx|p12)$/.test(segment))) {
      response.status(404).end();
      return;
    }
    next();
  };
}
