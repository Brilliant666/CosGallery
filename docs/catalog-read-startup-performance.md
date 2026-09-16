# Catalog reads and startup validation

This change optimizes reads, not ingestion, matching, or version acceptance. It
preserves the derivative indexes and 24-work summary/detail separation introduced
by the preceding gallery performance change.

## Catalog query changes

The visible creator count does not describe the old query's work. Missing-work
aggregation evaluated full acceptance evidence across active source works. Its
plan could start from local copies, rebuild media snapshots before narrowing the
fulfillment, and scan decisions repeatedly.

Migration `000021_add_acquisition_read_indexes.sql` adds ordinary, non-unique,
non-partial indexes:

- `archive_catalog_local_fulfillments(source_work_id, work_id, state)`;
- `archive_catalog_work_decisions(local_work_id)`.

The plan can now narrow the fulfillment first and find local decisions through a
covering index. The source/local snapshot predicates are unchanged: member IDs,
order, fingerprints, deletion state, and the remaining evidence still matter.

`CreatorSyncQueryService` evaluates its full creator aggregate once within each
read transaction. Count, summary and page SQL reuse a parameter-bound JSON rowset
of those small aggregate rows. This is not a media cache, a persistent table, or
an instance/global cache. Filters still operate before pagination over the full
cohort; a subsequent request rebuilds evidence and sees revocations or changes.
Source/task union, historical sources without tasks, staged history and active
claim protections are unchanged. Empty-cohort behavior remains compatible.

The small `roster`/`cohort` and creator-wide `activity_tasks` CTEs are explicitly
materialized within each SQL statement. Otherwise a status-first task plan can
decode the same JSON roster once per task and repeatedly expand the activity
subquery. `task_scope` deliberately remains flattenable: materializing it forces
full version evidence even for count/sort-only queries. No fulfillment validity
predicate was weakened to obtain these improvements.

## Startup validation changes

The old normal startup fully validated an already-migrated database while checking
historical migration markers, and repeated the same validation after dbmate.
Without pending migrations or marker repairs, the final full check now runs once.
Pending migrations retain pre/post checks where applicable; incomplete historical
migrations retain their existing repair and refusal paths. A pre-check success is
never reused after a schema/data change.

No check category is removed: structure, relationship constraints, foreign keys,
and full `integrity_check` still run before normal service readiness. There is no
permanent passed flag or cross-database/process cache. Soft-deleted empty Posts
remain allowed; broken active membership still fails startup.

Logs report actual applied migration versions, whether a migration ran, full-check
count and structure/relationships/FK/integrity durations. Failed stages remain
errors, not successful health responses. Logs contain no media manifest. These
new diagnostics use stderr so CLI stdout remains machine-readable JSON, including
when database initialization happens during static module imports.

Direct `node server/dist/index.js` (including the existing IDE configuration)
normally goes from two full checks to one per process. Existing `npm start` runs
a migrate process and a server process: both independently validate, so its total
goes from four checks to two. This change does not alter that launch contract.

## Reproducing isolated measurements

Use locked dependencies, Node24, production builds and one consistent database
copy. Never point the benchmark at production4141 or a production data/cache root.
Private copied databases, endpoint bodies and manifests remain Git-ignored.

- `scripts/perf/catalog-read-benchmark.mjs`: launches the actual built server
  entry in a marked isolated fixture; one warmup and three fresh-process starts,
  then bounded GET reads. Stops only its own child process. Set `PERF_CREATOR_ID`
  for the fixture's task-page sample. Send `stop` on stdin after browser checks.
- `scripts/perf/startup-check-probe.mjs`: optional preload measurement of the
  original SQLite FK/integrity calls; it executes, rather than mocks, each call.
- `scripts/perf/catalog-browser.mjs`: GET-only isolated browser requests and
  four-workspace read interactions; baseline slow combination only once, after
  warmup plus three measured loads. DOM readiness is not reported as FCP.

The fixture must have a matching isolated gallery-root setting and existing index
so both startup scans skip; all media/cache writes must remain isolated. Stable
slow baseline endpoint samples are collected once rather than repeatedly queued.
Browser timeouts remain timeouts, not inferred server completion durations.

## Results and validation

Measured on 2026-09-16, Node 24.19.0, production builds, identical business rows
from one consistent copy (597 creators, 282,344 images). Baseline source is
`4984baa62bc680fb61758e91c8ae283ed7ca09c4`. HTTP/startup baseline has migration
000020; after has 000021. No production request pressure or service restart was
used. The copied scanner-root setting points only to the isolated empty gallery;
both startup scans skip. OS caches were not cleared. No concurrent test suite ran
during measurements.

### SQL and HTTP

The pure missing-work SQL preserves all 1,459 result rows and their digest:
7,445.66 ms (one slow baseline sample) -> **11.38 ms** median
(11.03-12.88 ms, warmup + three). This index-only probe used a separate copy of the
same backup, adding only the two acquisition indexes; it is not HTTP timing.

Actual plan differences:

```text
before: SEARCH accepted_local USING INDEX idx_archive_catalog_local_works_work
        ... full local-version evidence before narrowing fulfillment
after:  SEARCH fulfilled USING INDEX idx_archive_fulfillments_source_work_state
        SEARCH accepted_local USING INTEGER PRIMARY KEY
        SEARCH manual_decision USING COVERING INDEX idx_archive_decisions_local_work
        ... original ordered media/version evidence remains
```

Seven complete HTTP response bodies match, excluding only `readAt`, across every
after iteration. Byte counts are unchanged; no fields or scope were removed.
Slow baseline endpoints were sampled once, not repeatedly queued. After uses one
warmup and three samples, with elapsed time through complete response-body read.

| GET sample | Before, ms (single) | After median, ms (range) | JSON bytes |
| --- | ---: | ---: | ---: |
| Roster, no-unchecked source filter | 7,515.09 | 58.23 (56.86-60.85) | 21,956 |
| Stage 1 first page | 22,572.49 | 74.50 (59.72-74.95) | 33,900 |
| Stage 1 no_task second page | 22,407.02 | 61.63 (60.19-73.32) | 261 |
| Shared statistics | 29,975.36 | 79.50 (73.89-82.35) | 651 |
| Stage 2 creator list, recent | 22,628.31 | 174.75 (156.30-174.80) | 14,499 |
| Stage 2 selected creator task page | 14,999.03 | 66.58 (64.72-70.82) | 47,564 |
| Idle operation | 2.51 | 12.03 (10.98-12.09) | 123 |

The idle endpoint is not an optimization claim. Browser validation exposed a
remaining staged-filter plan after the initial index fix: an intermediate version
took 8,789 ms in the service probe / about 10.4 s in browser interaction. The CTE
materialization correction above reduces the final staged HTTP filter to
**198.93 ms** (190.17-209.01). Exact service payloads match excluding `readAt`.
That intermediate observation is not relabeled as a main-branch before sample.

### Startup

Fresh Node processes, one warmup and three measured starts per version; readiness
requires both scan-skipped logs and a successful actual health response:

| Measurement | Before | After |
| --- | ---: | ---: |
| Full FK + integrity passes per ordinary process | 2 | 1 |
| Start -> ready median | 17,967.91 ms | 9,361.32 ms |
| Start -> ready range | 17,920.45-18,101.91 ms | 9,348.22-9,412.19 ms |

Representative final warmup stages: migration no-op 30.19 ms; structure 2.57 ms;
relationships 277.52 ms; FK 358.96 ms; integrity 7,972.62 ms. Thus a new process
still takes roughly nine seconds: full integrity checking remains substantial,
and was deliberately not replaced or deferred until after writable readiness.
The first fixture upgrade retains two checks; it is excluded from ordinary-start
statistics. Each later new process performs its own full check again.

### Regression coverage and boundaries

- Server: **915 passed, 2 skipped** (112 files); client: **432 passed** (66 files).
- Server TypeScript build, client typecheck and production build pass.
- Fresh schema, upgrade/repeat startup, historical interrupted markers, negative
  FK/membership/structure cases and valid soft-deleted empty Posts remain covered.
- Full source/local version evidence, revocation, changed members/order/fingerprint,
  local-only works, multi-copy rules and active claims retain their tests. Repeated
  reads see evidence changes; query-only reads and one heavy cohort evaluation per
  request are asserted. Status-filtered activity ordering remains creator-wide.
- The full regression initially found startup diagnostics corrupting a CLI JSON
  stream. Moving only the new diagnostics to stderr fixed that compatibility issue;
  the actual cross-process admission test now passes without weakening its parser.

### Browser

Chromium 151.0.7922.34, fixed 1440 x 1000 viewport, same production client build,
GET-only routing, no external/original media access. Routing disables browser HTTP
cache equally on both sides. These are catalog DOM milestones, **not FCP or a
claim that all original photographs loaded**. New browser contexts share one
already-running isolated Node process; they are distinct from fresh-process
startup timings above.

- Before: one bounded attempt timed out at 45 s, with Stage 2/jobs still pending.
  No retry or inferred server completion time is reported.
- After: one warmup + three loads completed; median **1,860 ms**, range
  **1,853-1,907 ms**, no pending/error/retry requests. Median roster insertion
  1,558 ms, Stage 1 1,832 ms, Stage 2 1,774 ms, settings 1,835 ms.
- Fifteen read interactions cover roster pagination and all source filters,
  Stage 1 pagination and real `no_task` rows, reuse explanations, Stage 2 creator
  paging/expand/staged filter, Stage 3 expand/collapse/settings. No business action
  is clicked and no non-GET request is allowed.
- Two previously recovered work records were read in the isolated copy: summary,
  detail and gallery totals agree (188 images + 1 video; 99 images). The active
  retained-original decision remains readable and its unsupported original is not
  a normal media item. Both covers return 200; Viewer first/second/close and direct
  second-media links work, with exactly one detail request for opening/switching/
  closing and no page/API errors. Only eight synthetic isolated WebP derivatives
  were generated (four thumbnails, four previews), not production photographs or
  a claim of decoding the retained original. The cache fixture is under nonhidden
  ignored `data/`, preserving existing `sendFile` dotfile behavior.

Private raw request bodies, copied databases and manifests remain local ignored
evidence, not committed. This branch is not merged or deployed by its validation.
