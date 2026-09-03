import { createHash } from 'node:crypto';
import { compilerIdentity, pipelineChains, pipelineDigest, pipelineHealth, pipelineServices, providerIntegrity } from './pipelineMetadata.js';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_PIPELINE_RESOLUTION_MESSAGE, type DkbUnresolvedCompilerTargetCapability } from '@sjshovan/dkb-protocol/compilerCapabilities.js';
import {
  validateInstallPlan,
  type DkbInstallPlan,
  type DkbInstallPlanArtifact,
} from '@sjshovan/dkb-protocol/builds.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import {
  DKB_SOURCE_INVENTORY_FORMAT,
  DKB_SOURCE_INVENTORY_MEDIA_TYPE,
  type DkbRegistryCatalogEntry,
  type DkbRegistryCatalogPage,
  type DkbRegistryCollectionDetail,
  type DkbRegistryPackageDetail,
  type DkbRegistryPackageVersionDetail,
  type DkbRegistryPageMeta,
  type DkbRegistrySourceInventoryPage,
} from '@sjshovan/dkb-protocol/registryCatalog.js';
import { createDkbSourceArchive, DKB_PACKAGE_EXTENSION, DKB_PACKAGE_MEDIA_TYPE, DKB_SOURCE_ARCHIVE_MEDIA_TYPE } from '@sjshovan/dkb-library/archive.js';
import { DEFAULT_REGISTRY_URL, normalizeRegistryUrl } from './config.js';
import { loadRegistryCredentialSync } from './credentials.js';

export interface DkbRegistryClientOptions {
  baseUrl?: string;
  token?: string;
  installGrant?: string;
}

export interface DkbRegistryBrowserAuthorization {
  authorizationId: string;
  authorizeUrl: string;
  expiresAt: string;
}

export interface DkbRegistryDeviceAuthorization {
  authorizationId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DkbRegistryTokenExchange {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  abilities: string[];
  user: { id: number; name: string; email: string };
  team: { id: number; name: string; slug: string };
}

export interface DkbRegistryInstallGrant {
  plan: DkbInstallPlan;
  installGrant: string;
  expiresAt: string;
}

export interface DkbRegistryRelease {
  packageId: string;
  version: string;
  status: string;
  archiveHash?: string;
  packageTreeHash?: string;
  recordCount?: number;
}

export interface DkbRegistryPackageSummary {
  id: string;
  latestVersion: string;
  name?: string;
  description?: string;
  visibility?: string;
}

export interface DkbRegistryCollectionRevision {
  collectionId: string;
  revision: number;
  digest: string;
  manifest: {
    type: 'collection';
    id: string;
    name: string;
    revision: number;
    digest: string;
    members: Array<{ id: string; version: string; digest: string }>;
  };
}

export interface DkbRegistryBuildRequest {
  status: 'queued' | 'ready';
  target: string;
  jobId?: number;
  evidenceDigest?: string;
  retrievalBuildDigest?: string;
}

export interface DkbRegistryPipelineProvider {
  id: string;
  version: string;
  kind: string;
  integrityDigest: string;
  integrity: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCapabilityIntegrityReceipt;
  source: import('@sjshovan/dkb-protocol/retrievalProfile.js').DkbPluginReceiptSource;
  sourceDigest: string;
}

export interface DkbRegistryPipelineProcessor {
  id: string;
  version: string;
  stage: string;
  integrityDigest: string;
  order: number;
  integrity: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCapabilityIntegrityReceipt;
  source: import('@sjshovan/dkb-protocol/retrievalProfile.js').DkbPluginReceiptSource;
  sourceDigest: string;
}

export interface DkbResolvedRegistryPipeline {
  name: string;
  default: boolean;
  available: boolean;
  providers: DkbRegistryPipelineProvider[];
  processors: DkbRegistryPipelineProcessor[];
  buildDigest: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  requiredServices: string[];
  health: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCompilerTargetCapability['health'];
  compilerBuildDigest: string;
  chains: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCompilerTargetCapability['chains'];
  serviceRequirements: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCapabilityServiceRequirement[];
  resolutionError?: never;
}

export interface DkbUnresolvedRegistryPipeline extends Omit<DkbUnresolvedCompilerTargetCapability, 'compatibility'> {
  default: boolean;
  compilerBuildDigest: string;
}
export type DkbRegistryPipeline = DkbResolvedRegistryPipeline | DkbUnresolvedRegistryPipeline;

export interface DkbRegistryPipelineCatalog {
  default: string;
  compiler: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbInstalledCompilerIdentity;
  pipelines: DkbRegistryPipeline[];
}

export interface DkbRegistryBuildJob {
  jobId: number;
  stage: 'pipeline' | 'variant' | 'retrieval';
  target: string;
  status: string;
  attempts: number;
  evidenceDigest?: string;
  retrievalBuildDigest?: string;
  error?: string;
}

class DkbRegistryHttpError extends DkbError {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, code: string, status: number, retryAfterMs?: number) {
    super(message, code);
    this.name = 'DkbRegistryHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface DkbRegistryIdentity {
  user: { id: number; name: string; email: string };
  team: { id: number; name: string; slug: string };
  token: { id: number; name: string; abilities: string[]; lastUsedAt?: string | null; expiresAt?: string | null };
}

export class DkbRegistryClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly installGrant?: string;

  constructor(options: DkbRegistryClientOptions = {}) {
    this.baseUrl = normalizeRegistryUrl(options.baseUrl ?? process.env.DKB_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
    this.token = options.token
      ?? process.env.DKB_REGISTRY_TOKEN
      ?? loadRegistryCredentialSync(this.baseUrl)?.token;
    this.installGrant = options.installGrant;
  }

  async startBrowserAuthorization(input: {
    callbackUri: string;
    state: string;
    codeChallenge: string;
    abilities?: string[];
  }): Promise<DkbRegistryBrowserAuthorization> {
    return await this.post('/api/registry/auth/authorize', input) as DkbRegistryBrowserAuthorization;
  }

  async startDeviceAuthorization(abilities?: string[]): Promise<DkbRegistryDeviceAuthorization> {
    return await this.post('/api/registry/auth/device', { ...(abilities ? { abilities } : {}) }) as DkbRegistryDeviceAuthorization;
  }

  async exchangeAuthorization(input: {
    grantType: 'authorization_code' | 'device_code';
    code?: string;
    codeVerifier?: string;
    deviceCode?: string;
  }): Promise<DkbRegistryTokenExchange> {
    return await this.post('/api/registry/auth/exchange', input) as DkbRegistryTokenExchange;
  }

  health() {
    return this.get('/health');
  }

  publicKeys() {
    return this.get('/.well-known/dkb-registry-keys.json');
  }

  async whoAmI(): Promise<DkbRegistryIdentity> {
    const data = resourceData(await this.get('/api/registry/auth/whoami'));

    if (!data || !isRecord(data.user) || !isRecord(data.team) || !isRecord(data.token)) {
      throw new DkbError('Registry returned an invalid authentication identity.');
    }

    return data as unknown as DkbRegistryIdentity;
  }

  revokeCurrentToken() {
    return this.request('DELETE', '/api/registry/auth/token');
  }

  packages() {
    return this.get('/api/registry/packages');
  }

  async pipelines(): Promise<DkbRegistryPipelineCatalog> {
    const value = await this.get('/api/registry/pipelines');
    if (!isRecord(value) || typeof value.default !== 'string' || !Array.isArray(value.pipelines)) {
      throw new DkbError('Registry returned an invalid Pipeline catalog.');
    }
    const pipelines = value.pipelines.map((candidate, index) => parseRegistryPipeline(candidate, index));
    if (!pipelines.some((candidate) => candidate.name === value.default && candidate.default)) {
      throw new DkbError(`Registry Pipeline catalog does not contain its declared default target: ${value.default}`);
    }
    const compiler = compilerIdentity(value.compiler);
    if (pipelines.some((pipeline) => pipeline.compilerBuildDigest !== compiler.buildDigest)) throw new DkbError('Registry Pipeline compiler identity differs from its catalog.');
    return { default: value.default, pipelines, compiler };
  }

  searchPackages(query?: string) {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : '';

    return this.get(`/api/registry/packages${suffix}`);
  }

  async catalog(options: {
    query?: string;
    type?: 'all' | 'dkb' | 'collection';
    page?: number;
    perPage?: number;
  } = {}): Promise<DkbRegistryCatalogPage> {
    const type = options.type ?? 'all';
    const query = registryQuery({ q: options.query, page: options.page, perPage: options.perPage });
    const [packages, collections] = await Promise.all([
      type === 'collection' ? null : this.get(`/api/registry/packages${query}`),
      type === 'dkb' ? null : this.get(`/api/registry/collections${query}`),
    ]);
    const packagePage = packages === null ? null : parseCatalogPage(packages, 'dkb');
    const collectionPage = collections === null ? null : parseCatalogPage(collections, 'collection');

    return {
      entries: [...(packagePage?.entries ?? []), ...(collectionPage?.entries ?? [])]
        .sort((left, right) => String(right.publishedAt ?? '').localeCompare(String(left.publishedAt ?? ''))
          || left.id.localeCompare(right.id)),
      pages: {
        ...(packagePage ? { dkbs: packagePage.meta } : {}),
        ...(collectionPage ? { collections: collectionPage.meta } : {}),
      },
    };
  }

  async packageDetails(packageId: string, version?: string): Promise<DkbRegistryPackageDetail> {
    const entry = resourceData(await this.download(packageId));
    if (!entry || entry.id !== packageId || typeof entry.latestVersion !== 'string') {
      throw new DkbError(`Registry returned invalid DKB details for ${packageId}.`);
    }
    const selectedVersion = version ?? entry.latestVersion;
    const release = resourceData(await this.download(packageId, selectedVersion));
    if (!release || release.packageId !== packageId || release.version !== selectedVersion || typeof release.status !== 'string') {
      throw new DkbError(`Registry returned invalid DKB release details for ${packageId}@${selectedVersion}.`);
    }

    return {
      type: 'dkb',
      entry: catalogEntry(entry, 'dkb'),
      versions: Array.isArray(entry.versions)
        ? entry.versions.filter(isRecord).map((item) => ({
            version: String(item.version ?? ''),
            status: String(item.status ?? ''),
            ...(typeof item.packageTreeHash === 'string' ? { packageTreeHash: item.packageTreeHash } : {}),
          })).filter((item) => item.version !== '' && item.status !== '')
        : [],
      selectedVersion: release as unknown as DkbRegistryPackageVersionDetail,
    };
  }

  async collectionDetails(collectionId: string, revision?: number): Promise<DkbRegistryCollectionDetail> {
    const entry = resourceData(await this.collection(collectionId));
    if (!entry || entry.id !== collectionId || typeof entry.latestRevision !== 'number') {
      throw new DkbError(`Registry returned invalid Collection details for ${collectionId}.`);
    }
    const revisions = Array.isArray(entry.revisions)
      ? entry.revisions.filter(isRecord).map((item) => ({
          revision: Number(item.revision),
          digest: String(item.digest ?? ''),
          ...(typeof item.publishedAt === 'string' ? { publishedAt: item.publishedAt } : {}),
        })).filter((item) => Number.isSafeInteger(item.revision) && item.revision > 0 && /^sha256:[a-f0-9]{64}$/u.test(item.digest))
      : [];
    if (!revisions.some((item) => item.revision === entry.latestRevision)) {
      throw new DkbError(`Registry returned incomplete Collection revision details for ${collectionId}.`);
    }
    const selectedRevision = await this.collectionRevision(collectionId, revision);
    return {
      type: 'collection',
      entry: { ...catalogEntry(entry, 'collection'), revisions },
      selectedRevision: selectedRevision as unknown as DkbRegistryCollectionDetail['selectedRevision'],
    };
  }

  async sourceContents(packageId: string, version: string, options: {
    cursor?: string;
    path?: string;
    perPage?: number;
  } = {}): Promise<DkbRegistrySourceInventoryPage> {
    const query = registryQuery({ cursor: options.cursor, path: options.path, perPage: options.perPage });
    const value = await this.get(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/contents${query}`,
    );
    if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)
      || value.meta.packageId !== packageId || value.meta.version !== version
      || !isRecord(value.meta.sourceInventory)) {
      throw new DkbError(`Registry returned invalid source inventory metadata for ${packageId}@${version}.`);
    }
    const binding = value.meta.sourceInventory;
    if (binding.format !== DKB_SOURCE_INVENTORY_FORMAT
      || binding.mediaType !== DKB_SOURCE_INVENTORY_MEDIA_TYPE
      || typeof binding.hash !== 'string'
      || typeof binding.count !== 'number'
      || typeof binding.bytes !== 'number') {
      throw new DkbError(`Registry returned an invalid signed source inventory binding for ${packageId}@${version}.`);
    }
    const entries = value.data.map((item, index) => {
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.bytes !== 'number' || typeof item.hash !== 'string') {
        throw new DkbError(`Registry returned invalid source inventory entry ${index} for ${packageId}@${version}.`);
      }
      return { path: item.path, bytes: item.bytes, hash: item.hash };
    });
    return {
      packageId,
      version,
      sourceInventory: binding as unknown as DkbRegistrySourceInventoryPage['sourceInventory'],
      entries,
      nextCursor: typeof value.meta.nextCursor === 'string' ? value.meta.nextCursor : null,
    };
  }

  async packageSummary(packageId: string): Promise<DkbRegistryPackageSummary> {
    const data = resourceData(await this.download(packageId));

    if (!data || data.id !== packageId || typeof data.latestVersion !== 'string' || data.latestVersion.length === 0) {
      throw new DkbError(`Registry returned invalid package metadata for ${packageId}.`);
    }

    return {
      id: packageId,
      latestVersion: data.latestVersion,
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      ...(typeof data.description === 'string' ? { description: data.description } : {}),
      ...(typeof data.visibility === 'string' ? { visibility: data.visibility } : {}),
    };
  }

  remoteEndpoints(packageId: string, version: string) {
    return this.get(`/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/remote-endpoints`);
  }

  async verifiedRemoteEndpoint(packageId: string, version: string, endpointUrl?: string) {
    const response = await this.remoteEndpoints(packageId, version);
    const endpoints = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const endpoint = endpoints.find((candidate) => isRecord(candidate)
      && (!endpointUrl || normalizeEndpointUrl(candidate.endpointUrl) === normalizeEndpointUrl(endpointUrl))
      && (candidate.status === 'verified' || candidate.status === 'behind'));

    if (!isRecord(endpoint)) {
      throw new DkbError(`No verified remote runtime is registered for ${packageId}@${version}.`);
    }

    return endpoint;
  }

  claimRemoteEndpoint(packageId: string, version: string, url: string) {
    return this.post(`/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/remote-endpoints`, { url });
  }

  async publish(input: {
    sourcePath: string;
    accountId?: string;
    accountName?: string;
    accountEmail?: string;
    force?: boolean;
    remoteUrl?: string;
    visibility?: 'public' | 'private';
    pipeline?: string;
  }) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-publish-upload-'));
    const archivePath = path.join(tempRoot, `source${DKB_PACKAGE_EXTENSION}`);

    try {
      const dkb = await loadDkb(input.sourcePath);
      await createDkbSourceArchive(input.sourcePath, archivePath);

      await this.ensurePackage({
        id: dkb.manifest.id,
        name: dkb.manifest.name,
        description: dkb.manifest.description,
        visibility: input.visibility ?? 'private',
      });

      const form = new FormData();
      const source = new Blob([await fs.readFile(archivePath)], { type: DKB_SOURCE_ARCHIVE_MEDIA_TYPE });

      form.set('version', dkb.manifest.version);
      form.set('source', source, path.basename(archivePath));
      if (input.pipeline) form.set('pipeline', input.pipeline);

      const version = await this.request('POST', `/api/registry/packages/${identityRoute(dkb.manifest.id)}/versions`, form);

      const published = await this.waitForPublishedVersion(dkb.manifest.id, dkb.manifest.version, version);

      if (input.remoteUrl) {
        try {
          return {
            ...published,
            remote: await this.claimRemoteEndpoint(dkb.manifest.id, dkb.manifest.version, input.remoteUrl),
          };
        } catch (error) {
          return {
            ...published,
            warning: `Package published, but remote endpoint registration failed: ${error instanceof Error ? error.message : String(error)}`,
            retryCommand: `dkb registry remote claim ${dkb.manifest.id}@${dkb.manifest.version} --url ${input.remoteUrl}`,
          };
        }
      }

      return published;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  download(packageId: string, version?: string) {
    if (!version) {
      return this.get(`/api/registry/packages/${identityRoute(packageId)}`);
    }

    return this.get(`/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}`);
  }

  verify(packageId: string, version?: string) {
    return this.download(packageId, version);
  }

  async packageRelease(packageId: string, version?: string): Promise<DkbRegistryRelease> {
    const resolvedVersion = version ?? await this.latestPackageVersion(packageId);
    const data = resourceData(await this.download(packageId, resolvedVersion));

    if (!data || typeof data.version !== 'string' || typeof data.packageId !== 'string') {
      throw new DkbError(`Registry returned invalid release metadata for ${packageId}@${resolvedVersion}.`);
    }

    if (data.packageId !== packageId || data.version !== resolvedVersion) {
      throw new DkbError(
        `Registry release identity mismatch: requested ${packageId}@${resolvedVersion}, `
        + `received ${data.packageId}@${data.version}.`,
      );
    }

    if (data.status !== 'published') {
      throw new DkbError(`Registry release is not installable: ${data.packageId}@${data.version} (${String(data.status ?? 'unknown')}).`);
    }

    return {
      packageId: data.packageId,
      version: data.version,
      status: data.status,
      ...(typeof data.archiveHash === 'string' ? { archiveHash: data.archiveHash } : {}),
      ...(typeof data.packageTreeHash === 'string' ? { packageTreeHash: data.packageTreeHash } : {}),
      ...(typeof data.recordCount === 'number' ? { recordCount: data.recordCount } : {}),
    };
  }

  async installPlan(packageId: string, version?: string, target?: string): Promise<DkbInstallPlan> {
    const resolvedVersion = version ?? await this.latestPackageVersion(packageId);
    const query = target ? `?target=${encodeURIComponent(target)}` : '';
    const value = await this.get(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(resolvedVersion)}/install-plan${query}`,
    );
    const plan = validateInstallPlan(value, `Registry install plan for ${packageId}@${resolvedVersion}`);
    if (plan.package.id !== packageId
      || plan.package.version !== resolvedVersion
      || !(await this.matchesRequestedPipeline(plan, target))) {
      throw new DkbError(`Registry install plan identity or target mismatch for ${packageId}@${resolvedVersion}`);
    }
    return plan;
  }

  async createInstallGrant(
    packageId: string,
    version: string,
    target?: string,
    retrievalBuildDigest?: string,
  ): Promise<DkbRegistryInstallGrant> {
    const value = await this.post(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/install-grant`,
      {
        ...(target ? { target } : {}),
        ...(retrievalBuildDigest ? { retrievalBuildDigest } : {}),
      },
    );
    if (!isRecord(value) || typeof value.installGrant !== 'string' || typeof value.expiresAt !== 'string') {
      throw new DkbError(`Registry returned an invalid Runtime install grant for ${packageId}@${version}.`);
    }
    const plan = validateInstallPlan(value.plan, `Registry Runtime install grant for ${packageId}@${version}`);
    if (plan.package.id !== packageId
      || plan.package.version !== version
      || (retrievalBuildDigest && plan.retrievalBuildDigest !== retrievalBuildDigest)
      || !(await this.matchesRequestedPipeline(plan, target))) {
      throw new DkbError(`Registry Runtime install grant identity, target, or build mismatch for ${packageId}@${version}.`);
    }
    return {
      plan,
      installGrant: value.installGrant,
      expiresAt: value.expiresAt,
    };
  }

  private async matchesRequestedPipeline(plan: DkbInstallPlan, target?: string): Promise<boolean> {
    if (!target || plan.target === target) return true;
    // Preserve the immutable build's signed label. An alias is accepted only
    // when the trusted catalog resolves it to the same complete build recipe.
    const receipt = plan.artifacts.find((artifact) => artifact.kind === 'retrieval')?.receipt;
    const payload = isRecord(receipt) && isRecord(receipt.payload) ? receipt.payload : null;
    const lock = payload && isRecord(payload.profileLock) ? payload.profileLock : null;
    const profile = lock && isRecord(lock.profile) ? lock.profile : null;
    if (!profile || !isSha256Digest(profile.providerBuildDigest)) return false;
    try {
      const selected = (await this.pipelines()).pipelines.find((candidate) => candidate.name === target);
      if (!selected) return false;
      return plan.evidenceProfileDigest === selected.evidenceProfileDigest
        && plan.retrievalProfileDigest === selected.retrievalProfileDigest
        && plan.compatibilityDigest === selected.compatibilityDigest
        && profile.providerBuildDigest === selected.buildDigest;
    } catch {
      return false;
    }
  }

  async requestBuild(packageId: string, version: string, target: string, expected?: {
    retrievalProfileDigest: string;
    compatibilityDigest: string;
  }): Promise<DkbRegistryBuildRequest> {
    const value = await this.post(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/builds`,
      { target, ...expected },
    );
    if (!isRecord(value) || (value.status !== 'queued' && value.status !== 'ready')) {
      throw new DkbError(`Registry returned an invalid build request for ${packageId}@${version} (${target})`);
    }
    if (value.target !== target) {
      throw new DkbError(`Registry build request target mismatch for ${packageId}@${version}: expected ${target}, got ${String(value.target)}`);
    }
    const readyBuild = isRecord(value.build) ? value.build : null;
    const evidenceDigest = typeof value.evidenceDigest === 'string'
      ? value.evidenceDigest
      : typeof readyBuild?.evidenceDigest === 'string' ? readyBuild.evidenceDigest : undefined;
    const retrievalBuildDigest = typeof value.retrievalBuildDigest === 'string'
      ? value.retrievalBuildDigest
      : typeof readyBuild?.retrievalBuildDigest === 'string' ? readyBuild.retrievalBuildDigest : undefined;
    if (value.status === 'ready' && !retrievalBuildDigest) {
      throw new DkbError(`Registry ready build response omitted its exact Retrieval Build digest for ${packageId}@${version} (${target})`);
    }
    return {
      status: value.status,
      target,
      ...(typeof value.jobId === 'number' ? { jobId: value.jobId } : {}),
      ...(evidenceDigest ? { evidenceDigest } : {}),
      ...(retrievalBuildDigest ? { retrievalBuildDigest } : {}),
    };
  }

  async buildJob(packageId: string, version: string, jobId: number): Promise<DkbRegistryBuildJob> {
    const value = await this.get(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/build-jobs/${jobId}`,
    );
    return this.parseBuildJob(value, packageId, version, jobId);
  }

  async cancelBuild(packageId: string, version: string, jobId: number): Promise<DkbRegistryBuildJob> {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new DkbError('Registry build job must be a positive integer.');
    const value = await this.post(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/build-jobs/${jobId}/cancel`,
      {},
    );
    return this.parseBuildJob(value, packageId, version, jobId);
  }

  private parseBuildJob(value: unknown, packageId: string, version: string, jobId: number): DkbRegistryBuildJob {
    if (!isRecord(value)
      || value.jobId !== jobId
      || (value.stage !== 'pipeline' && value.stage !== 'variant' && value.stage !== 'retrieval')
      || typeof value.target !== 'string'
      || !['queued', 'compiling', 'cancelling', 'cancelled', 'published', 'failed', 'revoked'].includes(String(value.status))
      || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) {
      throw new DkbError(`Registry returned invalid build-job status for ${packageId}@${version} (job ${jobId})`);
    }
    return {
      jobId: value.jobId,
      stage: value.stage,
      target: value.target,
      status: String(value.status),
      attempts: Number(value.attempts),
      ...(typeof value.evidenceDigest === 'string' ? { evidenceDigest: value.evidenceDigest } : {}),
      ...(typeof value.retrievalBuildDigest === 'string' ? { retrievalBuildDigest: value.retrievalBuildDigest } : {}),
      ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
    };
  }

  async waitForBuild(packageId: string, version: string, jobId: number, options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {}): Promise<DkbRegistryBuildJob> {
    const timeoutMs = options.timeoutMs
      ?? positiveDuration(process.env.DKB_REGISTRY_BUILD_TIMEOUT_MS, 30 * 60_000);
    const pollIntervalMs = options.pollIntervalMs
      ?? positiveDuration(process.env.DKB_REGISTRY_BUILD_POLL_INTERVAL_MS, 2_000);
    assertPositivePollDuration(timeoutMs, 'Registry build timeout');
    assertPositivePollDuration(pollIntervalMs, 'Registry build poll interval');

    return pollRegistryOperation<DkbRegistryBuildJob, DkbRegistryBuildJob>({
      timeoutMs,
      pollIntervalMs,
      load: () => this.buildJob(packageId, version, jobId),
      evaluate: (job) => {
        if (!job) return { state: 'pending' };
        if (job.status === 'published') return { state: 'complete', value: job };
        if (job.status === 'cancelled') {
          return { state: 'failed', error: new DkbError(`Registry build ${jobId} for ${packageId}@${version} was cancelled. Request a new build to retry.`, 'registry_build_cancelled') };
        }
        if (job.status === 'failed' || job.status === 'revoked') {
          return {
            state: 'failed',
            error: new DkbError(
              `Registry build failed for ${packageId}@${version} (${job.target}): ${job.error ?? job.status}`,
            ),
          };
        }
        return { state: 'pending' };
      },
      timeoutMessage: `Timed out waiting for Registry build ${jobId} for ${packageId}@${version}.`,
    });
  }

  async writeInstallLayer(
    artifact: DkbInstallPlanArtifact,
    targetPath: string,
    options: { progress?: DkbProgressReporter } = {},
  ): Promise<{ path: string; bytes: number; hash: string }> {
    const maximumBytes = positiveByteLimit(
      process.env.DKB_REGISTRY_MAX_LAYER_BYTES,
      16 * 1024 * 1024 * 1024,
    );
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      throw new DkbError(`Registry ${artifact.kind} layer must declare a positive byte size`);
    }
    if (artifact.bytes > maximumBytes) {
      throw new DkbError(
        `Registry ${artifact.kind} layer exceeds the configured ${maximumBytes}-byte download limit: ${artifact.bytes}`,
      );
    }
    const outputPath = path.resolve(targetPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const temporaryPath = siblingTemporaryPath(outputPath, artifact.kind);
    const hash = createHash('sha256');
    let received = 0;
    options.progress?.(progressStart({ phase: `download-${artifact.kind}`, label: `Download ${artifact.kind} layer`, total: artifact.bytes, unit: 'bytes' }));
    try {
      const layerUrl = sameOriginLayerUrl(this.baseUrl, artifact.url);
      const response = await openRegistryDownload(
        layerUrl,
        this.installGrant
          ? { authorization: `DKB-Install-Grant ${this.installGrant}` }
          : this.authorizationHeader(),
        artifact.mediaType,
        positiveDuration(process.env.DKB_REGISTRY_DOWNLOAD_TIMEOUT_MS, 30 * 60_000),
      );
      const contentLengthHeader = response.headers['content-length'];
      const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader;
      if (contentLengthValue !== undefined) {
        const contentLength = /^\d+$/u.test(contentLengthValue) ? Number(contentLengthValue) : Number.NaN;
        if (!Number.isSafeInteger(contentLength) || contentLength !== artifact.bytes) {
          response.resume();
          throw new DkbError(
            `Registry ${artifact.kind} layer Content-Length mismatch: expected ${artifact.bytes}, got ${contentLengthValue}`,
          );
        }
      }
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          received += chunk.byteLength;
          if (received > artifact.bytes) {
            callback(new DkbError(
              `Registry ${artifact.kind} layer exceeded its signed ${artifact.bytes}-byte size`,
            ));
            return;
          }
          options.progress?.(progressUpdate({ phase: `download-${artifact.kind}`, label: `Download ${artifact.kind} layer`, value: received, total: artifact.bytes, unit: 'bytes' }));
          callback(null, chunk);
        },
      });
      await pipeline(response, meter, createWriteStream(temporaryPath, { flags: 'wx' }));
      const digest = `sha256:${hash.digest('hex')}`;
      if (artifact.bytes > 0 && received !== artifact.bytes) {
        throw new DkbError(`Registry ${artifact.kind} layer was incomplete: expected ${artifact.bytes} bytes, received ${received}`);
      }
      if (digest !== artifact.digest) throw new DkbError(`Registry ${artifact.kind} layer hash mismatch: expected ${artifact.digest}, got ${digest}`);
      await fs.rm(outputPath, { force: true });
      await fs.rename(temporaryPath, outputPath);
      options.progress?.(progressFinish({ phase: `download-${artifact.kind}`, label: `Download ${artifact.kind} layer`, total: received, unit: 'bytes' }));
      return { path: outputPath, bytes: received, hash: digest };
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async packageArchive(packageId: string, version?: string, options: { progress?: DkbProgressReporter } = {}): Promise<Buffer> {
    const resolvedVersion = version ?? await this.latestPackageVersion(packageId);

    return this.binary(`/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(resolvedVersion)}/download`, DKB_PACKAGE_MEDIA_TYPE, {
      progress: options.progress,
      progressPhase: 'download',
      progressLabel: 'Download package',
    });
  }

  async writePackageArchive(packageId: string, targetPath: string, version?: string, options: {
    progress?: DkbProgressReporter;
    force?: boolean;
  } = {}): Promise<{
    archivePath: string;
    bytes: number;
    version: string;
    warning?: string;
    cleanupPath?: string;
  }> {
    const archivePath = path.resolve(targetPath);

    if (!options.force && await exists(archivePath)) {
      throw new DkbError(`Output archive already exists: ${archivePath}. Use --force to replace it.`);
    }

    const resolvedVersion = version ?? await this.latestPackageVersion(packageId);
    const response = await this.binaryResponse(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(resolvedVersion)}/download`,
      DKB_PACKAGE_MEDIA_TYPE,
    );
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const knownTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    const reader = response.body?.getReader();

    if (!reader) {
      throw new DkbError('Registry package response did not contain a readable body.');
    }

    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    const temporaryPath = siblingTemporaryPath(archivePath, 'download');
    const output = await fs.open(temporaryPath, 'wx');
    let received = 0;

    options.progress?.(progressStart({
      phase: 'download',
      label: 'Download package',
      total: knownTotal,
      unit: 'bytes',
    }));

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          let offset = 0;

          while (offset < value.byteLength) {
            const { bytesWritten } = await output.write(value, offset, value.byteLength - offset, null);

            if (bytesWritten <= 0) {
              throw new DkbError(`Unable to write package archive: ${archivePath}`);
            }
            offset += bytesWritten;
          }
          received += value.byteLength;
          options.progress?.(progressUpdate({
            phase: 'download',
            label: 'Download package',
            value: received,
            total: knownTotal,
            unit: 'bytes',
          }));
        }
      }
      await output.close();
    } catch (error) {
      await output.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    if (knownTotal > 0 && received !== knownTotal) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new DkbError(`Registry package download was incomplete: expected ${knownTotal} bytes, received ${received}.`);
    }

    let promotion: { warning?: string; cleanupPath?: string };

    try {
      promotion = await promoteDownloadedFile(temporaryPath, archivePath, Boolean(options.force));
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    options.progress?.(progressFinish({
      phase: 'download',
      label: 'Download package',
      total: knownTotal || received,
      unit: 'bytes',
    }));

    return {
      archivePath,
      bytes: received,
      version: resolvedVersion,
      ...promotion,
    };
  }

  rotateAccountKey(accountId: string) {
    return this.post(`/api/accounts/${encodeURIComponent(accountId)}/keys/rotate`, {});
  }

  rotateRegistryKey() {
    return this.post('/api/registry/keys/rotate', {});
  }

  revokeKey(keyId: string) {
    return this.post(`/api/keys/${encodeURIComponent(keyId)}/revoke`, {});
  }

  collections() {
    return this.get('/api/registry/collections');
  }

  collection(collectionId: string) {
    return this.get(`/api/registry/collections/${identityRoute(collectionId)}`);
  }

  async entryKind(identity: string): Promise<'dkb' | 'collection'> {
    let packageError: unknown;
    try {
      const data = resourceData(await this.download(identity));
      if (data?.id === identity) return 'dkb';
    } catch (error) {
      packageError = error;
    }

    try {
      const data = resourceData(await this.collection(identity));
      if (data?.id === identity) return 'collection';
    } catch (collectionError) {
      const packageMessage = packageError instanceof Error ? packageError.message : String(packageError ?? 'not found');
      const collectionMessage = collectionError instanceof Error ? collectionError.message : String(collectionError);
      throw new DkbError(`Registry entry ${identity} was not found as a DKB or Collection. DKB: ${packageMessage} Collection: ${collectionMessage}`);
    }

    throw new DkbError(`Registry entry ${identity} returned invalid metadata.`);
  }

  async collectionRevision(collectionId: string, revision?: number): Promise<DkbRegistryCollectionRevision> {
    const selector = revision === undefined ? 'latest' : String(revision);
    const data = resourceData(await this.get(`/api/registry/collections/${identityRoute(collectionId)}/revisions/${selector}`));

    if (!data || data.collectionId !== collectionId || typeof data.revision !== 'number'
      || typeof data.digest !== 'string' || !isCollectionManifest(data.manifest)) {
      throw new DkbError(`Registry returned invalid Collection revision for ${collectionId}@${selector}.`);
    }

    return data as unknown as DkbRegistryCollectionRevision;
  }

  async publishCollection(input: {
    id: string;
    name: string;
    description?: string;
    visibility?: 'public' | 'private' | 'unlisted';
    members: Array<{ id: string; version: string }>;
  }): Promise<DkbRegistryCollectionRevision> {
    await this.ensureCollection(input);
    const data = resourceData(await this.post(
      `/api/registry/collections/${identityRoute(input.id)}/revisions`,
      { members: input.members },
    ));

    if (!data || data.collectionId !== input.id || typeof data.revision !== 'number'
      || typeof data.digest !== 'string' || !isCollectionManifest(data.manifest)) {
      throw new DkbError(`Registry returned invalid published Collection revision for ${input.id}.`);
    }

    return data as unknown as DkbRegistryCollectionRevision;
  }

  private get(path: string) {
    return this.request('GET', path);
  }

  private post(path: string, body: unknown) {
    return this.request('POST', path, body);
  }

  private async request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<unknown> {
    const requestHeaders = {
      ...this.authorizationHeader(),
      ...(headers ?? (body === undefined || body instanceof FormData ? undefined : { 'content-type': 'application/json' })),
    };
    const response = await this.fetchRegistry(path, {
      method,
      headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
      body: body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body as unknown as BodyInit
          : body instanceof FormData
            ? body
          : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      throw registryHttpError(this.baseUrl, response.status, method, path, parsed, response.headers);
    }

    if (text && parsed === null) {
      throw new DkbError(`Registry returned invalid JSON for ${method} ${path}.`);
    }

    return parsed;
  }

  private async binary(path: string, expectedContentType: string, options: {
    progress?: DkbProgressReporter;
    progressPhase?: string;
    progressLabel?: string;
  } = {}): Promise<Buffer> {
    const response = await this.binaryResponse(path, expectedContentType);

    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);

    if (!response.body || !Number.isFinite(contentLength) || contentLength <= 0 || !options.progress) {
      return Buffer.from(await response.arrayBuffer());
    }

    options.progress(progressStart({
      phase: options.progressPhase ?? 'download',
      label: options.progressLabel ?? 'Download',
      total: contentLength,
      unit: 'bytes',
    }));

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        chunks.push(value);
        received += value.byteLength;
        options.progress(progressUpdate({
          phase: options.progressPhase ?? 'download',
          label: options.progressLabel ?? 'Download',
          value: received,
          total: contentLength,
          unit: 'bytes',
        }));
      }
    }

    options.progress(progressFinish({
      phase: options.progressPhase ?? 'download',
      label: options.progressLabel ?? 'Download',
      total: contentLength,
      unit: 'bytes',
    }));

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  private async binaryResponse(requestPath: string, expectedContentType: string): Promise<Response> {
    const response = await this.fetchRegistry(requestPath, {
      headers: this.authorizationHeader(),
    });

    if (!response.ok) {
      const text = await response.text();
      const parsed = parseJson(text);
      throw registryHttpError(this.baseUrl, response.status, 'GET', requestPath, parsed, response.headers);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.startsWith(expectedContentType)) {
      throw new DkbError(`Registry returned unexpected package content type: ${contentType || 'missing'}`);
    }

    return response;
  }

  private async fetchRegistry(requestPath: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${requestPath}`, init);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      throw new DkbError(`Unable to reach registry ${this.baseUrl}: ${detail}`);
    }
  }

  private async ensurePackage(input: { id: string; name: string; description?: string; visibility: 'public' | 'private' }) {
    const response = await this.fetchRegistry('/api/registry/packages', {
      method: 'POST',
      headers: {
        ...this.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        description: input.description,
        visibility: input.visibility,
      }),
    });

    if (response.ok) {
      return;
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (response.status === 422 && await this.packageAlreadyExists(input.id)) {
      return;
    }

    throw registryHttpError(this.baseUrl, response.status, 'POST', '/api/registry/packages', parsed, response.headers);
  }

  private async packageAlreadyExists(packageId: string): Promise<boolean> {
    try {
      const existing = resourceData(await this.download(packageId));

      return existing?.id === packageId || existing?.packageId === packageId || existing?.slug === packageId;
    } catch {
      return false;
    }
  }

  private async ensureCollection(input: { id: string; name: string; description?: string; visibility?: 'public' | 'private' | 'unlisted' }): Promise<void> {
    const response = await this.fetchRegistry('/api/registry/collections', {
      method: 'POST',
      headers: {
        ...this.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (response.ok) return;

    const text = await response.text();
    const parsed = parseJson(text);

    if (response.status === 422) {
      try {
        const existing = resourceData(await this.collection(input.id));
        if (existing?.id === input.id) return;
      } catch {
        // Surface the original reservation error below.
      }
    }

    throw registryHttpError(this.baseUrl, response.status, 'POST', '/api/registry/collections', parsed, response.headers);
  }

  private async waitForPublishedVersion(packageId: string, version: string, initial: unknown) {
    const timeoutMs = positiveDuration(process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS, 30 * 60_000);
    const pollIntervalMs = positiveDuration(process.env.DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS, 2_000);

    return pollRegistryOperation<unknown, ReturnType<typeof normalizePublishResult>>({
      initial,
      timeoutMs,
      pollIntervalMs,
      load: () => this.download(packageId, version),
      evaluate: (latest) => {
        const status = versionStatus(latest);
        if (status === 'published') {
          return { state: 'complete', value: normalizePublishResult(packageId, version, latest) };
        }
        if (status === 'failed' || status === 'revoked' || status === 'cancelled') {
          return {
            state: 'failed',
            error: new DkbError(
              `Registry publish failed for ${packageId}@${version}: ${versionFailure(latest) ?? status}`,
            ),
          };
        }
        return { state: 'pending' };
      },
      timeoutMessage: `Timed out waiting for registry publish: ${packageId}@${version}.`,
    });
  }

  async latestPackageVersion(packageId: string): Promise<string> {
    return (await this.packageSummary(packageId)).latestVersion;
  }

  private authorizationHeader(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }
}

async function openRegistryDownload(
  url: URL,
  headers: Record<string, string>,
  expectedContentType: string,
  timeoutMs: number,
  redirects = 0,
  deadline = Date.now() + timeoutMs,
): Promise<IncomingMessage> {
  const response = await requestRegistryDownload(url, headers, timeoutMs, deadline);
  const status = response.statusCode ?? 0;
  const location = response.headers.location;

  if ([301, 302, 303, 307, 308].includes(status) && location) {
    response.resume();
    if (redirects >= 5) throw new DkbError(`Registry layer download exceeded 5 redirects: ${url}`);
    const destination = new URL(location, url);
    if (url.protocol === 'https:' && destination.protocol !== 'https:') {
      throw new DkbError(`Registry layer download refused an HTTPS downgrade: ${destination}`);
    }
    return openRegistryDownload(
      destination,
      destination.origin === url.origin ? headers : {},
      expectedContentType,
      timeoutMs,
      redirects + 1,
      deadline,
    );
  }

  if (status < 200 || status >= 300) {
    const detail = await readNativeResponseText(response);
    throw new DkbError(detail || `GET ${url.pathname} failed with HTTP ${status}`);
  }

  const header = response.headers['content-type'];
  const contentType = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  if (!contentType.startsWith(expectedContentType)) {
    response.resume();
    throw new DkbError(`Registry returned unexpected package content type: ${contentType || 'missing'}`);
  }

  return response;
}

async function requestRegistryDownload(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  deadline: number,
): Promise<IncomingMessage> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DkbError(`Registry layer download requires HTTP or HTTPS: ${url}`);
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const timeoutError = () => new DkbError(`Registry layer download timed out after ${timeoutMs} ms: ${url}`);
    const pending = request(url, { method: 'GET', headers });
    const requestTimer = setTimeout(() => pending.destroy(timeoutError()), Math.max(1, deadline - Date.now()));
    pending.once('error', (error) => {
      clearTimeout(requestTimer);
      reject(error);
    });
    pending.once('response', (response) => {
      clearTimeout(requestTimer);
      const responseTimer = setTimeout(() => response.destroy(timeoutError()), Math.max(1, deadline - Date.now()));
      const clearResponseTimer = () => clearTimeout(responseTimer);
      response.once('end', clearResponseTimer);
      response.once('close', clearResponseTimer);
      resolve(response);
    });
    pending.end();
  });
}

async function readNativeResponseText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes < 64 * 1024) chunks.push(chunk.subarray(0, 64 * 1024 - bytes));
    bytes += chunk.byteLength;
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveByteLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sameOriginLayerUrl(baseUrl: string, relativeUrl: string): URL {
  if (!relativeUrl.startsWith('/') || relativeUrl.startsWith('//') || relativeUrl.includes('\\')) {
    throw new DkbError(`Registry layer URL must be a same-origin absolute path: ${relativeUrl}`);
  }
  const base = new URL(`${baseUrl}/`);
  const resolved = new URL(relativeUrl, base);
  if (resolved.origin !== base.origin) {
    throw new DkbError(`Registry layer URL crosses Registry origins: ${relativeUrl}`);
  }
  return resolved;
}

function assertPositivePollDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DkbError(`${label} must be a positive duration in milliseconds.`);
  }
}

type RegistryPollDecision<Result> =
  | { state: 'pending' }
  | { state: 'complete'; value: Result }
  | { state: 'failed'; error: Error };

async function pollRegistryOperation<Value, Result>(options: {
  initial?: Value;
  timeoutMs: number;
  pollIntervalMs: number;
  load(): Promise<Value>;
  evaluate(value: Value | undefined): RegistryPollDecision<Result>;
  timeoutMessage: string;
}): Promise<Result> {
  const deadline = Date.now() + options.timeoutMs;
  let latest = options.initial;
  let nextDelayMs = options.pollIntervalMs;
  let consecutiveTransientFailures = 0;
  let lastTransientError: string | undefined;

  while (true) {
    const decision = options.evaluate(latest);
    if (decision.state === 'complete') return decision.value;
    if (decision.state === 'failed') throw decision.error;

    const wakeAt = Math.min(deadline, Date.now() + nextDelayMs);
    let remainingMs = wakeAt - Date.now();
    // An early timer wakeup must not make a rate-limited request eligible again.
    while (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
      remainingMs = wakeAt - Date.now();
    }
    if (wakeAt === deadline || Date.now() >= deadline) break;

    try {
      latest = await options.load();
      consecutiveTransientFailures = 0;
      lastTransientError = undefined;
      nextDelayMs = options.pollIntervalMs;
    } catch (error) {
      const transient = registryPollTransientFailure(
        error,
        options.pollIntervalMs,
        consecutiveTransientFailures + 1,
      );
      if (!transient) throw error;
      consecutiveTransientFailures += 1;
      lastTransientError = transient.message;
      nextDelayMs = transient.retryDelayMs;
    }
  }

  const detail = lastTransientError ? ` Last transient error: ${lastTransientError}` : '';
  throw new DkbError(`${options.timeoutMessage}${detail}`);
}

function registryPollTransientFailure(
  error: unknown,
  pollIntervalMs: number,
  consecutiveFailures: number,
): { message: string; retryDelayMs: number } | null {
  if (!(error instanceof DkbRegistryHttpError && error.status === 429)
      && !isTransientRegistryConnectionError(error)) {
    return null;
  }

  const exponent = Math.min(consecutiveFailures, 4);
  const backoffMs = Math.max(
    pollIntervalMs,
    Math.min(pollIntervalMs * (2 ** exponent), 30_000),
  );
  const retryDelayMs = error instanceof DkbRegistryHttpError && error.retryAfterMs !== undefined
    ? Math.max(pollIntervalMs, error.retryAfterMs)
    : backoffMs;

  return {
    message: error instanceof Error ? error.message : String(error),
    retryDelayMs,
  };
}

function isTransientRegistryConnectionError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Unable to reach registry ');
}

function identityRoute(identity: string): string {
  const parsed = parseDkbIdentity(identity, 'Registry identity');

  return `${encodeURIComponent(parsed.namespace)}/${encodeURIComponent(parsed.name)}`;
}

function isCollectionManifest(value: unknown): value is DkbRegistryCollectionRevision['manifest'] {
  return isRecord(value)
    && value.type === 'collection'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.revision === 'number'
    && typeof value.digest === 'string'
    && Array.isArray(value.members)
    && value.members.every((member) => isRecord(member)
      && typeof member.id === 'string'
      && typeof member.version === 'string'
      && typeof member.digest === 'string');
}

export async function writeArchiveFileFromPath(sourcePath: string, targetPath: string, options: { force?: boolean } = {}): Promise<{
  archivePath: string;
  bytes: number;
  warning?: string;
  cleanupPath?: string;
}> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);

  if (!options.force && await exists(target)) {
    throw new DkbError(`Output archive already exists: ${target}. Use --force to replace it.`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = siblingTemporaryPath(target, 'copy');

  let promotion: { warning?: string; cleanupPath?: string };

  try {
    await fs.copyFile(source, temporaryPath);
    promotion = await promoteDownloadedFile(temporaryPath, target, Boolean(options.force));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    archivePath: target,
    bytes: (await fs.stat(target)).size,
    ...promotion,
  };
}

function parseRegistryPipeline(value: unknown, index: number): DkbRegistryPipeline {
  if (!isRecord(value)
      || typeof value.name !== 'string'
      || typeof value.default !== 'boolean'
      || typeof value.available !== 'boolean'
      || !Array.isArray(value.providers)
      || !Array.isArray(value.processors)
      || !Array.isArray(value.requiredServices)
      || !Array.isArray(value.health)) {
    throw new DkbError(`Registry returned an invalid Pipeline at position ${index + 1}.`);
  }
  const digestFields = ['buildDigest', 'evidenceProfileDigest', 'retrievalProfileDigest', 'compatibilityDigest'] as const;
  if (value.resolutionError !== undefined) {
    const error = value.resolutionError;
    const health = pipelineHealth(value.health);
    if (value.available !== false || !digestFields.every((field) => value[field] === null)
        || value.chains !== null || value.providers.length !== 0 || value.processors.length !== 0
        || value.requiredServices.length !== 0 || !Array.isArray(value.serviceRequirements) || value.serviceRequirements.length !== 0
        || !isRecord(error) || Object.keys(error).some((key) => !['code', 'message'].includes(key))
        || error.code !== 'pipeline_resolution_failed' || error.message !== DKB_PIPELINE_RESOLUTION_MESSAGE
        || health.length !== 1 || health[0]?.ok !== false || health[0].id !== value.name || health[0].kind !== 'pipeline'
        || health[0].detail !== DKB_PIPELINE_RESOLUTION_MESSAGE) {
      throw new DkbError(`Registry Pipeline ${value.name} has invalid unresolved metadata.`);
    }
    return {
      name: value.name, default: value.default, available: false, providers: [], processors: [], chains: null,
      buildDigest: null, evidenceProfileDigest: null, retrievalProfileDigest: null, compatibilityDigest: null,
      requiredServices: [], serviceRequirements: [], health, compilerBuildDigest: pipelineDigest(value.compilerBuildDigest),
      resolutionError: { code: 'pipeline_resolution_failed', message: error.message },
    };
  }
  for (const field of digestFields) {
    if (!isSha256Digest(value[field])) {
      throw new DkbError(`Registry Pipeline ${value.name} has an invalid ${field}.`);
    }
  }
  const providers = value.providers.map((provider, providerIndex) => {
    if (!isRecord(provider)
        || typeof provider.id !== 'string'
        || typeof provider.version !== 'string'
        || typeof provider.kind !== 'string'
        || !isSha256Digest(provider.integrityDigest)) {
      throw new DkbError(`Registry Pipeline ${value.name} has an invalid provider at position ${providerIndex + 1}.`);
    }
    return {
      id: provider.id,
      version: provider.version,
      kind: provider.kind,
      integrityDigest: provider.integrityDigest,
      integrity: providerIntegrity(provider.integrity, provider.id, provider.version),
      source: parsePipelineSource(provider.source), sourceDigest: pipelineDigest(provider.sourceDigest),
    };
  });
  const processors = value.processors.map((processor, processorIndex) => {
    if (!isRecord(processor)
        || typeof processor.id !== 'string'
        || typeof processor.version !== 'string'
        || typeof processor.stage !== 'string'
        || !isSha256Digest(processor.integrityDigest)) {
      throw new DkbError(`Registry Pipeline ${value.name} has an invalid processor at position ${processorIndex + 1}.`);
    }
    return {
      id: processor.id,
      version: processor.version,
      stage: processor.stage,
      integrityDigest: processor.integrityDigest,
      integrity: providerIntegrity(processor.integrity, processor.id, processor.version),
      order: parseProcessorOrder(processor.order),
      source: parsePipelineSource(processor.source), sourceDigest: pipelineDigest(processor.sourceDigest),
    };
  });
  if (!value.requiredServices.every((service) => typeof service === 'string')) {
    throw new DkbError(`Registry Pipeline ${value.name} has invalid service requirements.`);
  }
  return {
    name: value.name,
    default: value.default,
    available: value.available,
    providers,
    processors,
    buildDigest: value.buildDigest,
    evidenceProfileDigest: value.evidenceProfileDigest,
    retrievalProfileDigest: value.retrievalProfileDigest,
    compatibilityDigest: value.compatibilityDigest,
    requiredServices: value.requiredServices,
    health: pipelineHealth(value.health),
    compilerBuildDigest: pipelineDigest(value.compilerBuildDigest),
    chains: pipelineChains(value.chains),
    serviceRequirements: pipelineServices(value.serviceRequirements),
  };
}

function parseProcessorOrder(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DkbError('Registry Pipeline processor order is invalid.');
  return value as number;
}

function parsePipelineSource(value: unknown): import('@sjshovan/dkb-protocol/retrievalProfile.js').DkbPluginReceiptSource {
  if (value !== 'local' && value !== 'global' && value !== 'bundled') throw new DkbError('Registry Pipeline provider origin is invalid.');
  return value;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function parseJson(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeEndpointUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function resourceData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const data = (value as { data?: unknown }).data;

  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

function registryQuery(values: Record<string, string | number | undefined>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  }
  const query = parameters.toString();
  return query ? `?${query}` : '';
}

function parseCatalogPage(value: unknown, type: 'dkb' | 'collection'): {
  entries: DkbRegistryCatalogEntry[];
  meta: DkbRegistryPageMeta;
} {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) {
    throw new DkbError(`Registry returned an invalid ${type} catalog page.`);
  }
  return {
    entries: value.data.map((item) => catalogEntry(item, type)),
    meta: {
      currentPage: numberField(value.meta, 'current_page', `${type} catalog pagination`),
      perPage: numberField(value.meta, 'per_page', `${type} catalog pagination`),
      lastPage: numberField(value.meta, 'last_page', `${type} catalog pagination`),
      total: numberField(value.meta, 'total', `${type} catalog pagination`),
    },
  };
}

function catalogEntry(value: unknown, type: 'dkb' | 'collection'): DkbRegistryCatalogEntry {
  if (!isRecord(value)
      || typeof value.id !== 'string'
      || typeof value.namespace !== 'string'
      || typeof value.name !== 'string'
      || typeof value.slug !== 'string'
      || (value.visibility !== 'public' && value.visibility !== 'private' && value.visibility !== 'unlisted')) {
    throw new DkbError(`Registry returned invalid ${type} catalog metadata.`);
  }
  return {
    type,
      id: value.id,
      namespace: value.namespace,
      name: value.name,
      slug: value.slug,
    ...(typeof value.description === 'string' || value.description === null ? { description: value.description } : {}),
    visibility: value.visibility,
    ...(type === 'dkb' && (typeof value.latestVersion === 'string' || value.latestVersion === null)
      ? { latestVersion: value.latestVersion } : {}),
    ...(type === 'collection' && (typeof value.latestRevision === 'number' || value.latestRevision === null)
      ? { latestRevision: value.latestRevision } : {}),
    ...(typeof value.publishedAt === 'string' || value.publishedAt === null ? { publishedAt: value.publishedAt } : {}),
  };
}

function numberField(record: Record<string, unknown>, key: string, source: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DkbError(`Registry returned invalid ${source}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function registryHttpError(
  baseUrl: string,
  status: number,
  method: string,
  requestPath: string,
  parsed: unknown,
  headers?: Headers,
): DkbRegistryHttpError {
  const retryAfterMs = parseRetryAfterMilliseconds(headers?.get('retry-after'));
  if (status === 401) {
    return new DkbRegistryHttpError(
      `Registry authentication failed for ${baseUrl}. Run: dkb registry login --url ${baseUrl}`,
      'DKB_ERROR',
      status,
      retryAfterMs,
    );
  }

  if (status === 403) {
    return new DkbRegistryHttpError(
      `Registry credential for ${baseUrl} lacks permission for ${method} ${requestPath}. `
      + `Issue a token with the required scope, then run: dkb registry login --url ${baseUrl}`,
      'DKB_ERROR',
      status,
      retryAfterMs,
    );
  }

  const errorCode = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : 'REGISTRY_HTTP_ERROR';
  const message = isRecord(parsed) && 'message' in parsed
    ? String(parsed.message)
    : errorCode !== 'REGISTRY_HTTP_ERROR'
      ? errorCode
      : `${method} ${requestPath} failed with HTTP ${status}`;
  return new DkbRegistryHttpError(message, errorCode, status, retryAfterMs);
}

function parseRetryAfterMilliseconds(value: string | null | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number.parseInt(normalized, 10);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }

  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function versionStatus(value: unknown): string | null {
  const data = resourceData(value);

  return typeof data?.status === 'string' ? data.status : null;
}

function versionFailure(value: unknown): string | null {
  const data = resourceData(value);

  return typeof data?.failureReason === 'string' ? data.failureReason : null;
}

function normalizePublishResult(packageId: string, version: string, value: unknown) {
  const data = resourceData(value);

  return {
    status: 'published',
    packageId,
    version,
    archiveHash: data?.archiveHash,
    payloadHash: data?.payloadHash,
    compiled: {
      recordCount: data?.recordCount,
    },
  };
}

function siblingTemporaryPath(targetPath: string, purpose: string): string {
  return `${targetPath}.${purpose}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function promoteDownloadedFile(temporaryPath: string, targetPath: string, force: boolean): Promise<{
  warning?: string;
  cleanupPath?: string;
}> {
  if (!force) {
    try {
      await fs.link(temporaryPath, targetPath);
      try {
        await fs.rm(temporaryPath, { force: true });
        return {};
      } catch {
        return {
          warning: `Archive was written, but its temporary file could not be removed: ${temporaryPath}`,
          cleanupPath: temporaryPath,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DkbError(`Output archive already exists: ${targetPath}. Use --force to replace it.`);
      }

      throw error;
    }
  }

  const backupPath = siblingTemporaryPath(targetPath, 'backup');
  let backupCreated = false;

  try {
    await fs.rename(targetPath, backupPath);
    backupCreated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    if (backupCreated) {
      try {
        await fs.rename(backupPath, targetPath);
      } catch (restoreError) {
        throw new DkbError(
          `Unable to replace ${targetPath}, and the previous archive could not be restored. `
          + `It is preserved at ${backupPath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }

    throw error;
  }

  if (backupCreated) {
    try {
      await fs.rm(backupPath, { force: true });
    } catch {
      return {
        warning: `Archive was replaced, but its previous backup could not be removed: ${backupPath}`,
        cleanupPath: backupPath,
      };
    }
  }

  return {};
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
