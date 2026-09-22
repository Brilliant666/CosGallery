// Web drafts/dispatch receipts only. Original admission plans remain the execution ledger.
export const localAdmissionWebSchemaSql = `
CREATE TABLE IF NOT EXISTS local_admission_web_batches (
 id TEXT PRIMARY KEY, creator_id INTEGER NOT NULL REFERENCES archive_catalog_creators(id),
 input_root TEXT NOT NULL, source_evidence_id INTEGER,
 state TEXT NOT NULL CHECK(state IN ('draft','queued','running','completed','needs_review','failed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
 context_json TEXT NOT NULL, confirmed_json TEXT, owner_pid INTEGER, owner_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_admission_web_creator ON local_admission_web_batches(creator_id,created_at DESC);
CREATE TABLE IF NOT EXISTS local_admission_web_items (
 batch_id TEXT NOT NULL REFERENCES local_admission_web_batches(id), item_key TEXT NOT NULL,
 position INTEGER NOT NULL, summary_json TEXT NOT NULL, preview_json TEXT,
 action TEXT NOT NULL DEFAULT 'defer', PRIMARY KEY(batch_id,item_key)
);
CREATE TABLE IF NOT EXISTS local_admission_web_requests (
 request_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES local_admission_web_batches(id),
 kind TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
