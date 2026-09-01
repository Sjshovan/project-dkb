# DKB Host Console

The Console is the loopback management interface shipped with DKB. It presents
the host inventory, Libraries, Runtimes, Registries, Stacks, packages,
pipelines, and activity without reimplementing their domain behavior.

```powershell
dkb console
dkb console enable
dkb console restart
dkb console disable
dkb console status
dkb console stop
```

Automatic startup is optional and user-scoped. Windows registers a hidden,
least-privilege login task with failure restart and installs a **DKB Console**
Start Menu shortcut. Linux registers a systemd user service; macOS registers a
LaunchAgent. `disable` removes login startup without deleting activity or any
managed DKB state.

Every mutation selects an allowlisted command ID with validated typed input.
The server invokes the exact bundled CLI with argument arrays and `shell:
false`, then streams the `dkb.command-event.v1` result to the browser. Browser
code never receives Registry or Runtime credentials and cannot submit raw
commands or argv.

Registry detail pages use the same typed CLI boundary to search DKBs and
Collections, inspect exact releases, view signed source metadata, builds, and
provenance, and install into an explicitly selected matching Library. A Library
with another upstream must go through the separate Connect Library operation;
the Console never changes it implicitly.

When an installed package or Collection changes in a Library associated with a
running Runtime, the Console resolves that Runtime from host inventory and asks
the CLI to reload it after the transactional Library operation. The browser
cannot supply an arbitrary Runtime endpoint.

The server binds to `127.0.0.1`, requires a one-time bootstrap into an HttpOnly
session, validates Host and Origin, and requires CSRF on mutations. It stores
only redacted activity metadata in its local SQLite database. Authoritative
state remains in each owning DKB subsystem.

Browser sessions last twelve hours and are intentionally invalidated whenever
the local Console process restarts. An expired tab shows a dedicated recovery
screen; reopen **DKB Console** from the applications menu or run `dkb console`
to issue a new one-time link. Session expiry does not change Libraries,
Runtimes, Registries, packages, or other authoritative DKB state.

For design and ownership rules, read [DESIGN.md](../../DESIGN.md),
[PRODUCT.md](../../PRODUCT.md), and [ADR 0007](../../docs/decisions/0007-host-console-cli-control-and-authentication.md).
