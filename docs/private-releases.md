# Private Developer-Preview Releases

DKB release automation is private by design during the developer preview. The
repository, npm packages, container packages, workflow artifacts, and draft
releases must remain private until a separate public-release decision.

**Current availability:** this checkout produces verified package candidates;
it does not provide an available standalone npm/GitHub Packages CLI release.
The default distribution and its six providers intentionally retain
`private: true`. That flag prohibits npm publication to **any** registry,
including private GitHub Packages. It is not a GitHub visibility setting.

## Release units

| Unit | Intended private destination | Version source |
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

The package workflow stages all 15 distributable workspaces once using
`scripts/package-distribution.mjs`. Providers include their exact runtime
dependency closure through npm's native bundling; packaging verifies existing
provider integrity receipts and never regenerates them. The private workflow
artifact contains every `.tgz` plus `candidates.json`, which records portable
filenames, package names, versions, privacy flags, sizes, and archive hashes.

Before any upload, `scripts/release-package-candidates.mjs` re-inspects every
actual archive, checks its recorded hashes and package manifest, rejects
unlisted archives, and verifies exact internal dependency coverage. If any
required package is marked `private: true`, selecting `publish` fails with a
clear publication-blocked error **before publishing any package**. It never
silently skips a private dependency or modifies its manifest.

Enabling publication later requires a separate, reviewed policy decision,
updated source manifests where approved, a fresh build and integrity receipts,
and newly verified candidates. Do not remove flags from an existing archive.
Changesets remains responsible for versions and changelogs, not publication.
Once authorized and unblocked, publication consumes the exact verified `.tgz`
files with scripts disabled, an explicit GitHub Packages destination, and the
`preview` tag. It does not repack workspaces. The draft release receives those
same archives and candidate manifest only after every upload succeeds.

Private source-repository visibility does not itself verify the visibility or
permissions of every destination package. Review those GitHub package settings
separately before authorizing publication.

Before selecting `publish`:

1. Confirm the repository and destination package visibility are private.
2. Review publication eligibility, Changesets, and workspace versions.
3. Run the complete local verification gate.
4. Inspect package tarballs and image contents for credentials, private
   knowledge, generated indexes, local configuration, and internal notes.
5. Confirm the Laravel Registry image is privately available for the intended
   stack version.

## Using candidates today

Use the [checkout installation instructions](../README.md#install-from-this-checkout)
for the current CLI. A single CLI tarball is not a complete distribution: it
depends on other unpublished DKB workspaces. Keep the complete candidate set
together; its global-install proof installs all workspace archives together.

After building and verifying the checkout, generate and check candidates in an
empty output directory:

```powershell
node scripts/package-distribution.mjs --output release
node scripts/release-package-candidates.mjs --directory release
```

These commands do not publish. A successful check may report
`publicationBlockedBy` entries; that is the intentional publication safeguard,
not a failed candidate build. Windows and Linux installation and service proofs
remain separate release gates; archive verification alone is not release readiness.

## Future private GitHub Packages installation

This section applies only after a separately authorized, complete distribution
has actually been published. No currently available CLI version is implied.

GitHub Packages requires an operator-owned classic personal access token with
`read:packages` for local installation. Put it in the operator's user-level npm
configuration, never in this repository:

```ini
@sjshovan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then install the exact reviewed CLI version advertised by that private release,
with its complete dependency set available, and verify it with `dkb --version`
and `dkb version`. Do not assume a source-workspace version has been published.

Do not commit `.npmrc`, tokens, generated stack secrets, or a package-manager
cache. Revoking a package token must not affect Registry access tokens; they are
different trust domains.

## Current limitations

- Releases are developer previews and may require a hard-cut rebuild.
- The distribution and six providers deliberately block npm publication until
  a separate publication-policy decision. A manual publish request does not
  override these flags.
- Publishing 15 packages is sequential, not atomic. A later upload failure
  may leave earlier package versions published. The runner stops, reports the
  successful uploads, and creates no draft release; an operator must reconcile
  the exact archive digests before retrying. There is no automatic rollback or
  silent reuse of existing versions.
- GitHub authentication is required to install private packages and pull
  private images.
- Stack upgrades and backups must pass their own operational proof before a
  private stack release is called recoverable.
- There is no public stability, hosted uptime, compatibility, or support
  commitment.
