# Local admission and review in the web UI

This is the web continuation of Draft PR38. The CLI remains a maintenance entry;
ordinary users do not need commands, scope JSON, internal IDs, or an agent.
This is local-server file handling, not browser media upload or a cloud sync service.

## User flow

1. Open a managed creator and choose **本地导入**. A confirmed source observation
   may open the same page with its context; a source is not required.
2. Finish manual copying/extraction first. Browse the configured extracted waiting
   root, choose the creator parent, then select its direct work directories.
   Browsing lists one layer only. Preview inventories just the selected scope.
3. Review new independent works, possible existing works, known local copies and
   unresolved conflicts. Suggestions are not confirmations. Search this creator's
   Works by title, catalogue NO or original directory, using names/covers/counts.
   Stable IDs are carried by the application, never inferred from NO.
4. Choose new / existing / same-as-this-batch, main or secondary copy, skip or defer.
   Existing canonical titles remain. Same-title independent Works are supported.
   No general merging of two existing Works is offered.
5. Confirm the source/destination scope and usable-version choice. Ads require an
   **additional explicit confirmation of named TXT/URL files**; unchecked attachments
   stay. Batch provenance alone never satisfies downloads. Exact version acceptance
   requires selecting the existing Work and specific sources, using original claim
   checks and the fulfillment service, without rewriting staged history.
6. Follow real stages and results. Recent batches and URL restoration survive
   refresh/new tabs. A lost response is retried with the same receipt. Closing the
   page does not cancel a submitted operation.
7. An unfinished item opens **查看并处理** or continues the original plan. Eligible
   Stage3 reviews open the shared panel from the existing Stage3 list and remain
   Stage3 jobs; they never become folder-admission plans.

The extracted waiting root defaults to the gallery's sibling `cos等待入库` and can
be set by a manager. It must exist on the same volume and be independent from the
gallery, archive inbox and processing root. Linked ancestors, junctions, traversal
and arbitrary absolute directory selection are rejected server-side. There is no
shell-command or arbitrary-file-management endpoint.

## Review, persistence and failure behavior

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
  quarantine, never permanent deletion. Durable intent with exact evidence precedes
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

Previously completed real jobs must not be replayed. Preview data is never copied to
production. A 4141 candidate update requires paired client/server/CLI artifacts, a
current backup and the normal PyCharm maintenance window. PR38 stays Draft; Script
PR13 and the installed plugin remain unchanged. Passing tests or installing a candidate
does not mean the user has accepted the product for merge.
