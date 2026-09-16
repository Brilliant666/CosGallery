# Work entry loading and targeted creator reads

Baseline: `e076a2bd2b9b8ffae937346fb3d8a796bf4953ac`.

## Scope

Two read-only optimizations: stop gating the work grid on auxiliary creator display
metadata, and scope the existing complete creator projection to one creator in
SQL. No migration is needed. Production service, artifacts, database and cache
configuration are not changed by this development work.

There is no cross-route detail cache, media pagination, virtual list, speculative
detail prefetch, derivative/cache migration, generation-lock change or URL-version
change. The selected work still returns all ordered media; creator lists retain
24 summary cards per page.

## Implementation and access boundaries

`WorkGalleryView.loadWork` starts the authoritative selected-work request first.
It uses display metadata from `creator-reading.pages` only for the same canonical
creator identity and current reading generation (invalidation clears the pages).
It never adopts a summary as complete detail or as authorization evidence.

Without saved metadata, the creator request runs independently: successful work
detail can render the actual grid and a non-first-media Viewer before the name
returns. Updating the name does not replace the grid. Ordinary auxiliary network
errors/HTTP 500 do not discard a successful work. HTTP 401/403/404/503 remain
blocking, including when they arrive before or after detail. The shared HTTP
authentication-invalidated event is unchanged. Work-detail failures remain errors.

Separate name request tokens plus the work token and reading generation discard
responses from another work/creator, a previous generation or an unmounted view.
Authorization, indexed-work/scan and storage changes retain detail revalidation.
The existing selected-work endpoint independently validates storage, unique
canonical folder ownership, readable Post state and media; it deliberately keeps
secondary-copy detail links available. Legacy physical-folder checks and redirects
are unchanged.

`getCanonicalCreator(id)` now requests `listFolderCandidates(id)` and
`listAliases(id)`. `selected_folders` constrains Posts before work/media aggregation
and constrains folder/ownership projection. All owners of those selected folders
remain in the grouping: filtering owners themselves to the requested creator
would hide ambiguous legacy ownership. The existing projection/cover-selection
code remains shared with the full gallery listing, preserving aliases, rating,
preference, roster state, directory metadata, counts and unavailable primary copies.

The shared canonical-folder subquery also selects the requested creator's folder
IDs first, then counts **all** active matched owners of those IDs. This retains
the unique-owner rule without grouping unrelated creators' folders.

`EXPLAIN QUERY PLAN` tests assert indexed `SEARCH` on
`archive_catalog_local_creator_folders(creator_id)` and `posts(folder_id)` in the
scoped projection. The real snapshot exposed a second issue: despite the scoped
predicate, the media aggregate started with `idx_images_trashed_listing`, walking
all visible media before looking up membership and filtering Posts. It took
102.43 ms in a diagnostic call, versus 2.73 ms for the scoped folder projection.

The aggregate now constrains join order to scoped Posts, their `post_items`, then
media primary-key lookups. Its diagnostic call was 7.62 ms with exactly equal
results. These single-call diagnostics are not benchmark medians. The scoped
cover fallback uses the same bounded membership order; named-cover selection uses
the existing `idx_images_folder_visible_sort` index instead of a global visibility
scan chosen to satisfy ID ordering. Full-gallery projection rules stay unchanged.

The resulting plan is `SEARCH posts (folder_id=?)` →
`SEARCH post_items (post_id=?)` → `SEARCH media USING INTEGER PRIMARY KEY`.
Existing indexes suffice; no schema/index changes are included.
There is no persistent metadata cache or per-work query loop.

## Validation

- Local full regression before the final join-order refinement: server 918 passed,
  2 skipped; client 446 passed. Final scoped-query/primary-copy tests: 11 passed.
- Server TypeScript, client `vue-tsc`, and both production builds passed on Node 24.
- Delayed and failed auxiliary requests, both orders of authoritative failure,
  detail failure, access changes, A/B races, reading invalidation, unmount and
  non-first-media deep links are covered in component tests.
- Real router tests retain 500 background cards through Viewer close, Back,
  Forward and Escape without refetching detail. Existing physical-folder routes
  and summary-vs-detail tests remain in the full suite.
- Scoped and full projections agree in multi-folder fixtures, including aliases,
  classification, inactive identities, missing/no-visible-work creators, ambiguous
  ownership and unavailable primary-copy records. Secondary links remain readable.

## Measurement protocol

Before uses verified production-build artifacts from the fixed baseline commit,
not the online service. After uses the independent development worktree build.
Both use Node 24, the same isolated database snapshot and equivalent copies of
actual derivative bytes. Two missing ordinary-work Viewer previews were prepared
only in isolation before either measured run and copied identically to both cache
trees; their generation time is not presented as an optimization result.
No startup, migration or validation time is
included in work-entry measurements. Production is not restarted or benchmarked.

Measurements use a fixed viewport, one warmup and three measured iterations per
sample/condition. Ordinary, large and multi-folder samples are private and remain
in ignored local evidence. HTTP completion, JSON bytes, grid DOM readiness and
actual target-image completion are different metrics. Grid readiness is not FCP;
showing a loading skeleton is not counted as a usable grid.

The benchmark blocks uncached derivatives and original-media requests equally on
both sides, avoiding regeneration during the comparison. Only the fixed cached
target images count toward image completion; this is not all-images completion or
a cold-derivative claim. Browser HTTP cache conditions are equal in both runs.

## Paired measurements (final implementation)

All values milliseconds, median [min–max], 1 warmup + 3 measured iterations. Node24 production, 1440×1000. Same historical isolated snapshot: 597 creators, 5793 posts, 282344 images. Not a current-production measurement.

Before source: e076a2bd2b9b8ffae937346fb3d8a796bf4953ac
After source: 9b718f6c58f71b1669fb6a031b8899cdcb4a9c54

## Standalone HTTP and exact JSON size

| Sample | Endpoint | Before | After | Bytes both |
|---|---|---|---|---|
| ordinary | creator | 172.42 [161.21–174.47] | 18.17 [12.25–26.57] | 887 |
| ordinary | detail | 15.2 [15.07–15.6] | 12.78 [2.98–15.1] | 23746 |
| ordinary | list | 177.85 [176.63–185.28] | 28.96 [28.83–31.97] | 20692 |
| multi | creator | 155.52 [153.08–159.71] | 14.98 [8.5–15.65] | 942 |
| multi | detail | 15.46 [14.84–15.53] | 15.56 [14.77–15.61] | 14336 |
| multi | list | 157.35 [150.84–160.18] | 15.49 [14.16–16.67] | 19787 |
| large | creator | 175.42 [162.95–180.68] | 14.85 [14.85–15.84] | 879 |
| large | detail | 13.33 [11.28–18.3] | 17.21 [16.75–27.8] | 622397 |
| large | list | 170.52 [164.08–183.32] | 15.74 [15.41–15.79] | 10118 |

## Actual DOM grid / fixed target image completion

| Sample | Entry | Grid before | Grid after | Images before | Images after |
|---|---|---|---|---|---|
| ordinary | direct | 1781.5 [1766.8–1782.8] | 1660.4 [1639.6–1672.1] | 1849.4 [1833.2–1857.5] | 1739 [1723.2–1755.7] |
| ordinary | fromCreator | 207.4 [207–217.5] | 64.7 [59.3–69.3] | 207.5 [207–217.6] | 64.8 [59.3–69.3] |
| ordinary | revisit | 204.7 [203.9–219] | 54.8 [54.8–69.7] | 204.7 [203.9–219.2] | 54.9 [54.9–69.8] |
| ordinary | deep | 1841.9 [1786.6–1863.2] | 1649.4 [1630.3–1677.9] | 1919.59 [1842.89–1923.41] | 1728.5 [1704.32–1755.06] |
| multi | direct | 1766.7 [1716–1778.6] | 1696.9 [1658.8–1723.9] | 1845.3 [1782.6–1859] | 1776.9 [1725.8–1804.7] |
| multi | fromCreator | 199.1 [193.4–201.3] | 60.7 [57.8–61] | 199.2 [193.5–201.5] | 60.7 [57.8–61.1] |
| multi | revisit | 186.4 [174.7–189.4] | 53.9 [53.7–69.3] | 186.5 [174.8–189.4] | 54 [53.7–69.3] |
| multi | deep | 1780.6 [1779–1838.4] | 1652.2 [1616.8–1688.3] | 1834.45 [1829.84–1900.85] | 1714.73 [1679.68–1746.49] |
| large | direct | 1838 [1829–1890.3] | 1722.8 [1711.7–1787.9] | 1929.2 [1898.4–1992] | 1799.2 [1795.5–1868.9] |
| large | fromCreator | 392.9 [376.9–400.6] | 258.4 [253.9–266.3] | 393 [377.2–400.7] | 258.8 [254.1–266.4] |
| large | revisit | 254 [249.4–276.6] | 121 [118.7–129.9] | 254.2 [249.6–276.8] | 121.4 [119.2–130.3] |
| large | deep | 1845.3 [1842.1–1849.2] | 1708 [1703–1712.6] | 1938.15 [1935.72–1939.25] | 1805.31 [1709.21–1812.73] |

## Network completion to grid

| Sample | Entry | Detail end → grid before | after | Creator end → grid before | after |
|---|---|---|---|---|---|
| ordinary | direct | 165.8 [160.3–175.5] | 14.3 [9.5–16.2] | 8.8 [8.7–15.3] | 1.6 [-2.5–4.5] |
| ordinary | fromCreator | 172.8 [172.2–173.2] | 22.4 [22–23.7] | 13.7 [7.7–17.6] | not requested |
| ordinary | revisit | 172.3 [172.1–173.5] | 24.1 [24–24.2] | 16.4 [16.2–16.6] | not requested |
| multi | direct | 147.5 [147.2–159.7] | 6.9 [5.7–14.8] | 6 [5.2–8.1] | 1.8 [1.7–10.5] |
| multi | fromCreator | 157.3 [154.7–157.6] | 21.8 [19.6–23.6] | 13 [11.1–15.4] | not requested |
| multi | revisit | 155.8 [142.1–157.4] | 22.6 [22.5–23.4] | 7.9 [2.8–15.3] | not requested |
| large | direct | 227.9 [222.5–237.9] | 95.9 [93.5–103.3] | 87.2 [79.8–87.8] | 93.5 [91–100.7] |
| large | fromCreator | 350.7 [333.9–356.2] | 212.8 [206.3–220.1] | 198.4 [196–212] | not requested |
| large | revisit | 206.7 [198.2–224.8] | 75.2 [73.4–86.1] | 61 [58.2–73.6] | not requested |

## Checks and limitations

- All 9 creator/list/detail JSON comparisons exactly equal, including IDs/order/cover/counts/full media details.
- Direct and deep links: one detail + one creator request in both versions. From loaded creator and revisit: one detail request retained; creator requests reduced from one to zero. No cross-route detail cache claim.
- Viewer open/switch/close: zero new detail requests; background element stable in every run; no pageerror.
- Normal/multi had no ≥50ms long task; large still has substantial DOM/layout long tasks (see summary), intentionally no virtualization.
- Direct entry still includes app/bootstrap/sidebar competition. Grid can precede creator response after; first images can remain delayed by server request queue. This is not a guarantee of faster cold generation.
- Initial fixed image targets are first four thumbnails, deep target is second media actual preview. Deep image value is driver-observed completion, other image values use requestAnimationFrame in page. Not FCP, not every image in album.
- Read-only real production cache copies; two missing ordinary previews generated only in isolation before both runs. No production derivatives or originals altered.
- Both versions block missing off-target derivatives and original requests to prevent generation. Safety routing disables browser HTTP cache equally; same-session loaded image reuse remains.
- Both isolated databases have identical listed business-table counts; no source/ingest/recover/claim action. Hosts use GET/HEAD-only production app without bootstrap scanners.

## Remaining scope

A cross-route revisit still requests the selected full detail; only the existing
creator reading state is reused. Viewer actions within a loaded work reuse that
work and its background grid, a different mechanism. Large works still create all
media cards, and uncached derivatives still use the existing generation path and
maintenance lock. Neither cost is removed by this change.
