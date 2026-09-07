# Library media viewer route unification V1

## Scope

Base: `be90b611bfa58239d9381439cf2d0e7f4d00db0c` (PR13).
This change is client-only: no schema, media API, permission, derivative configuration,
HTTP cache header or production runtime changes. Publication stops at an unmerged PR.

## Routing and lifecycle

- Canonical cards have real `/library/:creatorId/works/:postId?media=:imageId` hrefs.
- WorkGalleryView remains mounted and opens the existing PostView/PostViewer as its
  query-driven overlay. The already ownership-checked work response is shared with
  the viewer; media selection does not fetch the work or creator again.
- Missing media query shows only the grid. Invalid, duplicate and foreign media
  queries produce an error rather than silently selecting the first item.
- The existing server canonical work endpoint still verifies creator/Post ownership.
- Opening pushes once; switching replaces. Closing returns only to a verified same
  work background without media and with equivalent whitelisted reading state.
  Query ordering is immaterial. Other entries replace to the safe work base.
- Legacy canonical Post links validate identity and media before replacing to the
  new route. Only safe reading state is carried; no arbitrary return URL is followed.
- Ordinary Posts, physical Folder routes and share routes retain their scope.
- Retained work data responds to auth/index/storage invalidation, caption updates
  and deletion. Pending responses are fenced by existing load tokens.

## Automated checks

Run with Node 24.19.0, frozen-lockfile installation, in the independent worktree:

| Check | Result |
| --- | --- |
| Server full suite, including migration and share/owner guards | 517 passed, 2 existing skips; 87 files |
| Client full suite | 342 passed; 55 files |
| Client targeted route/viewer tests | Passed |
| TypeScript / vue-tsc and server/client production builds | Passed |
| git diff --check | Passed |

Tests include 500 retained media nodes, Close/Esc/Back/Forward, unrelated history,
strict legacy identity/media, auth invalidation, stale response suppression and
Post-level mutation feedback. Existing share API tests verify that a share session
cannot expand into canonical creator APIs; no real share was created for this task.

The build retains the existing large-chunk warning; this task does not redesign
application initialization or overall page performance.

## Isolated browser evidence

The browser used port 4246, a consistent SQLite copy, and independent thumbnail and
preview directories. All five effective storage paths were checked before importing
the application/database. The original gallery was read-only; both startup scan
paths were confirmed skipped. Browser requests were restricted to GET/HEAD.

The real-data matrix covers creator 2 and multi-directory creator 166, exact non-first
Image IDs, repeated switches, nonzero scroll, DOM identity, refresh/direct/new-tab,
legacy redirect, invalid/duplicate/foreign media and wrong creator/Post combinations.
It also covers pure video, mixed video, rapid open/close, mobile containment and the
library search/rating → creator → work → media → return chain.

Additional browser fixtures intercepted only read API responses for a 500-item grid
and a delayed response. No synthetic production records were created. The 500-item
grid retained its nodes and scroll at 32273px; closing before a delayed detail response
did not reopen the viewer. Actual Ctrl-click and middle-click opened usable new tabs.

| Warm work transition (both real creators) | JSON API requests | Media requests |
| --- | ---: | ---: |
| Open non-first item | 0 | 1 |
| Switch item | 0 | 1 |
| Close | 0 | 0 |

Initial work navigation still performs necessary protected initialization and
creator/work ownership requests. These measurements apply only after that data has
loaded. They do not claim to fix the previously measured full-page latency.

Media URL/asset keys stayed unchanged. Four existing derived resources retained size,
mtime and SHA-256 in both the production sample and isolated warmed copy; sampled
original file sizes/mtimes also stayed unchanged. Screenshots and full request logs
are retained only under ignored `data/viewer-audit/`, not committed.

## Production protection

Before/after read-only SQLite snapshots found all 29 table row hashes identical:
588 completed LocalIngestJobs, 2323 active matched local works, migration 000017 and
657 Scan Runs. Integrity checks passed, no claims, no scanning/ingest/recycling.
Production 4141 remained on PID 81852 and the original main commit throughout.
Script remained clean at `84a95ffef1c03d4cb1cfa7006a1c0e9eab5ec9c6`.

The main worktree's existing unstaged CONTRIBUTING.md was not edited, staged or
stashed: content SHA-256, unstaged diff and empty staged diff matched the baseline.
No real media was moved, modified, deleted or restored; no production configuration
or database business records were written.
