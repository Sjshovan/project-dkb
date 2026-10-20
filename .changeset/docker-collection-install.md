---
"@sjshovan/dkb-cli": patch
"@sjshovan/dkb-runtime": patch
"@sjshovan/dkb-protocol": patch
---

Delegate Docker Library Collection install and explicit update through the
existing fixed Linux install worker. Send one exact immutable revision and one
scoped grant per member; keep reusable Registry login on the host. Adapt grant
downloads to the shared Collection installer so signature checks, direct-member
ownership, atomic rollback, retained-file verification and post-commit Runtime
refresh remain common to native CLI, Docker CLI and Console operations.

Reject mismatched worker protocol labels and malformed member grants before
mutation. On cancellation, confirm worker/scratch cleanup and name the preserved
Library's recovery command. This does not complete DKB upgrades, missing-build
acquisition, volume backup/restore or migration.
