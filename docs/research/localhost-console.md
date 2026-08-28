# Localhost management console research

Status: proposed, not implemented  
Reviewed: 2026-08-28

## Recommendation

Build a host-native **DKB Console** in this TypeScript monorepo. Serve a compiled
Vue application and a small JSON/event API from one loopback-only Node process.
Use Fastify for the local HTTP boundary and Vue 3 with Vite for the browser
application.

Do not build the local Console in Laravel, do not place it inside a Runtime, and
do not start with Tauri. Keep Laravel as the separately deployed Registry control
plane. A native wrapper can be added later around the same web application if
installers, a tray icon, or OS integration become product requirements.

No UI code should be added until the host operations described below are moved
out of `@sjshovan/dkb-cli` and the first Console information architecture is approved.

## Why this boundary fits DKB

The Console manages resources belonging to the host, not one Library or Runtime:

```text
browser
  -> loopback DKB Console
       -> host inventory and context selection
       -> @sjshovan/dkb-library
       -> @sjshovan/dkb-registry-client
       -> Runtime HTTP clients
       -> local stack operations
```

The Runtime remains a retrieval service for one Library. It must not gain
cross-host discovery, Registry management, Docker orchestration, or browser
session concerns. The CLI remains a command-line adapter. It must not become a
backend that the Console invokes through child processes.

Before the Console, extract these reusable boundaries:

1. `@dkb/host`: inventory storage, selection, resolution, health inspection, and
   local launch metadata. Move `apps/cli/src/host` here.
2. `@sjshovan/dkb-runtime-client`: the Runtime HTTP client and its wire validation. Move
   it out of the Runtime service package.
3. Move operation behavior into its owning package when it is still embedded in
   a Commander action. CLI handlers and Console routes should only validate
   input, call an operation, and present its result.

This is a narrow extraction, not another framework or plugin system.

## Technology comparison

| Option | Fit | Decision |
|---|---|---|
| Fastify + Vue + Vite | Uses DKB's Node/TypeScript runtime, workspaces, contracts, and tests directly. Produces one small host process and static browser assets. | Choose |
| Laravel + Inertia + Vue | Excellent for the remote Registry, but a local Console would add PHP/Composer and either duplicate DKB behavior or bridge back into Node. A container would also need awkward access to host paths and local processes. | Keep for Registry only |
| Tauri + Vue | Good future desktop packaging, but adds Rust, platform installers, WebView IPC, and a native release matrix before those capabilities are needed. It is not the requested self-hosted localhost surface. | Reconsider later |
| Nuxt or another full-stack frontend framework | Capable, but SSR, server conventions, and an additional application abstraction do not help an authenticated single-user operations console. | Do not add |

The evaluated current releases are Fastify 5.12.1, Vue 3.5.42, Vite 8.2.2,
and Tauri CLI 2.11.4. Versions must be pinned and rechecked at implementation
time. Fastify 5 supports Node 20 and newer; DKB already requires Node 22.15 or
newer.

Primary references:

- [Fastify v5 migration and Node support](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Vue with TypeScript and Vite](https://vuejs.org/guide/typescript/overview)
- [Vite production builds](https://vite.dev/guide/build)
- [Inertia's Laravel-oriented modern monolith](https://inertiajs.com/)
- [Laravel release and starter-kit policy](https://laravel.com/framework/docs/master/releases)
- [Tauri architecture](https://v2.tauri.app/concept/architecture/)

## Product shape

This is an operations console, not a showcase and not a second Registry admin.
The first release should have six destinations:

1. **Overview** — selected Library, Runtime, and Registry; health; storage;
   installed knowledge; incomplete builds; and actions requiring attention.
2. **Libraries** — registered Libraries, selected state, paths, package counts,
   storage, active pipeline, and health. A Library detail shows installed DKBs,
   Collections and dependencies, builds, provenance status, and upgrade state.
3. **Runtimes** — known endpoints, Library associations, versions, health, and
   start/stop controls only when local launch metadata makes those actions real.
4. **Registries** — known endpoints, selected state, health, Libraries using each
   endpoint, and package search. Registry administration stays in Laravel.
5. **Builds and pipelines** — active pipeline, package coverage, Evidence and
   Retrieval Builds, storage, missing builds, compile/switch progress, and safe
   pruning.
6. **Activity** — current and recent install, upgrade, compile, switch, prune,
   and stack operations with stages, cancellation where supported, final status,
   and an exact recovery action.

Avoid a card-grid dashboard that hides relationships. The selected context and
attention states lead; tables and master-detail views carry dense inventory. Every
mutation must show scope, affected Library, package/build identity, progress, and
the resulting authoritative state.

## Process and API shape

Add one independently versioned workspace, `apps/console` (`@dkb/console`). Its
production package contains:

```text
apps/console/
  src/server/       # Fastify routes, sessions, jobs, static asset serving
  src/web/          # Vue application
  dist/server/
  dist/web/
```

`dkb console` starts the process on an available loopback port and opens the
browser. `dkb console status` and `dkb console stop` manage only that process.
The server serves Vite's production output itself; `vite preview` is not a
production server.

Use versioned JSON request/response schemas derived from DKB types. Use
server-sent events for bounded operation progress; do not introduce WebSockets
until bidirectional realtime behavior exists. Operation records live for the
Console process lifetime, while Libraries, Runtime state, and Registry services
remain authoritative after a restart.

## Security invariants

- Bind only to `127.0.0.1` and `::1`. Do not offer remote binding in the first
  release.
- Generate a per-launch bootstrap secret, exchange it for an `HttpOnly`,
  `SameSite=Strict` session cookie, and remove the secret from browser history.
- Reject unexpected `Host` and `Origin` values to limit DNS-rebinding and
  cross-site request attacks. Do not enable CORS.
- Require JSON content types and a CSRF token for every mutation.
- Ship a restrictive Content Security Policy and no inline scripts.
- Keep Registry and Runtime tokens server-side. Never return their values to the
  browser, logs, host inventory, or activity records.
- Resolve all Library paths through existing containment and manifest checks.
- Confirm destructive actions by exact identity and describe what is preserved.
- Expose only existing operator-authorized operations. This Console does not
  change the read-only remote MCP surface.

## Implementation gate

After approval:

1. Extract `@dkb/host` and `@sjshovan/dkb-runtime-client`; prove the CLI remains identical.
2. Add read-only Console routes and the Overview, Libraries, Runtimes, and
   Registries views.
3. Add operation jobs and controlled mutations only after read-only state is
   correct.
4. Add Builds/Pipelines and Activity.
5. Verify with Fastify route injection, contract tests shared with the CLI,
   Playwright on Windows and Linux, keyboard-only use, accessibility checks,
   restart recovery, and hostile browser-origin tests.

The acceptance gate is one full lifecycle performed through the Console—register
and select context, install, inspect, retrieve, upgrade, switch pipeline,
uninstall, and verify disappearance—while the CLI reports the same authoritative
state throughout.

