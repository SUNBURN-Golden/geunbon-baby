import { CollectorStore, requireThat } from './store';
import type { Snapshot } from '../../shared/collection-schema';
export async function syncStatus(store:CollectorStore,endpoint:string,token:string,send:typeof fetch=fetch){
  const url=new URL('/api/v1/collector/status',endpoint);requireThat(url.protocol==='https:'&&!url.username&&!url.password&&token.length>=24,'sync_config');
  const snapshots=store.list<Snapshot>('sync_outbox').sort((a,b)=>a.version-b.version);
  for(const snapshot of snapshots){
    const response=await send(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(30000)});requireThat(response.ok,'sync_failed',502);
    store.transaction(()=>store.db.prepare('DELETE FROM sync_outbox WHERE id=?').run(String(snapshot.version)));
  }
  return {sent:snapshots.length};
}
