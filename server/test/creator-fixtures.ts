import type { DatabaseSync } from 'node:sqlite';
import { normalizeCreatorIdentity } from '../src/utils/creator-identity.js';

/** Synthetic SQL fixtures, not an external JSON import entry point. */
export function seedCreators(database:DatabaseSync, creators:Array<{name:string;preference:'liked'|'kept';rating:'R15'|'R18'|null}>) {
  for (const creator of creators) {
    const id=Number(database.prepare(`INSERT INTO archive_catalog_creators
      (canonical_name,normalized_name,preference,effective_rating,seed_source,seed_source_creator_id)
      VALUES (?,?,?,?,'fixture',?)`).run(creator.name,normalizeCreatorIdentity(creator.name),creator.preference,creator.rating,creator.name).lastInsertRowid);
    database.prepare(`INSERT INTO archive_catalog_creator_aliases(creator_id,alias,normalized_alias,source)
      VALUES (?,?,?,'fixture')`).run(id,creator.name,normalizeCreatorIdentity(creator.name));
  }
}
