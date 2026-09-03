# Lexical Pipeline Example

This directory owns a complete operator plugin, not a bundled default or core
search engine. Its authority is the [public SDK](../../docs/plugin-authoring.md).

- Import only declared dependencies and exported SDK contracts. Keep indexing
  and ranking in MiniSearch; DKB owns evidence identities, citations, activation,
  and audit.
- Parser output preserves source bytes' hashes. Chunk spans and source anchors
  are explicit provenance, never inferred from custom metadata.
- Keep the example independent of Docker, embeddings, Registry credentials, and
  default target changes. Knowledge packages must never contain this code.
- Honor cancellation and deterministic build output; keep memory limits and
  unsupported formats explicit in the README.
- Run `node node_modules/typescript/bin/tsc -p examples/lexical-pipeline/tsconfig.json`
  and `node --import ./tests/test-environment.mjs --test tests/lexical-pipeline-example.test.mjs`
  from the repository root after building the SDK.
