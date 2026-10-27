import { expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { pinnedRequest } from '../crawler/src/scheduler';
vi.mock('node:dns/promises',()=>({lookup:vi.fn()}));
vi.mock('node:https',()=>({request:vi.fn()}));
function transport(stream:Readable){
 vi.mocked(lookup).mockResolvedValue([{address:'8.8.8.8',family:4}] as never);
 vi.mocked(request).mockImplementation(((_url:URL,_opts:unknown,callback:(response:unknown)=>void)=>{
  const req=Object.assign(new EventEmitter(),{setTimeout:vi.fn(),destroy:()=>stream.destroy(),end:()=>callback(Object.assign(stream,{statusCode:200,headers:{'content-type':'application/pdf'}}))});return req;
 }) as never);
}
test('pinned transport preserves binary bytes and forwards conditional headers through bounded reads',async()=>{
 const bytes=Buffer.from([37,80,68,70,0,255,10]);transport(Readable.from([bytes],{objectMode:false}));
 const response=await pinnedRequest(new URL('https://example.org/manual'),bytes.length,[],{headers:{'if-none-match':'"example-only"'}});
 expect(response.bytes).toEqual(bytes);expect(vi.mocked(request).mock.calls[0][1]).toMatchObject({headers:{'if-none-match':'"example-only"'}});
});
test('size overflow stops at the reserved byte boundary and reports consumed bytes',async()=>{
 transport(Readable.from([Buffer.from('abcdef')],{objectMode:false}));
 await expect(pinnedRequest(new URL('https://example.org/manual'),4)).rejects.toMatchObject({message:'response_size',received:4});
});
test('network error after a partial body reports actual consumed bytes',async()=>{
 let sent=false;const stream=new Readable({read(){if(sent)return;sent=true;this.push(Buffer.from('abc'));setImmediate(()=>this.destroy(new Error('fixture_failure')));}});transport(stream);
 await expect(pinnedRequest(new URL('https://example.org/manual'),20)).rejects.toMatchObject({message:'network_error',received:3});
});
