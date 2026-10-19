---
"@sjshovan/dkb-cli": patch
---

Delegate DKB and Collection uninstallation to the fixed Linux CLI for Docker-owned
Libraries. Preserve Collection dependency guards, editable source, progress and
recovery errors. Refresh associated Runtimes on the host after commit, deduplicate
an explicit reload endpoint, and report failed refreshes as stale warnings rather
than failed Library mutations. No Registry credential, network, Runtime volume or
host Library mount is granted to the offline worker.
