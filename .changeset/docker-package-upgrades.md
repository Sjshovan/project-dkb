---
"@sjshovan/dkb-cli": patch
"@sjshovan/dkb-runtime": patch
---

Route Docker Library outdated checks and package upgrades through the existing
owner CLI and signed grant installer. Preserve the installed Registry origin,
report dry-run plans without downloading, and reject stale upgrade plans under
the Library writer lease. The private DKB install worker protocol is now v2;
operators must select a matching rebuilt CLI image.
