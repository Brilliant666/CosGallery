/** Detached, immutable deletion evidence. No live FK or unique name constraint. */
export const creatorDeletionSchemaSql = `
CREATE TABLE IF NOT EXISTS creator_deletion_audits (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 creator_id INTEGER NOT NULL,
 canonical_name TEXT NOT NULL,
 confirmation_token TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 deleted_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS creator_deletion_audits_no_update BEFORE UPDATE ON creator_deletion_audits
BEGIN SELECT RAISE(ABORT,'Creator deletion audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS creator_deletion_audits_no_delete BEFORE DELETE ON creator_deletion_audits
BEGIN SELECT RAISE(ABORT,'Creator deletion audit is immutable'); END;
`;
