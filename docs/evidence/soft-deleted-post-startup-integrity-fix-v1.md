# Soft-deleted Post startup integrity fix V1

## Scope

- The representative-item invariant now applies only to active (`is_deleted = 0`) Posts.
- Empty soft-deleted Posts remain valid retirement records.
- Trashed active Posts are not excluded.
- Existing item ordering, post type/cardinality, unique-index, foreign-key, and SQLite integrity checks remain enabled.
- No migration or schema version was added.

## Reproduction and regression

Before the query change, the expanded migration suite reproduced three failures:

- an empty soft-deleted Post was rejected;
- malformed retained members were intercepted by the wrong earlier condition;
- a database produced by the real creator topology reconciler could not be reopened through startup migrations.

After the query change, the migration suite passed all 26 tests. Coverage includes active and trashed Posts with and without a representative item, a position-2-only Post, an empty soft-deleted Post, malformed retained members, foreign-key corruption, and reopening the database twice after a real legacy-Post split.

## Independent process evidence

Using built server output and one synthetic topology fixture:

- the previous main build exited with the representative-item integrity error;
- the patched build started twice in independent Node processes and returned Health 200;
- both gallery and LocalIngest startup scans were skipped;
- Post, post item, image, and LocalIngest rows remained unchanged;
- a separate active-empty-Post copy was still rejected.

The current post-topology production database was copied with SQLite's backup API and tested separately. The patched build started that copy twice, returned Health 200 both times, skipped both startup scans, kept migration `000016` and Scan Run `639`, and changed no database table hashes.

## Verification

- Server: 83 test files passed; 495 tests passed, 2 skipped.
- Client: 53 test files passed; 303 tests passed.
- Server TypeScript build: passed.
- Client type check and production build: passed.
- Temporary migrations: up, down, re-up, and repeated no-op up passed.
- Production database and real gallery files were not modified during development verification.
