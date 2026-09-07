# Initial page load API optimization V1

## Scope and reproducibility

Base: `b08b0b9d669d8b7e3d2e1993e56d573f911976b5`.
Branch: `perf/initial-page-load-api-v1`. This change is for review, not production deployment.

The experiment uses Node24.19.0/x64 and production client/server builds in an
independent worktree. Both versions run sequentially on the same loopback port,
database copy and isolated derivative directories. SQLite online backup includes
committed WAL content. All effective storage paths are checked before importing
the application. Original media is read-only; writes remain in isolated derived
storage. Both startup scans are skipped, no watcher or real ingestion is started.

The production process and its on-disk client/server builds are not replaced.
The user's existing CONTRIBUTING.md change is excluded and preserved.

Each core route has one warmup and five valid fresh-context measurements. The
same-session library/creator/work/return chain is reported separately. Only
warm-server-cache runs enter the primary comparison; new derivative generation
is separately recorded. Browser caching remains enabled. OS cache is not cleared
or controlled. Builds and test suites do not overlap formal performance sampling.
Full samples, diagnostic traces and private-path details remain in ignored
`data/initial-load-audit/`, not in this PR.

## Confirmed causal paths

- App bootstrap starts stats and physical-folder loading concurrently. The first
  stats payload previously compared its count against an empty/in-flight list,
  requested force refresh and queued a second complete folder request.
- WorkGalleryView treated the first stats hydration as a business invalidation,
  requesting both work and creator again. App also invalidated the newly built
  in-memory reading context when that first stats payload arrived.
- Routes do not await the bootstrap Promise.all. Auth remains their required
  initial gate. Synchronous directory-summary SQL occupies the server event loop,
  delaying otherwise short work-detail requests before their handlers run.
- Physical-folder summaries repeat correlated aggregate and avatar projections.
  Request-scoped timing establishes this query as the dominant handler cost;
  request-local Scan Run lookups are secondary repeated work.

The isolated diagnostic distinguishes SQL preparation/execution, service spans,
synchronous filesystem calls, JSON serialization and HTTP completion. Nested
spans are not additive. Client response duration is not SQL execution time, and
coarse socket/event-loop observations do not measure all browser queueing.

## Implementation and correctness

The physical-folder list now batches active-post counts, representative counts,
all-member latest timestamps, story presence and ranked cover/fallback selection.
Explicit avatars retain the existing ownership checks. The original targeted
single-folder projection is unchanged and is also an independent test oracle.
The copied real dataset returns the same38 rows, every field and ordering.
EXPLAIN correlated-subquery plan entries decrease from21 to2 (owned-avatar checks).
The list captures the derivative version once per synchronous request rather
than once per folder; its value and URL policy are unchanged. No index or schema
migration is added.

FoldersStore shares its in-flight promise. A valid empty list is loaded data;
failure permits retry. Genuine force invalidations during a request coalesce
into a follow-up read, and all consumers wait for that read. Reset detaches old
responses without canceling other consumers. Initial stats establish a baseline
instead of invalidating data; subsequent count/scan/storage changes still refresh.
Mounted library/creator pages now observe real reading-state invalidation and
reject late responses through their existing request tokens.

Stats itself deliberately remains a fresh read for each call: its callers also
include post-mutation refreshes, so sharing an older read could lose a change.
Only the latest request in the same reset/identity/endpoint context can write back.
Authentication gates and server resource ownership are not bypassed. There is no
new TTL, localStorage business cache, query framework or polling strategy.

## Automated regression

- Client targeted initialization/store/navigation tests:60 passed.
- Client full suite:355 passed across57files.
- Server full suite:519 passed,2 existing skips across88files, including2 new
  batched-summary tests and existing migration/permissions/gallery coverage.
- Server TypeScript build and client production `tsconfig.build.json` typecheck
  plus Vite build passed. The extra broad client `tsconfig.json` check includes
  legacy test-fixture type errors; it is not the project's production build gate.
- `git diff --check` passed.

Covered cases include both initial response orders, a real invalidation while
loading, count-to-zero and same-count/new-scan changes, shared consumers, empty
results, failure/retry, merged force, late reset/permission responses, current
page invalidation, deleted/trashed/zero-member posts, avatar ownership and cover
priority. Existing500-item work galleries and mixed-media/navigation tests remain
in the full suite. Performance thresholds are not asserted in CI.

## Paired browser measurements

All values below are milliseconds, median [min–max], from five valid samples per step.
Before and after each contain42 runs:7 warmups and35 measurements; all primary
measurements generated zero derivatives. E starts in a fresh context but subsequent
steps share that session. It is not compared to a fresh-context direct entry.

| Route / step | First content before | First content after | Viewport media before | Viewport media after | API before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| /library | 3993 [3932–6723] | 1089 [1029–1124] | 8116 [8033–14272] | 2010 [1961–2041] | 8 → 7 |
| /library/2 | 4190 [3948–6840] | 1107 [1033–1225] | 12444 [8493–15236] | 2490 [2404–2671] | 8 → 7 |
| /library/166 | 6838 [3988–7140] | 1129 [1054–1203] | 11997 [8651–15624] | 2585 [2522–2662] | 8 → 7 |
| /library/2/works/88136 | 7243 [7051–7441] | 1160 [1025–1227] | 16142 [15878–16472] | 2811 [2637–2889] | 11 → 8 |
| /library/166/works/88555 | 7079 [6990–7319] | 1221 [1055–1347] | 16173 [16018–16343] | 2954 [2835–3114] | 11 → 8 |
| same work + media=94778 | 13656 [13476–14408] | 1741 [1638–1897] | 14163 [13975–14708] | 2114 [1869–2174] | 11 → 8 |
| E: filtered library | 6826 [6030–7012] | 977 [938–1011] | 14210 [10113–14594] | 1910 [1586–1929] | 8 → 7 |
| E: creator166 | 247 [120–444] | 130 [114–247] | 1944 [1082–2127] | 1063 [1056–1171] | 1 → 1 |
| E: work88555 | 308 [258–337] | 247 [234–275] | 3292 [1469–3475] | 1430 [1419–1457] | 2 → 2 |
| E: return creator | 50 [40–50] | 44 [37–52] | 215 [206–217] | 211 [203–218] | 0 → 0 |
| E: return library | 76 [64–108] | 46 [42–52] | 76 [64–108] | 46 [42–52] | 1 → 0 |

The normal new-context content and viewport ranges are clearly separated. Auth,
framework and initial controls are not uniformly faster; no universal speedup is
claimed for them. Return-to-creator remains zero-API with overlapping timing ranges.
The formerly invalidated library return now reuses its valid reading state.

### Retained raw content / viewport samples

Each cell preserves measurement order; integers are rounded milliseconds.

| Step | Before content | After content | Before viewport | After viewport |
| --- | --- | --- | --- | --- |
| A | 6723, 4130, 3932, 3967, 3993 | 1029, 1124, 1118, 1089, 1076 | 14272, 8262, 8033, 8116, 8092 | 1961, 2041, 2035, 2007, 2010 |
| B | 3948, 4053, 4190, 6824, 6840 | 1033, 1110, 1225, 1107, 1105 | 8493, 8789, 12444, 14970, 15236 | 2483, 2404, 2671, 2490, 2553 |
| C | 6838, 7140, 6924, 4157, 3988 | 1054, 1146, 1129, 1118, 1203 | 15432, 15624, 11997, 8816, 8651 | 2522, 2585, 2640, 2583, 2662 |
| D2 | 7441, 7051, 7105, 7362, 7243 | 1206, 1160, 1034, 1025, 1227 | 16472, 15878, 16005, 16147, 16142 | 2889, 2811, 2683, 2637, 2877 |
| D166 | 7319, 6990, 7079, 7018, 7194 | 1259, 1221, 1347, 1072, 1055 | 16316, 16173, 16093, 16018, 16343 | 3009, 2954, 3114, 2839, 2835 |
| F | 13476, 13656, 13666, 13646, 14408 | 1638, 1897, 1741, 1685, 1831 | 13975, 14155, 14183, 14163, 14708 | 2071, 2114, 2174, 1869, 2164 |
| E-library | 7012, 6826, 6827, 6795, 6030 | 977, 1011, 1010, 969, 938 | 14594, 13960, 14210, 14361, 10113 | 1911, 1929, 1910, 1586, 1855 |
| E-creator | 247, 317, 444, 236, 120 | 130, 132, 114, 247, 126 | 1944, 1962, 2127, 1904, 1082 | 1058, 1093, 1063, 1171, 1056 |
| E-work | 337, 300, 321, 308, 258 | 247, 234, 245, 252, 275 | 3369, 3475, 3234, 3292, 1469 | 1430, 1419, 1427, 1435, 1457 |
| E-return-creator | 50, 50, 50, 50, 40 | 37, 52, 44, 40, 50 | 217, 216, 215, 215, 206 | 203, 218, 211, 207, 218 |
| E-return-library | 75, 108, 76, 91, 64 | 48, 46, 52, 44, 42 | 75, 108, 76, 91, 64 | 48, 46, 52, 44, 42 |

### Browser-observed API response durations

These intervals run from fetch start through response body reading/JSON decoding.
They include queueing and must not be called SQL time. Duplicate before requests
are all retained; medians for even request cohorts average the middle two values.

| Step | API | Before | After |
| --- | --- | ---: | ---: |
| A | /api/folders | 3413 [3257–6264] | 559 [553–568] |
| A | /api/cos-gallery/creators?page=1&limit=50 | 3484 [3462–6362] | 604 [600–621] |
| B | /api/folders | 4663 [3294–6257] | 551 [548–573] |
| B | /api/cos-gallery/creators/2/works?page=1&limit=24 | 3691 [3509–6447] | 662 [656–679] |
| C | /api/folders | 4879 [3274–6489] | 569 [548–573] |
| C | /api/cos-gallery/creators/166/works?page=1&limit=24 | 6387 [3535–6654] | 659 [639–675] |
| D2 | /api/folders | 6276 [6172–6462] | 560 [556–567] |
| D2 | /api/cos-gallery/creators/2/works/88136 | 6302 [6066–6544] | 589 [583–607] |
| D2 | /api/cos-gallery/creators/2 | 6418 [6184–6660] | 662 [650–682] |
| D166 | /api/folders | 6262 [6128–6482] | 560 [542–570] |
| D166 | /api/cos-gallery/creators/166/works/88555 | 6308 [6059–6568] | 598 [585–611] |
| D166 | /api/cos-gallery/creators/166 | 6400 [6149–6658] | 654 [641–666] |
| F | /api/folders | 6315 [6180–6729] | 553 [546–566] |
| F | /api/cos-gallery/creators/2/works/88136 | 6410 [6041–6817] | 600 [586–613] |
| F | /api/cos-gallery/creators/2 | 6528 [6159–6934] | 674 [654–685] |

### Server attribution

The following handler profiles include warmups and valid samples, excluding later
regression traffic. They are not the same metric as browser request duration.

| Endpoint | Handler before | Handler after | SQL calls per request before → after | SQL execution before → after |
| --- | ---: | ---: | ---: | ---: |
| /api/folders | 5850 [3139–6264] | 292 [282–311] | 40 → 3 | 5847 → 290 |
| /api/admin/stats | 459 [253–488] | 265 [248–282] | 29 → 29 | 415 → 239 |
| /api/cos-gallery/creators/2/works/88136 | 3 [3–7] | 2 [2–3] | 8 → 8 | 1 → 1 |
| /api/cos-gallery/creators/2 | 117 [115–121] | 73 [68–77] | 38 → 38 | 114 → 71 |

Folder requests fall from84 to42 across the equal42-run cohorts, with SQL calls
per request40→3 (scope lookup, one batched summary, one derivative version).
Initial work/creator duplicate requests also disappear. Work payloads are not
truncated. JSON serialization is sub-millisecond at these sizes; folder-summary
SQL accounts for nearly all of that handler. Stats retains29 SQL calls and its
synchronous filesystem walk; unchanged handler timing also varies between runs,
so that variation is not attributed to code changes. OS scheduling/cache state is
uncontrolled; this is not a disk-cold benchmark or a P95/P99 claim.

All20 paired API-response contexts match full JSON hashes and ordered identity/count
sets. The one unpaired response is the intentionally eliminated library-return
request. Rendered counts and initial page sizes are unchanged.

### Warm-original confirmation and browser regression

After the paired runs, the original frozen build was restored only in the
isolated deployment. A and D2 each received another warmup plus5 valid samples.
The original bundle fingerprint was confirmed. A content/viewport medians were
6972/14821ms (API8), D2 were7093/15844ms (API11), with zero generation. All samples,
including the faster final D2 sample, are retained. This supplementary check does
not replace the primary dataset and supports that the main improvement is not
simply the later run receiving a warmer cache.

Separate browser regression passed15 core and8 additional cases: single/multiple
folder creators, non-first media, push/replace and Back/Forward, preserved grid
DOM and scroll, old links, invalid membership/cross-creator404,390px, Ctrl/middle
click and mixed video. Opening/switching/closing an already loaded work remains
API0/0/0, media1/1/0. Actual video playback stops and detaches on switch/close.
Observed existing derivative files retain size/mtime; no cache policy is changed.

The first video regression failed because the isolated launcher omitted the
production encoder setting: installed FFmpeg has NVENC but not libx264. Only the
ignored launcher was corrected to `h264_nvenc`, then the missing isolated video
preview was generated and playback passed. That failure is preserved. Both
primary benchmark variants had the same unused libx264 default, zero generation
and no video transcode; their paired measurements are unaffected. The later
confirmation also does not transcode video. This is not a product-code fix or a
claim that new video generation was part of the primary warm-cache benchmark.

## Safety and remaining costs

Final read-only production checks show29 complete table hashes unchanged,
migration000017, quick_check=ok and no foreign-key violations. All588 ingested
jobs,2323 active matched local works, source/download/metadata rows, creator166
preferences/bridges, historical topology and Scan Run657 remain unchanged.
Production client/dist and server/dist file hashes/mtime remain unchanged;
PID81852 remains healthy. CONTRIBUTING.md content and staging state are preserved.
No production scan, ingest, G-drive write, recycle operation or deployment took
place. Script remains unchanged. Temporary servers and browsers were closed.

Remaining measured costs are the unchanged stats handler (after median265ms,
29 SQL calls plus synchronous cache-directory counting), and the canonical
metadata handler which still constructs broader identity data (about73ms,
38 SQL calls for the sampled creator). Warm visible media still takes about2–3s
on these fresh-context pages. No decomposition proves that residual interval is
solely disk I/O or generation. These are separate follow-up candidates, not
justification for changing locks, concurrency, URL versions or cache policy here.

The associated PR must retain an Open/Ready, unmerged state with a successful
Verify run corresponding to its final Head. No production activation is included.
