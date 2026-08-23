-- migrate:up

CREATE TABLE IF NOT EXISTS folder_share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NULL,
  expires_at TEXT NULL,
  revoked_at TEXT NULL,
  allow_original_downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NULL,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_folder_share_links_folder_id
  ON folder_share_links(folder_id);

CREATE INDEX IF NOT EXISTS idx_folder_share_links_expires_at
  ON folder_share_links(expires_at);

ALTER TABLE folders
ADD COLUMN share_password_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS folder_share_passwords (
  folder_id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- migrate:down

-- Forward-only. Foldergram does not automatically roll back local user data migrations.
