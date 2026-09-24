import { requestJson } from './http';

export interface ApplicationRecoveryPoint {
  id: string;
  status: 'success';
  reason: string;
  startedAt: string;
  completedAt: string;
  schemaVersions: string[];
  codeVersion: string;
  instanceId: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  configuration: { complete: boolean; gaps: string[] };
  validation: { integrity: 'ok'; foreignKeys: number; tables: unknown };
  timings: { backupMs: number; validationMs: number; totalMs: number };
  bytes: number;
}
export interface ApplicationRecoveryStatus {
  backupRoot: string;
  automatic: { enabled: boolean; intervalHours: number; retainDaily: number; retainWeekly: number };
  active: { id: string; startedAt: string; reason: string } | null;
  latestSuccess: ApplicationRecoveryPoint | null;
  lastFailure: { at: string; code: string; message: string } | null;
  points: ApplicationRecoveryPoint[];
}
const endpoint = '/api/admin/recovery-points';
export function fetchApplicationRecoveryStatus() {
  return requestJson<ApplicationRecoveryStatus>(endpoint);
}
export function createApplicationRecoveryPoint() {
  return requestJson<ApplicationRecoveryStatus>(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
}
