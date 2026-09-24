# Gallery performance optimization (draft)

Base: `321e5241296ada67ae31632c85a5d30deaf2e162` (PR40).

This is one ongoing Draft PR, not a merged release. The initial trial candidate
`8a324e4ae4ffc1ae145e8ff0e9eca9c29282337f` was subsequently enabled on 4141
with migration 000027 under separate trial authorization. The feedback round
below changes only an isolated paired candidate on 4241; it does not update 4141.
Earlier measurements and acceptance statements below describe their original
pre-deployment observation point, not the current trial's runtime status.

## Scope and progress

- M1: initialize ordinary browsing with light status, share only equivalent
  initialization reads, and wait for the saved feed mode before infinite loading.
  Explicit refreshes remain separate generations. Late status, scan-poll and feed
  responses cannot repopulate reset access state. Homepage rail requests have the
  same generation ownership and retry protection.
  Folder aggregation scopes cover/story image lookups by physical folder first.
  The identical visible Post count is computed once per administrative response.
  Two fixed fact projections (folders and the legacy derivative compatibility
  count) reuse results only while SQLite proves the database unchanged.
- M2/L5: negotiated text compression, management-route splitting and distinct
  HTML/hash-asset caching are implemented. Full feed media arrays are retained.
  Sized text over 1 KiB negotiates gzip/deflate/Brotli; streams, Range/206, media
  and already encoded responses do not. Existing Vary, private/no-store and
  no-transform semantics remain. Eight management views are lazy routes.
  Hashed assets use one-year immutable caching; HTML revalidates. Missing assets
  are non-cacheable 404 responses, not the SPA document.
- L3/M3: bounded distinct-output generation and coordinated media URL/disk
  versions are implemented. FIFO maintenance leases allow distinct generation
  writers under the existing configured concurrency limit, while scans/rebuilds
  and participating deletion remain exclusive. A per-output lease coordinates
  serving with atomic replacement; same-output requests share one generation.
  Media URLs use indexed size/mtime plus the actual derivative recipe, not the
  latest scan ID. Persistent sidecars bind those versions to output size/mtime.
- L1: migration `000027_remove_redundant_indexes.sql` removes exactly the eight
  audited duplicate explicit indexes. New schemas omit them. Pre-migration
  validation retains historical names; post-migration validation requires all
  eight exact UNIQUE/PRIMARY KEY keys, column order, ASC/BINARY, nonpartial and
  constraint origin. Other structure, relationship, FK and integrity checks stay.

No changes to the legacy folder deletion flow, fonts, authentication policy,
backup product features, data locations, WAL/synchronous mode, task KV storage,
historical cleanup or plugin behavior are included.

## Read invalidation and cache compatibility

Fact reuse is per database connection and checks `data_version`, `total_changes()`
and `schema_version`. Same-process writes, independent CLI/worker commits and DDL
invalidate it. Explicit transactions bypass and evict; rollback cannot publish an
uncommitted cache result. There is no TTL, scan-ID assumption or authorized-response
cache. Results are cloned. Unrelated writes conservatively invalidate too, so the
first read and reads during active writes still pay the aggregation cost.

The first administrative compatibility COUNT retains its original SQL and cost.
A CASE rewrite measured worse and was removed. Ordinary homepage initialization
does not require this administrative diagnostic.

Unstamped legacy derivatives have no provable provenance. Only accessed outputs
are regenerated and stamped; no cache-tree purge, traversal or prewarm occurs.
That first accessed-output cost is not a hot-cache improvement. Stamped results
survive restart. Explicit stale versions return 409/no-store; unversioned historical
links remain readable with no-store. Shares retain their stricter cache semantics.
Titles, source relationships, sort decisions and unrelated scans do not change
media versions. Size/mtime is existing indexing evidence, not a content hash;
changes preserving both values are outside that evidence. Coordination remains
process-local, not a new cross-process generation protocol.

An already-open page requesting a removed old lazy chunk receives a real 404.
The feedback candidate adds a visible, explicit recovery action (see below),
without automatic reload or historical chunk retention.

## Initial isolated measurements (historical PR40-to-PR41 comparison)

Node 24.19.0, SQLite 3.53.3. The consistent audit database contains 383,802 media
members, 7,619 Posts, 7,617 Works and 601 creators. SQL measurements warm once and
record three runs; these are not page timings.

| Measurement | Before median (range), ms | After median (range), ms |
| --- | ---: | ---: |
| Complete folder aggregate | 951.31 (951.05–959.15) | 444.33 (443.85–451.95) |
| Unchanged folder repository read | Full aggregation | 0.332 (0.296–0.701) |
| Unchanged compatibility COUNT read | Full count | 0.0382 (0.0361–0.0429) |
| Four distinct cold image outputs | 137.20 (132.30–146.64) | 54.65 (51.75–57.34) |

Repeated unchanged reads explicitly execute zero expensive aggregates. The
folder comparison preserves all 146 existing projection rows. Cold generation
uses equivalent temporary 1800×2400 images and real Sharp through HTTP; measured
peak generation changes from 1 to 4. Four requests for one output still generate
once. This source/tsx experiment is not a production-page or video-hardware metric.

The migrated copy preserves row digests for all 49 application tables. FK and
integrity checks pass. The eight indexes occupied 49,819,648 bytes (47.5117 MiB).
Freelist pages rise from 194 to 12,357 at 4,096 bytes/page; the database file remains
666,353,664 bytes. No VACUUM or immediate file-size reduction is claimed.

### Matched production-build HTTP and browser samples

The before build matches the base application inputs; after uses application
commit `81f141b27f7b77fb8f2183bd38fc48af9894a278`. Subsequent candidate changes
only correct six obsolete test expectations and document these results. Each
sample warms once and measures three times, using the same database snapshot,
Node version and saved recent-feed preference. HTTP harnesses use read-only
connections and GET-only requests, with real-library media delivery blocked.
Normal production startup is verified separately on the isolated 4241 service.

| Measurement | Before median (range), ms | After median (range), ms |
| --- | ---: | ---: |
| Administrative stats HTTP | 793.53 (789.09–802.11) | 120.51 (119.58–123.37) |
| Warm unchanged folders HTTP | 940.32 (935.94–949.50) | 2.99 (2.51–3.14) |
| Recent feed HTTP | 130.02 (127.97–131.35) | 137.02 (134.95–140.29) |
| New context: navigation to recent response end | 3794.0 (3737.7–3803.6) | 1235.2 (1221.7–1269.7) |
| New context: first actual recent card DOM visible | 3840.1 (3784.4–3850.0) | 1286.9 (1272.7–1326.9) |
| Warm context: first actual recent card DOM visible | 3747.5 (3663.5–3764.7) | 1199.1 (1197.5–1204.7) |

Browser viewport is 1440×900. The DOM milestone requires a real recent Post card,
visible geometry and a following animation frame; it is not a skeleton, FCP or
all-images-loaded metric. Real media requests are blocked in this large-data
comparison. The historical 6.784 s observation is not used as its baseline.

Non-media initialization requests fall from 10 to 8: two administrative stats
requests become one light status request, and random-then-recent becomes one
recent request. Auth, folders, likes, collections, places and moments remain.
No page errors or recorded >50 ms long tasks occurred. Response-end-to-DOM changes
from 46.4 to 51.7 ms; rendering itself was not made faster by these changes.

Actual decoded/encoded response bytes (before identity, after negotiated Brotli):

| Body | Before raw / wire bytes | After raw / wire bytes |
| --- | ---: | ---: |
| Recent feed | 663735 / 663735 | 716095 / 101859 |
| Entry JS | 1297488 / 1297488 | 889087 / 257561 |
| Entry CSS | 277967 / 277967 | 237393 / 38978 |

Per-media version strings increase raw feed bytes; media arrays were not trimmed.
All three feed modes match complete JSON after excluding only thumbnail/preview
URL version values (six encoding/mode comparisons). Status bodies match without
normalization. Folder equivalence uses the complete SQL projection comparison;
no unavailable raw HTTP body comparison is claimed for folders or stats.

Compression is not free: on this loopback system after-build JS takes 1.94 ms
with identity versus 10.63 ms with Brotli. Process CPU sampling has roughly
15–16 ms granularity, so it cannot prove negligible CPU cost. Recent HTTP did not
improve and moments remains around 625 ms. Warm hashed assets transfer zero bytes
from browser cache, versus prior 304 revalidation. Inter and its loading strategy
are unchanged; no font request failures were observed.

### Separate fixed-image completion sample

Equivalent prewarmed derivative caches and 96 generated JPEGs / 24 Posts isolate
image delivery without reading original real-library files. The fixed first
recent carousel image must load with nonzero natural dimensions:

| Image completion | Before median (range), ms | After median (range), ms |
| --- | ---: | ---: |
| New browser context | 265.3 (253.9–278.7) | 244.9 (240.2–251.3) |
| Warm browser context | 180.0 (174.0–180.9) | 167.9 (164.3–172.4) |

This is one fixed first-screen target, not completion of every visible image or
the real 383,802-media library. Each separate temporary cache gained five
thumbnails and eighteen previews; after additionally has 23 provenance sidecars.
No original or existing live cache was changed. Large real-photo/video decoding
and deployment latency are not established by these synthetic samples.

## Initial validation status (historical)

- Client full suite: 702 passed; production type checks and paired builds pass.
- Final server full suite: 1,470 passed, 2 existing conditional skips, 153 files.
  The initial six failures were obsolete version/summary assertions. Exact new
  version expectations and lightweight cover provenance were asserted, not
  bypassed; the affected 30 tests and complete server suite then passed.
- Code/test candidate `20b76ac529b0b92fb527ae69a1dd50182fd6ddd2` passed Verify
  run `35964208428`. Documentation-only follow-up receives its own normal Verify;
  the PR check records its exact final Head rather than reusing this run.
- Isolated normal production startup applied 000027 with pre/post validation;
  both existing startup scans stay disabled. No live gallery startup occurred.
- Isolated browser: carousel and full-page Post return; canonical 24-item request
  contract with summary-only rows; Work Viewer item 2 → 3 → close retains the
  background grid and makes zero extra detail requests. Lazy management tabs,
  query/back restoration, catalog and settings pass, with no page/HTTP errors.
  The synthetic creator has eight Works; the >24 boundary uses the existing
  27-Work targeted test, not a fabricated browser total. At 390px no horizontal
  overflow occurs. Browser APIs were GET-only; canonical identity mappings were
  added only to the synthetic fixture after performance measurement completed.

The legacy folder deletion issue (L4), font behavior, backup product work, global
performance redesign, production media acceptance and plugin changes remain out
of scope. The initial JS bundle is smaller but still exceeds Vite's 500 KiB warning.

Private databases, local paths, raw request records and measurement artifacts
remain in ignored local evidence directories, not in the pull request.

## Trial feedback round: loading stability

Baseline: `8a324e4ae4ffc1ae145e8ff0e9eca9c29282337f`; application/test candidate:
`3d8c7d851faad999fc205ac1af329f6be3a6cee0`. These comparisons are not against
PR40. Node 24.19.0, unchanged locked dependencies and production builds are used.
No migration is added or rewritten. This remains the same Draft PR.

### COUNT

The existing administrative disk count includes only formal thumbnail `.webp`
and preview `.webp`/`.mp4` outputs. Extension constants are shared with generators.
Exact generator-owned `.stem.UUID.tmp.codec` files, sidecars and unrelated files
are excluded; names merely containing `tmp` and old unstamped formal media still
count. This is a file count, not a verified/current-cache census. Traversal
frequency is unchanged, and none is added to ordinary homepage initialization.
Failing-first regressions cover nested folders, generation before/after publish,
sidecars, unrelated files and legacy outputs.

### HOME and EMPTY_APIS: actual work, not storage guesses

Home waits for the correct first feed's committed state and a paint opportunity
before dispatching the nonessential rail. There is no arbitrary delay or
random-then-recent request. A failed feed still permits the rail; leaving/resetting
or changing access invalidates delayed work. The rail has a stable placeholder,
visible failure and explicit retry; non-home rail entry is unchanged.

The backend builds the preferred rail and only builds its fallback if necessary.
Capsule detail reuses that read's selected definition and count; recent overlap
uses the existing candidate prefix rather than a second hydrated query. There is
no long-lived rail cache: date, local-day seed, moving windows and facts are
reevaluated. Both preference branches, empty fallbacks, date/fact changes and
complete fixed-date responses are covered.

Sparse likes, collection memberships and places now drive the query before Post
visibility/primary-copy predicates. Four measured join-order constraints replace
the previous all-visible-Posts reverse lookup. EXPLAIN shows membership/places
first, then Post PK or the existing place visibility index. No predicate, field,
index or storage failure handling is removed. `getState` mkdir/stat measured only
about 0.3–0.5 ms; it was not the principal cause and is unchanged.

On the consistent 383,802-media snapshot, one warmup and five independent samples
produce the following HTTP medians (ranges), in milliseconds:

| Read | Before | After | Service median before / after |
| --- | ---: | ---: | ---: |
| Recent feed | 174.52 (156.67–179.63) | 162.25 (158.02–190.06) | 152.23 / 147.14 |
| Moments | 710.05 (666.14–906.30) | 494.23 (486.22–512.60) | 704.14 / 485.18 |
| Empty likes | 81.50 (76.67–99.28) | 7.64 (2.30–9.19) | 73.89 / 0.72 |
| Empty collection | 89.55 (81.69–103.69) | 15.05 (1.68–15.99) | 81.38 / 1.01 |
| Empty places | 90.37 (79.69–96.39) | 13.20 (1.55–14.71) | 76.56 / 0.80 |

Moments SQL calls fall 21→10, preserving the complete 91,190-byte response. All
five fixed-date response bodies compare byte-for-byte equal. Empty-read SQL
medians fall from 73.52/80.81/76.02 ms to 0.38/0.41/0.09 ms. Feed SQL is unchanged;
its small independent timing difference is not attributed to a feed-query fix.
In five concurrent endpoint rounds, feed HTTP median falls 1134.50→660.45 ms while
its own service work remains about 150→153 ms: reduced contention is distinct
from SQL improvement. Even a sub-millisecond empty read can finish late behind
synchronous heavy work.

These backend runs were sequential before/after processes with a fixed date and
GET-only/read-only database, not cold OS-cache or interleaved browser evidence.
Cold process samples are separate in local raw records. Handler entry is not
network arrival; HTTP minus service is not SQL, and finish minus service/JSON is
not isolated compression CPU. Five samples do not establish P95.

### RELEASE_NAV

Vue Router import/CSS-chunk errors produce a visible recovery dialog. A no-cache
HTML entry comparison can confirm a changed build; offline, failed connectivity
and unknown causes remain separate. Explicit retry or refresh keeps the target
route/query/hash and Back context. Cancellation preserves current input; refresh
warns that unsaved input may be lost, and existing tab draft/pagehide behavior
is reused. There is no new sensitive persistence, automatic refresh loop or
business-write replay.

The isolated browser experiment served real A/B production asset sets (same
application code, different physical hash-suffixed chunk filenames). After the
switch, an unvisited A management chunk actually returned 404. The visible
version dialog, cancel with an unsubmitted admission selection, explicit target
restoration, Back/Forward, offline and temporary network failure all passed.
The backend was real createApp with a read-only synthetic database; all business
requests were GET. This is asset-release recovery evidence, not a business-code
performance comparison or a new production-startup matrix.

### SOURCE_CHANGE

Reliable stamped A + index A can still serve A without an original stat/hash on
every hot read. If no reliable output exists, source B versus expected index A
is rejected **before encoding**, checked again inside the output lease and before
publication. The current identity/version is checked immediately before rename.
Failed source/version checks preserve the old output and provenance; unproven
legacy files do not receive invented stamps. Index/URL changes remain distinct:
`SOURCE_INDEX_OUTDATED` versus `DERIVATIVE_VERSION_CHANGED` (409/no-store).

The UI diagnoses only failed same-origin derivative elements, using bounded
Range reads: two active, 24 queued, 128 short-lived dedup entries and a 4 KiB
error-body limit. It stops automatic retries for recognized terminal versions,
discards stale responses and directs administrators to the existing manual
Settings → library scan, without starting it. Original fallback is retained but
explicitly not presented as a repaired derivative. No media GET updates index,
Work, source satisfaction or an admission task.

Real backend/browser checks used three temporary synthetic images: missing
cache, reliable A, and unstamped legacy output. After replacing only these
synthetic sources, missing/legacy cases showed the accurate notice and original
fallback; reliable A still loaded and its output/stamp stayed byte-identical.
After an isolated index update, fresh detail URLs loaded new previews normally.
The update was a test-fixture fact change, not a production scan or UI auto-scan.
Version evidence is still size/mtime/recipe, not detection of replacements that
deliberately preserve both size and mtime. Coordination remains process-local.

### SLOW_CLIENT

A real paused HTTP reader on a valid 64 MiB temporary MP4 held its output read
lease. Hot reads alone did not hold the global maintenance lease. A same-output
rebuild held a generation/limiter slot while waiting for that reader; maintenance
then waited for the rebuild. Different hot and cold Sharp outputs could finish.
Abort released the writer in 2.76 ms and queued maintenance in 7.52 ms in the
recorded finite run; Range, send-error and follow-up write paths released leases.
No leak/deadlock was observed. The actual bug found was invalid Range becoming
500; it now remains 416.

The test uses actual sending, backpressure, locks, limiter, singleflight and
atomic writer. Only the video's rebuild encoder copies a valid tiny MP4 fixture;
these are lock-attribution times, not FFmpeg throughput. Waiting behind a slow
reader and subsequent FIFO maintenance remains an explicit tradeoff. No necessary
sendFile protection is removed, video is not buffered wholesale, and legacy
folder deletion remains outside scope.

### Feedback candidate validation

- Failing-first defects and affected suites pass. Final local Node24 full suites
  on `3d8c7d8`: server 1,486 passed / 2 existing skips (155 files); client 728
  passed (86 files). No skips/assertions/timeouts were relaxed.
- Server TypeScript, client vue-tsc and both production builds pass. The top-level
  Node `--run` wrapper mishandled the local Unicode cwd; the same compiler/build
  commands were run directly from the correct server/client directories. This
  is recorded, not labeled a successful wrapper invocation or changed in scope.
- Shared links, carousel/Viewer, access generations, Range, compression/hash
  delivery, background navigation and the existing 000027 checks remain covered
  by the final full suites. No 000027 rewrite, new migration or live data test.
- Exact Head CI and the final paired 4241 runtime are recorded in the PR and local
  delivery record after completion. The running 4141 trial remains unchanged.

### Five-round interleaved feedback measurements

Baseline `8a324e4` versus product candidate `3d8c7d8`, Node 24.19.0,
production builds, identical database/lock content, 1440×900 viewport and unchanged
fonts. Each dataset had one warmup and five measured rounds alternating AB/BA.
Fresh browser contexts and warm browser-cache navigation were measured separately.
Services were already ready; startup validation is excluded.

Values below are median [min–max] milliseconds from navigation. Card means the
first real feed card/link DOM plus a paint opportunity, not a skeleton or FCP.
Image means the fixed first carousel image completed with naturalWidth > 0, not
all media. Large indexed data contains 383,802 media / 7,619 posts; access to real
media was blocked, so it cannot provide real image completion measurements.

| Dataset / context | Card before → after | Moments DOM before → after | Fixed image before → after |
| --- | --- | --- | --- |
| Indexed / fresh | 1389.3 [1372.8–1434.8] → 491.0 [475.5–504.4] | 1341.0 [1321.4–1434.4] → 971.8 [942.8–987.9] | Not measured |
| Indexed / warm | 1301.1 [1298.5–1340.6] → 411.5 [395.3–427.6] | 1251.1 [1245.0–1287.1] → 889.7 [863.7–917.0] | Not measured |
| Synthetic / fresh | 251.1 [246.8–274.9] → 247.7 [235.0–271.8] | 221.7 [213.3–256.6] → 264.7 [256.5–288.2] | 255.5 [249.5–278.8] → 251.9 [239.5–276.1] |
| Synthetic / warm | 166.4 [161.1–168.6] → 164.3 [160.1–171.3] | 134.2 [128.5–135.8] → 180.8 [172.9–185.5] | 170.4 [159.9–171.5] → 169.9 [159.0–170.4] |

Original five real-card samples, round order (milliseconds):

| Dataset / context | Before | After |
| --- | --- | --- |
| Indexed / fresh | 1384.3, 1372.8, 1389.3, 1434.8, 1419.2 | 475.5, 488.6, 494.4, 491.0, 504.4 |
| Indexed / warm | 1340.6, 1335.1, 1301.1, 1298.5, 1299.2 | 427.6, 415.0, 395.3, 411.5, 399.3 |
| Synthetic / fresh | 274.9, 257.6, 251.1, 250.3, 246.8 | 235.0, 248.7, 271.8, 247.7, 243.2 |
| Synthetic / warm | 168.6, 166.3, 161.1, 167.3, 166.4 | 164.8, 161.6, 160.1, 171.3, 164.3 |

The private measurement report retains all five feed-response, moments and image
samples, complete network start/end timelines, medians/ranges and raw JSON.
Synthetic data uses 96 temporary JPEGs / 24 posts with equivalent separate cache
roots. Warmup generated 23 derivative media and 23 version sidecars per variant;
the formal measurements used these outputs. Both versions made 8 ordinary app API
and 23 media requests per normal synthetic page. Images were effectively unchanged;
moments became about 43–47 ms later in this small dataset because feed receives
priority. This is a tradeoff, not a universal speedup.

Large-data blocked-media injection caused 62 → 99–100 media requests, including
the new bounded error diagnostics. It is not normal hot-cache request volume and
must not be reported as successful real-image acceptance.

| Isolated HTTP endpoint | Before median [range] ms | After median [range] ms |
| --- | --- | --- |
| Likes | 74.2 [67.5–81.7] | 3.2 [2.2–3.5] |
| Collections | 81.6 [78.7–84.2] | 1.5 [1.5–1.7] |
| Places | 69.9 [67.1–71.3] | 0.9 [0.8–1.0] |
| Feed | 149.0 [148.0–155.4] | 150.9 [142.9–153.5] |
| Moments | 663.0 [647.2–677.2] | 472.0 [454.9–475.1] |

Feed SQL itself did not improve. Moments SQL median fell 629.7 → 445.0 ms;
the three empty/sparse SQL reads fell 71.9/80.2/68.7 → 0.4/0.3/0.1 ms.
Storage checks remained about 0.3–0.4 ms and were retained. Concurrent small
requests still finished around 618–620 ms despite 0.7–1.3 ms of app processing:
queueing behind synchronous heavy work remains. Callback-to-finish is not packet
arrival-to-finish, and overlapping spans must not be added. JSON/compression/send
residuals were not isolated into exact independent CPU costs.

All five endpoint bodies were hash-identical across versions in both datasets.
Feed remained 716,095 raw / 101,859 Brotli bytes; moments 91,190 / 12,649 bytes.
Observed Node event-loop maximum across the whole indexed suite was 906 → 491 ms,
not P95. Browser long tasks were not eliminated: indexed fresh 0 → 1 (50 ms),
warm 2 → 4 (50–63 ms); synthetic zero in both versions.

### CI fixture correction and paired preview

The first feedback CI run `35977682269` failed only the existing combined review
recovery test at its unchanged 5-second limit. Logs do not identify its exact
blocking phase, and local full tests did not reproduce that timeout. Measured
fixture schema/seed setup performed repeated durable DDL commits (363 ms locally).
The follow-up groups only fixture initialization into one transaction (11 ms),
enables and verifies foreign keys, and confirms the transaction has ended before
testing recovery. The real on-disk database and all safety assertions remain;
38 affected tests pass without changing timeout or skip rules. Final CI is tracked
against the follow-up Head, not inferred from this local success.

Fixed 4241 now runs paired `3d8c7d8` application outputs from an independent
candidate worktree with isolated database, media, waiting area and cache. The
normal production entry performed a migration no-op on 000027, one full validation,
and skipped both legacy startup scans. Browser checks cover carousel/Viewer,
24-limit summaries, detail-on-demand, management navigation/back and narrow layout.
Later test/document-only commits do not imply the process reloaded. Port 4141
continues the existing `8a324e4` trial unchanged; this feedback round is not deployed.
