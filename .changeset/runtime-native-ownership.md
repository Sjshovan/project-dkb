---
"@sjshovan/dkb-library": patch
"@sjshovan/dkb-runtime": patch
---

Replace Runtime PID/age-based ownership with shared query and exclusive mutation
leases on verified local storage. Reuse the Library native-locking primitive,
support overlapping readers with local writer fairness, retain native connections
through idle callbacks, and reject expired or read-only mutation authority.

Preserve earlier Runtime guards for explicit matching-version recovery instead
of deleting them. Bootstrap missing Runtime state only through validated mutation
admission. Reject Windows/Docker shared state before opening its database; keep
separate Runtime roots independent even when they serve the same Library.
