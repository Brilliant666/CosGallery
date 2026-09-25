# Unified creator sync: check rounds and isolated full-chain evidence

Date: 2026-09-08. This evidence covers the current uncommitted implementation in the existing CosGallery / Script feature worktrees, including the final source-save safety changes. It is not evidence of a production deployment or real Costuan/Baidu execution.

## Round and receipt design

No new migration, task engine or parallel source table is introduced. The existing metadata task remains the stable task identity; these small contexts use `app_settings`:

- `archive.metadata-task.context.<taskId>`: explicit selection, current `checkRoundId`, request identifier, current receipt, finalized result and previous round history (attempt, round, terminal status/error and receipt).
- `archive.metadata-check.request.<sha256(requestId)>`: the normalized creator scope and the exact task/round references returned for that submission.

The same request/scope replays its round. A completed replay does not open another round; a later explicit request can reopen a completed check. Pending/claimed tasks are reused. A reused request with a different scope or superseded round is rejected rather than silently targeting newer work.

Claim requires the exact `taskId + checkRoundId` for new-round tasks. Results require the original worker and `expectedAttempt`. Receipt IDs and checksums make an acknowledged result replayable without reimporting; previous receipt IDs cannot be reused for a newer attempt. Historical receipts remain traceable in the task context. Failed/not-found checks do not delete the previously accepted source.

The read-only `validate-directory` preflight validates creator/collection identity, complete raw directory parsing, declared count, numbering identities, filename collisions and conflicts with the existing source before cloud mutations. `sourceFilenames` represents the complete validated source; `requiredFilenames` represents the files still needed by the local difference. A unique active matched Source Work / Local Work identity with a readable safe local directory is excluded from replenishment; an unresolved, ambiguous, offline or unsafe registered local state fails closed rather than becoming zero local works. The requirement can be an explicitly validated empty array. Completion still requires current-round own-cloud directory evidence covering that required set; historical `alreadySaved` alone is insufficient. Missing historical cloud packages for already ingested works are not restored merely to rebuild a full cloud mirror.

Finalization requires explicit creator/task/attempt scope. The exact finalized result is persisted for idempotent replay. A `WeakMap<DatabaseSync, Set<taskId>>` prevents duplicate finalization or reopening while the asynchronous scoped handoff is running on the same server connection. It is **not a cross-process or cross-connection lease**. Claim/attempt checks are repeated before storing the result. Existing scoped pipeline transactions are retained; this change does not promise an atomic transaction spanning filesystem reads and all later reconciliation steps.

## Executed isolation boundary

Final rerun root (outside Git):

`%LOCALAPPDATA%\Temp\cosgallery-unified-e2e-5572ba5ca9c2490dbb7bf4b0b11795be`

The fixture root must be a real, direct OS-temp child with the `cosgallery-unified-e2e-` prefix; otherwise the runner rejects it. `DATA_ROOT`, `DB_DIR`, `GALLERY_ROOT`, `THUMBNAILS_DIR` and `PREVIEWS_DIR` all resolve below that root. Inbox, processing, generated archives and simulated recycle destinations also stay below it.

- App endpoint: `http://127.0.0.1:4486`, production-mode **isolated source runtime**, not production 4141.
- Node: explicit project-verified Node 24 executable; no fallback to system Node.
- Database: fresh schema through `000017`; no production database copy or connection.
- Browser: separate headless Chromium context. The real plugin background harness and content script handle intercepted synthetic Costuan/Baidu pages. All browser external network requests are rejected/intercepted; only bridge calls reach the isolated local app.
- Media: four newly generated JPEGs packed into real password-protected outer `.7z` / inner `.7zz` archives using 7-Zip. Stage3 executes the actual validation, dual extraction, commit, scoped scan, reconciliation and cleanup services.
- Cleanup adapter: temporary-directory rename into `simulated-recycle`, never the Windows Recycle Bin.
- Startup: existing seeded fixture index reused, and `LOCAL_INGEST_STARTUP_SCAN=false`. Both initial app startup and fresh-process restart reported no startup scan.

The seed includes one unrelated creator/source/local work and 588 explicitly synthetic completed historical Job rows with preserved warnings. These are not production records or copied production evidence. The single initial full scan is fixture setup only; four subsequent scans are the actual creator-scoped ingest scans.

## Final full-chain rerun result

Both `cycle` and fresh-process `restart` commands exited **0** with the final source-save safety and local-difference changes. The additional fail-closed guard for an unresolved registered Local Work was unit-tested after the cycle runtime had loaded; that exceptional branch is not present in this fully matched E2E dataset, and the restart loaded the added guard.

| Phase | Observed result |
| --- | --- |
| First explicit check | Current directory contained 3 source works; 3 missing tasks; no empty target creator directory created by planning |
| First Stage2 | Precisely copied `001.7z`, `002.7z`, `003.7z` into synthetic cloud inbox |
| First Stage3 | 3 original synthetic archives actually dual-extracted and ingested; 3 unique matched local works |
| Later explicit refresh | After removing historical `001.7z` from the synthetic cloud while retaining its ingested local work, a different round reread a 4-work source; source save selected only `004.7z`; `001.7z` was not restored; only the new missing download task was created |
| Incremental Stage2/3 | Only `004.7z` copied and ingested; original 3 Job rows, task rows and local identities preserved |
| No-change explicit refresh | Costuan and own-cloud file list reread with an explicitly empty required file set; no new save/copy, missing task, local work or Job |
| Repeat inbox discovery | No completed Job recreated or reexecuted |
| Fresh-process restart | All 592 Job rows and complete captured business tables unchanged; 4 target local works; zero new startup scans |

Concrete plugin evidence: `collectionReads=3`, `sourceReads=6`, `saveClicks=1`, source saves `[[001,002,003],[004]]`, Stage2 copies `[[003,002,001],[004]]`; errors and external request lists were empty.

All 4 new Jobs ended `ingested / done / passed / recycled`, `attemptCount=1`. Eight synthetic cleanup entries were created (4 source packages and 4 processing directories). `quick_check=ok`; `foreign_key_check` returned no rows.

Complete-row hashes before/after matched for the unrelated creator's creator rows, local folders, local works, works, source works, metadata tasks, download tasks and all 588 synthetic historical Jobs. The historical Job hash was `45f326a2d53c6b01934bbb42bf3cd3d57a7ba1b1eeb10d9a9e2dffc93a999752` at both ends. The restart additionally compared complete rows for all Jobs, download tasks, source works, local works, folder bridges, Posts, Post Items and Scan Runs.

Local raw artifacts are `unified-evidence.json`, `unified-restart-before.json`, `unified-protected-before.json` and `unified-restart-evidence.json` under the temporary root. They are intentionally not committed. No token, database, full runtime export, archive or media is included in this document.

The final isolated process was stopped after confirming its exact Node executable and fixture-root command line; port 4486 had **0 listeners** afterward. Production 4141, production databases, all G-drive directories, the original loaded extension and the real Recycle Bin were not operated on.

## Reproduction

Run from this worktree's `server/`, with a newly created OS-temp root and a free isolated 4401–4899 port. Supply installed dependencies explicitly; do not install or fall back during a test:

```powershell
$node = 'C:\Users\ExampleUser\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:ROSTER_E2E_7ZIP = 'C:\Program Files\NVIDIA Corporation\NVIDIA app\7z.exe'
$env:ROSTER_E2E_PLAYWRIGHT = 'C:\Users\ExampleUser\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:ROSTER_E2E_PLUGIN_FIXTURE = 'C:\Users\ExampleUser\Documents\ChatGPT\插件\Script-task-display\CostuanArchiveManager\tests\helpers\page-fixtures.cjs'
# $fixtureRoot is an explicitly created, fresh OS-temp cosgallery-unified-e2e-* directory.
& $node --import tsx test/fixtures/unified-creator-sync-runtime.mjs $fixtureRoot 4486 seed
# In another terminal with the same explicit dependency variables:
& $node test/fixtures/unified-creator-sync-browser.cjs $fixtureRoot http://127.0.0.1:4486 cycle
# Stop only the identity-verified fixture process, then restart without seed:
& $node --import tsx test/fixtures/unified-creator-sync-runtime.mjs $fixtureRoot 4486
& $node test/fixtures/unified-creator-sync-browser.cjs $fixtureRoot http://127.0.0.1:4486 restart
```

Service regression command executed successfully: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/creator-source-check-rounds.test.ts test/roster-first-collection-service.test.ts test/archive-catalog-service.test.ts test/archive-metadata-legacy-identity.test.ts` (67/67), using the explicit Node above. TypeScript `--noEmit`, fixture JavaScript syntax checks and `git diff --check` also passed. Project-wide final checks and PR evidence are recorded by the main task separately.

Final verification after the local-difference guards: server 93 files / 594 passed / 2 pre-existing skipped (video tests requiring absent fixture FFmpeg/FFprobe); server TypeScript/build passed; plugin 100/100 with no skips (including five source-save safety DOM tests); client 375/375 with production Vue TypeScript/build passed. No production builds were overwritten. Script feature Head is `ca481d1fe43e311b8342381a3c2b0409ea0189d2`; it has no existing GitHub Actions checks. CosGallery final-Head Verify is tracked on the existing PR19, not replaced with an older successful run.

## Limits

This proves the cross-repository protocol, real synthetic content automation and actual isolated ingest pipeline; it does not certify today's real Costuan/Baidu DOM, login, account permissions or cloud performance. It uses synthetic JPEGs, not the user's archives. Synthetic recycle verifies cleanup scope/idempotency without testing Windows shell recycling. No production task is authorized or executed by these runners.
