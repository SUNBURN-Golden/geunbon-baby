import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { EngineDb } from '../crawler/engine/types';
import { initializeSourceRegistry, SourceRegistryStore } from '../crawler/src/source-registry/store';
import { loadRegistrySeed } from '../crawler/src/source-registry/seed';
import { registryUrl, scopeReason } from '../crawler/src/source-registry/policy';
import official from '../seed/official-sources.json';

test('the static seed is idempotent in memory and registration confers no permission',()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const engine:EngineDb={db,now:()=>Date.parse('2026-10-28T00:00:00Z'),transaction<T>(fn:()=>T):T{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
  try{
    const entries=loadRegistrySeed();initializeSourceRegistry(engine);
    const registry=new SourceRegistryStore(engine),before=db.prepare('SELECT * FROM source_registry_revisions ORDER BY source_id').all();
    expect(registry.list()).toHaveLength(entries.length);
    expect(registry.seed(loadRegistrySeed())).toEqual({inserted:0,unchanged:entries.length,conflicts:0});
    initializeSourceRegistry(engine);
    expect(db.prepare('SELECT * FROM source_registry_revisions ORDER BY source_id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM source_registry_conflicts').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(new Set(entries.map(e=>e.kind))).toEqual(new Set(['manufacturer_importer','catalog','official_seller','public_db','group_buy','social']));
    expect(entries.every(e=>e.permission.robots.status==='unknown'&&e.permission.terms.status==='unknown'&&e.reevaluate_at===null)).toBe(true);
    expect(registry.decide('public:cpsc','https://www.saferproducts.gov/RestWebServices/Recall?format=json',['recalls'])).toMatchObject({allowed:false,reason:'permission_unknown',revision:1});
    for(const e of entries)expect(registry.decide(e.source_id,(e.origin??'https://example.org')+'/',[]).allowed).toBe(false);
  }finally{db.close();}
});
test('every original official host keeps its exact product regex and blocked paths; missing paths stay empty',()=>{
  const entries=loadRegistrySeed();
  for(const [brand,source] of Object.entries(official)){
    for(const [host,rule] of Object.entries(source.hosts)){
      const e=entries.find(e=>e.evidence.some(v=>v.reference==='seed/official-sources.json#'+brand)&&e.origin==='https://'+host)!;
      expect(e).toBeDefined();expect(e.scope_hosts).toEqual([host]);expect(e.blocked_paths).toEqual(source.blocked_paths);
      if('product_path' in rule){expect(e.path_patterns).toEqual([rule.product_path]);expect(e.allowed_path_prefixes.length).toBeGreaterThan(0);}
      else{expect(e.allowed_path_prefixes).toEqual([]);expect(e.path_patterns).toEqual([]);expect(e.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({scope:'*'})]));}
    }
  }
  const stokke=entries.find(e=>e.origin==='https://www.stokke.com')!;
  expect(scopeReason(stokke,registryUrl('https://www.stokke.com/KOR/ko-kr/fixture.html'))).toBeUndefined();
  expect(scopeReason(stokke,registryUrl('https://www.stokke.com/KOR/ko-kr/fixture'))).toBe('path_mismatch');
  const aone=entries.find(e=>e.origin==='https://aonebaby.co.kr')!;
  expect(scopeReason(aone,registryUrl('https://aonebaby.co.kr/product/fixture'))).toBeUndefined();
  expect(scopeReason(aone,registryUrl('https://aonebaby.co.kr/product-other/fixture'))).toBe('path_mismatch');
});
test('unconfirmed endpoints and Instagram explicitly document unsupported capabilities',()=>{
  const entries=loadRegistrySeed();
  for(const id of ['catalog:unconfirmed','official-seller:unconfirmed','public:safetykorea']){
    const e=entries.find(e=>e.source_id===id)!;
    expect(e).toMatchObject({origin:null,scope_hosts:[],allowed_path_prefixes:[],collectable_fields:[]});
    expect(e.unsupported[0]).toMatchObject({scope:'*',reason:expect.any(String)});
  }
  const instagram=entries.find(e=>e.source_id==='social:instagram')!;
  expect(instagram.allowed_path_prefixes).toEqual([]);
  expect(instagram.unsupported.map(u=>u.scope)).toEqual(expect.arrayContaining(['*','automatic_login','access_bypass','images','direct_publication']));
  const first=loadRegistrySeed();first[0].scope_hosts=[];
  expect(loadRegistrySeed()[0].scope_hosts.length).toBeGreaterThan(0);
});
