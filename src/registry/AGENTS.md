# Registry Guidance

These rules extend the repository-level `AGENTS.md` for `src/registry/`.

## Trust Boundary

- Treat uploaded source archives, manifests, remote endpoints, and registry
  responses as untrusted until validated.
- Uploaded `.dkb/`, lock files, receipts, package metadata, and compiled indexes
  are never canonical publication input. Build releases from clean source.
- Published package versions are immutable. A reused version with a different
  digest is an error, not an update.
- DKBs and Collections share the canonical `@namespace/name` identity space.
  Collection revisions are Registry-assigned immutable snapshots of exact DKB
  versions and release digests; never publish unresolved `latest` selectors.
- Publisher-account private keys and registry signing keys stay server-side.
  Clients receive receipts, signatures, fingerprints, and public keys only.
- Validate package identity, version, tree hash, archive hash, signatures, and
  retrieval profile before runtime activation.

## Development And Production

- Keep the built-in TypeScript registry explicitly identified as a development
  fixture. Do not assume its routes or authentication exist in Laravel.
- The Laravel registry route contract is authoritative for hosted publication
  and private-package authentication. Change the client and Laravel API together,
  or make unsupported development-only behavior explicit.
- Registry URL precedence and folder discovery belong in shared configuration
  code. Do not add a new fallback in an individual command or client method.

## Mutation Safety

- Download and copy into sibling temporary files, verify completely, then
  promote atomically. Preserve existing output until replacement succeeds.
- Compile and publish are separate outcomes from hosted-runtime registration.
  Report partial success and provide a retry command when the release exists but
  a later registration step fails.
- Check existing installed or published state before transferring large
  archives when lightweight metadata can answer the question.
- Preserve clean rollback paths for failed compilation, signing, download,
  extraction, or activation.
- A failed fresh activation must remove the newly promoted vendor target as
  well as restoring any previous target, lock, ledger, and aggregate catalog.

## Verification

Test the local fixture and Laravel HTTP contract separately. Cover immutable
version conflicts, malformed validation responses, signature/hash failure,
overwrite protection, interrupted transfer, partial publication, and install
preflight without relying on a real personal token.
