# Resource catalog read-model validation

> 历史资料：阶段隔离测量记录，以下数量和耗时不是当前全库常量；使用说明见[资源目录](own-resource-catalog.md)。

## Environment and boundaries

Measured on Windows with Node 24.19.0 and production-built server/client in an
independent worktree. The reused consistent SQLite copy contains 601 creators,
7,250 Works, 7,247 local copies/Posts, 357,144 Images and post_items, and 4,772
source Works. Migration 000022 was applied only to this copy. All database,
gallery, thumbnail and preview directories were asserted beneath the isolated
evidence root before application imports. The HTTP harness used localhost 4492,
not production 4141. It mounts the real production Express app without running
scanner or ingestion startup. No originals or G-drive directories were read.

Three anonymized representative samples contain: A 171 Works / 10,995 primary
media members including a two-copy Work; B 189 Works / 25,198 members with legacy
source relations; C 233 Works / 12,393 members, all without source relations.
The complete derived catalog contains 7,245 rows; source-only Works are not made
into local entries. These counts describe this evidence copy, not live constants.

## Generator and SQL

The old PR31 service was transpiled from the preserved baseline source and called
once on the same database copy and Node runtime. Sample A's complete snapshot took
6,918.16 ms; the new generator immediately afterward took 21.76 ms. All 171 rows,
summaries, gaps and copy records matched deeply after excluding revisions,
generation timestamps and the newly added per-row creator fields. This is a
single paired observation, not a three-run old-version benchmark. The prior
8.16-second historical gap-query report is separate historical evidence.

The corrected candidate-Post query uses `idx_posts_folder_visible_sort` constrained
by the selected creator's folder IDs, obtained through
`idx_archive_catalog_local_folders_creator`. Its correlated membership lookup
starts with `post_items(post_id)` and then the Image integer primary key. It does
not enumerate unrelated active Images before discovering the target Posts.

One warm-up plus three measured candidate-query runs (milliseconds):

| Sample | Median | Range |
| --- | ---: | ---: |
| A | 0.51 | 0.48–0.55 |
| B | 2.51 | 2.41–3.00 |
| C | 0.62 | 0.62–0.75 |

Full generation measured separately: A 20.86 ms (20.32–21.55), B 39.05 ms
(38.64–41.11), C 22.90 ms (22.75–23.20). No image decoding or filesystem inventory
is included in these database-only generation measurements.

## Initialization, change and process restart

Synchronous initialization of 601 creators performed 601 builds and published
7,245 rows in 4,746.16 ms. The actual background Worker initialization, including
its 25-ms inter-batch yield, took 25,064.54 ms, emitted 601 successful publication
messages and no failures. These are distinct timings; the synchronous duration
is not advertised as background wall-clock completion.

After terminating that Worker and creating a new one against the persisted
database, 2.2 seconds of observation produced zero publications and no pending
creators. An independent SQLite connection then changed one creator's Work title:
only that creator became dirty and the live Worker published it automatically in
878.28 ms from external commit, with a 30-ms rebuild. The original title was
restored and its publication awaited. The one-second idle poll contributes to
notification latency; this is not a 878-ms SQL query.

Instrumenting `ResourceCatalogBuilder.generate` proved **zero generator calls**
across warmed list, page-two, detail, export and search operations for all three
samples and global scope. A new Node process repeated the reads with zero builds.
The first migration/startup integrity checks are deliberately outside read times.

## Final production-build HTTP and browser after measurements

Final measurements ran after rebuilding the final server changes and while the
main regression suite was stopped. Earlier measurements overlapping regression
execution are retained privately but are not the final HTTP numbers below.
Each row has one warm-up followed by three measured requests. HTTP includes full
response-body consumption; byte counts are decoded application bytes, not wire
compression. There is no production before/after claim.

| Scope / operation | HTTP median ms | Range ms | Body bytes |
| --- | ---: | ---: | ---: |
| A first 50 rows | 14.73 | 13.58–17.58 | 32,918 |
| A selected detail | 7.31 | 6.24–16.10 | 1,323 |
| A full CSV | 2.83 | 2.75–8.94 | 70,180 |
| B first 50 rows | 15.21 | 4.90–15.25 | 32,505 |
| C first 50 rows | 15.62 | 4.79–16.17 | 24,342 |
| Global first 50 rows | 47.46 | 43.87–48.42 | 26,052 |
| Global selected detail | 15.11 | 10.05–15.33 | 1,156 |
| Global creator-name search | 46.82 | 40.58–47.27 | 33,578 |
| Global full CSV | 92.77 | 79.31–243.65 | 2,434,278 |

Full-page navigation to the actual 50-row table at 1440×1000, with a ready server
and a reused isolated browser context, measured A 2,142.59 ms (2,113.63–2,152.31),
B 2,142.82 ms (2,113.57–2,153.56), C 2,106.70 ms (2,088.34–2,150.34), and global
2,126.36 ms (1,926.17–2,135.26). These are navigation-to-real-table milestones,
not FCP, fresh-context timing or completion of gallery images. The remaining
roughly two-second application-navigation cost has not been removed by this
read-model change. Each resource table made no per-Work detail prefetches.

## Actual interaction coverage

- Global table, page two, creator-name search, creator column and scoped detail.
- Single-creator oldest/newest changes first visible NO.001/NO.171 without
  renumbering the Work identity.
- Source filtering for the unlinked sample returns 233 unlinked and zero linked.
- Browser downloads a filtered global CSV and its separate metadata JSON;
  metadata includes the matching revision, global scope, filter and 171-row count.
  These private sample exports remain ignored, not in Git.
- All four original workspace tabs were actually clicked using their current
  selectors (`roster`, `source`, `staging`, `ingest`), not conditionally skipped.
- Existing gallery still returns 24 lightweight summaries without mediaItems;
  selected detail is complete and the album page mounts normally.
- A representative two-copy Work retains its primary and secondary.
- Two clearly synthetic derived fixtures in isolated cache paths were decoded by
  the existing thumbnail and Viewer routes. Closing Viewer made no additional
  Work-detail request. This is synthetic compatibility, not real-photo decoding.
- Desktop and 390-pixel screenshots were inspected. The narrow layout has no
  document-wide horizontal overflow; the catalog table retains its own scroll.

No business write endpoint, real scan, admission, recovery, source check, download
or recycle operation was executed. Only the isolated Work title update above and
derived-table/cache fixtures changed. Production runtime, original exports,
source files and user configuration were untouched by this validation.

Private raw evidence is in the worktree's ignored `.mocks/resource-read-model/`:
`copy-inventory.json`, `baseline-compare.json`, `scale-service.json`,
`scale-incremental.json`, `worker-check.json`, `browser-check.json`,
`supplement-check.json`, `visual-compat.json`, and timestamped `events.jsonl`.
No database, real media, private directory list or export is part of this document.

## Automated regression

Final Node24 server regression: 115 files, 960 passing tests and two existing
video-tool conditional skips. Client regression: 465 passing tests; final UI
wording/key adjustments were followed by the 13-case component suite and rebuild.
Server TypeScript, client vue-tsc and both production builds passed.

Coverage includes fresh/upgrade/repeated migration and historical fixture recovery;
transaction rollback, independent-connection writes, stale prepared generations,
failed/partial publication, restart, ownership swaps and monotonic rule versions;
uninitialized/pending read states, immediate deleted-copy link protection, global
pagination/export revisions, and member-key-driven query-plan assertions. No skip
condition was added or broadened for this feature. An older migration fixture now
removes the newer derived triggers before reconstructing its historical schema.

The implementation is for an unmerged, undeployed PR. These isolated results do
not mean migration 000022 or the background updater is enabled in production.
