# Costuan numbering reconciliation V1 evidence

Date: 2026-09-02 (Asia/Shanghai)

## Scope and baseline

- Repository: `Brilliant666/CosGallery`
- Base branch/SHA: `main` / `415718da8f6d33b66507a4c2da49f9fce157fc90`
- Working branch: `fix/costuan-numbering-reconciliation-v1`
- Production database: `data/db/gallery.sqlite`
- Pre-change backup: `data/db/backups/gallery-before-costuan-numbering-reconciliation-20260902-204933.sqlite`
- Migration before/after: `000015` / `000015` (no schema migration was needed)
- Production service was stopped for the dry-run and transactional apply.

The backup and the production database both returned `ok` from `PRAGMA quick_check`.

## Root cause and data-loss layer

The Costuan page directory text reached CosGallery intact. The Bridge payload and
`archive_catalog_collections.raw_directory_text` retained the original entries, including
`VOL`, `_NO`, and mixed-numbering records.

The loss occurred in the derived metadata path:

1. CostuanArchiveManager's historical `parseResourceDirectory` recognized `NO` and legacy
   numeric forms only.
2. Its derived `works[]` therefore omitted all pure `VOL` entries and part of the `_NO` data.
3. CosGallery trusted that lossy `works[]` during import.
4. The old local reconciliation indexed works by numeric `source_order` alone, so it could
   not safely distinguish `NO.013` from `VOL.013`.

CostuanArchiveManager was kept read-only. Its raw `resourceDirectoryText` was already
available in CosGallery, so the repair could be made safely and generically in CosGallery
without touching the Script repository's existing unpublished history or any browser,
transfer, login, or virtual-list behavior.

## Numbering model

The parser now uses the numbering scheme as part of identity:

- `NO.013`, `NO 013`, `NO_013`, `_NO.013`, and `-NO.013` -> `NO:013`
- `VOL.013`, `Vol.13`, `vol 13`, and `VOL_013` -> `VOL:013`
- `VOL.33 增刊` -> `VOL:033:增刊`
- non-standard supplement/unnumbered media entries -> `SPECIAL:<stable normalized text>`

Consequently, `NO:013` and `VOL:013` are distinct identities. The numeric value remains
available in the existing `source_order` column, while the canonical label, stable key,
scheme, original number text, full raw title, title, media declaration, declared image/video
counts, and declared size are retained in existing label/raw/metadata fields. No broad
multi-platform numbering schema was introduced.

Automatic association is restricted to the same exact creator. A scheme-aware number is
the primary key and a normalized title verifies it. Severe title disagreement is a blocking
review item. There is no edit-distance matching or ordered-folder binding. An unnumbered
local folder can fall back only to a unique exact normalized title in the same creator.
Two literal Costuan spelling variants (`咝`/`丝` and `自怕`/`自拍`) are normalized only for
that exact-title check; the untouched source spelling remains in `raw_title`.

## Before

Current database facts were recomputed rather than copied from historical reports:

| Metric | Count |
| --- | ---: |
| Active local works | 1,740 |
| Linked | 1,657 |
| Unlinked | 83 |
| Ambiguous | 0 |

| Creator | Local | Linked | Unlinked | Active Costuan source works | Missing source works |
| --- | ---: | ---: | ---: | ---: | ---: |
| 佳佳好难啊 | 44 | 0 | 44 | 0 | 0 |
| 五更百鬼 | 31 | 9 | 22 | 30 | 21 |
| 眼酱大魔王w | 98 | 81 | 17 | 97 | 16 |

Raw-directory recomputation found exactly 214 source entries:

- 佳佳好难啊: 44 (pure `VOL`)
- 五更百鬼: 56 (`NO` + three `VOL` entries)
- 眼酱大魔王w: 114 (mixed `NO` + `VOL`, including same-number collisions)

## Dry-run and apply

The final read-only dry-run reported:

| Planned operation | Count |
| --- | ---: |
| Source works to add | 87 |
| Source works to enrich/update | 127 |
| Local/source links to create | 83 |
| Preserved existing links | 90 |
| Numbering conflicts | 0 |
| Title conflicts | 0 |
| Unresolved local works | 0 |
| Blocking issues | 0 |
| Download tasks to create | 4 |

The dry-run left the production database size and modification timestamp unchanged.

One `BEGIN IMMEDIATE` transaction applied the main plan. A final parser review then retained
the leading separator in raw labels such as `_NO.010`; its separate dry-run proposed only
23 metadata enrichments, with zero link/task changes and zero blockers. A second transaction
applied that raw-label-only refinement. The final post-apply plan converged to:

- source works to add: 0
- source works to update: 0
- local links to create: 0
- download tasks to create: 0
- all conflict/unresolved counts: 0

The transaction would have rolled back if any blocker appeared or if this idempotent state
was not reached.

## After and creator results

| Metric | Count |
| --- | ---: |
| Active local works | 1,740 |
| Linked | 1,740 |
| Unlinked | 0 |
| Ambiguous | 0 |

| Creator | Local / linked | Active Costuan source works | True missing works |
| --- | ---: | ---: | ---: |
| 佳佳好难啊 | 44 / 44 | 44 | 0 |
| 五更百鬼 | 31 / 31 | 56 | 25 |
| 眼酱大魔王w | 98 / 98 | 114 | 16 |

The missing difference changed from 37 to 41 because complete source reconstruction exposed
four genuine not-yet-local works for 五更百鬼 (`NO.029` through `NO.032`). Four pending
download tasks were created for those works. The 37 previously known missing works remained
unchanged; no existing task was rewritten.

Creator-specific regression evidence:

- 佳佳好难啊: all 44 actual page `VOL` entries were created and linked by `VOL:<number>`;
  no synthetic entries were inferred from the declared collection count.
- 五更百鬼: `_NO.010` through `_NO.028` normalize to `NO` keys. The three unnumbered
  local 兔玩映画 folders uniquely and exactly verified `VOL.001` through `VOL.003` while
  preserving the full 兔玩映画 prefix.
- 眼酱大魔王w: local `NO.013` remains linked to source `NO.013`/work 1575, while
  local `Vol.13` links to source `VOL.013`/work 2326. The existing `NO` link was not replaced.

Duplicate checks returned no rows for collection/source IDs, scheme-aware numbering keys,
or multiple active local works sharing the same work. A comparison against the backup found:

- exactly 83 previously-null local links became linked;
- zero pre-existing local links changed;
- zero unexpected local fields changed;
- 87 source works were added and no pre-existing source/work identity changed;
- four tasks were added and no pre-existing task row changed.

## Real-data safety

All five real `LocalIngestJob` rows retained exactly the same complete-row SHA-256:
`2669f5761b0601ca7917b58b7381e938d454e27a445edf35d3728f127cc4be8c`.
Every job remains `ingested / done / passed / recycled` with `attempt_count = 1`.

Stage 3 settings and allowlist remained unchanged. The allowlist remains 倦倦喵. No LocalIngest
command, download, extraction, recycle-bin operation, or gallery scan was run.

Before/after recursive metadata snapshots for the three affected creator directories were
identical:

| Directory | Directories | Files | Bytes | Metadata SHA-256 |
| --- | ---: | ---: | ---: | --- |
| 佳佳好难啊 | 48 | 920 | 3,153,002,983 | `38FA465A9BB5A11239C11D95BBD84311826BC3F665819A2C650F368806ECEA68` |
| 五更百鬼 | 31 | 707 | 7,580,295,878 | `4B5570FF73C7D1B106CAD75210901F196E4058D10FC48E31B4E4F6F0912D24E4` |
| 眼酱大魔王w | 289 | 3,228 | 18,235,557,646 | `F3D9F9D8972D05B83CDF2528E720395BD214B48A8B2B26F47AC086B533CC117E` |

The root modification timestamps of `<GALLERY_ROOT>` and `<INBOX_ROOT>` were also unchanged.

## Verification

- Parser, import, reconciliation, collision, review-blocking, repeat/idempotency, and
  five-LocalIngestJob preservation tests were added.
- Existing migration up/down/repeat coverage passed; no new migration exists.
- Full server test suite passed.
- Client test suite passed: 42 files / 187 tests.
- Server and client production builds passed.
- Final production `PRAGMA quick_check`: `ok`.
- Final migration version: `000015`.

GitHub PR and Verify URLs are recorded in the PR description and final task report after the
branch is pushed. The PR is not merged as part of this task.
