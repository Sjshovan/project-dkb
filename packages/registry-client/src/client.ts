import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DkbError } from '@dkb/protocol/errors.js';
import { validateInstallPlan, type DkbInstallPlan, type DkbInstallPlanArtifact } from '@dkb/protocol/builds.js';
import { parseDkbIdentity } from '@dkb/protocol/identity.js';
import { loadDkb } from '@dkb/protocol/manifest.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@dkb/protocol/progress.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, DKB_PACKAGE_MEDIA_TYPE, DKB_SOURCE_ARCHIVE_MEDIA_TYPE } from './archive.js';
import { DEFAULT_REGISTRY_URL, normalizeRegistryUrl } from './config.js';

export interface DkbRegistryClientOptions {
  baseUrl?: string;
  token?: string;
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
}

export interface DkbRegistryBuildJob {
  jobId: number;
  stage: 'pipeline' | 'retrieval';
  target: string;
  status: string;
  attempts: number;
  evidenceDigest?: string;
  retrievalBuildDigest?: string;
  error?: string;
}

export class DkbRegistryClient {
  readonly baseUrl: string;
  readonly token?: string;

  constructor(options: DkbRegistryClientOptions = {}) {
    this.baseUrl = normalizeRegistryUrl(options.baseUrl ?? process.env.DKB_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
    this.token = options.token ?? process.env.DKB_REGISTRY_TOKEN;
  }

  health() {
    return this.get('/health');
  }

  publicKeys() {
    return this.get('/.well-known/dkb-registry-keys.json');
  }

  packages() {
    return this.get('/api/registry/packages');
  }

  searchPackages(query?: string) {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : '';

    return this.get(`/api/registry/packages${suffix}`);
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
  }) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-publish-upload-'));
    const archivePath = path.join(tempRoot, `source${DKB_PACKAGE_EXTENSION}`);

    try {
      const dkb = await loadDkb(input.sourcePath);
      await createDkbPackageArchive(input.sourcePath, archivePath);

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
    if (plan.package.id !== packageId || plan.package.version !== resolvedVersion) {
      throw new DkbError(`Registry install plan identity mismatch for ${packageId}@${resolvedVersion}`);
    }
    return plan;
  }

  async requestBuild(packageId: string, version: string, target: string): Promise<DkbRegistryBuildRequest> {
    const value = await this.post(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/builds`,
      { target },
    );
    if (!isRecord(value) || (value.status !== 'queued' && value.status !== 'ready')) {
      throw new DkbError(`Registry returned an invalid build request for ${packageId}@${version} (${target})`);
    }
    return {
      status: value.status,
      target,
      ...(typeof value.jobId === 'number' ? { jobId: value.jobId } : {}),
      ...(typeof value.evidenceDigest === 'string' ? { evidenceDigest: value.evidenceDigest } : {}),
    };
  }

  async buildJob(packageId: string, version: string, jobId: number): Promise<DkbRegistryBuildJob> {
    const value = await this.get(
      `/api/registry/packages/${identityRoute(packageId)}/versions/${encodeURIComponent(version)}/build-jobs/${jobId}`,
    );
    if (!isRecord(value)
      || typeof value.jobId !== 'number'
      || (value.stage !== 'pipeline' && value.stage !== 'retrieval')
      || typeof value.target !== 'string'
      || typeof value.status !== 'string'
      || typeof value.attempts !== 'number') {
      throw new DkbError(`Registry returned invalid build-job status for ${packageId}@${version} (job ${jobId})`);
    }
    return {
      jobId: value.jobId,
      stage: value.stage,
      target: value.target,
      status: value.status,
      attempts: value.attempts,
      ...(typeof value.evidenceDigest === 'string' ? { evidenceDigest: value.evidenceDigest } : {}),
      ...(typeof value.retrievalBuildDigest === 'string' ? { retrievalBuildDigest: value.retrievalBuildDigest } : {}),
      ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
    };
  }

  async writeInstallLayer(
    artifact: DkbInstallPlanArtifact,
    targetPath: string,
    options: { progress?: DkbProgressReporter } = {},
  ): Promise<{ path: string; bytes: number; hash: string }> {
    const outputPath = path.resolve(targetPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const temporaryPath = siblingTemporaryPath(outputPath, artifact.kind);
    const hash = createHash('sha256');
    let received = 0;
    options.progress?.(progressStart({ phase: `download-${artifact.kind}`, label: `Download ${artifact.kind} layer`, total: artifact.bytes, unit: 'bytes' }));
    try {
      const response = await openRegistryDownload(
        new URL(artifact.url, `${this.baseUrl}/`),
        this.authorizationHeader(),
        artifact.mediaType,
        positiveDuration(process.env.DKB_REGISTRY_DOWNLOAD_TIMEOUT_MS, 30 * 60_000),
      );
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          received += chunk.byteLength;
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
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `${method} ${path} failed with HTTP ${response.status}`;

      throw new DkbError(message);
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
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `GET ${requestPath} failed with HTTP ${response.status}`;

      throw new DkbError(message);
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
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : `POST /api/registry/packages failed with HTTP ${response.status}`;

    if (response.status === 422 && await this.packageAlreadyExists(input.id)) {
      return;
    }

    throw new DkbError(message);
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
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : `POST /api/registry/collections failed with HTTP ${response.status}`;

    if (response.status === 422) {
      try {
        const existing = resourceData(await this.collection(input.id));
        if (existing?.id === input.id) return;
      } catch {
        // Surface the original reservation error below.
      }
    }

    throw new DkbError(message);
  }

  private async waitForPublishedVersion(packageId: string, version: string, initial: unknown) {
    const timeoutMs = positiveDuration(process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS, 30 * 60_000);
    const pollIntervalMs = positiveDuration(process.env.DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS, 2_000);
    const started = Date.now();
    let latest = initial;
    let lastTransientError: string | undefined;

    while (Date.now() - started < timeoutMs) {
      const status = versionStatus(latest);

      if (status === 'published') {
        return normalizePublishResult(packageId, version, latest);
      }

      if (status === 'failed' || status === 'revoked') {
        throw new DkbError(`Registry publish failed for ${packageId}@${version}: ${versionFailure(latest) ?? status}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      try {
        latest = await this.download(packageId, version);
        lastTransientError = undefined;
      } catch (error) {
        if (!isTransientRegistryConnectionError(error)) {
          throw error;
        }

        lastTransientError = error.message;
      }
    }

    const detail = lastTransientError ? ` Last connection error: ${lastTransientError}` : '';
    throw new DkbError(`Timed out waiting for registry publish: ${packageId}@${version}.${detail}`);
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
): Promise<IncomingMessage> {
  const response = await requestRegistryDownload(url, headers, timeoutMs);
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
): Promise<IncomingMessage> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DkbError(`Registry layer download requires HTTP or HTTPS: ${url}`);
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const pending = request(url, { method: 'GET', headers }, resolve);
    pending.once('error', reject);
    pending.setTimeout(timeoutMs, () => {
      pending.destroy(new DkbError(`Registry layer download timed out after ${timeoutMs} ms: ${url}`));
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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
