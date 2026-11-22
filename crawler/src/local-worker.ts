import { bootstrap, envelope, publish } from '../collector-bootstrap.mjs';
import cronSchedule from '../pm2-cron.cjs';
import type { Invocation } from './collector-events';
import { identity, serviceProcesses } from './process-identity';
import { validateArtifact } from './agamajung/pre-storage';
import { loadSchedule, JOBS, type CollectionJob } from './collection-schedule';
import { runCollectorJob } from './collector-job';
import { jobDefinition } from './collector-runners';
import { ScheduleWorker } from './schedule-worker';
import { MissingFieldRunner, EXPLORER_RUN_ID } from './missing-field/runner';
import { basename, dirname, resolve } from 'node:path';
import { externalDirectory, RawStore } from '../engine/raw-store';
import { AgamajungPipeline } from './agamajung/pipeline';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { CollectorError, CollectorStore, requireThat } from './store';
import { config, type CollectorConfig } from './source-policy';
import { handleLocal } from './intake-api';
import { parseTrustedEgress } from './egress';
import { Scheduler, pinnedRequest } from './scheduler';
import { syncStatus } from './status-sync';
import { SourceDiscoveryRunner, DISCOVERY_RUN_ID } from './source-discovery/runner';
import { SourceCandidateStore } from './source-discovery/store';
import { loadDiscoveryConfig } from './source-discovery/config';
import { loadProfile } from './agamajung/profile';
export async function main(context?:Invocation){
  const args=process.argv.slice(2),command=args[0]==='explore-missing-fields'?'explore-missing':args[0]??'serve';
  const settings=process.env.COLLECTOR_CONFIG?JSON.parse(readFileSync(process.env.COLLECTOR_CONFIG,'utf8')) as CollectorConfig:config;
  const trusted=parseTrustedEgress(process.env.COLLECTOR_TRUSTED_EGRESS_CIDRS);
  if(trusted.length)console.error('trusted_egress_configured');
  requireThat(['schedule','serve','discover','discover-sources','source-candidates','sync','collect','engine-status','failures','backfill-engine','dedup-audit','explore-missing','missing-fields','missing-field-actions','missing-field-metrics'].includes(command),'command');
  if(['serve','schedule','discover','collect','backfill-engine','discover-sources','explore-missing'].includes(command))requireThat(process.platform==='linux','linux_required');
  if(command==='schedule'||command==='explore-missing'||command==='collect'||command==='discover-sources'||command==='backfill-engine'||command==='failures'&&args[1]==='retry'){
    requireThat(process.env.COLLECTOR_DB,'engine_paths_required');
    externalDirectory(dirname(process.env.COLLECTOR_DB!));
    if(['schedule','collect'].includes(command)){requireThat(process.env.COLLECTOR_RAW_DIR,'engine_paths_required');externalDirectory(process.env.COLLECTOR_RAW_DIR!);}
  }
  if(['engine-status','failures','dedup-audit','source-candidates','missing-fields','missing-field-actions','missing-field-metrics'].includes(command)){requireThat(process.env.COLLECTOR_DB,'engine_paths_required');externalDirectory(dirname(process.env.COLLECTOR_DB!));}
  const auth={intakeToken:process.env.COLLECTOR_INTAKE_TOKEN??'',reviewToken:process.env.COLLECTOR_REVIEW_TOKEN??'',extensionOrigin:process.env.COLLECTOR_EXTENSION_ORIGIN??'',host:'127.0.0.1:4318'};
  if(command==='serve')requireThat(auth.intakeToken.length>=24&&auth.reviewToken.length>=24&&auth.intakeToken!==auth.reviewToken&&/^chrome-extension:\/\/[a-p]{32}$/.test(auth.extensionOrigin),'local_auth_config');
  const store=new CollectorStore(resolve(process.env.COLLECTOR_DB??'crawler/.cache/collector.sqlite'),settings);
  if(command==='schedule'){
    const controller=new AbortController(),stop=()=>controller.abort();
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    try{const result=await new ScheduleWorker(store,job=>jobDefinition(store,job,trusted)).run(controller.signal);if(context){context.completed=true;publish(envelope(context,'service_stop',Date.now(),{outcome:result.outcome==='skipped'?'skipped':null,reason:result.reason}));}}
    finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);store.close();}return;
  }
  if(JOBS.includes(command as CollectionJob)){
    const cron = cronSchedule.isPm2CollectorJob(command);
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (cron) { process.once('SIGTERM', stop); process.once('SIGINT', stop); }
    try{
      const index=args.indexOf('--resume');if(index>=0)requireThat(args[index+1],'run_id_required');
      const job = command as CollectionJob;
      const schedule = cron ? { job, enabled: true, times: cronSchedule.collectorSlotTimes() } : loadSchedule().find(s => s.job === job)!;
      const result = await runCollectorJob(store, schedule, jobDefinition(store, job, trusted), {
        context, ...(cron ? { source: 'scheduled' as const, lock: { cronSignal: controller.signal } } : {}),
        resumeId: index >= 0 ? args[index + 1] : undefined, dryRun: args.includes('--dry-run'),
      });
      if(result.outcome==='halted')process.exitCode=75;
    } finally {
      if (cron) { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
      store.close();
    }
    return;
  }
  try {
    const kind=command==='serve'?'serve':command==='sync'?'sync':command==='explore-missing'||command==='failures'&&args[1]==='retry'?'crawl':undefined;
    if(kind){
      const result=await store.waitForRunLock(kind);
      if(!result.acquired){
        store.close();
        if(context&&command==='serve'){context.completed=true;publish(envelope(context,'service_stop',Date.now(),{outcome:'skipped',reason:result.reason}));}
        console.error(`collector_skipped command=${command} reason=${result.reason} kind=${kind} attempts=${result.attempts} waited_ms=${result.waitedMs}`);
        return;
      }
    }
  } catch(e) { store.close(); throw e; }
  if(['explore-missing','missing-fields','missing-field-actions','missing-field-metrics'].includes(command)){
    try{
      const runner=new MissingFieldRunner(store);
      if(command==='missing-fields'){const index=args.indexOf('--id');if(index>=0)requireThat(args[index+1],'slot_id_required');console.log(JSON.stringify(runner.storage.current(index>=0?args[index+1]:undefined)));return;}
      if(command==='missing-field-actions'){console.log(JSON.stringify(runner.storage.actions()));return;}
      if(command==='missing-field-metrics'){const index=args.indexOf('--run');requireThat(index>=0&&args[index+1],'run_id_required');console.log(JSON.stringify(store.readSnapshot(()=>({current:runner.currentMetrics(args[index+1]),snapshots:runner.snapshots(args[index+1])}))));return;}
      if(args.includes('--dry-run')){console.log(JSON.stringify(runner.preview()));return;}
      const index=args.indexOf('--resume');if(index>=0)requireThat(args[index+1],'run_id_required');
      const id=index>=0?runner.resume(args[index+1]):runner.start();await runner.run(id);console.log(JSON.stringify(runner.report(id)));
    }finally{store.close();}return;
  }
  if(command==='source-candidates'){
    try{const index=args.indexOf('--id');if(index>=0)requireThat(args[index+1],'candidate_id_required');console.log(JSON.stringify(new SourceCandidateStore(store,loadDiscoveryConfig()).list(index>=0?args[index+1]:undefined)));}finally{store.close();}return;
  }
  if(['engine-status','failures','dedup-audit'].includes(command)){
    try {
      if(command==='engine-status'){
        console.log(JSON.stringify({runs:store.db.prepare('SELECT id,profile_id,state,started_at,finished_at FROM engine_runs ORDER BY started_at DESC').all(),checkpoints:store.db.prepare('SELECT run_id,stage,phase,count(*) count FROM engine_checkpoints GROUP BY run_id,stage,phase').all(),costs:store.db.prepare('SELECT scope,kind,cap,held,spent FROM engine_costs').all(),next_day_shared_caps:loadProfile().cost_caps.day}));return;
      }
      if(command==='dedup-audit'){console.log(JSON.stringify({violations:store.dedupAudit({apply:args.includes('--apply')})}));return;}
      if(command==='failures'&&(args[1]??'list')==='list'){
        console.log(JSON.stringify(store.db.prepare('SELECT id,run_id,stage,item_key,reason,attempts,retryable,next_retry_at,first_at,last_at FROM engine_failures ORDER BY last_at').all()));return;
      }
      requireThat(process.env.COLLECTOR_DB,'engine_paths_required');
      externalDirectory(dirname(process.env.COLLECTOR_DB!));
      const scheduler=new Scheduler(store,(u,m,_trusted,opts)=>pinnedRequest(u,m,trusted,opts));
      if(command==='failures'&&args[1]==='retry'){
        requireThat(args[2],'command');
        const row=store.db.prepare('SELECT r.profile_id FROM engine_checkpoints c JOIN engine_runs r ON r.id=c.run_id WHERE c.id=?').get(args[2]) as {profile_id:string}|undefined;
        if(row?.profile_id===EXPLORER_RUN_ID){const runner=new MissingFieldRunner(store);console.log(JSON.stringify({run_id:runner.retryFailure(args[2])}));return;}
        if(row?.profile_id===DISCOVERY_RUN_ID){const runner=new SourceDiscoveryRunner(store,loadDiscoveryConfig(),{scheduler});console.log(JSON.stringify({run_id:runner.engine.retryFailure(args[2])}));return;}
      }
      requireThat(process.env.COLLECTOR_RAW_DIR,'engine_paths_required');
      const pipeline=new AgamajungPipeline(store,new RawStore(process.env.COLLECTOR_RAW_DIR!,'agamajung',process.cwd(),Date.now,validateArtifact),undefined,{scheduler,health:code=>console.error(`collect reason=${code}`)});
      if(command==='failures'){
        requireThat(args[1]==='retry'&&args[2],'command');console.log(JSON.stringify({run_id:pipeline.engine.retryFailure(args[2])}));return;
      }
    }finally{store.close();}
    return;
  }
  if(command==='sync'){try{console.log(JSON.stringify(await syncStatus(store,process.env.COLLECTOR_SITE_URL??'',process.env.COLLECTOR_STATUS_TOKEN??'')));}finally{store.close();}return;}
  const own=identity();
  try{requireThat(!serviceProcesses(resolve('.')).some(p=>p.identity.pid!==process.pid&&p.service==='local'&&p.state!=='gone'&&p.state!=='zombie'),'live_process_without_lock');}catch(e){store.close();throw e;}
  const server=createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){
      if(req.headers.host!==auth.host||req.headers.origin!==auth.extensionOrigin){res.writeHead(403);res.end();return;}
      res.writeHead(204,{'Access-Control-Allow-Origin':auth.extensionOrigin,'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Private-Network':'true','Vary':'Origin'});res.end();return;
    }
    const chunks:Buffer[]=[];let size=0;
    try{for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
      const request=new Request(`http://${auth.host}${req.url}`,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks).toString('utf8')}:{})});
      const result=await handleLocal(request,store,auth,own);res.writeHead(result.status,{...Object.fromEntries(result.headers),...(req.headers.origin===auth.extensionOrigin?{'Access-Control-Allow-Origin':auth.extensionOrigin,'Vary':'Origin'}:{})});res.end(await result.text());
    }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"request_failed"}');}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  server.once('error',()=>{if(context){context.completed=true;publish(envelope(context,'service_stop',Date.now(),{outcome:'failed',reason:'initialization_failed'}));}store.close();process.exitCode=1;});
  server.listen(4318,'127.0.0.1',()=>{if(context)publish(envelope(context,'service_ready',Date.now(),{reason:'ready',identity:own}));});
  const stop=()=>server.close(()=>{if(context){context.completed=true;publish(envelope(context,'service_stop',Date.now(),{reason:'shutdown'}));}store.close();});process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void bootstrap(process.argv.slice(2),async()=>({main,collectorFailure}));}

export function collectorFailure(error: unknown): string {
  const known=error instanceof CollectorError&&['run_locked','run_lock_unreadable','run_lock_unverifiable','unsafe_file','unsafe_directory','database_corrupt','sqlite_runtime_unsafe','local_auth_config','engine_paths_required'].includes(error.code);
  const detail=known?error.detail??{}:{};
  const fields:string[]=[];
  if(['serve','crawl','sync','schedule'].includes(String(detail.kind)))fields.push(`kind=${detail.kind}`);
  if(Number.isSafeInteger(detail.pid)&&Number(detail.pid)>0)fields.push(`pid=${detail.pid}`);
  if(typeof detail.started_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(detail.started_at)&&Number.isFinite(Date.parse(detail.started_at)))fields.push(`started_at=${detail.started_at}`);
  const path=typeof detail.path==='string'?basename(detail.path):'';
  if(/^collector\.sqlite\.(?:serve|crawl|sync|schedule)\.lock$/.test(path))fields.push(`path=${path}`);
  return [`collector_failed code=${known?error.code:'internal_error'}`,...fields].join(' ');
}
