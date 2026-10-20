# Benchmark methodology

DKB performance depends on source density, parsing complexity, Evidence record
count, embedding dimensions, selected providers and available hardware. File
count alone is not a useful capacity estimate.

## Bounded corpus benchmark

```powershell
npm.cmd run benchmark:scale
```

The harness generates deterministic mixed prose, Markdown tables and code in a
DKB-prefixed temporary directory and removes that corpus after the run. Start
with the smoke tier. Opt into larger tiers only after inspecting its result:

```powershell
$env:DKB_SCALE_TIERS = 'small,medium'
npm.cmd run benchmark:scale
```

The default harness stops before a tier projected to exceed 15 minutes or an
8 GiB working set. The compiler separately checks actual free space before
ingestion and after Evidence IR materialization. These limits bound a test;
they are not guarantees about arbitrary input documents.

## Record enough context to reproduce a result

Include the source revision, corpus hash and size, Evidence record/text counts,
Pipeline and provider integrity receipts, pinned model/image identities, OS,
CPU/GPU, memory, service configuration and cache state. Keep private corpora,
machine-local paths, credentials and raw operational logs outside Git.

Report at least three valid runs per condition, using medians and preserving
the sample count. Separate cold, warm, cached and concurrent conditions. Record
failures and timeouts instead of silently excluding them. Avoid running other
DKB proofs concurrently when comparing implementations.

## Measure the whole operation

- **Compilation:** source staging, parsing/chunking, processors, embedding,
  indexing, validation and promotion; also report individual stage timings.
- **Retrieval:** activation validation, query processing, provider search,
  evidence resolution and mandatory audit, not only an embedding HTTP request.
- **Resources:** the combined relevant processes and services, not just Node.
- **Storage:** source bytes and each immutable Evidence/Retrieval directory once.
  Retrieval artifact bytes are a subset, not another copy to add to the total.
- **Correctness:** known-answer evidence, stable provenance, unrelated-query
  insufficiency and identical compatibility checks.

Use `evidenceRecords`, `evidenceTextBytes`, `recordsPerSource` and
`textBytesPerRecord` to explain corpus density. A table-heavy PDF may generate
more work than many short text files.

## Comparing providers

Compare against the same source and Evidence Build when isolating retrieval
compilation. Compare complete source-to-build jobs separately. A component
speedup is not an end-to-end speedup, and a configured default is not a
performance claim.

FastEmbed and TEI are distinct embedding spaces even with the same model name.
Do not share vectors or relax compatibility to make a comparison pass. Pair
performance measurements with the existing lifecycle and security tests before
recommending a deployment change.
