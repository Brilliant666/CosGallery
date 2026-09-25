import express from 'express';
import { createApplicationRecoveryService } from '../services/application-recovery-service.js';

export function createApplicationRecoveryRouter() {
  const router = express.Router();
  router.get('/', (_request, response) => {
    try { response.json(createApplicationRecoveryService().getStatus()); }
    catch { response.status(503).json({ code: 'RECOVERY_CONFIGURATION_UNAVAILABLE', message: '恢复点配置或状态无法读取；现有恢复点和业务数据保持。' }); }
  });
  router.post('/', (request, response) => {
    if (request.body !== undefined && (request.body === null || typeof request.body !== 'object'
      || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
      response.status(400).json({ code: 'RECOVERY_FIXED_TARGET', message: 'Recovery points use the configured target; send an empty object.' });
      return;
    }
    try {
      const service = createApplicationRecoveryService();
      const status = service.getStatus();
      if (status.active) { response.status(202).json(status); return; }
      void service.create('manual').catch(() => { /* A safe failure is persisted by the core for subsequent GET. */ });
      response.status(202).json(service.getStatus());
    } catch { response.status(503).json({ code: 'RECOVERY_CONFIGURATION_UNAVAILABLE', message: '恢复点配置无法读取；未执行高风险操作。' }); }
  });
  return router;
}
