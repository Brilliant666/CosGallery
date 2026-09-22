import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type LocalIdentityInput = {
  creatorId: number; rootPath: string; creatorFolderName: string; absolutePath: string;
  relativePath: string; title: string; workId?: number; sourceWorkId?: number;
  sameAsLocalId?: number; reason: string; key: string; localOnly?: boolean; acceptExistingVersion?: boolean;
};

/** Explicit identity writes. No file operations and no execution-history rewriting. */
export class WorkIdentityService {
  constructor(private readonly database: DatabaseSync) {}

  private transaction<T>(action: () => T): T {
    // Reserve the top-level writer before reading identity. A deferred SAVEPOINT
    // can otherwise fail its read-to-write upgrade immediately when the catalog
    // worker owns the writer, despite busy_timeout. Preserve caller transactions.
    const ownWriteTransaction = !this.database.isTransaction;
    this.database.exec(ownWriteTransaction ? 'BEGIN IMMEDIATE' : 'SAVEPOINT local_identity');
    try {
      const result = action();
      this.database.exec(ownWriteTransaction ? 'COMMIT' : 'RELEASE local_identity');
      return result;
    } catch (error) {
      this.database.exec(ownWriteTransaction ? 'ROLLBACK' : 'ROLLBACK TO local_identity; RELEASE local_identity');
      throw error;
    }
  }

  private decision(key: string, kind: string, workId: number | null, localId: number | null,
    sourceId: number | null, reason: string, payload: unknown): number {
    if (!key.trim() || !reason.trim()) throw new Error('An explicit decision key and reason are required');
    const serialized = JSON.stringify(payload);
    const old = this.database.prepare('SELECT * FROM archive_catalog_work_decisions WHERE decision_key=?')
      .get(key) as { id: number; payload_json: string; state: string } | undefined;
    if (old) {
      if (old.payload_json !== serialized || old.state !== 'active') throw new Error('Decision key was already used with different or revoked content');
      return old.id;
    }
    return Number(this.database.prepare(`INSERT INTO archive_catalog_work_decisions
      (decision_key,kind,work_id,local_work_id,source_work_id,reason,payload_json) VALUES(?,?,?,?,?,?,?)`)
      .run(key,kind,workId,localId,sourceId,reason,serialized).lastInsertRowid);
  }

  registerLocal(input: LocalIdentityInput): { workId: number; localWorkId: number; decisionId: number } {
    if (!input.title.trim() || !input.reason.trim() || !input.key.trim()) throw new Error('Title, reason and key are required');
    return this.transaction(() => {
      const old = this.database.prepare('SELECT * FROM archive_catalog_work_decisions WHERE decision_key=?')
        .get(input.key) as { work_id: number; local_work_id: number; id: number; payload_json: string; state: string } | undefined;
      if (old) {
        if (old.payload_json !== JSON.stringify(input) || old.state !== 'active') throw new Error('Admission identity content changed; a new confirmation is required');
        return { workId: old.work_id, localWorkId: old.local_work_id, decisionId: old.id };
      }
      const creator = this.database.prepare('SELECT id FROM archive_catalog_creators WHERE id=? AND is_active=1').get(input.creatorId);
      if (!creator) throw new Error('Active canonical creator not found');
      let workId = input.workId;
      if (input.sourceWorkId !== undefined) {
        const source = this.database.prepare('SELECT work_id FROM archive_catalog_source_works WHERE id=?').get(input.sourceWorkId) as {work_id:number}|undefined;
        if (!source || (workId !== undefined && workId !== source.work_id)) throw new Error('Existing Work merge is not supported');
        workId = source.work_id;
      }
      if (input.sameAsLocalId !== undefined) {
        const same = this.database.prepare('SELECT work_id FROM archive_catalog_local_works WHERE id=?').get(input.sameAsLocalId) as {work_id:number|null}|undefined;
        if (!same?.work_id || (workId !== undefined && workId !== same.work_id)) throw new Error('Same-work reference conflicts with existing identity');
        workId = same.work_id;
      }
      if (workId !== undefined) {
        if (!this.database.prepare('SELECT id FROM archive_catalog_works WHERE id=? AND creator_id=?').get(workId,input.creatorId)) throw new Error('Work belongs to a different creator');
      } else workId = Number(this.database.prepare("INSERT INTO archive_catalog_works(creator_id,display_title,title_policy) VALUES(?,?,'manual')").run(input.creatorId,input.title).lastInsertRowid);
      const creatorPath = path.resolve(input.rootPath,input.creatorFolderName);
      const relative = input.relativePath.replaceAll('\\','/').replace(new RegExp('^' + input.creatorFolderName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '/'),'');
      if (relative.includes('/') || relative === '..' || path.resolve(creatorPath,relative) !== path.resolve(input.absolutePath)) throw new Error('Only an explicit direct work directory can be registered');
      const folder = this.database.prepare('SELECT id,creator_id FROM archive_catalog_local_creator_folders WHERE root_path=? AND relative_path=?')
        .get(path.resolve(input.rootPath),input.creatorFolderName) as {id:number;creator_id:number|null}|undefined;
      if (folder && folder.creator_id !== input.creatorId) throw new Error('Creator directory is already owned by another identity');
      const folderId = folder?.id ?? Number(this.database.prepare(`INSERT INTO archive_catalog_local_creator_folders
        (creator_id,root_path,relative_path,absolute_path,folder_name,match_status,match_method,scanned_at)
        VALUES(?,?,?,?,?,'matched','manual-admission',CURRENT_TIMESTAMP)`).run(input.creatorId,path.resolve(input.rootPath),input.creatorFolderName,creatorPath,input.creatorFolderName).lastInsertRowid);
      const existing = this.database.prepare('SELECT id,work_id FROM archive_catalog_local_works WHERE local_creator_folder_id=? AND relative_path=?').get(folderId,relative) as {id:number;work_id:number|null}|undefined;
      if (existing) throw new Error('Target local directory already has an identity; use its existing plan');
      const localId = Number(this.database.prepare(`INSERT INTO archive_catalog_local_works
        (local_creator_folder_id,work_id,relative_path,absolute_path,folder_name,match_status,match_method,scanned_at,identity_policy,provenance_json)
        VALUES(?,?,?,?,?,'matched','manual-admission',CURRENT_TIMESTAMP,?,?)`).run(folderId,workId,relative,path.resolve(input.absolutePath),relative,input.localOnly?'local_only':'manual',JSON.stringify({origin:'local-admission',key:input.key,acceptExistingVersion:input.acceptExistingVersion===true})).lastInsertRowid);
      this.database.prepare("UPDATE archive_catalog_works SET title_policy='manual' WHERE id=?").run(workId);
      const decisionId = this.decision(input.key,'same_work',workId,localId,input.sourceWorkId??null,input.reason,input);
      return {workId,localWorkId:localId,decisionId};
    });
  }

  attachPost(localWorkId: number, postId: number): void {
    const post=this.database.prepare('SELECT source_path FROM posts WHERE id=? AND is_deleted=0 AND is_trashed=0').get(postId) as {source_path:string}|undefined;
    if (!post) throw new Error('Usable Post not found');
    const owner=this.database.prepare(`SELECT lw.absolute_path,lf.root_path FROM archive_catalog_local_works lw
      JOIN archive_catalog_local_creator_folders lf ON lf.id=lw.local_creator_folder_id WHERE lw.id=?`).get(localWorkId) as {absolute_path:string;root_path:string}|undefined;
    if (!owner || path.relative(owner.root_path,owner.absolute_path).split(path.sep).join('/') !== post.source_path) throw new Error('Post path does not match the explicit local copy');
    const local = this.database.prepare('SELECT work_id,post_id FROM archive_catalog_local_works WHERE id=?').get(localWorkId) as {work_id:number;post_id:number|null}|undefined;
    if (!local || (local.post_id !== null && local.post_id !== postId)) throw new Error('Local Post identity conflict');
    if (this.database.prepare('SELECT id FROM archive_catalog_local_works WHERE post_id=? AND id<>?').get(postId,localWorkId)) throw new Error('Post already belongs to another local copy');
    this.database.prepare('UPDATE archive_catalog_local_works SET post_id=? WHERE id=?').run(postId,localWorkId);
    const count = this.database.prepare('SELECT COUNT(*) n FROM archive_catalog_local_works WHERE work_id=?').get(local.work_id) as {n:number};
    if (count.n === 1) this.database.prepare('UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=? AND primary_local_work_id IS NULL').run(localWorkId,local.work_id);
  }

  choosePrimary(localWorkId: number, reason: string): void {
    if (!reason.trim()) throw new Error('Primary choice reason required');
    const local = this.database.prepare('SELECT work_id FROM archive_catalog_local_works WHERE id=? AND is_active=1 AND post_id IS NOT NULL').get(localWorkId) as {work_id:number}|undefined;
    if (!local) throw new Error('Usable indexed local copy required');
    const previous = this.database.prepare('SELECT primary_local_work_id FROM archive_catalog_works WHERE id=?').get(local.work_id) as {primary_local_work_id:number|null};
    if (previous.primary_local_work_id === localWorkId) return;
    this.decision(randomUUID(),'primary_copy',local.work_id,localWorkId,null,reason,{previousLocalId:previous.primary_local_work_id,localWorkId});
    this.database.prepare('UPDATE archive_catalog_works SET primary_local_work_id=? WHERE id=?').run(localWorkId,local.work_id);
  }

  excludeSource(localWorkId: number, sourceWorkId: number, reason: string, key: string): number {
    const local = this.database.prepare('SELECT work_id FROM archive_catalog_local_works WHERE id=?').get(localWorkId) as {work_id:number}|undefined;
    if (!local) throw new Error('Local copy not found');
    const source = this.database.prepare('SELECT work_id FROM archive_catalog_source_works WHERE id=?').get(sourceWorkId) as {work_id:number}|undefined;
    if (!source) throw new Error('Source not found');
    if (source.work_id === local.work_id) throw new Error('Exclusion conflicts with existing identity; revoke or correct the mapping first');
    const decisionId=this.decision(key,'different_work',local.work_id,localWorkId,sourceWorkId,reason,{localWorkId,sourceWorkId,reason});
    this.database.prepare("UPDATE archive_catalog_local_works SET identity_policy='local_only' WHERE id=? AND identity_policy='auto'").run(localWorkId);
    return decisionId;
  }

  bindSource(input: {workId:number;collectionId:number;sourceWorkId:string;reason:string;key:string}): number {
    const work = this.database.prepare('SELECT creator_id FROM archive_catalog_works WHERE id=?').get(input.workId) as {creator_id:number}|undefined;
    const collection = this.database.prepare('SELECT creator_id FROM archive_catalog_collections WHERE id=?').get(input.collectionId) as {creator_id:number}|undefined;
    if (!work || !collection || work.creator_id !== collection.creator_id) throw new Error('Source creator conflicts with Work');
    const source = this.database.prepare('SELECT id,work_id FROM archive_catalog_source_works WHERE collection_id=? AND source_work_id=?').get(input.collectionId,input.sourceWorkId) as {id:number;work_id:number}|undefined;
    if (source && source.work_id !== input.workId) throw new Error('Existing Work merge is not supported');
    const decisionId = this.decision(input.key,'source_binding',input.workId,null,source?.id??null,input.reason,input);
    const existing = this.database.prepare('SELECT work_id FROM archive_catalog_source_bindings WHERE collection_id=? AND source_work_id=?').get(input.collectionId,input.sourceWorkId) as {work_id:number}|undefined;
    if (existing && existing.work_id !== input.workId) throw new Error('Existing explicit source mapping conflicts');
    this.database.prepare('INSERT INTO archive_catalog_source_bindings(collection_id,source_work_id,work_id,decision_id) VALUES(?,?,?,?) ON CONFLICT(collection_id,source_work_id) DO UPDATE SET decision_id=excluded.decision_id').run(input.collectionId,input.sourceWorkId,input.workId,decisionId);
    this.database.prepare("UPDATE archive_catalog_works SET title_policy='manual' WHERE id=?").run(input.workId);
    return decisionId;
  }

  revoke(decisionId: number, reason: string): void {
    if (!reason.trim()) throw new Error('Revocation reason required');
    const decision = this.database.prepare('SELECT kind,local_work_id,work_id,source_work_id,payload_json FROM archive_catalog_work_decisions WHERE id=?').get(decisionId) as {kind:string;local_work_id:number|null;work_id:number|null;source_work_id:number|null;payload_json:string}|undefined;
    if (!decision) throw new Error('Decision not found');
    if (decision.kind === 'primary_copy') throw new Error('Choose an explicit replacement primary copy; primary revocation cannot silently select a fallback');
    this.database.exec('SAVEPOINT revoke_identity');
    try {
      this.database.prepare("UPDATE archive_catalog_work_decisions SET state='revoked',revoked_at=CURRENT_TIMESTAMP,revoked_reason=? WHERE id=?").run(reason,decisionId);
      this.database.prepare("UPDATE archive_catalog_local_fulfillments SET state='revoked',revoked_at=CURRENT_TIMESTAMP,revoked_reason=? WHERE decision_id=?").run(reason,decisionId);
      if (decision.kind === 'unique_name') {
        this.database.prepare(`UPDATE archive_catalog_local_fulfillments SET state='revoked',revoked_at=CURRENT_TIMESTAMP,revoked_reason=?
          WHERE source_work_id=? AND local_work_id=? AND work_id=? AND state='active'`)
          .run(reason,decision.source_work_id,decision.local_work_id,decision.work_id);
      }
      if (decision.kind === 'source_binding') {
        this.database.prepare(`UPDATE archive_catalog_local_fulfillments SET state='revoked',revoked_at=CURRENT_TIMESTAMP,revoked_reason=?
          WHERE work_id=? AND source_work_id IN (
            SELECT s.id FROM archive_catalog_source_works s
            JOIN archive_catalog_source_bindings b ON b.collection_id=s.collection_id
              AND b.source_work_id=s.source_work_id AND b.work_id=s.work_id
            WHERE b.decision_id=? AND b.work_id=?
          ) AND state='active'`)
          .run(reason,decision.work_id,decisionId,decision.work_id);
      }
      // Keep local identity, but stop interpreting a revoked association as permission to rematch.
      if (decision.local_work_id !== null && decision.kind === 'same_work') {
        this.database.prepare("UPDATE archive_catalog_local_works SET identity_policy='local_only' WHERE id=?").run(decision.local_work_id);
        this.database.prepare("UPDATE archive_catalog_local_fulfillments SET state='revoked',revoked_at=CURRENT_TIMESTAMP,revoked_reason=? WHERE local_work_id=? AND state='active'").run(reason,decision.local_work_id);
      }
      this.database.exec('RELEASE revoke_identity');
    } catch(error) { this.database.exec('ROLLBACK TO revoke_identity; RELEASE revoke_identity'); throw error; }
  }
}
