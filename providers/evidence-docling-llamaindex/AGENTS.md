# Docling and LlamaIndex Evidence Provider Guidance

This package owns the `@dkb/evidence-docling-llamaindex` Evidence provider and its isolated Python parser/chunker worker. It implements Pipeline Evidence contracts and may depend only on Protocol, Pipeline, and Node APIs.

Keep source parsing, Docling conversion, LlamaIndex chunking, Evidence-stage batching, lifecycle, and extraction provenance here. It must return embedding-free records. Do not add embedding models, FAISS, managed indexes, retrieval ranking, Runtime, Registry, Library, or CLI dependencies to this package or image.

Verify with `npm run check --workspace @sjshovan/dkb-evidence-docling-llamaindex`, Python format tests, and a representative Evidence compile. See [the canonical architecture](../../docs/architecture/final-provider-architecture.md).

The Linux PID-1 supervisor owns a persistent warm child. A cancelled HTTP await
does not stop parsing threads: terminate and reap owned processes, replace IPC,
and acknowledge the exact job/token only after writes stop. Preserve private
recovery state on uncertainty. Run the worker-control tests in Linux and verify
both warm success and actual in-flight cancellation before changing this boundary.
