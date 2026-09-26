import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Real Vite integration needs Node's native typed arrays / HTTP server, not the
// UI suite's jsdom globals. This suite uses only ephemeral synthetic fixtures.
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/dev-server-security.integration.ts']
  }
});
