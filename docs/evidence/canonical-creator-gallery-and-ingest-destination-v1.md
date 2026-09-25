# Canonical creator gallery and ingest destination V1

## Scope and baseline

This change separates canonical creator identity from physical gallery folders without moving or renaming media. The implementation was developed in an independent worktree from main `d5d746ea6aa46974e1202f813f56bce4e6101a68`.

The production baseline was captured before implementation. SQLite was at migration `000016`, `quick_check` returned `ok`, and `foreign_key_check` returned no rows. All 588 LocalIngestJobs were `ingested/done`; 2,323 active local works were linked with no unmatched or ambiguous rows. Creator 166 (`lunana`) had two valid physical-folder bridges:

- bridge 8 / Folder 1 / `<GALLERY_ROOT>\lunananya`: 9 visible works;
- bridge 1004 / Folder 2290 / `<GALLERY_ROOT>\lunana`: 41 visible works.

The two folders already belonged to the same canonical creator. Neither folder nor any contained work was changed by development or isolated validation.

## Implementation

### Canonical gallery

- My Gallery now forms canonical creator identities before filtering, sorting and pagination. Linked folders use keys such as `creator:166`; unlinked physical folders remain separate with keys such as `folder:2290`. Null creator IDs and same-name distinct creators are never merged.
- Search covers canonical names, registered aliases and linked physical-folder names. Content rating, lifecycle and preference remain properties of `archive_catalog_creators`.
- Visible work counts, totals and pages come from the same distinct active Post set. Soft-deleted, trashed and empty entries follow the existing visibility rules. The deterministic cover policy reuses folder cover/avatar and latest-photo fallbacks without treating the preferred ingest directory as the only cover source.
- Canonical routes use creator IDs. Their work endpoint verifies that the requested Post belongs to an active, matched folder bridge for that creator. Existing Folder, Post, image and share routes retain their original Folder-scoped contracts.
- The canonical creator view pages one unified, stably ordered Post set across every linked physical folder. The work gallery and media viewer preserve the canonical return context, exact image positioning, browser history and internal-only return paths.

### Explicit ingest destination

- Migration `000017` adds nullable `archive_catalog_creators.preferred_local_creator_folder_id`, referencing `archive_catalog_local_creator_folders.id`. Existing creators default to no explicit preference; migration code contains no creator IDs, names or machine paths.
- The managed creator UI exposes valid linked direct gallery directories, their readable paths and work counts. Administrator-only GET/PUT endpoints use strict input, CSRF intent and the existing Stage 3 operation coordinator. Saving or clearing a preference does not scan, create a Job or touch media.
- One destination service now owns new-target resolution and persisted-target validation. New tasks use, in order: a valid explicit preference; one valid linked directory; a safe, conflict-checked first-directory plan for a true zero-directory creator. Multiple linked directories without a preference, stale links, offline paths, reparse points, path escapes and unconfirmed same-name collisions fail closed.
- A new Job fixes its target plan at discovery. Canonical renames, later preference changes and temporary directory outages cannot retarget it. Validation, commit, recovery, reconciliation, creator-scoped scanning, manual-placement takeover and cleanup all use the saved target and its actual parent directory.
- A true first directory is created only by the existing atomic commit path. The ensuing creator-scoped scan uses the explicit creator ID to establish the gallery Folder and catalog bridge. Discovery never creates an empty gallery directory.

## Isolated validation

All database and runtime experiments used a SQLite online-backup copy, temporary derivative roots and a temporary HTTP port. Startup compensation was explicitly disabled. No production scanner, LocalIngest run, source archive, G-drive mutation or recycle operation was invoked.

On a migrated production copy:

- first up reached `000017`; repeat was a no-op; down/up returned `000016` then `000017` cleanly;
- every pre-existing business row stayed unchanged before the explicit preference save;
- creator 166 initially reported both valid candidates and `selection-required`;
- saving bridge 1004 changed only creator 166's preference field and `updated_at`;
- a read-only new-work plan resolved to `<GALLERY_ROOT>\lunana`;
- all 588 historic Job targets passed persisted-target validation without rewrite;
- My Gallery produced one `creator:166` card with 50 works;
- searches for `lunana` and `lunananya` each returned that same card;
- the canonical work set exactly equalled the union of Folder 1 and Folder 2290 Posts (9 + 41 = 50);
- an owned Post was returned and a foreign creator/Post pairing was rejected;
- both legacy Folder endpoints remained available.

Two clean temporary starts on the migrated copy returned health 200 while preserving migration 000017, preference 1004, 588 Jobs, 657 ScanRuns and 2,323 linked local works. Startup logs explicitly reported that gallery and LocalIngest startup scans were skipped.

Automated coverage includes canonical aggregation, unlinked namespaces, same-name distinct creators, aliases, visibility and ratings, deterministic cover choice, distinct counts, unified pagination and ownership rejection; canonical viewer navigation and legacy routes; migration fresh/upgrade/repeat/down-up; valid and invalid preference changes; zero-, single- and multi-directory destination resolution; planned-target collisions; offline/stale/reparse/path-escape cases; immutable Job targets; first-directory commit and bridge reconciliation; recovery, manual placement and creator-scoped isolation.

## Production activation boundary

Production activation is permitted only after the final PR Head Verify and the matching main push Verify pass. Activation must use an online-consistent SQLite backup, migrate to `000017`, save exactly creator 166 → bridge 1004, set `LOCAL_INGEST_STARTUP_SCAN=false`, keep gallery startup scanning disabled through the existing project setting, and finish with port 4141 healthy. The final production outcome and before/after invariants are appended after activation.
