# Private Developer-Preview Releases

DKB release automation is private by design during the developer preview. The
repository, npm packages, container packages, workflow artifacts, and draft
releases must remain private until a separate public-release decision.

## Release units

| Unit | Private destination | Version source |
| --- | --- | --- |
| CLI and TypeScript workspaces | GitHub Packages under `@sjshovan` | each workspace `package.json` |
| Compiler image | `ghcr.io/sjshovan/dkb-compiler` | `@sjshovan/dkb-compiler` |
| Runtime image | `ghcr.io/sjshovan/dkb-runtime` | `@sjshovan/dkb-runtime` |
| Evidence image | `ghcr.io/sjshovan/dkb-evidence-docling-llamaindex` | `@sjshovan/dkb-evidence-docling-llamaindex` |
| FastEmbed image | `ghcr.io/sjshovan/dkb-embedding-fastembed` | `@sjshovan/dkb-embedding-fastembed` |
| FAISS helper image | `ghcr.io/sjshovan/dkb-index-faiss` | `@sjshovan/dkb-index-faiss` |
| Laravel Registry image | private GHCR package owned by the Registry repository | Registry application version |

The protocol version, implementation package versions, provider compatibility
digests, image digests, and stack version are separate identifiers. Do not use
one as a substitute for another.

The stack assembly workflow accepts one JSON map from distribution service IDs
to exact image digests and writes `dkb.stack-lock.v2`. The generator loads the
default distribution catalog, rejects missing or unknown services, and binds
the lock to the distribution ID and version. This includes pinned external
services as well as independently built private images. A stack upgrade never
resolves a floating tag.

## Safety model

The package and image workflows are manual-only. Their publish switch defaults
to off, and both workflows query GitHub before building to ensure the source
repository is private. A normal push to `development` runs verification only;
it never publishes a package or image.

Before selecting `publish`:

1. Confirm the repository visibility is private.
2. Review Changesets and workspace versions.
3. Run the complete local verification gate.
4. Inspect package tarballs and image contents for credentials, private
   knowledge, generated indexes, local configuration, and internal notes.
5. Confirm the Laravel Registry image is privately available for the intended
   stack version.

## Installing the private CLI

GitHub Packages requires an operator-owned classic personal access token with
`read:packages` for local installation. Put it in the operator's user-level npm
configuration, never in this repository:

```ini
@sjshovan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then install the exact developer-preview version:

```powershell
npm install --global @sjshovan/dkb-cli@0.2.0
dkb --version
dkb version
```

Do not commit `.npmrc`, tokens, generated stack secrets, or a package-manager
cache. Revoking a package token must not affect Registry access tokens; they are
different trust domains.

## Current limitations

- Releases are developer previews and may require a hard-cut rebuild.
- GitHub authentication is required to install private packages and pull
  private images.
- Stack upgrades and backups must pass their own operational proof before a
  private stack release is called recoverable.
- There is no public stability, hosted uptime, compatibility, or support
  commitment.
