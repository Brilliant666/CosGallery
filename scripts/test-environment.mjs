import path from 'node:path';

// Return overrides before importing application modules. Never inspect the
// caller's configuration or allow inherited storage paths to beat DATA_ROOT.
export function isolatedTestEnvironment(root, { nodeEnv = 'test' } = {}) {
  if (!path.isAbsolute(root)) throw new Error('A test environment requires an absolute fixture root.');
  if (nodeEnv !== 'test' && nodeEnv !== 'production') throw new Error('Unsupported test environment mode.');
  const dataRoot = path.resolve(root);
  return {
    NODE_ENV: nodeEnv,
    DATA_ROOT: dataRoot,
    DATA_DIR: dataRoot,
    DB_DIR: path.join(dataRoot, 'db'),
    GALLERY_ROOT: path.join(dataRoot, 'gallery'),
    THUMBNAILS_DIR: path.join(dataRoot, 'thumbnails'),
    PREVIEWS_DIR: path.join(dataRoot, 'previews'),
    BACKUP_ROOT: path.join(dataRoot, 'recovery-points'),
    APP_ENV_FILE: path.join(dataRoot, 'test.env'),
    APP_RUN_CONFIG_FILE: path.join(dataRoot, 'test.run.xml'),
    BACKUP_AUTO_ENABLED: 'false',
    LOCAL_INGEST_STARTUP_SCAN: 'false',
    LOCAL_INGEST_ARCHIVE_PASSWORD: ''
  };
}
