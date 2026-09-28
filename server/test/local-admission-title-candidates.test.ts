import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { LocalAdmissionTitleCandidates } from '../src/services/local-admission-title-candidates.js';

describe('creator-scoped manual admission title recall', () => {
  let db: DatabaseSync;
  const add=(id:number,title:string,creatorId=1)=>db.prepare('INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(?,?,?)').run(id,creatorId,title);
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');db.exec(schemaSql);
    db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,seed_source,seed_source_creator_id)
      VALUES(1,'Alpha','alpha','test','1'),(2,'Other','other','test','2');
      INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source) VALUES(1,'别名','别名','manual'),(1,'별칭','별칭','manual');
      INSERT INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,'synthetic','Alpha','synthetic/Alpha','Alpha','matched','now');`);
  });
  afterEach(()=>{vi.restoreAllMocks();db.close();});
  it('recalls source-free Works through the shared exact/candidate parser and registered aliases',()=>{
    add(1,'Garden Party');
    const index=new LocalAdmissionTitleCandidates(db,1);
    expect(index.find('别名 NO.991 Garden Party [12P 3MB]').get(1)?.level).toBe('exact');
    expect(index.find('alpha no.887 garden-party [12P]').get(1)?.level).toBe('similar');
    expect(index.find('NO.001 Other Title').size).toBe(0);
    expect(index.find('NO.001').size).toBe(0);
  });
  it('reads original local folder names and never includes a Work owned by another creator',()=>{
    add(1,'Manual canonical title');add(2,'Old folder title',2);
    db.exec(`INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,'old','synthetic/Alpha/old','Alpha NO.007 Old folder title [15P]','matched','now')`);
    const index=new LocalAdmissionTitleCandidates(db,1);
    expect([...index.find('别名 NO.999 Old folder title')]).toEqual([[1,expect.objectContaining({level:'exact',reasons:[expect.stringContaining('目录名')]})]]);
  });
  it('version differences only suggest review while internal and leading VOL numbers never authorize exact equivalence',()=>{
    add(1,'Garden Party RED.Ver');add(2,'Garden Party +Video');add(3,'Garden Party Vol.02');add(4,'VOL.02 Another Garden');
    const index=new LocalAdmissionTitleCandidates(db,1);
    expect(index.find('Garden Party').get(1)?.level).toBe('similar');
    expect(index.find('Garden Party').get(2)?.level).toBe('similar');
    expect(index.find('Garden Party').get(3)?.level).toBe('similar');
    expect(index.find('Garden Party BLUE.Ver').get(1)?.level).toBe('similar');
    expect(index.find('Garden Party Vol.02').get(3)?.level).toBe('exact');
    expect(index.find('Garden Party Vol.03').get(3)?.level).toBe('similar');
    expect(index.find('VOL.01 Another Garden').get(4)?.level).toBe('similar');
    expect(index.find('Another Garden').get(4)?.level).toBe('similar');
    expect(index.sourceEvidence('VOL.01 Another Garden','VOL.02 Another Garden').level).toBe('similar');
    expect(index.find('Garden Party RED.Ver').get(1)?.level).toBe('exact');
  });
  it('retains multiple same-title candidates without choosing an identity and only loads the creator once',()=>{
    add(1,'Identical');add(2,'Identical');add(3,'Identical',2);
    const prepare=vi.spyOn(db,'prepare');
    const index=new LocalAdmissionTitleCandidates(db,1);
    expect(prepare).toHaveBeenCalledTimes(3);
    db.exec('PRAGMA query_only=ON');const before=db.prepare('SELECT total_changes() n').get()!.n;
    prepare.mockClear();
    for(let i=0;i<50;i++)expect([...index.find('Alpha NO.083 Identical').keys()]).toEqual([1,2]);
    expect(prepare).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes() n').get()!.n).toBe(before);
  });
  it('keeps lower-level source substring suggestions as similar unless shared exact keys match',()=>{
    const index=new LocalAdmissionTitleCandidates(db,1);
    expect(index.sourceEvidence('Alpha NO.008 Garden Party','Garden Party').level).toBe('exact');
    expect(index.sourceEvidence('Garden Party RED.Ver','Garden Party').level).toBe('similar');
    expect(index.sourceEvidence('Garden Party','Party').level).toBe('similar');
  });
  it('checks stable creator/title/directory facts again without including unrelated statistics',()=>{
    add(1,'Stable title');
    db.exec(`INSERT INTO archive_catalog_local_works(local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,scanned_at)
      VALUES(1,1,'original','synthetic/Alpha/original','Original directory','matched','now')`);
    const index=new LocalAdmissionTitleCandidates(db,1);
    db.exec('UPDATE archive_catalog_local_works SET image_count=11,video_count=2');
    expect(index.unchanged()).toBe(true);
    db.exec("UPDATE archive_catalog_local_works SET folder_name='Renamed directory'");
    expect(index.unchanged()).toBe(false);
  });
  it.each([
    ['Garden Party_RED','Garden Party (RED.Ver)'],
    ['Garden Party_RED SP','Garden Party'],
    ['Garden Party (+Video)','Garden Party'],
    ['Garden Party V2','Garden Party'],
    ['Alpha NO.015 Garden Party (RED.Ver) [80P/1V/1.2GB]','Garden Party_RED'],
    ['Alpha (별칭) NO.015 Garden Party (RED.Ver) [109P+1V／1.82GB]','Alpha (별칭) NO.019 Garden Party_RED [99P/1.1GB]'],
  ])('recalls presentation/version differences %s versus %s only as manual similar', (stored,incoming)=>{
    add(1,stored);const index=new LocalAdmissionTitleCandidates(db,1);
    expect(index.find(incoming).get(1)?.level).toBe('similar');
    expect(index.sourceEvidence(stored,incoming).level).toBe('similar');
  });
  it('indexes bidirectional batch title/version peers without consulting file counts or changing identity',()=>{
    const index=new LocalAdmissionTitleCandidates(db,1);
    const paths=['NO.013 Garden Party_RED','NO.014 Garden Party (RED.Ver)','NO.015 Different title'];
    const result=index.peers(paths);
    expect(result.get(paths[0]!)?.items.map(item=>item.sourceRelativePath)).toEqual([paths[1]]);
    expect(result.get(paths[1]!)?.items.map(item=>item.sourceRelativePath)).toEqual([paths[0]]);
    expect(result.get(paths[2]!)?.items).toEqual([]);
    expect([...index.peers([...paths].reverse())]).toEqual([...result]);
  });
  it('recalls explicit studio/series numbers but not bare NO, different series, different studio or internal volumes',()=>{
    const index=new LocalAdmissionTitleCandidates(db,1);
    const paths=['[STUDIO] ABC-183 Moon','STUDIO ABC 183 Unrelated title','STUDIO ABC-184 Moon',
      'OTHER ABC-183 Moon','NO.183 First','NO.183 Second','Moon Vol.01','Moon Vol.02','Alpha NO.183','别名 NO.183'];
    const result=index.peers(paths);
    expect(result.get(paths[0]!)?.items.map(item=>item.sourceRelativePath)).toEqual([paths[1]]);
    expect(result.get(paths[1]!)?.items[0]?.reasons[0]).toContain('厂牌');
    for(const title of paths.slice(2))expect(result.get(title)?.items).toEqual([]);
  });
  it('marks peer truncation and retains deterministic capped output for dense buckets',()=>{
    const index=new LocalAdmissionTitleCandidates(db,1);
    const paths=Array.from({length:100},(_,n)=>`NO.${n+1} Shared title`);
    const result=index.peers(paths);
    for(const title of paths){const peers=result.get(title)!;expect(peers.items).toHaveLength(50);expect(peers.truncated).toBe(true);expect(peers.items.every(peer=>peer.sourceRelativePath!==title)).toBe(true);}
    expect([...index.peers(paths.reverse())]).toEqual([...result]);
  });
  it('retains full directory syntax with repeated registered names and multi-word studios',()=>{
    const index=new LocalAdmissionTitleCandidates(db,1);
    const paths=['Alpha (별칭) NO.034 STUDIO EXPRESS CODE-183 Alpha (별칭)[54P 1GB]',
      'Alpha (별칭) NO.038 STUDIO EXPRESS CODE 183 Alternate Name [109P+1V／1.82GB]',
      'Alpha (별칭) NO.039 STUDIO EXPRESS CODE 184 Alternate Name [54P 1GB]',
      'Alpha (별칭) NO.040 OTHER STUDIO CODE 183 Alternate Name [54P 1GB]'];
    const result=index.peers(paths);
    expect(result.get(paths[0]!)?.items.map(item=>item.sourceRelativePath)).toEqual([paths[1]]);
    expect(result.get(paths[1]!)?.items.map(item=>item.sourceRelativePath)).toEqual([paths[0]]);
    expect(result.get(paths[2]!)?.items).toEqual([]);expect(result.get(paths[3]!)?.items).toEqual([]);
  });
});
