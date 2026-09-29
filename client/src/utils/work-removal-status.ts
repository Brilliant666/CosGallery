import type { WorkRemovalResult } from '../api/work-removal';

export function workRemovalStatusKey(result: WorkRemovalResult): string {
  if (result.recoveryPending || result.state === 'recovery_pending')
    return 'workRemoval.recoveryPending';
  if (
    result.cleanupPending ||
    result.state === 'cleanup_pending' ||
    result.state === 'committed'
  )
    return 'workRemoval.pending';
  if (result.state === 'failed') return 'workRemoval.rolledBack';
  return result.state === 'completed'
    ? 'workRemoval.completed'
    : 'workRemoval.processing';
}
