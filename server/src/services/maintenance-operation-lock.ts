export const PERMANENT_DELETION_QUARANTINE_DIRECTORY_NAME = '.foldergram-delete-quarantine';

class MaintenanceOperationLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const maintenanceOperationLock = new MaintenanceOperationLock();
