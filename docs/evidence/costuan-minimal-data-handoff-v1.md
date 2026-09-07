# Costuan minimal data handoff V1

## Scope and findings

Base: `e0344cbd448050934354aa334e08a262e55b242b`; paired Script base `a22d64255325fb60d0cae158560763ddb79ad98b` (0.7.0), patch 0.7.1. This is an isolated code handoff verification, not production acquisition or activation.

The existing chain is retained:

`FirstCollectionSelector / roster detail -> planSelected -> fixed taskIds -> startMetadataCollection -> startQueue -> content.js -> validateSource / complete (receipt) -> finalize-selected -> refreshAfterMetadataTasks -> planMissing -> existing Stage2 -> user download -> existing Stage3 destination resolver / commit / scoped scanner / reconciliation`.

The explicit selector already admits creators with no local work or imported extension roster. Local-only automatic planning remains local-only. Canonical IDs, NO/VOL source identities, receipt replay, preferred directories and first-commit folder creation already work; they are not reimplemented. The extension's `content.js` is unchanged even between the stable 0.6.10 commit `84a95ff` and current main, and remains unchanged in the paired patch.

One server defect was confirmed: source finalization with no active local bridges called missing-work planning without checking whether the gallery was available or historical bridges were inactive. Unknown local state could therefore be treated as an empty set. The patch checks only this handoff: readable safe gallery root, usable same-root bridges and unbridged matching directories. A genuine absent or empty creator directory can mean zero works; a nonempty/unreadable/unconfirmed directory cannot. Source acquisition and accepted receipts are not rolled back or gated on having local works. Existing scoped reconciliation and missing-task planning still do the work, with no schema change or global scan.

The paired extension aligns single/array Stage2 occupancy, explains the blocker beside the button, preserves outstanding claims/receipts and distinguishes recent connection checks from historical synchronization time. It retains the original executor and checks that its internal continuation owns the just-claimed batch rather than treating that batch as a pre-claim conflict.

## Production read-only baseline

At this task's start, metadata task 32 belonged to creator 154, was `pending`, unclaimed, attempt count 0, with no error. It is not LocalIngestJob 32. The baseline was taken after this task was created: 18 metadata tasks, 588 ingest jobs, 2323 active local works; migration 000017, quick_check ok and foreign_key_check empty. Full table hashes and the original CONTRIBUTING content/staged state are kept in ignored local evidence, not committed.

The original Chrome extension is not readable through the permitted tool surface. Its actual queue origin/status, Stage2 occupancy and outstanding receipt state are unconfirmed. Synthetic failures are not presented as the real task32 button root cause. No production claim, replacement task, extension reload, database business write, scan, cloud action, G-drive change or Recycle Bin action is authorized or performed.

## Validation

- Server: 90 files / 550 tests passed, including added 3-0 / 3-1 / 3-3 scoped differences, existing pending-task reuse, empty directory, offline root, inaccessible directory, inactive historical bridge, populated unbridged directory and cross-creator alias isolation. Server typecheck and build passed.
- Client is unchanged. Shared selection / roster / ledger regressions: 34 tests passed; standard `vue-tsc --noEmit -p tsconfig.build.json` and Vite production build passed in the worktree. An initial nonstandard `tsconfig.json` invocation included existing test-type errors; it was corrected to the repository's existing build command, without changing those unrelated files. Existing large-chunk warning remains.
- Paired extension: 61 tests passed, zero skipped, with the existing local Costuan/Baidu DOM fixtures plus historical state, duplicate click, late claim, owner checks and visible blocker feedback. Syntax/version/diff checks passed.
- Cross-repository fixture on loopback 4473: actual Vue selection and cancellation -> fixed task -> extension with no historical roster -> existing page executor -> actual temporary server receipt -> creator-scoped difference -> exact Stage2 copy. One simulated save, two identical receipt submissions after a deliberately lost success response, two source works, no duplicate source/task. Only 001.7z and 002.7z copied; external fixture requests and page errors both zero.
- A tiny encrypted two-layer 7z was then processed by the existing Stage3 HTTP run endpoint, real scanner and scoped reconciliation (not a stubbed index). One JPEG was retained; synthetic TXT advertisement handled by existing rules. One canonical first directory and matched local work created, rating R18 retained. Job 1 finished ingested/done/passed/recycled, attempt 1. Only simulated recycle inside the temp fixture was used, never Windows Recycle Bin.
- First work ingested; second remains staged. Seven unrelated creator-scoped table hashes unchanged. Repeated discovery did not rerun the job; repeated selection returned source_ready. Separate Node restart kept rows and scan runs unchanged, skipped both startup scan paths, and loaded the actual synthetic work thumbnail.

## Reproduction and remaining boundary

Reuse `server/test/fixtures/roster-first-runtime.mjs` and `roster-first-browser.cjs` with an OS-temp `cosgallery-roster-e2e-*` root, explicit Node24 and all five isolated storage paths. Use paired Script `tests/helpers/page-fixtures.cjs`, installed Playwright and the existing 7z binary; phases select/plugin/ingest/restart. Temporary credentials and snapshots stay outside Git. Production 4141 is not used by these fixtures.

Two small linked PRs are published because there are two actual defects; neither is merged or deployed. After separate merge/activation authorization, the user can refresh the existing task32 scope and use the same execution button. If a genuine old batch owns execution, its exact displayed owner/reason must be resolved by the user rather than silently cleared or resumed. The real first-collection chain and the real disabled-button cause remain unverified.
