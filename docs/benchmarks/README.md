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
work the retrieval build actually performs. `sourceToDerivedRatio` includes
the active artifact tree plus the immutable Evidence and Retrieval Build
layers retained for rollback and space switching.

## Provider hard-cutover result

The deterministic 1 MiB `small` corpus was rerun after the immutable-build
storage cutover. Both reports use the same 24 generated source files, 1,062,058
source bytes, 682 Evidence records, and `tei-faiss` target.

| Measurement | 2026-08-28 baseline | 2026-08-29 cutover | Change |
|---|---:|---:|---:|
| Wall time | 207.02 s | 167.81 s | 18.9% faster |
| Total derived bytes | 32,682,857 | 7,811,596 | 76.1% smaller |
| Retrieval artifact files | 10 | 3 | 70.0% fewer |

The current result passes the cleanup gates: compile time did not regress and
removing the duplicate active artifact architecture reduced derived storage by
more than the required 35%. See
[`corpus-scale-small-2026-08-29.json`](corpus-scale-small-2026-08-29.json) for
the complete receipt.

The external application proof used a sanitized architecture slice containing
104 copied files (1,005,998 bytes). With the generated import receipt included,
the compiler measured 105 source assets, 773 Evidence records, 256.35 seconds,
and 8,941,246 derived bytes. It passed signed install, 3/3 retrieval, MCP
search/fetch, uninstall disappearance, and reinstall without compilation. The
copied corpus and disposable stack were removed after the run; only aggregate
metrics are retained in Git.

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
