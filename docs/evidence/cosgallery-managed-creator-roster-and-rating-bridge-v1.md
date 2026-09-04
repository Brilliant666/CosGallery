# Managed creator roster and rating bridge V1

## Pre-change audit (2026-09-04; before implementation)

- Base/main: `51fc81680c59b61744aa13cbacee13729e39fb30`; main and Script worktrees clean.
- Branch: `feat/managed-creator-roster-rating-bridge-v1`, independent `Foldergram-CosGallery-managed-creators` worktree.
- Production differs from the historical runtime expectation: port 4141 is **not listening**, and historical PID 285120 no longer exists. This task preserves that actual state and does not start/restart production.
- Production SQLite: migration 000015, quick_check=ok, foreign_key_check empty; 132755456 bytes; SHA-256 `44d9746859a4cae22b46eb2f647031a8c365ef90bfc6f90eaabec22d6e2910b0`; mtimeNs `1788440114897466100`.
- Read-only snapshots of every database table and the three G-drive root directory metadata are retained only under ignored `.mocks/`. No JSON exports, SQLite files, credentials or complete media inventories are committed.

### Creator master data

`archive_catalog_creators` already contains the curated roster: **593 creators**, all historically seeded by HentaiClub. There are 201 liked, 392 kept, 0 unset preferences; 259 R15, 334 R18, 0 unrated.

| Preference | R15 | R18 | Total |
| --- | ---: | ---: | ---: |
| liked | 93 | 108 | 201 |
| kept | 166 | 226 | 392 |

There are 628 source identities (593 HentaiClub, 35 Costuan), 633 aliases (593 HentaiClub, 40 Costuan), and three historical HentaiClub import runs. Exact canonical-name duplicates, normalized-name duplicates, and normalized aliases shared across creators all currently number **0**. The new model must nevertheless allow same-name distinct IDs and must not merge them.

### Local bridge audit

- `folders`: 33 normal creator folders; `archive_catalog_local_creator_folders`: 33 active rows, all already assigned a unique creator_id.
- The catalog table has **no foreign key to folders.id**. It currently stores root/relative/absolute paths and a normalized-alias match method.
- Resolving the gallery-relative folder path against the full library root, normalizing Windows slash/case/trailing separators, gives **33 exact, 0 missing, 0 ambiguous, 0 conflicting** matches. No creator currently spans multiple local folders; that remains a supported relationship.
- Only full paths/IDs are used for bridge backfill; existing canonical IDs and work links are preserved.
- Active local works: 1836, matched 1836, unmatched 0, ambiguous 0 (1837 total rows including one inactive row).
- LocalIngestJob: 101, all ingested/done, attemptCount=1. Download tasks: 604; metadata tasks: 17. Stage 3 allowlist: 咬一口兔娘. Processing directory is empty.

### Two competing rating authorities

The ledger reads `archive_catalog_creators.effective_rating`, whereas `creatorRatingRepository.listCreators()` currently calculates the gallery value from `creator_rating_sources` (manual first, then any R18/R15). The old gallery PATCH writes a folder-level manual source rather than the canonical creator.

`creator_rating_sources` currently has **0 rows, 0 manual rows, 0 conflicts**. Thus every local folder has a null legacy rating even though its canonical creator is classified. No historical manual choice needs promotion in this production copy. The legacy table will remain; unresolved/conflicting synthetic legacy cases must fail closed rather than lose data.

### HentaiClub callable surface before retirement

- `server/src/scripts/import-hcf-tags.ts`, `import:hcf-tags`: folder-level import with fuzzy name fallback and replace-by-source behavior.
- `creator-rating-import-service.ts`: HCF schemas/import plus a general identity normalization helper used by other services.
- `ArchiveCatalogService.importHentaiclubSeed`, hcfSeedSchema and HcfSeedImportResult: repeatable canonical seed upsert, including canonical name/preference/rating updates.
- `archive-catalog-bootstrap.ts`, `catalog:bootstrap`, `--hcf`: historical three-stage bootstrap that also scans a supplied gallery root.
- README documents both repeatable CLI commands. Current pipeline documentation describes the old seed step.
- Four server test files use synthetic HCF documents through the production seed API; one gallery test exercises the legacy rating importer. These will use database fixtures, not a retained production JSON entry point.
- No HCF upload/admin API, startup JSON synchronization or environment HCF path was found. Existing source identities, aliases and import-run history remain historical evidence only.

## Implementation

The sole canonical authority is now `archive_catalog_creators`. The managed roster is the first section of the existing archive-catalog page; it is not another creator table or a separate source of truth.

- Removed the two HCF/bootstrap CLI scripts, their package commands, the old rating import service and the catalog seed-import method/schema. Test seeds are SQL fixtures. A retirement regression test rejects restoring those callable entry points or normal writes to `creator_rating_sources`.
- Preserved all existing creator/source/alias/import-run rows. Costuan import resolves a persistent source/collection identity first, then requires a unique existing canonical candidate. It never seeds unknown creators or overwrites canonical name, preference or rating. The existing Costuan caption-import command now uses catalog IDs and the explicit gallery bridge rather than local-name guesses.
- Added strict administrator-only create/edit/alias/deactivate/restore/link/unlink APIs with 400/403/404/409 behavior, CSRF intent protection and short DB-only transactions. Nullable preference and rating are independent. Renaming retains the prior name as a read-only historical alias. Source aliases are read-only; manually added aliases can be removed. Same-name candidates require explicit distinct-person confirmation; IDs never merge. There is no hard-delete creator API.
- Added pagination (50), canonical/alias search, lifecycle, preference, classification, local/source filters, counts, read-only source details, impact confirmation and manual local-directory linking to the admin UI. Native dialog focus behavior and keyboard outlines remain. Stage 1–3 controls were not rebuilt.
- Deactivate/restore only writes the canonical row. Future metadata/download planning excludes inactive creators, including incidental reconciliation/removal inside the planners. Existing tasks, works and relationships remain unchanged. Restore does not automatically plan anything.

## Migration 000016 and bridge

SQL adds `is_active`, `deactivated_at`, lifecycle/preference/rating indexes, and nullable `gallery_folder_id REFERENCES folders(id) ON DELETE SET NULL`. A partial unique index permits only one active catalog row per gallery Folder.

The official migrate/startup command runs the deterministic DB-only post-phase:

1. Resolve complete absolute paths (including Windows drive, slash/case and trailing-separator normalization). Never use basenames or fuzzy name guesses for bridge backfill.
2. Record exact, missing, ambiguous and conflicting bridge results.
3. Promote only consistent legacy manual ratings through an unambiguous existing link. Conflicting manual choices stop migration completion; unlinked legacy choices remain preserved for review.
4. Persist a one-time completion marker so later startup cannot reapply legacy values over new manual edits.

HCF source metadata gains missing `initialPreference`, `initialRating`, `retiredAsAuthorityAt` and `authorityStatus=historical-seed` fields from existing database values, without replacing pre-existing fields. Malformed source metadata fails closed. Down removes new schema/marker fields but deliberately retains historical source snapshots; subsequent up does not replace them.

The gallery now joins `folders.id → archive_catalog_local_creator_folders.gallery_folder_id → creator_id → archive_catalog_creators.id`. Linked null ratings are **待分类**, missing links are **未关联**, and inactive creators are **已停用** (excluded from default listing, but their existing folders remain accessible). The compatibility folder rating PATCH writes canonical `effective_rating`; unlinked folders return 409. Legacy sources no longer calculate the current rating.

Full and creator-scoped local reconciliation preserve existing ID relationships. Explicit manual unlink is sticky. A physically changed folder path is reported for review (scoped reconciliation rejects it) rather than silently reassigned. A regression covers canonical rename, repeated reconciliation, unlink/relink, and a changed synthetic physical path.

## Automated validation

Local validation used Node 24.19.0 and the locked dependencies. GitHub Verify uses the repository's unchanged Node 22 workflow.

| Check | Result |
| --- | --- |
| Server full suite | 81 files; **446 passed, 2 existing conditional skips**, 0 failed |
| Client full suite | 53 files; **301 passed**, 0 failed |
| Server TypeScript build | passed |
| Client type check + production build | passed |
| SQL/migration fresh up + repeat | passed |
| Production-copy up + repeat + down/up | passed |
| Diff whitespace check | passed |

Coverage includes HCF retirement, strict CRUD/null inputs, same-name separation, source/history/manual aliases, source identity persistence, authorization and CSRF, exact/ambiguous/conflicting/out-of-root bridge cases, one-to-many folder links, manual legacy conflicts/non-manual exclusion, inactive planner preservation, canonical gallery classifications and admin UI. Existing Stage 1–3, Costuan numbering, creator-scoped ledger isolation and work-gallery regressions remain in the full suites.

## Production-copy migration experiment

Ignored experiment root: `.mocks/roster-preview-data-v2`. The production database was opened read-only and copied with SQLite backup; the original was never migrated. A first disposable copy was retained when the audit helper incorrectly assumed that source rows had a single-column ID; the helper was corrected to use the source table's composite key before completing the experiment on a second copy. This was not a migration failure.

The existing startup-migration entry point was called with an explicit **temporary database path**. The real gallery-root string was used only for pure database path comparison; storage initialization and scans were not called. Results:

- **33 exact links**, 0 missing, 0 ambiguous, 0 conflicts.
- 593 historical HCF snapshots; original metadata fields retained.
- 0 legacy/manual rating rows in the actual copy (synthetic migration tests cover promotion, conflict and unresolved cases).
- Original columns/rows of all business tables unchanged, including canonical IDs/names/classifications/timestamps, 101 LocalIngestJobs, 604 download tasks and 17 metadata tasks. Only new schema/bridge fields, historical snapshot additions and the migration marker changed.
- Repeated migration was a no-op; down returned to 000015; up returned to 000016 with preserved business rows and snapshots. Fresh up/repeat also passed.
- Both databases passed `quick_check`; `foreign_key_check` returned no rows.

## Real browser validation on 4244

The runtime used the migrated database **copy**, temporary gallery/cache roots and a synthetic one-image local folder. It used `createApp()` without index startup loops, scanners, inbox discovery or watchers. A preview-only HTTP guard rejected Stage 1–3 mutations, bridge calls, real-media requests and edits to pre-existing canonical IDs. Copied real thumbnails were represented by a synthetic placeholder; no real image or video was processed.

Verified in Chrome:

1. Initial roster showed all **593** creators, counts and 50-row pagination.
2. Created one synthetic creator, assigned liked/R18, added a manual alias, and changed the canonical name while keeping stable ID #594 and the original synthetic folder path.
3. Linked synthetic gallery Folder #1856. My Gallery displayed the canonical name and R18.
4. Changed preference to kept and later null; changed rating to null and later R15. My Gallery reflected **待分类** and R15 after normal refresh/navigation.
5. Deactivated with an explicit confirmation. Default listing hid the creator; the inactive filter displayed it and its existing folder could still be opened. Restore returned it to the active state.
6. Unlinked with confirmation: My Gallery displayed the local directory name and **未关联**, not 待分类. Relinking restored the canonical name/classification.
7. Alias search found the renamed creator. An existing creator's HCF history and Costuan source/aliases displayed read-only; no source website was opened.
8. Desktop layout was visually inspected. Mobile rendering was inspected at an effective 520-CSS-pixel viewport (browser zoom affected the requested 390-pixel override); the dialog measured 462px wide, with scrollWidth=clientWidth=439 and no horizontal overflow. Inputs stack vertically. Viewport overrides were reset.

After these UI operations, complete row hashes for all original copied creators, local works, works, source works, download tasks, metadata tasks and LocalIngestJobs were unchanged. Only the synthetic creator/aliases/local bridge changed. Final synthetic state is active, preference=null, rating=R15, exact manual link; no legacy rating-source row was written.

## Protected production state

The task-start 4141 state was **stopped**, not the historical running PID described in the request. No 4141 process was started or restarted. The main worktree remains at `51fc81680c59b61744aa13cbacee13729e39fb30`; Script remains at `84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6`.

Before/after production SHA-256:

`44d9746859a4cae22b46eb2f647031a8c365ef90bfc6f90eaabec22d6e2910b0`

The file size/timestamps and **every production table's complete-row hash** were equal. Migration remains **000015**, quick_check=ok, foreign_key_check empty. Stage 3 settings and allowlist remain unchanged. G-drive protected root metadata and the empty processing-directory listing were equal; no G-drive scan, extraction, rename, move, recycle or other write operation was issued.

Ignored audit helpers, SQLite copies, synthetic files and detailed snapshots are not committed. No real JSON, credentials, media or full local file inventory is included in this PR.

## Review / activation boundary

The feature is submitted on `feat/managed-creator-roster-rating-bridge-v1`. GitHub Verify must pass on the PR's final head, and the PR remains Open, Ready and unmerged. The Verify link and final head are recorded in the PR/checks and task handoff.

Production activation, applying 000016 to production, new source platforms, creator merge/split, work-level ratings, real ingestion and deployment architecture are outside this PR. Existing TypeScript/build warnings are not treated as new activation work.
