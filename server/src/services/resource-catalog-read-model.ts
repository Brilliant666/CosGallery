import type { DatabaseSync } from 'node:sqlite';
import { ResourceCatalogBuilder, type Snapshot } from './resource-catalog-builder.js';

export const RESOURCE_CATALOG_RULE_VERSION = 1;
export interface PreparedResourceCatalog {
  creatorId: number;
  generation: number;
  snapshot: Snapshot | null;
  aliases: string;
  related?: PreparedResourceCatalog[];
}

/** Derived data only. Neither generation nor publication changes business facts. */
export class ResourceCatalogReadModel {
  constructor(private readonly db: DatabaseSync) {}

  pending(limit = 1): number[] {
    return this.db.prepare(`SELECT creator_id FROM resource_catalog_state
      WHERE (generation<>built_generation OR rule_version<>?)
      AND rule_version<=?
      AND (retry_after IS NULL OR retry_after<=?)
      ORDER BY EXISTS (SELECT 1 FROM resource_catalog_rows r LEFT JOIN archive_catalog_works w ON w.id=r.work_id
        WHERE r.creator_id=resource_catalog_state.creator_id AND (w.id IS NULL OR w.creator_id<>r.creator_id)) DESC,
        creator_id LIMIT ?`)
      .all(RESOURCE_CATALOG_RULE_VERSION, RESOURCE_CATALOG_RULE_VERSION, new Date().toISOString(), limit)
      .map(row => Number(row.creator_id));
  }

  prepare(creatorId: number): PreparedResourceCatalog {
    // This read transaction captures both the generation and all dependent facts.
    this.db.exec('BEGIN');
    try {
      const capture = (id: number): PreparedResourceCatalog => {
        const generation = this.db.prepare('SELECT generation,rule_version FROM resource_catalog_state WHERE creator_id=?').get(id);
        if (!generation) throw new Error('Catalog creator state not found');
        if (Number(generation.rule_version) > RESOURCE_CATALOG_RULE_VERSION) throw new Error('Catalog rule version is newer than this updater');
        const creator = this.db.prepare('SELECT canonical_name FROM archive_catalog_creators WHERE id=?').get(id);
        return { creatorId: id, generation: Number(generation.generation),
          snapshot: creator ? new ResourceCatalogBuilder(this.db).generate(id) : null,
          aliases: creator ? [String(creator.canonical_name), ...this.db.prepare(
            'SELECT alias FROM archive_catalog_creator_aliases WHERE creator_id=? ORDER BY source,normalized_alias,alias',
          ).all(id).map(row => String(row.alias))].join('\n').toLocaleLowerCase() : '' };
      };
      const prepared = capture(creatorId);
      const group = new Map<number, PreparedResourceCatalog>([[creatorId, prepared]]);
      // Work ownership can move in either direction, including a swap. Capture the
      // old publication-owner closure in this same read snapshot, then replace it
      // atomically rather than stealing rows or waiting in a dependency cycle.
      for (const member of group.values()) {
        for (const row of member.snapshot?.page.items ?? []) {
          const old = this.db.prepare('SELECT creator_id FROM resource_catalog_rows WHERE work_id=?').get(row.workId);
          if (old && !group.has(Number(old.creator_id))) {
            const related = capture(Number(old.creator_id)); group.set(related.creatorId, related);
          }
        }
      }
      prepared.related = [...group.values()].filter(item => item !== prepared);
      this.db.exec('COMMIT');
      return prepared;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  publish(prepared: PreparedResourceCatalog): boolean {
    const group = [prepared, ...(prepared.related ?? [])];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { creatorId, generation } of group) {
      const current = this.db.prepare('SELECT generation,built_generation,rule_version FROM resource_catalog_state WHERE creator_id=?').get(creatorId);
      // An independent CLI/connection may have changed facts since the read ended.
      if (!current || Number(current.generation) !== generation || Number(current.rule_version) > RESOURCE_CATALOG_RULE_VERSION ||
          (Number(current.built_generation) === generation && Number(current.rule_version) === RESOURCE_CATALOG_RULE_VERSION)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      }
      const owners = new Set(group.map(item => item.creatorId));
      for (const { snapshot } of group) {
      if (snapshot) {
        const owner = this.db.prepare('SELECT creator_id FROM resource_catalog_rows WHERE work_id=?');
        if (snapshot.page.items.some(row => {
          const existing = owner.get(row.workId);
          return existing && !owners.has(Number(existing.creator_id));
        })) {
          this.db.exec('ROLLBACK');
          return false;
        }
      }
      }
      for (const { creatorId } of group) {
      this.db.prepare('DELETE FROM resource_catalog_rows WHERE creator_id=?').run(creatorId);
      }
      for (const { creatorId, generation, snapshot, aliases } of group) {
      if (snapshot) {
        const insert = this.db.prepare(`INSERT INTO resource_catalog_rows
          (work_id,creator_id,no_number,sort_timestamp,primary_post_id,local_state,has_source,search_text,row_json,copies_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        for (const row of snapshot.page.items) {
          const copies = snapshot.copies.get(row.workId) ?? [];
          insert.run(row.workId, creatorId, row.no ? Number(row.no.slice(3)) : null,
            row.sortTimestamp, row.primaryPostId, row.localState, Number(row.sources.length > 0),
            [row.title, row.no ?? '', ...copies.map(copy => copy.directoryName)].join('\n').toLocaleLowerCase(),
            JSON.stringify(row), JSON.stringify(copies));
        }
        this.db.prepare(`UPDATE resource_catalog_state SET built_generation=?,rule_version=?,revision=?,
          generated_at=?,creator_name=?,aliases_text=?,summary_json=?,gaps_json=?,last_error=NULL,
          failed_generation=NULL,retry_after=NULL WHERE creator_id=?`).run(generation, RESOURCE_CATALOG_RULE_VERSION,
          snapshot.page.revision, new Date().toISOString(), snapshot.page.creator.canonicalName, aliases,
          JSON.stringify(snapshot.page.summary), JSON.stringify(snapshot.page.legacyGaps), creatorId);
      } else {
        // A deleted creator's complete publication is removed atomically, including its rows.
        this.db.prepare('DELETE FROM resource_catalog_state WHERE creator_id=?').run(creatorId);
      }
      }
      this.db.prepare('UPDATE resource_catalog_meta SET publication=publication+1 WHERE id=1').run();
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  rebuildCreator(creatorId: number): boolean {
    const generation = Number(this.db.prepare('SELECT generation FROM resource_catalog_state WHERE creator_id=?').get(creatorId)?.generation);
    try {
      return this.publish(this.prepare(creatorId));
    } catch (error) {
      // Keep the last complete rows. Changed facts get a fresh attempt immediately;
      // a persistent failure retries in the worker without requiring a user click.
      this.db.prepare(`UPDATE resource_catalog_state SET last_error=?,failed_generation=?,retry_after=?
        WHERE creator_id=? AND generation=? AND rule_version<=?`).run('目录更新失败，后台将重试。', generation,
          new Date(Date.now() + 30_000).toISOString(), creatorId, generation, RESOURCE_CATALOG_RULE_VERSION);
      throw error;
    }
  }
}
