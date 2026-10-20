---
"@sjshovan/dkb-cli": patch
---

Prepare Stack recipe configuration in the Linux owner using the same image-identity
rules as native preparation. Keep a bounded owner-local recovery journal before
changing either configuration file, bind settlement to the exact storage scope,
preserve concurrent operator edits and activations, and retain committed Runtime
state when a caller loses its response. Persist a bounded completion receipt
before removing the recovery journal so a lost acknowledgement can be checked
without repeating mutation or guessing from a missing journal. Reject receipt
replay after configuration, activation or storage drift. Configuration operations never write an
activation or copy a database. The separate Linux-volume startup change connects
this coordinator to public Stack startup.

Cancel an undispatched host plan only after revalidating its exact owner observation.
Persist an acknowledgement that rejects delayed preparation, reuses normal recovery
if preparation already arrived, and preserves any activation that already committed.

Persist the host startup plan before owner dispatch and settle interrupted startup
against the verified Linux outcome. Retain recovery through partial host registration
or failed service restoration; reject changed topology and Compose definitions.
The coordinator never copies Runtime activation or Library data and never replays
activation during recovery. Volume-backed backup/restore remains a release gate.

Reject redirected host Stack directories before startup or recovery and recheck
after service and registration callbacks, preserving the recovery record rather
than following links into unrelated files.

Initialize the first Runtime binding through the fixed Linux owner worker using
Runtime's existing atomic writer. Retry a lost response without replacing an
existing selection, reject foreign Runtime identities and pending recovery, and
preserve Library/default configuration. This prerequisite does not activate a
Runtime or complete the public volume-backed Stack deployment.
