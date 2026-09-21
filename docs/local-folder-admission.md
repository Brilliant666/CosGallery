# Local folder admission and explicit mapping (V1)

The web continuation is documented in [Local admission and review in the web UI](local-admission-web.md).
It delegates to the same immutable plans and checkpoints; the CLI below remains supported.

This is an application CLI, not the research prototype. It accepts already-extracted,
explicitly selected work directories. No queues, downloads, archive jobs or source
collection are created by admission. Production execution is a separate authorization.

## Run

Use Node 24 and the application's normal environment. Set **all five absolute paths**
explicitly: `DATA_ROOT`, `DB_DIR`, `GALLERY_ROOT`, `THUMBNAILS_DIR`, `PREVIEWS_DIR`.
The CLI prints their resolved values to stderr before use. For isolated validation,
use `NODE_ENV=test` (disables `.env`), `COS_GALLERY_MODE=1`; create an isolated database
using the normal migration command. Never point an experiment at the production DB.

From the repository root (substitute your Node 24 executable):

```powershell
node --import ./server/node_modules/tsx/dist/loader.mjs ./server/src/scripts/local-folder-admission.ts preview C:\isolated\scope.json
node --import ./server/node_modules/tsx/dist/loader.mjs ./server/src/scripts/local-folder-admission.ts apply C:\isolated\confirmed.json
node --import ./server/node_modules/tsx/dist/loader.mjs ./server/src/scripts/local-folder-admission.ts resume C:\isolated\confirmed.json
node --import ./server/node_modules/tsx/dist/loader.mjs ./server/src/scripts/local-folder-admission.ts decide C:\isolated\decision.json
```

`pnpm --filter @foldergram/server local-folder-admission ...` is equivalent **only if**
that shell and child scripts already use Node 24. No global PATH change is required.
Default/no command prints help. JSON result is stdout; diagnostics are stderr.
Preview opens an **existing database read-only**, does not migrate, scan, hash media,
write Work records or plan acquisition. Save stdout to a local ignored file.

Scope example (synthetic only):

```json
{"creatorId":1,"inputRoot":"C:\\isolated\\inbox","directories":["Synthetic NO.032 Blue Theme 2 (Night) [31P-80MB]"]}
```

Empty scopes, links, non-direct-child directories and overlapping input/gallery roots
are refused. Preview returns original paths, display titles, per-file metadata, counts,
candidate source IDs and target conflicts. Candidates are **not identity decisions**.
No source coverage is inferred from the number of local folders.

### Confirm the plan

Retain `planId`, original names, manifests and target paths. Set `confirmed:true`,
write each item's nonempty `reason`, review `displayTitle` and choose `identity`:

```json
{"kind":"new"}
{"kind":"existing","sourceWorkId":123}
{"kind":"existing","workId":45}
{"kind":"same-as","itemKey":"earlier-item-key"}
```

These are four separate examples, not one JSON document. Source-first admission uses
the source's existing Work. `same-as` references an earlier confirmed item in this plan
and uses that item's confirmed display title (the original directory still stays intact).
`localOnly:true` prevents automatic source guessing. `excludeSourceIds:[...]` records
explicit negative candidates. New independent Work titles may be identical. Existing
Work titles are retained rather than overwritten by another copy's display suggestion.
For an existing Work, set the confirmed `displayTitle` to its `canonicalTitle` from
the candidate; a mismatch is explicitly rejected rather than silently ignored.

New previews explicitly use `localOnly:false`: no current source does not mean that
future source reuse is forbidden. The local identity is still `manual`, so directory
number scans cannot replace the confirmed Work. Explicit historical `localOnly:true`
continues to prohibit automatic reuse; older plans omitting it retain the prior true default.
`acceptExistingVersion` defaults to false. Setting it to true in a confirmed plan records
the user's acceptance of this local version for future safe unique-title source reuse
in `provenance_json`; it does not assert byte equality or itself satisfy any task.
Explicit local-only and negative decisions still take precedence. `acceptVersions`
continues to describe exact known-source acceptance independently.

`primary:true` explicitly selects this indexed copy. A first sole copy is naturally
primary; adding a second does not switch it. Same-work identity never means identical
bytes and never authorizes physical duplicate deletion.

`acceptVersions:[{"sourceWorkId":123,"taskIds":[456],"reason":"Accept the available local version"}]`
accepts only that source and its exact current task set after indexing. An empty task
set is valid only if that source actually has no tasks. Changes/active claims stop
acceptance without undoing successful file admission. Resume retries this checkpoint.

`approvedAds:["relative/ad.url"]` is optional and accepts only listed TXT/URL files
present in the confirmed manifest. These files are **moved, not deleted**, to
`inputRoot/.local-admission-attachments/planId/itemKey/relative/ad.url`.
All other attachments and directory structure remain. URLs are never opened.
The result reports exact retained attachment locations. No cleanup of real samples is
performed by development/testing, nor is general advertisement detection introduced.

### Later decisions

Each file requires `confirmed:true`. Examples:

```json
{"confirmed":true,"kind":"accept-version","decisionKey":"accept-001","sourceWorkId":123,"localWorkId":9,"taskIds":[456],"reason":"User accepts this measured version"}
{"confirmed":true,"kind":"exclude-source","key":"negative-001","localWorkId":9,"sourceWorkId":124,"reason":"Different actual content"}
{"confirmed":true,"kind":"primary","localWorkId":9,"reason":"Selected existing usable copy"}
{"confirmed":true,"kind":"revoke","decisionId":10,"reason":"User corrected the prior decision"}
{"confirmed":true,"kind":"bind-source","key":"binding-001","workId":45,"collectionId":7,"sourceWorkId":"NO.030","reason":"Explicit external entry mapping before import"}
```

Local-first source binding uses a known collection and source-scoped identifier **before
the new entry is imported**. Actual source import then reuses the local Work. An existing
source already linked to a different Work is a conflict; V1 does not silently merge two
existing identities. The collection must exist; admission does not fabricate a platform.
Source-first admission instead chooses `identity.existing.sourceWorkId` from the outset.

Revocation records its reason and invalidates dependent fulfillment without changing
files or execution history. Revoking a same-work decision leaves stable asset/Work IDs
and changes the copy to local-only; it does not perform a general Work split. Primary
revocation requires an explicit replacement choice, never silent fallback. Conflicting
corrections involving two existing Works remain manual review. Review holds do not
automatically restart acquisition; a new explicit version acceptance is supported, a
generic release-and-redownload command is not included in V1.

## Actual application changes

- `archive_catalog_works`: `title_policy`, `primary_local_work_id`.
- `archive_catalog_local_works`: `identity_policy`, `post_id`, `provenance_json`.
- `archive_catalog_work_decisions`: durable reasons, keys, payloads and revocation.
- `archive_catalog_source_bindings`: exact collection/entry prebinding for later import.
- `archive_local_admission_plans/items`: immutable confirmed payload and resumable steps.
- `archive_catalog_local_fulfillments`: exact source/local snapshots and task evidence,
  separate from execution history. Migration `000019` is additive; old records retain
  automatic behavior and existing IDs. Destructive downgrade is intentionally refused.

```text
SourceWork ──confirmed──> Work <──explicit identity── LocalWork ──> Post ──> post_items/Image
                            │                           │
                            └──primary_local_work_id────┘
SourceWork + accepted LocalWork + decision + exact tasks ──> fulfillment overlay
```

`WorkIdentityService` performs identity decisions. `ArchiveCatalogService` prioritizes
manual/local-only links before number matching and preserves manual titles on source
refresh; ordinary auto matching still has ownership/exclusivity checks. Source titles,
orders and declarations remain source data, never global Work keys.

`LocalFolderAdmissionService` uses existing destination/path validation, same-volume
rename, real `scanCosCreators` with **one explicit work scope**, folder bridge and
catalog reconciliation. It does not use the compressed-archive job engine or invent
LocalIngestJobs. Work identity is persisted **before** scanning so auto-number rules
cannot pollute it between move and registration.

`repositories`/`GalleryService` use one primary-copy predicate for default cards,
counts, covers and media summaries. Explicit Work display title is shown; original
Post/Image IDs, source paths, item order, asset keys and secondary deep links remain.
Indexed inactive/unavailable primary copies are reported, not replaced automatically.
As with existing indexed media, external disk deletion is discovered by a later scan.

`ArchiveLocalFulfillmentService` feeds catalog missing counts, download planning,
claim/resume checks, Stage1 required-file scope and creator-sync task/creator summaries.
Stage2 shows acquisition explanation separately from the original execution status.
Historical staged worker ownership is retained; active claims/downloads/ingest execution
block acceptance. Source or local snapshot changes invalidate coverage and require
review. Local evidence includes ordered media fingerprints/mtime and Post state, not
merely file counts; ordinary scan/cache timestamps do not invalidate acceptance.
Revoking an exact source binding invalidates only its derived fulfillment, including
bindings confirmed before that source row existed. Raw staged timestamps, attempts and download IDs are not rewritten. Late staged
receipts remain normal execution history; they cannot authorize renewed acquisition.

## Recovery and integrity

Plans bind ID to their normalized confirmed content; changing decisions requires a new
confirmation. State order is `planned → move_intent → files_verified → indexed → completed`.
Plan+items are saved transactionally. File rename is **not** part of a SQLite transaction.
If rename succeeds before its checkpoint, resume verifies the existing target against
the recorded manifest. An index commit before its checkpoint safely reuses original IDs.
Both paths present, neither present, changed contents/metadata or occupied targets stop.

### Explicit recovery after authorized file removal

`recover <absolute-confirmed-removals.json>` records an **already performed, explicitly
authorized removal**. It does not recycle files, start indexing, resume a plan or change
any acquisition status. Use the original immutable plan with `resume` afterwards.

```json
{
  "confirmed": true,
  "planId": "original-plan-id",
  "key": "unique-recovery-request",
  "reason": "User approved recycling the broken image and original approved ads",
  "evidence": "Local removal log location and user confirmation reference",
  "removals": [
    {
      "itemKey": "original-item-key",
      "entry": {
        "relativePath": "broken.jpg", "kind": "image", "size": 0,
        "dev": "original-value", "ino": "original-value", "mtimeNs": "original-value"
      }
    }
  ]
}
```

Copy `entry` exactly from the saved manifest; never invent file metadata. Evidence is
a user/operator statement, not proof that the OS recycle bin still contains the file.
The service verifies the absence and all remaining metadata, not the truth of an external
log. Review the real removal records before confirming. Include every authorized missing
file for each affected item in one request; unrelated missing, replaced or new files stop
registration without partially writing decisions.

No migration is required. Additive `admission_file_removal` rows in the existing
`archive_catalog_work_decisions` table retain plan/item identity, original entry,
original content hash, reason and evidence. Original plan payload/hash, item manifest,
checkpoints, source declarations and download history are not rewritten. `recover`
uses the same exclusive admission lock and refuses related active acquisition.

Storage compatibility: migration 000019 already permits arbitrary decision kinds;
this patch adds no column, index or migration. Recovery payloads keep the existing
`planId`, `itemKey`, `contentHash`, exact `entry`, `reason` and `evidence` fields.
An absent `retainOriginal` means the original removal-only format; only explicit
`true` authorizes preservation on resume. Existing rows are read as-is, not
backfilled or rewritten. Active decisions must still match the immutable saved
plan; revoked decisions are excluded. Plans without recovery decisions retain
normal manifest validation. Old binaries do not understand these exceptions and
must not be used to resume a recovered plan: schema compatibility is not semantic
recovery support. No downgrade or automatic conversion is provided.

Publication review additionally rechecks idle state and related active claims
inside the decision-save transaction after asynchronous filesystem verification.
A claim acquired during that verification refuses the entire recovery registration;
the claim and original plan remain untouched. The recovery test exercises this
window explicitly. The four focused admission/identity/gallery/fulfillment suites
pass 33 tests on Node 24; this is synthetic isolation evidence, not a new real
admission run or production rollout.

Allowed scope is deliberately narrow:

- Originally approved TXT/URL advertisements after a verified move (including completed
  items whose saved advertisements were subsequently recycled).
- Explicit image/video removal only at `files_verified`, before LocalWork/Post attachment
  and without active fulfillment. Provisional scanner data may exist after a failed scan;
  the normal scoped scanner still has to finish. Already attached/indexed media is refused.
- No directory exclusions, arbitrary other attachments, source-side/planned removals,
wildcard rules, automatic missing-file acceptance or physical cleanup.

For a failed scan that already created a provisional Post, resume uses the existing
Post repository to detach only the explicitly removed media memberships before scoped
indexing. Post IDs and surviving Image IDs remain; the scanner must finish marking the
absent media inactive and refreshing card counts/cover. This is not applied to unrelated
Post ownership conflicts. If scanning fails again, the removal decision and checkpoint
remain for retry; membership updates and scanning are not one atomic transaction.

Removing an empty media subdirectory is a separate change and is **not** authorized by
its file's exclusion; preserve original internal directories. A removed file appearing
again (even as a replacement) also stops replay. At least one supported medium must remain.
Do not clear saved advertisements from an unfinished batch without retaining explicit
removal evidence for recovery.

The exact request is idempotent even after successful resume. A second request key for
the same active file exclusion is refused. `decide` with `kind:"revoke"` revokes a removal
decision; subsequent resume again requires the original file. Revocation does not restore
files, undo prior scans or recreate thumbnails. A correction needs an explicit new decision,
not silent resurrection of the revoked key. CLI results list `approvedRemovals` separately
and mark removed advertisements as `removed_by_explicit_decision`, never as still preserved.

The manifest records every selected entry's relative path/type/size/device/inode/mtime.
Same-volume rename preserves these; no claim of cross-source byte identity is made.
Cross-volume admission is explicitly unsupported. Verification covers the selected
directories, not an entire disk. Replays check target and saved attachments again;
within each move evidence is reused rather than repeatedly reading media bytes.

An app-settings PID/token lock serializes admission with actual scanner/ingest operations
across processes. Only a definitely dead PID is recoverable; a live/unknown owner is not
expired based on age. No external file editor can be locked by SQLite: source directories
must remain quiescent during the operation, and observed changes stop the plan.

## Validation and remaining scope

### Explicit retained-original recovery

An individual `recover` request entry may specify `retainOriginal:true` for a failed
image/video in an unfinished `files_verified` item. This is not automatic exclusion
of every decoder error. The exact original manifest entry, reason and evidence are
required. `recover` persists the decision without moving files; the original plan's
`resume` moves the file to `_未支持格式原件/<original relative path>` on the same
volume. The scanner already excludes this reserved direct child from display.
The original manifest and IDs remain immutable. CLI `retainedOriginals` reports the
preserved path separately from actual `approvedRemovals`: retained does not mean lost.

The decision commits before rename. Interrupted replay accepts either original or
retained location, never both, verifies exact file metadata and unrelated entries,
and refuses an occupied destination, changed file, active acquisition, or exclusion
of the last displayable medium. Reserved-directory conflicts in the original plan
are rejected. Revoking a decision does not move the file back; physical correction
requires explicit handling and normal validation, not an implicit rollback.
This uses existing decision storage; no migration or decoder pixel-limit change.

Tests live in `server/test/local-folder-admission.test.ts`, `work-identity.test.ts`,
`local-admission-gallery.test.ts`, `archive-local-fulfillment.test.ts` and matching client
tests. They exercise real migrations, actual services, synthetic media indexing/API,
restart/replay, fulfillment filtering and compatibility, not research SQL projections.
Final PR records exact test/build/browser results.

Local acceptance run: server **854 passed / 2 skipped**, client **429 passed**;
server TypeScript build and client build/typecheck passed with Node 24. Final hardening
tests passed 40/40 (admission 7, identity 5, fulfillment 8, creator-sync 20), covering
post-index checkpoint loss, exact source-binding revocation and changed media evidence. In-app
browser checked the isolated HTTP application backed by CLI-admitted synthetic files:
three local directories, two independent same-title Work cards, four default images,
primary details, ordered media viewer and the secondary copy's existing deep link.
No production server bootstrap, watcher or business queue was used in that preview.

Not included: new real source sites, global deduplication, AI/perceptual fingerprints,
complex package splitting/coverage, physical duplicate deletion, generic existing-Work
merge/split, complete version-management UI or rebuilding historic media IDs.
The real pilot still needs exact move scope, per-source mapping and primary-copy choices.
53 directories / 52 candidate groups is not 52 confirmed source entries.
