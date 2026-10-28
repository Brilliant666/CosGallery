import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { isolatedTestEnvironment } from '../scripts/test-environment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isolatedDefaultDataRoot = path.join(os.tmpdir(), `foldergram-vitest-${process.pid}`);

export default defineConfig({
  root: __dirname,
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Explicit storage/config overrides also replace paths inherited from an IDE
    // or shell; individual tests can still install their own synthetic fixtures.
    env: isolatedTestEnvironment(isolatedDefaultDataRoot),
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1
  }
});
