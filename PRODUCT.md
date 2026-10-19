# DKB Console Product Brief

## Product

The DKB Console is the localhost management surface for one DKB host. It ships
with the same application bundle as the CLI, Runtime, compiler, and local stack.
It does not replace those tools or create a second control plane.

## Primary user

An operator managing personal or team knowledge infrastructure on a desktop or
server host. They need to see known Libraries, Runtimes, Registries, Stacks,
installed knowledge, pipelines, builds, provenance, and recent operations
without remembering every CLI command.

## Core jobs

- Understand the host's current defaults and degraded resources.
- Register, inspect, select, start, stop, and forget host resources explicitly.
- Install, update, inspect, and uninstall knowledge within an exact Library.
- Inspect pipeline coverage, build identity, provenance, and recovery actions.
- Authenticate the host to a Registry without exposing credentials to browser code.
- Follow long operations and confirm the CLI reports the same resulting state.

## Authority and safety

The Console invokes an allowlisted, typed CLI command with `shell: false`.
Library manifests and locks, Runtime state, Registry services, and the host
inventory remain authoritative. Opening a resource never changes a default.
Destructive operations name their exact scope and require confirmation.
Registry and Runtime credentials remain server-side. Remote MCP stays read-only.

## Non-goals

The developer-preview Console is not a public Registry storefront, a remote
multi-user admin portal, a source editor, or a replacement for Registry
administration. It does not scan disks or networks, bundle Authentik, expose raw
shell commands, or manage repository visibility.
