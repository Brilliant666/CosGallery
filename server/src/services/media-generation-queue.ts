import pLimit from 'p-limit';
import { appConfig } from '../config/env.js';

// Thumbnail, preview and reel remux work share one bounded admission queue.
export const mediaGenerationLimit = pLimit(appConfig.scanDerivativeConcurrency);
