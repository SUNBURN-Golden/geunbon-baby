import { parseHtml, selectAll, textOf, linesOf } from '../../lib/external/parse';
import { filterText } from '../../../shared/privacy-rules';
import { candidateUrl, type ProductUrlPolicy } from '../source-discovery/url-policy';
import type { DocumentLinks, Relation } from '../source-discovery/types';
export const cleanText=(s:string,max=300)=>filterText(s.replace(/https?:\/\/[^\s<>"']+/gi,''),max).replace(/\s+/g,' ').trim();
const xml=(s:string)=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
export type RawDocumentLinks=Omit<DocumentLinks,'links'>&{links:{url:string;title:string;quote:string;locator:string;relation:Relation}[]};
// Transient raw links: callers must apply their URL policy before caching or output.
export function extractRawDocument(body:string,base:string,adapter:'rss'|'sitemap'|'links',nextSelector=''):RawDocumentLinks {
  const links:RawDocumentLinks['links']=[];let total=0;
  const add=(raw:string,title:string,quote:string,locator:string,relation:Relation)=>{
    total++;if(total>500)return;
    let url:string;try{url=new URL(raw,base).href;}catch{url='';}
    if(relation==='link'&&url){const u=new URL(url);if(/(?:^|\.)(?:instagram|facebook|youtube|tiktok)\.com$/.test(u.hostname))relation='social';else if(/\.(?:pdf|docx?|xlsx?|zip)$/i.test(u.pathname))relation='attachment';else if(/(?:order|checkout|buy)/i.test(u.pathname))relation='order';}
    links.push({url,title:cleanText(title,200),quote:cleanText(quote),locator,relation});
  };
  if(adapter==='sitemap'){
    const index=/<sitemapindex\b/i.test(body);
    let i=0;for(const m of body.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)){add(xml(m[1]),'','',`${index?'sitemapindex/sitemap':'urlset/url'}[${i++}]/loc`,'sitemap');if(total>500)break;}
    return {links,truncated:total>500,text:'',kind:index?'sitemap_index':'sitemap'};
  }
  if(adapter==='rss'){
    const feedLinks=(part:string,title:string,prefix:string)=>{
      let j=0;for(const m of part.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>|<link\b[^>]*>([\s\S]*?)<\/link>/gi)){
        const rel=/\brel=["']([^"']+)["']/i.exec(m[0])?.[1];if(rel&&rel!=='alternate')continue;
        add(xml(m[1]??m[2]),title,title,`${prefix}/link[${j++}]`,'feed');if(total>500)break;
      }
    };
    let i=0;for(const m of body.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)){
      const root=parseHtml(m[2]),title=selectAll(root,'title').map(textOf).join(' ');
      feedLinks(m[2],title,`${m[1]}[${i++}]`);if(total>500)break;
    }
    if(!i)feedLinks(body,'','feed');
    return {links,truncated:total>500,text:'',kind:'rss'};
  }
  const root=parseHtml(body),next=nextSelector?new Set(selectAll(root,nextSelector)):new Set();
  let i=0;for(const el of selectAll(root,'a[href],link[rel=next]')){
    const locator=`link[${i++}]`;
    add(el.attrs.href,textOf(el),textOf(el.parent??el),locator,(el.attrs.rel??'').split(/\s+/).includes('next')||next.has(el)?'pagination':'link');if(total>500)break;
  }
  return {links,truncated:total>500,text:linesOf(root).map(l=>cleanText(l,500)).filter(Boolean).join('\n').slice(0,20000),kind:'html'};
}

export function extractDocument(body:string,base:string,adapter:'rss'|'sitemap'|'links',policies:ProductUrlPolicy[]=[],nextSelector=''):DocumentLinks {
  const doc=extractRawDocument(body,base,adapter,nextSelector);
  return {...doc,links:doc.links.map(({url,...link})=>({...link,destination:candidateUrl(url,policies)}))};
}
