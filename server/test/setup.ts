import sharp from 'sharp';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { databaseManager } from '../src/db/database.js';

sharp.cache(false);

beforeEach(() => {
  databaseManager.close();
});

afterEach(() => {
  databaseManager.close();
});

afterAll(() => {
  databaseManager.close();
});
