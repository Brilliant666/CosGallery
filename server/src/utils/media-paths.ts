import { appConfig } from '../config/env.js';
import { safeJoin } from './path-utils.js';

export function resolveOriginalPath(relativePath: string): string {
  return safeJoin(appConfig.galleryRoot, relativePath);
}
