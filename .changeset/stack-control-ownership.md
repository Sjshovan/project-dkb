---
"@sjshovan/dkb-cli": patch
"@sjshovan/dkb-library": patch
---

Use a host-local native Stack control lease outside replaceable Stack data for
preparation, startup, stop, backup, restore, and upgrade. Preserve earlier startup
guards instead of guessing ownership from PID or age. Reject incomplete
host-folder backups and failed Docker status checks, and remove implicit
Library relocation during Stack preparation. Reject linked archive entries
through normal error handling without crashing or promoting a partial backup.
Knowledge extraction and release-package inspection likewise return malformed
archive failures to their callers so staging cleanup completes.
