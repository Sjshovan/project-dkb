import { DkbError } from './errors.js';

export const DKB_ARTIFACT_MANIFEST_FORMAT = 'dkb.artifacts.manifest.v2';
export const DKB_ARTIFACT_MANIFEST_FILENAME = 'artifacts.manifest.json';

export interface DkbArtifactManifestFile {
  path: string;
  hash: string;
  size: number;
}

export interface DkbArtifactManifest {
  format: typeof DKB_ARTIFACT_MANIFEST_FORMAT;
  package: { id: string; version: string };
  evidenceDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  index: { provider: string; mode: 'packaged' | 'managed'; format: string };
  files: DkbArtifactManifestFile[];
  generatedAt: string;
}

export function validateArtifactManifest(value: unknown, source = DKB_ARTIFACT_MANIFEST_FILENAME): DkbArtifactManifest {
  if (!isRecord(value) || value.format !== DKB_ARTIFACT_MANIFEST_FORMAT || !isRecord(value.package)
    || !isRecord(value.index) || !Array.isArray(value.files)) {
    throw new DkbError(`Invalid artifact manifest at ${source}: expected ${DKB_ARTIFACT_MANIFEST_FORMAT}`);
  }
  const manifest = value as unknown as DkbArtifactManifest;
  if (typeof manifest.package.id !== 'string' || typeof manifest.package.version !== 'string'
    || typeof manifest.index.provider !== 'string' || typeof manifest.index.format !== 'string'
    || (manifest.index.mode !== 'packaged' && manifest.index.mode !== 'managed')) {
    throw new DkbError(`Invalid artifact manifest at ${source}: package and index identities are required`);
  }
  for (const [label, digest] of Object.entries({
    evidenceDigest: manifest.evidenceDigest,
    retrievalProfileDigest: manifest.retrievalProfileDigest,
    compatibilityDigest: manifest.compatibilityDigest,
  })) assertDigest(digest, `${source} ${label}`);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || file.path.length === 0 || file.path.includes('\\')
      || file.path.startsWith('/') || file.path.split('/').some((part) => part === '..' || part === '')
      || !Number.isInteger(file.size) || file.size < 0) {
      throw new DkbError(`Invalid artifact file entry at ${source}`);
    }
    assertDigest(file.hash, `${source} ${file.path}`);
    if (seen.has(file.path)) throw new DkbError(`Duplicate artifact path ${file.path} at ${source}`);
    seen.add(file.path);
  }
  return manifest;
}

function assertDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/iu.test(value)) throw new DkbError(`${label} must be a sha256 digest`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
