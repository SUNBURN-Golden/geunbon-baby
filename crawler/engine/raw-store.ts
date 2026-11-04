import { closeSync, existsSync, fsyncSync, futimesSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashBytes } from './util';
function entry(path:string){try{return lstatSync(path);}catch(e){if((e as {code?:string}).code==='ENOENT')return undefined;throw e;}}
export function externalDirectory(path:string,repository=process.cwd()){
  const target=resolve(path),repo=realpathSync(repository),r=relative(repo,target);
  if(!isAbsolute(path)||r===''||(!r.startsWith(`..${process.platform==='win32'?'\\':'/'}`)&&r!=='..'&&!isAbsolute(r)))throw new Error('unsafe_directory');
  // Inspect every existing ancestor before mkdir, so symlink parents cannot escape checks.
  let cursor=target;
  while(true){if(entry(cursor)?.isSymbolicLink())throw new Error('unsafe_directory');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  mkdirSync(target,{recursive:true,mode:0o700});
  if(realpathSync(target)!==target||!lstatSync(target).isDirectory()||(lstatSync(target).mode&0o777)!==0o700)throw new Error('unsafe_directory');
  return target;
}
export type InspectedArtifact={text:string;fullTextAllowed:boolean;permissionBasis:string};
export type ArtifactValidator=(artifact:InspectedArtifact)=>void;
// This store has no response-body or spool interface. The Linux binding supplies
// a runtime privacy/schema validator; a caller flag alone never permits a write.
export class RawStore {
  readonly root:string;
  constructor(path:string,readonly profile:string,repository=process.cwd(),readonly now=Date.now,readonly validate?:ArtifactValidator){
    if(!/^[a-z0-9_-]{1,80}$/.test(profile))throw new Error('profile_id');
    this.root=externalDirectory(path,repository);this.directory(join(this.root,profile));
  }
  private directory(path:string){
    if(realpathSync(this.root)!==this.root||(lstatSync(this.root).mode&0o777)!==0o700)throw new Error('unsafe_directory');
    const rel=relative(this.root,path);let cursor=this.root;
    for(const segment of rel.split('/').filter(Boolean)){cursor=join(cursor,segment);if(!entry(cursor))mkdirSync(cursor,{mode:0o700});if(lstatSync(cursor).isSymbolicLink()||!lstatSync(cursor).isDirectory()||(lstatSync(cursor).mode&0o777)!==0o700)throw new Error('unsafe_directory');}
  }
  private safeFile(path:string){const stat=entry(path);if(stat&&(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600))throw new Error('unsafe_file');}
  path(hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('content_hash');return join(this.root,this.profile,'inspected-v1','sha256',hash.slice(0,2),hash.slice(2,4),hash);}
  writeInspected(artifact:InspectedArtifact){
    if(!this.validate||artifact.fullTextAllowed!==true||typeof artifact.permissionBasis!=='string'||!artifact.permissionBasis.trim())throw new Error('retention_not_allowed');
    this.validate(artifact);
    const bytes=Buffer.from(artifact.text),hash=hashBytes(bytes),path=this.path(hash);
    this.directory(dirname(path));this.safeFile(path);
    if(existsSync(path)){if(hashBytes(readFileSync(path))!==hash)throw new Error('artifact_corrupt');return {path,hash};}
    const temp=join(dirname(path),`.${randomUUID()}.tmp`),fd=openSync(temp,'wx',0o600);
    try{
      try{writeFileSync(fd,bytes);futimesSync(fd,new Date(this.now()),new Date(this.now()));fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temp,path);const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
    }finally{rmSync(temp,{force:true});}
    return {path,hash};
  }
  readArtifact(hash:string):Buffer|undefined {
    const path=this.path(hash);this.safeFile(path);if(!existsSync(path))return;
    this.directory(dirname(path));const bytes=readFileSync(path);if(hashBytes(bytes)!==hash)throw new Error('artifact_corrupt');return bytes;
  }
  // Called under the crawl lock. Legacy raw/spool files are deliberately untouched.
  cleanup(references:ReadonlySet<string>,now=this.now(),ttl=86400000){
    const base=join(this.root,this.profile,'inspected-v1');if(!existsSync(base))return;
    const scan=(dir:string)=>{this.directory(dir);for(const name of readdirSync(dir)){
      const path=join(dir,name),stat=lstatSync(path);
      if(stat.isSymbolicLink())throw new Error('unsafe_file');
      if(stat.isDirectory()){scan(path);continue;}
      this.safeFile(path);
      if(!references.has(path)&&now-stat.mtimeMs>=ttl&&(/^[a-f0-9]{64}$/.test(name)||/^\.[a-f0-9-]+\.tmp$/.test(name)))rmSync(path);
    }};scan(base);
  }
}
