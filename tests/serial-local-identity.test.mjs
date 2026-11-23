import test from 'node:test';import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {mkdtempSync,rmSync,writeFileSync,symlinkSync,linkSync,unlinkSync,realpathSync,chmodSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {localIdentityStore} from './helpers/serial-local-identity.mjs';
const child=fileURLToPath(new URL('./helpers/serial-local-identity-child.mjs',import.meta.url)),scope='a'.repeat(64);
const launch=(dir,cut='')=>new Promise(resolve=>{const p=spawn(process.execPath,[child,dir,scope,cut],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',(status,signal)=>resolve({status,signal,out,err}));});
test('exclusive fsynced identity has one owner across processes and never changes',async()=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),'serial-identity-')));try{
 const pair=await Promise.all([launch(dir),launch(dir)]);const results=pair.filter(x=>x.status===0).map(x=>JSON.parse(x.out));assert.equal(results.filter(x=>x.state==='FRESH').length,1);for(const x of pair.filter(x=>x.status!==0))assert.match(x.err,/LOCAL_IDENTITY_UNVERIFIED/);
 const fresh=results.find(x=>x.state==='FRESH');assert.ok(results.every(x=>x.roundId===fresh.roundId));
 assert.deepEqual(await localIdentityStore(dir).claim(scope),{state:'EXISTING',roundId:fresh.roundId});await assert.rejects(localIdentityStore(dir).claim('b'.repeat(64)),/LOCAL_IDENTITY_UNVERIFIED/);
 }finally{rmSync(dir,{recursive:true,force:true});}});
test('killed creator, truncated marker, unsafe directory and symlink all fail closed',async()=>{for(const mode of ['killed','truncated','symlink','permissions']){const dir=realpathSync(mkdtempSync(join(tmpdir(),'serial-identity-')));try{
 if(mode==='killed'){const result=spawnSync(process.execPath,[child,dir,scope,'kill'],{encoding:'utf8',timeout:10000});assert.equal(result.signal,'SIGKILL');}
 if(mode==='truncated')writeFileSync(join(dir,'serial-round-identity.json'),'{"schema":',{mode:0o600});
 if(mode==='symlink')symlinkSync('/dev/null',join(dir,'serial-round-identity.json'));
 if(mode==='permissions')chmodSync(dir,0o755);
 await assert.rejects(localIdentityStore(dir).claim(scope),/LOCAL_IDENTITY_UNVERIFIED/,mode);
 }finally{chmodSync(dir,0o700);rmSync(dir,{recursive:true,force:true});}}});

test('sync failure never permits a later invocation to become a fresh owner',async()=>{for(const key of ['syncFile','syncDirectory']){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'serial-identity-')));try{
  await assert.rejects(localIdentityStore(dir,{[key](){throw Error('synthetic fsync failure');}}).claim(scope),/synthetic fsync failure/);
  const after=await localIdentityStore(dir).claim(scope);assert.equal(after.state,'EXISTING',key);
 }finally{rmSync(dir,{recursive:true,force:true});}
}});

test('identity rejects a symlinked parent directory and hardlinked marker',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'serial-identity-'))),alias=dir+'-alias';try{
  symlinkSync(dir,alias);await assert.rejects(localIdentityStore(alias).claim(scope),/LOCAL_IDENTITY_UNVERIFIED/);unlinkSync(alias);
  const target=join(dir,'target');writeFileSync(target,'{}',{mode:0o600});linkSync(target,join(dir,'serial-round-identity.json'));
  await assert.rejects(localIdentityStore(dir).claim(scope),/LOCAL_IDENTITY_UNVERIFIED/);
 }finally{try{unlinkSync(alias);}catch{}rmSync(dir,{recursive:true,force:true});}
});
