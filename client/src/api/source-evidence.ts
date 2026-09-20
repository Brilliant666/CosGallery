import { requestJson } from './http';

export interface SourceEvidenceEntry {
  key: string;
  lineNumber: number;
  raw: string;
  state: 'candidate' | 'range' | 'unknown' | 'conflict';
  title: string;
  sourceOrder?: string;
  range?: { first: number; last: number; count: number };
  diagnostics: string[];
}
export interface SourceEvidenceLink {
  id: number;
  observationId: number;
  creatorId: number;
  workId: number;
  localWorkId: number | null;
  planId: string | null;
  itemKey: string | null;
  key: string;
  reason: string;
  entryKey: string | null;
  createdAt: string;
  kind: 'batch' | 'exact';
  sourceWorkId: number | null;
  identityDecisionId: number | null;
}
export interface SourceEvidenceObservation {
  id: number;
  platform: string;
  pageKey: string;
  pageUrl: string;
  pageTitle: string;
  method: string;
  observedAt: string;
  createdAt: string;
  candidateCreatorId: number;
  creatorId: number | null;
  identityState: 'confirmed' | 'candidate' | 'conflict';
  identityRevision: number;
  identityReason: string;
  rawDirectoryText: string;
  notes: string;
  resourceEntries: Array<{ url: string; label: string }>;
  diagnostics: string[];
  completeness: 'partial' | 'unknown';
  parsedEntries: SourceEvidenceEntry[];
  links: SourceEvidenceLink[];
  entryMappings: SourceEvidenceLink[];
}
export interface SourceEvidencePage {
  items: SourceEvidenceObservation[];
  total: number;
  page: number;
  limit: number;
}
export interface SaveSourceEvidenceInput {
  creatorId: number;
  requestId: string;
  record: {
    platform: string;
    pageUrl: string;
    pageTitle: string;
    method: 'manual';
    rawDirectoryText: string;
    notes: string;
    resourceEntries: Array<{ url: string; label: string }>;
    completeness: 'partial' | 'unknown';
  };
}
export interface ConfirmSourceEvidenceInput {
  creatorId: number;
  requestId: string;
  reason: string;
  expectedRevision: number;
}
export interface LinkSourceEvidenceInput {
  creatorId: number;
  workId: number;
  localWorkId?: number;
  key: string;
  reason: string;
  entryKey?: string;
}
export interface MapSourceEvidenceEntryInput {
  creatorId: number;
  entryKey: string;
  workId: number;
  sourceWorkId?: number;
  key: string;
  reason: string;
}

const secretField = /^(?:pwd|password|passcode|passwd|token|access_token|refresh_token|auth|authorization|cookie|session|sessionid|bdstoken|bduss|stoken|sekey|randsk|surl_password|提取码|解压密码|密码)$/iu;
export function assertSafeSourceEvidenceText(...fields: string[]) {
  const credential = /(?:cookie|authorization|access[_-]?token|refresh[_-]?token|bdstoken|bduss|stoken|password|passwd|提取码|解压密码|密码)\s*(?:[:=：]\s*|\s+)\S+/iu;
  if (fields.some(value => credential.test(value))) throw new Error('资料中包含疑似会话凭据、提取码或密码；请移除后保存，分享凭据继续使用原受保护通道。');
  for (const url of fields.flatMap(value => value.match(/https?:\/\/[^\s<>]+/giu) ?? [])) assertPublicLocation(url);
}
function assertPublicLocation(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('来源位置需要完整的 HTTP / HTTPS URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('来源位置只允许 HTTP / HTTPS');
  const hasSecret = [...parsed.searchParams.keys()].some(name => secretField.test(name));
  const hashParams = new URLSearchParams(parsed.hash.slice(1).replace(/^.*?\?/u, ''));
  if (parsed.username || parsed.password || hasSecret || [...hashParams.keys()].some(name => secretField.test(name))) throw new Error('来源链接含认证信息、提取码或令牌；请先移除敏感参数，不能保存在普通来源资料中。');
}
/** Refuse obvious session/share credentials before a draft can enter browser retry storage. */
export function assertSafeSourceEvidenceInput(input: SaveSourceEvidenceInput) {
  const fields = [input.record.pageTitle, input.record.rawDirectoryText, input.record.notes, ...input.record.resourceEntries.map(entry => entry.label)];
  assertSafeSourceEvidenceText(...fields);
  for (const url of [input.record.pageUrl, ...input.record.resourceEntries.map(entry => entry.url)]) assertPublicLocation(url);
}

const root = '/api/admin/archive-catalog/source-evidence';
function post<T>(url: string, input: unknown) {
  return requestJson<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
function positiveId(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('需要明确的正整数 ID');
  return id;
}
export const fetchSourceEvidence = (creatorId: number, page = 1) => requestJson<SourceEvidencePage>(`${root}?creatorId=${positiveId(creatorId)}&page=${positiveId(page)}&limit=20`);
export const fetchSourceEvidenceDetail = (id: number) => requestJson<SourceEvidenceObservation>(`${root}/${positiveId(id)}`);
export const saveSourceEvidence = (input: SaveSourceEvidenceInput) => {
  assertSafeSourceEvidenceInput(input);
  return post<{ ok: true; recorded: true; observation: SourceEvidenceObservation }>(root, input);
};
export const confirmSourceEvidenceIdentity = (id: number, input: ConfirmSourceEvidenceInput) => post<{ ok: true; observation: SourceEvidenceObservation }>(`${root}/${positiveId(id)}/confirm-identity`, input);
export const linkSourceEvidenceWork = (id: number, input: LinkSourceEvidenceInput) => post<{ ok: true; link: SourceEvidenceLink }>(`${root}/${positiveId(id)}/links`, input);
export const mapSourceEvidenceEntry = (id: number, input: MapSourceEvidenceEntryInput) => post<{ ok: true; mapping: SourceEvidenceLink }>(`${root}/${positiveId(id)}/entry-mappings`, input);

/** A CLI preview scope, never an executable admission plan. Filesystem checks stay in the CLI. */
export function createSourceEvidenceScope(input: {
  creatorId: number; sourceEvidenceId: number; inputRoot: string; directoryLines: string; acceptExistingVersion: boolean;
}) {
  positiveId(input.creatorId);
  positiveId(input.sourceEvidenceId);
  const inputRoot = input.inputRoot.trim();
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/]|\/)/iu.test(inputRoot)) throw new Error('请填写已解压目录的绝对路径');
  const directories = input.directoryLines.split(/\r?\n/u).filter(line => line.trim().length > 0);
  if (!directories.length || directories.length > 500) throw new Error('请明确列出 1～500 个一级作品目录');
  if (directories.some(name => /[\\/:\x00]/u.test(name) || name === '.' || name === '..')) throw new Error('每行仅填写一个原始一级目录名，不填写子路径');
  if (new Set(directories.map(name => name.toLocaleLowerCase('en-US'))).size !== directories.length) throw new Error('目录清单不能重复');
  return {
    creatorId: input.creatorId,
    sourceEvidenceId: input.sourceEvidenceId,
    inputRoot,
    directories,
    localOnly: false,
    acceptExistingVersion: input.acceptExistingVersion,
    confirmed: false
  };
}
