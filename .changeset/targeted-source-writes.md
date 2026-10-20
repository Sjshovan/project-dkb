---
"@sjshovan/dkb-protocol": minor
"@sjshovan/dkb-library": minor
"@sjshovan/dkb-runtime": minor
---

Add explicit append/create/exclude path policy and local MCP write destination
discovery. Preserve exact byte prefixes with source-hash preconditions and retain
prior source/build revisions for exact citation fetch with original audit digests.
Search remains current-only. Legacy pathless append remains available only when
write.paths is absent; unsupported write constraints fail closed.
