/** Durable multi-creator orchestration; each child retains its original admission plan. */
export const localAdmissionCollectionSchemaSql = `
CREATE TABLE IF NOT EXISTS local_admission_web_collections (
 id TEXT PRIMARY KEY,
 state TEXT NOT NULL CHECK(state IN ('draft','queued','running','completed','partial')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 confirmed_json TEXT, error TEXT, owner_pid INTEGER, owner_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_admission_collection_recent ON local_admission_web_collections(created_at DESC,id);
CREATE TABLE IF NOT EXISTS local_admission_web_collection_batches (
 collection_id TEXT NOT NULL REFERENCES local_admission_web_collections(id),
 batch_id TEXT NOT NULL UNIQUE REFERENCES local_admission_web_batches(id),
 position INTEGER NOT NULL,
 PRIMARY KEY(collection_id,batch_id), UNIQUE(collection_id,position)
);
CREATE TABLE IF NOT EXISTS local_admission_web_collection_requests (
 request_key TEXT PRIMARY KEY,
 collection_id TEXT NOT NULL REFERENCES local_admission_web_collections(id),
 kind TEXT NOT NULL CHECK(kind IN ('execute','resume')),
 payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
