# Local admission and review in the web UI

This is the web continuation of Draft PR38. The CLI remains a maintenance entry;
ordinary users do not need commands, scope JSON, internal IDs, or an agent.
This is local-server file handling, not browser media upload or a cloud sync service.

## User flow

1. Open **本地入库** from the main navigation for one or several creators. Existing
   creator-specific **本地导入** and confirmed source observation links remain valid;
   a source is not required.
2. Finish manual copying/extraction first. Browse the configured extracted waiting
   root, choose the creator parent, then select its direct work directories.
   Browsing lists one layer only. Preview inventories just the selected scope.
   There is no additional copy-complete checkbox before preview: a short notice
   explains the requirement, and the final execution confirmation still asks that
   the files are no longer being written. Server manifest/target/claim checks remain.
3. Review new independent works, possible existing works, known local copies and
   unresolved conflicts. Suggestions are not confirmations. Search this creator's
   Works by title, catalogue NO or original directory, using names/covers/counts.
   Stable IDs are carried by the application, never inferred from NO.
4. Choose new / existing / same-as-this-batch, main or secondary copy, skip or defer.
   Existing canonical titles remain. Same-title independent Works are supported.
   No general merging of two existing Works is offered.
5. Confirm the source/destination scope. New web confirmations use the stated rule
   **已入库的同一作品不重复获取**, without an extra policy checkbox: they explicitly
   send `acceptExistingVersion:true`, retaining `localOnly:false`. This is an
   acquisition preference, not a claim that the copy is complete, source-identical,
   or decodable. Future supported source imports can reuse it only through existing
   reliable matching and local-validity checks. Existing sources still require
   individual selection; no blanket source fulfillment is introduced. An unsubmitted
   draft may use the rule at its next new confirmation, never as a retroactive
   approval. Pending receipts retry their exact original policy (including false or
   mixed creator policies); confirmed plans, CLI defaults, exclusions and revocations
   are unchanged. Ads require an
   **additional explicit confirmation of the exact relative-file list**; unchecked attachments
   stay. Batch provenance alone never satisfies downloads. Exact version acceptance
   requires selecting the existing Work and specific sources, using original claim
   checks and the fulfillment service, without rewriting staged history.
6. Follow real stages and results. Recent batches and URL restoration survive
   refresh/new tabs. A lost response is retried with the same receipt. Closing the
   page does not cancel a submitted operation. In the same browser tab, the general
   local-admission entry restores the last opened collection after visiting an album;
   **新建批次** explicitly starts a fresh scope. The remembered ID never starts or
   resumes work: status is fetched with normal authorization. Unavailable batches
   report an error rather than displaying cached success. New tabs can use the exact
   collection URL or recent history; no cross-browser navigation promise is made.
7. An unfinished item opens **查看并处理** or continues the original plan. Eligible
   Stage3 reviews open the shared panel from the existing Stage3 list and remain
   Stage3 jobs; they never become folder-admission plans.

The extracted waiting root defaults to the gallery's sibling `cos等待入库` and can
be set by a manager. It must exist on the same volume and be independent from the
gallery, archive inbox and processing root. Linked ancestors, junctions, traversal
and arbitrary absolute directory selection are rejected server-side. There is no
shell-command or arbitrary-file-management endpoint.

### Batch advertisement selection

The confirmation page groups advertisement candidates by their complete basename,
showing the selected-directory count, file count and selected count. Select/clear a
specific filename or all candidates across **all pages and groups**. Only directories
chosen as new/existing/same-as are affected; skip/defer, identity, main-copy and source
choices remain unchanged. Newly selecting a directory for admission preselects **all
listed advertisement candidates**, including TXT/URL and recognized image ads. The
user may clear individual paths, names or the whole selection. This is a web-form
default, not a new filename rule or permission to remove files outside the saved
candidate list. The exact list still requires final explicit confirmation.
Switching among admission identity choices, refreshing, restoring saved draft
choices or carrying unchanged choices into repreview preserves manual deselections,
including an empty list. Existing confirmed plans and pending receipts are unchanged.

The user has confirmed the ecytt02 advertisements `492.jpg` and `009-01.jpg` as global
exact-filename rules. Any creator's new local admission can recognize these basenames
(case-insensitive, including nested paths). No wildcard, similar number or other JPG
is included. These image ads use the same preselected, cancellable web default as the
other listed candidates. They remain explicitly listed in `approvedAds` and in the
last confirmation dialog. Image ads moved out do not become gallery media. The preview
image count is the original inventory, not a promise that excluded ads remain indexed.

An old **unsubmitted** draft can show these additional candidates from its saved
manifest without another disk inventory or changing its plan. Existing confirmed
payloads, past batches and outstanding retry receipts never gain new approvals.
Choosing defaults is not execution. New web confirmations explicitly include
`advertisementDisposition:'recycle_bin'`: after indexing, the approved files go to
the Windows Recycle Bin and only their known empty staging directories are removed.
The temporary attachment area is not a permanent ad archive. A native recycle failure
keeps the item at its indexed checkpoint and reports partial completion; resume uses
the same plan and exact durable file intents. This is recoverable recycling, not
permanent deletion. Files not explicitly approved remain untouched.

Old confirmed plans and pending receipts without this optional field retain their
original attachment handling. They are not silently upgraded by a new UI. Historical
attachments need the separate exact `preview-recycle-advertisements` /
`recycle-advertisements` request described in the CLI document. A failed historical
cleanup retries that original cleanup request, not ordinary admission resume. No
previously indexed gallery or old source copy is swept or rewritten.

The same exact-name helper is used by new ordinary Stage3 staging. Advertisement
files remain in its original processing content, outside `ready`, and follow the
existing recoverable processing cleanup (or remain when cleanup is disabled).
Existing ready content, immutable staging manifests and explicit review plans keep
their recorded classification. A new optional `imageAdvertisementPolicy: 1` in the
job summary fixes the rule for an in-progress new staging attempt, including copy
fallback/replay; absent historical markers do not authorize retroactive cleanup.
No schema migration or source/plugin rule is added for this filename policy.

## Review, persistence and failure behavior

### Independent multi-creator workspace

The local-admission workspace is a library-level entry, not a requirement to open
each creator's management page. Existing creator-specific and source-evidence links
remain valid. The normal path is three stages: choose creator directories and work
scope, review one combined confirmation, then read durable background results.

The root browser only enumerates the configured waiting directory's immediate
children. Canonical names and registered aliases suggest existing active creator
identities; an ambiguous/unmatched directory needs an explicit selection. No creator
is automatically created or reactivated. Detailed inventory is limited to the work
directories selected for preview, not the whole waiting area or gallery.

A multi-creator collection coordinates the existing per-creator admission plans.
It is not a new Work database or fabricated archive-ingest history. The server saves
the exact confirmed scope before dispatch and executes creator plans serially under
the existing admission barrier. Closing the browser does not discard the collection.
An interrupted collection retains child checkpoints and requires an explicit resume;
opening the workspace does not automatically replay old queues. A failed child is
reported independently of other completed/remaining confirmed children.
If an unstarted source changes after confirmation, continuing the old payload does
not approve that change. Prepare a new preview for those still-unmoved directories;
keep the old failed collection as history. Moved items use their original checkpoint
and exact recovery workflow, not a new plan that pretends they were never moved.

One collection accepts at most 100 creators, each with one selected parent directory.
Multiple alias folders for the same creator must be reviewed in separate scopes;
they are never silently combined or omitted. The submit check validates all selected
manifests and targets before atomically saving every child confirmation. The existing
engine validates again when each child actually starts. A collection child cannot be
submitted or resumed independently through an old single-creator URL.

On first review, clear new-work candidates are preselected, never submitted. Review
starts with pending items across all selected creators; selected works have collapsed
cards, with creator/group/status filters and title/directory search. Scope selection
can select currently filtered, uniquely resolved creators together without replacing
manual directory choices or combining two parent directories for the same creator.

Unsent choices record UI-only automatic/manual provenance. Manual defer/skip/title,
identity and primary choices are not reinterpreted as defaults. One tab's ten recent
unsent drafts can be restored after fetching authorized server state; this is not a
cross-browser saved draft guarantee. Original pending execution receipts always take
precedence, including their historical acquisition policy. UI-only provenance and
advertisement cancellation history never enter the execution payload.

The controls distinguish three operations:

- **上一步：调整导入范围** reopens the unsubmitted draft's selected creators and
  directories. Renamed/new directories are not automatically selected. Cancel returns
  to the same review; submitting the edited scope creates a new unconfirmed preview.
- **重新检查并更新选择** inventories the selected scope and creates a new draft.
  Automatically deferred or selected new works are reconsidered against fresh facts;
  now-safe new works are selected in the same operation. Manual defer/skip remain,
  and changed manual identity decisions require review. A rename or changed album
  boundary needs an explicit scope adjustment first. There is no separate supplement button.
- **更新进度** (results), or **读取已保存状态** (review technical details), reads saved
  server state only. Neither inventories disk nor resumes work. Refresh reconciles
  any changed saved summary with current choices, without overwriting manual decisions.

Repreview never edits the original plan or carries its execution receipt. Unsent
confirmed identity choices carry only when the saved manifest, target, boundary,
advertisement and creator-scoped identity/source facts still match. Changed existing
Work/same-as decisions become manual defer; one peer's changed evidence also invalidates
its dependent same-as choice. Legacy choices without provenance are conservative manual
choices. Surviving advertisement cancellations persist even across an unsafe intermediate
preview. Automatic safe-new selection is not an execution authorization. The API
rechecks draft/confirmation/owner state under its publication transaction, so a
concurrent confirmation prevents publishing a replacement draft. Confirmed or moved
items stay with their original checkpoint/recovery workflow.

History names the creators and links previous/subsequent previews. Lineage is optional
metadata published atomically in new children's existing context JSON; old drafts lack
it and remain readable. No schema migration or original confirmed-payload change.
Result items expose DB-only next-action hints from actual execution checkpoints, saved
plan membership, LocalWork/Post links and active owners. File-review links appear only
for eligible files-verified projects and disappear while a batch is active. Hints are
not authority: execution/review routes still validate their original guards.

Each grouped advertisement filename has one tri-state checkbox (all/partial/none).
Batch select/clear remains available, and affects only selected admission directories.
Final confirmation shows creator-level counts first; expandable exact directory, Work,
target and advertisement lists remain available. Separate execution/advertisement
confirmation is still required. No list/filter/checkbox action moves or recycles files.

Only clear new-work candidates can be selected together. Existing Work reuse,
same-work copies, source acceptance and exceptions remain explicit, creator-scoped
choices. Cross-creator Work reuse and same-as references are not supported. Optional
sources/settings and technical identifiers are secondary details rather than steps
every user must repeat. Exact advertisement choices and recoverable handling remain
visible in the final confirmation, including selections spanning creators/pages.

### Irregular extracted collections are not automatically reorganized

One selected direct child directory still represents one proposed Work, with its
internal structure preserved. Recursive inventory counts files; it does not prove
that a wrapper containing several shoots is a single album. Structural hints are
review prompts, not a semantic classification of photography or duplicate content.

For example, a creator wrapper might contain `working/Pic/albums`, another copy of
`albums`, and separate year/month image/video trees. Selecting those wrapper folders
would propose large combined Works. Establish the intended album boundaries first:
which branch is authoritative, which same-named directories are duplicates or distinct
shoots, and which loose videos belong to which album. Similar names/counts/sizes alone
do not authorize merging, skipping or deletion.

This workspace does not silently flatten, split, rename or merge those collections.
Keep uncertain scopes deferred while other creators proceed. Existing exact review
handles supported failed admission/Stage3 checkpoints and file exceptions; it is not
a general arbitrary-folder restructuring tool. Preparing a regular waiting layout
remains a separate scoped operation when genuinely needed.

- Review files are paginated. Status reads saved summaries, not disk media, full
  manifest hashes or decoder results. Polling is confined to the open active page
  and stops on completion, repeated network failure or leaving the page.
- A JPEG can be kept as an unsupported original only after the existing Sharp
  pixel-limit diagnosis. It remains excluded from normal image counts and decoding;
  the safety limit is unchanged. Valid WebP is ordinary media. PDF uses existing
  attachment rules, not an advertisement classification.
  In the Stage3 review path, named TXT/URL files not approved for removal are also
  retained explicitly as attachments, rather than inherited blanket ad cleanup.
- Explicitly selected ads or damaged files move on the same volume into recoverable
  quarantine in the existing precise-review workflow, never permanent deletion. This
  is distinct from new-admission advertisement recycling above. Durable intent with exact evidence precedes
  the move; destination verification precedes success. Retry reconciles both paths.
- Handling files and registering results are separate steps. Folder review uses
  original `recover` with an internal preparation callback under the admission lock,
  then applies the unchanged plan. Stage3 prepares under its existing barrier and
  calls `previewReview` / `resumeReview` for the original Job.
- Original plans remain immutable. New approved-advertisement removals are independent
  decisions restricted to exact original TXT/URL entries in an unfinished, unindexed
  item. Old decisions are readable; without this optional flag old rules are unchanged.
- PID/token ownership, active source claims, occupancy and manifest validation remain
  authoritative. Live or unknown owners are not stolen based on time. External file
  edits cannot be prevented; observed changes stop execution and remain visible.
- Dead-process work is interrupted, not automatically replayed on page load. Explicit
  continuation uses original checkpoints. Unstarted items may obtain a new preview
  without replaying completed ones. File failures never mark Jobs ingested by fiat.

## Reused services and new orchestration

The authoritative engines remain `LocalFolderAdmissionService`, `LocalIngestService`,
`WorkIdentityService`, `ArchiveLocalFulfillmentService`, `SourceEvidenceService`,
the scoped scanner and the admission barrier.

Manager-only routes `/api/admin/local-admission/*` and `/api/admin/local-review/*`
use existing authentication, authorization and write-intent/CSRF protections.
Selections are bounded; media is not uploaded. Dispatch is in-process but plans,
requests and file-action receipts are persistent, not in-memory-only jobs.

Migration **000025_local_admission_web.sql** adds only orchestration tables:

| Table | Purpose |
| --- | --- |
| `local_admission_web_batches` | Preview context, immutable submitted payload, dispatch owner/outcome |
| `local_admission_web_items` | Lightweight summaries/actions; execution joins original checkpoints |
| `local_admission_web_requests` | Idempotent submit/continue receipt |
| `local_review_web_sessions` | Review baseline, confirmation and original recovery request |
| `local_review_web_file_actions` | Recoverable move intent and verified result |

000024 is unchanged. Old business rows are not backfilled. Repeated migration SQL
preserves receipts; reopening preserves sessions. Automatic destructive down is
refused because it would erase operation receipts. Do not restore an old full backup
over later trial data.

Migration **000026_local_admission_collections.sql** adds the multi-creator envelope,
without rewriting 000025 or any existing confirmed plan:

| Table | Purpose |
| --- | --- |
| `local_admission_web_collections` | Combined confirmation, serial dispatch owner and overall outcome |
| `local_admission_web_collection_batches` | Ordered links to original per-creator batches |
| `local_admission_web_collection_requests` | Idempotent combined submit/continue receipts |

The collection endpoints live under `/api/admin/local-admission/collections`;
`GET /:id/scope` returns the saved scope without filesystem inventory, and
`POST /:id/repreview` prepares a new unconfirmed draft from that scope or an explicitly
edited replacement. The original collection remains unchanged. These add no migration.
`workspace` reads configured top-level directories and `creators` searches active
canonical identities and registered aliases. These have the same manager access and
write-intent checks as single-creator admission. All-deferred creators remain explicit
outcomes, not silently dropped work. Read-only polling uses durable summaries only.
The existing 1 MiB HTTP body limit remains; very large explicit file selections may
need separate collections rather than an unlimited request size.

## Verification and trial boundary

Focused tests cover original-engine execution, immutable replay, identity/main-copy
choices, exact source acceptance with staged history, changes/claims, auth/CSRF,
path confinement, review failure and migration compatibility. Browser acceptance uses
independent synthetic media, real nested Chinese 7z archives and a 2,100-image album
through the production entry on 4241. The local ignored report records actual completed
cases and timings; preparing fixtures alone is not a passed browser test.

The real production-entry fixture exposed a Windows/libvips handle issue that the
existing test-wide `sharp.cache(false)` masked: path-based WebP metadata could leave
the file open, allowing a hardlink but blocking source unlink with `EBUSY`. Local
admission/review metadata now uses a Buffer input on Windows; other platforms keep
the file input. Global Sharp cache settings, pixel limits and one metadata-validation
call remain unchanged. This adds a full file read and temporary input-buffer memory
on Windows at the existing bounded/sequential validation point, not another hash or
decode pass. A separate Node process test retains default caching and exercises actual
Chinese-path JPEG/WebP link/unlink plus the unchanged pixel-limit rejection.

A separate two-connection regression test reproduces SQLite's deferred read-to-write
upgrade conflict during `ManagedCreatorService.linkFolder` while a real catalog
publication holds the writer. Top-level folder linking now reserves the writer with
`BEGIN IMMEDIATE` before reading ownership. Caller-owned transactions retain their
SAVEPOINT/rollback contract. This does not change journal mode, global timeouts or
the catalog worker, and is not a blanket promise that every SQLite contention is
resolved. Historical failures without a statement-level trace are not retrospectively
claimed to have this sole cause.

`WorkIdentityService.registerLocal` now follows the same top-level writer reservation
rule before its first identity/idempotency read. A separate real catalog-publisher
connection regression reproduces the old conflict despite `busy_timeout`, then checks
successful waiting, stable identities and rollback. Nested caller transactions retain
their original semantics; they are not silently replaced or automatically retried.
Advertisement-result transactions also reserve the top-level writer before reading.
No filesystem operation is wrapped in a blanket SQLite retry. The historical paused
batch's error is retained; its exact former lock-owning connection was not observed.

Previously completed real jobs must not be replayed. Preview data is never copied to
production. A 4141 candidate update requires paired client/server/CLI artifacts, a
current backup and the normal PyCharm maintenance window. PR38 stays Draft; Script
PR13 and the installed plugin remain unchanged. Passing tests or installing a candidate
does not mean the user has accepted the product for merge.

### Parents containing only internal residual directories

The waiting-area workspace inspects only the immediate children of each safe creator
parent. A nonempty parent containing exclusively real reserved `.local-admission-*`
or `.local-review-*` directories is omitted from pending creator selection. This is a
read-only presentation filter: it does not enumerate those containers or remove them.
Empty parents are also omitted. Ordinary directories/files and reserved-name files
or links remain visible. Unreadable parents remain visible with their error and cannot be selected.

Historical advertisement cleanup remains a separate explicit operation through
`preview-recycle-advertisements` and `recycle-advertisements`, using the immutable
original plan and exact approved files. It records recycling/removal evidence without
replaying admission. Merely opening or refreshing the waiting area never cleans old
attachments, and a hidden parent is not proof that every historical job succeeded.

### Continue unresolved items and finalize empty parents

An inactive confirmed collection exposes `remainingCount` and an explicit
`POST /collections/:id/remaining-preview` action. This creates a linked, unconfirmed
draft directly in review, containing only original deferred entries with no execution
checkpoint. Completed/skipped entries and exact paths claimed by another immutable
plan are excluded. Local targets registered after the original preview are excluded;
pre-existing identity conflicts remain reviewable. Missing original directory names
stay visible as conflicts; renamed/new directories are never silently substituted.
Manual deferral reasons survive. Repeat clicks, including concurrent requests, reuse
the existing current follow-up draft. Rechecking that draft preserves its lineage.
Original confirmations, plans, checkpoints and request receipts remain immutable.

After successful web admission, only that batch's verified empty creator parent is
eligible for recycling. Ordinary content, deferred directories and internal retained
attachments prevent cleanup. A separate result records cleanup success or failure;
failure must not downgrade completed admission. The helper checks direct-child scope,
ancestors, activity, identity and emptiness, isolates the empty directory under a
reserved temporary name, and restores it when new content or a recycle failure is
observed. Arbitrary external writers cannot be atomically locked by the Windows
recycle API; a failed restore reports its retained location without overwriting a
recreated parent. Only the helper's empty wrapper is removed non-recursively.

Historical empty parents require the explicit `POST /collections/:id/cleanup-empty-parents`
action in results. Listing, refreshing and restarting do not perform historical cleanup.
Both actions require management authorization and write intent, reject active owners
and preserve activity/claim protection. No migration or automatic remaining-job execution
is introduced. Rapid-iteration runtime management may be performed by Codex when the
user explicitly authorizes it, using the same production entry and configuration.
