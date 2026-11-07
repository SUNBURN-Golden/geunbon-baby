import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireThat } from './store';
export function privateDirectory(dir:string){
  mkdirSync(dir,{recursive:true,mode:0o700});const s=lstatSync(dir);
  requireThat(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(dir)===dir&&(s.mode&0o777)===0o700&&s.uid===process.getuid!(),'unsafe_directory');
}
export function readPrivate(path:string):unknown {
  const dir=dirname(path);privateDirectory(dir);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=fstatSync(fd);requireThat(s.isFile()&&(s.mode&0o777)===0o600&&s.uid===process.getuid!()&&s.size<=1024*1024,'unsafe_file');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
}
export function writePrivate(path:string,value:unknown){
  const dir=dirname(path);privateDirectory(dir);const s=lstatSync(path,{throwIfNoEntry:false});
  requireThat(!s||s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o777)===0o600&&s.uid===process.getuid!(),'unsafe_file');
  const tmp=join(dir,`.${randomUUID()}.tmp`),fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);const d=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(d);}finally{closeSync(d);}}finally{rmSync(tmp,{force:true});}
}
