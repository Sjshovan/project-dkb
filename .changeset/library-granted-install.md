---
"@sjshovan/dkb-runtime": patch
---

Share exact-plan, grant-only signed installation between Runtime and standalone
Library destinations. Preserve the canonical Registry origin independently of
the transport endpoint, reject malformed grant envelopes before initialization,
and never inherit host bearer credentials. Library installation does not create
or activate Runtime state. The CLI connects this through its separate fixed,
grant-only Docker owner worker; ordinary offline workers remain network-disabled.

Require retained Evidence and Retrieval Build identities to match the newly
requested signed install plan, even when an older signed build uses the same
recipe. A missing child build cannot be reported as already installed.
