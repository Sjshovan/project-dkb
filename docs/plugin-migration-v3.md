# Plugin API v2 to v3

Plugin API v3 is a development hard cut. DKB rejects v1 and v2 plugins and does
not ship an adapter because an adapter would make incomplete provenance or
loosely validated output appear trustworthy.

## Required changes

1. Set `apiVersion` to `3`.
2. Export a Standard Schema V1 `optionsSchema`; validation now happens before
   `setup`, and the resolved options are frozen.
3. Use the matching `define*` SDK helper from
   `@sjshovan/dkb-pipeline/sdk.js`.
4. Evidence records must provide the explicit provenance structure documented
   in [Plugin SDK v3](plugin-authoring.md). Remove hidden provenance metadata.
   Separate parser/chunker implementations return `DkbParsedDocument` and
   `DkbLocatedChunk` with explicit source and span provenance. Do not derive the
   original source hash from text changed by a processor; metadata is not a
   provenance fallback.
5. Return provider-owned semantic `build` and optional `compatibility` receipt
   data. Put timings, cache statistics, and other run-specific measurements in
   optional `diagnostics`, never `build`. Receipt values must be plain, finite
   JSON data. Do not return or claim a provider ID/version.
6. Accept and honor cancellation on provider operations. Pass signals into
   network/process calls and check between batches.
7. Index candidates and retrieval hits must refer to existing Evidence IDs and
   use finite scores. Packaged and managed indexes use their separate contracts.
   Managed installation returns an explicit `created` boolean and implements
   `discardPackage` for rollback of one exact newly created index. Do not reuse
   broad package uninstall as rollback: other Pipelines may retain their indexes.
8. Move post-query exports to a `defineQueryObserver`. Observers receive a
   frozen, redacted event after DKB has persisted the canonical audit event;
   they cannot mutate results or citations.
9. Run `dkb plugin verify .` and `dkb plugin test . --fixture <editable-dkb>`.

## Rebuild effects

Provider integrity is part of profile identity. Moving to API v3 therefore
creates new Evidence or Retrieval Profile digests and requires rebuilding
derived state. Package source, manifests, Collection locks, installed intent,
credentials, and host inventory remain unchanged. Historical signed builds stay
immutable but cannot satisfy a v3 Runtime activation.

Evidence and Retrieval locks use `dkb.evidence-build.v2` and
`dkb.retrieval-build.v2`. Both retain ordered semantic execution receipts under
DKB-verified provider identities. Each Retrieval Build also binds the exact
parent Evidence receipt, not only the Evidence IR bytes. The old derived locks
cannot supply this provenance and must be rebuilt; there is no legacy reader.
Operational diagnostics remain in the local compilation report and do not
change Evidence or Retrieval identity.

Bundled distribution providers additionally ship a generated
`dist/provider.integrity.json`. Their build command must generate it from the
final shipped files and installed dependency closure; Runtime loading and
package inspection only verify it. Do not copy or edit an old receipt after
changing provider code. This does not add a manifest or receipt requirement
to operator-managed `.dkb/plugins` modules.

Use `dkb plugin init @namespace/name --kind <kind> <temporary-directory>` as a
current contract reference when migrating an existing implementation.
