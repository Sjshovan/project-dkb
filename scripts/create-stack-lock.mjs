import fs from 'node:fs/promises';
import path from 'node:path';

const options = parseArguments(process.argv.slice(2));
const required = ['version', 'registry', 'compiler', 'runtime', 'provider', 'output'];
for (const key of required) {
  if (!options[key]) throw new Error(`Missing --${key}`);
}

const images = {
  registry: verifiedImage(options.registry, 'dkb-registry'),
  compiler: verifiedImage(options.compiler, 'dkb-compiler'),
  runtime: verifiedImage(options.runtime, 'dkb-runtime'),
  provider: verifiedImage(options.provider, 'dkb-provider-sidecar'),
};

const lock = {
  format: 'dkb.stack-lock.v1',
  version: options.version,
  protocol: '1.0',
  createdAt: new Date().toISOString(),
  sourceCommit: process.env.GITHUB_SHA ?? process.env.DKB_BUILD_COMMIT ?? 'development',
  images,
  externalImages: {
    tei: 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.3@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07',
  },
};

await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
await fs.writeFile(path.resolve(options.output), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
console.log(path.resolve(options.output));

function verifiedImage(value, expectedName) {
  const pattern = new RegExp(`^ghcr\\.io/sjshovan/${expectedName}@sha256:[a-f0-9]{64}$`, 'u');
  if (!pattern.test(value)) throw new Error(`${expectedName} must be a private GHCR reference pinned by sha256 digest`);
  return value;
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/u, '');
    const value = values[index + 1];
    if (!key || !value) throw new Error(`Invalid argument near ${values[index] ?? '<end>'}`);
    parsed[key] = value;
  }
  return parsed;
}
