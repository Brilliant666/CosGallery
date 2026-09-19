# Confirmed work-level sort time

Migration 000023 adds a minimal confirmation table, not data corrections.
No creator, work or private file identity is embedded in the migration.
Fresh databases use the identical schema fragment.

Each confirmation records a unique decision key, stable Work ID, original
primary LocalWork/Post evidence, original and adopted timestamps, evidence JSON,
confirmation source, state and recording time. Timestamps are finite positive
JavaScript milliseconds; fractional milliseconds are preserved in SQLite REAL.
There can be only one confirmed value per Work. Revoked evidence remains stored.

The catalog builder and canonical creator gallery query use the confirmed value
with the original Post timestamp as fallback. Gallery SQL sorts before
LIMIT/OFFSET and returns the effective time in its summary; the canonical detail
projection uses the same value. Member Image/Post evidence, media order,
fulfillment version snapshots and acquisition history are never rewritten.
The legacy source-path LocalWork-to-Post mapping is retained. An ambiguous
selected Post is refused by the application command, not silently repaired.

Only the creator owning a changed confirmation is marked dirty in the same
transaction. Its catalog Worker republishes normal complete versions. Identical
replay issues no writes and does not increment the generation. Normal page reads
do not read filesystem creation metadata.

## Explicit maintenance application

After the ordinary migration has completed, use the compiled command with two
explicit absolute paths:

```text
node server/dist/scripts/confirmed-work-sort-time.js apply <existing-database.sqlite> <confirmed-plan.json>
```

The command does not load .env, initialize/migrate a database, start any service,
scan media or accept versions. It refuses a missing database. The caller is
responsible for choosing the authorized database; this task applies only to the
isolated preview database.

Plan structure (synthetic illustration, never production IDs):

```json
{
  "confirmed": true,
  "decisions": [{
    "decisionKey": "synthetic-review-1",
    "creatorId": 1,
    "workId": 1,
    "primaryLocalWorkId": 1,
    "primaryPostId": 1,
    "originalTimestamp": 1000,
    "adoptedTimestamp": 2000.25,
    "evidence": {
      "basis": "original-media-birthtime-max",
      "mediaCount": 2,
      "minimum": 1990.5,
      "maximum": 2000.25
    },
    "confirmationSource": "explicit user instruction"
  }]
}
```

All decisions apply atomically. Identity, current primary and original time are
checked against the current catalog facts before inserting. The same key and
same payload replay without mutation; changed or revoked keys fail, as does
trying to replace an active confirmation with another key. No generic force
option bypasses these checks. A future correction requires explicit revocation
and a fresh evidence decision, not editing the original evidence in place.

Filesystem birthtime is a sorting fact, not proof of a shoot/publication date.
Capture every eligible original media member at its original location first;
do not substitute copied-file creation time or silently fall back to mtime.
Private paths and per-file evidence belong in local ignored reports only.

The existing numbering tie-break and independent display directions remain:
number the full creator collection oldest first, then filter/page/reverse.
Other Work timestamps are untouched even when their NO shifts.
