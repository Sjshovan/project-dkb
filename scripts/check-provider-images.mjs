import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const images = [
  {
    role: 'evidence',
    image: process.env.DKB_EVIDENCE_IMAGE ?? 'dkb-evidence-docling-llamaindex:0.1.0',
    present: ['docling', 'llama_index'],
    absent: ['fastembed', 'faiss'],
  },
  {
    role: 'embedding',
    image: process.env.DKB_FASTEMBED_IMAGE ?? 'dkb-embedding-fastembed:0.1.0',
    present: ['fastembed'],
    absent: ['docling', 'llama_index', 'faiss'],
  },
  {
    role: 'index',
    image: process.env.DKB_FAISS_IMAGE ?? 'dkb-index-faiss:0.1.0',
    present: ['faiss'],
    absent: ['docling', 'llama_index', 'fastembed'],
  },
];

const results = await Promise.all(images.map(async (definition) => {
  const probe = [
    'import importlib.util as modules',
    `present = ${JSON.stringify(definition.present)}`,
    `absent = ${JSON.stringify(definition.absent)}`,
    'missing = [name for name in present if modules.find_spec(name) is None]',
    'unexpected = [name for name in absent if modules.find_spec(name) is not None]',
    'assert not missing, f"missing required modules: {missing}"',
    'assert not unexpected, f"contains prohibited modules: {unexpected}"',
  ].join('\n');

  try {
    await executeFile('docker', [
      'run', '--rm', '--entrypoint', 'python', definition.image, '-c', probe,
    ], { windowsHide: true, timeout: 120_000 });
  } catch (error) {
    const detail = [error instanceof Error ? error.message : String(error), error?.stdout, error?.stderr]
      .filter(Boolean)
      .join('\n');
    throw new Error(`${definition.role} provider image ${definition.image} is not isolated:\n${detail}`);
  }

  return { role: definition.role, image: definition.image, status: 'isolated' };
}));

console.log(JSON.stringify({ status: 'passed', images: results }, null, 2));
