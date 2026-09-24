import { createApplicationRecoveryService } from '../services/application-recovery-service.js';

const command = process.argv[2] ?? 'status';
if (!['status', 'create'].includes(command) || process.argv.length > 3) {
  console.error('Usage: recovery-point [status|create]. Target and source come only from application configuration.');
  process.exitCode = 1;
} else {
  try {
    const service = createApplicationRecoveryService();
    console.log(JSON.stringify(command === 'create' ? await service.create('maintenance') : service.getStatus(), null, 2));
  } catch {
    console.error('Recovery point operation failed. See the configured backup status; no restore or migration was performed.');
    process.exitCode = 1;
  }
}
