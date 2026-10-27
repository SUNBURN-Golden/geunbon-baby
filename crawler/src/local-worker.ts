import { dirname, resolve } from 'node:path';
import { externalDirectory, RawStore } from '../engine/raw-store';
import { AgamajungPipeline } from './agamajung/pipeline';
import { backfillEngine } from './agamajung/backfill';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { CollectorStore, requireThat } from './store';
import { config, type CollectorConfig } from './source-policy';
import { handleLocal } from './intake-api';
import { formatLine } from './discovery/health';
import { DiscoveryRunner } from './discovery/run';
import { parseTrustedEgress } from './egress';
import { Scheduler, pinnedRequest } from './scheduler';
import { syncStatus } from './status-sync';
export async function main(){
  const args=process.argv.slice(2),command=args[0]??'serve';
  const settings=process.env.COLLECTOR_CONFIG?JSON.parse(readFileSync(process.env.COLLECTOR_CONFIG,'utf8')) as CollectorConfig:config;
  const trusted=parseTrustedEgress(process.env.COLLECTOR_TRUSTED_EGRESS_CIDRS);
  if(trusted.length)console.error(`trusted_egress_cidrs=${trusted.map(c=>c.text).join(',')}`);
  requireThat(['serve','discover','sync','collect','engine-status','failures','backfill-engine','dedup-audit'].includes(command),'command');
  if(command==='collect'||command==='backfill-engine'||command==='failures'&&args[1]==='retry'){
    requireThat(process.env.COLLECTOR_DB&&process.env.COLLECTOR_RAW_DIR,'engine_paths_required');
    externalDirectory(dirname(process.env.COLLECTOR_DB!));externalDirectory(process.env.COLLECTOR_RAW_DIR!);
  }
  if(['engine-status','failures','dedup-audit'].includes(command)){requireThat(process.env.COLLECTOR_DB,'engine_paths_required');externalDirectory(dirname(process.env.COLLECTOR_DB!));}
  const auth={intakeToken:process.env.COLLECTOR_INTAKE_TOKEN??'',reviewToken:process.env.COLLECTOR_REVIEW_TOKEN??'',extensionOrigin:process.env.COLLECTOR_EXTENSION_ORIGIN??'',host:'127.0.0.1:4318'};
  if(command==='serve')requireThat(auth.intakeToken.length>=24&&auth.reviewToken.length>=24&&auth.intakeToken!==auth.reviewToken&&/^chrome-extension:\/\/[a-p]{32}$/.test(auth.extensionOrigin),'local_auth_config');
  const store=new CollectorStore(resolve(process.env.COLLECTOR_DB??'crawler/.cache/collector.sqlite'),settings);
  if(['collect','engine-status','failures','backfill-engine','dedup-audit'].includes(command)){
    try {
      if(command==='engine-status'){
        console.log(JSON.stringify({runs:store.db.prepare('SELECT id,profile_id,state,started_at,finished_at FROM engine_runs ORDER BY started_at DESC').all(),checkpoints:store.db.prepare('SELECT run_id,stage,phase,count(*) count FROM engine_checkpoints GROUP BY run_id,stage,phase').all(),costs:store.db.prepare('SELECT scope,kind,cap,held,spent FROM engine_costs').all()}));return;
      }
      if(command==='dedup-audit'){console.log(JSON.stringify({violations:store.dedupAudit({apply:args.includes('--apply')})}));return;}
      if(command==='backfill-engine'){console.log(JSON.stringify(backfillEngine(store)));return;}
      if(command==='failures'&&(args[1]??'list')==='list'){
        console.log(JSON.stringify(store.db.prepare('SELECT id,run_id,stage,item_key,reason,attempts,retryable,next_retry_at,first_at,last_at FROM engine_failures ORDER BY last_at').all()));return;
      }
      requireThat(process.env.COLLECTOR_DB&&process.env.COLLECTOR_RAW_DIR,'engine_paths_required');
      externalDirectory(dirname(process.env.COLLECTOR_DB!));
      const scheduler=new Scheduler(store,(u,m,_trusted,opts)=>pinnedRequest(u,m,trusted,opts));
      const pipeline=new AgamajungPipeline(store,new RawStore(process.env.COLLECTOR_RAW_DIR!,'agamajung'),undefined,{scheduler,health:code=>console.error(`collect reason=${code}`)});
      if(command==='failures'){
        requireThat(args[1]==='retry'&&args[2],'command');console.log(JSON.stringify({run_id:pipeline.engine.retryFailure(args[2])}));return;
      }
      // Dry-run is an offline policy/seed preview: no transport or service intake.
      const resumeIndex=args.indexOf('--resume');if(resumeIndex>=0)requireThat(args[resumeIndex+1],'run_id_required');
      const id=resumeIndex>=0?pipeline.resume(args[resumeIndex+1]):args.includes('--dry-run')?pipeline.start({kind:'dry-run',at:new Date(store.now()+9*3600000).toISOString().slice(0,10)}):pipeline.start();
      if(args.includes('--dry-run')){
        const enabled=settings.sources.filter(s=>s.enabled&&pipeline.profile.domain_policy.sources[s.id]);
        if(!enabled.length&&!store.db.prepare('SELECT 1 FROM engine_checkpoints WHERE run_id=? LIMIT 1').get(id))await pipeline.run(id);
        console.log(JSON.stringify({run_id:id,dry_run:true,state:pipeline.engine.run(id)?.state,sources:enabled.map(s=>s.id)}));if(pipeline.engine.run(id)?.state==='halted')process.exitCode=75;return;
      }
      pipeline.seed(id);const run=await pipeline.run(id);console.log(JSON.stringify({run_id:id,state:run.state}));
      if(run.state==='halted')process.exitCode=75;
    }finally{store.close();}
    return;
  }
  if(command==='discover'){
    try{
      const runner=new DiscoveryRunner(store,new Scheduler(store,(u,m)=>pinnedRequest(u,m,trusted))),dry=args.includes('--dry-run');
      if(!dry)runner.seed();
      const health=await runner.run(dry);
      const jobs=store.jobSummary();
      console.log(JSON.stringify(dry?{dry_run:true,health}:{...store.report(),jobs,health}));
      for(const s of health.sources.filter(s=>s.pages_attempted>0))console.error(formatLine(s));
    }finally{store.close();}
    return;
  }
  if(command==='sync'){try{console.log(JSON.stringify(await syncStatus(store,process.env.COLLECTOR_SITE_URL??'',process.env.COLLECTOR_STATUS_TOKEN??'')));}finally{store.close();}return;}
  const server=createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){
      if(req.headers.host!==auth.host||req.headers.origin!==auth.extensionOrigin){res.writeHead(403);res.end();return;}
      res.writeHead(204,{'Access-Control-Allow-Origin':auth.extensionOrigin,'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Private-Network':'true','Vary':'Origin'});res.end();return;
    }
    const chunks:Buffer[]=[];let size=0;
    try{for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
      const request=new Request(`http://${auth.host}${req.url}`,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks).toString('utf8')}:{})});
      const result=await handleLocal(request,store,auth);res.writeHead(result.status,{...Object.fromEntries(result.headers),...(req.headers.origin===auth.extensionOrigin?{'Access-Control-Allow-Origin':auth.extensionOrigin,'Vary':'Origin'}:{})});res.end(await result.text());
    }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"request_failed"}');}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  server.once('error',()=>{store.close();process.exitCode=1;});
  server.listen(4318,'127.0.0.1');
  const stop=()=>server.close(()=>store.close());process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('collector_failed');process.exitCode=1;});
