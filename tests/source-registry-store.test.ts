import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { EngineDb } from '../crawler/engine/types';
import { initializeSourceRegistry, SourceRegistryStore } from '../crawler/src/source-registry/store';
import { loadRegistrySeed } from '../crawler/src/source-registry/seed';
import type { RevisionApproval, SourceRegistryEntry } from '../crawler/src/source-registry/types';
import { config, type SourcePolicy } from '../crawler/src/source-policy';

const NOW=Date.parse('2026-10-28T00:00:00Z');
const databases: DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function memory() {
  const db=new DatabaseSync(':memory:');databases.push(db);db.exec('PRAGMA foreign_keys=ON');
  let time=NOW,fail=false;
  const engine:EngineDb={db,now:()=>time,transaction<T>(fn:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const result=fn();if(fail)throw new Error('fixture_rollback');db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
  return {db,engine,advance:(ms:number)=>{time+=ms;},fail:(value:boolean)=>{fail=value;}};
}
function entry(overrides: Partial<SourceRegistryEntry>={}): SourceRegistryEntry {
  return {...loadRegistrySeed().find(e=>e.source_id==='public:cpsc')!,source_id:'fixture',origin:'https://example.org',scope_hosts:['example.org'],allowed_path_prefixes:['/products/'],path_patterns:['^/products/[a-z-]+$'],query_keys:[],collectable_fields:['manual_url'],blocked_paths:['/review'],unsupported:[],permission:{robots:{status:'allowed',checked_at:'2026-10-27T00:00:00Z',evidence:'fixture robots'},terms:{status:'allowed',checked_at:'2026-10-27T00:00:00Z',evidence:'fixture terms'}},reevaluate_at:'2026-11-28T00:00:00Z',evidence:[{reference:'synthetic fixture'}],...overrides};
}
function legacy(overrides: Partial<SourcePolicy>={}): SourcePolicy {
  return {...structuredClone(config.sources[0]),id:'legacy',origin:'https://example.org',paths:['/'],query_keys:[],official_fields:['manual_url'],enabled:true,...overrides};
}
function setup(entries=[entry()],sources=[legacy()]) {
  const f=memory();initializeSourceRegistry(f.engine,entries);
  const registry=new SourceRegistryStore(f.engine,sources);
  for(const e of entries)registry.approveRevision({...approval({...e,revision:2}),expires_at:'2026-11-28T00:00:00Z'});
  return {...f,registry};
}
function approval(next:SourceRegistryEntry): RevisionApproval {
  return {source_id:next.source_id,base_revision:next.revision-1,entry:next,decided_by:'fixture-reviewer',evidence:'fixture explicit scope review',approved_at:new Date(NOW).toISOString(),expires_at:'2026-10-29T00:00:00Z'};
}

test('normal scope requires the ID, origin, exact host, path, fields, and both permissions',()=>{
  const f=setup();
  expect(f.registry.decide('fixture','https://example.org/products/item',['manual_url'])).toMatchObject({allowed:true,reason:'approved',revision:2});
  expect(f.registry.decide('unknown','https://example.org/products/item',[])).toMatchObject({allowed:false,reason:'unknown_source',revision:null});
  expect(f.registry.decide('fixture','https://example.org/products/item',['official_msrp']).reason).toBe('field_denied');
});
test.each([
  'https://example.org/unapproved/item','https://example.org/products-other/item','https://example.org/products/item/extra',
  'https://extra.example.org/products/item','https://www.example.org/products/item','https://example.net/products/item',
])('a broad existing setting never approves an unseeded path/host: %s',url=>{
  const f=setup([entry()],[legacy(),legacy({id:'extra',origin:new URL(url).origin})]);
  expect(f.registry.decide('fixture',url,['manual_url']).allowed).toBe(false);
});
test('changing existing settings, even a matching ID, cannot expand the registered scope',()=>{
  const sources=[legacy({id:'fixture',paths:['/products/']})],f=setup([entry()],sources);
  sources[0].paths=['/'];sources.push(legacy({id:'new',origin:'https://extra.example.org'}));
  expect(f.registry.decide('fixture','https://example.org/new',['manual_url']).reason).toBe('path_mismatch');
  expect(f.registry.decide('fixture','https://extra.example.org/products/item',['manual_url']).reason).toBe('origin_mismatch');
});
test.each([false,true])('the narrow legacy denial wins independently of array order (%s)',reverse=>{
  const sources=[legacy(),legacy({id:'narrow',paths:['/products/'],enabled:false})];
  const f=setup([entry()],reverse?sources.reverse():sources);
  expect(f.registry.decide('fixture','https://example.org/products/item',['manual_url']).reason).toBe('legacy_disabled');
});
test('legacy path, query, field constraints and equal-scope ambiguity fail closed',()=>{
  for(const [sources,url,fields,reason] of [
    [[legacy({paths:['/other/']})],'https://example.org/products/item',['manual_url'],'legacy_scope_mismatch'],
    [[legacy({official_fields:[]})],'https://example.org/products/item',['manual_url'],'legacy_field_denied'],
    [[legacy(),legacy({id:'duplicate'})],'https://example.org/products/item',[],'ambiguous_scope'],
    [[],'https://example.org/products/item',[],'legacy_scope_mismatch'],
  ] as const){const f=setup([entry()],[...sources]);expect(f.registry.decide('fixture',url,fields).reason).toBe(reason);}
});
test('narrow legacy query and field denials cannot fall back to broader allowances',()=>{
  const e=entry({query_keys:['id']});
  for(const [narrow,reason] of [
    [legacy({id:'narrow-query',paths:['/products/'],query_keys:[]}), 'legacy_scope_mismatch'],
    [legacy({id:'narrow-field',paths:['/products/'],query_keys:['id'],official_fields:[]}), 'legacy_field_denied'],
  ] as const){
    for(const sources of [[legacy({query_keys:['id']}),narrow],[narrow,legacy({query_keys:['id']})]]){
      const f=setup([e],sources);
      expect(f.registry.decide('fixture','https://example.org/products/item?id=fixture',['manual_url']).reason).toBe(reason);
    }
  }
});
test.each([false,true])('a narrow registered denial cannot be bypassed via the broad ID (%s)',reverse=>{
  const broad=entry({source_id:'broad',allowed_path_prefixes:['/'],path_patterns:[]}),narrow=entry({source_id:'narrow',status:'excluded'});
  const entries=[broad,narrow],f=setup(reverse?entries.reverse():entries);
  expect(f.registry.decide('broad','https://example.org/products/item',['manual_url'])).toMatchObject({allowed:false,reason:'scope_shadowed',applied:{source_id:'narrow',revision:2}});
  expect(f.registry.decide('narrow','https://example.org/products/item',['manual_url']).reason).toBe('inactive');
});
test('a provably narrow approval takes precedence over a broad inactive scope',()=>{
  const f=setup([entry({source_id:'broad',allowed_path_prefixes:['/'],path_patterns:[],status:'excluded'}),entry()]);
  expect(f.registry.decide('fixture','https://example.org/products/item',['manual_url']).allowed).toBe(true);
});
test('equal or incomparable registered scopes are denied',()=>{
  for(const other of [entry({source_id:'equal'}),entry({source_id:'incomparable',allowed_path_prefixes:['/'],path_patterns:['^/products/.*']})]){
    const f=setup([entry(),other]);expect(f.registry.decide('fixture','https://example.org/products/item',[]).reason).toBe('ambiguous_scope');
  }
});
test('explicit revision binds scope and fields, expires without fallback, and preserves history',()=>{
  const f=setup(),next=entry({revision:3,allowed_path_prefixes:['/products/','/catalog/'],path_patterns:['^/(products|catalog)/[a-z-]+$'],collectable_fields:['manual_url','official_msrp']});
  expect(f.registry.decide('fixture','https://example.org/catalog/item',[]).allowed).toBe(false);
  f.registry.approveRevision(approval(next));
  expect(f.registry.decide('fixture','https://example.org/catalog/item',['manual_url'])).toMatchObject({allowed:true,revision:3});
  // Legacy authority still forms an intersection with the approved expansion.
  expect(f.registry.decide('fixture','https://example.org/catalog/item',['official_msrp']).reason).toBe('legacy_field_denied');
  expect(f.registry.get('fixture',1)).toEqual(entry());expect(f.registry.history('fixture')).toEqual([entry(),entry({revision:2}),next]);
  expect(f.registry.seed([entry()])).toEqual({inserted:0,unchanged:1,conflicts:0});
  expect(f.registry.get('fixture')).toEqual(next);
  f.advance(86400000);
  expect(f.registry.decide('fixture','https://example.org/products/item',[])).toMatchObject({allowed:false,reason:'approval_expired',revision:3});
});
test('an explicitly approved new origin still needs exact host and legacy approval',()=>{
  const f=setup([entry()],[legacy(),legacy({id:'alias',origin:'https://alias.example.org'})]);
  const next=entry({revision:3,origin:'https://alias.example.org',scope_hosts:['alias.example.org']});
  f.registry.approveRevision(approval(next));
  expect(f.registry.decide('fixture','https://alias.example.org/products/item',[]).allowed).toBe(true);
  expect(f.registry.decide('fixture','https://sub.alias.example.org/products/item',[]).allowed).toBe(false);
  expect(f.registry.decide('fixture','https://example.org/products/item',[]).allowed).toBe(false);
});
test('unbound, missing, future, expired, stale approvals and revision injection are rejected',()=>{
  const f=setup(),next=entry({revision:3}),valid=approval(next);
  for(const change of [
    {source_id:'other'},{base_revision:7},{decided_by:''},{evidence:''},{approved_at:'2026-10-29T00:00:00Z'},
    {expires_at:new Date(NOW).toISOString()},{entry:entry({revision:4})},
  ])expect(()=>f.registry.approveRevision({...valid,...change})).toThrow('invalid_registry_approval');
  expect(()=>f.registry.seed([next])).toThrow('seed_revision_invalid');
  f.registry.approveRevision(valid);
  expect(()=>f.registry.approveRevision(valid)).toThrow('registry_revision_conflict');
  expect(f.db.prepare('SELECT count(*) n FROM source_registry_approvals').get()!.n).toBe(2);
});
test('a changed seed is preserved as one pending conflict, without overwriting or merging',()=>{
  const f=setup(),changed=entry({allowed_path_prefixes:['/'],path_patterns:[]});
  expect(f.registry.seed([changed])).toEqual({inserted:0,unchanged:0,conflicts:1});
  expect(f.registry.seed([changed])).toEqual({inserted:0,unchanged:0,conflicts:0});
  expect(f.registry.get('fixture')).toEqual(entry({revision:2}));
  expect(f.registry.conflicts('fixture')).toMatchObject([{state:'pending',data:changed}]);
  expect(f.registry.decide('fixture','https://example.org/new',[]).allowed).toBe(false);
  for(const table of ['source_registry_revisions','source_registry_conflicts','source_registry_approvals']){
    expect(()=>f.db.exec(`UPDATE ${table} SET data='{}'`)).toThrow('immutable_registry_history');
    expect(()=>f.db.exec(`DELETE FROM ${table}`)).toThrow('immutable_registry_history');
  }
});
test('seed batches and approval records roll back atomically on failure',()=>{
  const f=setup();f.fail(true);
  expect(()=>f.registry.seed([entry({source_id:'another'})])).toThrow('fixture_rollback');
  expect(f.registry.get('another')).toBeUndefined();
  expect(()=>f.registry.approveRevision(approval(entry({revision:3})))).toThrow('fixture_rollback');
  expect(f.registry.history('fixture')).toHaveLength(2);
  expect(f.db.prepare('SELECT * FROM source_registry_approvals').all()).toHaveLength(1);
  f.fail(false);
  const bad=entry({source_id:'invalid',revision:2});
  expect(()=>f.registry.seed([entry({source_id:'another'}),bad])).toThrow('seed_revision_invalid');
  expect(f.registry.get('another')).toBeUndefined();
});
test('0005 to 0006 and seed are atomic and preserve all existing table rows',()=>{
  const f=memory();
  for(const name of ['0001_collection.sql','0002_lookup_indexes.sql','0003_engine.sql','0004_source_discovery.sql','0005_missing_field_explorer.sql'])f.db.exec(readFileSync(new URL(`../crawler/migrations/${name}`,import.meta.url),'utf8'));
  f.db.prepare('INSERT INTO collector_meta VALUES(?,?)').run('fixture','{"preserved":true}');
  f.db.exec(`
    INSERT INTO dedup_groups VALUES('group','{"preserved":"group"}');
    INSERT INTO collection_records VALUES('record','https://example.org/fixture','group','discovered','{"preserved":"record"}');
    INSERT INTO evidence_assertions VALUES('assertion','record','{"preserved":"claim"}');
    INSERT INTO evidence_conflicts VALUES('conflict','group','{"preserved":"conflict"}');
    INSERT INTO review_events VALUES('review','{"preserved":"review"}');
    INSERT INTO engine_runs VALUES('run','fixture','fixed','2026-10-28T00:00:00Z','finished','2026-10-28T00:00:00Z',NULL,'{}');
    INSERT INTO engine_captures(id,run_id,source_id,url_norm,fetched_at,status,data) VALUES('capture','run','fixture','https://example.org/fixture','2026-10-28T00:00:00Z','ok','{"preserved":"capture"}');
    INSERT INTO missing_field_slots VALUES('slot','model:fixture','manual_url','{}',NULL,1,'{"preserved":"slot"}');
    INSERT INTO missing_field_assessments VALUES('assessment','slot','digest','2026-10-28T00:00:00Z','{"preserved":"assessment"}');
  `);
  const tables=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const before=tables.map(name=>f.db.prepare(`SELECT * FROM ${name}`).all());
  expect(f.db.prepare('PRAGMA user_version').get()!.user_version).toBe(5);
  expect(()=>initializeSourceRegistry(f.engine,[entry({revision:2})])).toThrow('seed_revision_invalid');
  expect(f.db.prepare('PRAGMA user_version').get()!.user_version).toBe(5);
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='source_registry_revisions'").all()).toEqual([]);
  initializeSourceRegistry(f.engine,[entry()]);initializeSourceRegistry(f.engine,[entry()]);
  expect(f.db.prepare('PRAGMA user_version').get()!.user_version).toBe(6);
  expect(tables.map(name=>f.db.prepare(`SELECT * FROM ${name}`).all())).toEqual(before);
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(f.db.prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok');
});

test('registration and reseeding a new ID cannot grant collection authority',()=>{
  const f=memory();initializeSourceRegistry(f.engine,[entry()]);
  const registry=new SourceRegistryStore(f.engine,[legacy()]);
  expect(registry.decide('fixture','https://example.org/products/item',[]).reason).toBe('approval_required');
  registry.seed([entry({source_id:'new-scope',allowed_path_prefixes:['/catalog/'],path_patterns:[]})]);
  expect(registry.decide('new-scope','https://example.org/catalog/item',[]).reason).toBe('approval_required');
  registry.approveRevision(approval(entry({source_id:'new-scope',revision:2,allowed_path_prefixes:['/catalog/'],path_patterns:[]})));
  expect(registry.decide('new-scope','https://example.org/catalog/item',[]).allowed).toBe(true);
});

test('redundant specific alternatives cannot disguise a broad scope as a narrow approval',()=>{
  const f=setup([entry({source_id:'denial',allowed_path_prefixes:['/'],path_patterns:[],status:'excluded'}),entry({allowed_path_prefixes:['/','/products/'],path_patterns:[]})]);
  expect(f.registry.decide('fixture','https://example.org/products/item',[]).reason).toBe('ambiguous_scope');
  const g=setup([entry()],[legacy({paths:['/','/products/item']}),legacy({id:'narrow',paths:['/products/'],enabled:false})]);
  expect(g.registry.decide('fixture','https://example.org/products/item',[]).reason).toBe('legacy_disabled');
});
