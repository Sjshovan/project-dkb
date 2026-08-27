# @dkb/protocol

Stable, implementation-neutral contracts for DKB manifests, identities,
canonical JSON, Evidence IR, validation, paths, capabilities, and source-safety
handling.

Consumers import public subpaths such as `@dkb/protocol/manifest.js` and
`@dkb/protocol/evidence/ir.js`. This package does not depend on the CLI,
Library, pipeline, providers, compiler, Runtime, or Registry client.

The package version follows the DKB protocol version. It is intentionally
independent of developer-preview implementation package versions.
