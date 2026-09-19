# Resource catalog startup lock fix

PR32 introduced an independent SQLite catalog worker before synchronous gallery
startup checks. Even when scans are skipped, those checks remove obsolete
`app_settings` rebuild markers. The production failure occurred at this DELETE
after HTTP listening was announced. The worker had already published one creator.
The main connection had no busy timeout; the worker alone had a 5-second timeout.

## Bounded fix

- Run synchronous gallery startup checks before listening and before starting the
  worker. Their errors reach the existing bootstrap failure handler; no false
  HTTP-ready log is emitted. An enabled gallery scan is still queued asynchronously.
- Start the catalog worker after local startup recovery/compensation completes or
  its existing failure handler logs the error. HTTP does not wait for an enabled
  compensation scan. A blocked gallery still skips local startup as before, but
  starts the independent catalog updater.
- Configure each application database connection with `busy_timeout=5000`, matching
  the worker. This tolerates short independent writer transactions, not unlimited
  waits or transparent retries of all transaction-upgrade failures.
- Catch synchronous worker construction failure without crashing HTTP or producing
  an unhandled rejection. Pending generations remain; no completion is fabricated.
  Existing worker shutdown guards still prevent late startup callbacks restarting
  a stopped updater.

No migration, journal-mode change, fact repair, scan policy change, or catalog rule
change. Existing 000022 data and pending generations are retained. Production was
not restarted or modified for these tests; release acceptance remains incomplete.

## Validation

Behavior tests import the actual entry point with isolated dependencies to check
startup order, blocked/error branches and HTTP readiness while local scanning is
pending. Separate tests use real temporary SQLite connections and a worker thread
to hold/release locks, verify bounded failure and connection reopening. Existing
catalog publication, migration, startup and local ingestion tests remain applicable.
