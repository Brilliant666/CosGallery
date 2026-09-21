/** Web orchestration only. The original admission plan / Stage3 job remains authoritative. */
export const localReviewWebSchemaSql = `
CREATE TABLE IF NOT EXISTS local_review_web_sessions (
  id TEXT PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES archive_catalog_creators(id),
  target_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('preparing','ready','submitted','running','interrupted','completed','failed')),
  phase TEXT NOT NULL DEFAULT 'preparing',
  owner_pid INTEGER,
  title TEXT NOT NULL DEFAULT '正在读取原任务',
  total_files INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  baseline_json TEXT,
  execute_key TEXT UNIQUE,
  choices_json TEXT,
  recovery_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_review_web_target ON local_review_web_sessions(target_key, created_at);
CREATE TABLE IF NOT EXISTS local_review_web_file_actions (
  session_id TEXT NOT NULL REFERENCES local_review_web_sessions(id),
  relative_path TEXT NOT NULL,
  source_path TEXT NOT NULL,
  quarantine_path TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent','moved')),
  moved_at TEXT,
  PRIMARY KEY(session_id,relative_path)
);
`;
