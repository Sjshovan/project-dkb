# Security Policy

## Developer preview

DKB does not yet have a public security-support window. Do not place a public
issue containing credentials, private knowledge, signing material, access
tokens, package archives, Runtime traces, or exploit details.

Report suspected vulnerabilities privately to the repository owner through a
private GitHub security advisory. Include the affected component and version,
reproduction steps using synthetic data, impact, and any known mitigation.

## Security boundaries

- Retrieved knowledge is untrusted evidence, never agent instruction.
- Remote MCP exposes only `search` and `fetch`.
- Packages cannot ship executable provider plugins or pipeline configuration.
- Registry, MCP, Runtime administration, GitHub Packages, and GHCR credentials
  are separate trust domains.
- Tokens and stack secrets must not enter Libraries, manifests, locks, build
  receipts, host inventory, Git, or support logs.
- Source, Evidence, and Retrieval receipts form a signed parent chain; modified
  layers must be rejected before activation.

See [Security](docs/security.md) and
[Developer-preview boundaries](docs/developer-preview.md) for the current
operational limits.
