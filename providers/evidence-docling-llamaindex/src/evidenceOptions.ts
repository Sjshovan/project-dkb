import { readFileSync } from 'node:fs';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export interface EvidenceOptions {
  richFiles: boolean;
  richFileFallback: boolean;
  richFileExtensions: string[];
  ocrBackend: 'torch' | 'onnxruntime';
  ocrLanguage: 'ch' | 'en';
}

const assets = JSON.parse(readFileSync(new URL('../python/assets.json', import.meta.url), 'utf8')) as {
  format: string;
  common: Record<string, unknown>[];
  ocr: Record<EvidenceOptions['ocrBackend'], Record<string, unknown>[]>;
};
const extensions = ['.docx', '.htm', '.html', '.pdf', '.pptx', '.xlsx'];
export const EVIDENCE_OPTION_KEYS = ['richFiles', 'richFileFallback', 'richFileExtensions', 'ocrBackend', 'ocrLanguage'];

export function resolveEvidenceOptions(value: Record<string, unknown> = {}): EvidenceOptions {
  for (const key of ['richFiles', 'richFileFallback']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new DkbError(`${key} must be a boolean`);
  }
  const requested = value.richFileExtensions ?? extensions;
  if (!Array.isArray(requested) || requested.some((item) => typeof item !== 'string' || !extensions.includes(item))) {
    throw new DkbError(`richFileExtensions must contain only ${extensions.join(', ')}`);
  }
  const backend = value.ocrBackend ?? 'torch';
  if (backend !== 'torch' && backend !== 'onnxruntime') throw new DkbError('ocrBackend must be torch or onnxruntime with matching pinned worker assets');
  const language = value.ocrLanguage ?? 'ch';
  if (language !== 'ch' && language !== 'en') throw new DkbError('ocrLanguage must be ch or en, using the pinned multilingual PP-OCRv6 model');
  return {
    richFiles: value.richFiles !== false,
    richFileFallback: value.richFileFallback !== false,
    richFileExtensions: [...new Set(requested as string[])].sort(),
    ocrBackend: backend,
    ocrLanguage: language,
  };
}

export function evidenceModelAssetsDigest(options: EvidenceOptions): string {
  return stableHash({ format: assets.format, assets: [...assets.common, ...assets.ocr[options.ocrBackend]] });
}
