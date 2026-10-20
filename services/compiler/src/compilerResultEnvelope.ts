import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export const DKB_COMPILER_RESULT_MEDIA_TYPE = 'application/vnd.dkb.compiler-result.v1+binary';
export const DKB_COMPILER_RESULT_MAGIC = 'DKB-COMPILER-RESULT-V1\n';

const MAX_METADATA_BYTES = 64 * 1024 * 1024;

export function compilerResultEnvelopePrefix(payload: unknown): Buffer {
  const metadata = Buffer.from(JSON.stringify(payload), 'utf8');
  if (metadata.byteLength > MAX_METADATA_BYTES) {
    throw new DkbError(`Compiler result metadata exceeds the ${MAX_METADATA_BYTES}-byte envelope limit`);
  }

  return Buffer.concat([
    Buffer.from(DKB_COMPILER_RESULT_MAGIC, 'ascii'),
    Buffer.from(`${metadata.byteLength}\n`, 'ascii'),
    metadata,
  ]);
}
