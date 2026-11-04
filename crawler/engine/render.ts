import type { FetchResponse, RenderPort } from './types';
import { detectRendered } from './restricted';
export async function renderDocument(port:RenderPort,url:string,document:FetchResponse,enabled:boolean,maxBytes=2097152){
  if(!enabled)throw new Error('render_not_allowed');
  if(port.capability?.nonpersistent!==true)throw Object.assign(new Error('unsupported'),{tool:'renderer'});
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const snapshot=await Promise.race([port.render(url,document,{signal:controller.signal,maxBytes}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('tool_timeout'));},30000);})]).finally(()=>{clearTimeout(timer);controller.abort();});
  if(Buffer.byteLength(JSON.stringify(snapshot))>maxBytes)throw new Error('preparation_limit');
  const code=detectRendered(snapshot);if(code)throw new Error(code);
  if(snapshot.regionError)throw new Error('region_missing');return snapshot;
}
