# Gallery path indexes and canonical work summaries

> 历史资料：阶段性能记录。基线、未部署描述和样本仅对应当时验证；当前能力见[功能](features.md)。

## Scope and implementation

Baseline: `d493c741825afdec9d6c90de90d9f9deeb3bf580`.

This change optimizes two read paths only. It does not change derivative dimensions,
quality, mode, naming/versioning, HTTP caching policy, generation concurrency or
the maintenance lock. It does not change gallery routes, source identity, admission,
acquisition or Stage 1–3 behavior. Production service, database and artifacts are
not deployed by this work.

### Derivative lookup

Migration `000020_add_image_derivative_path_indexes.sql` adds two ordinary,
non-unique, non-partial indexes, also present in `server/src/db/schema.ts`:

- `idx_images_thumbnail_path ON images(thumbnail_path)`
- `idx_images_preview_path ON images(preview_path)`

`imageRepository` and the lazy derivative routes retain their exact predicates and
record/authorization/error checks. Existing duplicate/empty paths remain legal;
the existing `NOT NULL` constraints are unchanged. There is no disk-first bypass,
new uniqueness requirement or deleted/trashed partial-index condition.

### Canonical creator list

`canonicalCreatorGalleryRepository.listVisibleWorks` keeps the existing paged Post
and cover projection, and adds one aggregate query for those page Post IDs only.
It no longer calls `postRepository.hydratePostItems`, fetches each item's EXIF/path
metadata or builds every media URL. The count query joins exactly the media set
used by the previous hydration, without new visibility filters.

The card contract is `CanonicalWorkSummary` (`representation: 'summary'`):

| Data | Preserved use |
| --- | --- |
| Post ID, folder identity, source path, canonical creator route | Existing navigation and links |
| Caption/carousel title/filename | Existing display title precedence |
| Cover thumbnail/preview metadata, width/height, type/duration | 2:3 card, video indicator, fallback |
| `itemCount`, `imageCount`, `videoCount` | Counts over the same complete work |
| Sort/taken timestamps, saved state, pagination | Existing order, filters and interactions |

The service maps only this cover; the client creator reading store holds summary
items, not complete details. `mediaItems?: never` prevents treating this type as a
full media payload. `FeedItem.mediaItems` remains available to other feed/share
entrances. `WorkGalleryView` retains its existing complete-detail fetch/cache:
only the selected work is fetched, including direct media links; Viewer switching
and closing do not re-fetch it. No background per-card detail fetch was added.

The existing explicit-primary Post projection is retained. Same-title different
Works remain separate, while a secondary copy remains reachable by its old detail
ID. No Work, LocalWork, SourceWork or media ID is rewritten.

## Measurement protocol

All production-scale measurements use a consistent read-only online SQLite backup
and two independent copies. Node 24 production server/client builds use the same
locked dependency graph. The baseline build comes from the fixed commit above in
an independent source directory, not from current production dist. The isolated
host imports the normal built `createApp` stack without starting index bootstrap,
watchers, scanners or recovery workers; it rejects non-GET/HEAD HTTP requests.
Its final DB/gallery/thumbnail/preview paths are asserted before DB import.

The fixed sample includes the library first page, one single-directory creator,
one multi-directory creator, a large image work and its media deep link. The list
limit remains 24. Private IDs, titles, media and database files are not committed.
Only the selected pages, opened works and their real sidebar avatar union have
prepared derivatives; bytes are identical in both isolated cache trees. Where a
sample cache did not already exist, it was generated in isolation before either
accepted browser run. This is neither a production cache warmup nor a cold-cache
benchmark. Production originals were read only for this bounded preparation.

Each SQL, service and HTTP condition has one warmup and five measured iterations.
Browser conditions use Chromium at 1440×1000, a new context for each initial visit,
then actual SPA navigation/Viewer interaction and return within the same context.
Date is fixed to keep the sidebar's daily choice identical; performance clocks
and timers are not frozen. Google Fonts alone is blocked identically using CDP.
No Playwright routing/mocking disables the browser's real HTTP cache.

Card appearance is visible DOM plus two animation frames, not trace-based FCP.
Image completion requires the same fixed visible target paths, `complete` and
positive `naturalWidth`. Reports distinguish card appearance, loaded images and
opening a work. SQL-only, HTTP headers/complete-body timing and browser timing are
not interchangeable. Resource Timing transfer bytes include protocol overhead;
decoded JSON size is reported separately from encoded body/network bytes.

Initial fixture diagnostics exposed Express's default dot-directory protection
and missing daily-sidebar cached avatars. Those failures were excluded. Isolated
build/data paths were moved to ignored non-dot directories and the bounded cache
union prepared; no product route or cache policy was changed to accommodate tests.

## Results

Windows, Node **24.19.0**, **282,344 images / 5,793 Posts** in the shared snapshot.
All times below are milliseconds, **median [min, max]**, five measured runs after
one warmup. There was no concurrent build/test load. These are local sample
measurements, not a latency guarantee for every gallery or a cold-cache promise.

### A. Exact repository path predicates (SQL only)

| Predicate/sample | Before | After |
| --- | --- | --- |
| Thumbnail, old first row | 0.0306 [0.0299, 0.0364] | 0.0329 [0.0295, 0.1052] |
| Thumbnail, recent row | 155.4056 [149.3924, 161.7415] | 0.0314 [0.0299, 0.0367] |
| Thumbnail, missing | 151.5373 [150.2967, 154.1852] | 0.0260 [0.0248, 0.0298] |
| Preview, old first row | 0.0333 [0.0284, 0.0443] | 0.0306 [0.0293, 0.0334] |
| Preview, recent row | 152.6704 [151.8553, 158.7885] | 0.0295 [0.0289, 0.0307] |
| Preview, missing | 151.7077 [149.2125, 153.8116] | 0.0245 [0.0240, 0.0261] |

All before plans: `SCAN images`. All after plans (old/recent/missing):

```text
SEARCH images USING INDEX idx_images_thumbnail_path (thumbnail_path=?)
SEARCH images USING INDEX idx_images_preview_path (preview_path=?)
```

The first-row scan was already cheap; its tiny timing change is noise, not an
index speedup. The same recent and missing paths are compared before/after.

On a disposable copy, the actual migration-up SQL took **671.36ms**; repeated
`IF NOT EXISTS` checks took **0.127ms**. Database size grew from **443,822,080** to
**471,732,224 bytes**, an increase of **27,910,144 bytes (26.62MiB)**. Image row
count, ID range and summed file sizes stayed unchanged; quick/FK checks passed.
The normal after-host startup separately applied migration 000020 in **556.61ms**.
Fresh/upgrade/repeat/reopen behavior is covered by the migration tests, not by
claiming that the SQLite file hash should remain unchanged.

### B. Existing derivative HTTP requests

`wait` is client fetch start through response headers; `complete` includes the
whole response body. Same path, same bytes, same existing disk cache each side.

| Sample | Before wait | After wait | Before complete | After complete |
| --- | --- | --- | --- | --- |
| Old thumbnail, 77,100B | 14.740 [12.509,15.798] | 1.804 [1.104,15.371] | 14.915 [12.693,15.965] | 2.018 [1.303,15.564] |
| Old preview, 306,780B | 14.702 [2.048,15.026] | 14.133 [3.769,15.085] | 15.264 [3.889,15.619] | 14.821 [4.888,15.933] |
| Recent thumbnail, 34,188B | 170.287 [159.491,176.424] | 15.719 [14.770,16.232] | 170.400 [159.592,176.526] | 15.839 [14.942,16.406] |
| Recent preview, 680,430B | 171.008 [168.107,182.498] | 12.855 [4.259,13.831] | 172.204 [169.250,183.603] | 15.062 [7.001,15.539] |

HTTP includes scheduler/connection/body overhead and is not the SQL-only number.
The wide old-thumbnail range overlaps; no deterministic speedup is claimed for
that already-cheap lookup. All returned the same `public, max-age=604800,
immutable` policy and unencoded bytes. No generation is needed in these runs.

### C. Same creator pages, same 24 works

| Metric | Ordinary before → after | Multi-directory before → after |
| --- | --- | --- |
| Nested media entries returned | 1,519 → **0** | 733 → **0** |
| Uncompressed JSON bytes | 965,120 → **21,894 (-97.73%)** | 380,210 → **19,787 (-94.80%)** |
| Repository query + assembly | 6.781 [6.427,7.232] → 2.480 [2.404,2.745] | 2.503 [2.260,2.675] → 0.979 [0.934,1.324] |
| Complete service (includes creator metadata) | 177.541 [171.700,178.341] → 175.704 [166.652,181.549] | 148.715 [142.784,150.937] → 145.700 [143.931,153.271] |
| HTTP wait | 190.425 [181.841,190.855] → 182.720 [175.487,186.917] | 154.958 [151.458,160.582] → 150.222 [141.736,155.553] |
| HTTP complete | 192.145 [183.562,192.624] → 182.870 [175.620,187.081] | 155.625 [152.167,161.320] → 150.358 [141.991,155.757] |

Each page still needs one list HTTP request, not 24 detail requests. Encoding was
absent in these local responses, so the HTTP body bytes equal raw JSON bytes;
browser transfer bytes including overhead are recorded separately below.

Summary assembly is cheaper and payload size is much smaller, but complete
creator service latency remains dominated by unchanged creator metadata queries.
The complete-service ranges overlap; a large service-time gain is **not** claimed.

### D. Browser and compatibility

Chromium **151.0.7922.34**. Both sides passed all five cases, each with one warmup
and five new-context measurements plus same-session return. The large work has
**1,207 media**; the same four first-viewport images (one selected preview for the
deep link) were required to load on each side.

| New-context entry | Card/visible-media DOM before → after | Fixed images loaded before → after |
| --- | --- | --- |
| Library | 1620.4 [1598.8,1635.2] → 1586.7 [1570.7,1613.2] | 2090.3 [2052.3,2158.7] → **1616.2 [1606.2,1650.0]** |
| Ordinary creator | 2331.9 [2274.7,2594.2] → 1725.3 [1676.7,1743.2] | 4284.4 [4181.8,4580.6] → **1760.2 [1711.8,1770.8]** |
| Multi-directory creator | 1957.7 [1910.7,1983.5] → 1671.2 [1645.4,1680.5] | 3372.0 [3318.9,3658.8] → **1711.7 [1684.9,1716.8]** |
| Large work | 2213.1 [2102.0,2232.1] → 1902.2 [1845.3,1913.6] | 4998.8 [4855.4,5664.2] → **1903.6 [1846.6,1914.9]** |
| Media deep link | 5532.0 [4749.6,5961.0] → 2041.1 [2001.6,2059.3] | 5535.1 [4752.9,5964.0] → **2044.0 [2004.7,2062.3]** |

The fixed-image median reductions are respectively **22.68%, 58.92%, 49.24%,
61.92%, 63.07%**. These gains combine the two changes and normal HTTP/UI behavior;
they are not an isolated attribution of every millisecond to summary assembly.

| Same-session interaction | Loaded images before | Loaded images after |
| --- | --- | --- |
| Return to library | 56.6 [51.9,63.7] | 64.0 [58.0,67.8] |
| Return to ordinary creator | 63.6 [62.3,64.0] | 63.9 [61.8,64.3] |
| Return to multi-directory creator | 63.6 [63.3,63.9] | 63.4 [62.1,63.9] |
| Close Viewer to large work grid | 59.1 [56.6,71.1] | 69.8 [54.8,73.2] |
| Reopen the deep-linked media | 81.1 [76.9,83.5] | 79.5 [74.1,83.4] |
| Click ordinary work → visible media | 3213.8 [3187.8,3254.8] | **238.6 [230.8,251.2]** |
| Click multi-directory work → visible media | 1680.8 [1626.6,1733.6] | **206.6 [199.3,222.9]** |

Already-cached return paths show no material gain; small changes/noise are retained
rather than removed from the report. Same-session return uses zero new list/detail
API requests. Initial creator entry still makes seven app/bootstrap/list API
requests, including exactly one work-list request; no card-details fan-out exists.

| Browser list response | Decoded/encoded body before → after | Actual `transferSize` before → after |
| --- | --- | --- |
| Ordinary creator | 965,120 → 21,894B | 965,420 → 22,194B |
| Multi-directory creator | 380,210 → 19,787B | 380,510 → 20,087B |

There was no Content-Encoding in this localhost setup. Opening the selected
ordinary work still transfers its full **13,472B** detail body (**13,772B** with
overhead). Viewer switching/closing keeps the cumulative detail request count at
**one**, not one per media or one per card.

The paired comparison passed all pagination metadata and every pre-existing card
field (IDs/order/title/cover URLs/dimensions/counts/interactions). All **318** paired
cached files retain their recorded SHA-256 and size. Actual browser runs had zero
HTTP errors, page errors or failed same-origin requests. The isolated gallery root
contains no real originals; accepted runs use the prepared existing derivatives.

Both ordinary and multi-directory interaction checks preserved 2:3 covers,
original-ratio `contain` Viewer, non-first-media selection and keyboard switching.
The multi-directory sample loaded two pages/48 cards, restored their order and
scroll position **400 → 400**, and retained the selected work's one detail fetch.
Unit/integration coverage additionally retains mixed image/video ordering,
same-title distinct Works, explicit primary selection, secondary-copy old links,
shared entrances and delete/recycle/authorization error behavior.

An initial diagnostic using Playwright's fixed clock affected Resource Timing.
That whole run was excluded. Accepted runs use only a Date proxy for daily seed,
with native Performance/Resource Timing and timers, and verify non-zero network
measurements. No product changes were made for this test-harness issue.

### Remaining latency and limits

New-context first entry still takes roughly **1.6–2.0 seconds** in these samples.
After-run ordinary-creator Resource Timing, for example, shows bootstrap requests
started around 59–69ms, with TTFB of about **613ms** for stats, **1,315ms** for
folders and **1,575ms** for the work list. These observations include server
queueing and do not measure each endpoint's exclusive CPU cost. Unchanged global
bootstrap/creator metadata work remains; it was not folded into this PR.

Global derivative URL versions and first-generation maintenance locking remain
unchanged. A truly cold original must still be read/decoded/generated and can
wait on the existing lock. The real Sharp synthetic cold-cache test verifies
correct generation/reuse, not a claim that cold-cache waits were optimized away.

## Validation

The focused tests cover actual indexed plans, legal duplicate/empty paths,
fresh/000019-upgrade/repeat/reopen migrations, batch count parity, full detail and
ownership/errors, and summary reading-cache separation. Existing scanner/upsert,
deletion, trash and share suites are part of the complete regression.

`lazy-derivatives-real.test.ts` additionally uses a real synthetic PNG, actual
Sharp, a temporary DB and real HTTP requests: first thumbnail/preview generation,
valid WebP/dimensions, identical cached bytes/mtime/ETag/headers on the second
request, stable URLs/original and missing-path 404. It does not mock the generator.

Local final regression: **111 server test files, 888 passed / 2 skipped (890)**;
**66 client test files, 432 passed**. The real Sharp cold-cache HTTP case passed.
Node 24 server TypeScript build and client `vue-tsc -p tsconfig.build.json` plus
production Vite build passed for the tested source. Existing large-chunk warnings
remain; no bundle-splitting change was added. Git diff whitespace check passed.

Private before/after raw JSON, snapshot, cache manifest and logs remain in the
ignored local evidence root. `gallery-compare.mjs` verified both page-field parity
and all 318 cache byte hashes. Both isolated benchmark hosts were stopped after
measurement; the existing production 4141 process was not stopped or replaced.

## Reproduction

Tracked helpers are under `scripts/perf/`; their outputs belong in Git-ignored
`data/gallery-perf*`, never a committed fixture directory. Use a clean baseline
source from the fixed SHA and this branch, the same Node 24 executable and locked
dependencies. Build both clients/servers into their own source directories.

1. `gallery-fixture.mjs prepare <production-repo> <evidence-root>` takes one
   read-only online backup and creates paired independent data roots. Do not
   re-run it over an existing evidence root.
2. `gallery-runtime.mjs <baseline-built-source> <before-data-root> <isolated-port>`
   starts only the read-only benchmark HTTP host (never port 4141).
3. Set `GALLERY_BENCH_FFMPEG` to the verified local ffmpeg absolute path, then run
   `gallery-samples.mjs <evidence-root> <production-repo> <url> <ordinary-id> <multi-id> <large-id>`.
   Selection and generated derivatives stay isolated.
4. `gallery-measure.mjs <baseline-built-source> <evidence-root> before <url>`
   records query plans, SQL/service timings, JSON bytes and HTTP timings.
5. Set `BROWSER_NODE_MODULES` to a directory containing the existing Playwright
   installation. Run `gallery-browser.mjs --url=<url> --samples=<ignored-samples> --out=<evidence-root>/before-browser.json`.
   No builds/tests run concurrently
   with accepted measurements. A failed warmup stops instead of publishing timing.
6. Send `stop` to the isolated host's stdin. Run `gallery-index-size.mjs <evidence-root>`
   once on a disposable snapshot copy, then start the after host
   with this branch's built source and the after data root on the same port.
   Normal migration applies only to that isolated database.
7. Repeat steps 4–5 with label/output `after` and exactly the same samples/cache.
   `gallery-compare.mjs <evidence-root>` checks page-field parity, all cached
   bytes, browser target sets and errors, then writes a local comparison report.

No production migration, scan, import, download, admission, deletion or service
switch is part of these commands. Do not point an isolated root at production.
