---
"@sjshovan/dkb-cli": patch
---

Check all recorded Stack volumes for consumers outside the Compose project before
treating storage as stopped. Reject incomplete host-only restoration of Docker
storage descriptors and preserve the original topology on failure. These checks
do not enable live volume backups or replace owner-side snapshot requirements.
