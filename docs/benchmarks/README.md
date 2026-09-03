# Bounded Benchmarks

These are dated measurements, not certification of the current working tree.
The Plugin API v3 milestone still requires fresh full-compilation and warm
audited Runtime-query comparisons against a compatible baseline, with no more
than a 10% regression. See the [current system map](../architecture/system-map.md).

## Corpus scale

These reports exercise the real default `tei-faiss` ingestion, embedding, and
index path with deterministic mixed prose, Markdown tables, and code. Generated
corpora live only in a DKB-prefixed temporary directory and are removed after
each run.

Run the bounded smoke tier:

```powershell
npm.cmd run benchmark:scale
```

Select additional tiers only when the prior result is acceptable:

```powershell
$env:DKB_SCALE_TIERS = 'small,medium'
npm.cmd run benchmark:scale
```

The harness stops before a tier whose linear projection exceeds 15 minutes or
whose initial working-set estimate exceeds 8 GiB. The compiler independently
checks actual free space before ingestion and again after Evidence IR exists.

Interpret source files as descriptive only. `evidenceRecords`,
`evidenceTextBytes`, `recordsPerSource`, and `textBytesPerRecord` describe the
work the retrieval build actually performs. `sourceToDerivedRatio` counts each
immutable Evidence and Retrieval Build directory once. `artifactBytes` is a
diagnostic subset of the Retrieval Build and is never added to the total a
second time.

## Provider hard-cutover result

The deterministic 1 MiB `small` corpus was rerun after the immutable-build
storage cutover. Both reports use the same 24 generated source files, 1,062,058
source bytes, 682 Evidence records, and `tei-faiss` target.

| Measurement | 2026-08-28 baseline | 2026-08-29 cutover | Change |
|---|---:|---:|---:|
| Wall time | 207.02 s | 167.81 s | 18.9% faster |
| Total derived bytes | 32,682,857 | 6,602,142 | 79.8% smaller |
| Retrieval artifact files | 10 | 3 | 70.0% fewer |

That dated comparison passed the storage-cutover gates: compile time did not regress and
removing the duplicate active artifact architecture reduced derived storage by
more than the required 35%. The current total was recalculated from the stored
Evidence and Retrieval Build byte counts after correcting an artifact-subset
double count. See
[`corpus-scale-small-2026-08-29.json`](corpus-scale-small-2026-08-29.json) for
the complete receipt.

The hardened real-corpus proof passed on 2026-08-30 using a sanitized
real-project architecture slice: 102 files, 989,281 source bytes, and three
credential-bearing files rejected before staging. The signed Registry install
retrieved all three known answers, MCP search/fetch resolved the same evidence,
uninstall removed the evidence immediately, and reinstall restored it without
compilation. No real-corpus source or compiled artifact is retained in Git.

A fresh bounded scale confirmation on 2026-08-30 produced:

| Tier | Source bytes | Evidence records | Wall time | Derived bytes | Expansion |
|---|---:|---:|---:|---:|---:|
| smoke | 136,870 | 88 | 33.99 s | 898,289 | 6.563x |
| small | 1,062,058 | 682 | 152.60 s | 6,601,888 | 6.216x |

The next 8 MiB tier was skipped before materialization because its
1,205,317 ms linear projection exceeded the 15-minute guardrail. The generated
corpus and its services were removed after the run.

## Historical embedding component comparison

The recorded 2026-08-30 component run reused one byte-identical 176-record Evidence
Build from 32 sanitized files (232,937 source bytes) and compared only
Retrieval compilation and query embedding. It did **not** measure complete
source ingestion/compilation, an audited Runtime query, or the combined memory
of every compiler/provider service. The earlier claim that this passed every
default-promotion gate was not supported by that measurement scope.

| Measurement | FastEmbed + FAISS | TEI + FAISS | TEI change |
|---|---:|---:|---:|
| Fresh Retrieval-build median | 168.01 s | 67.77 s | 59.7% lower |
| Two-job median throughput | 1.626 records/s | 3.001 records/s | 84.6% higher |
| Query-embedding latency p50 | 789.00 ms | 546.99 ms | 30.7% lower |
| Sampled Node + embedder memory | 2.495 GiB | 0.776 GiB | 68.9% lower |

The benchmark used three cold, fresh, cached, and concurrent samples for each
provider plus 20 query-embedding samples. TEI remains the configured distribution
default; that setting is not proof that the complete performance, resource,
correctness, or security acceptance gates passed. FastEmbed remains bundled as
a separate selectable embedding space. The
checked-in
[`embedding-providers-2026-08-29.json`](embedding-providers-2026-08-29.json)
retains the preceding raw component report, unchanged. Its historical
`eligibleForDefaultPromotion` field must not be used as current or whole-system
approval. No second raw report was retained for the recorded 2026-08-30 numbers,
so that table is historical context, not independently reproducible acceptance
evidence. Current component reports explicitly withhold whole-system promotion.

The remaining integrated performance proof must include the Evidence stage,
full activation-validated and audited Runtime queries, all relevant service
memory, exact corpus/model/image identities, and at least three valid timing
runs. Component results cannot satisfy those missing measurements or the
separate correctness and security gates.
