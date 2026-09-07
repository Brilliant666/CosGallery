# Unified library routes and cache reuse audit V1

## Scope and checkpoint

This document records measured cache behavior on 2026-09-07. Initial and final
warm measurements, navigation regression and additional browser acceptance are
complete. Publication and the final Head's Verify are recorded on the associated
PR; this evidence does not authorize merging or production deployment.

Base: `c43b7c34d02bf17a09059a85a3d43f2ceb13d5a0`.
Branch: `feat/unified-library-routes-cache-audit-v1`.

## Unified reading implementation

Single- and multi-folder creators use `CanonicalCreatorView` at
`/library/:creatorId` and shared `WorkGalleryView` at
`/library/:creatorId/works/:postId`. Server pagination (24 works) feeds the
existing InfiniteLoader/FolderGrid; Post ID breaks timestamp ties. A bounded,
nonpersistent reading store retains loaded items and scroll, invalidated on
permission/index/business changes. Query state is flat and whitelisted;
Viewer retains one validated work return target rather than nesting parents.

Canonical scope requires a unique active matched folder bridge. Detail,
count and ownership share that scope; erroneous creator/Post pairs return 404.
Old creator routes redirect; uniquely mapped ordinary CosGallery Folder routes
first validate the physical resource and then redirect. Physical management,
unlinked/ambiguous folders, non-CosGallery and public shares keep their scope.
Folder summaries expose a separately named canonicalCreatorId; list mapping is
batched rather than adding a per-folder identity query.

Header metadata is read-only: existing deterministic cover selection is also
the avatar fallback, first nonempty description by ascending physical Folder ID,
distinct visible image/video counts across all associated folders. Existing
folder settings are not rewritten. Preferred ingest directory does not limit
reading or choose the only cover source. Local-directory actions are secondary
and label editing/sharing as physical-folder operations.

Production port 4141 was stopped at the initial check and was not started or
restarted for this audit. Production runtime performance was therefore not
observed. The production `.env` declared `lazy`, `preview`, concurrency `4`;
these are configuration-file observations, not effective running-process proof.

The production baseline snapshot reports migration `000017`, quick_check `ok`
and no foreign-key violations. The main task's final before/after comparison
reports identical full-row hashes for all 29 protected business tables. No cache
policy, quality, resolution, maintenance lock or global URL
versioning policy was changed for this audit.

The copied database also retains all 29 original table hashes, including 588
Jobs, 2323 active matched Local Works, 657 Scan Runs, creator preferences and
historical posts/membership. No migration, scan, ingest, recovery or recycle
operation was invoked. Main's preexisting `CONTRIBUTING.md` change is preserved
and excluded from this worktree/PR. Script remains clean at
`84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6`.

## Isolated runtime and conditions

The real-index browser experiment used a consistent database copy, an isolated
cache, read-only original-media access and the existing built server:

| Setting | Effective value |
| --- | --- |
| Worktree/CWD | `C:\Users\brilliant\Documents\ChatGPT\插件\Foldergram-CosGallery-unified-library` |
| DATA_ROOT | `<worktree>\data\library-audit\runtime` |
| Database | `<DATA_ROOT>\db\gallery.sqlite` |
| THUMBNAILS_DIR | `<DATA_ROOT>\thumbnails` |
| PREVIEWS_DIR | `<DATA_ROOT>\previews` |
| GALLERY_ROOT | `G:/cos图集` (originals read only) |
| DERIVATIVE_MODE | `lazy` |
| IMAGE_DETAIL_SOURCE | `preview` |
| SCAN_DERIVATIVE_CONCURRENCY | `4` |
| Local-ingest startup scan | `LOCAL_INGEST_STARTUP_SCAN=false` |
| Library startup scan | Existing index and matching successful gallery-root setting; log confirms skipped |
| Port/origin | `http://127.0.0.1:4245` |
| Process | Node `24.19.0`, isolated `data/library-audit/launch.cjs` importing `server/dist/index.js` |

Node executable: `C:\Users\brilliant\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.
The launcher is started with this executable from the above worktree, with
environment established before app imports. Production declared paths are
under `C:\Users\brilliant\Documents\ChatGPT\插件\Foldergram-CosGallery\data`:
`db\gallery.sqlite`, `thumbnails`, `previews`; production runtime was absent.
The copy was made using SQLite online backup, including committed WAL state.

Explicit environment paths were validated before loading application modules;
the launcher checks directory links and the final database path. Production-mode
dotenv loading does not override these explicit values. Logs confirm both
startup scans skipped. The launcher also rejects unfinished copied jobs and
pending deletion journals before loading the application. Original samples
reside on G: (Disk 3, WD Elements 25A3, USB HDD); derivatives on C: (Disk 0,
SOLIDIGM SSDPFKKW010X7, NVMe SSD), confirmed by the main task using Get-Disk and
Get-PhysicalDisk. OS file-cache state is not established. No OS-cache clearing
or production cache deletion was used.

Browser: headless Chromium, 1440x1000 viewport, DevTools Disable cache explicitly
**off**. A/B share one browser context; B navigates via `about:blank` and therefore
does not retain the same page DOM. C and D each use a fresh context, shared only
across the three sample visits within that scenario. Consequently later samples
can reuse sidebar images loaded by an earlier sample in that same context.
Fresh context does not mean cold OS or disk cache.

## Request chain

The samples use `/library/:creatorId/works/:postId`. Their JSON request is
`/api/cos-gallery/creators/:creatorId/works/:postId`, with companion creator JSON
and existing application bootstrap API requests. `/api` responses are no-store.

WorkMediaCard requests `/thumbnails/<shard>/<asset-key>.webp?v=657`; only an image
thumbnail failure may fall back to its image preview. Video grid cards use
posters, not video players. All twelve initial A-D work-page observations had
zero `/api/originals/` requests, zero `/previews/` requests, zero media-type
network requests and zero video DOM elements. Large previews/originals are not
part of this grid measurement. A separate Viewer preview experiment is recorded
below; actual original-image transfer and video playback were not measured.

The normal image Viewer uses the preview URL (or original under the configured
detail-source rule), with original fallback; originals are served through
`/api/originals/:imageId`. Video playback chooses the existing preview/original
strategy. These are code-path findings, not claims that these requests occurred
in the measured grid samples; the separate preview result does not claim video
playback was exercised.

In lazy mode, protected media routing validates the indexed image then checks
the output file. Existing files are sent directly, without the generation
queue, maintenance lock or source decode. Missing files are deduplicated by
absolute output path, enter pLimit, then the global maintenance lock; identity
and file existence are rechecked before generation. Successful derivatives use
`max-age=604800, immutable`, private plus `Vary: Cookie` with authentication,
otherwise public. Errors use no-store. Measured synthetic responses also carry
ETag, Last-Modified and Accept-Ranges; these do not prove browser cache hits by
themselves.

## Initial browser A-D measurements

`visibleMs` measures navigation until currently visible images report complete
and nonzero natural width. It includes application bootstrap and rendering; it
is not isolated filesystem-read or decoder time. Request counts include sidebar
and bootstrap requests. This is the **initial** run, not final optimized/warm UI
acceptance. New lazy requests can continue around the measurement boundary.

| Scenario/sample | Visible ms | All / image requests | Generation-log increment | Zero-transfer image resources |
| --- | ---: | ---: | ---: | ---: |
| A lunana 166 / 88555 | 13529 | 59 / 45 | 28 | 0 |
| B same sample | 3924 | 59 / 45 | 1 | 27 |
| A single-directory creator 2 / 88136 | 15189 | 57 / 43 | 23 | 15 |
| B same sample | 3929 | 57 / 43 | 0 | 36 |
| A video-containing sample 166 / 88589 | 14999 | 66 / 52 | 24 | 20 |
| B same sample | 4018 | 66 / 52 | 1 | 37 |
| C fresh context, 166 / 88555 | 11739 | 59 / 45 | 5 | 0 |
| C 2 / 88136 | 8337 | 57 / 43 | 5 | 20 |
| C 166 / 88589 | 8058 | 66 / 52 | 2 | 20 |
| D restarted isolated service, fresh context, 166 / 88555 | 8672 | 59 / 45 | 0 | 0 |
| D 2 / 88136 | 8364 | 57 / 43 | 3 | 20 |
| D 166 / 88589 | 7733 | 66 / 52 | 0 | 20 |

CDP cache events supplement Resource Timing zero-transfer image records. Neither
the all-request count nor a CDP request event alone means bytes were downloaded.
A is first page visit in this experiment, not guaranteed cold: later A samples
already share context/sidebar caches.

Before restart, 88 derivative files were recorded. All 88 retain identical
size, mtime and SHA-256 after restarting the same service origin with the same
database/cache; the later snapshot has 92 files. `fileReuse=true`. The captured
runtime log contains 127 generation lines for 127 distinct kind/path keys and
zero repeated keys (including subsequent creator/mobile visits). Thus positive
B/C/D generation increments represent newly requested lazy files, not repeated
generation of those existing outputs. Increment windows and asynchronous lazy
requests are not treated as exact per-page inventory accounting.

Both sessions logged skipped startup scans. Media URLs remain version `657`.
This is isolated full-application restart evidence, **not** a restart of 4141.
Per-image records and detailed network traces remain in ignored evidence files.

### Final-code warm repeat

`final-measure-results.json` repeats the same three samples and A-D procedure
with final code and already populated isolated cache. All twelve visits have
**zero** generation-log increments. All **192** existing files retain their
size, mtime and SHA-256 across restart, with 192 files afterward and
`fileReuse=true`. A means first visit of this run, not missing server cache.

| Scenario/sample | Visible ms | All / image requests | Generation increment | Zero-transfer image resources |
| --- | ---: | ---: | ---: | ---: |
| A 166 / 88555 | 12546 | 59 / 45 | 0 | 0 |
| B 166 / 88555 | 6508 | 59 / 45 | 0 | 30 |
| A 2 / 88136 | 20279 | 57 / 43 | 0 | 20 |
| B 2 / 88136 | 6527 | 57 / 43 | 0 | 43 |
| A 166 / 88589 | 19065 | 66 / 52 | 0 | 20 |
| B 166 / 88589 | 6602 | 66 / 52 | 0 | 38 |
| C 166 / 88555 | 21620 | 59 / 45 | 0 | 0 |
| C 2 / 88136 | 17841 | 57 / 43 | 0 | 20 |
| C 166 / 88589 | 14178 | 66 / 52 | 0 | 20 |
| D 166 / 88555 | 12415 | 59 / 45 | 0 | 0 |
| D 2 / 88136 | 14826 | 57 / 43 | 0 | 20 |
| D 166 / 88589 | 13263 | 66 / 52 | 0 | 20 |

Some A-C timing overlaps local full-suite tests/builds. This is cache-reuse
verification under the recorded conditions, **not a performance benchmark**;
differences from the initial run do not establish a speedup or regression.
Visible waiting persists with zero generation, so generation alone cannot
explain the complete observed navigation latency.

### Real Viewer preview across isolated restart

`extra-results.json` records the actual Viewer preview request
`/previews/ec/ec8d418a281d1b38a8d6a3c275cd5a36.webp?v=657`, 427430 bytes.
After normal isolated-service restart, a fresh browser context requests it with
200, `public, max-age=604800, immutable` and 73.3ms observed duration. File size,
mtime and SHA-256 are identical before/after; new generation logs: **0**. This
extends the thumbnail/browser evidence to a real preview, rather than relying
solely on synthetic E or browser cache. Actual video playback and original-file
transfer remain unmeasured; video acceptance here covers the poster-only grid.

## Synthetic E: actual missing files and new Node process

A separate route harness used sharp to create a 2000x3000 JPEG in its isolated
gallery. It loaded the real lazy routers and real derivative generators (no
generator mocks). All five paths were explicit, no `.env` was loaded
(`NODE_ENV=test`), and the harness never invoked application startup scanning.

- Node processes 75980 then 92972, normal close, same port 62783, DB and cache.
- Six concurrent thumbnail plus six concurrent preview HTTP requests returned
  200. Exactly two generation logs: one thumbnail and one preview.
- Fresh HTTP-client revisit: no new generation.
- Fresh Node and fresh HTTP clients after restart: zero generation logs.
- Original JPEG and derivative size/mtime/SHA-256 are unchanged across revisit
  and restart; Image row, asset key, URLs and Scan Run (null in fixture) unchanged.
- Generated thumbnail is valid 640x960 WebP / 1170 bytes; preview is valid
  1500x2250 WebP / 6114 bytes.
- First thumbnail requests: about 50-51ms; preview: 167ms. Revisit: 1.6/1.7ms;
  new process: 6.2/7.2ms. Single synthetic experiment, not a real-library SLA.
- Both harness processes stopped at completion.

This proves persistent reuse independently of browser memory. It tests the
actual lazy route/generator in a new process; A-D separately covers the complete
isolated application startup lifecycle.

## Confirmed performance clues and limits

1. `lazy-derivatives.ts` uses both configured concurrency and the shared
   `maintenance-operation-lock.ts`. Synthetic tests confirm distinct missing
   files serialize even with concurrency four; existing files bypass this lock.
   Scanner and permanent-deletion work share it. The actual wait contribution
   for a given real request has not been separately instrumented.
2. Initial `/api/folders` Resource Timing is roughly 3.19-3.53 seconds; initial
   loads often request it twice. Work JSON responses are approximately
   3.39-3.60 seconds. These are client-observed response durations, not isolated
   handler CPU timings. Bootstrap/API blocking or queueing is material evidence
   to investigate; it is incorrect to assign all visible waiting to an HDD.
   Final UI work must verify it introduces no extra duplicate requests.
3. `gallery-service.ts` uses the most recently finished Scan Run ID globally in
   derivative URLs. An isolated fixture adds unrelated completed scan metadata:
   unchanged image URLs change while original URL, entire Image row, asset key,
   and derivative files stay unchanged; fresh requests reuse disk files with no
   generation. `latestCompleted()` filters non-null `finished_at`, not only a
   successful status. No production Scan Run was created for this test.
4. Decode versus original-read time, OS caching and independent sendFile timing
   have not been measured separately. No claimed
   cache-hit speedup factor or disk-cold benchmark follows from these results.

Follow-ups, if separately authorized: profile the existing folder/bootstrap API
and avoid proven redundant invocations; measure maintenance-lock wait before
considering concurrency changes; evaluate asset-scoped URL invalidation rather
than global scan invalidation. This task does not implement those cache-policy
changes.

## Automated cache regression and evidence handling

Added `server/test/derivative-cache-reuse.test.ts`: existing-file lock bypass,
same-file concurrent generation deduplication and HTTP reuse, distinct-file
serialization, and unrelated-scan URL/disk behavior. Together with existing
lazy-derivatives, image-detail-source and api-cache-control tests: **4 files,
29 tests passed**, 6.48s. These tests use isolated DB/storage and synthetic
generator bodies; the separate synthetic E experiment above uses real codecs.

Final main-task full regression: server 87 files, 517 passed / 2 skipped;
client 55 files, 322 passed. Client/server builds and type checks passed.

`navigation-results.json` confirms 50 unique lunana Post IDs, foreign
creator/Post mismatch 404, creator scroll 2478 restored to 2478, work scroll
178 restored to 178, search/rating/loaded-range preservation and refresh with
50 cards. Legacy `/creators/166` resolves to `/library/166`; `/f/folder-10`
and `/folders/folder-10` resolve to actual canonical creator `/library/2`;
`/f/lunananya/works/5` resolves to `/library/166/works/5`. Explicit physical
directory entry `?physical=1` remains physical. `extra-results.json` additionally
passes browser Back/Forward and new-tab direct work access. Viewer closes back
to the original work URL. Main-task screenshots `loaded-mobile-work-166.png`
and `loaded-mobile-work-2.png` show fully loaded visible media at 390px without
horizontal overflow; desktop creator/work and Viewer-return screenshots are
retained with the ignored local evidence. Actual video playback is not claimed.

Raw `measure-results.json`, runtime logs, network events, screenshots, database
copy, synthetic scripts and `synthetic-5QP1q2/result.json` are under ignored
`data/library-audit/`; they are not committed. No credentials, full media
inventory or database is included in this document. Full-application isolated
servers were stopped normally after testing. The associated PR must remain
Open/Ready with successful final-Head Verify; no production activation is part
of this task.
