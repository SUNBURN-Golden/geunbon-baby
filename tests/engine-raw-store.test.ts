import { expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawStore } from '../crawler/engine';
import { hashBytes } from '../crawler/engine/util';
import { validateArtifact } from '../crawler/src/agamajung/pre-storage';
const artifact={text:'Example stroller',fullTextAllowed:true,permissionBasis:'Synthetic fixture permission'};
test('artifact store rejects repository paths, symlink parents/files and unsafe permissions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-inspected-'));try{
  expect(()=>new RawStore(process.cwd(),'fake')).toThrow('unsafe_directory');
  const loose=join(dir,'loose');mkdirSync(loose,{mode:0o755});chmodSync(loose,0o755);expect(()=>new RawStore(loose,'fake')).toThrow('unsafe_directory');
  symlinkSync(dir,join(dir,'link'));expect(()=>new RawStore(join(dir,'link','child'),'fake')).toThrow('unsafe_directory');
  const raw=new RawStore(join(dir,'secure'),'fake',process.cwd(),Date.now,validateArtifact),saved=raw.writeInspected(artifact);
  rmSync(saved.path);symlinkSync(join(dir,'outside'),saved.path);expect(()=>raw.writeInspected(artifact)).toThrow('unsafe_file');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('runtime inspection and retention authorization precede every content file open',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-inspected-'));try{
  const root=join(dir,'raw'),validate=vi.fn(validateArtifact),raw=new RawStore(root,'fake',process.cwd(),Date.now,validate);
  expect(()=>raw.writeInspected({...artifact,fullTextAllowed:false})).toThrow('retention_not_allowed');
  expect(()=>raw.writeInspected({...artifact,permissionBasis:''})).toThrow('retention_not_allowed');
  expect(()=>raw.writeInspected({...artifact,text:'token: synthetic_private_value'})).toThrow('artifact_invalid');
  expect(validate).toHaveBeenCalledTimes(1);expect(existsSync(join(root,'fake','inspected-v1'))).toBe(false);expect(existsSync(join(root,'spool'))).toBe(false);
  expect(()=>new RawStore(join(dir,'unbound'),'fake').writeInspected(artifact)).toThrow('retention_not_allowed');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('sanitized files use distinct hashes, 0600 and scoped reference-aware orphan cleanup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engine-inspected-'));let now=Date.now();try{
  const raw=new RawStore(join(dir,'raw'),'fake',process.cwd(),()=>now,validateArtifact),saved=raw.writeInspected(artifact);
  expect(saved.hash).toBe(hashBytes(Buffer.from(artifact.text)));expect(saved.path).toContain('/fake/inspected-v1/sha256/');
  expect(statSync(saved.path).mode&0o777).toBe(0o600);expect(raw.readArtifact(saved.hash)).toEqual(Buffer.from(artifact.text));expect(raw.writeInspected(artifact)).toEqual(saved);
  now+=86400001;raw.cleanup(new Set([saved.path]),now);expect(readFileSync(saved.path,'utf8')).toBe(artifact.text);
  raw.cleanup(new Set(),now);expect(raw.readArtifact(saved.hash)).toBeUndefined();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
