import { readFile } from 'node:fs/promises';
import { LABELS, STATUSES, type Snapshot } from '../../shared/collection-schema';
export function formatReport(s:Snapshot,json=false){return json?JSON.stringify(s):`${STATUSES.map(k=>`${LABELS[k]} (${k}): ${s.counts[k]}`).join('\n')}\n전체: ${s.total} · 중복 제외 후: ${s.unique} · 버전: ${s.version}`;}
export async function cli(args:string[],send:typeof fetch=fetch){
  const [command,action,id,...rest]=args;let path='',method='GET',body:unknown;
  if(command==='report')path='/v1/collection/status';
  else if(command==='sellers'){path='/v1/sellers';if(action!=='list'){if(!id)throw new Error('candidate_id_required');path+=`/${encodeURIComponent(id)}`;if(action==='review'){path+='/review';method='POST';body={status:rest[0],reason:rest.slice(1).join(' ')};}else if(action==='export-account')path+='/export-account';else if(action!=='show')throw new Error('seller_action');}}
  else if(command==='groups'){path='/v1/groups';if(action==='show'){path+=`/${id}`;}else if(action!=='list')throw new Error('groups_action');}
  else if(command==='review-group'){path=`/v1/groups/${action}/review`;method='POST';body=JSON.parse(await readFile(id,'utf8'));}
  else if(command==='import-legacy-candidates'){
    if(action!=='--state'||!id)throw new Error('state_path');
    const state=JSON.parse(await readFile(id,'utf8')) as {candidates?:Record<string,unknown>};
    if(!state.candidates||typeof state.candidates!=='object'||Array.isArray(state.candidates))throw new Error('legacy_shape');
    let imported=0;
    // Never transmit Instagram state, cursors, sessions or URL history; candidate-sized batches resume independently.
    for(const [handle,candidate] of Object.entries(state.candidates)){
      const payload=JSON.stringify({candidates:{[handle]:candidate}});if(Buffer.byteLength(payload)>32768)throw new Error('legacy_candidate_size');
      const response=await send('http://127.0.0.1:4318/v1/import-legacy-candidates',{method:'POST',headers:{authorization:`Bearer ${process.env.COLLECTOR_REVIEW_TOKEN??''}`,'content-type':'application/json'},body:payload});
      if(!response.ok)throw new Error(`collector_request_${response.status}`);imported+=((await response.json()) as {data:{imported:number}}).data.imported;
    }
    return JSON.stringify({imported});
  }
  else throw new Error('collector report [--json] | sellers list/show/review/export-account | groups list/show | review-group <id> <json-file> | import-legacy-candidates --state <path>');
  const response=await send(`http://127.0.0.1:4318${path}`,{method,headers:{authorization:`Bearer ${process.env.COLLECTOR_REVIEW_TOKEN??''}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error(`collector_request_${response.status}`);const result=await response.json() as {data:unknown};return command==='report'?formatReport(result.data as Snapshot,args.includes('--json')):JSON.stringify(result.data,null,2);
}
