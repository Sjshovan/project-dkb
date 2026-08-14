# Codename DKB

DKB is a TypeScript reference implementation for packaging source knowledge
into local, installable knowledgebases.

The project provides:

- `dkb.json` package manifests
- source compilation into chunk and provenance indexes
- signed `.dkbpkg` package archives
- local registry publish and install flows
- runtime retrieval over a compact CLI and MCP surface

## Install

```bash
npm install
npm run build
```

## Basic Usage

Create a package:

```bash
node dist/src/cli/index.js init "My DKB"
```

Compile and inspect a package:

```bash
node dist/src/cli/index.js validate ./my-dkb
node dist/src/cli/index.js compile ./my-dkb
node dist/src/cli/index.js verify ./my-dkb
node dist/src/cli/index.js inspect ./my-dkb
```

Run the local registry flow:

```bash
node dist/src/cli/index.js registry serve --root .dkb/mock-registry
node dist/src/cli/index.js registry login --root .dkb/mock-registry --account local-publisher
node dist/src/cli/index.js publish ./my-dkb --registry .dkb/mock-registry --account local-publisher
node dist/src/cli/index.js registry packages --root .dkb/mock-registry
node dist/src/cli/index.js install my-dkb --registry .dkb/mock-registry
```

Retrieve knowledge:

```bash
node dist/src/cli/index.js retrieve "what does this knowledgebase say?"
```

Run the MCP server:

```bash
node dist/src/cli/index.js mcp serve
```

## Runtime Artifacts

Generated artifacts are written under `.dkb/` and are not intended to be
committed:

```text
.dkb/artifacts/
.dkb/cache/
.dkb/locks/
.dkb/runs/
.dkb/trace.sqlite
```
