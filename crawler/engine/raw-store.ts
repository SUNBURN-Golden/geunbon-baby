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
export class RawStore {
  readonly root:string;
  constructor(path:string,readonly profile:string,repository=process.cwd(),readonly now=Date.now){
    if(!/^[a-z0-9_-]{1,80}$/.test(profile))throw new Error('profile_id');
    this.root=externalDirectory(path,repository);this.directory(join(this.root,profile));this.directory(join(this.root,'spool'));
  }
  private directory(path:string){
    if(realpathSync(this.root)!==this.root||(lstatSync(this.root).mode&0o777)!==0o700)throw new Error('unsafe_directory');
    const rel=relative(this.root,path);let cursor=this.root;
    for(const segment of rel.split('/').filter(Boolean)){cursor=join(cursor,segment);if(!entry(cursor))mkdirSync(cursor,{mode:0o700});if(lstatSync(cursor).isSymbolicLink()||!lstatSync(cursor).isDirectory()||(lstatSync(cursor).mode&0o777)!==0o700)throw new Error('unsafe_directory');}
  }
  private safeFile(path:string){const stat=entry(path);if(stat&&(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600))throw new Error('unsafe_file');}
  path(hash:string,spool=false){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('content_hash');return spool?join(this.root,'spool',hash):join(this.root,this.profile,'sha256',hash.slice(0,2),hash.slice(2,4),hash);}
  write(bytes:Buffer,permanent=false){
    const hash=hashBytes(bytes),path=this.path(hash,!permanent);this.directory(dirname(path));this.safeFile(path);
    if(existsSync(path)){if(hashBytes(readFileSync(path))!==hash)throw new Error('raw_corrupt');return path;}
    const temp=join(dirname(path),`.${randomUUID()}.tmp`),fd=openSync(temp,'wx',0o600);
    try{
      try{writeFileSync(fd,bytes);futimesSync(fd,new Date(this.now()),new Date(this.now()));fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temp,path);const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}finally{rmSync(temp,{force:true});}
    return path;
  }
  read(hash:string):Buffer|undefined {for(const spool of [false,true]){const path=this.path(hash,spool);this.safeFile(path);if(!existsSync(path))continue;this.directory(dirname(path));if(spool&&this.now()-lstatSync(path).mtimeMs>=86400000){rmSync(path);continue;}const bytes=readFileSync(path);if(hashBytes(bytes)!==hash)throw new Error('raw_corrupt');return bytes;}}
  removeSpool(hash:string){this.directory(join(this.root,'spool'));const path=this.path(hash,true);this.safeFile(path);rmSync(path,{force:true});}
  cleanup(now=Date.now(),ttl=86400000){this.directory(join(this.root,'spool'));for(const name of readdirSync(join(this.root,'spool'))){const path=join(this.root,'spool',name);this.safeFile(path);if(now-lstatSync(path).mtimeMs>=ttl)rmSync(path);}}
}
