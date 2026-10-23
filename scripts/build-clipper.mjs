import ts from 'typescript';
import { readFile, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
const root=resolve('.'),out=resolve('tools/chrome-clipper/dist');
const settings=JSON.parse(await readFile('crawler/config/collector.json','utf8'));
const approved=settings.sources.filter(s=>s.enabled&&s.browser).map(({origin,selector,brand})=>({origin,selector,brand}));
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const seen=new Set();
async function emit(file){
  if(seen.has(file))return;seen.add(file);
  const source=file.endsWith('/approved.ts')?`export const approved = ${JSON.stringify(approved)}; export const policies = ${JSON.stringify(settings.sources.map(({origin,paths,query_keys,brand})=>({origin,paths,query_keys,brand})))}; export const policyVersion = ${JSON.stringify(settings.policy_version)};`:await readFile(file,'utf8');
  let output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  const imports=[...output.matchAll(/from ['"]([^'"]+)['"]/g)];
  for(const [,specifier] of imports){if(!specifier.startsWith('.'))throw new Error('browser_dependency');await emit(resolve(dirname(file),specifier+'.ts'));output=output.replaceAll(`'${specifier}'`,`'${specifier}.js'`).replaceAll(`"${specifier}"`,`"${specifier}.js"`);}
  const target=resolve(out,relative(root,file).replace(/\.ts$/,'.js'));await mkdir(dirname(target),{recursive:true});await writeFile(target,output);
}
await emit(resolve('tools/chrome-clipper/src/service-worker.ts'));await emit(resolve('tools/chrome-clipper/src/options.ts'));
const manifest=JSON.parse(await readFile('tools/chrome-clipper/manifest.json','utf8'));manifest.optional_host_permissions=approved.map(s=>s.origin+'/*');
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2));await copyFile('tools/chrome-clipper/options.html',resolve(out,'options.html'));
console.log('Chrome clipper built: tools/chrome-clipper/dist');
