# Catalog entry and confirmed sort time: draft preview

This is an iterative preview, not a deployment or final acceptance.

## Entry scopes

- `/archive-catalog?workspace=resources`: creator picker only; no catalog list,
  detail or export is fetched until the user chooses a scope.
- Add `creatorId=<id>` for the existing personal catalog deep link.
- Add `scope=all` for explicit global browsing; the secondary picker action
  creates this URL. Invalid creator parameters never fall back to global.

Personal and global scopes share ResourceCatalog. Filters, export controls and
technical notes are collapsible; failures and incomplete versions stay visible.
Changing scope invalidates pending responses. The roster stays mounted when
returning within the SPA so its current filters and page survive.

## Work-level time

See [confirmed-work-sort-time.md](confirmed-work-sort-time.md) for migration
000023 and the explicit, idempotent maintenance command. No real identities or
private file evidence are shipped. Production data application is separate
from schema deployment and is not part of this preview.

## First-preview evidence

- Client affected suites: 56 passing; production typecheck and build pass.
- Server affected suites: 57 passing, including 8 new confirmation cases;
  typecheck/build pass. Existing migration parity now normalizes Windows CRLF.
- Isolated production entry: ordinary migration/validation and catalog worker,
  both original startup scans skipped, separate database and derivative paths.
- Seven user-scoped decisions applied to a real-scale isolated database;
  identical replay applied zero changes. Catalog numbering, paginated canonical
  cards and detail timestamps agree. Existing business table fingerprints and
  the selected original media metadata remain unchanged.
- Real browser: default picker sends zero catalog requests; search and personal
  selection, reload, explicit global/reload and invalid scope handling pass.

Private reports and screenshots are retained only in ignored local evidence.
This does not claim final full-regression, production deployment or user UI
acceptance. Final candidate verification follows explicit user closure of this
iteration. Existing ambiguous legacy ownership is not repaired by this feature.

## Feedback iteration: source-order estimates

Filesystem birthtime is no longer the adopted rule for the selected anomalies.
The isolated preview retains its captured evidence and revoked decisions. Five
works now use fixed source-order estimates; two lack reliable source sequence
and retain their original times. Equal-interval groups never use each other as
anchors, and no missing source entry is invented.

The concise list marks estimated times; expanded details and export evidence
explain their fixed anchors and non-publication-date meaning. The relevant
server suites pass 28 tests, client component passes 17 tests, types/builds pass,
and actual browser badge/detail checks pass. Isolated comparison verifies
catalog/card/detail agreement, unchanged business facts and idempotent replay.
The same Draft and preview remain unmerged and undeployed.
