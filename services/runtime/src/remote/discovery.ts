import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type {
  DkbDiscoveryDocument,
  DkbDiscoveryVersion,
  DkbRemoteDiscoveryResult,
  DkbRemoteEndpointType,
  DkbRemoteScrapePolicy,
} from './types.js';

const DEFAULT_TTL_SECONDS = 86400;
const MAX_TTL_SECONDS = 7 * 86400;

export async function discoverRemoteDkb(inputUrl: string, now = new Date()): Promise<DkbRemoteDiscoveryResult> {
  const discoveryUrl = discoveryUrlFor(inputUrl);
  const response = await fetch(discoveryUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new DkbError(`DKB discovery failed for ${discoveryUrl}: HTTP ${response.status}`);
  }

  const discovery = validateDiscoveryDocument(await response.json(), discoveryUrl);
  const ttlSeconds = boundedTtlSeconds(discovery.policy?.ttlSeconds);

  return {
    status: 'ready',
    trust: 'unverified',
    requestedUrl: inputUrl,
    discoveryUrl,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    discovery,
  };
}

export function discoveryUrlFor(inputUrl: string): string {
  const url = new URL(inputUrl);

  if (url.protocol !== 'https:' && !isLocalhost(url.hostname)) {
    throw new DkbError('Remote DKB discovery requires HTTPS except for localhost test endpoints.');
  }

  if (url.pathname.endsWith('/.well-known/dkb.json')) {
    return url.toString();
  }

  return new URL('/.well-known/dkb.json', url.origin).toString();
}

export function validateDiscoveryDocument(value: unknown, sourceUrl: string): DkbDiscoveryDocument {
  if (!isObject(value)) {
    throw new DkbError('DKB discovery document must be a JSON object.');
  }

  if (value.version !== '0.1' && value.version !== '0.2' || value.type !== 'dkb-discovery') {
    throw new DkbError('DKB discovery document must declare version 0.1 or 0.2 and type dkb-discovery.');
  }

  if (typeof value.site !== 'string' || value.site.length === 0) {
    throw new DkbError('DKB discovery document requires site.');
  }

  validateHttpsUrl(value.site, 'site');

  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) {
    throw new DkbError('DKB discovery document requires at least one endpoint.');
  }

  const endpoints = value.endpoints.map((endpoint, index) => validateEndpoint(endpoint, `endpoints[${index}]`));
  const packages = Array.isArray(value.packages)
    ? value.packages.map((item, index) => validatePackage(item, `packages[${index}]`))
    : [];

  if (value.version === '0.2') {
    for (const [index, item] of packages.entries()) {
      if (!item.packageTreeHash || !item.install) {
        throw new DkbError(`DKB discovery packages[${index}] requires packageTreeHash and install for version 0.2.`);
      }
    }
  }
  const policy = isObject(value.policy)
    ? {
        scrape: validateScrapePolicy(value.policy.scrape),
        ttlSeconds: value.policy.ttlSeconds === undefined ? undefined : boundedTtlSeconds(value.policy.ttlSeconds),
      }
    : undefined;
  const publisher = isObject(value.publisher)
    ? {
        ...(typeof value.publisher.name === 'string' ? { name: value.publisher.name } : {}),
        ...(typeof value.publisher.url === 'string' ? { url: validateHttpsUrl(value.publisher.url, 'publisher.url') } : {}),
      }
    : undefined;

  const discoveryOrigin = new URL(sourceUrl).origin;
  const siteOrigin = new URL(value.site).origin;

  if (discoveryOrigin !== siteOrigin && !isLocalhost(new URL(sourceUrl).hostname)) {
    throw new DkbError(`DKB discovery site origin ${siteOrigin} does not match discovery origin ${discoveryOrigin}.`);
  }

  return {
    version: value.version as DkbDiscoveryVersion,
    type: 'dkb-discovery',
    site: value.site,
    ...(publisher ? { publisher } : {}),
    endpoints,
    ...(packages.length > 0 ? { packages } : {}),
    ...(policy ? { policy } : {}),
  };
}

export function boundedTtlSeconds(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_TTL_SECONDS;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 60) {
    throw new DkbError('DKB discovery policy.ttlSeconds must be an integer >= 60.');
  }

  return Math.min(value, MAX_TTL_SECONDS);
}

function validateEndpoint(value: unknown, label: string) {
  if (!isObject(value)) {
    throw new DkbError(`DKB discovery ${label} must be an object.`);
  }

  const type = value.type;
  const access = value.access;

  if (type !== 'dkb-runtime-http' && type !== 'mcp-streamable-http') {
    throw new DkbError(`DKB discovery ${label}.type must be dkb-runtime-http or mcp-streamable-http.`);
  }

  if (access !== 'public-read') {
    throw new DkbError(`DKB discovery ${label}.access must be public-read.`);
  }

  if (typeof value.url !== 'string') {
    throw new DkbError(`DKB discovery ${label}.url is required.`);
  }

  return {
    type: type as DkbRemoteEndpointType,
    url: validateHttpsUrl(value.url, `${label}.url`),
    access: access as 'public-read',
  };
}

function validatePackage(value: unknown, label: string) {
  if (!isObject(value)) {
    throw new DkbError(`DKB discovery ${label} must be an object.`);
  }

  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i.test(value.id)) {
    throw new DkbError(`DKB discovery ${label}.id must be a registry package id or namespace/name.`);
  }

  const packageTreeHash = value.packageTreeHash === undefined ? undefined : requiredString(value.packageTreeHash, `${label}.packageTreeHash`);
  const install = value.install === undefined ? undefined : validateInstall(value.install, `${label}.install`);

  if (install && install.packageId !== value.id) {
    throw new DkbError(`DKB discovery ${label}.install.packageId must match id.`);
  }

  if (install && value.version !== undefined && install.version !== value.version) {
    throw new DkbError(`DKB discovery ${label}.install.version must match version.`);
  }

  if (install && packageTreeHash && install.packageTreeHash !== packageTreeHash) {
    throw new DkbError(`DKB discovery ${label}.install.packageTreeHash must match packageTreeHash.`);
  }

  return {
    id: value.id,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.manifestUrl === 'string' ? { manifestUrl: validateHttpsUrl(value.manifestUrl, `${label}.manifestUrl`) } : {}),
    ...(packageTreeHash ? { packageTreeHash } : {}),
    ...(install ? { install } : {}),
  };
}

function validateInstall(value: unknown, label: string) {
  if (!isObject(value)) {
    throw new DkbError(`DKB discovery ${label} must be an object.`);
  }

  return {
    registryUrl: validateHttpsUrl(requiredString(value.registryUrl, `${label}.registryUrl`), `${label}.registryUrl`),
    packageId: requiredString(value.packageId, `${label}.packageId`),
    version: requiredString(value.version, `${label}.version`),
    packageTreeHash: requiredString(value.packageTreeHash, `${label}.packageTreeHash`),
  };
}

function validateScrapePolicy(value: unknown): DkbRemoteScrapePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'fallback' || value === 'disallow' || value === 'allowed') {
    return value;
  }

  throw new DkbError('DKB discovery policy.scrape must be fallback, disallow, or allowed.');
}

function validateHttpsUrl(value: string, label: string): string {
  const url = new URL(value);

  if (url.protocol !== 'https:' && !isLocalhost(url.hostname)) {
    throw new DkbError(`DKB discovery ${label} requires HTTPS except for localhost test endpoints.`);
  }

  return url.toString();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DkbError(`DKB discovery ${label} is required.`);
  }

  return value;
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
