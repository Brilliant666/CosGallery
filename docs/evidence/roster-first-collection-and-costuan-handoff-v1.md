# Roster-first collection and Costuan handoff V1

## Scope and production boundary

This change adds explicitly selected canonical creators to the **existing** Stage 1 metadata task table. It does not run a production acquisition, reload the user's extension, deploy to 4141, or merge either PR. Stage 2 still stages missing archives; the user downloads them; the existing Stage 3 remains the ingest executor.

Bases: CosGallery `9b1eecac24ee0be0f775c6741f8ed31f54dfe142`, Script `84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6` (extension 0.6.10). Independent worktrees are used for all builds. The production worktree's existing `CONTRIBUTING.md` change is preserved.

## Bounded audit

The previous management list was a read of metadata tasks, but “plan local-only” created tasks only for already-local creators. Legacy extension acquisition claimed a count rather than explicit IDs, matched jobs by normalized display names, and could shortcut a historical `saved` record. Completion imported source data before separately completing its task. Batch finalize called the global catalog refresh. The options table read the legacy creator list, while some task results lived in the separate metadata queue; a runtime message alone did not provide storage/reopen/visibility synchronization. These are inspected call-path findings, not an assumption about browser cache.

New call chain:

1. Read candidates / search canonical names and recorded aliases (GET; no planning).
2. Submit explicitly checked `creatorIds` using the shared selector (admin capability + CSRF intent).
3. Copy the returned fixed task-ID handoff to the extension; start explicitly. Cancelling or refreshing does not execute anything.
4. Bridge v3 claims only supplied task IDs and rechecks active identity. Existing local-only planning is retained; legacy unscoped claims cannot take new explicit tasks.
5. Validate the independent Costuan collection identity and persistent ownership before cloud save/import. Canonical name, manual aliases, rating, preference, activation and preferred folder are not overwritten.
6. Complete imports and stores a receipt atomically. Exact receipt replay is read-only; another worker, altered payload or stale claim `expectedAttempt` is rejected.
7. Strict `/metadata-tasks/finalize-selected` validates the task/creator/worker set and plans only that scope. Its empty body cannot fall back to legacy global finalize.
8. Existing Stage 2 and Stage 3 handle precise missing files and canonical first-directory ingestion.

Metadata acceptance (A), complete cloud source availability (B), and Stage 2 staged files (C) remain separate facts. Metadata-only results have an explicit delivery-repair action. Historical evidence is labelled as historical, not fresh verification. Failed/not-found/cancelled tasks need an explicit retry; repeated selection does not reset them.

No migration: existing `app_settings` stores a small per-metadata-task explicit-selection marker and replay receipt. Task identity, status and execution remain in the original task table. No new queue or scheduler is introduced.

## Compatibility / enablement

| Server | Extension | Behaviour |
|---|---|---|
| New | 0.6.10 | Legacy flows retained; cannot claim explicitly selected tasks. Use the new extension for the new entry. |
| Old | 0.7.0 | New selected flow rejects missing v3 capability. No fallback to unscoped acquisition or the imported legacy list. |
| New | 0.7.0 | Fixed selection, source preflight, receipt replay and scoped finalization. |

Deploy the server first, then load the new extension after user authorization. Existing independent-list workflows/history are retained separately. Stage 1/2 refresh uses completion events, storage changes and visibility reads, not interval polling. Existing Stage 3 ten-second active-operation polling is unchanged.

## Reproducible isolated integration harness

`server/test/fixtures/roster-first-runtime.mjs` runs the actual server in a fresh Node process with all five storage paths fixed **before** application imports. It rejects a non-fixture temporary root or a production port. The seed is synthetic and separate from production. The initial fixture-only scan creates the partially local regression baseline; subsequent first-collection work must be scoped.

Run from `server/` using the chosen Node executable and `--import tsx`, passing a freshly created OS temporary directory prefixed `cosgallery-roster-e2e-`, an isolated 4401–4899 port and `seed` only for the first launch. Supply `ROSTER_E2E_7ZIP` explicitly. Build the client in the worktree first. Later restarts omit `seed`.

`server/test/fixtures/roster-first-browser.cjs` accepts that same root/URL and a phase (`select`, `plugin`, `ingest`, `restart`; optional `source` / `staging` for debugging). Supply `ROSTER_E2E_PLAYWRIGHT` (installed Playwright module), `ROSTER_E2E_PLUGIN_FIXTURE` (paired Script `tests/helpers/page-fixtures.cjs`) and the 7-Zip executable. It runs real Vue selection and HTTP bridge requests against the temporary service. Credentials are temporary and stay in the ignored fixture directory, never in evidence or commits. Both launchers resolve the temporary root to its real path, avoiding Windows short/long-path mismatches in fixture configuration.

Website responses are local Costuan/Baidu DOM fixtures, not live websites. They exercise the real extension background and content scripts; unknown network hosts are blocked. Download is simulated by creating an actual encrypted two-layer 7z with synthetic media. Stage 3 uses actual integrity tests, extraction, commit, creator-scoped scanner and reconciliation. The recycle adapter moves only fixture inbox/processing paths to a fixture recycle directory; it never calls the Windows Recycle Bin.

## Real candidate preview (read-only)

`creatorId=167`, `3mime`: enabled, liked, R15. At audit time there are no directory bridges (including inactive history), no canonical works or Costuan collection, and no other creator alias matching its recorded identity. The historical HentaiClub identity source is retained. Live Costuan availability, collection size and Baidu directory have **not** been checked or guessed.

After enablement, the user can select this creator in Stage 1 (or its roster detail), copy the fixed task scope into the extension, and confirm source acquisition. Once exact missing files are staged, the user downloads the creator folder through the Baidu client, then invokes Stage 3. A truly new creator's first physical folder is created only at commit; it is not created by selection. No task has been created for this candidate in production.

## Validation results

Integration and final publication results are recorded below after execution; no production-first-collection success is implied by fixture results.

- Final local server suite: **90 files, 538 passed, 2 skipped**, including existing migration regressions; server TypeScript build passed. The two existing environment-specific skips are not represented as executed.
- Client suite: **59 files, 365 passed**; production Vue TypeScript check and Vite build passed. Scoped selector/API/roster/Stage3 visibility regressions are included.
- Final opt-in cross-repository run: real selection/cancel UI → one fixed Stage 1 task → independent extension with no legacy roster → two source works → one simulated cloud save. The first successful HTTP completion response was intentionally discarded; the exact receipt was resent and save clicks remained **1**.
- Stage 2 single-creator seeded continuation copied exactly `002.7z` and `001.7z`, not fixture `999.7z`. Both tasks became `staged`. No fixture page errors or non-fixture external requests were recorded in the final run.
- Actual encrypted two-layer 7z containing one synthetic JPEG and one synthetic advertisement was downloaded to the fixture inbox, then processed by the existing Stage 3 HTTP entry. Job 1 became `ingested / done / passed / recycled`, attemptCount **1**; one canonical directory bridge and one matched local work were created. The simulated recycle directory contains only the outer archive and processing directory.
- Source work 001 is `ingested`; 002 remains `staged`. The pre-existing partial creator keeps its original local 001 and only its genuine 002 missing task. Full-row hashes for seven unrelated creator-scoped business tables stayed identical, including the unrelated pending Stage 1 task.
- Repeated selection returns `source_ready`; repeated inbox discovery creates no duplicate job and does not rerun Job 1. A separate Node restart preserves all jobs, source rows, download tasks, directory bridges and scan runs, with both startup paths reporting no scan/queue execution.
- The restarted browser reached `/library/1/works/2`, loaded the actual synthetic thumbnail, and showed the same canonical R18 creator with one work. Screenshots and row evidence remain in the ignored temporary fixture directory, not the repository.
- `git diff --check` and manual harness syntax checks passed. No new migration is required; the fresh fixture migrates to **000017**.

Production runtime observation: at 23:48 local time on September 7, the original 4141 listener/PID 83312 was absent. No production stop/start command was issued in this task. The user reported a possible Codex desktop crash; that is a plausible explanation, not a verified causal finding. The read-only checkpoint still matched all 29 database-table hashes, both production dist trees, the original CONTRIBUTING change and Script state. This task does not restart production.
