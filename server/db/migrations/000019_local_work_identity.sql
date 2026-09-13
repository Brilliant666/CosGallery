-- migrate:up
ALTER TABLE archive_catalog_works ADD COLUMN title_policy TEXT NOT NULL DEFAULT 'auto' CHECK(title_policy IN ('auto','manual'));
ALTER TABLE archive_catalog_works ADD COLUMN primary_local_work_id INTEGER NULL REFERENCES archive_catalog_local_works(id);
ALTER TABLE archive_catalog_local_works ADD COLUMN identity_policy TEXT NOT NULL DEFAULT 'auto' CHECK(identity_policy IN ('auto','manual','local_only'));
ALTER TABLE archive_catalog_local_works ADD COLUMN post_id INTEGER NULL REFERENCES posts(id);
ALTER TABLE archive_catalog_local_works ADD COLUMN provenance_json TEXT NULL;
CREATE TABLE IF NOT EXISTS archive_catalog_work_decisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, decision_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 work_id INTEGER REFERENCES archive_catalog_works(id), local_work_id INTEGER REFERENCES archive_catalog_local_works(id),
 source_work_id INTEGER REFERENCES archive_catalog_source_works(id), reason TEXT NOT NULL, payload_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS archive_catalog_source_bindings (
 collection_id INTEGER NOT NULL REFERENCES archive_catalog_collections(id), source_work_id TEXT NOT NULL,
 work_id INTEGER NOT NULL REFERENCES archive_catalog_works(id), decision_id INTEGER NOT NULL REFERENCES archive_catalog_work_decisions(id),
 PRIMARY KEY(collection_id,source_work_id)
);
CREATE TABLE IF NOT EXISTS archive_catalog_local_fulfillments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id INTEGER NOT NULL REFERENCES archive_catalog_work_decisions(id),
 source_work_id INTEGER NOT NULL REFERENCES archive_catalog_source_works(id), local_work_id INTEGER NOT NULL REFERENCES archive_catalog_local_works(id),
 work_id INTEGER NOT NULL REFERENCES archive_catalog_works(id), task_id INTEGER REFERENCES archive_catalog_download_tasks(id),
 source_snapshot_json TEXT NOT NULL, local_snapshot_json TEXT NOT NULL, reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked','stale')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS archive_local_admission_plans (
 plan_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS archive_local_admission_items (
 plan_id TEXT NOT NULL REFERENCES archive_local_admission_plans(plan_id), item_key TEXT NOT NULL, state TEXT NOT NULL,
 manifest_json TEXT NOT NULL, work_id INTEGER REFERENCES archive_catalog_works(id),
 local_work_id INTEGER REFERENCES archive_catalog_local_works(id), last_error TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(plan_id,item_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_local_work_post ON archive_catalog_local_works(post_id) WHERE post_id IS NOT NULL;

-- migrate:down
-- Identity decisions cannot be discarded safely by an automatic downgrade.
SELECT local_identity_downgrade_requires_explicit_data_migration();
