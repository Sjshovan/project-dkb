# DKB Libraries And Collections

## TL;DR

- A **Library** is the one local knowledge environment served by one Runtime.
- A **Registry** is the remote package service a Library publishes to and installs from.
- A Library contains editable DKBs and Collections as direct child folders.
- Registry downloads live only at `vendor/@namespace/name`.
- A Collection is a namespaced dependency bundle. A published revision is an immutable Registry snapshot of exact DKB versions and digests.
- `dkb.json` declares desired roots, `dkb-lock.json` records exact resolution, and `.dkb/state.sqlite` records applied state. A folder existing on disk does not make it installed.

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
│       └── .dkb/artifacts/      # compiled release
└── .dkb/                        # applied-state DB, aggregate indexes, staging
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

A successful install refreshes the Library integrity lock and aggregate artifact
manifest from those already-compiled package artifacts; it does not parse,
chunk, or embed their sources again. Any failed activation restores the prior
manifest, lock, ledger, vendor paths, retrieval profile, and aggregate artifacts
byte for byte.

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

`.dkb/state.sqlite` is the deterministic applied-state ledger used for status and recovery. DKB regenerates it from the promoted lock during an atomic mutation. These layers answer different questions:

- folder exists: bytes are present;
- manifest root exists: entry is desired;
- lock entry exists: exact dependency resolution was committed;
- ledger status is `installed`: the committed content is present and usable;
- ledger status is `broken`: committed content is missing or invalid;
- no lock entry: content is inactive or untracked, even if a folder exists.

Moving folders by hand never rewrites dependency intent. Use `dkb library add`, `dkb library remove`, `dkb install`, `dkb collection update`, or `dkb uninstall` so manifest, lock, ledger, aggregate catalog, and query snapshot change together.

## Runtime And Portability Boundary

One Runtime serves one Library. All active DKBs in that Library must use the same retrieval profile: parser, chunker, embedding model, dimensions, metric, compiler, and relevant versions. An incompatible release is verified but rejected before activation, and the previous Library remains unchanged.

Original sources and embedding-free Evidence IR are portable. Vectors, FAISS segments, profile-specific chunks, and aggregate indexes are compiled artifacts. A compatible DKB Runtime installs them without recompilation. Another RAG system may ingest the source or Evidence IR using its own pipeline; it is not expected to consume DKB's profile-bound FAISS data.

The remote HTTP MCP is intentionally read-only and exposes only `search` and `fetch`. Installing, updating, and uninstalling knowledge remain operator-controlled CLI actions.
