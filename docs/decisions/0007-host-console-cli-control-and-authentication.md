# 0007 - Host Console, CLI Control, And Authentication

- **Status:** Accepted
- **Date:** 2026-08-30

## Decision

Ship a loopback-only Vue Console as `@sjshovan/dkb-console`. The Console is an
adapter over an allowlisted typed command map. It invokes the exact bundled CLI
with `process.execPath`, argument arrays, and `shell: false`; it never accepts a
browser-provided command string. Reads may run concurrently and mutations are
serialized per affected resource. CLI `--json-stream` is the operation event
contract and Server-Sent Events carry it to the browser.

Upgrade host inventory to `dkb.host.v2`: `defaults` replaces `selected`, named
Stacks become host resources, and v1 documents migrate through atomic
replacement. Inventory remains disposable convenience state and stores no
credentials or authoritative package state.

The Console follows [the product brief](../../PRODUCT.md), [design system](../../DESIGN.md),
and [surface brief](../design/console-surface.md). It is a mobile-complete
operations interface, not a Registry showcase or a second Registry admin.

The installed Console may run as an optional per-user login service. Windows
uses a least-privilege scheduled task, Linux uses a systemd user unit, and macOS
uses a LaunchAgent. The service runs the Console foreground entrypoint so the
operating system can supervise failure and restart it. It never runs as a
system account. The CLI remains the trusted lifecycle controller and session
issuer; an operating-system application launcher invokes that controller
without exposing its control credential to browser code.

Registry authentication belongs to the host. Browser login uses authorization
code plus PKCE and a loopback callback; device authorization supports headless
hosts. Local Fortify, passkeys, and two-factor authentication remain the default.
Generic OIDC is optional, with identities bound by issuer and subject. Runtime
administration uses a separate credential. Registry downloads for Runtime
installation use short-lived, single-plan grants bound to exact signed digests.
An unused grant expires after five minutes. Once redeemed in time, its exact
source, Evidence, and Retrieval layers may finish within a bounded transfer
window so large archives do not fail mid-install.

## Security consequences

The Console binds to loopback, rejects unexpected Host and Origin headers, uses
an HttpOnly SameSite session plus CSRF for mutations, serves a restrictive CSP,
and retains credentials only server-side. Its activity database stores redacted
operation metadata. Remote MCP remains exactly read-only `search` and `fetch`.

## Rejected alternatives

Laravel remains the remote Registry control plane and is not duplicated for a
host-native process. A browser shell executor is rejected because it expands
the Console into arbitrary code execution. A second domain API is rejected
because it would drift from the CLI lifecycle and recovery contract.
