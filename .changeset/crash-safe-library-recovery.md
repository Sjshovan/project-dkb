---
"@sjshovan/dkb-library": patch
"@sjshovan/dkb-runtime": patch
"@sjshovan/dkb-cli": patch
---

Journal Library package and Collection mutations with a single SQLite commit
decision, exact-path recovery, and OS-managed ownership on verified local
storage. Fail closed on pending recovery and mutation/rollback races. Add
explicit `dkb library recover` with local Runtime refresh and structured
recovery guidance. Avoid rediscovering source folders during warm identity
reads while retaining exact activated-input and fresh recovery validation.

Stop older Library writers before upgrading the development locking protocol.
Sources and immutable compiled builds are preserved; this does not require
recompilation or claim power-loss durability.

Direct Windows/Docker shared database access is no longer supported. Docker
Libraries require Linux-local storage and owner-side management; this boundary
does not automatically migrate existing Libraries.
