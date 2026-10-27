import type { FetchResponse, RenderPort } from './types';
import { detectRendered } from './restricted';
export async function renderDocument(port:RenderPort,url:string,document:FetchResponse,enabled:boolean){
  if(!enabled)throw new Error('render_not_allowed');
  const snapshot=await port.render(url,document),code=detectRendered(snapshot);if(code)throw new Error(code);
  if(snapshot.regionError)throw new Error('region_missing');return snapshot;
}
