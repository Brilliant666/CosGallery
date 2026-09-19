# CosGallery own resource catalog

The admin ledger's resource-catalog workspace describes confirmed **local Works**,
not the creator's complete worldwide publication history. It is a read-only view:
opening, filtering, copying and exporting it do not scan disk, match sources,
create Works, plan downloads or rename local directories.

## Identity and numbering

- Work IDs remain the identity. A same-title pair of different Works remains two
  entries; confirmed copies of one Work occupy one entry.
- An explicit primary is authoritative. The reader does not promote a secondary
  when the primary is temporarily unavailable. A single unambiguous legacy copy
  can provide the existing implicit representative; ambiguous cases stay visible
  for review rather than choosing a copy by title or number.
- Existing legacy local records can resolve their indexed Post by the unique
  exact creator-directory/work-relative path relationship. This does not persist
  a new binding and is not a title/NO-based source match.
- Catalog display order follows the persisted gallery folder order: `sort_timestamp`
  and Post ID, both ascending for oldest-first or descending for newest-first.
  Missing reliable sort evidence is not replaced with the current time or an
  external source date.
- Numbering always uses ascending `sort_timestamp`, then ascending Post ID and
  Work ID as deterministic tie breakers, independently of display direction.
  Changing oldest/newest display order does not change a Work's NO. Unarranged
  rows remain unnumbered at the end in either direction. TXT labels numbering
  and display order separately; CSV and filtered exports retain the same NOs.
- Numbering runs over the creator's entire eligible collection before search,
  status filtering and pagination. Minimum three digits, with no truncation past
  999. A filtered result keeps its original number. New insertions may shift NOs,
  never Work/LocalWork/Post/Image IDs or paths.
- A NO is a presentation value, not a source key, filename, task identifier or
  permanent identity. Migration 000022 saves this rebuildable value only in the
  derived catalog rows; it never writes numbering into Work or source records.

## Local facts and source facts

Counts and media bytes belong to the representative copy's valid indexed image
and video members. Secondary copies, advertisements, ordinary attachments,
retained unsupported originals and remote archive declarations are not summed
into these bytes. `LocalWork.total_bytes` is not used as a media-size shortcut.
Unknown statistics stay unknown. A retained last index is labelled as such, not
presented as a fresh disk inspection.

Temporarily inactive records are distinguished from explicit trash/deletion.
Historical readable Posts without a reliable Work are disclosed as identity gaps;
reading does not repair them. Source-only Works do not acquire local catalog NOs.

Source platform, original title and source numbering remain separate from the
canonical Work title and CosGallery NO. No source does not mean a website lacks
that work. Multiple saved sources remain within the same Work row.

## Navigation and consistency

The roster action and workspace selector open the same component/data service.
The selected creator is addressable through ledger query parameters. The roster
stays mounted so its current filters and page survive workspace navigation.
Resource reads are lazy: other workspaces do not fetch a resource catalog.

The default workspace shows all creators; the roster action limits the same page
to one creator. Global search matches title, creator name/aliases and original
copy directory names. Each creator retains its own NO namespace.

Migration 000022 adds a persistent, rebuildable read model. SQLite triggers mark
affected creator generations in the same transaction as the facts. A single
background worker reads one consistent generation and atomically publishes its
lightweight rows, copy details and summaries. Ordinary requests read completed
rows; they do not generate catalogs or aggregate media. Restart resumes pending
updates and reuses completed rows. See [invalidation coverage](resource-catalog-invalidation.md).

Pagination, expanded details and exports carry a version token; a mismatch
requires refresh rather than combining numbering states. The UI distinguishes
ready, updating, uninitialized and failed states, and only polls while pending.
It retains an already displayed version when a newer version is found. Exports
require a complete current scope. A failed update keeps previous completed data
and is retried without a maintenance button. Live deletion/ownership guards may
hide a now-invalid row before its replacement publication; pending summaries are
explicitly still the last completed summaries, not a new complete snapshot.

## Copy and export

The UI distinguishes full scoped catalog from the current filtered result; neither
means the current page only. Text includes creator, NO, canonical title and local
media counts/capacity. Unknown values and unarranged entries are explicit.
TXT adds generation time, order, scope and the dynamic-NO explanation. CSV retains
stable IDs, byte values, original directory names and saved source summaries.
Global exports include creator name/ID and stable Work ID. The CSV download also
delivers its matching `.metadata.json` with revision, scope, order, generation time
and row count; a visible metadata download link remains if the browser blocks a
second automatic download. Save both files together.

CSV cells are quoted/escaped and formula-leading values are made inert. Management
paths, credentials, extraction codes and passwords are not export fields. Source
links are restricted to safe HTTP(S) URLs without credentials or private query data.
No export modifies master data or the local filesystem names.

## Access and scope

List, details, creator selection and export are admin APIs protected on the server.
Nothing is added to public gallery or sharing responses. The selected album links
use the existing library routes and retain primary/secondary navigation behavior.

Development uses an independent worktree and isolated test data. Production4141,
its database/caches, user IDE files, ingestion, recovery and source automation are
outside this implementation's mutation scope. This change is delivered as an
unmerged, undeployed review PR.

## Application entry points

- `ArchiveCatalogView` mounts `ResourceCatalog` only for the resource workspace.
  Both the roster action and workspace tab use
  `/archive-catalog?workspace=resources&creatorId=...`.
- `ResourceCatalogBuilder` owns scoped generation, copy selection and numbering.
  `ResourceCatalogReadModel` captures fact generations and atomically publishes.
  `ResourceCatalogService` reads published rows, filters and exports. None calls
  the fulfillment evaluator, `hydratePostItems`, or enumerates media on disk.
- The management-capability-protected API prefix is
  `/api/admin/archive-catalog/resource-catalog`:
  `GET /creators`, `GET /all`, `GET /:creatorId`, `GET /:creatorId/works/:workId`,
  and `GET /all|:creatorId/export?format=txt|csv&scope=all|filtered`.
  Global detail reads include `revisionScope=all`; direction is `order=oldest|newest`.
- Subsequent pages, details and exports carry a SHA-256 token of small version
  identifiers, not a freshly computed content hash.
  Export requires it. A changed snapshot returns HTTP 409
  `RESOURCE_CATALOG_CHANGED`; invalid transport parameters return 400.
- Migration 000022 creates three derived tables, their indexes and fact-change
  triggers. No public write endpoint or new business task is added. The background
  worker writes only rebuildable projections. It never changes acquisition evidence.

## Original PR30 validation (historical)

The following records describe the original on-demand implementation, not the
current steady-state read model. Current real-scale results are recorded in
`resource-catalog-read-model-performance.md`.

The isolated browser fixture uses over 1,000 local Works for one creator, a second
creator, old matched records without an explicit Post ID, duplicate titles,
multiple copies, an unavailable primary, missing sort evidence, a readable Post
identity gap and a source-only Work. All files and derived images are synthetic.

Actual production-build browser checks cover desktop and 390px layouts, roster
entry and same-SPA return, refresh/new-tab creator identity, page two, NO.1000
search, copy-to-clipboard, downloaded full CSV and filtered TXT, copy details and
existing album navigation. An isolated database change verifies HTTP 409, keeping
the displayed old snapshot until explicit refresh. The original four workspaces
are read-only smoke tested. No browser business action is invoked.

Both primary and secondary copy links were actually opened: synthetic thumbnails
and Viewer previews decoded successfully. Closing Viewer through Back retained
the same background grid DOM and made zero additional work-detail requests.
Desktop and 390px screenshots were inspected; the narrow table scrolls internally
without overflowing the entire page. The isolated host and browsers were closed
after acceptance; production 4141 was not restarted or repointed.

Roster filters/page survive a same-SPA workspace return through its mounted
component. A full browser reload preserves the resource creator via URL; this
change does not add cross-reload persistence to the existing roster filters.

The Node24 full regression run passed 927 server tests (two existing video-tool
conditional skips) and all 458 client tests. Subsequent resource-specific review
fixes are validated again by the final targeted suite and CI. The conditional
video ingest tests are not resource-catalog skips; this feature adds none.

Review explicitly checked uncertain ownership, cross-Work primary references,
unavailable versus deleted copies, legacy Post resolution and original retention
from both admission recovery decisions and completed Stage3 evidence. Uncertain
ownership cannot supply apparently confirmed primary-media totals.

This is not a production throughput benchmark: the synthetic scale proves full
numbering/export beyond 999 and fixed-count scoped database reads, not the cost of
every possible creator's real media membership. Media aggregates remain proportional
to the selected creator's indexed members; there is no permanent result cache.

## Isolated production-build measurements

Measured with Node 24.19.0, a synthetic creator with 1,005 local Works and about
1,008 indexed media members, including 100 legacy copies without explicit Post
IDs. Independent database/gallery/thumbnail/preview paths and port 4481 were used.
One warm-up preceded three measured runs, without the full test suite running in
parallel. These are new-feature measurements, not a before/after production claim.

| Operation | Service median (range), ms | HTTP median (range), ms | HTTP body bytes |
| --- | ---: | ---: | ---: |
| First 50 rows | 67.84 (66.99–67.97) | 77.65 (77.03–80.25) | 22,509 |
| Selected Work detail | 67.22 (66.64–68.36) | 79.61 (79.28–80.10) | 1,071 |
| Complete 1,005-Work CSV | 68.12 (67.26–69.85) | 77.34 (77.05–77.41) | 211,143 |

Service timings include snapshot query, aggregation and serialization preparation;
they are not presented as pure SQL timings. HTTP timings include reading the full
body; byte counts are application-body bytes, not compressed wire transfer sizes.
CSV size can change slightly after the intentional synthetic title-update check.

A fresh browser context reached the actual 50-row resource table in a median
276.09 ms (255.21–278.69 ms), at the fixed desktop viewport with the server already
ready. This is a table-visible milestone, not FCP or all gallery-media completion.
Each entry made one resource-list request and zero resource-detail requests.

Instrumentation observes 10 prepared reads for list, detail and complete export,
both for the 1-Work creator and the 1,005-Work creator. No per-row detail hydration
occurs. EXPLAIN assertions verify the legacy exact path uses the existing unique
`posts.source_path` index and then the Post primary key, without scanning all Posts.
The identity-gap check reads creator-scoped visible Post IDs once and compares
against a reliable linked-ID set rather than repeating a local-copy scan per Post.

The final resource server suite has 12 passing cases, including the ownership and
Stage3 retention review fixes. Server TypeScript, client vue-tsc and both final
production builds pass. The existing Vite large-chunk advisory remains; bundle
splitting is not introduced as part of this feature.
