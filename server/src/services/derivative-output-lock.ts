import { MaintenanceOperationLock } from './maintenance-operation-lock.js';

// Publication and serving coordinate per output, without holding the global
// maintenance lease for hot files. Entries live only while operations use them.
const locks = new Map<string, { lock: MaintenanceOperationLock; users: number }>();

async function withOutput<T>(output: string, write: boolean, operation: () => Promise<T>): Promise<T> {
  let entry = locks.get(output);
  if (!entry) {
    entry = { lock: new MaintenanceOperationLock(), users: 0 };
    locks.set(output, entry);
  }
  entry.users += 1;
  try {
    return await (write ? entry.lock.runExclusive(operation) : entry.lock.runGeneration(operation));
  } finally {
    entry.users -= 1;
    if (entry.users === 0) locks.delete(output);
  }
}

export const withDerivativeOutputRead = <T>(output: string, operation: () => Promise<T>) => withOutput(output, false, operation);
export const withDerivativeOutputWrite = <T>(output: string, operation: () => Promise<T>) => withOutput(output, true, operation);
