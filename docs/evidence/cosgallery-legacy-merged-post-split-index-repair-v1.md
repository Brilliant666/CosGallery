# CosGallery legacy merged Post split index repair V1 evidence

## Scope and safety boundary

- Repository base: `b272027c8faa7cbcca066a806dfa04152476504b`.
- Development branch: `fix/legacy-merged-post-split-index-repair-v1`.
- Production database was opened read-only for evidence only. All repair execution used a SQLite backup copy under the Windows temporary directory.
- The production gallery, inbox, processing directory, Recycle Bin, Stage 1/2/3 jobs, and Costuan extension were not mutated.
- The database schema remains at migration `000016`; no `000017` migration was added.

## Incident and root cause

Scan Runs 623 through 638 repeatedly failed with `UNIQUE constraint failed: post_items.image_id`. The creator-work scanner previously created or updated each work Post inside the per-directory loop. When a current work used Image IDs still owned by a legacy merged Post, the first destination insert hit the unique owner constraint before the obsolete Post was retired. The later `softDeleteMissingByFolder` call could not help because execution never reached it, and a soft-deleted Post would still own its `post_items` unless membership was explicitly released.

The unique index `idx_post_items_image_id` is intentional and remains unique. The repair transfers ownership atomically; it does not weaken the invariant, ignore inserts, duplicate Image rows, or special-case a production ID/title.

## Production read-only forensics

### Legacy Post

| Field | Value |
| --- | --- |
| Post ID | 36520 |
| creator folder ID | 1196 |
| source path | `眼酱大魔王w/眼酱大魔王w NO.036-052` |
| type | `carousel` |
| item count | 265 |
| caption | null |
| content rating | R15 |
| place | null |
| sort timestamp | 1554441982000 |
| taken at / source | 1538726688000 / `mtime` |
| deleted / trashed | false / false |
| created at | 2026-09-01 05:37:17 |
| updated at | 2026-09-02T06:27:55.712Z |
| likes | 0 |
| collection memberships | 0 |
| other foreign-key references to `posts.id` | 0 |

The ordered `(image_id, position)` membership contains 265 rows and has SHA-256 `d0233dba319fbfc055f9318300bb23680ac8ce8fccf64dd2ba517685e9b7c49a`. The schema/foreign-key audit found Post references in `post_items`, `likes`, and `collection_items`; the implementation also discovers any future foreign-key table that references `posts.id` and blocks automatic retirement when such rows exist.

### Media and current topology

- 265/265 legacy members were uniquely matched to exactly one present current work by the existing scanner move identity (file size, rounded mtime, extension, with basename tie-breaking).
- 13 rows were already indexed at the current NO.036 path; 252 retained the stale merged DB path before the scan but had a unique current physical destination.
- Unmapped items: 0.
- Ambiguous items: 0.
- Cross-creator items: 0.
- Active competing owners: 0.
- User-state conflicts: 0.
- The stale merged physical directory no longer exists.
- The creator has 114 current direct work directories. Sixteen current directories partition this legacy Post; there is no independent NO.050 directory.

The 16-way physical partition was:

| Work | Items |
| --- | ---: |
| NO.036 | 13 |
| NO.037 | 20 |
| NO.038 | 9 |
| NO.039 | 15 |
| NO.040 | 10 |
| NO.041 | 9 |
| NO.042 | 9 (8 images, 1 video) |
| NO.043 | 18 |
| NO.044 | 47 |
| NO.045 | 39 |
| NO.046 | 9 |
| NO.047 | 7 |
| NO.048 | 15 |
| NO.049 | 20 |
| NO.051 | 10 |
| NO.052 | 15 |
| **Total** | **265** |

Stage 3 Jobs 348–363 do **not** represent these 16 split works. They map to NO.083–NO.098. Each had a unique Source Work/local link and an `ingested` Download Task, but remained `reconciling` with `GALLERY_INDEX_INCOMPLETE` because the creator scan aborted on the older merged Post.

## Repair algorithm

`scanCreatorWorks` now finishes media discovery/move recognition for every direct work, verifies that every discovered media file is indexed, and builds one desired topology containing creator owner, work Folder, source path, ordered Image IDs, Post type, timestamps, and place.

`reconcileCreatorWorkPostTopology` then performs:

1. a read-only dry-run over the complete creator topology;
2. validation of unique source paths, unique Image targets, contiguous positions, same-creator Folder ownership, active filesystem paths, existing destination Posts, current item owners, legacy leftovers, and Post-level user state;
3. an expected-revision check after acquiring `BEGIN IMMEDIATE`;
4. destination Post creation/reuse and metadata updates;
5. removal of destination and verified legacy memberships;
6. ordered reinsertion of every destination membership;
7. per-Image verification that the final owner is exactly the expected destination Post;
8. soft retirement of fully drained legacy Posts, retaining tombstone ID/history;
9. destination item-count/order and legacy-empty verification;
10. `COMMIT`, or full `ROLLBACK` on any error.

Existing destination Post IDs and their own caption, likes, collections, trash state, content rating, and other state are retained. The scanner only invokes this coordinator in CosGallery creator-work mode; ordinary folders, stories, reserved carousels, viewers, and LocalIngest extraction/commit logic are unchanged.

Structured failure codes are:

- `POST_ITEM_ACTIVE_OWNER_CONFLICT`
- `LEGACY_POST_SPLIT_AMBIGUOUS`
- `LEGACY_POST_SPLIT_UNMAPPED_ITEM`
- `LEGACY_POST_SPLIT_CROSS_CREATOR`
- `LEGACY_POST_SPLIT_REQUIRES_REVIEW`
- `LEGACY_POST_SPLIT_CONCURRENT_CHANGE`

The thrown Scan Run error includes creator scope, legacy/target Post evidence, conflicting Image IDs, current/expected owner, and `rolledBack: true`; the dry-run log retains the complete conflict summary.

## User-state protection

Automatic retirement is blocked if a legacy merged Post has a caption, like, Saved/custom collection membership, trash state, non-default R18 rating, place, or any other row with a foreign key to `posts.id`. These states are neither discarded nor copied to every new Post. Separate tests cover every variant.

The current schema records the effective rating but not its provenance. Therefore a non-default `R18` value is conservatively treated as user state; the default `R15` value cannot be distinguished from a user explicitly selecting R15 without a future provenance schema decision. The real legacy Post has the default R15 value and no other user state, so V1 requires no schema change.

## Production-copy verification

The consistent source copy was:

`C:\Users\ExampleUser\AppData\Local\Temp\cosgallery-legacy-split-20260905-135935\production-copy.sqlite`

It had migration `000016`, `quick_check=ok`, zero foreign-key violations, 638 Scan Runs, and the same protected business-row hashes as production.

### Dry-run

| Metric | Result |
| --- | ---: |
| destination works | 114 |
| existing destination Posts | 82 |
| Posts to create | 32 |
| Images to transfer | 265 |
| legacy Posts to retire | 1 |
| affected legacy Post | 36520 (265 items) |
| user-state conflicts | 0 |
| unmapped conflicts | 0 |
| active-owner conflicts | 0 |
| all conflicts | 0 |

The 32 creations consist of missing current work Posts across the creator scope, including the 16 split destinations and the NO.083–NO.098 targets whose prior scans had never committed. The plan is topology-derived and contains no numbering or Post-ID special case.

### Final-code execution on a fresh copy

- Creator-scoped Scan Run 639: completed; 3,835 media scanned, 691 new index rows, 252 moved/updated rows, zero removed, zero warnings, zero errors.
- Topology commit: 32 Posts created, 265 members transferred, one legacy Post retired.
- Post 36520 after commit: `is_deleted=1`, `deleted_at` populated, zero `post_items`.
- Affected ownership: 265/265 Image IDs present, each with exactly one owner, distributed across the 16 expected split Posts with the counts above.
- The unique `post_items(image_id)` index remained unique.
- No `UNIQUE constraint failed: post_items.image_id` occurred.
- Other creators' complete Post/item row hash remained `037cfe56c8a8ff4036fecf8df9cf41e41a5b09bf726480591bd88da63a7eab49`.
- Archive creator/collection/work/source/local tables, Download Tasks, Metadata Tasks, and all LocalIngestJob rows retained their pre-scan hashes.

Creator-scoped Scan Run 640 immediately repeated the same scan:

- completed with 3,835 scanned, zero new/updated/removed;
- dry-run and commit both reported `createdPosts=0`, `transferredItems=0`, `retiredPosts=0`, `conflicts=0`;
- the complete Posts/post_items topology hash was unchanged across the second scan;
- no duplicate Image owner exists.

One earlier disposable-copy attempt intentionally lacked a usable `ffprobe` path and stopped while validating the NO.042 video. It made no topology commit: Post 36520 remained active with all 265 items. The final run used the already-installed media tools, started again from a fresh database copy, and produced the successful result above. This also confirms failure closes before a partial split.

### Stage 3 recovery readiness (read-only)

After the copy-only creator scan, Jobs 348–363 remained unchanged (`reconciling`, attempt 1, retained `GALLERY_INDEX_INCOMPLETE`), but each target now had a unique local link, `ingested` Download Task, and indexed Post/media count equal to its Job summary:

| Jobs / works | Expected and indexed media |
| --- | --- |
| 348–351 / NO.083–086 | 36, 32, 39, 29 |
| 352–355 / NO.087–090 | 41, 26, 33, 30 |
| 356–359 / NO.091–094 | 35, 33, 36, 31 |
| 360–363 / NO.095–098 | 41, 110, 109, 30 |

The repair therefore makes those Jobs eligible for a later explicitly authorized reconciliation recovery, but this task did not invoke that recovery or recycle any file.

## Automated verification

- Topology/scanner focused suites: merged-to-split, partial destination reuse, active owner, stale revision, every user-state variant, unmapped member, cross-creator owner, injected mid-transaction failure/rollback, strict idempotency, creator isolation, and synthetic Stage 3 reconciliation.
- Synthetic Stage 3 verifies that an already committed `reconciling` Job completes without extraction, recommit, media mutation, or attempt-count increase, while an `awaiting_review` Job remains byte-for-byte unchanged.
- Focused topology + CosGallery suites: 24 tests passed.
- Migration up/down/repeat and bootstrap suites: 18 tests passed; latest migration remains `000016`.
- Full server: 83 files, 486 passed, 2 skipped, 0 failed.
- Full client: 53 files, 303 passed, 0 failed.
- Server TypeScript build: passed.
- Client type check and production build: passed (existing large-chunk advisory only).
- `git diff --check`: passed.

## Production zero-write evidence

Production database before and after development/verification:

| Property | Before | After |
| --- | --- | --- |
| SHA-256 | `15D1A3C507FBA161D60B50BC7EF43F26861CFDAB6E637A0811492D224499012A` | same |
| size | 162,185,216 bytes | same |
| mtime (UTC) | 2026-09-05 04:37:03 | same |
| migration | 000016 | 000016 |
| quick check | ok | ok |
| foreign-key violations | 0 | 0 |
| Scan Runs | 638 | 638 |

Protected production hashes after verification match the task-start copy:

- Jobs 348–363: `4fce97c176314720f0e6979efa2b55e127c57ff9c11f3b12be54f7c8945bb74d`.
- Jobs 489/525: `024458e9d5e2319beb3513015c0224e88d413c88a5ce094eedb53e0195c8bc16`.
- all 588 LocalIngestJobs: `8de7d5a0051205d780d29bc39044ed20da9dc52dd7fea41836332df9511b3165`.
- Download Tasks: `1b63e73540e021ce5b6d0ae4aa58e99b06b4480f24525d1aaa66d16eee68b012`.
- Metadata Tasks: `b40e6cdfa0d3c70b72c5c0850035518e25793464508f487688ac956fa491a9d8`.
- Stage 3 settings: `8221d263364e5e03a60d857e429780caebbb5f842ed260b41efc840676d2898f`; allowlist count 18 and unchanged.

Filesystem metadata snapshots before and after were identical:

| Root | Directories | Files | Bytes | Snapshot hash |
| --- | ---: | ---: | ---: | --- |
| `<GALLERY_ROOT>` | 3,805 | 117,117 | 1,178,278,080,637 | `fc6fa58a47e167fc28eaf09d0972e3924e109bcc5fde01a0ef74f5ce2675c809` |
| `<INBOX_ROOT>` | 29 | 19 | 5,196,209,855 | `ec3488035154baf6114378eb2c7d95f3306fb70c21dfda65ac3ee7d0937526b0` |
| `<PROCESSING_ROOT>` | 82 | 832 | 10,390,615,277 | `ef9090f359c05c29d4ead3d9a3fea75295759cc3803e2c8aca765e5d2ba3bf39` |

The existing safety backup `gallery-before-yanjiang-348-363-reconciliation-20260905-123438.sqlite` remains present and unchanged. The user-reported 4141 process was already absent at task start (`NO_LISTENER_4141`, reported PID 56136 not running); the task did not start, stop, or restart production. Script remains on clean main `84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6`.

## Remaining production action

Production Post 36520 and Jobs 348–363 intentionally remain untouched. After this PR is reviewed and merged, production repair/reconciliation requires a separate authorization, a fresh consistency backup, a current-state dry-run, and a creator-scoped execution. Lunana Jobs 489/525 remain outside that scope.
