# Console Guidance

This workspace owns the loopback Console server and its Vue operator interface.
The canonical decisions are [ADR 0007](../../docs/decisions/0007-host-console-cli-control-and-authentication.md),
the [product brief](../../PRODUCT.md), and [design system](../../DESIGN.md).

- Treat the CLI as the only control plane. Browser requests select a typed,
  allowlisted command ID and validated input; never accept commands or argv.
- Spawn the exact provided CLI entrypoint with `process.execPath`, argument
  arrays, `shell: false`, bounded environment, working directory, and timeout.
- Keep credentials server-side and activity records redacted. Preserve Host,
  Origin, session, CSRF, path, and loopback checks.
- Reads may run concurrently. Serialize mutations by the exact affected
  resource and surface CLI recovery guidance without reinterpretation.
- Keep pages compositional. Reuse interface and resource components, Registry
  tokens, keyboard semantics, mobile layouts, and status language.
- Do not import CLI internals. The Console may depend on Protocol event types;
  the CLI may depend on the Console launcher.

Verify server routes with injection tests, Vue types and production build,
hostile-origin tests, keyboard/accessibility checks, and paired 320px/1440px
visual inspection.
