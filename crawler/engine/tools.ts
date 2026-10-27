import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EngineDb } from './types';
const exec=promisify(execFile);
export type ToolExec=(name:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<{stdout:string;stderr?:string}>;
export type ToolResult={status:'ok';text:string;tool:string}|{status:'unsupported';tool:string};
export class ToolAdapter {
  private probes=new Map<string,Promise<boolean>>();
  constructor(readonly store:EngineDb,readonly execute:ToolExec=async(name,args,options)=>{const r=await exec(name,args,options);return {stdout:r.stdout,stderr:r.stderr};}){}
  async probeTool(name:string,args=['--version']){
    if(!this.probes.has(name))this.probes.set(name,(async()=>{
      let supported=true,version:string|null=null;
      try{const r=await this.execute(name,args,{timeout:5000,maxBuffer:32768});version=(r.stdout||r.stderr||'').split('\n')[0].slice(0,100);}
      catch(e){if((e as {code?:string}).code==='ENOENT')supported=false;else throw new Error('tool_timeout');}
      this.store.transaction(()=>this.store.db.prepare('INSERT INTO engine_tool_support VALUES(?,?,?,?) ON CONFLICT(tool) DO UPDATE SET status=excluded.status,version=excluded.version,checked_at=excluded.checked_at').run(name,supported?'supported':'unsupported',version,new Date(this.store.now()).toISOString()));return supported;
    })());try{return await this.probes.get(name)!;}catch(e){this.probes.delete(name);throw e;}
  }
  async run(name:string,args:string[],probe=['--version']):Promise<ToolResult>{
    if(!await this.probeTool(name,probe))return {status:'unsupported',tool:name};
    try{const r=await this.execute(name,args,{timeout:30000,maxBuffer:2097152});return {status:'ok',text:r.stdout,tool:name};}
    catch(e){if((e as {code?:string}).code==='ENOENT'){this.probes.delete(name);await this.probeTool(name,probe);return {status:'unsupported',tool:name};}throw new Error('tool_timeout');}
  }
}
export const probeTool=(adapter:ToolAdapter,name:string,args?:string[])=>adapter.probeTool(name,args);
