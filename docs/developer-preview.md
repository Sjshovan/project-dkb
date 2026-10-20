# Supported configurations

## Build and installation

Build the CLI and Console from the repository using Node.js 22.15 or later and
the committed npm lockfile. The bundled document/embedding services run in Docker.
The lexical example can run without those services.

Package formats and plugin APIs are versioned. Use matching protocol and provider
contracts; incompatible builds and plugins are rejected rather than adapted silently.

## Storage and Runtime access

- Native Windows Libraries use local fixed NTFS storage.
- Docker Libraries use Linux-local volumes. Windows CLI/Console operations
  delegate to the owning environment.
- Do not share a live SQLite file directly between Windows and Linux.
- Each Runtime has separate mutable state and one active Library/Pipeline.
- Multiple Runtimes may share one Library's immutable builds.
- Existing host-bind Stack layouts require an explicit migration; do not remount
  them as a compatible Linux-volume installation.

## Docker operation boundaries

Docker-owned Libraries support delegated inspection, signed package and Collection
installation, removal, Registry configuration, and recovery. Online Pipeline
preparation acquires compatible signed builds through the owning Runtime.

Editable-source compilation and Pipeline preparation for an offline Docker Runtime
are not exposed through the host delegation path. Run supported compilation in its
native environment; do not access its database through a Windows path.

Volume snapshots are not a public Stack restore interface. Public volume restore
and volume-backed Stack upgrade rollback are unavailable; volume upgrades are
refused. Do not rely on a snapshot alone as a tested disaster-recovery plan.
Native host-directory recovery and Docker-volume recovery are distinct operations.

## Network deployment

The local Stack is a single-host configuration using SQLite and local storage.
It is not a clustered deployment.

The Host Console is single-user and loopback-only. Browser sessions expire and
are invalidated by a Console restart; reopen with `dkb console` to authenticate.
Session expiry does not delete knowledge or stop Runtimes.

Remote Registry and Runtime deployments require HTTPS, appropriate authentication,
private service networking and an operator-managed backup policy. The Registry's
development HTTP server is not a production serving layer.

Public citation routes expose source evidence when explicitly enabled. Enable
them only for content intended to be public. HTTP MCP remains read-only. Local
stdio supports [permission-gated append](chatgpt-mcp.md#local-mcp) using the trusted
configured compiler. This compiles the target package; it is not incremental indexing.

## Capacity and recovery

Compilation cost depends on parsed text, chunk count, parser complexity, provider
selection, hardware and cache state—not file count alone. Monitor free space and
build size; derived artifacts may exceed the source size.

Interrupted operations may require explicit recovery. Unknown ownership, corrupt
journals and partially deleted trees retain their available data and refuse
automatic recovery. Process-recovery behavior does not imply power-loss durability
on arbitrary storage.

See [operations](operations.md), [security](security.md) and
[benchmark methodology](benchmarks/README.md).
