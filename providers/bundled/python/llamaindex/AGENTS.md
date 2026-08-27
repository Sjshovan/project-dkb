# LlamaIndex Compiler Guidance

These rules extend the repository-level `AGENTS.md` for the Python/Docker
provider-side compiler implementation in `providers/bundled/python/llamaindex/`.

## Compiler Contract

- The compiler converts staged source into deterministic, provenance-bearing
  records and retrieval-profile-specific artifacts. It does not define DKB
  package identity or registry policy.
- Rich filesystem formats route through Docling. Plain text, Markdown, CSV, and
  database sources stay on their documented LlamaIndex paths.
- Every output record preserves package/version, source identity, locator,
  source hash, chunk boundaries, compiler metadata, and embedding profile.
- FastEmbed document vectors and runtime query vectors must use the same model,
  dimensions, normalization, and metric recorded in the profile lock.
- Warm service and one-shot container modes must produce contract-compatible
  output. GPU support is an execution variant, not a different artifact format.

## Source And Failure Safety

- Never move or mutate caller source. Compile isolated staged copies.
- Exclude generated DKB state, vendor dependencies, caches, and temporary files
  from source compilation.
- Make Docling fallback visible in record metadata. With fallback disabled,
  fail before artifact promotion.
- Pin dependency and image changes deliberately. Do not upgrade parser,
  tokenizer, embedding, or ONNX behavior without recording profile/compiler
  drift and testing representative source formats.
- Return explicit errors and preserve the previous complete artifact on failure.

## Verification

Exercise Markdown, CSV, PDF or another Docling-rich format, and SQLite when
changing routing, chunking, provenance, or dependencies. Verify stable evidence
identity, profile metadata, no vendor ingestion, and equivalent warm/one-shot
output before handoff.
