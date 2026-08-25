import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '../protocol/errors.js';
import { loadDkb } from '../protocol/manifest.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '../progress.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, DKB_PACKAGE_MEDIA_TYPE, DKB_SOURCE_ARCHIVE_MEDIA_TYPE } from './archive.js';
import { DEFAULT_REGISTRY_URL, normalizeRegistryUrl } from './config.js';

export interface DkbRegistryClientOptions {
  baseUrl?: string;
  token?: string;
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

  login(input: { accountId?: string; name?: string; email?: string }) {
    return this.post('/api/login', input);
  }

  packages() {
    return this.get('/api/registry/packages');
  }

  searchPackages(query?: string) {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : '';

    return this.get(`/api/registry/packages${suffix}`);
  }

  remoteEndpoints(packageId: string, version: string) {
    return this.get(`/api/registry/packages/${encodeURIComponent(packageId)}/versions/${encodeURIComponent(version)}/remote-endpoints`);
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
    return this.post(`/api/registry/packages/${encodeURIComponent(packageId)}/versions/${encodeURIComponent(version)}/remote-endpoints`, { url });
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

      const version = await this.request('POST', `/api/registry/packages/${encodeURIComponent(dkb.manifest.id)}/versions`, form);

      const published = await this.waitForPublishedVersion(dkb.manifest.id, dkb.manifest.version, version);

      if (input.remoteUrl) {
        try {
          return {
            ...published,
            remote: await this.claimRemoteEndpoint(dkb.manifest.id, dkb.manifest.version, input.remoteUrl),
          };
        } catch (error) {
          throw new DkbError(`Package published, but remote endpoint registration failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return published;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  download(packageId: string, version?: string) {
    if (!version) {
      return this.get(`/api/registry/packages/${encodeURIComponent(packageId)}`);
    }

    return this.get(`/api/registry/packages/${encodeURIComponent(packageId)}/versions/${encodeURIComponent(version)}`);
  }

  verify(packageId: string, version?: string) {
    return this.download(packageId, version);
  }

  async packageArchive(packageId: string, version?: string, options: { progress?: DkbProgressReporter } = {}): Promise<Buffer> {
    const resolvedVersion = version ?? await this.latestVersion(packageId);

    return this.binary(`/api/registry/packages/${encodeURIComponent(packageId)}/versions/${encodeURIComponent(resolvedVersion)}/download`, DKB_PACKAGE_MEDIA_TYPE, {
      progress: options.progress,
      progressPhase: 'download',
      progressLabel: 'Download package',
    });
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
    const response = await fetch(`${this.baseUrl}${path}`, {
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
    const parsed = text ? JSON.parse(text) as unknown : null;

    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `${method} ${path} failed with HTTP ${response.status}`;

      throw new DkbError(message);
    }

    return parsed;
  }

  private async binary(path: string, expectedContentType: string, options: {
    progress?: DkbProgressReporter;
    progressPhase?: string;
    progressLabel?: string;
  } = {}): Promise<Buffer> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authorizationHeader(),
    });

    if (!response.ok) {
      const text = await response.text();
      const parsed = text ? JSON.parse(text) as unknown : null;
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `GET ${path} failed with HTTP ${response.status}`;

      throw new DkbError(message);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.startsWith(expectedContentType)) {
      throw new DkbError(`Registry returned unexpected package content type: ${contentType || 'missing'}`);
    }

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

  private async ensurePackage(input: { id: string; name: string; description?: string; visibility: 'public' | 'private' }) {
    const response = await fetch(`${this.baseUrl}/api/registry/packages`, {
      method: 'POST',
      headers: {
        ...this.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        slug: input.id,
        description: input.description,
        visibility: input.visibility,
      }),
    });

    if (response.ok || response.status === 422) {
      return;
    }

    const text = await response.text();
    const parsed = text ? JSON.parse(text) as unknown : null;
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : `POST /api/registry/packages failed with HTTP ${response.status}`;

    throw new DkbError(message);
  }

  private async waitForPublishedVersion(packageId: string, version: string, initial: unknown) {
    const timeoutMs = Number.parseInt(process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS ?? String(30 * 60_000), 10);
    const started = Date.now();
    let latest = initial;

    while (Date.now() - started < timeoutMs) {
      const status = versionStatus(latest);

      if (status === 'published') {
        return normalizePublishResult(packageId, version, latest);
      }

      if (status === 'failed' || status === 'revoked') {
        throw new DkbError(`Registry publish failed for ${packageId}@${version}: ${versionFailure(latest) ?? status}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
      latest = await this.download(packageId, version);
    }

    throw new DkbError(`Timed out waiting for registry publish: ${packageId}@${version}`);
  }

  private async latestVersion(packageId: string): Promise<string> {
    const details = await this.download(packageId);
    const data = resourceData(details);
    const latest = data && typeof data.latestVersion === 'string' ? data.latestVersion : null;

    if (!latest) {
      throw new DkbError(`Registry package has no published version: ${packageId}`);
    }

    return latest;
  }

  private authorizationHeader(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
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
