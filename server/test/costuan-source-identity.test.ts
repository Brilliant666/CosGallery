import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';
import { ArchiveMetadataTaskService } from '../src/services/archive-metadata-task-service.js';
import { normalizeCreatorIdentity } from '../src/utils/creator-identity.js';

// Synthetic article-sized directories only: no live website, production DB,
// media directory, download, or fixture copied from an account is involved.
describe('Costuan multi-evidence creator identity', () => {
  let db: DatabaseSync;
  let catalog: ArchiveCatalogService;
  const id = 61;
  const name = '星野咪兔';
  const postId = '463';
  const articleTitle = (creatorName = `${name}MeetU`) => `${creatorName}COSPLAY写真图片包合集[3套][持续更新]`;
  const rawDirectory = (creatorName = name) => [
    `${creatorName} NO.001 春日 [2P-1MB]`,
    '2026.09.01更新：',
    `${creatorName} NO.002 夏日 [2P-1MB]`,
    `${creatorName} NO.003 秋日 [2P-1MB]`
  ].join('\n');
  const evidence = () => ({
    resourceDirectoryText: rawDirectory(),
    identityEvidence: {
      version: 1 as const,
      pageUrl: 'https://www.costuan.com/463.html',
      creatorTags: [{ name, url: 'https://www.costuan.com/tag/561' }]
    }
  });
  const snapshot = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(table => [table.name, db.prepare(`SELECT * FROM "${table.name}" ORDER BY 1`).all()]));
  const creator = (creatorId: number, creatorName: string, active = 1) => db.prepare(`INSERT INTO archive_catalog_creators
    (id,canonical_name,normalized_name,is_active,seed_source,seed_source_creator_id) VALUES (?,?,?,?,'identity-test',?)`)
    .run(creatorId, creatorName, normalizeCreatorIdentity(creatorName), active, String(creatorId));
  const alias = (creatorId: number, alternate: string) => db.prepare(`INSERT INTO archive_catalog_creator_aliases
    (creator_id,alias,normalized_alias,source) VALUES (?,?,?,'manual')`)
    .run(creatorId, alternate, normalizeCreatorIdentity(alternate));
  const bind = (creatorId = id) => db.prepare(`INSERT INTO archive_catalog_collections
    (creator_id,source,source_collection_id,title,observed_at) VALUES (?,'costuan',?,?,?)`)
    .run(creatorId, postId, articleTitle(), '2026-09-01T00:00:00Z');
  const rejectsWithoutWrites = (action: () => unknown, message: RegExp = /身份|名称|目录|证据|归属|标题|博主/) => {
    const before = snapshot();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    expect(action).toThrow(message);
    expect(snapshot()).toBe(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  };

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    creator(id, name);
    catalog = new ArchiveCatalogService(db);
  });
  afterEach(() => db.close());

  it.each(['韩国妹子','韩国模特'])('verifies bounded descriptive prefix %s without writes', prefix=>{
    db.prepare('UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=? WHERE id=?').run('Maruemon','maruemon',id);
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory('Maruemon');
    proof.identityEvidence.creatorTags[0].name='Maruemon';
    const before=snapshot();
    expect(catalog.validateCostuanIdentity(id,postId,`${prefix}Maruemon写真图片包合集[3套][COSPLAY][持续更新]`,proof)).toMatchObject({creatorId:id,method:'title-directory-tags'});
    expect(snapshot()).toBe(before);
  });

  it.each(['missing-tag','other-tag','incomplete','other-owner','unbounded-prefix'])('rejects invalid descriptive title evidence: %s',mode=>{
    const proof=evidence();
    let prefix='韩国妹子';
    if(mode==='missing-tag') proof.identityEvidence.creatorTags=[];
    if(mode==='other-tag') proof.identityEvidence.creatorTags[0].name='别人';
    if(mode==='incomplete') proof.resourceDirectoryText=rawDirectory().split('\n')[0];
    if(mode==='other-owner') {creator(62,'其他博主');alias(62,`韩国妹子${name}`);}
    if(mode==='unbounded-prefix')prefix='推荐精选';
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,articleTitle(`${prefix}${name}`),proof));
  });

  it.each(['西园寺南歌(白露Mizu_)','白露Mizu_（西园寺南歌）'])('verifies parenthetical dual names %s without learning aliases', titleName => {
    db.prepare('UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=? WHERE id=?').run('西园寺南歌','西园寺南歌',id);
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory('西园寺南歌').replace('西园寺南歌 NO.002','白露Mizu_ NO.002');
    proof.identityEvidence.creatorTags[0].name='白露Mizu_';
    const before=snapshot();
    expect(catalog.validateCostuanIdentity(id,postId,articleTitle(titleName),proof)).toMatchObject({creatorId:id,method:'title-directory-tags'});
    expect(snapshot()).toBe(before);
  });

  it.each(['conflict','bound-conflict','missing-tag','unrelated-tag','nested','duplicate','no-anchor'])('rejects unsafe parenthetical names: %s', mode => {
    const proof=evidence();
    let titleName=`${name}(旧名称)`;
    if(mode==='conflict' || mode==='bound-conflict') {creator(62,'旧名称');if(mode==='bound-conflict') bind();}
    if(mode==='missing-tag') proof.identityEvidence.creatorTags=[];
    if(mode==='unrelated-tag') proof.identityEvidence.creatorTags[0].name='第三名称';
    if(mode==='nested') titleName=`${name}(旧名称(第三名称))`;
    if(mode==='duplicate') titleName=`${name}(${name})`;
    if(mode==='no-anchor') titleName='未登记(旧名称)';
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,articleTitle(titleName),proof));
  });

  it.each(['YeonYu','연유','YeonYu(연유)'])('verifies an article-local Korean name declaration with directory %s', directoryName => {
    db.prepare('UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=? WHERE id=?').run('YeonYu','yeonyu',id);
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory(directoryName);
    proof.identityEvidence.creatorTags[0].name='YeonYu';
    const before=snapshot();
    expect(catalog.validateCostuanIdentity(id,postId,'韩国模特YeonYu(연유)写真图片包合集[3套][持续更新]',proof)).toMatchObject({creatorId:id,method:'title-directory-tags'});
    expect(snapshot()).toBe(before);
  });

  it.each(['other-korean-owner','missing-tag','unrelated-directory','incomplete-directory','arbitrary-parenthesis'])('rejects unsafe multilingual evidence: %s', mode => {
    db.prepare('UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=? WHERE id=?').run('YeonYu','yeonyu',id);
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory('YeonYu');
    proof.identityEvidence.creatorTags[0].name='연유';
    if(mode==='other-korean-owner') creator(62,'연유');
    if(mode==='missing-tag') proof.identityEvidence.creatorTags=[];
    if(mode==='unrelated-directory') proof.resourceDirectoryText=rawDirectory('别人');
    if(mode==='incomplete-directory') proof.resourceDirectoryText='YeonYu NO.001 春日 [2P-1MB]';
    const title=mode==='arbitrary-parenthesis'?'韩国模特YeonYu(其他人)写真图片包合集[3套][持续更新]':'韩国模特YeonYu(연유)写真图片包合集[3套][持续更新]';
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,title,proof));
  });

  it('accepts mixed canonical and bounded variant directory names with separated dashes without writes', () => {
    const proof=evidence();
    proof.resourceDirectoryText=`${name} – NO.001 春日 [2P-1MB]\n${name}MeetU — NO.002 夏日 [2P-1MB]\n${name} NO.003 秋日 [2P-1MB]`;
    proof.identityEvidence.creatorTags[0].name=`${name}MeetU`;
    const before=snapshot();
    expect(catalog.validateCostuanIdentity(id,postId,articleTitle(),proof)).toMatchObject({creatorId:id,method:'title-directory-tags'});
    expect(snapshot()).toBe(before);
  });

  it('rejects a conflicting variant identity even behind a directory separator', () => {
    creator(62,`${name}MeetU`);
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory(`${name}MeetU –`);
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,articleTitle(),proof));
  });

  it.each(['missing','duplicate'])('reports a specific directory error for %s', mode => {
    const proof=evidence();
    proof.resourceDirectoryText=mode==='missing' ? rawDirectory().replace(/[^\n]*NO\.003[^\n]*/,'') : rawDirectory()+`\n${name} NO.003 重复 [2P-1MB]`;
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,articleTitle(),proof), mode==='missing'?/缺少编号：3/:/编号重复：NO/);
  });

  it.each([`${name}MeetU`, `MeetU${name}`])('confirms the bounded Latin variant %s using the complete directory and article tag without adding an alias, source or task', titleName => {
    const before = snapshot();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    expect(catalog.validateCostuanIdentity(id, postId, articleTitle(titleName), evidence())).toMatchObject({
      method: 'title-directory-tags', creatorId: id, postId, titleName,
      directoryName: name, tagNames: [name]
    });
    expect(snapshot()).toBe(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('accepts a shorter article name against a unique canonical Latin handle only with matching directory and tag proof', () => {
    db.prepare('UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=? WHERE id=?')
      .run(`${name}MeetU`, normalizeCreatorIdentity(`${name}MeetU`), id);
    const proof = evidence();
    proof.resourceDirectoryText = rawDirectory(`${name}MeetU`);
    proof.identityEvidence.creatorTags[0].name = `${name}MeetU`;
    expect(catalog.validateCostuanIdentity(id, postId, articleTitle(name), proof)).toMatchObject({
      method: 'title-directory-tags', titleName: name, directoryName: `${name}MeetU`
    });
  });

  it('keeps the exact registered alias path available without requiring new page evidence', () => {
    alias(id, `${name}MeetU`);
    expect(catalog.validateCostuanIdentity(id, postId, articleTitle())).toMatchObject({method: 'exact-name', creatorId: id});
    expect(catalog.validateCostuanIdentity(id, postId, articleTitle('星野咪兔_MeetU'))).toMatchObject({method: 'exact-name'});
  });

  it('accepts the same uniquely resolved Latin variant in title, complete directory and article tag without adding aliases', () => {
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory(`MeetU${name}`);
    proof.identityEvidence.creatorTags[0].name=`MeetU${name}`;
    const before=snapshot();
    expect(catalog.validateCostuanIdentity(id,postId,articleTitle(`MeetU${name}`),proof)).toMatchObject({method:'title-directory-tags',creatorId:id});
    expect(snapshot()).toBe(before);
  });

  it('rejects a tag variant that resolves to a different or ambiguous creator', () => {
    creator(62,`${name}Meet`);
    const proof=evidence();
    proof.identityEvidence.creatorTags[0].name=`${name}MeetMore`;
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,articleTitle(),proof));
  });

  it('retains the compatible bound-source path for old records lacking new evidence', () => {
    bind();
    expect(catalog.validateCostuanIdentity(id, postId, articleTitle())).toMatchObject({method: 'bound-source', creatorId: id});
  });

  it('does not let an old binding override a title that uniquely belongs to another creator', () => {
    bind();
    creator(62, `${name}MeetU`);
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), evidence()), /标题身份不一致.*#62/);
  });

  it('does not let title or directory evidence override an existing source owner', () => {
    creator(62, '另一位博主');
    bind(62);
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), evidence()), /归属冲突.*#62/);
  });

  it.each(['exact-active', 'exact-inactive-alias', 'variant-active', 'variant-inactive'])('rejects the global %s identity collision, even for an inactive creator', collision => {
    const exact = collision.startsWith('exact');
    creator(62, exact ? '另一位博主' : `${name}Me`, collision.includes('inactive') ? 0 : 1);
    if (exact) alias(62, `${name}MeetU`);
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), evidence()), /不一致|歧义/);
  });

  it('reports an exact name shared by two canonical identities as ambiguous', () => {
    creator(62, name);
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(name)), /歧义/);
  });

  it.each(['未命名页面', '他人COSPLAY写真图片包合集[3套][持续更新]',
    `前缀${name}MeetUCOSPLAY写真图片包合集[3套][持续更新]`,
    `X${name}YCOSPLAY写真图片包合集[3套][持续更新]`,
    `${name}MeetU2026COSPLAY写真图片包合集[3套][持续更新]`])('does not turn parsing failure or mere substring similarity into authorization: %s', title => {
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, title, evidence()), /无法解析|未匹配|歧义/);
  });

  it('does not use a one-character base name to approve Latin additions', () => {
    creator(62, '兔');
    const proof = evidence();
    proof.resourceDirectoryText = rawDirectory('兔');
    proof.identityEvidence.creatorTags[0].name = '兔';
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(62, postId, articleTitle('兔MeetU'), proof), /未匹配/);
  });

  it.each(['absent-evidence', 'no-tags', 'multiple-tags', 'unregistered-tag', 'different-owner-tag'])('requires unique matching tag evidence: %s', mode => {
    const proof: {resourceDirectoryText: string; identityEvidence?: ReturnType<typeof evidence>['identityEvidence']} = evidence();
    if (mode === 'absent-evidence') delete proof.identityEvidence;
    if (mode === 'no-tags') proof.identityEvidence!.creatorTags = [];
    if (mode === 'multiple-tags') proof.identityEvidence!.creatorTags.push({name: '角色标签', url: 'https://www.costuan.com/tag/562'});
    if (mode === 'unregistered-tag') proof.identityEvidence!.creatorTags[0].name = '未知名称';
    if (mode === 'different-owner-tag') {
      creator(62, '另一位博主');
      proof.identityEvidence!.creatorTags[0].name = '另一位博主';
    }
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), proof));
  });

  it.each([
    ['pageUrl', 'https://www.costuan.com/464.html'],
    ['pageUrl', 'https://costuan.com.evil.test/463.html'],
    ['pageUrl', 'http://www.costuan.com/463.html'],
    ['pageUrl', 'https://someone@www.costuan.com/463.html'],
    ['pageUrl', 'https://www.costuan.com/463.html?other=1'],
    ['tagUrl', 'https://other.test/tag/561'],
    ['tagUrl', 'https://www.costuan.com/463.html'],
    ['tagUrl', 'https://www.costuan.com/tag/561#another'],
    ['tagUrl', 'https://www.costuan.com/tag/561?creator=another']
  ])('rejects invalid or unrelated evidence URL %s=%s', (field, value) => {
    const proof = evidence();
    if (field === 'pageUrl') proof.identityEvidence.pageUrl = value;
    else proof.identityEvidence.creatorTags[0].url = value;
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), proof), /证据无效/);
  });

  it.each(['missing-line', 'duplicate-line', 'mixed-prefix', 'incomplete-prefix', 'body-prose', 'mixed-schemes', 'only-count', 'unknown-appendix'])('rejects an incomplete or contradictory raw directory: %s', mode => {
    const proof = evidence();
    if (mode === 'missing-line') proof.resourceDirectoryText = proof.resourceDirectoryText.replace(/[^\n]*NO\.003[^\n]*/, '');
    if (mode === 'duplicate-line') proof.resourceDirectoryText += `\n${name} NO.003 重复 [2P-1MB]`;
    if (mode === 'mixed-prefix') proof.resourceDirectoryText = proof.resourceDirectoryText.replace(`${name} NO.002`, '另一位博主 NO.002');
    if (mode === 'incomplete-prefix') proof.resourceDirectoryText = proof.resourceDirectoryText.replace(`${name} NO.002`, '咪兔 NO.002');
    if (mode === 'body-prose') proof.resourceDirectoryText += `\n大家都喜欢${name}，这不是资源目录条目。`;
    if (mode === 'mixed-schemes') proof.resourceDirectoryText = proof.resourceDirectoryText.replace('NO.002', 'VOL.002');
    if (mode === 'only-count') proof.resourceDirectoryText = `${name} 总计3套，最新 NO.003`;
    if (mode === 'unknown-appendix') proof.resourceDirectoryText += `\n${name} 附加内容 [2P-1MB]`;
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), proof), /目录|证据|冲突/);
  });

  it('rejects a disabled selected creator before considering matching evidence', () => {
    db.prepare('UPDATE archive_catalog_creators SET is_active=0 WHERE id=?').run(id);
    rejectsWithoutWrites(() => catalog.validateCostuanIdentity(id, postId, articleTitle(), evidence()), /停用/);
  });

  const claimedRecord = () => {
    const service = new ArchiveMetadataTaskService(db);
    const planned = service.planSelected({creatorIds: [id], requestId: 'synthetic-identity-round'});
    const task = service.claim({workerId: 'identity-test', taskIds: planned.taskIds,
      rounds: [{taskId: planned.taskIds[0], checkRoundId: planned.items[0].task!.checkRoundId!}]})[0];
    const proof = evidence();
    const record = {creatorName: name, aliases: [], costuan: {
      postId, title: articleTitle(), url: proof.identityEvidence.pageUrl, collectionCount: 3, ...proof,
      directoryVerification: {complete: true, checkedAt: '2026-09-11T00:00:00Z', parsedWorkCount: 3},
      works: ['春日', '夏日', '秋日'].map((label, index) => ({order: index + 1,
        sourceOrder: `NO.${String(index + 1).padStart(3, '0')}`, label, mediaSummary: '2P-1MB'}))
    }, baidu: {transport: 'direct-share', status: 'share-verified', shareUrl: 'https://pan.baidu.com/s/1syntheticIdentity', sourceFolderName: '999',
      verification: {method: 'share-read', complete: true, checkedAt: '2026-09-11T00:00:00Z', checkRoundId: task.checkRoundId,
        files: ['001.7z', '002.7z', '003.7z']}}};
    const request = {id: task.id, workerId: 'identity-test', canonicalCreatorId: id, expectedAttempt: task.attemptCount,
      receiptId: 'synthetic-identity-receipt', record};
    return {service, task, proof, record, request};
  };

  it.each(['阿九从不咕咕/九言', '九言／阿九从不咕咕'])('verifies dual names %s through preflight, directory and completion without global aliases', titleName => {
    db.prepare('UPDATE archive_catalog_creators SET canonical_name=?,normalized_name=? WHERE id=?').run('九言','九言',id);
    const {service,request}=claimedRecord();
    request.record.creatorName='九言';
    request.record.costuan.title=articleTitle(titleName);
    request.record.costuan.resourceDirectoryText=rawDirectory('阿九从不咕咕');
    request.record.costuan.identityEvidence.creatorTags[0].name='阿九从不咕咕';
    const before=snapshot();
    expect(service.validateSource({...request,...request.record.costuan})).toMatchObject({identityVerification:{method:'title-directory-tags',creatorId:id}});
    expect(service.validateDirectory(request).sourceFilenames).toEqual(['001.7z','002.7z','003.7z']);
    expect(snapshot()).toBe(before);
    expect(service.complete(request).task.status).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_creator_aliases').get()?.n).toBe(0);
    expect(db.prepare('SELECT creator_id FROM archive_catalog_collections').get()?.creator_id).toBe(id);
  });

  it.each(['other-owner','ambiguous-alias','bound-conflict','missing-tag','multiple-tags','tag-mismatch','incomplete-directory','mixed-directory','substring','three-names','empty-name','duplicate-name'])('rejects unsafe dual-name evidence without writes: %s', mode => {
    let titleName=`旧名称/${name}`;
    const proof=evidence();
    proof.resourceDirectoryText=rawDirectory('旧名称');
    proof.identityEvidence.creatorTags[0].name='旧名称';
    if(['other-owner','ambiguous-alias','bound-conflict'].includes(mode)) {
      creator(62,'另一位博主',0); alias(62,'旧名称');
      if(mode==='ambiguous-alias') alias(id,'旧名称');
      if(mode==='bound-conflict') bind();
    }
    if(mode==='missing-tag') proof.identityEvidence.creatorTags=[];
    if(mode==='multiple-tags') proof.identityEvidence.creatorTags.push({name,url:'https://www.costuan.com/tag/562'});
    if(mode==='tag-mismatch') proof.identityEvidence.creatorTags[0].name='未核实名';
    if(mode==='incomplete-directory') proof.resourceDirectoryText=rawDirectory('旧名称').split('\n').slice(0,2).join('\n');
    if(mode==='mixed-directory') proof.resourceDirectoryText=rawDirectory('旧名称').replace('旧名称 NO.003',`${name} NO.003`);
    if(mode==='substring') titleName=`旧名称/前缀${name}`;
    if(mode==='three-names') titleName+= '/第三名称';
    if(mode==='empty-name') titleName=`/${name}`;
    if(mode==='duplicate-name') titleName=`${name}/${name}`;
    rejectsWithoutWrites(()=>catalog.validateCostuanIdentity(id,postId,articleTitle(titleName),proof));
  });

  it('carries the same evidence through read-only preflight, full directory validation and final completion without learning a global alias', () => {
    const {service, task, proof, request} = claimedRecord();
    const before = snapshot();
    expect(service.validateSource({...request, postId, title: articleTitle(), ...proof})).toMatchObject({
      id: task.id, identityVerification: {method: 'title-directory-tags', creatorId: id}
    });
    expect(service.validateDirectory(request).sourceFilenames).toEqual(['001.7z', '002.7z', '003.7z']);
    expect(snapshot()).toBe(before);
    expect(service.complete(request).task.status).toBe('completed');
    expect(db.prepare('SELECT creator_id FROM archive_catalog_collections').get()?.creator_id).toBe(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_creator_aliases').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_source_works').get()?.n).toBe(3);
    const saved = JSON.parse(String(db.prepare('SELECT metadata_json FROM archive_catalog_collections').get()?.metadata_json));
    expect(saved.identityVerification).toMatchObject({method: 'title-directory-tags', creatorId: id});
  });

  it.each(['missing-evidence', 'changed-title-owner', 'changed-tag-owner'])('recomputes identity on completion after successful preflight: %s', mode => {
    const {service, proof, request} = claimedRecord();
    service.validateSource({...request, postId, title: articleTitle(), ...proof});
    const invalid = structuredClone(request);
    if (mode === 'missing-evidence') {
      Reflect.deleteProperty(invalid.record.costuan, 'identityEvidence');
      Object.assign(invalid.record.costuan, {identityVerification: {method: 'title-directory-tags', creatorId: id}});
    } else {
      creator(62, '另一位博主');
      if (mode === 'changed-title-owner') invalid.record.costuan.title = articleTitle('另一位博主');
      else invalid.record.costuan.identityEvidence.creatorTags[0].name = '另一位博主';
    }
    rejectsWithoutWrites(() => service.complete(invalid));
    expect(service.get(request.id)?.status).toBe('claimed');
  });
});
