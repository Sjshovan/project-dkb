# Verified Remote DKB Hosting

DKB runtimes are portable and may run without a registry. A registry is
required only when a runtime should be publicly discoverable and trusted by
other DKB clients.

## Runtime discovery

A hosted runtime exposes:

    /.well-known/dkb.json

Protocol 0.2 advertises the public-read runtime endpoint and each installed
package release. A package entry includes its package id, version, package tree
hash, and a registry install descriptor. The runtime document is an assertion;
it is not trusted by itself.

## Registry verification

After a published release is available, the publisher can register a runtime:

    dkb registry remote claim publisher/docs@1.4.0
      --url https://docs.example.com

The registry fetches discovery and health, checks the endpoint origin, package
identity, version, and package tree hash, and returns a short-lived signed
endpoint attestation. Only verified and behind endpoints are eligible for
trusted remote queries. A valid older release is behind, not invalid.

The registry derives two catalog indicators:

    [local]  downloadable published release
    [remote] verified hosted runtime

The indicators describe availability, not installation state or current online
health.

## Local remote catalog

Persistent remote state belongs to the runtime at:

    .dkb/runtime/remotes.json

Examples:

    dkb remote search docs
    dkb remote add publisher/docs --version 1.4.0
    dkb remote list
    dkb remote status <remote-id>
    dkb remote query <remote-id> "How are retries configured?"
    dkb remote remove <remote-id>

A direct URL can still be added for development:

    dkb remote add https://docs.example.com

Direct URLs are stored as unverified and cannot offer package installation.
Registry-backed remotes receive a five-minute verification lease. A query
refreshes the lease through the registry only when it has expired, then checks
that returned provenance belongs to the expected package.

## Explicit installation

Discovery can show a one-time installation offer for the exact
registry/package/version/tree-hash tuple. An agent must ask the user before
calling dkb.install_package.

Installation resolves the package through the configured registry, verifies
publisher and registry signatures and the package tree hash, then uses the
existing compiled-artifact install path. It never downloads package contents
from the remote runtime, recompiles, rechunks, or re-embeds.

Installed packages enter the local vendor/catalog/index only after explicit
installation. Remote packages remain remote until then.

## Trust limits

This verifies an HTTPS endpoint against a registry-signed package release. It
does not provide hardware-backed host attestation. Registry availability is
not required for runtime startup or ordinary queries while a verification lease
is valid. The registry does not proxy remote queries or re-sign package
artifacts.
