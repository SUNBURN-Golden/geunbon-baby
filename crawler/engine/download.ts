import type { Data, FetcherPort } from './types';
import { hashBytes } from './util';
import { detectExplicit, plainText } from './restricted';
export type PreviousCapture={id:string;content_hash:string|null;etag:string|null;last_modified:string|null;content_type?:string|null};
export class Downloader {
  constructor(readonly fetcher:FetcherPort){}
  async download(url:string,options:{previous?:PreviousCapture;reusable:(hash:string)=>boolean;render:boolean}){
    const p=options.previous,headers:Record<string,string>={};
    if(p?.content_hash&&options.reusable(p.content_hash)){
      if(p.etag)headers['if-none-match']=p.etag;if(p.last_modified)headers['if-modified-since']=p.last_modified;
    }
    let response=await this.fetcher.get(url,{headers});
    if(response.status===304&&(!p?.content_hash||!Object.keys(headers).length||!options.reusable(p.content_hash))){
      response=await this.fetcher.get(url);
      if(response.status===304)throw Object.assign(new Error('source_response'),{http_status:304});
    }
    if(response.status===304){if(!p?.content_hash)throw new Error('source_response');return {response,hash:p.content_hash,status:'not_modified' as const,bytes:undefined};}
    if(response.status<200||response.status>=300)throw Object.assign(new Error('source_response'),{http_status:response.status});
    const bytes=response.bytes??Buffer.from(response.body),type=response.headers['content-type']??'text/html';
    const restricted=detectExplicit(response)??(!options.render&&/html|text/i.test(type)&&plainText(response.body).length<20?'empty_page':null);
    if(restricted)throw Object.assign(new Error(restricted),{response});
    return {response,bytes,hash:hashBytes(bytes),status:'ok' as const};
  }
}
export type DownloadData=Data;
