---
"@sjshovan/dkb-cli": patch
"@sjshovan/dkb-console": patch
"@sjshovan/dkb-registry-client": patch
---

Route signed DKB installation for Docker-owned Libraries through a fixed Linux
CLI worker. Keep Registry login credentials on the host; send only an exact-plan
download grant over private input. Retain Registry resolution precedence, signed
receipt verification, mutation rollback, progress and post-commit Runtime refresh.
Use an inspected anonymous Linux scratch volume and confirm owned-container
cleanup on cancellation without deleting the named Library volume.

Check available storage before downloading signed layers and preserve existing
files on failed admission. This check is not a cross-process disk reservation.
Forward the operator's Registry credential-file location into Console CLI
operations without forwarding its Registry bearer environment variable.

Docker Collection download, upgrade, verification, volume backup/restore and
migration remain explicit release gates; this does not complete that deployment.
