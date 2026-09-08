# Unified creator sync: read-only query audit

## Scope and method

The production ledger was inspected on 2026-09-08 with a standalone Node 24
`DatabaseSync` connection opened with `readOnly: true` and `PRAGMA query_only=ON`.
No application startup, filesystem scan, task planning, ingestion, database write,
or recycle operation was performed. Counts below are the observed ledger snapshot,
not product constants or proof that a disk is currently online.

## Observed counting domains

| Domain | Observed value | Meaning |
| --- | ---: | --- |
| Canonical roster | 593 | Canonical creators; all enabled at this snapshot |
| Creators with active local works | 36 | Distinct canonical creator IDs |
| Active physical creator folders | 40 | Four creators each have two linked folders |
| Default visible gallery cards | 36 | Existing visible-Post and owner filtering, grouped by canonical identity |
| Source-check tasks | 20 | 19 completed and 1 not_found; not the roster |
| Stage 2 download ledger | 655 | All ingested |
| Stage 3 ingestion jobs | 639 | All ingested; warnings remain independent |
| Active local works | 2374 | All matched to valid source identities |
| Active Costuan source works | 2393 | 2393 distinct works, across 37 creators |
| Known source/local gap | 19 | Set difference; all belong to the historical paused creator |
| Unlinked active creator folders | 0 | Reported separately, never fabricated as canonical creators |

Seventeen locally collected creators have no metadata task and therefore were
missing from a list derived from metadata tasks (examples include MACHI and
lunana). The canonical roster now supplies the list independently of task history.
Historical import and real source collections count as source coverage.

## Why 655 minus 639 is not sixteen missing works

All 639 jobs have a non-null, existing download-task foreign key. These are 639
distinct tasks, with matching source-work identity and a matched active local
work belonging to the same creator. No dangling or mismatched relationship was
found in this comparison.

The remaining sixteen ingested download tasks have no LocalIngestJob, but each
already has exactly one matched active local work:

- One historical `000.7z` task for 桜桃喵 (task 1200).
- Fifteen historical records for 眼酱大魔王w (tasks 1720–1734), covering
  037–049 and 051–052.

These are existing local-linked ledger records without Stage 3 jobs, not missing
media and not an instruction to create retrospective jobs. This database audit
does not invent an exact historical execution mechanism for those records.

Of 2374 active local works, 655 have a download task and 639 have an ingestion
job. The 1719 without a download task and 1735 without a job remain legitimate
historical local records. The actual known gap is independently calculated from
valid source-work identities minus valid local relationships. No paused task was
resumed and no task was created to make these numbers equal.

## Shared read model

`CreatorSyncQueryService` exposes roster, statistics, creator-level download
groups, and creator-specific task pages to both administration and authenticated
plugin routes. Default scope is enabled creators; query, preference, rating,
enabled/local/source filters share one canonical cohort. Each response includes
`readAt`; each read is protected by a database read snapshot.

Local means known active indexed ledger rows, not a new filesystem measurement.
Source rows require active Costuan collections and matching creator ownership.
Known missing works use distinct work identity, not title, maximum number,
collection count, or task/job subtraction. Unlinked folders have no canonical
filter identity and are explicitly reported as a separate `all-unlinked` scope.

Pagination happens after aggregation. Empty pages retain complete totals and
status summaries. Details load only on demand, with the existing download-task
shape. Query failures propagate instead of becoming zero counts. The number of
prepared statements is bounded: roster 2, stats 5, download groups 2, details 3.

## Isolated verification

Eight focused in-memory SQLite tests pass. Coverage includes canonical creators
without metadata tasks, aliases and multi-directory ownership, equal-number
NO/VOL identities, distinct source sets, duplicate delivery joins, more than 100
tasks and later-page creators, consistent filters, empty-page totals, exact
legacy task-detail shape, unresolved ownership, bounded query counts, query-only
execution and unchanged database rows. Invalid query inputs and database errors
are not converted into success-shaped empty results.

These tests and the production read audit do not claim real Costuan or Baidu
incremental automation acceptance. Production deployment and real checks are
outside this task.

## Plugin display verification

The plugin options page now reads the canonical roster and the same shared
statistics/download queries. Legacy JSON import, independent list execution,
single independent transfer and paused-history restore controls are absent.
No old storage is erased. The options page displays version 0.8.0.

Six isolated headless Playwright DOM cases pass with intercepted local fixtures
and no user browser profile: canonical rows independent of 593 historical rows;
full Stage 2 aggregation beyond 100 tasks; paged lazy details and retained open
state; cross-page explicit selection; late-query suppression; failed reads not
shown as zero; mobile layout; occupied/offline start guards; unsaved credentials;
read-only pasted scope; retry request/round persistence through page reload; and
read-only reopened historical progress. A failed request retains its request ID
and scope in session storage, with an explicit local-draft discard control for
stale requests. That control does not cancel or erase server jobs/receipts.
