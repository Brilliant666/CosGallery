# Creator page and catalog UX fix V1

## Scope and baseline

- Branch: `fix/creator-page-catalog-ux-v1`; base: `19d99fc540f1776317117ddfd251d505fe477b1a`.
- Four bounded UX changes only. No migration, execution workflow, plugin, physical-route or deployment changes.
- Production 4141 had been stopped by the user before this task and remains stopped. The attachment's earlier running PID is not the current baseline.
- Production database was queried with Node `DatabaseSync(..., { readOnly: true })`, without importing application startup or execution services. No production backup, migration or media scan was performed.

## Changes and causes

1. `CanonicalCreatorView` previously linked directory names to `physical=1`, taking management actions out of the canonical browsing context. `CreatorFolderActions` now opens the existing profile/share modals in place, lazily fetching only the chosen Folder. Initial render makes no per-directory detail request. Each button is scoped to its Folder; `canManageLibrary` hides both management actions and paths. Saving updates the local directory label and reading cache, not the work grid, canonical identity or disk name. Existing Folder and share routes are unchanged.
2. `ManagedCreatorRoster` previously applied filters only on form submission. Five select changes now query immediately; name search debounces 300 ms, Enter/clear apply immediately, and IME composition is deferred. Request keys suppress duplicate requests, generation guards discard late results, and pagination retains the applied filters. Clicking pagination during a pending new search applies that search at page 1. Edit dialogs still require explicit saving.
3. Stage 1 previously read at most 100 metadata tasks and displayed only the first 20. A read-only projection of the existing creator-sync CTEs now forms the complete canonical Costuan source/task union before counting and pagination. Source-only records have no invented task ID, check time or round. Source state and latest task failure are displayed independently. UI pages contain 20 rows; loading, error and empty states are distinct. No new periodic polling is introduced.
4. Stage 3 treated null selection as an instruction to select the first creator. Null now explicitly means all collapsed. Summary-only requests omit creatorId, leveraging the existing backend's no-detail path. Only explicit expansion reads that creator's current page; stale responses cannot restore collapsed panels or populate a different creator. Removed creators collapse rather than falling back to the first. Existing active 10-second polling, hidden-page pause and execution locks remain unchanged.

## Read-only production evidence

Observed 2026-09-09, approximately 01:13–01:19 +08:00:

| Measure | Count |
|---|---:|
| Effective Costuan source creators | 38 |
| Effective Costuan source collections | 38 |
| Costuan metadata task creators | 21 |
| Source/task intersection | 20 |
| Source-only creators | 18 |
| Task-only creators | 1 |
| Union represented by Stage 1 | 39 |
| Task states | 20 completed, 1 not_found |

All current active Costuan collections have effective source works. Source counts reuse the existing active collection + active source-work + matching canonical owner rules. A retired HentaiClub seed is not a Costuan source. `38 - 21` is not a missing-task count.

Identity checks: creator 1 (瓜希酱) maps to gallery Folder **1101**, bridge **40**, slug `folder-14`, 113 active local works. The slug suffix is not a Folder ID. Creator 166 (lunana) maps to Folder **1** / bridge **8** (9 works) and Folder **2290** / bridge **1004** (41 works). Its existing preferred bridge remains 1004. No new link, preference or identity was written.

Protection check: migration 000017; 652 Jobs all ingested (16 nonempty warning summaries); 668 Download Tasks all ingested; 2387 active Local Works all matched; zero ambiguity. This is current queried data, not a product constant. The database hash snapshot is a closing baseline only: no matching pre-task row hash was captured, so it is not presented as a byte-for-byte before/after proof.

Main-worktree `CONTRIBUTING.md` remains unstaged-only, with no staged difference, and unchanged SHA-256 `125c9fe91b2831f7f7413b6d49617f1c88b5d6f8df5873265317584cdaaaf9dd`.

## Validation

- Fixed local Node 24.19.0. Commands directly invoke the installed tsc/vue-tsc/Vite/Vitest JS entrypoints with that executable. Node `--run build` could not resolve the Unicode workspace path on this host; no application was started and no runtime/configuration was changed. Equivalent package-script tools completed successfully.
- Server full suite: 93 files; 596 passed, 2 existing skipped. Includes migration, share scope/auth, local-ingest and source projection regression tests.
- Client full suite: 62 files, 398 passed; one subsequently added disappearing-creator regression passed separately (399 current cases). Client vue-tsc, server tsc and client Vite production build passed. Additional tests cover source/task pagination races and pending-search pagination.
- New projection tests include 107 rows across pages, same-name distinct IDs, multiple collections, source-only/task-only/failed-task combinations, read-only SQL and route authorization.
- Isolated Chromium fixture: `client/test/catalog-browser.mjs`, run from client with `BROWSER_NODE_MODULES` pointing to an installed Playwright package parent. Uses a separate local Vite server and temporary browser; **all API responses are synthetic**, external requests are blocked, and profile PATCH is consumed in memory. No production service/database or daily Chrome session is used. Screenshot artifacts remain outside Git.
- Browser checks exercise the actual Vue components: lazy directory modal/save/share with unchanged canonical URL; immediate roster filtering; Stage 1 page 2; Stage 3 summary-only collapsed state and explicit expansion. After collapse, manual refresh, active 10-second polling and completed-operation refresh all preserve collapse and issue zero additional creator detail requests. Six check groups passed with no page errors or unmatched API requests. Temporary screenshot/results directory: `foldergram-browser-bJhfZJ` under the host's temporary directory; not committed.
- Component tests cover multi-folder scope, cancel/no-write, route/grid/scroll preservation, stale requests, IME, deduplication, complete pagination and active/collapsed refresh behavior. Existing 500-media viewer/navigation tests remain in the full suite.

## Release boundary

One Ready PR only, with final Head Verify required. Do not merge or deploy in this task. Script/CostuanArchiveManager, production build artifacts, G-drive media, recycling, existing task rounds and the 19 known gaps are untouched. No real source check, download, extraction, ingest or retry was executed.
