export type DkbRemoteEndpointType = 'dkb-runtime-http' | 'mcp-streamable-http';
export type DkbRemoteAccess = 'public-read';
export type DkbRemoteScrapePolicy = 'fallback' | 'disallow' | 'allowed';
export type DkbDiscoveryVersion = '0.1' | '0.2';

export interface DkbDiscoveryEndpoint {
  type: DkbRemoteEndpointType;
  url: string;
  access: DkbRemoteAccess;
}

export interface DkbDiscoveryPackage {
  id: string;
  version?: string;
  manifestUrl?: string;
  packageTreeHash?: string;
  install?: {
    registryUrl: string;
    packageId: string;
    version: string;
    packageTreeHash: string;
  };
}

export interface DkbDiscoveryDocument {
  version: DkbDiscoveryVersion;
  type: 'dkb-discovery';
  site: string;
  publisher?: {
    name?: string;
    url?: string;
  };
  endpoints: DkbDiscoveryEndpoint[];
  packages?: DkbDiscoveryPackage[];
  policy?: {
    scrape?: DkbRemoteScrapePolicy;
    ttlSeconds?: number;
  };
}

export interface DkbRemoteEndpointAttestation {
  type: 'dkb.remote.endpoint.attestation';
  version: 1;
  subject: {
    registryUrl: string;
    endpointUrl: string;
    discoveryUrl: string;
    packageId: string;
    version: string;
    packageTreeHash: string;
  };
  issuedAt: string;
  expiresAt: string;
  registry: {
    registryId: string;
    keyId: string;
    publicKeyFingerprint: string;
    algorithm: 'ed25519';
    value: string;
    signedAt: string;
  };
}

export interface DkbRemoteDiscoveryResult {
  status: 'ready';
  trust: 'unverified' | 'registry-verified';
  requestedUrl: string;
  discoveryUrl: string;
  fetchedAt: string;
  expiresAt: string;
  discovery: DkbDiscoveryDocument;
}
