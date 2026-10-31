import { sqliteRuntimeSafe } from './sqlite-runtime';
import { initializeSourceRegistry } from './source-registry/store';
import { acquireRunLock, acquireRunLockWithRetry, type RunKind, type RunLock, type ProcReader, type RunLockOptions } from './run-lock';
import { supersedes, evaluateConflictSet, EVIDENCE_POLICY_VERSION } from './conflict-policy';
import { reviewScopeValidity, ordered, REVIEW_POLICY_VERSION, type ReviewScopeSnapshot } from './evidence-policy';
import { validateProvenance, linkExtractedInside, type ProvenanceInput } from './evidence-provenance';
import { axesOf, mergeConflict, conflictAxes, contradictoryAxes, type Axes } from './merge-rules';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATUSES } from '../../shared/collection-schema';
import { type AssertionInput, type Binding, type ClipPayload, type CollectionRecord, type Snapshot } from '../../shared/collection-schema';
import { PRIVACY_VERSION, canonicalUrl, filterText } from '../../shared/privacy-rules';
import { config, sourceFor, validateConfig, type CollectorConfig } from './source-policy';
import { privacyFilter, LINUX_PRIVACY_VERSION } from './privacy-filter';
import { dedupKey, digest, stable } from './dedup';
export class CollectorError extends Error { constructor(public code: string, public status = 400, public detail?: Record<string,string|number>) { super(code); } }
export const requireThat = (ok: unknown, code: string, status = 409): void => { if (!ok) throw new CollectorError(code,status); };
type Table = 'collector_meta'|'collection_records'|'dedup_groups'|'dedup_members'|'evidence_assertions'|'group_evidence_links'|'evidence_conflicts'|'review_events'|'collection_jobs'|'intake_reservations'|'intake_attempts'|'intake_receipts'|'daily_budgets'|'domain_state'|'seller_candidates'|'seller_candidate_sources'|'legacy_imports'|'sync_outbox';
export type Group = { id: string; key: string; representative: string; group_version: number; evidence_version: number; review_scope_digest: string; verified_evidence_version: number|null; ready_evidence_version: number|null; retired?: boolean; lineage: string[]; aliases?:string[]; review_policy_version?:string; verified_scope_digest?:string; ready_scope_digest?:string };
export type Evidence = AssertionInput & { id: string; record_id: string; url: string; source_kind: string; observed_at: string; level: 'clue'|'authorized'; withdrawn?: boolean; superseded_by?: string; seller?: string; target_ref?:string };
export type Conflict = { id: string; group_id: string; assertions: string[]; reason: string; resolved: boolean; selected?: string; resolution?: string; policy_version?:string; input_digest?:string };
type Reservation = Binding & { id: string; client: string; record_id: string; day: string; expires_at: number; execution_until?: number; submit_until?: number; phase:'held'|'started'|'expired'|'cancelled'|'complete' };
type Receipt = { id: string; digest: string; record_id: string; reservation_id: string; provenance_digest?:string };
type Budget = { held: number; spent: number };
export type Seller = { id: string; handle: string; platform: string; found_via: string; first_seen: string; last_seen: string; hits: number; legacy_hits: number; sample_urls: string[]; matched_models: string[]; status: string; reason?: string };
const dayKey = (t: number) => new Date(t+9*3600000).toISOString().slice(0,10);
const midnight = (t: number) => Date.parse(`${dayKey(t)}T00:00:00+09:00`)+86400000;
export type JobSummary = {generated_at:string;sources:Record<string,{done:number;failed:number;pending:number;failures:Record<string,number>;last_failure?:{reason:string;at:string}}>};
export class CollectorStore {
  readonly db: DatabaseSync;
  private runLocks: RunLock[] = [];
  private closed = false;
  private releaseRunLocks = () => { for (const lock of this.runLocks) lock.release(); this.runLocks = []; };
  private inTransaction = false;
  private snapshotTime?:number;
  get asOf(){return this.snapshotTime??this.now();}
  readSnapshot<T>(task:(asOf:number)=>T):T {return this.inTransaction?task(this.asOf):this.transaction(()=>task(this.asOf));}
  constructor(readonly file: string, readonly settings: CollectorConfig = config, readonly now = Date.now, readonly fault: (point: string)=>void = ()=>{}, sqliteVersion = process.versions.sqlite ?? 'unknown') {
    if (!sqliteRuntimeSafe(sqliteVersion)) throw new CollectorError('sqlite_runtime_unsafe',500,{sqlite:sqliteVersion,node:process.versions.node});
    validateConfig(settings); process.umask(0o077);
    const dir = dirname(resolve(file));
    mkdirSync(dir,{recursive:true,mode:0o700});
    requireThat(realpathSync(dir) === dir && !lstatSync(dir).isSymbolicLink() && (lstatSync(dir).mode&0o077)===0,'unsafe_directory');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (suffix) this.fault(`aux_check:${suffix}`);
      const stat=lstatSync(file+suffix,{throwIfNoEntry:false});
      if (stat) requireThat(!stat.isSymbolicLink() && stat.isFile() && (stat.mode&0o077)===0,'unsafe_file');
    }
    // Legacy DB-wide locks are deliberately left untouched, including empty files.
    if (lstatSync(`${file}.lock`,{throwIfNoEntry:false})) console.error(`collector_warning legacy_lock_present path=${basename(file)}.lock`);
    let opened:DatabaseSync|undefined;
    try {
      this.db=opened=new DatabaseSync(file);
      this.db.exec(`PRAGMA busy_timeout=${settings.busy_timeout_ms}; PRAGMA foreign_keys=ON;`);
      this.retryBusy(()=>this.db.exec('PRAGMA journal_mode=WAL;'));
      this.db.exec('PRAGMA synchronous=FULL;');
      const uv=()=>(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
      for (const [version,name] of [[1,'0001_collection.sql'],[2,'0002_lookup_indexes.sql']] as const) {
        if (uv()<version) this.transaction(()=>{ if (uv()<version) this.db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')); });
      }
      if (uv()<3) {
        const backup=`${resolve(file)}.pre-0003-${new Date(this.now()).toISOString().replaceAll(':','-')}-${randomUUID()}.sqlite`;
        this.retryBusy(()=>this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`));chmodSync(backup,0o600);
        this.transaction(()=>{ if (uv()<3) this.db.exec(readFileSync(new URL('../migrations/0003_engine.sql',import.meta.url),'utf8')); });
      }
      if(uv()<4)this.transaction(()=>{if(uv()<4)this.db.exec(readFileSync(new URL('../migrations/0004_source_discovery.sql',import.meta.url),'utf8'));});
      if(uv()<5)this.transaction(()=>{if(uv()<5)this.db.exec(readFileSync(new URL('../migrations/0005_missing_field_explorer.sql',import.meta.url),'utf8'));});
      initializeSourceRegistry(this);
      requireThat(!this.db.prepare('PRAGMA foreign_key_check').all().length,'database_foreign_key');
      requireThat((this.db.prepare('PRAGMA quick_check').get() as {quick_check:string}).quick_check==='ok','database_corrupt');
      this.secureFiles();
      this.transaction(()=>{if(this.get('collector_meta','version')===undefined)this.put('collector_meta','version',0);const prior=this.get<number>('collector_meta','policy');if(prior!==undefined&&(prior!==settings.policy_version||this.get<number>('collector_meta','privacy_version')!==PRIVACY_VERSION||this.get('collector_meta','linux_privacy_version')!==LINUX_PRIVACY_VERSION)){for(const g of this.list<Group>('dedup_groups').filter(g=>!g.retired))this.invalidate(g.id,'policy_changed');this.snapshotInside();}this.put('collector_meta','policy',settings.policy_version);this.put('collector_meta','privacy_version',PRIVACY_VERSION);this.put('collector_meta','linux_privacy_version',LINUX_PRIVACY_VERSION);});
      this.transaction(()=>{
        if(this.get('collector_meta','evidence_policy')!==EVIDENCE_POLICY_VERSION)this.put('collector_meta','review_epoch',(this.get<number>('collector_meta','review_epoch')??0)+1);
        this.db.prepare("INSERT OR IGNORE INTO evidence_policy_jobs(group_id,policy_version,state) SELECT id,?,'pending' FROM dedup_groups WHERE NOT coalesce(json_extract(data,'$.retired'),0)").run(EVIDENCE_POLICY_VERSION);
        this.put('collector_meta','evidence_policy',EVIDENCE_POLICY_VERSION);
      });
    } catch (e) { opened?.close(); throw e; }
  }
  private secureFiles() {
    for (const path of [this.file,`${this.file}-wal`,`${this.file}-shm`,`${this.file}-journal`]) {
      const stat=lstatSync(path,{throwIfNoEntry:false});
      if (!stat) continue;
      requireThat(!stat.isSymbolicLink() && stat.isFile(),'unsafe_file');
      if ((stat.mode&0o777)!==0o600) {
        try { chmodSync(path,0o600); } catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
      }
    }
  }
  private ownRunLock(lock: RunLock) {
    if(this.closed) {lock.release();throw new CollectorError('store_closed');}
    if (!this.runLocks.length) process.once('exit',this.releaseRunLocks);
    this.runLocks.push(lock);
  }
  runLock(kind: RunKind, options?: RunLockOptions | ProcReader) {
    requireThat(!this.closed,'store_closed');
    this.ownRunLock(acquireRunLock(this,kind,options));
  }
  async waitForRunLock(kind: RunKind, options?: RunLockOptions) {
    requireThat(!this.closed,'store_closed');
    const result=await acquireRunLockWithRetry(this,kind,options);
    if(result.acquired)this.ownRunLock(result.lock);
    return result;
  }
  runLockTransaction<T>(task:()=>T): T {
    requireThat(!this.closed,'store_closed');
    requireThat(!this.inTransaction,'nested_transaction');
    const {timeout}=this.db.prepare('PRAGMA busy_timeout').get() as {timeout:number};
    this.db.exec('PRAGMA busy_timeout=0');
    try {return this.transaction(task,0);}
    finally {this.db.exec(`PRAGMA busy_timeout=${timeout}`);}
  }
  close() {
    if (this.closed) return;
    try { this.db.close(); } finally {
      this.closed=true; this.releaseRunLocks(); process.removeListener('exit',this.releaseRunLocks);
    }
  }
  private isBusy(error: unknown) {
    const e=error as {errcode?:number;message?:string}|null;
    return !!e && (typeof e.errcode==='number' && (e.errcode&0xff)===5 || /database is locked|SQLITE_BUSY/i.test(e.message??''));
  }
  private retryBusy<T>(task:()=>T, retries=this.settings.busy_retries): T {
    for (let attempt=0;;attempt++) {
      try { return task(); } catch(e) {
        if (!this.isBusy(e)) throw e;
        if (attempt>=retries) throw new CollectorError('database_busy',503);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50+Math.floor(Math.random()*201));
      }
    }
  }
  get<T>(table: Table, id: string): T|undefined { const row=this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|undefined; return row ? JSON.parse(row.data) as T : undefined; }
  list<T>(table: Table): T[] { return (this.db.prepare(`SELECT data FROM ${table} ORDER BY id`).all() as {data:string}[]).map(r=>JSON.parse(r.data) as T); }
  put(table: Table, id: string, data: unknown) {
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id,JSON.stringify(data));
    if(table==='dedup_groups'){
      const g=data as Group;this.db.prepare('DELETE FROM dedup_keys WHERE group_id=?').run(id);
      if(!g.retired)for(const key of new Set([g.key,...(g.aliases??[])]))this.db.prepare('INSERT INTO dedup_keys(key,group_id) VALUES(?,?)').run(key,id);
    }
  }
  transaction<T>(task:()=>T, busyRetries=this.settings.busy_retries): T {
    requireThat(!this.inTransaction,'nested_transaction'); this.retryBusy(()=>this.db.exec('BEGIN IMMEDIATE'),busyRetries); this.inTransaction=true;this.snapshotTime=this.now();
    try { const result=task(); this.fault('before_commit'); this.db.exec('COMMIT'); this.secureFiles(); return result; }
    catch(e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); if(this.isBusy(e))throw new CollectorError('database_busy',503); throw e; }
    finally { this.inTransaction=false;this.snapshotTime=undefined; }
  }
  private saveRecord(r: CollectionRecord) { this.db.prepare('INSERT INTO collection_records(id,url,group_id,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,group_id=excluded.group_id,status=excluded.status,data=excluded.data').run(r.id,r.url,r.dedup_group_id,r.verification_status,JSON.stringify(r)); }
  private rows<T>(sql:string,...args:SQLInputValue[]):T[] {return (this.db.prepare(sql).all(...args) as {data:string}[]).map(r=>JSON.parse(r.data) as T);}
  private members(groupId:string) {return this.rows<CollectionRecord>('SELECT data FROM collection_records WHERE group_id=? ORDER BY id',groupId);}
  recordByUrl(url: string) {return this.rows<CollectionRecord>('SELECT data FROM collection_records WHERE url=?',url)[0];} 
  private budget(day: string, brand: string, kind: string) { const id=`${day}:${brand}:${kind}`; return {id,...(this.get<Budget>('daily_budgets',id)??{held:0,spent:0})}; }
  private spend(brand: string,kind:'discovered'|'new_body'|'recheck',held=false) { const b=this.budget(dayKey(this.now()),brand,kind); requireThat(b.spent+b.held<this.settings.limits[kind],'daily_limit',429); if(held)b.held++;else b.spent++; this.put('daily_budgets',b.id,b); }
  authorizeProbe(brand:string) {requireThat(brand==='unknown'||this.settings.sources.some(s=>s.brand===brand),'brand_mismatch');return this.transaction(()=>this.spend(brand,'new_body'));}
  private group(key: string, representative: string): Group {
    const g:Group={id:randomUUID(),key,representative,group_version:0,evidence_version:0,review_scope_digest:'',verified_evidence_version:null,ready_evidence_version:null,lineage:[]}; this.put('dedup_groups',g.id,g); return g;
  }
  private discoverInside(raw: string, method: Binding['collection_method'], title: string|null = null) {
    const url=canonicalUrl(raw); const existing=this.recordByUrl(url); if(existing) return existing;
    const s=sourceFor(url,this.settings); this.spend(s?.brand??'unknown','discovered');
    const id=randomUUID(),g=this.group(`url:${url}`,id);
    const r:CollectionRecord={id,url,title:title?filterText(title,200):null,source:s?.id??'unknown',published_at:null,collected_at:new Date(this.now()).toISOString(),target_model_id:null,extracted_facts:{},evidence_locator:[],dedup_group_id:g.id,verification_status:'discovered',collection_method:method,schema_version:1,record_version:1,privacy_filter_version:PRIVACY_VERSION,conflict_detected:false,last_checked_at:null,next_recheck_at:null};
    this.saveRecord(r); this.member(r,'url'); this.invalidate(g.id,'discovery'); return r;
  }
  discover(url: string, method: Binding['collection_method']='auto_discovery', title: string|null=null) { return this.transaction(()=>{const before=this.recordByUrl(canonicalUrl(url));const r=this.discoverInside(url,method,title);if(!before)this.snapshotInside();return r;}); }
  private member(r:CollectionRecord,reason:string) { this.db.prepare('INSERT INTO dedup_members(id,group_id,record_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,data=excluded.data').run(r.id,r.dedup_group_id,r.id,JSON.stringify({id:r.id,group_id:r.dedup_group_id,record_id:r.id,reason})); }
  private reap() {
    for(const r of this.rows<Reservation>("SELECT data FROM intake_reservations WHERE json_extract(data,'$.phase')='held' AND json_extract(data,'$.expires_at')<=?",this.now())) { r.phase='expired';this.release(r);this.put('intake_reservations',r.id,r); }
  }
  private release(r:Reservation) { const b=this.budget(r.day,r.brand,r.operation); requireThat(b.held>0,'budget_invariant');b.held--;this.put('daily_budgets',b.id,b); }
  reserve(client:string, binding:Binding):Reservation {
    return this.transaction(()=>{
      this.reap(); const safeId=(id:string)=>typeof id==='string'&&/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id);
      requireThat(safeId(binding.clip_id)&&safeId(binding.attempt_id),'invalid_id',400);
      requireThat(['auto_discovery','browser_extract','manual_clip'].includes(binding.collection_method)&&['new_body','recheck'].includes(binding.operation),'invalid_method',400);
      const b:Binding={clip_id:binding.clip_id,attempt_id:binding.attempt_id,url:canonicalUrl(binding.url),brand:binding.brand,collection_method:binding.collection_method,operation:binding.operation,policy_version:binding.policy_version};
      if(b.collection_method==='browser_extract')requireThat(sourceFor(b.url,this.settings)?.browser,'browser_not_approved',403);
      requireThat(b.policy_version===this.settings.policy_version,'policy_changed');
      requireThat(b.brand===(sourceFor(b.url,this.settings)?.brand??'unknown'),'brand_mismatch');
      const id=digest([client,b.clip_id,b.attempt_id]); const old=this.get<Reservation>('intake_reservations',id);
      if(old) { requireThat(stable(Object.fromEntries(Object.keys(b).map(k=>[k,old[k as keyof Reservation]])))===stable(b),'binding_changed');return old; }
      const existing=this.recordByUrl(b.url);requireThat(b.operation!=='recheck'||existing?.last_checked_at,'invalid_recheck');
      const record=this.discoverInside(b.url,b.collection_method); this.spend(b.brand,b.operation,true);
      const r:Reservation={...b,id,client,record_id:record.id,day:dayKey(this.now()),expires_at:Math.min(this.now()+this.settings.reservation_ms,midnight(this.now())),phase:'held'};
      this.put('intake_reservations',id,r);this.fault('reservation');this.snapshotInside();return r;
    });
  }
  reservation(client:string,id:string) { const r=this.get<Reservation>('intake_reservations',id); requireThat(r?.client===client,'reservation_not_found',404);return r!; }
  clip(client:string,id:string) { this.transaction(()=>this.reap());const attempts=this.rows<Reservation>("SELECT data FROM intake_reservations WHERE json_extract(data,'$.client')=? AND json_extract(data,'$.clip_id')=?",client,id);return {attempts,receipts:attempts.flatMap(r=>{const receipt=this.get<Receipt>('intake_receipts',r.id);return receipt?[receipt]:[];})}; }

  start(client:string,id:string) {
    return this.transaction(()=>{this.reap();const r=this.reservation(client,id);if(['started','complete'].includes(r.phase))return r;requireThat(r.phase==='held','reservation_expired');this.release(r);const b=this.budget(r.day,r.brand,r.operation);b.spent++;this.put('daily_budgets',b.id,b);r.phase='started';r.execution_until=this.now()+this.settings.execution_ms;r.submit_until=this.now()+this.settings.submission_grace_ms;this.put('intake_reservations',id,r);this.put('intake_attempts',id,{...r,started_at:this.now()});this.fault('start');return r;});
  }
  cancel(client:string,id:string) {return this.transaction(()=>{this.reap();const r=this.reservation(client,id);requireThat(r.phase!=='started'&&r.phase!=='complete','already_started');if(r.phase==='held'){this.release(r);r.phase='cancelled';this.put('intake_reservations',id,r);}return r;});}
  receipt(id:string) {return this.get<Receipt>('intake_receipts',id);}
  submit(client:string,id:string,raw:unknown,trustedSourceId?:string):Receipt {
    return this.submitInternal(client,id,raw,trustedSourceId);
  }
  submitExtracted(id:string,raw:unknown,provenance:ProvenanceInput,trustedSourceId?:string):Receipt {
    return this.submitInternal('linux',id,raw,trustedSourceId,provenance);
  }
  private submitInternal(client:string,id:string,raw:unknown,trustedSourceId?:string,provenance?:ProvenanceInput):Receipt {
    const p=privacyFilter(raw),hash=digest(p);
    return this.transaction(()=>{
      if(trustedSourceId)requireThat(client==='linux'&&this.settings.sources.some(s=>s.id===trustedSourceId&&s.adapter==='cpsc'),'adapter_authority');
      const r=this.reservation(client,id),receipt=this.get<Receipt>('intake_receipts',id);
      if(receipt){requireThat(receipt.digest===hash&&receipt.provenance_digest===(provenance?digest(provenance):undefined),'payload_changed');return receipt;}
      requireThat(r.phase==='started'&&r.submit_until!>=this.now(),'submission_expired');
      const facts=provenance?validateProvenance(this,p,provenance,r.url):[];
      requireThat(facts.every(f=>!this.db.prepare('SELECT 1 FROM extracted_assertion_links WHERE extracted_id=?').get(f.id)),'provenance_reused');
      const assertions=this.applyPayload(r.record_id,p,r.id,trustedSourceId,facts[0]?.collected_at??(provenance?String(this.db.prepare('SELECT fetched_at FROM engine_captures WHERE id=?').get(provenance.capture_id)!.fetched_at):undefined));
      facts.forEach((f,index)=>linkExtractedInside(this,f,assertions[index],id));this.fault('evidence');
      const ack={id,digest:hash,record_id:r.record_id,reservation_id:id,...(provenance?{provenance_digest:digest(provenance)}:{})};this.put('intake_receipts',id,ack);r.phase='complete';this.put('intake_reservations',id,r);this.put('intake_attempts',id,r);this.snapshotInside();this.fault('intake');return ack;
    });
  }
  private activeEvidence(id:string){return this.rows<Evidence>('SELECT data FROM evidence_assertions WHERE record_id=?',id).filter(a=>!a.withdrawn&&!a.superseded_by);}
  private recordAxes(id:string,incoming:AssertionInput[]=[]):Axes {
    return axesOf([...this.activeEvidence(id).filter(a=>!incoming.some(n=>supersedes({...n,url:this.get<CollectionRecord>('collection_records',id)?.url},a))),...incoming]);
  }
  reviewSnapshot(groupId:string):ReviewScopeSnapshot {
    const groups:Group[]=[],documents:CollectionRecord[]=[],evidence:ReviewScopeSnapshot['evidence']=[],links:unknown[]=[],provenance:unknown[]=[],reviews:ReviewScopeSnapshot['reviews']=[];
    const seen=new Set<string>();let complete=true;
    const visit=(id:string)=>{
      if(seen.has(id))return;seen.add(id);
      const g=this.get<Group>('dedup_groups',id);if(!g||g.retired){complete=false;return;}groups.push(g);
      const members=this.members(id);if(!members.length)complete=false;documents.push(...members);
      reviews.push(...this.rows<ReviewScopeSnapshot['reviews'][number]>("SELECT json_set(data,'$.id',id) AS data FROM review_events WHERE json_extract(data,'$.group_id')=? AND json_extract(data,'$.decision') IN ('verify','ready') ORDER BY id",id));
      const claims=this.evidence(id).map(e=>{const r=this.get<CollectionRecord>('collection_records',e.record_id);return {...e,target_ref:r?.target_model_id?`model:${r.target_model_id}`:`document:${e.record_id}`};});evidence.push({group_id:id,claims,resolutions:this.conflictHistory(id)});
      links.push(...this.db.prepare('SELECT group_id,assertion_id FROM group_evidence_links WHERE group_id=? ORDER BY assertion_id').all(id));
      for(const r of members){
        provenance.push(...this.db.prepare('SELECT * FROM missing_field_target_links WHERE record_id=? ORDER BY id').all(r.id));
        provenance.push(...this.db.prepare('SELECT l.*,x.capture_id,x.fact_status,x.extractor,x.effective_from,x.effective_from_basis,c.content_hash,c.status,c.fetched_at FROM evidence_assertions e JOIN extracted_assertion_links l ON l.assertion_id=e.id JOIN engine_extracted x ON x.id=l.extracted_id JOIN engine_captures c ON c.id=x.capture_id WHERE e.record_id=? ORDER BY l.extracted_id').all(r.id));
      }
      for(const claim of claims.filter(e=>!e.withdrawn&&!e.superseded_by)){
        const owner=this.get<CollectionRecord>('collection_records',claim.record_id);
        if(!owner){complete=false;continue;}
        if(owner.dedup_group_id!==id)visit(owner.dedup_group_id);
      }
    };
    visit(groupId);
    return {root:groupId,groups,documents:ordered(documents),evidence:evidence.sort((a,b)=>a.group_id.localeCompare(b.group_id)),links:ordered(links),provenance:ordered(provenance),reviews:ordered(reviews),policy:this.settings.policy_version,epoch:this.get<number>('collector_meta','review_epoch')??0,complete};
  }
  reviewValidity(groupId:string,asOf=this.asOf){return reviewScopeValidity(this.reviewSnapshot(groupId),asOf);}
  private scopeAxes(groupId:string,excludeRecordId?:string):Axes {
    return axesOf(this.reviewSnapshot(groupId).evidence.flatMap(g=>g.claims).filter(e=>e.record_id!==excludeRecordId));
  }
  dedupAudit({apply=false}:{apply?:boolean}={}) {
    const violations=this.list<Group>('dedup_groups').filter(g=>!g.retired).flatMap(g=>{
      const ids=new Set([...this.members(g.id).map(r=>r.id),...this.evidence(g.id).filter(e=>!e.withdrawn&&!e.superseded_by).map(e=>e.record_id)]);
      const members=[...ids].map(id=>this.get<CollectionRecord>('collection_records',id)!),pairs=[];
      for(const r of members){const axes=contradictoryAxes(this.recordAxes(r.id));if(axes.length)pairs.push({group_id:g.id,records:[r.id],axes});}
      for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){
        const axes=conflictAxes(this.recordAxes(members[i].id),this.recordAxes(members[j].id));
        if(axes.length)pairs.push({group_id:g.id,records:[members[i].id,members[j].id],axes});
      }
      return pairs;
    });
    if(apply&&violations.length)this.transaction(()=>{
      for(const groupId of new Set(violations.map(v=>v.group_id))){
        const kept:string[]=[];
        for(const r of this.members(groupId)){
          if(!kept.some(id=>mergeConflict(this.recordAxes(id),this.recordAxes(r.id)))){kept.push(r.id);continue;}
          const next=this.group(`audit:${r.id}`,r.id);next.lineage.push(groupId);this.put('dedup_groups',next.id,next);
          r.dedup_group_id=next.id;this.saveRecord(r);this.member(r,'merge_forbidden_split');
          this.db.prepare('DELETE FROM collector_meta WHERE id=?').run(`dedup_override:${r.id}`);
          this.put('review_events',randomUUID(),{decision:'merge_forbidden_split',record_id:r.id,group_id:groupId,axes:this.recordAxes(r.id),at:this.now()});this.invalidate(next.id,'merge_forbidden_split');
        }
        this.invalidate(groupId,'merge_forbidden_split');
      }
      this.snapshotInside();
    });
    return violations;
  }
  private applyPayload(id:string,p:ClipPayload,eventId:string,trustedSourceId?:string,collectedAt?:string) {
    const r=this.get<CollectionRecord>('collection_records',id)!;const s=trustedSourceId?this.settings.sources.find(s=>s.id===trustedSourceId):sourceFor(r.url,this.settings);
    if(trustedSourceId&&s)r.source=s.id;
    const observedAt=collectedAt??new Date(this.asOf).toISOString();
    if(p.target_model_id&&p.target_model_id!==r.target_model_id){
      const from=r.target_model_id?`model:${r.target_model_id}`:`document:${r.id}`,to=`model:${p.target_model_id}`,link=digest([id,eventId,from,to]);
      this.db.prepare('INSERT OR IGNORE INTO missing_field_target_links VALUES(?,?,?,?,?,?)').run(link,id,from,to,observedAt,'explicit_target_assignment');
    }
    r.title=p.title??r.title;r.published_at=p.published_at??r.published_at;r.target_model_id=p.target_model_id??r.target_model_id;r.record_version++;
    r.last_checked_at=r.last_checked_at&&Date.parse(r.last_checked_at)>Date.parse(observedAt)?r.last_checked_at:observedAt;
    r.next_recheck_at=new Date(Date.parse(r.last_checked_at)+(s?.recheck_ms??86400000)).toISOString();
    const incoming=this.recordAxes(id,p.assertions);
    const key=dedupKey(r.url,{...p,target_model_id:r.target_model_id,assertions:[...this.activeEvidence(id).filter(a=>!p.assertions.some(n=>supersedes({...n,url:r.url,seller:p.seller_handle},a))),...p.assertions]});
    const oldGroup=r.dedup_group_id,override=this.get<string>('collector_meta',`dedup_override:${r.id}`);
    const groups=this.rows<Group>("SELECT data FROM dedup_groups WHERE id=? OR id IN (SELECT group_id FROM dedup_keys WHERE key IN (?,?))",override??'',key,`document:${r.url}`).filter(g=>!g.retired);
    const linked=p.document_origin&&new URL(p.document_origin).pathname!=='/'?this.recordByUrl(p.document_origin):undefined;
    const candidates=[groups.find(g=>g.id===override),...groups.filter(g=>g.key===key||g.aliases?.includes(key)),linked?this.get<Group>('dedup_groups',linked.dedup_group_id):undefined,...groups.filter(g=>g.key===`document:${r.url}`)];
    const compatible=(g:Group)=>!contradictoryAxes(incoming).length&&!g.retired&&!mergeConflict(incoming,this.scopeAxes(g.id,id));
    const invalidOverride=override&&candidates.find(g=>g?.id===override&&!compatible(g));
    if(invalidOverride){this.db.prepare('DELETE FROM collector_meta WHERE id=?').run(`dedup_override:${id}`);this.put('review_events',randomUUID(),{decision:'merge_forbidden_split',record_id:id,group_id:override,axes:incoming,at:this.now()});}
    const target=candidates.find((g):g is Group=>!!g&&compatible(g));
    if(target&&target.id!==oldGroup) {
      r.dedup_group_id=target.id;target.lineage=[...new Set([...target.lineage,oldGroup])];this.put('dedup_groups',target.id,target);this.saveRecord(r);this.member(r,'reviewed_family_or_document');this.retireOrInvalidate(oldGroup,'member_moved');
    } else if(!target) {
      const g=this.get<Group>('dedup_groups',oldGroup)!;
      if(this.members(oldGroup).length>1&&(g.key!==key||!compatible(g)||invalidOverride)){
        const next=this.group(key,id);next.lineage.push(oldGroup);this.put('dedup_groups',next.id,next);r.dedup_group_id=next.id;this.saveRecord(r);this.member(r,'model_or_generation_changed');this.retireOrInvalidate(oldGroup,'member_moved');
      }else{g.key=key;this.put('dedup_groups',g.id,g);}
    }
    const created:Evidence[]=[];
    // Only prior submissions may be superseded; sibling assertions must remain independent evidence.
    const priorEvidence=this.rows<Evidence>('SELECT data FROM evidence_assertions WHERE record_id=?',id);
    for(const a of p.assertions) {
      const authorized=!!s?.official_fields.includes(a.field) && (a.field!=='official_msrp'||(a.msrp_explicit===true&&['manufacturer','importer'].includes(s.kind)));
      const field=a.field==='official_msrp'&&!authorized?'clue_price':a.field;
      const e:Evidence={...a,field,id:randomUUID(),record_id:id,url:r.url,source_kind:s?.kind??'unknown',observed_at:observedAt,level:authorized?'authorized':'clue',seller:p.seller_handle??priorEvidence.find(e=>e.seller)?.seller};
      for(const old of priorEvidence.filter(old=>!old.withdrawn&&!old.superseded_by&&supersedes(e,old))){
        if(Date.parse(old.observed_at)>Date.parse(observedAt)){e.superseded_by=old.id;continue;}
        old.superseded_by=e.id;this.db.prepare('UPDATE evidence_assertions SET data=? WHERE id=?').run(JSON.stringify(old),old.id);
      }
      this.db.prepare('INSERT INTO evidence_assertions(id,record_id,data) VALUES(?,?,?)').run(e.id,id,JSON.stringify(e));
      created.push(e);
      (r.extracted_facts[field]??=[]).push({assertion_id:e.id,value:e.value}); r.evidence_locator.push(e.locator);
    }
    r.evidence_locator=[...new Set(r.evidence_locator)];this.saveRecord(r);
    if(s?.full_text_allowed&&s.permission_basis&&p.full_text)this.put('collector_meta',`fulltext:${id}`,{text:p.full_text,permission:s.permission_basis});
    if(p.seller_handle)this.sellerObservation(p.seller_handle,s?.id??'unknown',r.url,p.target_model_id?[p.target_model_id]:[],eventId);
    this.detectConflicts(r.dedup_group_id);this.invalidate(r.dedup_group_id,'new_observation');
    return created;
  }
  evidence(groupId:string) {return this.rows<Evidence>(`SELECT data FROM evidence_assertions WHERE record_id IN (SELECT id FROM collection_records WHERE group_id=?) UNION SELECT e.data FROM group_evidence_links l JOIN evidence_assertions e ON e.id=l.assertion_id WHERE l.group_id=? ORDER BY data`,groupId,groupId);}
  conflictHistory(groupId:string){return this.rows<Conflict>('SELECT data FROM evidence_conflicts WHERE group_id=? ORDER BY id',groupId);}
  conflictEvaluation(groupId:string,asOf=this.asOf){
    const evidence=this.evidence(groupId).map(e=>{
      const r=this.get<CollectionRecord>('collection_records',e.record_id);
      const fresh=r?.last_checked_at&&r.next_recheck_at&&Date.parse(r.next_recheck_at)>asOf;
      return {...e,target_ref:r?.target_model_id?`model:${r.target_model_id}`:`document:${e.record_id}`,...(!fresh?{unavailable_reason:'source_expired'}:{})};
    });
    return evaluateConflictSet(evidence,this.conflictHistory(groupId),asOf);
  }
  policyComparisons(groupId:string){return this.conflictEvaluation(groupId).pairs;}
  groupMergeSafe(groupId:string){return !contradictoryAxes(this.scopeAxes(groupId)).length;}
  conflicts(groupId:string,asOf=this.asOf) {
    const history=this.conflictHistory(groupId),evaluation=this.conflictEvaluation(groupId,asOf);
    const current=evaluation.pairs.filter(p=>p.result==='conflict').map(p=>{
      const id=digest([groupId,...p.assertions]),old=history.find(c=>c.id===id);
      return {...old,id,group_id:groupId,assertions:p.assertions,reason:'different_values',resolved:!!p.resolution,selected:p.resolution?.selected,resolution:p.resolution?old?.resolution:undefined} as Conflict;
    });
    for(const old of history)if(evaluation.reopened.some(r=>r.id===old.id))current.push({...old,resolved:false,reason:'selected_evidence_inactive'});
    return current.sort((a,b)=>a.id.localeCompare(b.id));
  }
  reconcileConflictInside(groupId:string){this.detectConflicts(groupId);this.db.prepare("UPDATE evidence_policy_jobs SET state='done' WHERE group_id=? AND policy_version=?").run(groupId,EVIDENCE_POLICY_VERSION);}
  private detectConflicts(groupId:string) {
    const evaluation=this.conflictEvaluation(groupId),input=evaluation.input_digest;
    const data={pairs:evaluation.pairs.map(p=>({assertions:p.assertions,result:p.result,resolution:p.resolution??null})),history:this.conflictHistory(groupId),excluded:evaluation.excluded,reopened:evaluation.reopened};
    const id=digest([groupId,EVIDENCE_POLICY_VERSION,input,data]);
    if(!this.db.prepare('SELECT 1 FROM evidence_conflict_evaluations WHERE id=?').get(id))this.db.prepare('INSERT INTO evidence_conflict_evaluations VALUES(?,?,?,?,?,?)').run(id,groupId,EVIDENCE_POLICY_VERSION,input,new Date(this.asOf).toISOString(),stable(data));
    for(const c of this.conflicts(groupId))if(!this.get('evidence_conflicts',c.id))this.db.prepare('INSERT INTO evidence_conflicts(id,group_id,data) VALUES(?,?,?)').run(c.id,groupId,JSON.stringify(c));
  }
  private invalidate(groupId:string,reason:string,visited=new Set<string>()) {
    if(visited.has(groupId))return;visited.add(groupId);
    const g=this.get<Group>('dedup_groups',groupId)!;if(g.retired)return;
    if(g.verified_evidence_version!==null||g.ready_evidence_version!==null)this.put('review_events',randomUUID(),{group_id:groupId,decision:'invalidated',reason,previous_version:g.evidence_version,at:this.now()});
    g.group_version++;g.evidence_version++;g.verified_evidence_version=null;g.ready_evidence_version=null;delete g.verified_scope_digest;delete g.ready_scope_digest;
    const members=this.members(groupId);
    if(!members.some(r=>r.id===g.representative))g.representative=members[0]?.id??'';
    const unresolved=this.conflicts(groupId).some(c=>!c.resolved);
    for(const r of members){r.verification_status=r.id===g.representative?(members.some(m=>m.last_checked_at)?'source_check_needed':'discovered'):'dedup_excluded';r.conflict_detected=unresolved;r.record_version++;this.saveRecord(r);}
    g.review_scope_digest=digest({members:members.map(r=>[r.id,r.record_version,r.next_recheck_at]),evidence:this.evidence(groupId),conflicts:this.conflicts(groupId),policy:this.settings.policy_version,privacy:PRIVACY_VERSION});this.put('dedup_groups',groupId,g);
    // Invalidate every explicitly dependent group in the same transaction.
    const dependent=(this.db.prepare(`SELECT DISTINCT l.group_id FROM collection_records r JOIN evidence_assertions e ON e.record_id=r.id JOIN group_evidence_links l ON l.assertion_id=e.id WHERE r.group_id=? AND l.group_id<>?`).all(groupId,groupId) as {group_id:string}[]).map(r=>r.group_id);
    for(const id of dependent){const d=this.get<Group>('dedup_groups',id)!;if(!d.retired){this.detectConflicts(id);this.invalidate(id,'linked_evidence_changed',visited);}}
  }
  private retireOrInvalidate(id:string,reason:string) {const g=this.get<Group>('dedup_groups',id)!;if(!this.members(id).length){this.put('review_events',randomUUID(),{group_id:id,decision:'invalidated',reason,previous_version:g.evidence_version,at:this.now()});g.retired=true;g.group_version++;g.verified_evidence_version=null;g.ready_evidence_version=null;this.put('dedup_groups',id,g);}else this.invalidate(id,reason);}
  scope(id:string) {return this.readSnapshot(asOf=>{
    const raw=this.get<Group>('dedup_groups',id);requireThat(raw&&!raw.retired,'group_not_found',404);
    const validity=this.reviewValidity(id,asOf),group={...raw!,review_scope_digest:validity.scope_digest,verified_evidence_version:validity.reviewed?raw!.verified_evidence_version:null,ready_evidence_version:validity.ready?raw!.ready_evidence_version:null};
    return {group,members:this.members(id),evidence:this.evidence(id),conflicts:this.conflicts(id,asOf)};
  });}
  private expected(id:string,e:{expected_group_version:number;expected_evidence_version:number;review_scope_digest:string}) {const g=this.scope(id).group;requireThat(g.group_version===e.expected_group_version&&g.evidence_version===e.expected_evidence_version&&g.review_scope_digest===e.review_scope_digest,'stale_review');return this.get<Group>('dedup_groups',id)!;}
  review(id:string,e:{expected_group_version:number;expected_evidence_version:number;review_scope_digest:string;decision:'verify'|'ready';reviewer:string}) {
    return this.transaction(()=>{const g=this.expected(id,e),validity=this.reviewValidity(id);requireThat(e.decision==='verify'||e.decision==='ready','review_decision',400);
      requireThat(validity.requirements&&!this.conflicts(id).some(c=>!c.resolved),'review_requirements');
      if(e.decision==='ready')requireThat(validity.reviewed,'verification_required');
      g.review_policy_version=REVIEW_POLICY_VERSION;
      if(e.decision==='verify'){g.verified_evidence_version=g.evidence_version;g.verified_scope_digest=validity.scope_digest;delete g.ready_scope_digest;g.ready_evidence_version=null;}
      else {g.ready_evidence_version=g.evidence_version;g.ready_scope_digest=validity.scope_digest;}
      g.group_version++;g.review_scope_digest=validity.scope_digest;
      this.put('dedup_groups',id,g);const r=this.get<CollectionRecord>('collection_records',g.representative)!;r.verification_status=e.decision==='verify'?'verified_waiting':'ready_to_publish';r.record_version++;this.saveRecord(r);
      this.put('review_events',randomUUID(),{decision:e.decision,expected_group_version:e.expected_group_version,expected_evidence_version:e.expected_evidence_version,review_scope_digest:validity.scope_digest,policy_version:REVIEW_POLICY_VERSION,reviewer:filterText(e.reviewer,80),group_id:id,at:this.asOf});this.snapshotInside();return this.scope(id).group;});
  }
  resolveConflict(id:string,conflictId:string,selected:string,reason:string,expected:Parameters<CollectorStore['expected']>[1]) {return this.transaction(()=>{
    this.expected(id,expected);const c=this.conflicts(id).find(c=>c.id===conflictId);
    requireThat(c?.group_id===id&&c.assertions.includes(selected)&&this.evidence(id).some(a=>a.id===selected&&!a.withdrawn&&!a.superseded_by)&&filterText(reason).length>0,'conflict_resolution');
    const next={...c!,resolved:true,selected,resolution:filterText(reason),policy_version:EVIDENCE_POLICY_VERSION,input_digest:this.conflictEvaluation(id).input_digest};
    this.put('review_events',randomUUID(),{group_id:id,decision:'conflict_resolution',conflict_id:conflictId,selected,reason:filterText(reason),previous:c,policy_version:EVIDENCE_POLICY_VERSION,input_digest:next.input_digest,at:this.asOf});
    this.db.prepare('INSERT INTO evidence_conflicts(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(next.id,id,JSON.stringify(next));
    this.detectConflicts(id);this.invalidate(id,'conflict_resolved');this.snapshotInside();
  });}
  changeGroup(id:string,action:'representative'|'split'|'merge'|'withdraw'|'link',input:{record_id?:string;other_group?:string;assertion_id?:string;other_expected?:Parameters<CollectorStore['expected']>[1]},e:Parameters<CollectorStore['expected']>[1]) {
    return this.transaction(()=>{const g=this.expected(id,e);const members=this.scope(id).members;
      if(action==='representative'){requireThat(members.some(r=>r.id===input.record_id),'not_member');g.representative=input.record_id!;this.put('dedup_groups',id,g);}
      else if(action==='merge'){const other=this.expected(input.other_group!,input.other_expected!);requireThat(other.id!==id,'same_group');requireThat(!mergeConflict(this.scopeAxes(id),this.scopeAxes(other.id)),'merge_forbidden',409);for(const r of this.scope(other.id).members){r.dedup_group_id=id;this.saveRecord(r);this.member(r,'manual_merge');}g.lineage.push(other.id);g.aliases=[...new Set([...(g.aliases??[]),other.key,...(other.aliases??[])])];this.put('dedup_groups',id,g);for(const member of this.scope(id).members)this.put('collector_meta',`dedup_override:${member.id}`,id);this.retireOrInvalidate(other.id,'merge');}
      else if(action==='split'){requireThat(members.length>1&&members.some(r=>r.id===input.record_id),'invalid_split');const r=members.find(r=>r.id===input.record_id)!;const next=this.group(`split:${randomUUID()}`,r.id);next.lineage.push(id);this.put('dedup_groups',next.id,next);r.dedup_group_id=next.id;this.saveRecord(r);this.member(r,'manual_split');this.put('collector_meta',`dedup_override:${r.id}`,next.id);this.invalidate(next.id,'split');}
      else if(action==='withdraw'){const a=this.get<Evidence>('evidence_assertions',input.assertion_id!);requireThat(a&&this.evidence(id).some(x=>x.id===a.id),'not_evidence');a!.withdrawn=true;this.db.prepare('UPDATE evidence_assertions SET data=? WHERE id=?').run(JSON.stringify(a),a!.id);}
      else if(action==='link'){const assertion=this.get<Evidence>('evidence_assertions',input.assertion_id!);requireThat(assertion,'not_evidence');requireThat(!mergeConflict(this.scopeAxes(id),this.scopeAxes(this.get<CollectionRecord>('collection_records',assertion!.record_id)!.dedup_group_id)),'merge_forbidden',409);const link=digest([id,input.assertion_id]);this.db.prepare('INSERT OR IGNORE INTO group_evidence_links(id,group_id,assertion_id,data) VALUES(?,?,?,?)').run(link,id,input.assertion_id!,JSON.stringify({group_id:id,assertion_id:input.assertion_id}));}
      else throw new CollectorError('invalid_action');
      this.detectConflicts(id);this.invalidate(id,action);if(action==='withdraw'){const assertion=this.get<Evidence>('evidence_assertions',input.assertion_id!)!;const owner=this.get<CollectionRecord>('collection_records',assertion.record_id)!;if(owner.dedup_group_id!==id)this.invalidate(owner.dedup_group_id,'withdraw');}this.snapshotInside();return this.scope(id);
    });
  }
  private dueCount() {return (this.db.prepare("SELECT count(*) AS n FROM collection_records WHERE json_extract(data,'$.next_recheck_at')<=?").get(new Date(this.now()).toISOString()) as {n:number}).n;}
  private validateRecords() {
    const bad=this.db.prepare(`SELECT g.id FROM dedup_groups g LEFT JOIN collection_records r ON r.group_id=g.id
      WHERE NOT coalesce(json_extract(g.data,'$.retired'),0) GROUP BY g.id
      HAVING count(r.id)=0 OR sum(r.status<>'dedup_excluded')<>1
      OR sum(r.id=json_extract(g.data,'$.representative') AND r.status<>'dedup_excluded')<>1
      OR sum(r.status IN ('verified_waiting','ready_to_publish') AND (json_extract(g.data,'$.verified_evidence_version') IS NOT json_extract(g.data,'$.evidence_version')))>0
      OR sum(r.status='ready_to_publish' AND (json_extract(g.data,'$.ready_evidence_version') IS NOT json_extract(g.data,'$.evidence_version')))>0 LIMIT 1`).get();
    requireThat(!bad,'representative_invariant');
    requireThat(!this.db.prepare("SELECT r.id FROM collection_records r JOIN dedup_groups g ON g.id=r.group_id WHERE coalesce(json_extract(g.data,'$.retired'),0) LIMIT 1").get(),'group_invariant');
  }
  private currentCounts(){
    const counts=Object.fromEntries(STATUSES.map(s=>[s,0])) as Snapshot['counts'];
    for(const row of this.db.prepare('SELECT status,count(*) AS n FROM collection_records GROUP BY status').all() as {status:typeof STATUSES[number];n:number}[])counts[row.status]=row.n;
    // Only approved representatives need a scope read. Unrelated discovered or
    // unchecked records stay in SQL aggregates on intake's hot path.
    for(const r of this.rows<CollectionRecord>("SELECT data FROM collection_records WHERE status IN ('verified_waiting','ready_to_publish')")){
      const validity=this.reviewValidity(r.dedup_group_id),status=validity.ready?'ready_to_publish':validity.reviewed?'verified_waiting':'source_check_needed';
      if(status!==r.verification_status){counts[r.verification_status]--;counts[status]++;}
    }
    const candidateGroups=this.db.prepare(`SELECT DISTINCT c.group_id AS id FROM evidence_conflicts c JOIN dedup_groups g ON g.id=c.group_id WHERE NOT coalesce(json_extract(g.data,'$.retired'),0)
      UNION SELECT group_id AS id FROM group_evidence_links
      UNION SELECT r.group_id AS id FROM evidence_assertions e JOIN collection_records r ON e.record_id=r.id
      WHERE NOT coalesce(json_extract(e.data,'$.withdrawn'),0) AND json_extract(e.data,'$.superseded_by') IS NULL
      GROUP BY r.group_id,json_extract(e.data,'$.field') HAVING count(*)>1`).all() as {id:string}[];
    const unresolved=candidateGroups.reduce((n,g)=>n+this.conflicts(g.id).filter(c=>!c.resolved).length,0);
    return {counts,unresolved};
  }
  private snapshotInside():Snapshot {
    const {counts,unresolved}=this.currentCounts(),total=Object.values(counts).reduce((n,x)=>n+x,0);
    const version=(this.get<number>('collector_meta','version')??0)+1;
    const snapshot:Snapshot={worker_id:this.settings.worker_id,version,generated_at:new Date(this.now()).toISOString(),counts,total,unique:total-counts.dedup_excluded,groups:total-counts.dedup_excluded,unresolved_conflicts:unresolved,recheck_due:this.dueCount()};
    this.put('collector_meta','version',version);this.put('sync_outbox',String(version),snapshot);this.put('collector_meta','snapshot',snapshot);return snapshot;
  }
  jobSummary():JobSummary {
    const sources:JobSummary['sources']=Object.create(null);
    const rows=this.db.prepare("SELECT json_extract(data,'$.source_id') AS source, json_extract(data,'$.phase') AS phase, json_extract(data,'$.failure_reason') AS reason, json_extract(data,'$.finished_at') AS finished FROM collection_jobs ORDER BY id").all() as {source:string;phase:string;reason:string|null;finished:number|null}[];
    for(const row of rows){
      const s=sources[row.source]??={done:0,failed:0,pending:0,failures:Object.create(null)};
      if(row.phase==='done')s.done++;
      else if(row.phase==='failed'){
        s.failed++;const reason=row.reason&&/^[a-z_]{1,40}$/.test(row.reason)?row.reason:'error';
        s.failures[reason]=(s.failures[reason]??0)+1;
        const at=new Date(row.finished??0).toISOString();
        if(!s.last_failure||at>s.last_failure.at)s.last_failure={reason,at};
      }else s.pending++;
    }
    return {generated_at:new Date(this.now()).toISOString(),sources};
  }
  private refreshInside(maxAgeMs?: number): Snapshot {
    this.reap();
    const cached=this.get<Snapshot>('collector_meta','snapshot'),current=this.currentCounts();
    const expired=stable(cached?.counts)!==stable(current.counts)||cached?.unresolved_conflicts!==current.unresolved;
    this.validateRecords();
    const age=cached?this.now()-Date.parse(cached.generated_at):0;
    if(expired||!cached||cached.recheck_due!==this.dueCount()||(maxAgeMs!==undefined&&(age>=maxAgeMs||age<0)))return this.snapshotInside();
    return cached;
  }
  report() {return this.transaction(()=>this.refreshInside());}
  heartbeat(maxAgeMs: number) {
    requireThat(Number.isSafeInteger(maxAgeMs)&&maxAgeMs>0,'sync_config');
    return this.transaction(()=>this.refreshInside(maxAgeMs));
  }
  sellerObservation(handle:string,via:string,url:string,models:string[],event:string,legacyHits=0,legacy=false) {
    requireThat(/^[a-zA-Z0-9._]{1,30}$/.test(handle)&&filterText(handle)===handle,'seller_handle');handle=handle.toLowerCase();url=canonicalUrl(url);via=filterText(via,80);models=models.filter(m=>/^[\w-]{1,100}$/.test(m));
    const id=`instagram:${handle}`,key=digest([id,event,url]);if(this.get('seller_candidate_sources',key))return;
    const at=new Date(this.now()).toISOString();const s=this.get<Seller>('seller_candidates',id)??{id,handle,platform:'instagram',found_via:via,first_seen:at,last_seen:at,hits:0,legacy_hits:0,sample_urls:[],matched_models:[],status:'pending'};
    s.last_seen=at;s.hits+=legacy?0:1;s.legacy_hits=Math.max(s.legacy_hits,legacyHits);s.sample_urls=[...new Set([...s.sample_urls,url])].slice(-30);s.matched_models=[...new Set([...s.matched_models,...models])];this.put('seller_candidates',id,s);this.put('seller_candidate_sources',key,{id:key,candidate_id:id,found_via:via,url,models,at,legacy,event:digest(event)});
  }
  reviewSeller(id:string,status:string,reason:string) {return this.transaction(()=>{const s=this.get<Seller>('seller_candidates',id);requireThat(s&&['pending','rejected','manually_registered'].includes(status),'seller_review');s!.status=status;s!.reason=filterText(reason);this.put('seller_candidates',id,s);return s;});}
  importLegacy(raw:unknown) {
    requireThat(raw&&typeof raw==='object'&&!Array.isArray(raw),'legacy_shape');
    const candidates=(raw as {candidates:Record<string,unknown>}).candidates;
    requireThat(candidates&&typeof candidates==='object'&&!Array.isArray(candidates),'legacy_shape');
    return this.transaction(()=>{
      let imported=0;
      for(const [handle,value] of Object.entries(candidates)){
        const c=value as {found_via:string;sample_urls:string[];matched_models:string[];hits:number;first_seen:string;last_seen:string};
        requireThat(c&&typeof c==='object'&&typeof c.found_via==='string'&&Array.isArray(c.sample_urls)&&c.sample_urls.every(u=>typeof u==='string')&&Array.isArray(c.matched_models)&&c.matched_models.every(m=>typeof m==='string')&&Number.isSafeInteger(c.hits)&&c.hits>=0,'legacy_candidate');
        const key=digest([handle,c]);if(this.get('legacy_imports',key))continue;
        const beforeSeller=this.get<Seller>('seller_candidates',`instagram:${handle.toLowerCase()}`);
        let accepted=0;
        for(const url of c.sample_urls){try{this.sellerObservation(handle,c.found_via,url,c.matched_models,`legacy:${handle.toLowerCase()}:${c.found_via}`,c.hits,true);accepted++;}catch(e){if(!(e instanceof Error)||!['unsafe_url','private_url'].includes(e.message))throw e;}}
        if(!accepted)continue;
        const seller=this.get<Seller>('seller_candidates',`instagram:${handle.toLowerCase()}`);
        if(seller){seller.legacy_hits=Math.max(seller.legacy_hits,c.hits);seller.matched_models=[...new Set([...seller.matched_models,...c.matched_models.filter(m=>/^[\w-]{1,100}$/.test(m))])];if(Number.isFinite(Date.parse(c.first_seen)))seller.first_seen=new Date(Math.min(Date.parse(beforeSeller?.first_seen??c.first_seen),Date.parse(c.first_seen))).toISOString();if(Number.isFinite(Date.parse(c.last_seen)))seller.last_seen=new Date(Math.max(Date.parse(beforeSeller?.last_seen??c.last_seen),Date.parse(c.last_seen))).toISOString();this.put('seller_candidates',seller.id,seller);}
        this.put('legacy_imports',key,{id:key,imported_at:this.now(),unrecoverable_followup_sources:true});imported++;
      }
      return {imported};
    });
  }
}
