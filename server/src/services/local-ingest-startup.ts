export interface LocalIngestStartupDependencies {
  scanEnabled: boolean;
  recoverInterruptedJobs: () => Promise<number>;
  getAllowlist: () => readonly string[];
  scanInbox: () => Promise<unknown>;
  logInfo: (message: string) => void;
}

/** Runtime-only switch: never rewrites the saved allowlist or disables manual discovery. */
export async function runLocalIngestStartup(dependencies: LocalIngestStartupDependencies): Promise<void> {
  const recovered = await dependencies.recoverInterruptedJobs();
  if (recovered > 0) {
    dependencies.logInfo(`Marked ${recovered} interrupted local ingest job(s) as safely resumable`);
  }
  if (!dependencies.scanEnabled) {
    dependencies.logInfo('Local ingest startup compensation scan skipped (LOCAL_INGEST_STARTUP_SCAN=false)');
    return;
  }
  if (dependencies.getAllowlist().length > 0) await dependencies.scanInbox();
}
