import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EngineDb, MemoryCapability } from './types';
const exec=promisify(execFile);
export type ToolExec=(name:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<{stdout:string;stderr?:string}>;
export type MemoryTool={capability:MemoryCapability;run:(name:'pdftotext'|'tesseract',bytes:Buffer,options:{signal:AbortSignal;maxBytes:number})=>Promise<string>};
export type ToolResult={status:'ok';text:string;tool:string}|{status:'unsupported';tool:string};
export class ToolAdapter {
  private probes=new Map<string,Promise<boolean>>();
  constructor(readonly store:EngineDb,readonly execute:ToolExec=async(name,args,options)=>{const r=await exec(name,args,options);return {stdout:r.stdout,stderr:r.stderr};},readonly memory?:MemoryTool){}
  async probeTool(name:string,args=['--version']){
    if(!['pdftotext','tesseract'].includes(name))throw new Error('unsupported');
    if(!this.probes.has(name))this.probes.set(name,(async()=>{
      let supported=true,version:string|null=null;
      try{const r=await this.execute(name,args,{timeout:5000,maxBuffer:32768});const line=(r.stdout||r.stderr||'').split('\n')[0];version=/^(?:pdftotext|tesseract) (?:version )?\d+(?:\.\d+){1,3}$/.test(line)?line:null;}
      catch(e){if((e as {code?:string}).code==='ENOENT')supported=false;else throw new Error('tool_timeout');}
      this.store.transaction(()=>this.store.db.prepare('INSERT INTO engine_tool_support VALUES(?,?,?,?) ON CONFLICT(tool) DO UPDATE SET status=excluded.status,version=excluded.version,checked_at=excluded.checked_at').run(name,supported?'supported':'unsupported',version,new Date(this.store.now()).toISOString()));return supported;
    })());try{return await this.probes.get(name)!;}catch(e){this.probes.delete(name);throw e;}
  }
  async runBytes(name:'pdftotext'|'tesseract',bytes:Buffer,maxBytes=2097152):Promise<ToolResult>{
    if(!this.memory||this.memory.capability.nonpersistent!==true||!/^[-a-zA-Z0-9_.@]{1,80}$/.test(this.memory.capability.version))return {status:'unsupported',tool:name};
    if(bytes.length>maxBytes)throw new Error('preparation_limit');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const text=await Promise.race([this.memory.run(name,bytes,{signal:controller.signal,maxBytes}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('tool_timeout'));},30000);})]);
      if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw new Error('preparation_limit');
      return {status:'ok',text,tool:name};
    } finally {clearTimeout(timer);controller.abort();}
  }
}
export const probeTool=(adapter:ToolAdapter,name:string,args?:string[])=>adapter.probeTool(name,args);
