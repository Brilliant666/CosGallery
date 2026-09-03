# Stage 3 exclusive operation feedback and Stage 2 handoff sync V1

## Scope

This change makes Stage 3 a server-coordinated, single-process exclusive workflow and keeps the Stage 2 cloud-to-local handoff state in sync. It does not change the two-layer extraction, atomic gallery commit, creator-scoped reconciliation, or Recycle Bin semantics. It adds no database migration; the schema remains at `000015`.

## Before-change audit

The base revision was `b78492760e413bfa7ac119eb72234c5c3ec19a68`.

The original client used one page-local `localIngestBusy` flag for the top Stage 3 buttons. It had no server operation state, so a refresh or a second browser tab lost the lock. Row-level continue and cleanup actions used a separate job ID flag and were not governed by the same exclusive boundary. The scan action also saved the current draft before scanning.

The original request chain was:

```text
scan button
  -> saveLocalIngestSettings(draft)
  -> POST /api/admin/local-ingest/scan { allowlist }
  -> LocalIngestService.scanInbox(allowlist)
  -> GET jobs?limit=100

run button
  -> POST /api/admin/local-ingest/run { allowlist }
  -> LocalIngestService.runBatch()
  -> scanInbox()
  -> serial runJob(...)
  -> GET jobs?limit=100
```

Both POST requests waited for the complete server operation, but there was no server-side mutual exclusion or progress endpoint. `runBatch()` implicitly discovered files before executing jobs. The Job API returned a flat array with a default/UI limit of 100. Stage 2 rendered `staged` as `网盘待下载`, which incorrectly implied that the browser/client download had happened. No Stage 1, Stage 2, or Stage 3 polling existed.

## Operation coordinator

`LocalIngestOperationCoordinator` owns one in-memory operation per server process. Public states are `idle`, `scanning`, and `running`; kinds distinguish scan, batch, single job, cleanup, creator discovery, settings save, validation, and recycle test.

Acquisition is synchronous before the action is started. If any operation is active, every protected entry point immediately receives HTTP 409 with code `LOCAL_INGEST_OPERATION_ACTIVE` and the current lightweight operation snapshot. Requests are never queued and never run after the first request releases its lock.

The shared boundary protects:

- inbox creator discovery;
- Stage 3 settings save;
- environment validation;
- Recycle Bin smoke test;
- inbox scan;
- batch execution;
- single-job execution/continuation;
- cleanup retry.

The coordinator releases in `finally` after success or failure. Existing Job claim, heartbeat, lease, and interrupted-process recovery remain independent safeguards. A process restart intentionally resets the coordinator to `idle`; persisted Job recovery semantics continue to identify interrupted work.

`GET /api/admin/local-ingest/operation` returns `Cache-Control: no-store`, elapsed time, a fixed-run progress summary, at most one current Job, and the last completed operation summary. It does not return passwords, tokens, media lists, or the full Job set. A refreshed page adopts this server state and remains locked while it is active.

## Stage 3 scan

Scan now uses saved settings only. An unsaved allowlist draft disables the scan button, and the scan API accepts an empty strict body. It does not save settings and does not run any Job.

The scan performs one ordinary observation pass. If candidates still need a size/mtime stability observation, the same exclusive operation waits exactly `fileStableSeconds` and performs one second observation only for those first-pass paths. It does not rescan newly appearing paths and does not wait indefinitely. Files still changing, files with temporary siblings, unmapped files, and ambiguous files do not advance Stage 2.

The response is summary-only and contains:

- discovered creators and archives;
- created and reused Jobs;
- waiting-stable and awaiting-review counts;
- `reconciledDownloadedTasks`;
- ignored items.

After a same-page scan returns, the client refreshes Stage 3 summary/current detail and Stage 2 once. It does not refresh Stage 1 or the catalog and does not poll while the original scan POST is pending. A page opened during a server-side scan polls only the lightweight operation endpoint every ten seconds until completion.

## Stage 3 run

`runBatch()` no longer calls `scanInbox()`. It takes a fixed snapshot of existing `queued`, `failed`, or `reconciling` Jobs that are not in `waiting_stable`, intersects that set with the saved allowlist and any explicit Job IDs, then executes serially. An empty set returns an empty summary without reading the inbox.

The running operation exposes total, processed, ingested, failed, awaiting-review, remaining, and the current creator/archive/phase. Common internal phases are mapped to readable Chinese labels without changing database values.

While a recovered or same-page run is active, the client polls every ten seconds for only:

- the operation snapshot;
- the currently expanded creator's current 50-row Job page.

It does not poll Stage 1, Stage 2, the full catalog, or all Jobs. Polling and the elapsed-time clock stop while the document is hidden. Visibility restoration triggers one immediate status request. `idle` has no timer.

Batch, single-job, and cleanup completion refresh Stage 3, Stage 2, the catalog summary/current page, and the currently expanded catalog creator detail while preserving filters, page, and expansion. Stage 1 is not refreshed.

## Unified Stage 3 lock and feedback

Server activity or a not-yet-confirmed local request disables every editable Stage 3 input and write action: inbox/processing/7-Zip paths, allowlist, stability seconds, recycle option, creator discovery/draft controls, save, validation, recycle test, scan, batch run, row continue, and cleanup retry. The formal gallery root remains read-only.

Buttons use real `disabled` attributes and explanatory `title` text. Operation refresh, read-only creator expansion, status filtering, and pagination remain available. A 409 response replaces optimistic client state with the authoritative server operation immediately.

The operation card shows scan/run state, elapsed time, current Job and phase, counters, last read time, and the last completed summary. Idle state explicitly states that there is no background polling.

## Stage 2 local handoff

The minimum state transition is intentionally narrow:

```text
Costuan/Baidu staging complete                 -> staged
stable local archive + exact mapping + Job     -> downloaded
successful gallery commit and reconciliation   -> ingested
```

`staged -> downloaded` occurs only after all of the following are true:

- the creator directory maps uniquely and is in the saved allowlist;
- the source archive is a regular, non-symlink file;
- size and mtime are stable across the configured interval;
- SHA-256 completes with size and mtime unchanged;
- exactly one source work and exactly one download task match;
- a matching idempotent Job is created or reused.

Job insert/reuse and the download-task update use one short `BEGIN IMMEDIATE` transaction after filesystem hashing. An update failure rolls the Job insert back. Only a task currently in `staged` is updated. `downloaded` is a no-op; `ingested` is never downgraded; `cancelled`, waiting-stable, unmapped, ambiguous, and awaiting-review cases remain unchanged.

Stage 2 now uses these labels: `待转存`, `插件已领取`, `插件处理中`, `网盘已暂存，待本地确认`, `本地已下载，待入库`, `已入库`, `失败`, and `已取消`. Its seven summary cards combine claimed/downloading as `插件处理中`. The manual `刷新状态` action only reloads Stage 2 and never plans, scans, or starts plugin work. Stage 2 has no interval timer.

## Job dashboard

The flat first-100 view is replaced with a creator summary and an optional 50-row detail page. The API supports creator ID, status group, page, limit, total, and `hasMore`. Status groups are pending, running, awaiting review, failed, completed, and all.

Creator ordering is current run first, then failure/review, pending/running, completed, and natural name. The default summary response contains no Job rows. A synthetic 558-Job test proves all records remain addressable through pagination while the client renders at most one creator page.

## Automated verification

All tests used temporary directories and temporary SQLite databases.

- operation coordinator: immediate rejection for all protected kinds under scan and batch, no queue, authoritative conflict payload, progress snapshot, and `finally` release;
- operation routes: no-store status endpoint, all eight protected routes returning 409, and summary-only scan/batch payloads;
- scan/run separation: no implicit scan, empty batch no-op, explicit scan-to-run path, fixed allowlist scope, and serial execution;
- handoff: stable staged-to-downloaded, repeated no-op, ingested anti-downgrade, cancelled/unstable/unmapped/ambiguous preservation, hash-time mutation rejection, and transactional rollback;
- client: scanning/running lock, row actions, 409 adoption, refresh recovery, same-page scan without polling, ten-second operation polling, hidden/visible behavior, idle zero polling, Stage 2 labels/manual refresh, completion refresh boundaries, and 558-Job pagination.

Results under the bundled Node.js 24 runtime:

- server full suite: 76 files, 420 passed, 2 platform-gated skipped;
- client full suite: 42 files, 200 passed;
- migration bootstrap/up/down/repeat: 17 passed, including `000014` down/up and repeated `000015` no-op behavior;
- server TypeScript build: passed;
- client `vue-tsc --noEmit` plus production Vite build: passed;
- `git diff --check`: passed.

The client build emitted only the existing Vite chunk-size warning. The unchanged repository-root wrapper still requires the bundled Node runtime because the system Node 18 lacks `node:sqlite`; no wrapper or runtime task was included here.

## Isolated runtime smoke

The feature worktree was built and served on `127.0.0.1:4242` with a generated DATA_ROOT under the Windows temporary directory. Gallery, inbox, processing, SQLite, thumbnails, and previews all remained inside that temporary root.

The isolated service migrated its empty database through `000015` and returned:

- `/`: HTTP 200 with the built application shell;
- `/api/health`: healthy storage and persistent temporary SQLite;
- `/api/admin/local-ingest/operation`: `idle` with `no-store`;
- `/api/admin/local-ingest/jobs?page=1&limit=50`: empty grouped/paginated dashboard;
- settings: only temporary roots;
- Stage 2: zero tasks.

The 4242 service was stopped after the smoke test. UI state transitions and polling behavior were exercised by the Vue DOM/fake-timer suite against synthetic API state. The production 4141 process was never restarted or pointed at feature code.

## Production read-only safety comparison

The production service remained listening at `127.0.0.1:4141` from the main checkout throughout development. Its old-main operation endpoint remained HTTP 404, confirming that feature code was not hot-loaded into production.

The same read-only snapshot procedure was executed before and after development. Every value was identical:

| Evidence | Before and after |
|---|---|
| production database SHA-256 | `2238bd20fc096497514f3b77303e12678f9cb785d35b7096e166275b8fead494` |
| database size | `128749568` bytes |
| database mtime UTC | `2026-09-03T09:16:17.5144632Z` |
| migration / integrity | `000015`; quick check `ok`; 0 foreign-key violations |
| Stage 3 settings + allowlist hash | `91b7f241dab8ecb14f906a7ca8aee7949254f6c7f8f156bcde9cf113d52b119e` |
| LocalIngestJob count / row hash | 74 / `b31901f2069f625237a1aceedded5501556fc5b39b3364548f2b3d10d706f74c` |
| Download Task count / row hash | 604 / `27f8c27243cdf1a76b7be15de7cc587d29c33d9e754abcc8293670a9127cc86a` |
| `G:\cos图集` root mtime UTC | `2026-08-31T20:11:21.1686403Z` |
| `G:\cos待入库` root mtime UTC | `2026-09-03T07:22:12.4039023Z` |
| inbox direct creator dirs | 29, 0 reparse directories |
| inbox direct-dir metadata hash | `d98422e3ba344b64603916f05f50685b1044e6fa2eaf2c8a9bdadf70af57ce5d` |

All 74 existing Jobs retained `attemptCount=1`: 72 are passed/recycled and 2 are warning/recycled. Download Tasks remain 90 ingested and 514 staged. The six completed creator samples (果咩酱w, 阿包也是兔娘, rua阮阮, 糖果果Candy, 是一只废喵了, 弥美Mime) retained identical creator and Job row hashes and were never run.

No production Job was created, no Download Task or setting was updated, and no production scan, extraction, ingest, reconciliation, recycle action, or media read was started. `G:\cos图集` and `G:\cos待入库` were metadata-read only. The Script repository remained on `84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6`, clean, with CostuanArchiveManager `0.6.10`.

## Explicitly unchanged

- two-layer archive extraction and validation;
- atomic gallery commit;
- creator-scoped physical scan and ledger reconciliation;
- Recycle Bin cleanup semantics;
- Stage 1 and Stage 2 polling (both remain absent);
- database schema/migration version;
- Script and CostuanArchiveManager;
- real gallery/inbox contents and completed Jobs;
- new-source, cross-platform deduplication, work-level R15/R18, and deployment architecture.
