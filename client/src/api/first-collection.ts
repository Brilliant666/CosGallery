import { requestJson } from './http';
import type { ArchiveMetadataTask, ArchiveSourceState } from '../types/api';

const root = '/api/admin/archive-catalog/metadata-tasks';
export interface FirstCollectionCandidate {
  creatorId: number; creatorName: string; aliases: string[];
  preference: 'liked' | 'kept' | null; rating: 'R15' | 'R18' | null;
  isActive: boolean; localWorks: number; sourceState: ArchiveSourceState;
  task: ArchiveMetadataTask | null;
}
export interface FirstCollectionCandidates {
  items: FirstCollectionCandidate[]; total: number; page: number; limit: number; pages: number;
}
export interface FirstCollectionResult {
  requestId?: string;
  replayed?: boolean;
  items: Array<{
    creatorId: number; creatorName: string;
    result: 'created' | 'reused' | 'claimed' | 'replayed' | 'source_ready' | 'delivery_required' | 'retry_required' | 'inactive';
    task: ArchiveMetadataTask | null;
  }>;
  taskIds: number[];
}
export function fetchFirstCollectionCandidates(options: {
  q: string; page: number; limit: number; active: 'active' | 'inactive' | 'all'; hasSource: 'yes' | 'no' | 'all';
}) {
  return requestJson<FirstCollectionCandidates>(`${root}/candidates?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]))}`);
}
export function planFirstCollection(creatorIds: number[], requestId: string) {
  if (!creatorIds.length || creatorIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return Promise.reject(new Error('请明确选择合法的博主 ID，空范围不能提交。'));
  }
  if (!requestId) return Promise.reject(new Error('缺少本次检查请求标识，未创建任务。'));
  return requestJson<FirstCollectionResult>(`${root}/plan-selected`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creatorIds: [...new Set(creatorIds)], requestId })
  });
}

export function sourceStateLabel(state?: ArchiveSourceState) {
  if (!state) return '历史记录，尚未核验';
  if (!state.metadataAccepted) return '尚无 Costuan 来源';
  if (!state.deliveryReady) return `元数据已接入，网盘来源待确认${state.missing.length ? `：${state.missing.join('；')}` : ''}`;
  return state.deliveryEvidence === 'verified' ? '元数据已接入，网盘来源已核验' : '元数据已接入，历史转存记录可用（尚未实时核验）';
}
