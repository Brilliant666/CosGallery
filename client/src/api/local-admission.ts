import { requestJson } from './http';
import type { AdmissionBatch, AdmissionDirectories, AdmissionExecuteInput, AdmissionItem, AdmissionPage, AdmissionPreviewInput, AdmissionResumeInput, AdmissionSettings, AdmissionWork } from '../types/local-admission';

const root = '/api/admin/local-admission';
const id = (value: string) => encodeURIComponent(value);
const send = <T>(path: string, input: unknown, method = 'POST') => requestJson<T>(`${root}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
export const fetchAdmissionSettings = () => requestJson<AdmissionSettings>(`${root}/settings`);
export const saveAdmissionSettings = (waitingRoot: string) => send<AdmissionSettings>('/settings', { waitingRoot }, 'PUT');
export const fetchAdmissionDirectories = (creatorId: number, parent?: string) => requestJson<AdmissionDirectories>(`${root}/directories?${new URLSearchParams({ creatorId: String(creatorId), ...(parent ? { parent } : {}) })}`);
export const createAdmissionPreview = (input: AdmissionPreviewInput) => send<AdmissionBatch>('/previews', input);
export const fetchAdmissionBatches = (creatorId: number, page = 1) => requestJson<AdmissionPage<AdmissionBatch>>(`${root}/batches?creatorId=${creatorId}&page=${page}&pageSize=20`);
export const fetchAdmissionBatch = (batchId: string) => requestJson<AdmissionBatch>(`${root}/batches/${id(batchId)}`);
export const fetchAdmissionItems = (batchId: string, page = 1, pageSize = 50) => requestJson<AdmissionPage<AdmissionItem>>(`${root}/batches/${id(batchId)}/items?page=${page}&pageSize=${pageSize}`);
export const executeAdmission = (batchId: string, input: AdmissionExecuteInput) => send<AdmissionBatch>(`/batches/${id(batchId)}/execute`, input);
export const resumeAdmission = (batchId: string, input: AdmissionResumeInput) => send<AdmissionBatch>(`/batches/${id(batchId)}/resume`, input);
export const repreviewAdmission = (batchId: string, keys?: string[]) => send<AdmissionBatch>(`/batches/${id(batchId)}/repreview`, keys ? { keys } : {});
export const fetchAdmissionWorks = (creatorId: number, q: string, page = 1) => requestJson<AdmissionPage<AdmissionWork>>(`${root}/works?${new URLSearchParams({ creatorId: String(creatorId), q, page: String(page), pageSize: '20' })}`);
