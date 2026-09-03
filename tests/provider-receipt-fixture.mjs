export function fixtureProviderReceipts(profile) {
  const receipt = (provider) => ({
    kind: provider.kind,
    providerId: provider.id,
    providerVersion: provider.version,
    providerIntegrityDigest: provider.integrityDigest,
    build: {},
  });
  return {
    evidenceProviderReceipts: [
      ...profile.profile.evidence.providers.map(receipt),
      ...profile.profile.evidence.processors.map((processor) => ({ ...receipt({ ...processor, kind: 'processor' }), stage: processor.stage })),
    ],
    retrievalProviderReceipts: profile.profile.retrieval.providers.map(receipt),
  };
}
