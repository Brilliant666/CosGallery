# Plugin display identity bridge

Publication scope: the read-only plugin identity bridge plus the Stage 2/3
presentation fixes. The identity API has not been activated in production.
Base: `513292fd52ddb7d27671c91d14f6c7a381672a5d`.
Companion plugin: CostuanArchiveManager v0.7.3, `codex/plugin-task-display-v1`.

## Contract

Metadata tasks optionally include `legacyIdentity: { source: 'hentaiclub',
sourceCreatorId: string } | null`. The ID is the exact persisted seed identity.
Current canonical names and aliases are not used as identity evidence.
The field is available on existing completed tasks as well as new task results;
there is no need to re-execute Stage1 to update plugin display.

Uniqueness is checked across every HentaiClub creator, including inactive records
and creators absent from task results. Because the old extension encoded seed IDs
with normalization, raw-different seeds whose old encoded IDs collide are also
rejected. List requests compute a single mapping per request, not per task, and
do not retain a stale cross-request cache. Missing/empty/conflicting seeds return
null. No schema migration or business-state write is introduced.

## Verification

- 16 new isolated identity tests; related test groups total 48 passing.
- Final full server suite: 91 files passing; 564 passing, 2 skipped, 0 failed.
- TypeScript noEmit and server production compilation passed.
- Diff whitespace check passed.
- Completed-task get/list tests compare SQLite total_changes before and after
  enrichment to confirm zero writes.

Tests used in-memory SQLite and Vitest's isolated temporary DATA_ROOT. No running
production service, production database, real archive, G-drive media or Recycle
Bin was operated. The original main worktree and its user's CONTRIBUTING.md edit
were not modified. No local migrations or deployment commands were run.

## Activation handoff

Publish/review the API and plugin branches as separate changes. The user has
already authorized an in-place local plugin v0.7.3 update; the companion API is
still pending activation. After deploying the API, refresh tasks only. Do not
rerun real Stage1/2/3 jobs to obtain display evidence. Without the optional field,
the plugin must keep legacy and canonical identities explicitly separate rather
than guessing a match from names.

## Stage 2/3 presentation fixes included in this branch

- Stage 3 running-state polling and manual refresh now fetch the existing
  summary-only jobs response even with all creator rows collapsed. Expanded
  creator details retain their page/filter. The ten-second interval, hidden-tab
  pause, idle stop and existing write locks remain unchanged.
- Stage 2 groups the existing bounded preview by canonical creator ID, initially
  collapsed. It retains API ordering and expansion across refreshes, renders
  all loaded rows on expansion rather than silently truncating at twenty, and
  explicitly labels per-group counts as preview-only. The existing maximum
  100-row request remains; this is not a full per-creator queue summary API.
- No changes to media-time sorting, task execution, planning, persistence or
  production schema. Prior user-authorized static deployments already serve
  these client fixes on 4141 without restarting the backend. Publishing this
  branch does not activate the pending identity API or run real tasks.
- Client validation: 59 files / 369 tests passed, including collapsed automatic
  and manual refresh, expanded pagination, same-name distinct creator IDs,
  greater-than-twenty previews, refresh preservation and empty results.
  Client typecheck, production build and diff checks passed.
