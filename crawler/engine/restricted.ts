import type { FetchResponse, RenderSnapshot } from './types';
export const plainText=(html:string)=>html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').trim();
export function detectExplicit(response:Pick<FetchResponse,'body'|'finalUrl'|'headers'>):'login_required'|'access_restricted'|null {
  const type=response.headers['content-type']??'text/html';if(!/text|json|xml|html/i.test(type))return null;
  if(response.finalUrl&&/\/(?:accounts\/login|login|checkpoint)(?:\/|\?|$)/i.test(new URL(response.finalUrl).pathname))return 'login_required';
  if(/<input\b[^>]*type\s*=\s*["']?password/i.test(response.body))return 'login_required';
  if(/captcha|access denied|checkpoint required|challenge required|접근.{0,5}차단|로그인이 필요/i.test(response.body))return 'access_restricted';
  return null;
}
export function detectRendered(snapshot:RenderSnapshot){return detectExplicit({body:snapshot.html,finalUrl:snapshot.finalUrl,headers:{'content-type':'text/html'}})??(Math.max(snapshot.text.trim().length,snapshot.regionText?.trim().length??0)<20?'empty_page':null);}
