# Corpus Scale Benchmarks

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

The current result passes the cleanup gates: compile time did not regress and
removing the duplicate active artifact architecture reduced derived storage by
more than the required 35%. The current total was recalculated from the stored
Evidence and Retrieval Build byte counts after correcting an artifact-subset
double count. See
[`corpus-scale-small-2026-08-29.json`](corpus-scale-small-2026-08-29.json) for
the complete receipt.

The external application proof is pending a fresh run after the corpus
sanitizer was hardened to reject quoted literal secrets in configuration files.
No real-corpus source or compiled artifact is retained in Git.

## Embedding provider result

The three-run provider benchmark reused one byte-identical 178-record Evidence
Build and compared only Retrieval compilation and query embedding. TEI passed
every default-promotion gate:

| Measurement | FastEmbed + FAISS | TEI + FAISS | TEI change |
|---|---:|---:|---:|
| Fresh single-job median | 182.39 s | 52.34 s | 71.3% faster |
| Two-job median throughput | 1.66 records/s | 3.42 records/s | 105.8% higher |
| Query latency p50 | 797.09 ms | 563.84 ms | 29.3% lower |
| Peak combined memory | 2.47 GiB | 0.81 GiB | 67.3% lower |

The benchmark used three cold, fresh, cached, and concurrent samples for each
provider plus 20 query samples. TEI remains the default for new Libraries;
FastEmbed remains bundled as a separate selectable embedding space. See
[`embedding-providers-2026-08-29.json`](embedding-providers-2026-08-29.json)
for every raw sample and gate calculation.
