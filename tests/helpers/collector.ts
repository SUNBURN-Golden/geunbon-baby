import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollectorStore } from '../../crawler/src/store';
import { config, type CollectorConfig, type SourcePolicy } from '../../crawler/src/source-policy';
import type { Binding, ClipPayload } from '../../shared/collection-schema';
export const source:SourcePolicy={id:'fixture',origin:'https://gear.example.org',brand:'Stokke',kind:'manufacturer',paths:['/'],query_keys:['id','page'],entries:['https://gear.example.org/'],adapter:'links',browser:false,selector:'.card',official_fields:['official_msrp','recalls'],full_text_allowed:false,recheck_ms:86400000,max_pages:20,enabled:true};
export function fixture(settings:CollectorConfig={...config,sources:[source]}){
  const dir=mkdtempSync(join(tmpdir(),'collector-')),file=join(dir,'collector.sqlite');let time=Date.parse('2026-10-23T01:00:00Z');
  let store=new CollectorStore(file,settings,()=>time);
  return {file,dir,get store(){return store;},settings,advance:(ms:number)=>{time+=ms;},reopen:()=>{store.close();store=new CollectorStore(file,settings,()=>time);return store;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
export function binding(url='https://gear.example.org/model',method:Binding['collection_method']='manual_clip'):Binding{return {clip_id:randomUUID(),attempt_id:randomUUID(),url,brand:url.startsWith(source.origin)?source.brand:'unknown',collection_method:method,operation:'new_body',policy_version:1};}
export const price=(amount=123000):ClipPayload=>({target_model_id:'model-1',assertions:[{field:'official_msrp',value:{amount,currency:'KRW',market:'KR'},quote:`권장소비자가 ${amount}원`,locator:'main .msrp',msrp_explicit:true,conditions:{currency:'KRW',market:'KR'}}]});
export function intake(store:CollectorStore,url:string,payload:ClipPayload,method:Binding['collection_method']='manual_clip'){
 const reservation=store.reserve('fixture-client',binding(url,method));store.start('fixture-client',reservation.id);return store.submit('fixture-client',reservation.id,payload);
}
export function expected(store:CollectorStore,id:string){const g=store.scope(id).group;return {expected_group_version:g.group_version,expected_evidence_version:g.evidence_version,review_scope_digest:g.review_scope_digest};}
export function ready(store:CollectorStore,id:string){store.review(id,{...expected(store,id),decision:'verify',reviewer:'fixture-reviewer'});store.review(id,{...expected(store,id),decision:'ready',reviewer:'fixture-publisher'});}
