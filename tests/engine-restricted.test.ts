import { expect, test, vi } from 'vitest';
import { detectExplicit, detectRendered } from '../crawler/engine';
import { asset, engineFixture } from './helpers/engine';
import type { DomainState } from '../crawler/src/scheduler';
test('explicit login/challenge signals stop immediately while a JS shell is renderable',()=>{
 expect(detectExplicit({headers:{},body:asset('rendered-login.html')})).toBe('login_required');
 expect(detectExplicit({headers:{},body:'example_only',finalUrl:'https://example.org/accounts/login/'})).toBe('login_required');
 expect(detectRendered({finalUrl:'https://example.org/',html:'',text:''})).toBe('empty_page');
});
test.each(['login_required','empty_page','region_missing','ok'])('rendered %s is assessed before missing-region handling',async code=>{
 const renderer={capability:{nonpersistent:true as const,version:'fixture-render@1'},render:vi.fn(async()=>({finalUrl:'https://gear.example.org/model',html:code==='login_required'?asset('rendered-login.html'):code==='ok'?'<main><h1>Example stroller</h1><p>출시 연식: 2026</p><p>호환성: Example adapter</p></main>':'',text:code==='empty_page'?'':'Example stroller specifications example_only',regionText:code==='ok'?'출시 연식: 2026\n호환성: Example adapter':undefined,regionError:code==='ok'?undefined:'region_required'}))};
 const f=engineFixture(asset('js-shell.html'),{browser:true},{renderer});try{
  const id=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(id);await f.pipeline.run(id);expect(renderer.render).toHaveBeenCalledTimes(1);
  const state=f.pipeline.engine.run(id)?.state,domain=f.store.get<DomainState>('domain_state','gear.example.org');
  if(code==='login_required'||code==='empty_page'){expect(state).toBe('halted');expect(domain).toMatchObject({stopped:true,reason:'access_restricted'});expect(f.pipeline.engine.failures()[0]).toMatchObject({reason:code,retryable:0,attempts:0});}
  else {expect(state).toBe('finished');expect(domain?.stopped).toBe(false);if(code==='region_missing')expect(f.pipeline.engine.failures()[0]).toMatchObject({reason:code});else expect(f.store.list('evidence_assertions').length).toBeGreaterThan(0);}
  expect(f.calls).toHaveLength(2);
 }finally{f.close();}
});
test('non-rendered empty page halts and persists across restart, blocking further transport',async()=>{
 const f=engineFixture(asset('rendered-empty.html'));try{
  const r=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(r);await f.pipeline.run(r);expect(f.pipeline.engine.run(r)?.state).toBe('halted');f.reopen();expect(()=>f.pipeline.resume(r)).toThrow('domain_stopped');expect(f.calls).toHaveLength(2);
 }finally{f.close();}
});
