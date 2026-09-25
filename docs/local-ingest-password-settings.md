# Local ingest password settings

The management-only Stage 3 settings endpoint accepts `archivePassword` and
`clearArchivePassword`. Omitted or empty password input preserves the current
secret. An explicit clear disables the saved password **and environment
fallback**. A later non-empty password replaces it. A clear and a non-empty
replacement cannot be submitted together. Passwords are not trimmed; newline,
NUL and values over 1,024 characters are rejected.

If no local decision exists, `LOCAL_INGEST_ARCHIVE_PASSWORD` remains the fallback.
Settings/list APIs expose only `archivePasswordConfigured`,
`archivePasswordSource` (`environment`, `local`, `none`) and
`archivePasswordOverride` (`inherit`, `local`, `cleared`). The legacy management
`GET /api/admin/local-ingest/archive-password` endpoint is retired: it returns
410 `PASSWORD_READ_RETIRED` with `Cache-Control: no-store`, never the password.
Ciphertext and encryption keys are never returned. Changing
the password does not scan, extract, execute a job or rewrite job history.
Environment validation checks the saved effective password, not an unsaved
password input. All settings mutations use the existing management capability,
same-origin mutation protections and Stage 3 operation exclusivity.

The editor never fetches or prefills the existing value. The empty replacement
field preserves the current decision; a non-empty new value replaces it. Only
the separate explicit-clear checkbox disables the saved password and environment
fallback. Opening settings, emptying the replacement input, or saving other
settings does not clear the password or create an override. Canceling/closing
discards both replacement and clear intent. The value is not
placed in URLs, ordinary status payloads, logs or exported reports.

The local secret is AES-256-GCM authenticated ciphertext in the existing
`app_settings` table (`local_ingest.archive_password`), with a versioned envelope.
No migration is required. Its randomly generated key is stored separately at
`DATA_ROOT/private/local-ingest-archive-password.key`. The private directory and
key reject symbolic-link/junction targets; the key must be a single-link regular
32-byte file. Missing, malformed or unauthentic ciphertext/key fails closed,
without falling back to an environment secret. Explicit replacement/clearing can
repair the saved decision. No error includes the secret or key material.

The key uses restrictive POSIX creation modes. On Windows, protection depends on
the inherited directory/file ACL; this is **not DPAPI or a claim that POSIX modes
enforce Windows ACLs**. Keep the server data directory restricted to the service
user. Backups intended to preserve this local setting need both the database and
the separate key, protected together as sensitive recovery material; neither
belongs in Git, client assets, exports or public reports. Possession of both
permits decryption. The key is retained when clearing/replacing the password.

`PUT /api/admin/local-ingest/allowlist` accepts only `{ allowlist: string[] }` and
returns the ordinary settings view. It validates/deduplicates the list and writes
only that setting. It cannot overwrite paths, extraction options or the secret.
Appending/replacing a discovered list therefore does not silently save unrelated
form drafts. The full settings endpoint remains for the settings dialog, and
preserves the saved list when its `allowlist` field is omitted.
