import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFixture } from './helpers/engine';
const files=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{const path=join(dir,n);return statSync(path).isDirectory()?files(path):[path];});
test.each(['during_download','before_commit','after_commit'])('SIGKILL %s leaves no private body and fresh-process recovery preserves evidence',async phase=>{
 const f=engineFixture('<main><h1>Example stroller</h1><p>출시 연식: 2026</p></main>'),config=join(f.dir,'child-config.json');
 writeFileSync(config,JSON.stringify({settings:f.settings,profile:f.profile,dir:f.dir,now:f.now()}),{mode:0o600});
 const child=fork(fileURLToPath(new URL('./helpers/pre-storage-child.ts',import.meta.url)),[f.file,config,phase],{execArgv:['--import','tsx'],silent:true});
 let output='';child.stdout?.on('data',b=>{output+=b;});child.stderr?.on('data',b=>{output+=b;});
 try{
  const result=await new Promise<{markers:string[];run:string;hash:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('child_timeout')),15000);
   child.once('message',v=>{clearTimeout(timer);resolve(v as {markers:string[];run:string;hash:string});});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error('child_exited_early'));});
  });
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
  for(const marker of result.markers){expect(output).not.toContain(marker);for(const path of files(f.dir))expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);}
  f.advance(180001);f.reopen();await f.pipeline.run(f.pipeline.resume(result.run));
  expect(f.store.list('intake_receipts')).toHaveLength(1);expect(f.pipeline.engine.failures()).toEqual([]);
  const cap=f.store.db.prepare("SELECT * FROM engine_captures WHERE status='ok'").get();expect(cap).toBeTruthy();
  if(phase==='after_commit'){expect(f.calls).toEqual([]);expect(cap!.content_hash).toBe(result.hash);}
  else expect(f.calls.filter(c=>!c.url.endsWith('/robots.txt'))).toHaveLength(1);
  for(const marker of result.markers)for(const path of files(f.dir))expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
 }finally{child.kill('SIGKILL');f.close();}
},25000);
