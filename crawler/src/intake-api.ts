import { timingSafeEqual, createHash } from 'node:crypto';
import { CollectorError, CollectorStore, requireThat } from './store';
import type { Binding } from '../../shared/collection-schema';
export type LocalAuth={intakeToken:string;reviewToken:string;extensionOrigin:string;host:string};
function equal(a:string,b:string){return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());}
export async function handleLocal(request:Request,store:CollectorStore,auth:LocalAuth):Promise<Response>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  const reply=(data:unknown,status=200)=>Response.json({data},{status,headers});
  try{
    requireThat(auth.intakeToken.length>=24&&auth.reviewToken.length>=24&&auth.intakeToken!==auth.reviewToken&&/^chrome-extension:\/\/[a-p]{32}$/.test(auth.extensionOrigin),'local_auth_config',503);
    requireThat(request.headers.get('host')===auth.host,'invalid_host',403);
    const path=new URL(request.url).pathname,method=request.method,origin=request.headers.get('origin');
    const intake=path.startsWith('/v1/intake');
    requireThat(intake?origin===auth.extensionOrigin:!origin,'invalid_origin',403);
    requireThat(equal(request.headers.get('authorization')??'',`Bearer ${intake?auth.intakeToken:auth.reviewToken}`),'unauthorized',401);
    let body:Record<string,unknown>={};
    if(method==='POST'){
      requireThat(request.headers.get('content-type')?.split(';')[0]==='application/json','content_type',415);
      const reader=request.body?.getReader();requireThat(reader,'body',400);const chunks:Uint8Array[]=[];let size=0;
      for(;;){const next=await reader!.read();if(next.done)break;size+=next.value.length;if(size>32768){await reader!.cancel();throw new CollectorError('body_size',413);}chunks.push(next.value);}
      try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new CollectorError('json',400);}requireThat(body&&typeof body==='object'&&!Array.isArray(body),'body',400);
    }
    if(method==='POST'&&path==='/v1/intake/reservations') {requireThat(body.collection_method==='manual_clip'||body.collection_method==='browser_extract','method',400);return reply(store.reserve(auth.extensionOrigin,body as unknown as Binding));}
    let match=path.match(/^\/v1\/intake\/clips\/([\w-]+)$/);
    if(method==='GET'&&match)return reply(store.clip(auth.extensionOrigin,match[1]));
    match=path.match(/^\/v1\/intake\/reservations\/([\w-]+)\/(start|cancel)$/);
    if(method==='POST'&&match)return reply(match[2]==='start'?store.start(auth.extensionOrigin,match[1]):store.cancel(auth.extensionOrigin,match[1]));
    if(method==='POST'&&path==='/v1/intake')return reply(store.submit(auth.extensionOrigin,String(body.reservation_id),body.payload));
    if(method==='GET'&&path==='/v1/collection/jobs')return reply(store.jobSummary());
    if(method==='GET'&&path==='/v1/collection/status')return reply(store.report());
    if(method==='GET'&&path==='/v1/groups')return reply(store.list('dedup_groups'));
    match=path.match(/^\/v1\/groups\/([\w-]+)(?:\/(review|resolve|representative|split|merge|withdraw|link))?$/);
    if(match){const id=match[1],action=match[2];if(method==='GET'&&!action)return reply(store.scope(id));if(method==='POST'){
      if(action==='review')return reply(store.review(id,body as unknown as Parameters<CollectorStore['review']>[1]));
      if(action==='resolve')return reply(store.resolveConflict(id,String(body.conflict_id),String(body.selected),String(body.reason),body as unknown as Parameters<CollectorStore['resolveConflict']>[4]));
      if(['representative','split','merge','withdraw','link'].includes(action))return reply(store.changeGroup(id,action as Parameters<CollectorStore['changeGroup']>[1],body,body as unknown as Parameters<CollectorStore['changeGroup']>[3]));
    }}
    if(method==='GET'&&path==='/v1/sellers')return reply(store.list('seller_candidates'));
    match=path.match(/^\/v1\/sellers\/([\w:.-]+)(?:\/(review|export-account))?$/);
    if(match){const seller=store.get<import('./store').Seller>('seller_candidates',match[1]);requireThat(seller,'seller_not_found',404);if(method==='GET')return reply(match[2]==='export-account'?{handle:seller!.handle,verified:false,follow:false,collect_images:false}:seller);if(method==='POST'&&match[2]==='review')return reply(store.reviewSeller(match[1],String(body.status),String(body.reason)));}
    if(method==='POST'&&path==='/v1/import-legacy-candidates')return reply(store.importLegacy(body));
    return reply(null,404);
  }catch(e){return Response.json({error:e instanceof CollectorError?e.code:'request_failed'},{status:e instanceof CollectorError?e.status:400,headers});}
}
