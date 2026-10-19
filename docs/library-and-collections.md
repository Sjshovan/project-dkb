# DKB Libraries And Collections

## TL;DR

- A **Library** owns installed knowledge and immutable builds. Any number of independently configured Runtimes may serve it.
- A **Registry** is a package source. A Library may install from multiple Registries and retains each release's exact origin.
- A Library contains editable DKBs and Collections as direct child folders.
- Registry downloads live only at `vendor/@namespace/name`.
- A Collection is a namespaced dependency bundle. A published revision is an immutable Registry snapshot of exact DKB versions and digests.
- `dkb.json` declares desired roots, `dkb-lock.json` records exact resolution, and `.dkb/state.sqlite` records applied state. A folder existing on disk does not make it installed.
- `~/.dkb/host.json` remembers Library, Registry, and Runtime shortcuts for one machine; it is disposable and never authoritative.

## Host-local context

A host may know many Libraries, Registry endpoints, and Runtime endpoints. The
CLI catalogs only resources that an operator initialized, registered, or used;
it never scans disks or networks. Use `dkb library list`, `dkb registry list`,
and `dkb runtime list` from any directory. `--check` is required before Registry
or Runtime list commands make network requests.

One Runtime still serves one Library. Naming multiple items in the host
inventory does not combine Libraries or make a Runtime serve multiple roots.
The inventory simply lets an operator select defaults:

```text
dkb library use personal
dkb runtime use home
dkb registry use team
```

Library-bound commands prefer an explicit Library, environment override, and
nearest Library before the selected default. Removing a host entry forgets the
shortcut only; it never deletes knowledge or stops a service. See
[`decisions/0003-host-inventory-and-context-selection.md`](decisions/0003-host-inventory-and-context-selection.md).

## Layout

```text
my-library/
├── dkb.json
├── dkb-lock.json
├── assembly-toolbox/
│   └── dkb.json                 # type: collection
├── assembly-core/
│   ├── dkb.json                 # type: dkb
│   └── ...source files
├── internal-handbook/
│   ├── dkb.json                 # type: dkb
│   └── ...source files
├── vendor/
│   └── @vendor/reference/
│       ├── dkb.json             # Registry-managed DKB
│       ├── .dkb-package.json    # signed release receipt
│       └── .dkb/builds/         # immutable Evidence/Retrieval Builds
└── .dkb/                        # applied state, Library locks, staging, plugins
```

Discovery is deliberately flat. Only direct child folders are editable Library entries. DKB never recursively searches arbitrary folder trees for manifests, and it never treats `vendor/` as authoring source.

## Manifest Kinds

The same `dkb.json` filename is used for all three kinds. Its `type` is authoritative.

Library:

```json
{
  "manifestVersion": 1,
  "type": "library",
  "name": "My Knowledge Library",
  "roots": {
    "@sjshovan/assembly-toolbox": { "revision": 3 },
    "@sjshovan/internal-handbook": { "path": "internal-handbook" }
  },
  "registry": { "url": "https://registry.example" }
}
```

DKB:

```json
{
  "type": "dkb",
  "name": "@sjshovan/assembly-core",
  "version": "1.3.0"
}
```

Collection:

```json
{
  "type": "collection",
  "name": "@sjshovan/assembly-toolbox",
  "members": {
    "@sjshovan/assembly-core": "1.3.0",
    "@vendor/reference": "latest"
  }
}
```

DKB and Collection identities are lowercase `@namespace/name` values. DKB versions are exact semantic versions. Editable Collections may use an exact version or `latest`; the Registry resolves `latest` when publishing and stores only exact versions and release digests in the immutable revision.

## Authoring Workflow

```text
dkb init --registry-url https://registry.example
dkb init @sjshovan/assembly-core
dkb collection create @sjshovan/assembly-toolbox
dkb collection add @sjshovan/assembly-toolbox @sjshovan/assembly-core --version 1.3.0
dkb collection show @sjshovan/assembly-toolbox
dkb collection publish ./assembly-toolbox
```

Publishing a Collection verifies every dependency first. A missing DKB in the publisher's own namespace may be published from a valid editable child DKB before the Collection revision is created. A missing foreign dependency is an error. The Registry never publishes a Collection revision until every exact member release exists.

## Install, Update, And Uninstall

```text
dkb install @sjshovan/assembly-toolbox --revision 3
dkb list
dkb library status
dkb collection update @sjshovan/assembly-toolbox
dkb uninstall @sjshovan/assembly-toolbox
```

Install resolves the Collection revision before downloading anything. It rejects duplicate members, digest drift, and version conflicts before mutation. Every archive is downloaded, hash-checked, signature-checked, retrieval-profile-checked, and staged before final activation.

The Collection itself is a digest-bound Registry snapshot, not a signed DKB
build. Its sorted exact member releases must match the requested revision and
the Registry's existing snapshot digest, including Unicode display names.
Each member's full source → Evidence → Retrieval receipt chain is verified
before any member download. An unsigned release-list response or the presence
of a receipt file is never enough to admit a member.

Retries and shared-member reuse verify the retained source bytes, exact build
artifacts, receipt chain, and origin-pinned keys. A damaged retained package
fails closed; it is not silently replaced as part of another Collection's
installation. Missing requested build variants must be acquired and verified
before reuse. Collection updates still commit as one Library mutation: failure
on a later member restores earlier promoted members and the previous logical
state. An unchanged release retains its original Registry URL across sync,
even when the Library default points elsewhere.

For a Docker-owned Library, add `--library <registered-name>` to these same
commands. The host uses its saved Registry login only to obtain the exact
revision and member download grants. One fixed Linux CLI worker runs the shared
installer; Windows never opens the Library database. Login credentials and host
paths are not sent into the worker. Cancelled operations preserve the Library
and report `dkb library recover --library <registered-name>` when needed.

A successful install updates the Library's exact logical lock and applied
ledger using already-compiled package builds. It does not parse, chunk, or
embed their sources again. Runtime refresh is a separate operation: a failed
refresh leaves that Runtime stale, not the Library partially installed.
There is no Library-wide active artifact mirror or active retrieval profile.

[ADR 0012](decisions/0012-crash-safe-library-mutations.md) specifies the durable
Library recovery boundary and its process-death acceptance gate. Do not infer
crash safety from catch-handler rollback alone. Unresolved recovery must block
installed-state reads and retrieval; it is not permission to reinstall over
backups or delete lock files.

A Library permits one installed version of a DKB identity. Dependency ownership is reference-counted through `requiredBy` entries:

```text
@sjshovan/assembly-toolbox
├── @sjshovan/assembly-core@1.3.0
└── @vendor/reference@2.4.1
```

If two Collections require the same identity, version, and digest, one installed DKB is shared. Uninstalling either Collection removes only its ownership edge. The DKB is pruned only after no root or Collection requires it.

If Collection A requires `@vendor/reference@2.4.1` and Collection B requires `@vendor/reference@2.5.0`, installing or updating B fails atomically. DKB does not install two versions of the same identity into one Library and does not choose a winner silently.

## Lock And Applied State

`dkb.json` is the editable desired state. `dkb-lock.json` is the human-auditable exact resolution. It records identity, kind, source (`local` or `registry`), exact version or revision, digest, path, Registry URL, ownership edges, and install time.

`.dkb/state.sqlite` is the authoritative applied-state ledger used for status and recovery. The logical lock and ledger must agree after a completed mutation; the presence of a newly written lock alone is not proof that the database committed. These layers answer different questions:

- folder exists: bytes are present;
- manifest root exists: entry is desired;
- lock entry exists: exact dependency resolution was committed;
- ledger status is `installed`: the committed content is present and usable;
- ledger status is `broken`: committed content is missing or invalid;
- no lock entry: content is inactive or untracked, even if a folder exists.

Moving folders by hand never rewrites dependency intent. Use `dkb library add`, `dkb library remove`, `dkb install`, `dkb collection update`, or `dkb uninstall` to update desired and applied Library state together. Each serving Runtime then refreshes its own activation; stale Runtimes must refuse queries.

## Runtime And Portability Boundary

One Runtime serves one Library and selects one Pipeline. Every build in that
Runtime's activation must match the resolved Evidence Profile and retrieval
compatibility space: embedding space, dimensions, metric, normalization, index
format, and evidence protocol. Another Runtime may serve the same Library
through a different Pipeline and immutable build chain. An incompatible build
is rejected before activation; the previous Runtime selection remains intact.

Original sources and embedding-free Evidence IR are portable. Evidence Builds
store interpreted records and provenance; Retrieval Builds store vectors and
provider-specific indexes. A compatible DKB Runtime opens the installed builds
without recompilation. Another RAG system may ingest the source or Evidence IR
using its own pipeline; it is not expected to consume DKB's profile-bound index
bytes.

The remote HTTP MCP is intentionally read-only and exposes only `search` and `fetch`. Installing, updating, and uninstalling knowledge remain operator-controlled CLI actions.
