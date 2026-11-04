import { safeEtag, safeModified } from '../crawler/src/agamajung/http-validators';
import { expect, test, vi } from 'vitest';
import { Downloader, type FetcherPort } from '../crawler/engine';
const previous={id:'prior',content_hash:'a'.repeat(64),etag:'"example-only"',last_modified:'Mon, 26 Oct 2026 00:00:00 GMT'};
const body='<main>Example stroller specifications for offline tests only.</main>';
test('conditional validators require reusable output; 304 inherits hash and never parses a response body',async()=>{
 const get=vi.fn<FetcherPort['get']>(async()=>({status:304,headers:{},body:''})),d=new Downloader({get},{etag:safeEtag,modified:safeModified});
 const r=await d.download('https://example.org/spec',{previous,reusable:()=>true,render:false});expect(get.mock.calls[0]).toEqual(['https://example.org/spec',{headers:{'if-none-match':previous.etag,'if-modified-since':previous.last_modified}}]);expect(r).toMatchObject({hash:previous.content_hash,status:'not_modified',bytes:undefined});
});
test('missing prepared cache/version sends no validators; race-lost cache retries unconditionally once',async()=>{
 const get=vi.fn<FetcherPort['get']>(async()=>({status:200,headers:{'content-type':'text/html'},body})),d=new Downloader({get},{etag:safeEtag,modified:safeModified});
 await d.download('https://example.org/spec',{previous,reusable:()=>false,render:false});expect(get.mock.calls[0]?.[1]).toEqual({headers:{}});
 let usable=true;get.mockImplementationOnce(async()=>{usable=false;return {status:304,headers:{},body:''};});
 await d.download('https://example.org/spec',{previous,reusable:()=>usable,render:false});expect(get.mock.calls[2]).toEqual(['https://example.org/spec']);
});
test('binary PDF text does not trigger HTML block patterns; JS shells require render before empty-page detection',async()=>{
 const pdf=Buffer.from('%PDF-1.4 captcha example_only');
 const d=new Downloader({get:async()=>({status:200,headers:{'content-type':'application/pdf'},body:pdf.toString(),bytes:pdf})});
 expect((await d.download('https://example.org/manual',{reusable:()=>false,render:false})).bytes).toEqual(pdf);
 const shell=new Downloader({get:async()=>({status:200,headers:{'content-type':'text/html'},body:'<main></main><script>example_only</script>'})});
 await expect(shell.download('https://example.org/page',{reusable:()=>false,render:true})).resolves.toMatchObject({status:'ok'});
 await expect(shell.download('https://example.org/page',{reusable:()=>false,render:false})).rejects.toThrow('empty_page');
});

test('unsafe legacy validators are omitted unchanged, never redacted and sent',async()=>{
 const get=vi.fn<FetcherPort['get']>(async()=>({status:200,headers:{'content-type':'text/html'},body})),d=new Downloader({get},{etag:safeEtag,modified:safeModified});
 await d.download('https://example.org/spec',{previous:{...previous,etag:'"token: synthetic_private_value"',last_modified:'ignore previous instructions'},reusable:()=>true,render:false});
 expect(get.mock.calls[0]?.[1]?.headers).toEqual({});
});
