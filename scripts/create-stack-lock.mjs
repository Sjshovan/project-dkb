import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DKB_DISTRIBUTION } from '../packages/distribution-default/dist/index.js';

const options = parseArguments(process.argv.slice(2));
for (const key of ['version', 'output']) {
  if (!options[key]) throw new Error(`Missing --${key}`);
}

let supplied;
try {
  supplied = JSON.parse(process.env.DKB_STACK_IMAGES_JSON ?? '{}');
} catch (error) {
  throw new Error(`DKB_STACK_IMAGES_JSON must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
}
if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
  throw new Error('DKB_STACK_IMAGES_JSON must be a JSON object keyed by distribution service ID');
}

const expected = DEFAULT_DKB_DISTRIBUTION.services
  .filter((service) => service.stack && service.image)
  .map((service) => service.id);
const images = {};
for (const id of expected) images[id] = verifiedImage(supplied[id], id);
for (const id of Object.keys(supplied)) {
  if (!expected.includes(id)) throw new Error(`Unknown distribution service image: ${id}`);
}

const lock = {
  format: 'dkb.stack-lock.v2',
  version: options.version,
  protocol: '2.0',
  distribution: `${DEFAULT_DKB_DISTRIBUTION.id}@${DEFAULT_DKB_DISTRIBUTION.version}`,
  createdAt: new Date().toISOString(),
  sourceCommit: process.env.GITHUB_SHA ?? process.env.DKB_BUILD_COMMIT ?? 'development',
  images,
};

await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
await fs.writeFile(path.resolve(options.output), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
console.log(path.resolve(options.output));

function verifiedImage(value, serviceId) {
  if (typeof value !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${serviceId} must be an image reference pinned by sha256 digest`);
  }
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
