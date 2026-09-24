# Gallery performance optimization (draft)

Base: `321e5241296ada67ae31632c85a5d30deaf2e162` (PR40).

This is one ongoing Draft PR, not a release. It is not deployed to the live
gallery. Port 4241 uses paired production builds and a synthetic isolated library.

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

An already-open page requesting a removed old lazy chunk receives a real 404 and
needs a refresh to obtain the new HTML. No automatic reload or historical chunk
retention mechanism is introduced.

## Isolated measurements

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

## Validation status

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
