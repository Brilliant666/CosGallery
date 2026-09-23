# Local-first source reuse V1

This is the application path, not the research prototype. No production migration
is required: migration 000019's decisions, local provenance and fulfillment overlay
are reused. New code does not act on any production files when installed.

## Call chain

`ArchiveMetadataTaskService.validateDirectory` →
`ArchiveCatalogService.validateCompleteCostuanDirectory` →
`LocalSourceReuseService.evaluate` computes the entire source/name set **before**
returning `requiredFilenames` through the existing plugin protocol. Source format,
numbering, identity and supplemental-content checks still precede matching.

`validateCompleteCostuanCheck` recalculates the same result at the receipt boundary.
`importCostuanRecords` evaluates before inserting entries, uses explicit bindings
first, and then reuses unique names. Work titles and media IDs are not rewritten.
The new source receives a traceable `unique_name` decision and the existing PR24
`accept_version`/fulfillment overlay, not fabricated download or ingest history.
Missing planning and claim guards continue to consume that overlay. No task is
created merely to record a local satisfaction without prior download history.

## Acceptance and identity policy

New preview items are `localOnly:false`, meaning no source yet, not a ban on future
association. They are still explicitly identified and protected from local-number
guessing. `acceptExistingVersion:true` in a confirmed admission plan is the explicit
permission to accept a usable indexed local version under the unique-name rule.
It defaults to false, including for older plans. Explicit `localOnly:true`, negative
decisions and revocations are not erased or relaxed by this release.

The current web admission confirmation explicitly submits this acceptance policy
for the selected new scope; it does not require another checkbox proving version
completeness. Retrying an existing confirmed request preserves its original value
instead of replacing older decisions with the current web default.

Shared title extraction removes only a known creator prefix, outside NO/VOL, and
trailing media-count/size wrapping. NFKC and whitespace normalization preserve case,
internal numbers, theme modifiers, punctuation and subtitles. Variants are only
review candidates. One Work with two copies counts once; primary-copy availability
and media-index/file metadata are checked without a new full content hash pass.

## Review and recovery

Ambiguous **new** source entries remain as raw source facts in the collection's
`works` and `localSourceReuse` metadata. They do not receive a speculative duplicate
Work, SourceWork or download task. `/creator-sync/source-reuse` retains the
read-only review data even when no download task exists. PR39 removed the separate
source-tab disclosure entry; this API capability is not a claim that a generic
source-mapping resolution UI is available. These entries are
not counted as successfully fulfilled. To resolve a pending new entry, an explicit
PR24 `bind-source` can bind that collection/entry to a known Work before rechecking;
the existing version-acceptance policy must still be satisfied.

Existing SourceWork IDs are retained. A source already owning a different Work from
its local candidate is held for review, never silently merged. Active claims are
not cleared. A revoked name decision invalidates only its own source/local
fulfillment; future checks preserve the review. Generic existing-Work merge/split
and a decision-editing UI remain out of scope.

The review explanations are explicitly latest-check snapshots, not live disk
scans. At the next prepare/import the local directory, active Post, indexed media,
size/mtime and completed admission checkpoint are revalidated. Unknown, changed or
offline state is review, not proof of a missing collection or permission for a full
re-download. Existing source declaration changes retain the old review safeguards.

## Validation

### Review candidate correction (September 2026)

The accepted local Work remains authoritative. Source numbering is not its
identity. Before declaring a source missing, a separate **lossy, review-only**
comparison also considers bare leading ordinals (`001 -`), spaces in an already
known creator name, bracketed known aliases, punctuation/case, and media-count
tails such as `[61P/766MB]`. This comparison never authorizes automatic reuse,
merges Work IDs, learns a creator alias, or proves equal media contents. Meaningful
internal numbers and different themes still distinguish candidates. A genuine
new title without a local candidate continues through missing-work planning.

Candidates remain in collection `works` / `localSourceReuse` metadata with their
candidate Work IDs. New unresolved entries do not create speculative Work,
SourceWork, or acquisition tasks. Existing source identities are not rebound:
conflicts enter review on the next source preparation/import. Already confirmed
relations retain priority. Strict exact-name reuse and its version acceptance,
revocation, availability and full-set ambiguity checks remain unchanged. Existing
decision keys retain `unique-work-title-v1`; only the diagnostic review rule version
changes. No migration, persistent cache or background identity sweep is added.

Stage2 already rechecks durable holds at claim time. Stage3 now rechecks the same
hold **after acquiring its own claim but before archive processing** for never-run
queued/failed jobs (zero attempts, no processing directory or summary). Held jobs
become `awaiting_review / mapping / SOURCE_ACQUISITION_REVIEW_REQUIRED`; they are
not marked ingested and their download history is untouched. Existing extraction
checkpoints, committed reconciliation and another worker's active claim are not
rewritten. Merely installing this code does not retroactively republish old source
metadata or resolve already-conflicting identities.

Historical source-only duplicate Work correction is **not** a new generic merge
API. A separate explicit plan must verify exact source/local relationships and all
references, preserve media-bearing Work/LocalWork/Post/Image and original plans,
record the old source relationship, and handle only eligible source-only
placeholders. A disposable-copy SQL rehearsal is not an authorized production
execution path. Existing review states are a no-execution safeguard, not a claim
that historical jobs have been completed or the review UI has been resolved.

The added tests cover formatted titles, both arrival orders, ambiguous distinct
local Works, genuine missing works, repeat import, established relationships,
active download/ingest claims, and Stage3's pre-processing hold. They use synthetic
data and do not contain private source-to-work mappings.

`local-first-source-reuse.test.ts` uses temporary migrated databases, generated JPEGs,
real admission/scanner/catalog/download services, and the real metadata-task
prepare/receipt protocol. No pre-binding stands in for first-source automatic reuse.
It covers both arrival orders, explicit version acceptance, two copies of one Work,
full-set conflicts beyond 100 entries, negative policies, restart/repeat/revoke
behavior, and local changes between preparation and receipt.

The browser fixture uses only generated solid-color images: one unique local work,
two distinct same-title works, and one new remote work. The actual built app shows
one accepted reuse, one visible review, and exactly one pending acquisition. No
private directory, source mapping, media, database or credential belongs in this PR.
