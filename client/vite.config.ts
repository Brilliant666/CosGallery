import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv, type Plugin } from 'vite';
import UnoCSS from 'unocss/vite';
import vue from '@vitejs/plugin-vue';
import { vite as vidstack } from 'vidstack/plugins';

const appPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version: string };
const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, '..');
const DEV_CLIENT_PORT_RANGE_SIZE = 4;

function canListenOnPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();

    probe.once('error', () => {
      resolve(false);
    });

    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });

    probe.listen({
      port,
      host,
      exclusive: true
    });
  });
}

async function resolveDevClientPort(basePort: number, host: string): Promise<number> {
  for (let offset = 0; offset < DEV_CLIENT_PORT_RANGE_SIZE; offset += 1) {
    const candidatePort = basePort + offset;
    if (await canListenOnPort(candidatePort, host)) {
      return candidatePort;
    }
  }

  throw new Error(`No available Vite client port found in range ${basePort}-${basePort + DEV_CLIENT_PORT_RANGE_SIZE - 1}.`);
}

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, repositoryRoot, '');
  const backupRoot = path.resolve(repositoryRoot, env.BACKUP_ROOT ?? 'data_backup');
  const backupName = path.basename(backupRoot).toLowerCase();
  const devServerPort = Number.parseInt(env.DEV_SERVER_PORT ?? '4140', 10);
  const devClientPort = Number.parseInt(env.DEV_CLIENT_PORT ?? '4141', 10);
  const devHost = '0.0.0.0';
  const isVitest = process.env.VITEST === 'true';
  const resolvedDevClientPort = command === 'serve' && !isVitest ? await resolveDevClientPort(devClientPort, devHost) : devClientPort;

  return {
    envDir: repositoryRoot,
    define: {
      __APP_VERSION__: JSON.stringify(appPackage.version),
      __VUE_I18N_FULL_INSTALL__: JSON.stringify(true),
      __VUE_I18N_LEGACY_API__: JSON.stringify(false),
      __INTLIFY_PROD_DEVTOOLS__: JSON.stringify(false)
    },
    plugins: [
      {
        name: 'deny-private-recovery-files',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            let pathname: string;
            try { pathname = decodeURIComponent((request.url ?? '').split('?')[0]!).replace(/\\/g, '/').toLowerCase(); }
            catch { response.statusCode = 400; response.end(); return; }
            const backupUrl = pathname === `/${backupName}` || pathname.startsWith(`/${backupName}/`)
              || pathname.startsWith('/@fs/') && pathname.includes(backupRoot.replace(/\\/g, '/').toLowerCase());
            if (backupUrl || pathname.split('/').some(segment => segment === 'data_backup'
              || segment === 'private' || segment === '.run' || /^\.env(?:\.|$)/.test(segment)
              || /\.(?:key|pem|pfx|p12)$/.test(segment))) {
              response.statusCode = 404; response.end(); return;
            }
            next();
          });
        }
      } satisfies Plugin,
      UnoCSS(),
      vidstack({
        include: /src\/components\//
      }),
      vue({
        template: {
          compilerOptions: {
            isCustomElement: tag => tag.startsWith('media-')
          }
        }
      })
    ],
    resolve: {
      alias: {
        'vue-i18n': 'vue-i18n/dist/vue-i18n.esm-bundler.js'
      }
    },
    server: {
      fs: {
        strict: true,
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data_backup/**',
          '**/private/**', '**/.run/**', '**/*.{key,pfx,p12}', `${backupRoot.replace(/\\/g, '/')}/**`]
      },
      host: devHost,
      port: resolvedDevClientPort,
      proxy: {
        '/api': `http://localhost:${devServerPort}`,
        '/thumbnails': `http://localhost:${devServerPort}`,
        '/previews': `http://localhost:${devServerPort}`
      }
    },
    test: {
      environment: 'jsdom',
      setupFiles: './vitest.setup.ts',
      css: true
    }
  };
});
