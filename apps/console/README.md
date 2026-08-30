# DKB Host Console

The Console is the loopback management interface shipped with DKB. It presents
the host inventory, Libraries, Runtimes, Registries, Stacks, packages,
pipelines, and activity without reimplementing their domain behavior.

```powershell
dkb console
dkb console status
dkb console stop
```

Every mutation selects an allowlisted command ID with validated typed input.
The server invokes the exact bundled CLI with argument arrays and `shell:
false`, then streams the `dkb.command-event.v1` result to the browser. Browser
code never receives Registry or Runtime credentials and cannot submit raw
commands or argv.

The server binds to `127.0.0.1`, requires a one-time bootstrap into an HttpOnly
session, validates Host and Origin, and requires CSRF on mutations. It stores
only redacted activity metadata in its local SQLite database. Authoritative
state remains in each owning DKB subsystem.

For design and ownership rules, read [DESIGN.md](../../DESIGN.md),
[PRODUCT.md](../../PRODUCT.md), and [ADR 0007](../../docs/decisions/0007-host-console-cli-control-and-authentication.md).
