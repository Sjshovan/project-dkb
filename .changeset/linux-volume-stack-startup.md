---
"@sjshovan/dkb-cli": patch
"@sjshovan/dkb-pipeline": patch
"@sjshovan/dkb-distribution-default": patch
---

Route new public Stack startup through the Linux owner coordinator. Persist
labelled volume ownership before provisioning, fail closed on missing recorded
storage, and require explicit migration of existing host-mounted Stacks. Keep
live databases off shared Windows mounts. Register volume handles only after
activation acknowledgement, preserve credentials across restart, and derive
additional service storage from the injected distribution catalog. Add
`init --if-absent` to preserve existing Library configuration during startup.

Volume-backed backups and authenticated Registry package delegation remain
release gates; a host-folder archive is not accepted as a volume backup.
