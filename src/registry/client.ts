import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '../protocol/errors.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, DKB_PACKAGE_MEDIA_TYPE, DKB_SOURCE_ARCHIVE_MEDIA_TYPE } from './archive.js';

export interface DkbRegistryClientOptions {
  baseUrl?: string;
}

export class DkbRegistryClient {
  readonly baseUrl: string;

  constructor(options: DkbRegistryClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.DKB_REGISTRY_URL ?? 'http://127.0.0.1:7332');
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
    return this.get('/api/packages');
  }

  async publish(input: { sourcePath: string; accountId?: string; accountName?: string; accountEmail?: string; force?: boolean }) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-publish-upload-'));
    const archivePath = path.join(tempRoot, `source${DKB_PACKAGE_EXTENSION}`);

    try {
      await createDkbPackageArchive(input.sourcePath, archivePath);
      const query = new URLSearchParams();

      if (input.accountId) {
        query.set('accountId', input.accountId);
      }
      if (input.accountName) {
        query.set('accountName', input.accountName);
      }
      if (input.accountEmail) {
        query.set('accountEmail', input.accountEmail);
      }
      if (input.force) {
        query.set('force', 'true');
      }
      query.set('sourceName', path.basename(path.resolve(input.sourcePath)));

      const suffix = query.size > 0 ? `?${query.toString()}` : '';

      return await this.request('POST', `/api/packages/publish${suffix}`, await fs.readFile(archivePath), {
        'content-type': DKB_SOURCE_ARCHIVE_MEDIA_TYPE,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  download(packageId: string, version?: string) {
    const query = version ? `?version=${encodeURIComponent(version)}` : '';

    return this.get(`/api/packages/${encodeURIComponent(packageId)}${query}`);
  }

  verify(packageId: string, version?: string) {
    return this.post(`/api/packages/${encodeURIComponent(packageId)}/verify`, { version });
  }

  async packageArchive(packageId: string, version?: string): Promise<Buffer> {
    const query = version ? `?version=${encodeURIComponent(version)}` : '';

    return this.binary(`/api/packages/${encodeURIComponent(packageId)}/package${query}`, DKB_PACKAGE_MEDIA_TYPE);
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: headers ?? (body === undefined ? undefined : { 'content-type': 'application/json' }),
      body: body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body as unknown as BodyInit
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

  private async binary(path: string, expectedContentType: string): Promise<Buffer> {
    const response = await fetch(`${this.baseUrl}${path}`);

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

    return Buffer.from(await response.arrayBuffer());
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/g, '');
}
