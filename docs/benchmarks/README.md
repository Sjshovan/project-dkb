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
