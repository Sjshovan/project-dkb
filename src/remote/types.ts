import type { DkbRetrieveKnowledgeRequest, DkbRetrieveKnowledgeResponse } from '../read/runtime.js';

export type DkbRemoteEndpointType = 'dkb-runtime-http' | 'mcp-streamable-http';
export type DkbRemoteAccess = 'public-read';
export type DkbRemoteScrapePolicy = 'fallback' | 'disallow' | 'allowed';

export interface DkbDiscoveryEndpoint {
  type: DkbRemoteEndpointType;
  url: string;
  access: DkbRemoteAccess;
}

export interface DkbDiscoveryPackage {
  id: string;
  version?: string;
  manifestUrl?: string;
}

export interface DkbDiscoveryDocument {
  version: '0.1';
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

export interface DkbRemoteDiscoveryResult {
  status: 'ready';
  requestedUrl: string;
  discoveryUrl: string;
  fetchedAt: string;
  expiresAt: string;
  discovery: DkbDiscoveryDocument;
}

export interface DkbRemoteSession {
  id: string;
  status: 'attached';
  endpoint: DkbDiscoveryEndpoint;
  discoveryUrl: string;
  site: string;
  publisher?: DkbDiscoveryDocument['publisher'];
  packages: DkbDiscoveryPackage[];
  scrapePolicy: DkbRemoteScrapePolicy;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export interface DkbRemoteAttachInput {
  url: string;
  ttlSeconds?: number;
}

export interface DkbRemoteRetrieveResult {
  session: DkbRemoteSession;
  remote: DkbRetrieveKnowledgeResponse;
}

export type { DkbRetrieveKnowledgeRequest };
