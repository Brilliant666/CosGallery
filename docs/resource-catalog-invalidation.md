# Resource catalog derived-state invalidation

Migration 000022 stores lightweight completed rows and per-creator generations.
These tables have no foreign keys to mutable business identities: deletion marks
the affected creator dirty, while the last complete publication remains available
until the builder atomically publishes the replacement (including tombstones).
They are rebuildable projections, never authoritative acquisition evidence.

SQLite triggers apply to every writer, including CLI and independent connections.
Markers participate in the original transaction and roll back with it. INSERT and
fact-changing UPDATE mark after the write; DELETE marks before cascading deletes
lose ownership joins. Both old and new owners are included when relationships move.
Each marker only increments generation and clears retry/error state. No trigger
scans media, hashes files, generates rows, or publishes a catalog. Batch writes can
increment a creator generation many times, but the updater coalesces these to one
completed-generation publication.

| Facts observed | Dirty owner selection |
| --- | --- |
| Creator canonical name, active/preference/rating; aliases | That creator, including deletion tombstones |
| Work title, creator, selected primary local copy | Old and new Work creators |
| Local copy Work/Post/folder, original paths/name, active/match state, other count | Work creator and local-folder owner |
| Local creator folder assignment, gallery folder, path, match/active state | Old/new owner, all shared gallery-folder owners, Works using the bridge |
| Gallery folder role | Folder owners and bridge-linked Works |
| Post source path/folder, caption, ordering timestamp, deletion/trash state | Folder owners, bridge-linked legacy Works, explicitly linked Works |
| Post item image, position or Post | Both Posts' folder and Work owners |
| Image filename/path/folder, type, size, deletion/trash state | Indexed member Post owners and linked Works; explicit-cover and unsupported-original rules are thereby refreshed |
| Source Work ownership, collection, platform, source number/label/title, declared media summary, active state | Its Work creator |
| Collection public URL | Creators of its associated source Works |
| Active/revoked admission-file-removal decisions and payload | Their Work creator, for retained-original descriptions |
| Ingest source/creator, ingested state, target and retainedOriginalCount | Old/new creator when the job is ingested |

The triggers intentionally ignore derivative paths, access timestamps, generic
updated_at, worker heartbeat, task state/progress and unrelated ingest summary
properties. Normal thumbnail/preview generation does not invalidate the catalog.
Display direction is a request setting applied to already assigned per-creator NO;
changing it does not invalidate numbering. Media fingerprints are not used as a
catalog identity or count and do not alone trigger re-generation.

Tests compare the fresh-schema constant with migration SQL, cover repeated
application, independent connection writes, reopen, rollback, owner reassignment,
legacy exact-path membership, shared-owner ambiguity, deletion and retained-file
decisions. A legacy-ambiguity fixture removes only its isolated active-folder
unique index so both owners remain observable; production constraints are unchanged.

The generator must publish only the generation it actually read, retaining pending
newer generations; must handle deleted-creator tombstones; and must not treat these
markers as permission to change Work, source, task or file facts.

## Publication and owner changes

The read model captures generation and all creator facts in one SQLite read
transaction. Publication uses BEGIN IMMEDIATE and compares every captured
generation; it also rejects an already published generation/rule pair. Failed
generation or insertion retains the previous completed rows and records a bounded
retry, without clearing newer changes. A new process sees the persisted pending
generation and retry state; an unchanged completed creator is not regenerated.

When an existing Work moves between creators, its derived row may still belong to
the old completed publication. Preparation follows only these conflicting Work
owners to capture their snapshots in the same read transaction. The complete
related group is replaced in one write transaction after all generations pass.
This handles two-way Work swaps without a primary-key collision, partial snapshots,
or cyclic waiting; ordinary single-creator changes do not build other creators.
Deleted-creator tombstones are cleared by that same atomic publication mechanism.

Rule versions are monotonic for each creator: older updaters skip a higher stored
version, refuse preparation, reject late prepared publication, and never attach
their failure marker to it. A newer process may progressively upgrade remaining
older creator versions; no global event infrastructure or schema-wide lock is used.
