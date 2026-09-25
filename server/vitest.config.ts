import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isolatedDefaultDataRoot = path.join(os.tmpdir(), `foldergram-vitest-${process.pid}`);

export default defineConfig({
  root: __dirname,
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    env: {
      // Tests that do not install a more specific fixture still default to an
      // isolated temp root, never the repository's production ./data folder.
      DATA_ROOT: isolatedDefaultDataRoot,
      APP_ENV_FILE: path.join(isolatedDefaultDataRoot, 'test.env'),
      APP_RUN_CONFIG_FILE: path.join(isolatedDefaultDataRoot, 'test.run.xml'),
      BACKUP_ROOT: path.join(isolatedDefaultDataRoot, 'recovery-points')
    },
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1
  }
});
