import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compilerResultEnvelopePrefix,
  DKB_COMPILER_RESULT_MAGIC,
} from '../services/compiler/dist/compilerResultEnvelope.js';

test('compiler result envelope carries large metadata outside HTTP headers', () => {
  const payload = {
    sourceInventory: {
      entries: Array.from({ length: 500 }, (_, index) => ({
        path: `packages/example-${index}/src/implementation-${index}.ts`,
        bytes: 12_000 + index,
        hash: `sha256:${String(index).padStart(64, '0')}`,
      })),
    },
  };

  const prefix = compilerResultEnvelopePrefix(payload);
  assert.ok(prefix.byteLength > 12 * 1024);

  const magic = Buffer.from(DKB_COMPILER_RESULT_MAGIC, 'ascii');
  assert.deepEqual(prefix.subarray(0, magic.byteLength), magic);

  const lengthEnd = prefix.indexOf(0x0a, magic.byteLength);
  assert.ok(lengthEnd > magic.byteLength);
  const metadataLength = Number.parseInt(prefix.subarray(magic.byteLength, lengthEnd).toString('ascii'), 10);
  const metadata = prefix.subarray(lengthEnd + 1);

  assert.equal(metadata.byteLength, metadataLength);
  assert.deepEqual(JSON.parse(metadata.toString('utf8')), payload);
});
