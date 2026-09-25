import { z } from 'zod';
import { RequestInputError } from '../utils/request-input-error.js';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import { parseCostuanDirectoryText, parseCostuanNumbering, WEIBO_SUPPLEMENT_LABELS, hasCostuanWeiboSupplementDeclaration } from './costuan-numbering-service.js';

export const costuanIdentityEvidenceSchema = z.object({
  version: z.literal(1),
  pageUrl: z.string().max(2000),
  creatorTags: z.array(z.object({ name: z.string().trim().min(1).max(255), url: z.string().max(2000) }).strict()).max(20)
}).strict();

export type CostuanIdentityInput = {
  resourceDirectoryText?: string;
  identityEvidence?: z.infer<typeof costuanIdentityEvidenceSchema>;
};

export type CostuanIdentityVerification = {
  method: 'bound-source' | 'exact-name' | 'title-directory-tags';
  creatorId: number;
  postId: string;
  titleName: string | null;
  directoryName?: string;
  tagNames?: string[];
  message: string;
};

function costuanUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['costuan.com', 'www.costuan.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

export function checkedIdentityEvidence(input: unknown, postId: string) {
  const parsed = costuanIdentityEvidenceSchema.safeParse(input);
  if (!parsed.success || costuanUrl(parsed.data.pageUrl)?.pathname !== `/${postId}.html`
    || parsed.data.creatorTags.some(tag => !/^\/tag\/\d+$/.test(costuanUrl(tag.url)?.pathname ?? ''))) {
    throw new RequestInputError('身份页面证据无效：文章地址或本篇标签链接与指定 Costuan 合集不符；保留暂停，需人工检查。', 'COSTUAN_IDENTITY_INVALID');
  }
  return parsed.data;
}

// Candidate relationship, never sufficient authorization by itself. Preserve
// every character of the shorter name; only an added Latin handle is supported.
export function isCostuanNameVariant(left: string, right: string): boolean {
  const a = normalizeCreatorIdentity(left), b = normalizeCreatorIdentity(right);
  if (!a || !b || a === b) return false;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if ((short.match(/\p{Script=Han}/gu) ?? []).length < 2) return false;
  return (long.startsWith(short) && /^[a-z]{2,32}$/.test(long.slice(short.length)))
    || (long.endsWith(short) && /^[a-z]{2,32}$/.test(long.slice(0, -short.length)));
}

export function directoryCreatorNames(text: string): string[] {
  return text.split(/\r?\n/u).flatMap(raw => {
    const line = raw.normalize('NFKC').trim();
    const order = parseCostuanNumbering(line);
    return order && ['explicit','implicit'].includes(order.style) && order.start > 0 ? [line.slice(0, order.start).trim().replace(/\s+[-–—]\s*$/u, '').trim()] : [];
  });
}

// A variant cannot be approved from one convenient line or a partially loaded
// directory. Do not merge duplicates or infer identity from work descriptions.
export function completeIdentityDirectory(text: string | undefined, title: string, validateName?: (name: string) => boolean,
  options: { allowUnnamedEntries?: boolean } = {}): string {
  const count = Number(title.normalize('NFKC').match(/\[(\d+)\s*套[^\]]*\]/u)?.[1]);
  const fail = (reason = '未取得有效目录或标题声明数量') => new RequestInputError(`来源目录校验未通过：${reason}；保留暂停，需人工检查。`, 'COSTUAN_DIRECTORY_INVALID');
  if (!text?.trim() || text.length > 2_000_000 || !Number.isInteger(count) || count < 1 || count > 10000) throw fail();
  const names = new Map<string, string>(), orders = new Set<number>(), schemes = new Set<string>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.normalize('NFKC').trim();
    if (!line || /^\d{4}[./-]\d{1,2}[./-]\d{1,2}更新\s*[:：]?$/u.test(line)) continue;
    const order = parseCostuanNumbering(line);
    const works = parseCostuanDirectoryText(line);
    // An explicitly advertised appendix participates in creator-name evidence,
    // never in numbered coverage or executable Works.
    if (!order && works.length === 1 && works[0].mediaSummary
      && hasCostuanWeiboSupplementDeclaration(title)) {
      const label=WEIBO_SUPPLEMENT_LABELS.find(label => works[0].label.endsWith(label));
      const name=label ? works[0].label.slice(0,-label.length).trim() : '';
      if (name) { names.set(normalizeCreatorIdentity(name),name); continue; }
    }
    const first=order?.range?.first ?? order?.order;
    const last=order?.range?.last ?? order?.order;
    if (!order || !['explicit','implicit'].includes(order.style) || first == null || last == null || order.qualifier
      || !['NO', 'VOL'].includes(order.scheme) || first < 1 || last > count
      || works.length !== 1 || works[0].sourceOrderKey !== order.key) throw fail(`条目格式或编号不符合要求：${line.slice(0, 100)}`);
    for(let number=first;number<=last;number++) {
      if(orders.has(number)) throw fail(`编号重复：${order.key}`);
      orders.add(number);
    }
    // A separated dash immediately before NO/VOL is layout punctuation, not a name.
    const name = line.slice(0, order.start).trim().replace(/\s+[-–—]\s*$/u, '').trim(), normalized = normalizeCreatorIdentity(name);
    if (!normalized && !options.allowUnnamedEntries) throw fail('条目未提供博主名称，且缺少独立的已确认身份证据');
    if (normalized) names.set(normalized, name);
    schemes.add(order.scheme);
  }
  if (orders.size !== count) throw fail(`标题声明 ${count} 套，有效编号 ${orders.size} 套；缺少编号：${Array.from({length:count},(_,i)=>i+1).filter(n=>!orders.has(n)).slice(0,20).join('、')}`);
  if (schemes.size !== 1) throw fail('目录混用了 NO 与 VOL 编号体系');
  if (validateName) {
    for (const name of names.values()) if (!validateName(name)) throw new RequestInputError(`目录身份核验未通过：名称“${name}”无法唯一对应当前博主，或不属于本篇标题的受限名称变体；保留暂停，需人工检查。`, 'COSTUAN_IDENTITY_INVALID');
  } else if (names.size !== 1 && !(options.allowUnnamedEntries && names.size === 0)) throw fail(`目录名称写法不一致：${[...names.values()].join('、')}`);
  // No name was observed: never fabricate a directory identity from the title.
  return [...names.values()][0] ?? '';
}
