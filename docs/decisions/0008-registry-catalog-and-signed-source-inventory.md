# 0008 - Registry Catalog And Signed Source Inventory

- **Status:** Accepted
- **Date:** 2026-08-30

## Decision

Registry browsing is a read-only host operation exposed through the same CLI
control plane as package installation. `dkb search` lists both DKBs and
Collections and can use an explicit Registry URL without a Library. `dkb
registry show` inspects an exact remote DKB version or Collection revision.
Top-level `dkb show` remains installed-only.

The Console calls only those typed CLI commands. Registry credentials remain in
the host credential store and never reach browser code. Installation always
names an exact release, target, Library, and Registry. The Console rejects a
Library whose registered upstream differs from the selected Registry; changing
that upstream is a separate, explicit Connect Library operation.

The trusted initial compiler pass emits `dkb.source-inventory.v1`, a sorted list
of portable source paths, byte sizes, and SHA-256 hashes. It excludes `.dkb`,
plugins, configuration, credentials, and generated state. The Registry stores
the inventory separately from build layers and binds its digest, size, and
entry count into the signed source receipt. Alternate Retrieval Builds reuse
the same source inventory.

Remote Contents are bounded metadata only, with at most 200 entries per page
and an opaque continuation cursor bound to the inventory digest and path. File
bodies are available only after installation through the existing inert local
preview. This keeps catalog browsing safe and cheap without making the Registry
a source-code hosting surface.

## Consequences

Public catalog entries remain anonymously visible; saved credentials add
authorized private and unlisted entries. Package provenance can be inspected
before download, and a modified inventory or receipt reference is rejected.
Historical package releases remain immutable. No new database table or browser
credential path is introduced.
