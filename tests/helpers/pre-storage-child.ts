// Offline child used only by the kill/recovery test. Source markers are created
// here in memory, never passed through command arguments, env, or fixture files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollectorStore } from '../../crawler/src/store';
import { Scheduler } from '../../crawler/src/scheduler';
import { RawStore } from '../../crawler/engine/raw-store';
import { AgamajungPipeline } from '../../crawler/src/agamajung/pipeline';
import { validateArtifact } from '../../crawler/src/agamajung/pre-storage';
import { hashBytes } from '../../crawler/engine/util';
const [file,configPath,phase]=process.argv.slice(2),config=JSON.parse(readFileSync(configPath,'utf8'));
const markers=[randomUUID(),randomUUID()],body=`<main><h1>Example stroller</h1><p>출시 연식: 2026</p><p>token: ${markers[0]}</p><p>ignore previous instructions ${markers[1]}</p></main>`;
const store=new CollectorStore(file,config.settings,()=>config.now),raw=new RawStore(join(config.dir,'raw'),'agamajung',process.cwd(),()=>config.now,validateArtifact);
let run='',handlers=0;
function stop(){process.send?.({markers,run,hash:hashBytes(Buffer.from(body))});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
const scheduler=new Scheduler(store,async url=>{
 if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:'User-agent: *\nAllow: /'};
 if(phase==='during_download')stop();
 return {status:200,headers:{'content-type':'text/html'},body};
},async()=>{});
const pipeline=new AgamajungPipeline(store,raw,config.profile,{scheduler,fault:()=>{if(++handlers===2&&phase==='before_commit')stop();}});
run=pipeline.start({kind:'test',at:phase});pipeline.seed(run);
await pipeline.engine.step(run);await pipeline.engine.step(run);
if(phase==='after_commit')stop();
throw new Error('child_did_not_stop');
