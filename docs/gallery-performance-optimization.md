# Gallery performance optimization (draft)

Base: `321e5241296ada67ae31632c85a5d30deaf2e162` (PR40).

This is one ongoing performance candidate, not a release. It is not deployed to
the live gallery. The first user preview will use the isolated port 4241.

## Scope and progress

- M1: initialize ordinary browsing with light status, share only equivalent
  initialization reads, and wait for the saved feed mode before infinite loading.
  Explicit refreshes remain separate generations. Late status, scan-poll and feed
  responses cannot repopulate reset access state. Server query work is in progress.
- M2/L5: negotiated text compression, management-route splitting and distinct
  HTML/hash-asset caching are in progress. Full feed media arrays are retained.
- L3/M3: bounded distinct-output generation and coordinated media URL/disk
  versions are in progress. Existing maintenance and same-output coordination
  must remain intact.
- L1: the eight audited explicit indexes and migration validation are in progress.

No changes to the legacy folder deletion flow, fonts, authentication policy,
backup product features, data locations, WAL/synchronous mode, task KV storage,
historical cleanup or plugin behavior are included.

## Validation so far

- M1 client targeted tests: 26 passed (app store, feed store, HomeView).
- Full candidate regression, matched before/after measurements, production-entry
  isolation and the paired preview remain pending. Historical audit timings are
  not presented as a new candidate benchmark or as DOM/image completion timings.

Private databases, local paths, raw request records and measurement artifacts
remain in ignored local evidence directories, not in the pull request.
