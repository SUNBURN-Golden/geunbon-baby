import { expect, test, vi } from 'vitest';
import { handleLocal, type LocalAuth } from '../crawler/src/intake-api';
import { formatReport, cli } from '../crawler/src/cli';
import { handleApi } from '../lib/api';
import { readFileSync } from 'node:fs';
import { memoryD1 } from './helpers/sqlite';
import { fixture, binding, intake, price, source } from './helpers/collector';
import type { Snapshot } from '../shared/collection-schema';
import type { Env } from '../lib/db';
const auth:LocalAuth={host:'127.0.0.1:4318',extensionOrigin:`chrome-extension://${'a'.repeat(32)}`,intakeToken:'intake-fixture-1234567890123456',reviewToken:'review-fixture-1234567890123456'};
test('local API requires exact host/origin and distinct privileges; API, CLI and function agree',async()=>{
 const f=fixture();try{
  const call=(path:string,body?:unknown,patch:Record<string,string>={})=>handleLocal(new Request('http://'+auth.host+path,{method:body===undefined?'GET':'POST',headers:{host:auth.host,authorization:`Bearer ${auth.reviewToken}`,'content-type':'application/json',...patch},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.store,auth);
  expect((await call('/v1/collection/status',undefined,{host:'evil.invalid'})).status).toBe(403);
  expect((await call('/v1/collection/status',undefined,{origin:auth.extensionOrigin})).status).toBe(403);
  expect((await call('/v1/intake/reservations',binding())).status).toBe(403);
  const headers={origin:auth.extensionOrigin,authorization:`Bearer ${auth.intakeToken}`};
  const reserved=await call('/v1/intake/reservations',binding(),headers);expect(reserved.status).toBe(200);
  const json=await reserved.json() as {data:{id:string}};expect((await call(`/v1/intake/reservations/${json.data.id}/start`,{},headers)).status).toBe(200);
  expect((await call('/v1/intake',{reservation_id:json.data.id,payload:price()},headers)).status).toBe(200);
  expect((await call('/v1/collection/status',undefined,{authorization:`Bearer ${auth.intakeToken}`})).status).toBe(401);
  const snapshot=(await (await call('/v1/collection/status')).json() as {data:Snapshot}).data;expect(snapshot).toEqual(f.store.report());expect(JSON.parse(formatReport(snapshot,true))).toEqual(snapshot);
  const send:typeof fetch=async(input,init)=>call(new URL(String(input)).pathname,init?.body?JSON.parse(String(init.body)):undefined);expect(JSON.parse(await cli(['report','--json'],send))).toEqual(snapshot);
 }finally{f.close();}
});

test('site stores authenticated counts only; idempotent and reverse versions cannot publish or overwrite newer snapshots',async()=>{
 const memory=memoryD1(),f=fixture();vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-24T00:00:00Z'));try{
  for(const sql of readFileSync(new URL('../migrations/0007_collector_status.sql',import.meta.url),'utf8').split(';').filter(v=>v.trim()))await memory.db.prepare(sql).run();
  const env:Env={DB:memory.db,IMAGES:{} as R2Bucket,ADMIN_TOKEN:'fixture-admin-token',INGEST_TOKEN:'fixture-ingest-token',COLLECTOR_STATUS_TOKEN:'fixture-status-token-distinct'};
  const call=(path:string,token?:string,body?:unknown)=>handleApi(new Request(`https://site.example.org/api/v1/${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token??''}`},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('/'),env);
  expect((await call('admin/collection-status',env.ADMIN_TOKEN)).status).toBe(200);expect((await (await call('admin/collection-status',env.ADMIN_TOKEN)).json() as {data:{synced:boolean;workers:{snapshot:Snapshot;stale:boolean}[]}}).data).toMatchObject({synced:false,workers:[]});
  const old=f.store.report();intake(f.store,`${source.origin}/a`,price());const newer=f.store.report();
  expect((await call('collector/status',env.INGEST_TOKEN,newer)).status).toBe(401);expect((await call('collector/status',env.ADMIN_TOKEN,newer)).status).toBe(401);
  for(const snapshot of [newer,newer,old])expect((await call('collector/status',env.COLLECTOR_STATUS_TOKEN,snapshot)).status).toBe(200);
  expect((await call('collector/status',env.COLLECTOR_STATUS_TOKEN,{...newer,generated_at:'2026-10-23T00:00:00Z'})).status).toBe(409);
  expect((await call('collector/status',env.COLLECTOR_STATUS_TOKEN,{...newer,url:'https://private.invalid/'})).status).toBe(400);
  const result=(await (await call('admin/collection-status',env.ADMIN_TOKEN)).json() as {data:{synced:boolean;workers:{snapshot:Snapshot;stale:boolean}[]}}).data;expect(result.workers[0].snapshot.version).toBe(newer.version);expect(result.workers[0].snapshot.counts).toEqual(newer.counts);expect(result.workers[0].stale).toBe(true);
  expect(await memory.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toMatchObject({results:[{name:'collector_status_snapshots'}]});
 }finally{f.close();memory.close();}
});
