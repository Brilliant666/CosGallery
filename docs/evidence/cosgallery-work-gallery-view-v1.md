# CosGallery Work Gallery View V1 — evidence

Date: 2026-09-04 (Asia/Shanghai).
Base: `0a241b7566589e73e4b669cb941655e38c62f3bc`.
Branch: `feat/cosgallery-work-gallery-view-v1`.
Scope: browsing only; independent worktree and ordinary review PR. Do not merge or activate production as part of this task.

## 1. Audit of the existing implementation

Before: `/library` (creator directory) → `/f/:slug` (`FolderView`) → `FolderGrid` cover → `/post/:id` (`PostView` + `PostViewer`).

- `LibraryView` uses existing folder slugs to enter creator pages.
- The canonical viewer route is named `image`, despite its `/post/:id` URL; `/image/:id` is a client route alias.
- Folder feed card `id` is a Post ID. A Post's `mediaItems[].imageId` is the concrete file identity; those IDs need not equal the Post ID.
- API `/api/posts/:id` resolves a Post. The legacy API `/api/images/:id` resolves an Image and then its owning Post. These rules are unchanged.
- `/api/folders/:slug/images` supplies the existing cover, title, count and Post ID. `FolderGrid` is also used by likes, collections, place/moment and public-share pages; feed and search have their own entry components.
- App already renders a second `PostView` over a background route stored in `imageModalBackgroundPath`. It locks the body and restores its previous scroll on close. Existing Router tests covered basic modal scroll selection, but not the new nested work route, query-selected media, or a complete gallery → modal → back sequence.
- Server configuration `appConfig.cosGalleryMode` and folder role distinguish CosGallery normal creator folders from ordinary mode / internal carousel-source folders.

The existing Post detail already provides Post ID, folder slug/name, caption/carousel title/source path, post type/count and the complete position-ordered media list. Each media item includes Image ID, position, filename, media type, dimensions, duration, animation flag, thumbnail/preview/original URLs, MIME, size, relative path, playback strategy and EXIF. No parallel Work API or media model was needed.

Only the folder summary response gains a backward-compatible, read-only `workNavigationMode` enum. Its value is `work-gallery` for CosGallery normal folders, otherwise `post`; both preloaded and fallback summary paths are tested. No database migration or schema change.

## 2. Navigation and independent gallery

New chain: `/library` → `/f/:slug` → `/f/:slug/works/:postId` → `/post/:postId?media=:imageId&context=work`.

- `work-gallery` uses the existing Post ID, never the first Image ID or a newly introduced database ID.
- `FolderGrid.navigationMode` defaults to `post`. Only the creator `FolderView` explicitly passes the server-provided mode. Carousel type, media count and `showWorkLabels` do not opt a grid into the new navigation.
- Existing feed/search/likes/collections/place/share entry behavior stays unchanged. Shared routes take precedence even if a caller supplies the work mode.
- A single-media work still opens a one-card gallery.
- Invalid/non-positive/unsafe Post IDs are rejected before fetching. A mismatched folder slug renders the same fixed not-found state and no media. The existing Post API still rejects deleted/trashed/not-found Posts and enforces private-library authentication.
- Errors, empty lists, unavailable storage and missing posters are explicit states. Retry fetches only the Post or that failed card; it never scans or repairs data.

The new page shows a back-to-creator link, creator, work title and image/video/total counts. It has no new management sidebar or editing actions.

## 3. Media rendering and performance

Both gallery and viewer derive the same ascending `post_items.position` sequence. Images/videos are never grouped by type, extension, date or aspect ratio.

- Row-major CSS Grid, not CSS columns; 2/3/4/5/6 columns at mobile/640/1024/1280/1600 breakpoints.
- Stable Image ID keys; each card has an accessible link and a lightweight ordinal.
- Images use async-decoded, lazy thumbnails with `object-fit: contain`; source dimensions do not crop the image.
- On thumbnail failure only that image may fall back once to its non-original image preview. Video previews and originals are never used as thumbnail fallbacks.
- Videos show only a poster, play icon and duration. No grid video players or autoplay.
- A failed card has a local retry without replacing unaffected loaded cards.

### 500-item browser regression

Synthetic temporary dataset: 250 images + 250 videos in an alternating position sequence; both landscape and portrait images. A small synthetic video validates the existing player after selection.

At 1440 × 1000:

- 500 accessible media links; positions 1–500 in exact DOM order; five CSS grid columns.
- Initial grid requested/loaded **50 of 500** thumbnails using native browser lazy loading, **0 previews, 0 originals, 0 video players**.
- Longest observed initial-page task: **89 ms**; total reported long tasks **149 ms** (includes application boot). No multi-second blocking or console errors.
- All 500 cards were reachable by scrolling; items 1, 17, 18, 19, 251 and 500 were exercised.
- After traversing the full gallery, a warm reload exposed the first grid in **96.7 ms**, with longest task **68 ms**. This is a warm reload measurement, not a cold-load/network guarantee.
- At the last video, exactly one player was present; no next-item or next-Post link existed.
- Final counters after interaction: 500 thumbnails, 5 selected-media previews, 0 original requests. These are whole-session counts, not initial-load counts.
- At 390 × 844: two columns; no horizontal overflow; no CSS columns.

No virtualization was needed for this V1 sample. Browser timing is evidence from this machine, not a general performance SLA.

## 4. Viewer identity, actions and history

Reused components: `PostView`, `PostViewer`, `CarouselMediaStage`, `VideoMediaPlayer`. No second viewer.

- `media` stores the exact Image ID. Missing media selects the first item. Invalid/non-member/array/unsafe input selects the first and removes the invalid query with `router.replace`.
- Media switches update `query.media` with replace, not push. A page reload/deep link preserves the selected item.
- In `context=work`, outer Post neighbors are disabled. Buttons, keys, wheel and touch stay within the current work; bounds do not wrap to another Post. Normal feed modal cross-Post navigation is retained.
- Current filename, relative path, dimensions, MIME, duration, size, EXIF, original links and folder-cover target use the active media, including single-media Posts whose IDs differ from Image IDs.
- Likes, collection membership, caption and deletion remain Post-scoped. Action tests are synthetic and mocked; no real data actions were clicked.
- Gallery state is independent of the viewer store, so media changes and closing keep its DOM and loaded thumbnails mounted.
- Closing a work modal pops its single history entry when the background matches; browser Back returns to the gallery once, then to the creator.
- Standalone work deep links provide a back-to-gallery route derived from the loaded Post and folder slug, never arbitrary external `returnTo`.

### Scroll issue found and fixed in browser testing

Going Back to the creator, reopening the gallery, scrolling farther and closing a second modal initially restored an older history position. Work-context modal scroll preservation now takes precedence over Router's stale `savedPosition`; normal non-work scroll behavior is unchanged.

Retested: first close at **887 px**, then reopen at item 251 and close at **17180 px** → exactly **17180 px**, not the old 887 px. Router and App history tests cover the precedence and mounted-background invariants.

## 5. Automated validation

Local runtime: bundled Node 24.19.0; frozen-lockfile dependencies. CI retains the repository's existing Node 22 / pnpm 10.28.0 Verify workflow, unchanged.

| Check | Result |
| --- | --- |
| `pnpm --filter client test` | 50 files, **260 passed**, 0 failed |
| `pnpm --filter server test` | 77 files, **425 passed, 2 conditionally skipped**, 0 failed |
| Router | 9 passed; new route and work modal scroll priority included |
| FolderView / FolderGrid | 3 / 6 passed; explicit opt-in, default and shared behavior |
| WorkGalleryView | 22 passed; order, counts, missing/deleted/trashed errors, slug, empty, storage, retry isolation, 500 items |
| Media-selection composable | 15 passed; identity, query cleanup, reload and replace |
| PostViewer | 9 existing + 6 work-context tests passed |
| PostView | 1 existing + 1 work deep-link test passed |
| Viewer store | 3 passed; success, stale response and error |
| App nested work navigation | 2 passed; close and browser back, history length, DOM/scroll retention |
| Existing image/video/share/auth suites | Passed as part of full suites |
| Migration up/down/repeat | Passed in existing temporary-database migration-bootstrap suite |
| `pnpm --filter server build` | TypeScript and server build passed |
| `pnpm --filter client build` | vue-tsc and production Vite build passed |
| `git diff --check` | Passed |

The two existing server skips are optional Windows video LocalIngest E2E tests gated on the test environment's FFmpeg configuration. No real ingestion was enabled to run them. Migration tests use temporary databases; production migration remains **000015**.

Existing non-blocking warnings remain: repeated Vue i18n installation in some existing video unit tests, and the existing large main-bundle warning from Vite. No workflow, dependency, runtime or unrelated build refactor was added.

## 6. Read-only real-data browser checks

Test port: **4243**, never production 4141. The isolated harness imported `createApp`, **not** server startup/index: no startup recovery, watcher, scanner, metadata planner or LocalIngest execution.

All application database activity went to a temporary copy; derivative files went to temporary DATA_ROOT. The harness allowed GET/HEAD only, rejected mutation/scan/ingest endpoints, and guarded filesystem mutation methods against G-drive targets. The dedicated browser tab and temporary listener were closed after testing.

Temporary roots (not committed):

- `%TEMP%/cos-work-gallery-synthetic-LnlQjm`
- `%TEMP%/cos-work-gallery-real-UPROuU`

No SQLite, real media, thumbnails, screenshots, passwords, tokens, cookies or per-file absolute path lists are included in this evidence or PR.

| Existing sample | Post ID | Images / videos / total | Selected media evidence |
| --- | --- | --- | --- |
| Pure image | 88080 | 31 / 0 / 31 | Position 16 → Image 92539; next → 92540 at 17/31, metadata and links update |
| Pure video | 87984 | 0 / 1 / 1 | Poster first, no grid player; click → Image 87984, one player, readyState 4, no playback error |
| Mixed image/video | 88059 | 16 / 2 / 18 | Position 1 → 90691; position 18 → 90708 at 18/18; previous → 90707 at 17/18 |

For all three, creator covers first entered their independent work-gallery route. Actual mixed Image IDs are not monotonic; DOM ordering follows position, not ID.

- Pure image close/back: all 31 cards remained loaded; returned to **887 px**, then Back reached the creator.
- Mixed video close/back: all 18 cards remained loaded; returned to **627 px**; zero players after close.
- Current media paths, dimensions, MIME, duration, size and original-link targets were checked without clicking download/open-original/cover/like/edit/delete actions.
- Real mobile check at width 390: two columns, document width 375 (scrollbar included), no horizontal overflow.
- Real session browser error/warning log: empty.
- Real session request counters: 126 thumbnails (includes creator/sidebar covers), 6 selected-media previews, **0 originals**, **0 rejected mutation requests**, **0 attempted G writes**. No Stage 1–3, scan or repair request was made.
- Lazy derivatives were produced only below temporary DATA_ROOT, never the production cache.

## 7. Production safety: before = after

Production service was already **stopped** at task start (4141 had no listener), despite the historical expected URL. It was not started or restarted. PID before/after: null/null.

Production database was accessed only via file hash/stat, read-only SQLite queries and a read copy into temporary storage. The app never connected to the production database.

| Fact | Before | After |
| --- | --- | --- |
| DB SHA-256 | `44d9746859a4cae22b46eb2f647031a8c365ef90bfc6f90eaabec22d6e2910b0` | identical |
| DB bytes | 132755456 | identical |
| DB mtime UTC | 2026-09-03T12:55:14.8974661Z | identical |
| Migration | 000015 | 000015 |
| quick_check | ok | ok |
| foreign_key_check rows | 0 | 0 |
| Active local works | 1836 | 1836 |
| Linked / unlinked / ambiguous | 1836 / 0 / 0 | identical |
| All local-work rows (including inactive) | 1837 | 1837 |
| LocalIngestJob rows | 101 | 101 |
| Download Task rows | 604 | 604 |
| Stage 3 settings/allowlist hash | `1d95fafcb9ea075b1f5150b18a86640c1ee60f8dc362cadf9c914f8597f0dd0f` | identical |
| Production main | `0a241b7566589e73e4b669cb941655e38c62f3bc` | identical, clean |
| Script main | `84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6` | identical, clean, v0.6.10 |

Full business row hashing: enumerate every column in schema order; serialize each using SQLite `quote()`, join fields with `|`, sort rows by primary ID, join rows with CRLF plus a final CRLF, SHA-256. This includes timestamps and all persisted business fields, not only counts.

| Table | Rows before/after | SHA-256 before | After |
| --- | --- | --- | --- |
| `archive_catalog_collections` | 35 | `c539c22fcde2c0fc0daefe1a957677657cf0eafdedf02a9da33a92053174b74b` | identical |
| `archive_catalog_creator_aliases` | 633 | `67572468d567210efdf738277c5a89efb6123f5da04fabfd5165dcabbbc19e49` | identical |
| `archive_catalog_creator_sources` | 628 | `e3fcce5f70236af0e0059509cedf7e614a0354a0222c49baba9d1a62f9ca4829` | identical |
| `archive_catalog_creators` | 593 | `52e489c429de9e5f609215bbd58a0922badf25867b2f51714f0dee6ec3696e3c` | identical |
| `archive_catalog_deliveries` | 34 | `2923cec4af97977a1ff3bd5537125952183ef6bac7a8cf13a1b9ac91fcd1bd2b` | identical |
| `archive_catalog_download_tasks` | 604 | `e10b97038080a26fd8199db114387da18c036a320e730faeffea63bfc03a8c70` | identical |
| `archive_catalog_import_runs` | 23 | `0f28623c9abc744849eb7f04da24cd336c7470ee912416ba6f22d68d21b053f1` | identical |
| `archive_catalog_local_creator_folders` | 33 | `72154925580954b11d643a03eab4aa39e8e90c51533a17aaa2f583fef77804bf` | identical |
| `archive_catalog_local_works` | 1837 | `75457bca9a05c35716eeebb650743b47123976f22ded2de49697f81adb85845e` | identical |
| `archive_catalog_metadata_tasks` | 17 | `128e1d0738558953c119f337860468658311ff0f8984a2c0b3651f146331e557` | identical |
| `archive_catalog_source_works` | 2342 | `9880c5922fea27c0973b53190eb2bcd07e0674c3c46c4d90b1bb506aadad8243` | identical |
| `archive_catalog_works` | 2342 | `c3b80c62d986bf106d4eda2a4aaa7085d3b9ae97300191998341aa20e68a6c52` | identical |
| `local_ingest_jobs` | 101 | `15064ea24d464ba7138cbbaf8d4d928b1ee633ecdd37ffd59121d2e0059f35c2` | identical |

Filesystem metadata checks (no full-library scan):

| Root | Creation UTC before/after | Last-write UTC before/after | State |
| --- | --- | --- | --- |
| G: gallery root | 2026-08-30T05:34:35.0415482Z | 2026-08-31T20:11:21.1686403Z | unchanged directory |
| G: inbox root | 2026-08-31T08:46:06.5721864Z | 2026-09-03T07:22:12.4039023Z | unchanged directory |
| G: processing root | 2026-09-02T05:59:13.2348502Z | 2026-09-03T12:55:14.6574613Z | unchanged, empty |

The complete structured before/after snapshot matched exactly. No production business writes, G-drive writes, real scans, ingestion, renames, deletions, cover edits or recycle operations were performed.

## 8. Delivery boundary

Only browsing components, tests, the read-only folder navigation hint and this evidence belong in the PR. Main and production remain untouched; the PR is to be Ready, Verify-green and **open/unmerged** for human review. PR/check URLs and final head are recorded in the task handoff, avoiding a self-referential evidence commit.

Unchanged: R15/R18 bridging, Stage 1/2/3, LocalIngest, creator-scoped reconciliation, recycling semantics, database schema/migrations, Script/CostuanArchiveManager, cross-platform logic and deployment architecture.

No known blocker remains within work-gallery browsing. Existing viewer/admin appearance, creator classification and unrelated runtime warnings are outside this task.

## 9. Borderless media follow-up (2026-09-04)

The existing PR received a presentation-only follow-up: the shared image/video media link no longer has a persistent border or card radius, and the work-gallery grid now uses the same compact `1px` rhythm as the creator cover grid. `object-fit: contain`, lazy thumbnail loading, media ordinals, video poster/play/duration overlays, retry behavior and the keyboard-only `focus-visible` outline remain unchanged.

Computed-style comparison on the same 31-image real-data sample, using an isolated hot SQLite backup and temporary derivative cache:

| Style | Before | After |
| --- | --- | --- |
| Persistent border | `1px solid` | `0px` |
| Card radius | `10.4px` | `0px` |
| Box shadow | `none` | `none` |
| Grid gap | `10.4px` | `1px` |
| Media fit | `contain` | `contain` |

Real-data browser checks covered a 31-image work, a one-video work and a mixed 16-image/2-video work. Image and video entries shared the same borderless container; the video grid contained posters and overlays but zero players. At 1294 px the mixed work used five columns; at a 390 px viewport it used two columns with no horizontal overflow. All media remained position ordered.

Regression results:

- focused WorkGalleryView, WorkMediaCard, work viewer and navigation suites: 34 passed;
- full client suite: 51 files, 264 passed, including the 500-item work gallery;
- full server suite: 77 files, 425 passed and 2 environment-gated video E2E skips;
- client type-check/build and server TypeScript build: passed;
- migration bootstrap/up/down/repeat coverage: 17 passed inside the full server suite;
- `git diff --check`: passed.

The production 4141 service was already running when this follow-up began and was neither started, stopped nor restarted. The browser harness used port 4243, an ignored temporary database snapshot and an ignored temporary cache. The production database, `G:\cos图集`, `G:\cos待入库` and `G:\cos处理中` were not opened through mutating application endpoints or modified by the follow-up.
