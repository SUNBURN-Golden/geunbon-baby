import { expect, test, vi } from 'vitest';
import { engineFixture } from './helpers/engine';
import type { Checkpoint } from '../crawler/engine';
const checkpoint=(f:ReturnType<typeof engineFixture>,run:string,stage:string)=>{
 const row=f.store.db.prepare('SELECT id FROM engine_checkpoints WHERE run_id=? AND stage=?').get(run,stage) as {id:string};return f.pipeline.engine.checkpoint(row.id)!;
};
const effects=(f:ReturnType<typeof engineFixture>)=>({evidence:f.store.list('evidence_assertions'),budgets:f.store.list('daily_budgets'),outbox:f.store.list('sync_outbox'),version:f.store.get('collector_meta','version')});
test('crash after external submit recovers through a receipt without touching service effects',async()=>{
 let armed=true;const f=engineFixture(undefined,{}, {fault:point=>{if(armed&&point==='after_external_commit'){armed=false;throw new Error('injected');}}});try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);await expect(f.pipeline.run(id)).rejects.toThrow('engine_crash');
  const before=effects(f),c=checkpoint(f,id,'service');expect(c.phase).toBe('leased');expect(before.evidence.length).toBeGreaterThan(0);
  const receipt=f.store.receipt(String(c.data.reservation_id))!;expect(receipt).toBeTruthy();f.advance(180001);f.reopen();const spy=vi.spyOn(f.pipeline.handlers.service,'run');
  await f.pipeline.run(f.pipeline.resume(id));expect(checkpoint(f,id,'service')).toMatchObject({phase:'done',output_ref:receipt.id});expect(effects(f)).toEqual(before);expect(spy).not.toHaveBeenCalled();
 }finally{f.close();}
});
test('receipt mismatch fails payload_changed; an expired reservation fails submission_expired without creating facts',async()=>{
 const f=engineFixture();try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);
  while(!f.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='service'").get(id))await f.pipeline.engine.step(id);
  const c=checkpoint(f,id,'service');f.advance(8*86400000);await f.pipeline.run(id);expect(checkpoint(f,id,'service')).toMatchObject({phase:'failed',error_code:'submission_expired',attempts:0});expect(f.store.list('evidence_assertions')).toEqual([]);
  // Recovery checks the privacy-filtered payload digest before treating any receipt as success.
  f.store.transaction(()=>f.store.put('intake_receipts',String(c.data.reservation_id),{id:'example-only',digest:'changed'}));
  expect(()=>f.pipeline.handlers.service.recover?.(c as Checkpoint)).toThrow('payload_changed');
 }finally{f.close();}
});
test('daily body cap stops transport before even robots and defers without incrementing attempts',async()=>{
 const f=engineFixture();try{
  f.store.settings.limits.new_body=0;
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);await f.pipeline.run(id);
  expect(f.calls).toEqual([]);expect(f.pipeline.engine.run(id)?.state).toBe('cost_wait');expect(checkpoint(f,id,'fetch')).toMatchObject({phase:'deferred',attempts:0,error_code:'daily_limit'});
 }finally{f.close();}
});
test('manual retry of expired service creates a fresh attempt with fresh budget while preserving successful ancestor stages',async()=>{
 const f=engineFixture();try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);
  while(!f.store.db.prepare("SELECT 1 FROM engine_checkpoints WHERE run_id=? AND stage='service'").get(id))await f.pipeline.engine.step(id);
  f.advance(8*86400000);await f.pipeline.run(id);const original=checkpoint(f,id,'service');
  const next=f.pipeline.engine.retryFailure(original.id);await f.pipeline.run(next);
  expect(checkpoint(f,next,'service').phase).toBe('done');expect(checkpoint(f,next,'fetch').phase).toBe('done');expect(f.calls).toHaveLength(2);expect(f.store.list('intake_reservations')).toHaveLength(2);expect(f.store.list('intake_receipts')).toHaveLength(1);
 }finally{f.close();}
});
