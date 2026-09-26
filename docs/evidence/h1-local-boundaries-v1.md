# H1 isolated candidate: local access and execution boundaries

This work starts from PR42 squash `037b2dfc75cdbf8d436a44958b6e3f21752d5102`. It is a separate Draft, not a claim that PR42 implemented H1 or that the candidate is deployed to a production instance.

| Boundary | Existing entry / problem | Legitimate use and minimal change | Verification |
| --- | --- | --- | --- |
| Administrator | Optional inherited password protection | Keep the existing Settings → Security and access switch. The user chose configuration instead of mandatory bootstrap. No default-auth behavior change or new setup CLI. | Existing auth regressions; synthetic configured-password HTTP session, CLI and scoped bridge tests. |
| 7-Zip | Web/DB settings could select the program used by validation and extraction | Startup-only `LOCAL_INGEST_SEVEN_ZIP_PATH`; web read-only display/validation. Ignore old DB program choice; reject a different submitted path before validation. Pin native local program identity/content for the process, no PATH lookup or shell wrappers. | Synthetic inert runner boundary cases, HTTP replacement rejection, existing encrypted synthetic archive ingestion/review/idempotency tests using the same pinned runner. |
| Host / origin | Request forwarding headers could influence source trust; invalid browser metadata could fall back to CLI | Exact Host list before all routes. No implicit proxy trust. Direct serving authority or explicit trusted origins; reject invalid/contradictory browser provenance. | Host, CSRF and real HTTP tests; preserve bridge socket/token scope, normal sessions and Node fetch CLI metadata. |
| Client Vite | Broad default listener and development filesystem scope | Loopback default, explicit LAN option, exact API/media proxy prefixes, client/dependency file allowlist and private-file denial. | Ephemeral synthetic sentinels only; encoded/raw/@fs/symlink paths denied, Vue/dependencies/font/HMR WebSocket/proxy still function. |

No real password is collected, read or rotated by these changes. Password write-only behavior, recovery-point protection, retired 410 deletion and Range semantics remain in place. No schema migration is added.

## Boundaries deliberately retained

- Optional authentication remains optional in code. Operators must enable the existing password switch; this is not a multi-account system or a public-deployment security certification.
- A trusted OS operator must install and select the native 7-Zip binary. Its name or header alone does not establish trust. Pinning detects changes between invocations; it does not defeat a hostile same-privilege OS process racing the executable or rewriting configuration/code.
- Browser source checks are not credentials. Non-browser CLI metadata remains supported, with intent and the existing downstream access controls. Extension bridge tokens do not authorize ordinary admin routes.
- Client Vite restrictions do not sandbox malicious build dependencies or all filesystem races. VitePress documentation development/preview remains outside this change; do not expose it assuming the client policy applies.
- No production switch, real ingestion, recovery, source relation change, media cleanup, additional repository cleanup or remote repository administration is part of this candidate.

## Evidence interpretation

Local full suites, focused boundary suites, GitHub Node22/24 Verify and paired isolated browser checks are separate evidence levels. Failed intermediate runs are not final acceptance. Per-head final results and the isolated runtime identity belong in the Draft description and local ignored handoff report, not a private-data fixture in Git.
