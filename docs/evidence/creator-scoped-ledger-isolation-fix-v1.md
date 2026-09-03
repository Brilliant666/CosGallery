# Creator-scoped ledger isolation fix V1

## Scope and call-chain change

Before:

```text
LocalIngest
  -> ScannerService.scanCosCreators([creator])
  -> ArchiveCatalogPipelineService.refreshAfterGalleryScan()
       -> reconcileLocalRoot(all creators)
       -> planMissing(all creators)
       -> planLocalOnly(all creators)
```

After:

```text
LocalIngest
  -> ScannerService.scanCosCreators([creatorFolderName])
  -> ArchiveCatalogPipelineService.refreshAfterCreatorGalleryScan({
       galleryRoot, creatorId, creatorFolderName
     })
       -> reconcileLocalCreators([{ creatorId, folderName }])
       -> planMissing({ creatorIds: [creatorId] })
       -> no metadata planning
```

The full `refreshAfterGalleryScan` entry point remains explicit and unchanged for deliberate full-library operations. The scoped entry point cannot fall back to it.

## Implementation

### Fail-closed creator scope

- `creatorId` must be a positive existing database ID.
- `creatorFolderName` must identify exactly one real, non-symlink direct child of the gallery root.
- The normalized folder identity must resolve uniquely to the same creator ID.
- Empty creator arrays, duplicate IDs/folders, nested paths, missing creators, and ID/folder mismatches throw before reconciliation.
- `planMissing({ creatorIds: [] })` throws. Omitting the property is the only way to request the existing explicit global behavior.

### Scoped local reconciliation

- Only the requested direct creator folder is read.
- Only that local creator-folder row and its local works can be inserted, reactivated, updated, or made inactive.
- No root-wide `is_active = 0` step occurs in the scoped path.
- Full reconciliation now deactivates only folders/works actually absent from the filesystem, rather than invalidating everything before every scan.
- Upserts use change predicates, so an unchanged second scan does not rewrite `scanned_at` or `updated_at`.

### Persistent relationship semantics

Before automatic matching, the reconciler loads the existing local row for the same creator-folder/work relative path. It preserves `work_id`, `match_status`, and `match_method` when:

- the row is currently matched;
- its work still belongs to the same creator;
- at least one source work and its collection remain active;
- the preserved work ID is not already claimed by another local row.

If a folder has no explicit number but a previously validated relationship supplied `parsed_source_order`, an ordinary scan also avoids erasing that useful persisted order merely because the raw folder name cannot reproduce it. New, null, invalid, cross-creator, or duplicate relationships still pass through automatic matching.

### Scoped download-task writes

`ArchiveDownloadTaskService.planMissing` now carries the same creator filter through one atomic transaction for:

- already-local task reconciliation;
- invalid/out-of-scope task removal;
- candidate selection;
- new task creation.

The synthetic isolation test intentionally places a locally satisfied pending task and a removable cancelled task under non-target creators. Both remain byte-for-byte unchanged while the target creator independently exercises reconcile, remove, and create.

### Metadata decision

The creator-scoped LocalIngest path does not run `ArchiveMetadataTaskService.planLocalOnly`. Full catalog refresh retains its existing global metadata planning behavior.

## Automated verification

New tests:

- `server/test/creator-scoped-ledger-isolation.test.ts`
  - three-creator row isolation across local folders, local works, works, source works, download tasks, and metadata tasks;
  - existing-link preservation plus one newly ingested work;
  - ambiguity isolation;
  - scoped task reconcile/remove/create;
  - empty/invalid/mismatched/non-direct scope failures;
  - repeated scoped operation strict no-op;
  - repeated explicit full reconciliation relationship idempotency.
- `server/test/local-ingest-scoped-reconciliation.test.ts`
  - proves the real default LocalIngest boundary calls `scanCosCreators` and `refreshAfterCreatorGalleryScan` with creator ID/folder;
  - proves `refreshAfterGalleryScan` is not called.
- `server/test/local-ingest-service.test.ts`
  - the real two-layer ingest fixture now asserts that the post-commit callback receives the mapped creator ID and exact direct folder name.

Targeted result: 5 files passed, 47 tests passed, 2 platform-gated tests skipped.

Full pre-PR verification under the bundled Node 24 runtime:

- server: 72 files passed; 403 tests passed; 2 platform-gated tests skipped;
- client: 42 files passed; 187 tests passed;
- migration bootstrap/up/down/repeat coverage: 1 file and 17 tests passed, including the `000014` down/up preservation case and a second-run idempotency case;
- server TypeScript build: passed;
- client type-check and production build: passed (only the existing Vite environment/chunk-size warnings were emitted);
- `git diff --check`: passed.

The repository-root workspace launcher remains affected by the explicitly excluded Node 24/Chinese-path wrapper issue, so verification invoked the unchanged server and client workspace scripts directly. No wrapper or migration code was altered for this task.

## Production-copy verification

All writes below used the Git-ignored copy:

`data/db/verification/gallery-scoped-ledger-verification-20260903-014138.sqlite`

The production database was never passed to a reconciliation service.

### Two consecutive creator-scoped runs

Target: creator id 39 / `五更百鬼`; filesystem input read-only: `G:\cos图集\五更百鬼`.

Both runs returned:

- creator folders: 1 matched;
- local works: 35 matched, 0 unmatched, 0 ambiguous;
- missing-plan result: created 0, existing 21, removed 0, reconciled 0;
- target missing works: 21;
- total local state: 1,744 active / 1,744 linked / 0 unmatched / 0 ambiguous;
- download tasks: 604 total (25 ingested, 579 staged);
- LocalIngest jobs: 9.

The complete business-row hash (local folders, local works, works, source works, download tasks, metadata tasks, LocalIngest jobs, and app settings) remained:

`e8bce2bf90c605f7631f19280e902f210333c1644424786157a48f62407af3f4`

before the first run, after the first run, and after the second run. Thus the first real-data scoped check and repeated check were both strict no-ops.

Non-target (other 32 local creators) hashes were also identical before/after both runs:

| Data set | SHA-256 |
|---|---|
| local creator folders | `4358dce1b1882c3ac54b3def703a7cb1482cf14ae33e224fd6a33a1086a99518` |
| local works | `53ddfd38d8671c37c2ab6c6536e3441710a4605bac63a1de71c3be09f6d52f1b` |
| works | `5776d18fc6b0589feecb102e7c3ecaa00482f7a1c61d51bff2ce55106b2d5680` |
| source works | `cbc586dd87c9773b1435934d68e4b1206d8e2ba1c664e5b50b284bc996b4a4cf` |
| download tasks | `f496c5d2c1d634accb1514ff400de8230b29d13f919c46be33e7db9b5d2973f7` |
| metadata tasks | `dd3d7f74da12d2506062339ad545093dd6e9908d9caa2ed69a90719b82035917` |

`PRAGMA quick_check` remained `ok`; `PRAGMA foreign_key_check` returned no rows.

### Explicit full reconciliation on the copy

A deliberate full ledger reconciliation read all 33 creator directories from `G:\cos图集` against the same database copy. Before and after:

- active local works: 1,744;
- linked: 1,744;
- unmatched: 0;
- ambiguous: 0;
- relationship-row SHA-256: `1b087e0305d0bc92dc0cefa1d1cca8ff0efd72bf788c77373c595395582ba16f`.

No relationship row changed. In particular, the prior 53 title conflicts did not reappear and no unrelated download planning was run.

## Incident conclusion

The cancellation of a conversational instruction did not create the corruption. The defect was deterministic in the existing code: a correctly scoped physical scan always called a global catalog/download/metadata pipeline, while global reconciliation discarded valid persisted relationships and re-guessed them. The fix aligns every post-ingest ledger write with the physical scan scope and makes valid relationships persistent under ordinary full scans as well.

## Real-data safety

- Production `gallery.sqlite`: read-only integrity/baseline queries plus creation of the pre-fix backup only.
- `G:\cos图集`: read-only directory enumeration and file stats; no writes, moves, derivatives, or timestamp-setting calls.
- `G:\cos待入库`: no scan, extraction, move, or cleanup.
- `033.7z` through `053.7z`: never opened or processed.
- Recycle Bin: not invoked.
- Production LocalIngest: not invoked.
- Stage 3 settings, allowlist, password, 9 job rows and attempt counts: not changed.

The final read-only production check reproduced every pre-change table hash exactly:

| Production table | Rows | SHA-256 |
|---|---:|---|
| `archive_catalog_local_creator_folders` | 33 | `da2cebef0ebbe9a245dff250f48300f5d1c207a335a4f997da7fd51a4ba7034e` |
| `archive_catalog_local_works` | 1,745 (1,744 active) | `4fcdcb267cb3516ef9e396d9e148ed0069db7921f0cd686bdd22863f9b15b782` |
| `archive_catalog_works` | 2,342 | `82a8fcd70f46aa61abb52a1a9a16e0f5b9bbecb7a602d64d9c816b25a0b1f30e` |
| `archive_catalog_source_works` | 2,342 | `60cfa9e2b12d43f8e31be7e96bb21680cbeade77d478255b8463c8f1592924bb` |
| `archive_catalog_download_tasks` | 604 | `5a6e08050df9eaf4105f30542a330f4f7980360e82a3ed3efd68fb018388c601` |
| `archive_catalog_metadata_tasks` | 17 | `b40e6cdfa0d3c70b72c5c0850035518e25793464508f487688ac956fa491a9d8` |
| `local_ingest_jobs` | 9 | `0addad6eed1c8ae3026304903178e4aadfa4bc2ff99594cdff139efaba4b2f66` |
| `app_settings` | 11 | `c2e9164f2cd7031ecf1f126ddb6d6edc07d5669485b1b166b0ad8eed4dc1355b` |

The final G-drive metadata census also matched the baseline: `G:\cos图集\五更百鬼` still has 35 direct work directories, 790 files and 8,267,590,983 bytes; `G:\cos待入库\五更百鬼` still has exactly 21 files named `033.7z` through `053.7z` and 3,413,803,069 bytes. No production service was started.
