---
"@sjshovan/dkb-protocol": patch
"@sjshovan/dkb-library": patch
"@sjshovan/dkb-registry-client": patch
"@sjshovan/dkb-runtime": patch
---

Validate immutable Registry Collection snapshots and every exact signed member
plan before downloads. Revalidate retained source, build artifacts, receipt
chains, origin-pinned trust, and the installed Collection on retries instead of
treating receipt-file presence as verification. Preserve Registry origins across
Library synchronization and retain the existing atomic Collection transaction
and process-death recovery behavior.
