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

Shared title extraction removes only a known creator prefix, outside NO/VOL, and
trailing media-count/size wrapping. NFKC and whitespace normalization preserve case,
internal numbers, theme modifiers, punctuation and subtitles. Variants are only
review candidates. One Work with two copies counts once; primary-copy availability
and media-index/file metadata are checked without a new full content hash pass.

## Review and recovery

Ambiguous **new** source entries remain as raw source facts in the collection's
`works` and `localSourceReuse` metadata. They do not receive a speculative duplicate
Work, SourceWork or download task. `/creator-sync/source-reuse` and the source-tab
read-only disclosure expose reviews even when no download task exists. They are
not counted as successfully fulfilled. To resolve a pending new entry, an explicit
PR24 `bind-source` can bind that collection/entry to a known Work before rechecking;
the existing version-acceptance policy must still be satisfied.

Existing SourceWork IDs are retained. A source already owning a different Work from
its local candidate is held for review, never silently merged. Active claims are
not cleared. A revoked name decision invalidates only its own source/local
fulfillment; future checks preserve the review. Generic existing-Work merge/split
and a decision-editing UI remain out of scope.

The source-tab explanations are explicitly latest-check snapshots, not live disk
scans. At the next prepare/import the local directory, active Post, indexed media,
size/mtime and completed admission checkpoint are revalidated. Unknown, changed or
offline state is review, not proof of a missing collection or permission for a full
re-download. Existing source declaration changes retain the old review safeguards.

## Validation

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
