import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN } from '@sjshovan/dkb-evidence-docling-llamaindex/plugin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerRoot = path.join(root, 'providers/evidence-docling-llamaindex/python');
const execFile = promisify(execFileCallback);

test('Evidence identity binds exact selected assets and semantic extraction options', async () => {
  const manifest = JSON.parse(await readFile(path.join(providerRoot, 'assets.json'), 'utf8'));
  const schema = EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN.optionsSchema['~standard'];
  const cpu = await schema.validate({});
  const gpu = await schema.validate({ ocrBackend: 'onnxruntime' });
  const disabled = await schema.validate({ richFiles: false });
  assert.ok(cpu.value);
  assert.equal(cpu.value.ocrBackend, 'torch');
  assert.equal(cpu.value.ocrLanguage, 'ch');
  const identify = (value) => EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN.identity({ options: value });
  const cpuIdentity = identify(cpu.value);
  const gpuIdentity = identify(gpu.value);
  assert.equal(cpuIdentity.external.find((item) => item.name === 'docling-assets').digest,
    stableHash({ format: manifest.format, assets: [...manifest.common, ...manifest.ocr.torch] }));
  assert.notEqual(stableHash(cpuIdentity), stableHash(gpuIdentity));
  assert.notEqual(stableHash(cpuIdentity), stableHash(identify(disabled.value)));
  for (const asset of [...manifest.common, ...manifest.ocr.torch, ...manifest.ocr.onnxruntime]) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(asset.bytes > 0 && asset.bytes < 256 * 1024 * 1024);
    assert.ok(!asset.path.includes('..'));
    if (asset.url.includes('huggingface.co')) assert.match(asset.url, /\/resolve\/[a-f0-9]{40}\//u);
  }
  assert.throws(() => schema.validate({ tokenizerModel: 'custom/tokenizer' }), /requires tokenizerRevision/u);
  assert.throws(() => schema.validate({ ocrBackend: 'auto' }), /ocrBackend must/u);
  assert.throws(() => schema.validate({ richFiles: 'false' }), /richFiles must/u);
  const worker = await readFile(path.join(providerRoot, 'compile.py'), 'utf8');
  assert.doesNotMatch(worker, /\bDOCLING_ENABLED\b|\bDOCLING_FALLBACK\b|DKB_DOCLING_/u);
});

test('Python pinned-asset verifier rejects missing, corrupt and oversized downloads', async (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  try { await execFile(python, ['--version']); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Python is required for the Evidence worker asset-verification test');
    throw error;
  }
  const script = String.raw`
import ast, hashlib, importlib.util, io, json, pathlib, sys, tempfile
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('model_assets', root / 'model_assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
original = assets.MANIFEST
digests = {backend: assets.asset_digest(backend) for backend in ('torch', 'onnxruntime')}
payload = b'pinned test model'
entry = {'path':'model.bin','url':'https://models.example/model','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
assets.MANIFEST = {'format':'test','common':[entry],'ocr':{'torch':[]}}
with tempfile.TemporaryDirectory(prefix='dkb-model-assets-') as directory:
    target = pathlib.Path(directory)
    try: assets.verify_assets('torch', target)
    except assets.ModelIntegrityError: pass
    else: raise AssertionError('missing model accepted')
    assets.urlopen = lambda *args, **kwargs: io.BytesIO(payload)
    assets.download_assets('torch', target)
    assets.verify_assets('torch', target)
    (target / 'model.bin').write_bytes(b'corrupt')
    try: assets.verify_assets('torch', target)
    except assets.ModelIntegrityError: pass
    else: raise AssertionError('corrupt model accepted')
    assets.urlopen = lambda *args, **kwargs: io.BytesIO(payload + b'oversized')
    try: assets.download_assets('torch', target)
    except assets.ModelIntegrityError: pass
    else: raise AssertionError('oversized model accepted')
    assert not (target / 'model.bin.download').exists()
for filename in ('compile.py','service.py','model_assets.py'):
    ast.parse((root / filename).read_text(encoding='utf-8'), filename=filename)
print(json.dumps(digests))
`;
  const result = await execFile(python, ['-B', '-c', script, providerRoot], { timeout: 30_000 });
  const digests = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const manifest = JSON.parse(await readFile(path.join(providerRoot, 'assets.json'), 'utf8'));
  for (const backend of ['torch', 'onnxruntime']) {
    assert.equal(digests[backend], stableHash({ format: manifest.format, assets: [...manifest.common, ...manifest.ocr[backend]] }));
  }
});
