import { readFileSync } from 'node:fs';
import type { EngineDb } from '../../engine/types';
import { digest, stable } from '../../engine/util';
import { filterText } from '../../../shared/privacy-rules';
import { config, type SourcePolicy } from '../source-policy';
import { entryReason, legacyReason, matchedPrefix, narrower, registryUrl, scopeReason, validateEntry, validTime } from './policy';
import type { RegistryDecision, RevisionApproval, SourceRegistryEntry, Reason } from './types';
import { loadRegistrySeed } from './seed';

type Row = {data: string; content_hash: string; approval_id: string|null};
export class SourceRegistryStore {
  constructor(readonly store: EngineDb, readonly legacySources: readonly SourcePolicy[]=config.sources) {}
  get(sourceId: string,revision?: number): SourceRegistryEntry|undefined {
    const row=(revision===undefined
      ? this.store.db.prepare('SELECT data FROM source_registry_revisions WHERE source_id=? ORDER BY revision DESC LIMIT 1').get(sourceId)
      : this.store.db.prepare('SELECT data FROM source_registry_revisions WHERE source_id=? AND revision=?').get(sourceId,revision)) as {data:string}|undefined;
    return row?JSON.parse(row.data):undefined;
  }
  list(): SourceRegistryEntry[] {
    return this.store.db.prepare('SELECT r.data FROM source_registry_revisions r WHERE revision=(SELECT max(revision) FROM source_registry_revisions WHERE source_id=r.source_id) ORDER BY source_id').all().map(r=>JSON.parse(String(r.data)));
  }
  history(sourceId: string): SourceRegistryEntry[] {
    return this.store.db.prepare('SELECT data FROM source_registry_revisions WHERE source_id=? ORDER BY revision').all(sourceId).map(r=>JSON.parse(String(r.data)));
  }
  conflicts(sourceId: string) {
    return this.store.db.prepare('SELECT * FROM source_registry_conflicts WHERE source_id=? ORDER BY id').all(sourceId).map(r=>({...r,data:JSON.parse(String(r.data))}));
  }
  seed(entries: readonly SourceRegistryEntry[]) {return this.store.transaction(()=>this.seedInside(entries));}
  // For atomic migration + seed. The caller must already own the transaction.
  seedInside(entries: readonly SourceRegistryEntry[]) {
    if(!this.store.db.isTransaction)throw new Error('registry_transaction_required');
    const result={inserted:0,unchanged:0,conflicts:0};
    for(const entry of entries){
      validateEntry(entry);
      if(entry.revision!==1)throw new Error('seed_revision_invalid');
      const data=stable(entry),hash=digest(entry);
      const old=this.store.db.prepare('SELECT data,content_hash,approval_id FROM source_registry_revisions WHERE source_id=? AND revision=1').get(entry.source_id) as Row|undefined;
      if(old){
        if(old.data===data){result.unchanged++;continue;}
        // Preserve proposals; a changed seed cannot advance the effective revision.
        const id=digest([entry.source_id,1,old.content_hash,hash]);
        const change=this.store.db.prepare('INSERT OR IGNORE INTO source_registry_conflicts(id,source_id,revision,existing_hash,proposed_hash,recorded_at,data) VALUES(?,?,?,?,?,?,?)').run(id,entry.source_id,1,old.content_hash,hash,new Date(this.store.now()).toISOString(),data);
        result.conflicts+=Number(change.changes);continue;
      }
      this.store.db.prepare('INSERT INTO source_registry_revisions VALUES(?,1,?,?,NULL,?)').run(entry.source_id,hash,new Date(this.store.now()).toISOString(),data);result.inserted++;
    }
    return result;
  }
  approveRevision(approval: RevisionApproval) {
    return this.store.transaction(()=>{
      const next=validateEntry(approval.entry),now=this.store.now();
      const clean=(s:string)=>typeof s==='string'&&s.length>0&&s.length<=2000&&filterText(s,2000)===s;
      if(approval.source_id!==next.source_id || !Number.isSafeInteger(approval.base_revision) || next.revision!==approval.base_revision+1
        || !clean(approval.decided_by)||!clean(approval.evidence)||!validTime(approval.approved_at)||!validTime(approval.expires_at)
        || Date.parse(approval.approved_at)>now||Date.parse(approval.expires_at)<=now||Date.parse(approval.expires_at)<=Date.parse(approval.approved_at))throw new Error('invalid_registry_approval');
      const current=this.get(next.source_id);
      if(!current||current.revision!==approval.base_revision)throw new Error('registry_revision_conflict');
      const id=digest(approval);
      this.store.db.prepare('INSERT INTO source_registry_approvals VALUES(?,?,?,?,?,?,?)').run(id,next.source_id,approval.base_revision,next.revision,approval.approved_at,approval.expires_at,stable(approval));
      this.store.db.prepare('INSERT INTO source_registry_revisions VALUES(?,?,?,?,?,?)').run(next.source_id,next.revision,digest(next),new Date(now).toISOString(),id,stable(next));
      return next;
    });
  }
  decide(sourceId: string,rawUrl: string,fields: readonly string[]): RegistryDecision {
    return this.store.transaction(()=>{
      const entry=this.get(sourceId),now=this.store.now();
      const result=(reason:Reason,applied?:SourceRegistryEntry):RegistryDecision=>({allowed:reason==='approved',reason,source_id:sourceId,revision:entry?.revision??null,...(applied?{applied:{source_id:applied.source_id,revision:applied.revision}}:{})});
      if(!entry)return result('unknown_source');
      let url:URL;try{url=registryUrl(rawUrl);}catch{return result('invalid_url');}
      // Never search by origin first or fall back after this source's scope fails.
      const scope=scopeReason(entry,url);if(scope)return result(scope);
      const overlaps=this.list().filter(e=>e.source_id!==sourceId && matchedPrefix(e,url));
      for(const other of overlaps){
        if(narrower(entry,other,url))continue;
        if(narrower(other,entry,url))return result('scope_shadowed',other);
        return result('ambiguous_scope');
      }
      const reason=entryReason(entry,url,fields,now);if(reason)return result(reason);
      const approval=this.store.db.prepare('SELECT a.id,a.approved_at,a.expires_at FROM source_registry_revisions r JOIN source_registry_approvals a ON a.id=r.approval_id WHERE r.source_id=? AND r.revision=?').get(sourceId,entry.revision) as RegistryDecision['approval'];
      // Registration and reseeding, including a new ID on an existing origin,
      // never grant collection authority even if the input claims permission.
      if(!approval)return result('approval_required');
      if(Date.parse(String(approval.expires_at))<=now)return result('approval_expired');
      const legacy=legacyReason(this.legacySources,url,fields);if(legacy)return result(legacy);
      return { ...result('approved'), approval: { id: approval.id, approved_at: new Date(approval.approved_at).toISOString(),
        expires_at: new Date(Math.min(Date.parse(approval.expires_at), Date.parse(entry.reevaluate_at!))).toISOString() } };
    });
  }
}

export function initializeSourceRegistry(store: EngineDb,entries: readonly SourceRegistryEntry[]=loadRegistrySeed()) {
  return store.transaction(()=>{
    const version=Number(store.db.prepare('PRAGMA user_version').get()!.user_version);
    if(version<6)store.db.exec(readFileSync(new URL('../../migrations/0006_source_registry.sql',import.meta.url),'utf8'));
    return new SourceRegistryStore(store).seedInside(entries);
  });
}
