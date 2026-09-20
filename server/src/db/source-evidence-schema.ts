// Private source observations and provenance, separate from authoritative Works.
// No catalog invalidation triggers: raw evidence does not change catalog facts.
export const sourceEvidenceSchemaSql = `
CREATE TABLE IF NOT EXISTS source_evidence_pages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 platform TEXT NOT NULL,
 page_key TEXT NOT NULL,
 creator_id INTEGER REFERENCES archive_catalog_creators(id),
 identity_revision INTEGER NOT NULL DEFAULT 0,
 confirmed_observation_id INTEGER,
 identity_reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 UNIQUE(platform,page_key)
);
CREATE TABLE IF NOT EXISTS source_evidence_observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 page_id INTEGER NOT NULL REFERENCES source_evidence_pages(id),
 candidate_creator_id INTEGER NOT NULL REFERENCES archive_catalog_creators(id),
 request_key TEXT NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 identity_state TEXT NOT NULL CHECK(identity_state IN ('confirmed','candidate','conflict')),
 identity_reason TEXT NOT NULL,
 parsed_json TEXT NOT NULL,
 completeness TEXT NOT NULL CHECK(completeness IN ('partial','unknown')),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_evidence_creator ON source_evidence_observations(candidate_creator_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_source_evidence_page ON source_evidence_observations(page_id,id DESC);
CREATE TABLE IF NOT EXISTS source_evidence_identity_decisions (
 request_key TEXT PRIMARY KEY,
 observation_id INTEGER NOT NULL REFERENCES source_evidence_observations(id),
 creator_id INTEGER NOT NULL REFERENCES archive_catalog_creators(id),
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_evidence_admission_links (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 link_key TEXT NOT NULL UNIQUE,
 observation_id INTEGER NOT NULL REFERENCES source_evidence_observations(id),
 creator_id INTEGER NOT NULL REFERENCES archive_catalog_creators(id),
 work_id INTEGER NOT NULL REFERENCES archive_catalog_works(id),
 local_work_id INTEGER REFERENCES archive_catalog_local_works(id),
 plan_id TEXT,
 item_key TEXT,
 entry_key TEXT,
 link_kind TEXT NOT NULL DEFAULT 'batch' CHECK(link_kind IN ('batch','exact')),
 source_work_id INTEGER REFERENCES archive_catalog_source_works(id),
 identity_decision_id INTEGER REFERENCES archive_catalog_work_decisions(id),
 reason TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_evidence_link_observation ON source_evidence_admission_links(observation_id,id);
CREATE INDEX IF NOT EXISTS idx_source_evidence_link_work ON source_evidence_admission_links(work_id,id);
`;
