---
"@sjshovan/dkb-cli": patch
"@sjshovan/dkb-runtime": patch
"@sjshovan/dkb-library": patch
"@sjshovan/dkb-registry-client": patch
---

Prepare online Runtime Pipeline changes against an owner-generated state/profile
receipt. Acquire exact signed builds with per-package Registry grants without
opening Docker or remote Library databases on the host. Preserve Registry origins,
reject changed selections before downloads, distinguish missing from invalid
builds, and retain actionable Runtime conflict codes. Never forward untrusted
layer-download error bodies that may echo credentials.
