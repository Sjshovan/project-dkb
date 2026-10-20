import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DKB_RUNTIME_ACTIVATION_FORMAT,
  DKB_RUNTIME_BINDING_FORMAT,
  runtimeActivationDigest,
  validateRuntimeActivation,
  validateRuntimeBinding,
} from '@sjshovan/dkb-protocol/runtimeActivation.js';

const digest = (character) => `sha256:${character.repeat(64)}`;

test('Runtime bindings keep machine paths outside portable activation locks', () => {
  const binding = validateRuntimeBinding({
    format: DKB_RUNTIME_BINDING_FORMAT,
    runtimeId: 'tei-proof',
    library: { kind: 'local', name: 'proof', path: 'C:\\knowledge\\proof' },
    target: 'tei-faiss',
    updatedAt: '2026-08-31T00:00:00.000Z',
  });
  const activation = validateRuntimeActivation({
    format: DKB_RUNTIME_ACTIVATION_FORMAT,
    runtimeId: binding.runtimeId,
    library: { id: 'proof-library', generation: 4, stateDigest: digest('1') },
    target: binding.target,
    evidenceProfileDigest: digest('2'),
    retrievalProfileDigest: digest('3'),
    compatibilityDigest: digest('4'),
    packages: {
      '@proof/knowledge': {
        version: '1.0.0',
        evidenceProfileDigest: digest('2'),
        evidenceDigest: digest('5'),
        retrievalProfileDigest: digest('3'),
        retrievalBuildDigest: digest('6'),
      },
    },
    generation: 2,
    generatedAt: '2026-08-31T00:00:00.000Z',
  });

  assert.equal(binding.library.kind, 'local');
  assert.equal('path' in activation.library, false);
  assert.match(runtimeActivationDigest(activation), /^sha256:[a-f0-9]{64}$/u);
});

test('Runtime activation rejects packages from another compatibility profile', () => {
  assert.throws(() => validateRuntimeActivation({
    format: DKB_RUNTIME_ACTIVATION_FORMAT,
    runtimeId: 'fast-proof',
    library: { id: 'proof-library', generation: 1, stateDigest: digest('1') },
    target: 'fastembed-faiss',
    evidenceProfileDigest: digest('2'),
    retrievalProfileDigest: digest('3'),
    compatibilityDigest: digest('4'),
    packages: {
      '@proof/knowledge': {
        version: '1.0.0',
        evidenceProfileDigest: digest('2'),
        evidenceDigest: digest('5'),
        retrievalProfileDigest: digest('9'),
        retrievalBuildDigest: digest('6'),
      },
    },
    generation: 1,
    generatedAt: '2026-08-31T00:00:00.000Z',
  }), /does not match the active profiles/u);
});
