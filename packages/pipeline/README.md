# @dkb/pipeline

Provider contracts and per-context plugin hosting for DKB compilation and retrieval.

This package discovers only the providers selected by a Library or Registry compiler context. It owns configuration merging, middleware order, compatibility receipts, lifecycle, and disposal; it contains no concrete parser, embedder, index, or retrieval implementation.

See [ADR 0004](../../docs/decisions/0004-monorepo-release-units-and-local-stack.md).
