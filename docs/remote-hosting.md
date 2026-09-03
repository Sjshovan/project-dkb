# Verified Remote DKB Hosting

A DKB Runtime can be hosted anywhere that exposes its HTTP and MCP endpoints.
The Registry is optional for serving knowledge, but it is required when a
publisher wants the endpoint associated with a signed package release and
discoverable as a verified remote.

## Runtime discovery and verification

A hosted Runtime exposes:

    /.well-known/dkb.json

The discovery document advertises its public-read endpoint and installed
package releases. It is an assertion, not a trust root. After publishing a
release, a namespace administrator may ask the Registry to verify the endpoint:

    dkb registry remote claim publisher/docs@1.4.0 \
      --url https://docs.example.com

The Registry fetches discovery and health, checks the endpoint origin, package
identity, version, and signed source-tree hash, and issues a short-lived signed
endpoint attestation. A valid Runtime serving an older release is reported as
`behind`, not as invalid.

Registry catalog indicators distinguish a downloadable release from a verified
hosted Runtime. They describe availability; they do not prove that an endpoint
is online now or that its knowledge is installed in any local Library.

## Local endpoint catalog

`dkb remote` manages discovery and attestation metadata only:

    dkb remote search docs
    dkb remote add publisher/docs --version 1.4.0
    dkb remote list
    dkb remote status <remote-id>
    dkb remote remove <remote-id>

A direct development URL may be cataloged, but remains explicitly unverified:

    dkb remote add https://docs.example.com

The catalog is stored in the local DKB state root as `remotes.json`. It does not
create a proxy session, install knowledge, or authorize retrieval.

## Querying a hosted Runtime

A Runtime serves only its own validated activation. DKB never routes a query
through another Runtime process. Register the destination endpoint in the host
Runtime inventory and address it through the ordinary query surface:

    dkb runtime register docs https://docs.example.com --kind remote
    dkb query "How are retries configured?" --runtime docs
    dkb read-targets "retry configuration" --runtime docs

Agents connect directly to that destination Runtime's MCP endpoint and use only
`search` and `fetch`. This keeps activation checks, provenance resolution, and
the authoritative audit event at the Runtime that actually served the evidence.

Installing a Registry package is a separate, explicit operation. It downloads
the exact signed source, Evidence, and Retrieval chain from the selected
Registry into a chosen Library; it never copies knowledge out of a hosted
Runtime.

## Trust limits

A Registry attestation binds an HTTPS endpoint to one signed release for a
limited time. It is not hardware-backed host attestation and does not make a
directly added URL trusted. The Registry does not proxy queries, re-sign Runtime
responses, or grant a Runtime authority to browse or publish packages.
