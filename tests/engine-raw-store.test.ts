import { expect, test } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawStore } from '../crawler/engine';
import { hashBytes } from '../crawler/engine/util';
test('raw store rejects repository paths, symlink parents, symlink files and unsafe permissions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-raw-'));try{
  expect(()=>new RawStore(process.cwd(),'fake')).toThrow('unsafe_directory');
  const loose=join(dir,'loose');mkdirSync(loose,{mode:0o755});chmodSync(loose,0o755);expect(()=>new RawStore(loose,'fake')).toThrow('unsafe_directory');
  symlinkSync(dir,join(dir,'link'));expect(()=>new RawStore(join(dir,'link','child'),'fake')).toThrow('unsafe_directory');
  const raw=new RawStore(join(dir,'secure'),'fake'),data=Buffer.from('example_only'),hash=hashBytes(data);
  symlinkSync(join(dir,'outside'),raw.path(hash,true));expect(()=>raw.write(data)).toThrow('unsafe_file');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('atomic content-addressed files are 0600; spool is removed/expired and hash_only never writes a permanent file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-raw-'));try{
  const raw=new RawStore(join(dir,'raw'),'fake'),data=Buffer.from('example_only'),hash=hashBytes(data),path=raw.write(data);
  expect(statSync(path).mode&0o777).toBe(0o600);expect(existsSync(raw.path(hash))).toBe(false);expect(raw.read(hash)).toEqual(data);
  utimesSync(path,new Date(0),new Date(0));raw.cleanup(86400001);expect(raw.read(hash)).toBeUndefined();
  const permanent=raw.write(data,true);expect(permanent).toContain(`/fake/sha256/${hash.slice(0,2)}/${hash.slice(2,4)}/${hash}`);raw.write(data,true);expect(readdirSync(join(raw.root,'fake','sha256',hash.slice(0,2),hash.slice(2,4)))).toEqual([hash]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('spool TTL uses the injected clock even while the same process stays open',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-raw-'));let now=Date.parse('2026-01-01T00:00:00Z');try{
  const raw=new RawStore(join(dir,'raw'),'fake',process.cwd(),()=>now),data=Buffer.from('example_only'),path=raw.write(data);expect(raw.read(hashBytes(data))).toEqual(data);
  now+=86400001;expect(raw.read(hashBytes(data))).toBeUndefined();expect(existsSync(path)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
