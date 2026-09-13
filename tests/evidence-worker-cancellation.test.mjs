import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { compileDkbWithLlamaIndex, cancelLlamaIndexPending, recoverLlamaIndexCompiler } from '@sjshovan/dkb-evidence-docling-llamaindex/compiler.js';
import { EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN } from '@sjshovan/dkb-evidence-docling-llamaindex/plugin.js';

test('Evidence service dispatch is durably registered before launch and warm success settles after cleanup', async t => {
  const fixture = await workerFixture(t, 'completed');
  const result = await fixture.compile();
  assert.deepEqual(result.records, []);
  assert.equal(fixture.requests.filter(item => item.route === '/compile').length, 1);
  assert.equal(fixture.settled.length, 1);
  assert.equal(fixture.pending.size, 0);
  assert.equal(fixture.workerTerminated, false, 'a safely idle warm worker need not exit after successful work');
  await assert.rejects(fs.access(fixture.state.jobRoot), { code: 'ENOENT' });
});

test('Evidence cancellation waits for acknowledged writes to stop before removing the job root', async t => {
  const fixture = await workerFixture(t, 'cancel');
  await assert.rejects(fixture.compile(), { code: 'compile_cancelled' });
  assert.equal(fixture.lateWriteObserved, true, 'job root remains available until the simulated worker stops');
  assert.equal(fixture.workerTerminated, true);
  assert.equal(fixture.pending.size, 0);
  assert.equal(fixture.requests.filter(item => item.route === '/jobs/cancel').length, 1);
  await assert.rejects(fs.access(fixture.state.jobRoot), { code: 'ENOENT' });
});

test('abort after registration but before dispatch creates a bound tombstone without starting a worker', async t => {
  const fixture = await workerFixture(t, 'cancel', { abortOnRegistration: true });
  await assert.rejects(fixture.compile(), { code: 'compile_cancelled' });
  assert.equal(fixture.requests.some(item => item.route === '/compile'), false);
  assert.equal(fixture.requests.filter(item => item.route === '/jobs/cancel').length, 1);
  assert.equal(fixture.pending.size, 0);
});

test('failed pending registration preserves its original error without dispatching work', async t => {
  const fixture = await workerFixture(t, 'cancel', { abortOnRegistration: true });
  const register = fixture.execution.registerPending;
  fixture.execution.registerPending = async state => {
    await register(state);
    throw new Error('Synthetic journal acknowledgement loss');
  };
  await assert.rejects(fixture.compile(), { message: 'Synthetic journal acknowledgement loss' });
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.pending.size, 1);
  await assert.rejects(fs.access(fixture.state.jobRoot), { code: 'ENOENT' });
  assert.deepEqual(await cancelLlamaIndexPending({ state: fixture.state, options: {} }), { safeToCleanup: true });
});

test('pre-dispatch registration cancellation does not manufacture an unconfirmed worker', async t => {
  const fixture = await workerFixture(t, 'cancel');
  const cancellation = new DkbError('Cancelled before journal persistence.', 'compile_cancelled');
  fixture.execution.registerPending = async () => { throw cancellation; };
  await assert.rejects(fixture.compile(), error => error === cancellation);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.pending.size, 0);
  assert.deepEqual(await fs.readdir(path.join(fixture.serviceRoot, 'jobs')), []);
});

for (const mode of ['unavailable', 'wrong-job', 'wrong-token', 'unsafe-terminal']) {
  test(`Evidence ${mode} cancellation acknowledgement retains recoverable state and scratch`, async t => {
    const fixture = await workerFixture(t, mode);
    await assert.rejects(fixture.compile(), error => {
      assert.equal(error.code, 'compile_termination_unconfirmed');
      assert.ok(error.message.includes('Private recovery control:'));
      assert.ok(!error.message.includes(fixture.state.jobToken));
      return true;
    });
    assert.equal(fixture.pending.size, 1);
    assert.equal(fixture.settled.length, 0);
    await fs.access(path.join(fixture.state.jobRoot, '.dkb-worker-control.json'));
    await fs.access(path.join(fixture.state.jobRoot, 'input', 'sources', 'sample.txt'));

    const calls = fixture.requests.length;
    const outside = { ...fixture.state, jobRoot: fixture.root };
    assert.deepEqual(await cancelLlamaIndexPending({ state: outside, options: {} }), { safeToCleanup: false });
    assert.equal(fixture.requests.length, calls, 'invalid ownership must not dispatch recovery requests');
    const previousUrl = process.env.DKB_LLAMA_COMPILER_SERVICE_URL;
    process.env.DKB_LLAMA_COMPILER_SERVICE_URL = 'http://127.0.0.1:1';
    try {
      assert.deepEqual(await cancelLlamaIndexPending({ state: fixture.state, options: {} }), { safeToCleanup: false });
      assert.equal(fixture.requests.length, calls, 'a replaced endpoint cannot receive the retained job token');
    } finally { process.env.DKB_LLAMA_COMPILER_SERVICE_URL = previousUrl; }

    fixture.mode = 'cancel';
    // A restarted caller has only the journal's opaque JSON state. Property
    // ordering is not part of the recovery contract.
    const recovered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(fixture.state))).reverse());
    assert.deepEqual(await cancelLlamaIndexPending({ state: recovered, options: {} }), { safeToCleanup: true });
    await assert.rejects(fs.access(fixture.state.jobRoot), { code: 'ENOENT' });
    const callsAfterCleanup = fixture.requests.length;
    assert.deepEqual(await Promise.all(Array.from({ length: 2 }, () => cancelLlamaIndexPending({ state: recovered, options: {} }))),
      [{ safeToCleanup: true }, { safeToCleanup: true }]);
    assert.equal(fixture.requests.length, callsAfterCleanup + 2, 'missing scratch still requires a correlated worker acknowledgement on every recovery retry');
  });
}

test('direct local Evidence compilation retains its private recovery control without a Registry execution context', async t => {
  const fixture = await workerFixture(t, 'unavailable');
  await assert.rejects(fixture.compile(false), { code: 'compile_termination_unconfirmed' });
  assert.equal(fixture.pending.size, 0);
  const controlPath = path.join(fixture.state.jobRoot, '.dkb-worker-control.json');
  await fs.access(controlPath);
  fixture.mode = 'cancel';
  assert.deepEqual(await recoverLlamaIndexCompiler(controlPath), { safeToCleanup: true });
});

test('already-aborted Evidence input never stages or dispatches work', async t => {
  const fixture = await workerFixture(t, 'completed');
  fixture.controller.abort(new DkbError('Synthetic cancellation', 'compile_cancelled'));
  await assert.rejects(fixture.compile(), { code: 'compile_cancelled' });
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.pending.size, 0);
  await assert.rejects(fs.access(path.join(fixture.serviceRoot, 'jobs')), { code: 'ENOENT' });
});

for (const outcome of ['confirmed', 'unconfirmed', 'foreign-owner']) {
  test(`owned Docker cancellation ${outcome} verifies identity and waits before cleanup`, async () => {
    // Replace only the Docker command boundary in a separate Node process. No
    // real container, shared service, or global process is stopped by this test.
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
      import cp from 'node:child_process';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
      const outcome=${JSON.stringify(outcome)}, image='sha256:'+ 'a'.repeat(64), id='b'.repeat(64);
      const root=await fs.mkdtemp(path.join(os.tmpdir(),'dkb-llamaindex-'));
      await fs.mkdir(path.join(root,'request'));await fs.mkdir(path.join(root,'output'));
      const controller=new AbortController(),commands=[];let owned,state,settled=false,restored=false;
      const execute=async(command,args)=>{
        assert.equal(command,'docker');commands.push(args);
        if(args[0]==='image')return {stdout:JSON.stringify([{Id:image,RepoDigests:[]}]),stderr:''};
        if(args[0]==='create') {
          assert.ok(state,'register before Docker create');await fs.access(path.join(root,'.dkb-worker-control.json'));
          const labels={},mounts=[];
          for(let i=0;i<args.length;i++) {
            if(args[i]==='--label'){const [key,...value]=args[i+1].split('=');labels[key]=value.join('=');}
            if(args[i]==='--mount'){const fields=Object.fromEntries(args[i+1].split(',').map(x=>x.split('=')));mounts.push({Source:fields.src,Destination:fields.dst,RW:!Object.hasOwn(fields,'readonly')});}
          }
          owned={Id:id,Image:image,Config:{Labels:labels},Mounts:mounts,State:{Running:false,Status:'created'}};
          if(outcome==='foreign-owner')owned.Config.Labels['org.dkb.evidence.job-token-hash']='sha256:'+ '0'.repeat(64);
        }
        if(args[0]==='inspect'){if(!owned)throw new Error('No such container');return {stdout:JSON.stringify([owned]),stderr:''};}
        if(args[0]==='start') {owned.State={Running:true,Status:'running'};controller.abort(new Error('Synthetic cancellation'));throw new Error('Docker client aborted');}
        if(['stop','kill','wait','rm'].includes(args[0]))assert.equal(args.at(-1),id,'destructive commands use the exact verified container ID');
        if(args[0]==='stop')throw new Error('Synthetic ignored TERM');
        if(args[0]==='kill') {if(outcome==='unconfirmed'&&!restored)throw new Error('Synthetic engine loss');owned.State={Running:false,Status:'exited'};}
        if(args[0]==='wait') {assert.equal(owned.State.Running,false);await fs.access(root);}
        if(args[0]==='rm') {assert.ok(commands.some(item=>item[0]==='wait'));owned=undefined;}
        return {stdout:'0',stderr:''};
      };
      function mock(command,args,options,callback){execute(command,args).then(r=>callback(null,r.stdout,r.stderr),callback);}
      mock[promisify.custom]=execute;cp.execFile=mock;syncBuiltinESMExports();
      const {runCompiler,cancelLlamaIndexPending}=await import('./providers/evidence-docling-llamaindex/dist/compilerTransport.js');
      try {
        const execution={registerPending:async value=>{state=value;return 'pending';},settlePending:async()=>{await assert.rejects(fs.access(root),{code:'ENOENT'});settled=true;}};
        await assert.rejects(runCompiler('synthetic:image',path.resolve('/input'),path.join(root,'request'),path.join(root,'output'),{imageDigest:image,signal:controller.signal,execution}),
          error=>outcome==='confirmed'?error.message==='Synthetic cancellation':error.code==='compile_termination_unconfirmed');
        if(outcome==='confirmed') {
          assert.equal(settled,true);assert.equal(owned,undefined);
          const order=commands.map(item=>item[0]);assert.ok(order.indexOf('stop')<order.indexOf('kill'));assert.ok(order.indexOf('kill')<order.indexOf('wait'));assert.ok(order.indexOf('wait')<order.indexOf('rm'));
        } else {
          assert.equal(settled,false);await fs.access(path.join(root,'.dkb-worker-control.json'));
          if(outcome==='foreign-owner')assert.ok(!commands.some(item=>['stop','kill','wait','rm'].includes(item[0])));
          else {
            restored=true;
            assert.deepEqual(await cancelLlamaIndexPending({state,options:{image:'synthetic:image',imageDigest:image}}),{safeToCleanup:true});
            assert.deepEqual(await cancelLlamaIndexPending({state,options:{image:'synthetic:image',imageDigest:image}}),{safeToCleanup:true});
          }
        }
      } finally {await fs.rm(root,{recursive:true,force:true});}
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), timeout: 15_000, windowsHide: true,
    });
  });
}

test('real isolated Docker fallback overrides daemon CMD and acknowledges kill before cleanup', {
  skip: process.env.DKB_RUN_EVIDENCE_DOCKER_PROOF !== '1', timeout: 120_000,
}, async t => {
  const run = promisify(execFile);
  const docker = (args, timeout = 15_000) => run('docker', args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const context = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-evidence-docker-proof-'));
  const tag = `dkb-evidence-cancellation-proof:${randomUUID()}`;
  const pending = [];
  const scratches = [];
  let imageId;
  t.after(async () => {
    for (const state of pending) {
      try {
        const inspected = JSON.parse((await docker(['inspect', `dkb-evidence-${state.jobId}`])).stdout)[0];
        assert.equal(inspected.Image, imageId);
        assert.equal(inspected.Config.Labels['org.dkb.evidence.job-id'], state.jobId);
        assert.equal(inspected.Config.Labels['org.dkb.evidence.job-token-hash'], `sha256:${createHash('sha256').update(state.jobToken).digest('hex')}`);
        await docker(['rm', '-f', inspected.Id]);
      } catch (error) { if (!/no such (container|object)/iu.test(`${error.message} ${error.stderr ?? ''}`)) throw error; }
    }
    if (imageId) {
      assert.equal((await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).stdout.trim(), imageId);
      await docker(['image', 'rm', tag]);
    }
    for (const scratch of scratches) {
      assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
      assert.match(path.basename(scratch), /^dkb-llamaindex-/u);
      await fs.rm(scratch, { recursive: true, force: true });
    }
    assert.equal(path.dirname(context), path.resolve(os.tmpdir()));
    assert.match(path.basename(context), /^dkb-evidence-docker-proof-/u);
    await fs.rm(context, { recursive: true, force: true });
  });
  const baseImage = (await docker(['image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'])).stdout.trim();
  assert.match(baseImage, /^sha256:[a-f0-9]{64}$/u);
  await fs.writeFile(path.join(context, 'Dockerfile'), 'FROM python:3.12-slim\nWORKDIR /compiler\nCOPY compile.py /compiler/compile.py\nCMD ["python", "-c", "raise RuntimeError(\'one-shot must override the service CMD\')"]\n');
  await fs.writeFile(path.join(context, 'compile.py'), `import json, os, signal, subprocess, sys, time
from pathlib import Path
request = json.loads(Path(os.environ['DKB_COMPILER_REQUEST']).read_text())
output = Path(os.environ['DKB_COMPILER_OUTPUT'])
assert Path(os.environ['DKB_COMPILER_INPUT']).is_dir()
if request['mode'] == 'complete':
    output.write_text(json.dumps({'status': 'completed'}))
else:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = subprocess.Popen([sys.executable, '-c', "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)"])
    output.with_name('started').write_text(str(child.pid))
    while True:
        output.write_text(str(time.time_ns()))
        time.sleep(0.025)
`);
  await docker(['build', '--pull=false', '--network=none', '--tag', tag, context], 60_000);
  assert.equal((await docker(['image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'])).stdout.trim(), baseImage);
  imageId = (await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).stdout.trim();
  const { runCompiler } = await import('../providers/evidence-docling-llamaindex/dist/compilerTransport.js');
  for (const mode of ['complete', 'cancel']) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-llamaindex-'));
    scratches.push(scratch);
    const requestRoot = path.join(scratch, 'request'), outputRoot = path.join(scratch, 'output');
    await fs.mkdir(requestRoot); await fs.mkdir(outputRoot);
    await fs.writeFile(path.join(requestRoot, 'request.json'), JSON.stringify({ mode }));
    const controller = new AbortController();
    let settled = false;
    const execution = {
      async registerPending(state) { pending.push(state); return state.jobId; },
      async settlePending() { await assert.rejects(fs.access(scratch), { code: 'ENOENT' }); settled = true; },
    };
    const running = runCompiler(tag, context, requestRoot, outputRoot, { imageDigest: imageId, signal: controller.signal, execution });
    if (mode === 'complete') {
      const finish = await running;
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputRoot, 'llamaindex-compiled.json'), 'utf8')), { status: 'completed' });
      assert.equal(settled, false);
      await finish();
    } else {
      // Install the rejection observer before signalling the running worker.
      const cancelled = assert.rejects(running, error => error.message === 'Synthetic Docker cancellation');
      const deadline = Date.now() + 30_000;
      while (true) {
        try { await fs.access(path.join(outputRoot, 'started')); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      controller.abort(new Error('Synthetic Docker cancellation'));
      await cancelled;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(settled, true);
    await assert.rejects(fs.access(scratch), { code: 'ENOENT' });
    const name = `dkb-evidence-${pending.at(-1).jobId}`;
    assert.equal((await docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).stdout.trim(), '');
  }
});

async function workerFixture(t, mode, { abortOnRegistration = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-evidence-cancellation-test-'));
  const serviceRoot = path.join(root, 'service');
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(path.join(sourceRoot, 'sources'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'sources', 'sample.txt'), 'Synthetic cancellable source.');
  const names = ['DKB_LLAMA_COMPILER_SERVICE_ROOT', 'DKB_LLAMA_COMPILER_SERVICE_URL', 'DKB_LLAMA_COMPILER_SERVICE',
    'DKB_LLAMA_RECORD_CACHE', 'DKB_TEST_ABORT_LLAMA_AFTER_CHECKPOINT'];
  const before = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  const fixture = {
    root, serviceRoot, mode, requests: [], pending: new Map(), settled: [], errors: [],
    controller: new AbortController(), state: undefined, workerTerminated: false, lateWriteObserved: false,
  };
  const envelope = (body, status = 'cancelled') => ({
    format: 'dkb.evidence.worker-job.v1', jobId: body.jobId,
    jobTokenHash: `sha256:${createHash('sha256').update(body.jobToken).digest('hex')}`,
    status, safeToCleanup: true, terminated: status === 'cancelled',
  });
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      fixture.requests.push({ route: request.url, jobId: body.jobId });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/compile') {
        const control = JSON.parse(await fs.readFile(path.join(serviceRoot, 'jobs', body.jobId, '.dkb-worker-control.json'), 'utf8'));
        assert.equal(control.jobToken, body.jobToken);
        assert.equal(control.deadline, body.deadline);
        assert.ok(Date.parse(body.deadline) > Date.now());
        fixture.state = control;
        if (fixture.mode === 'completed') {
          const identity = EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN.identity({ options: body.evidenceOptions });
          response.end(JSON.stringify({
            format: 'dkb.llamaindex.compile.v2', records: [], job: envelope(body, 'completed'),
            compiler: {
              id: 'llamaindex.docling.evidence', model: body.model, modelRevision: body.modelRevision,
              evidenceOptions: body.evidenceOptions,
              modelAssetsDigest: identity.external.find(item => item.name === 'docling-assets').digest,
            },
          }));
        } else fixture.controller.abort(new DkbError('Synthetic cancellation', 'compile_cancelled'));
        return;
      }
      assert.ok(['/jobs/cancel', '/jobs/status'].includes(request.url));
      const ack = envelope(body);
      if (fixture.mode === 'unavailable') { response.writeHead(503); response.end('{}'); return; }
      if (fixture.mode === 'wrong-job') ack.jobId = 'job-00000000-0000-0000-0000-000000000000';
      if (fixture.mode === 'wrong-token') ack.jobTokenHash = `sha256:${'0'.repeat(64)}`;
      if (fixture.mode === 'unsafe-terminal') { ack.safeToCleanup = false; ack.terminated = false; }
      if (fixture.mode === 'cancel') {
        if (!abortOnRegistration && !fixture.workerTerminated) {
          await new Promise(resolve => setTimeout(resolve, 25));
          await fs.writeFile(path.join(fixture.state.jobRoot, 'last-worker-write'), 'write before acknowledged stop');
          fixture.lateWriteObserved = true;
        }
        fixture.workerTerminated = true;
      }
      response.end(JSON.stringify(ack));
    } catch (error) { fixture.errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(fixture.errors, []);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.DKB_LLAMA_COMPILER_SERVICE_ROOT = serviceRoot;
  process.env.DKB_LLAMA_COMPILER_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  const execution = {
    async registerPending(state) {
      fixture.state = JSON.parse(JSON.stringify(state));
      assert.equal(fixture.requests.length, 0, 'registration must precede worker launch');
      await fs.access(path.join(state.jobRoot, '.dkb-worker-control.json'));
      fixture.pending.set('pending-1', state);
      if (abortOnRegistration) fixture.controller.abort(new DkbError('Synthetic cancellation', 'compile_cancelled'));
      return 'pending-1';
    },
    async settlePending(id) {
      assert.ok(fixture.mode === 'completed' || fixture.workerTerminated);
      await assert.rejects(fs.access(fixture.state.jobRoot), { code: 'ENOENT' });
      fixture.pending.delete(id);
      fixture.settled.push(id);
    },
  };
  fixture.execution = execution;
  fixture.compile = (withExecution = true) => compileDkbWithLlamaIndex({
    root: sourceRoot, manifest: { id: '@test/cancellable', version: '1.0.0', stores: [{ id: 'files', type: 'filesystem', path: 'sources' }] },
  }, { signal: fixture.controller.signal, ...(withExecution ? { execution } : {}) });
  return fixture;
}
