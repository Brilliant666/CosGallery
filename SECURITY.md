# Security policy

CosGallery is maintained in this repository by [Brilliant666](https://github.com/Brilliant666), with upstream Foldergram attribution and AGPL-3.0 preserved. No invented security mailbox or response-time guarantee is provided.

Report suspected vulnerabilities privately using GitHub's **Report a vulnerability** action if available. If private reporting is unavailable, contact the repository owner through an existing private channel to arrange a confidential report. Do not put credentials, personal paths, media lists, database copies or an exploitable private-instance link in public issues.

Maintained code is the current main branch; Node support is defined in package.json and checked by the Node 22/24 CI matrix. Draft candidates are not released or automatically approved for production.

## Explicitly deferred H1 work

Administrator authentication defaults/enforcement, executable-path boundary changes, Host/Origin/Referer/CSRF/proxy changes, and development listener/file-exposure changes are **deferred by the user and not remediated** by this governance PR. Existing protections remain. Password write-only handling, response headers and error redaction do not resolve those boundaries.

Recovery points contain sensitive application data/configuration and possibly private keys. They are not a backup of original media or protection against loss of the entire disk. Current-file redaction does not erase Git history; suspected exposed credentials require a separate scoped response rather than a force-push by default.
