import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

async function isolated(body) {
  const script = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { promisify } from 'node:util';
    import { syncBuiltinESMExports } from 'node:module';
    const A='sha256:'+ 'a'.repeat(64), B='sha256:'+ 'b'.repeat(64), M='sha256:'+ 'c'.repeat(64);
    const commands=[];
    let created=false, actual=A, containerImage=A;
    const revision='5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';
    const pin={model:'BAAI/bge-small-en-v1.5',modelRepository:'test/onnx',modelRevision:revision};
    const execute=async(command,args)=>{
      assert.equal(command,'docker'); commands.push(args);
      if(args[0]==='image')return {stdout:JSON.stringify([{Id:actual,RepoDigests:['test/image@'+M]}]),stderr:''};
      if(args[0]==='inspect') {
        if(!created)throw new Error('No such container');
        return {stdout:JSON.stringify([{Image:containerImage,State:{Running:true},Config:{Image:'mutable:tag',Labels:{
          'org.dkb.embedding.service.version':'1', 'org.dkb.embedding.model':pin.model,
          'org.dkb.embedding.model-repository':pin.modelRepository,'org.dkb.embedding.model-revision':pin.modelRevision,
          'org.dkb.tei.model':pin.model,'org.dkb.tei.revision':pin.modelRevision,'org.dkb.tei.version':'1.9.3'
        }}}]),stderr:''};
      }
      if(args[0]==='run') created=true;
      if(args[0]==='rm') created=false;
      return {stdout:args[0]==='port'?'127.0.0.1:12345':'ok',stderr:''};
    };
    function mockExecFile(command,args,options,callback){execute(command,args).then(r=>callback(null,r.stdout,r.stderr),callback);}
    mockExecFile[promisify.custom]=execute;
    cp.execFile=mockExecFile; syncBuiltinESMExports();
    globalThis.fetch=async(url)=>new Response(JSON.stringify(String(url).endsWith('/info')
      ?{model_id:pin.model,model_sha:pin.modelRevision,version:'1.9.3'}
      :{ok:true,serviceVersion:'4',...pin}),{headers:{'content-type':'application/json'}});
    ${body}
  `;
  await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 15_000, windowsHide: true });
}

test('Docker image verification accepts actual IDs and repository digests, rejects tag substitution', async () => {
  await isolated(`
    const {resolveDockerImageIdentity}=await import('@sjshovan/dkb-pipeline/serviceIdentity.js');
    assert.equal(await resolveDockerImageIdentity('mutable:tag',A),A);
    assert.equal(await resolveDockerImageIdentity('test/image@'+M,M),A);
    actual=B;
    await assert.rejects(resolveDockerImageIdentity('mutable:tag',A),/identity mismatch/);
    await assert.rejects(resolveDockerImageIdentity('test/image@'+A),/identity mismatch/);
    await assert.rejects(resolveDockerImageIdentity('mutable:tag','main'),/exact sha256/);
  `);
});

test('FastEmbed starts the verified immutable image and rejects a mismatched configured image before mutation', async () => {
  await isolated(`
    const {ensureFastEmbedService,fastEmbedServiceStatus}=await import('@sjshovan/dkb-embedding-fastembed/service.js');
    const options={image:'mutable:tag',imageDigest:A,...pin};
    const status=await ensureFastEmbedService(options);
    assert.equal(status.imageId,A); assert.equal(status.ready,true);
    assert.ok(commands.find(args=>args[0]==='run').includes(A));
    assert.ok(!commands.find(args=>args[0]==='run').includes('mutable:tag'));
    containerImage=B;
    assert.ok((await fastEmbedServiceStatus(options)).drift.includes('image_mismatch'));
    commands.length=0;actual=B;
    await assert.rejects(ensureFastEmbedService(options),/identity mismatch/);
    assert.ok(!commands.some(args=>args[0]==='run'||args[0]==='rm'));
  `);
});

test('TEI starts the verified image with exact model revision and rejects physical container drift', async () => {
  await isolated(`
    const {ensureTeiService,teiServiceStatus}=await import('@sjshovan/dkb-embedding-tei/tei.js');
    const options={image:'mutable:tag',imageDigest:A,model:pin.model,modelRevision:pin.modelRevision};
    const status=await ensureTeiService(options);
    assert.equal(status.imageId,A); assert.equal(status.ready,true);
    const started=commands.find(args=>args[0]==='run');
    assert.ok(started.includes(A));assert.ok(!started.includes('mutable:tag'));
    assert.equal(started[started.indexOf('--revision')+1],revision);
    containerImage=B;
    assert.ok((await teiServiceStatus(options)).drift.includes('image_mismatch'));
    commands.length=0;actual=B;
    await assert.rejects(ensureTeiService(options),/identity mismatch/);
    assert.ok(!commands.some(args=>args[0]==='run'||args[0]==='rm'));
  `);
});

test('FAISS Docker compilation is pinned and native execution cannot claim an image receipt', async () => {
  await isolated(`
    const {runFaissHelper}=await import('./providers/index-faiss/dist/faissHelperClient.js');
    process.env.DKB_FAISS_DOCKER_IMAGE='mutable:tag';delete process.env.DKB_FAISS_SERVICE_URL;
    const args=['build','--vectors','/fixture/vectors.json','--out','/fixture/index.faiss'];
    await runFaissHelper(args,{imageDigest:A});
    const started=commands.find(args=>args[0]==='run');
    assert.ok(started.includes(A));assert.ok(!started.includes('mutable:tag'));
    commands.length=0;actual=B;
    await assert.rejects(runFaissHelper(args,{imageDigest:A}),/identity mismatch/);
    assert.ok(!commands.some(args=>args[0]==='run'));
    process.env.DKB_FAISS_DOCKER_IMAGE='none';
    await assert.rejects(runFaissHelper(args,{imageDigest:A}),/native Python cannot verify/);
  `);
});

test('FAISS Runtime helper starts the exact verified image', async () => {
  await isolated(`
    const {EventEmitter}=await import('node:events');
    const {PassThrough,Writable}=await import('node:stream');
    cp.spawn=(command,args)=>{
      assert.equal(command,'docker');commands.push(args);
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;
      child.stdin=new Writable({write(data,_encoding,callback){
        const request=JSON.parse(String(data));
        queueMicrotask(()=>child.stdout.write(JSON.stringify(request.op==='search'?{ok:true,hits:[{id:'1',score:1}]}:{ok:true})+'\\n'));
        callback();
      },final(callback){child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));callback();}});
      child.kill=()=>{child.exitCode=1;child.emit('exit',1);};return child;
    };syncBuiltinESMExports();
    process.env.DKB_FAISS_DOCKER_IMAGE='mutable:tag';delete process.env.DKB_FAISS_SERVICE_URL;
    const {FaissHelperClient}=await import('./providers/index-faiss/dist/faissHelperClient.js');
    const helper=new FaissHelperClient({imageDigest:A});
    await helper.load({dimensions:2,segments:[{path:'/fixture/index.faiss'}]});
    assert.deepEqual(await helper.search([1,0],1),{hits:[{id:'1',score:1}]});await helper.close();
    const started=commands.find(args=>args[0]==='run');assert.ok(started.includes(A));assert.ok(!started.includes('mutable:tag'));
    commands.length=0;actual=B;
    const bad=new FaissHelperClient({imageDigest:A});
    await assert.rejects(bad.load({dimensions:2,segments:[]}),/identity mismatch/);
    assert.ok(!commands.some(args=>args[0]==='run'));
  `);
});

for (const provider of ['FastEmbed', 'TEI', 'Evidence']) {
  test(`${provider} services with different pinned images have independent names and stop only their own service`, async () => {
    await isolated(`
      const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
      const root=await fs.mkdtemp(path.join(os.tmpdir(),'dkb-service-identity-'));
      process.env.DKB_LLAMA_COMPILER_SERVICE_ROOT=root;
      const containers=new Map();
      mockExecFile[promisify.custom]=async(command,args)=>{
        assert.equal(command,'docker');commands.push(args);
        if(args[0]==='image') {
          if(args.includes('--format'))return {stdout:'4',stderr:''};
          return {stdout:JSON.stringify([{Id:args[2]==='image-b'?B:A,RepoDigests:[]}]),stderr:''};
        }
        if(args[0]==='inspect') {
          if(!containers.has(args[1]))throw new Error('No such container');
          return {stdout:JSON.stringify([containers.get(args[1])]),stderr:''};
        }
        if(args[0]==='run') {
          const labels={};for(let i=0;i<args.length;i++){if(args[i]==='--label'){const [key,...value]=args[i+1].split('=');labels[key]=value.join('=');}}
          containers.set(args[args.indexOf('--name')+1],{Image:args.includes(B)?B:A,State:{Running:true},Config:{Labels:labels}});
        }
        if(args[0]==='rm')containers.delete(args.at(-1));
        return {stdout:args[0]==='port'?'127.0.0.1:12345':'ok',stderr:''};
      };
      try {
        let start,status,stop;
        const provider=${JSON.stringify(provider)};
        if(provider==='FastEmbed'){const m=await import('@sjshovan/dkb-embedding-fastembed/service.js');start=m.ensureFastEmbedService;status=m.fastEmbedServiceStatus;stop=m.stopFastEmbedService;}
        if(provider==='TEI'){const m=await import('@sjshovan/dkb-embedding-tei/tei.js');start=m.ensureTeiService;status=m.teiServiceStatus;stop=m.stopTeiService;}
        if(provider==='Evidence'){const m=await import('./providers/evidence-docling-llamaindex/dist/compilerService.js');start=m.startLlamaIndexCompilerService;status=m.compilerServiceStatus;stop=m.stopLlamaIndexCompilerService;}
        const left={image:'image-a',imageDigest:A,...pin},right={image:'image-b',imageDigest:B,...pin};
        const a=await start(left);commands.length=0;
        const b=await start(right);assert.notEqual(a.container,b.container);
        assert.ok(!commands.some(args=>args[0]==='rm'&&args.includes(a.container)));
        assert.equal((await status(left)).ready,true);assert.equal((await status(right)).ready,true);
        await stop(right);assert.equal((await status(left)).ready,true);assert.equal((await status(right)).running,false);
        const createdArgs=commands.find(args=>args[0]==='run');assert.ok(createdArgs.includes(B));assert.ok(!createdArgs.includes('image-b'));
        if(provider==='Evidence') {
          assert.ok(createdArgs.includes('DKB_COMPILER_MODEL_REVISION='+revision));
          commands.length=0;
          await assert.rejects(start({...left,imageDigest:B}),/identity mismatch/);
          assert.ok(!commands.some(args=>args[0]==='run'||args[0]==='rm'||args[0]==='build'));
          containers.get(a.container).Image=B;
          assert.ok((await status(left)).drift.includes('image_id_mismatch'));
        }
      } finally {await fs.rm(root,{recursive:true,force:true});}
    `);
  });
}

test('Evidence one-shot compilation checks and runs the exact recorded image', async () => {
  await isolated(`
    const {runCompiler}=await import('./providers/evidence-docling-llamaindex/dist/compilerTransport.js');
    await runCompiler('mutable:tag','/input','/request','/output',{imageDigest:A,model:pin.model,modelRevision:revision});
    const started=commands.find(args=>args[0]==='run');assert.ok(started.includes(A));assert.ok(!started.includes('mutable:tag'));
    assert.ok(started.includes('DKB_COMPILER_MODEL_REVISION='+revision));
    actual=B;commands.length=0;
    await assert.rejects(runCompiler('mutable:tag','/input','/request','/output',{imageDigest:A}),/identity mismatch/);
    assert.ok(!commands.some(args=>args[0]==='run'));
  `);
});
