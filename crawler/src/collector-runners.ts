import { offerConfig } from './offers/config';
import { enqueueConfigured } from './offers/frontier';
import { validateArtifact } from './agamajung/pre-storage';
import { RawStore } from '../engine/raw-store';
import { AgamajungPipeline } from './agamajung/pipeline';
import { backfillEngine } from './agamajung/backfill';
import { DiscoveryRunner } from './discovery/run';
import { formatLine } from './discovery/health';
import { SourceDiscoveryRunner, DISCOVERY_RUN_ID, sourceDiscoveryReport } from './source-discovery/runner';
import { loadDiscoveryConfig } from './source-discovery/config';
import { Scheduler, pinnedRequest } from './scheduler';
import type { Cidr } from './egress';
import type { CollectorStore } from './store';
import type { CollectionJob } from './collection-schedule';
import type { JobAdapter, JobDefinition } from './collector-job';
export function collectAdapter(pipeline:AgamajungPipeline):JobAdapter {
  const sources=pipeline.store.settings.sources.filter(s=>s.enabled&&pipeline.profile.domain_policy.sources[s.id]);
  return {enabled:sources.length>0,start:slot=>pipeline.start(slot),seed:id=>pipeline.seed(id),resume:id=>pipeline.resume(id),run:async id=>pipeline.run(id!),preview:()=>({dry_run:true,state:sources.length?'running':'finished',sources:sources.map(s=>s.id)})};
}
export function jobDefinition(store:CollectorStore,job:CollectionJob,trusted:Cidr[]=[]):JobDefinition {
  if (process.env.AGAMAJUNG_PM2_JOB && (process.env.AGAMAJUNG_API_URL || process.env.COLLECTOR_SITE_URL) && job !== 'backfill-engine') {
    return { create: () => ({ enabled: true,
      async run() { enqueueConfigured(store, offerConfig(), store.settings.sources.filter(source => source.enabled).map(source => source.origin)); },
      preview: () => ({ dry_run: true, frontier: true }),
      result: () => ({ status: 'succeeded', reason: 'completed', output: { frontier: true } }),
    }) };
  }
  const scheduler=()=>new Scheduler(store,(u,m,_t,opts)=>pinnedRequest(u,m,trusted,opts));
  if(job==='collect')return {profileId:'agamajung',create:(offline=false)=>collectAdapter(new AgamajungPipeline(store,new RawStore(process.env.COLLECTOR_RAW_DIR!,'agamajung',process.cwd(),Date.now,validateArtifact),undefined,{scheduler:scheduler(),offline}))};
  if(job==='discover-sources')return {profileId:DISCOVERY_RUN_ID,output:id=>sourceDiscoveryReport(store,id),create:(offline=false)=>{
    const cfg=loadDiscoveryConfig(),runner=new SourceDiscoveryRunner(store,cfg,{scheduler:scheduler(),offline});
    const preview=runner.preview();return {enabled:cfg.enabled&&(preview.providers.length>0||preview.sources.length>0),start:slot=>runner.start(slot),seed:id=>runner.seed(id),resume:id=>runner.resume(id),run:async id=>runner.run(id!),preview:()=>preview};
  }};
  if(job==='backfill-engine')return {create:()=>({enabled:true,run:async()=>backfillEngine(store),result:output=>({status:'succeeded',reason:'completed',output}),preview:()=>({dry_run:true})})};
  return {create:()=>{
    const runner=new DiscoveryRunner(store,scheduler());
    const run=async(dry:boolean,callId?:string)=>{
      if(!dry)runner.seed();const health=await runner.run(dry,callId);
      for(const h of health.sources.filter(h=>h.pages_attempted>0))console.error(formatLine(h,{at:store.now(),callId}));
      return dry?{dry_run:true,health}:{...store.report(),jobs:store.jobSummary(),health};
    };
    return {enabled:store.settings.sources.some(s=>s.enabled),run:(_id,callId)=>run(false,callId),preview:()=>run(true),result:output=>{
      const data=output as Awaited<ReturnType<typeof run>>,sources=data.health.sources;
      const failed=sources.some(s=>s.pages_failed||s.blocked||Object.keys(s.subrequest_failures).length);
      return {status:failed?'partial_failure':'succeeded',reason:failed?'transport_failed':data.health.status==='review'?'quality_review':data.health.status==='idle'?'no_work':'completed',output,counts:{pages_attempted:sources.reduce((n,s)=>n+s.pages_attempted,0),pages_ok:sources.reduce((n,s)=>n+s.pages_ok,0),pages_failed:sources.reduce((n,s)=>n+s.pages_failed,0),blocked_requests:sources.reduce((n,s)=>n+s.blocked,0),parsed_items:sources.reduce((n,s)=>n+s.parsed,0),eligible_items:sources.reduce((n,s)=>n+s.eligible,0),submissions_accepted:sources.reduce((n,s)=>n+s.sent,0),subrequest_failures:sources.reduce((n,s)=>n+Object.values(s.subrequest_failures).reduce((a,b)=>a+b,0),0),sources_review:sources.filter(s=>s.status==='review').length}};
    }};
  }};
}
