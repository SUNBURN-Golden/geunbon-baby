// Invoked only under crawler/collector-watchdog.sh's kernel flock.
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
const diagnostic = code => console.log(JSON.stringify({schema_version:1,event:'watchdog',generated_at:new Date().toISOString(),code,automatic_recovery:false}));
try {
  if(process.platform!=='linux'||process.env.COLLECTOR_WATCHDOG_LOCKED!=='1')throw new Error();
  const file=process.env.COLLECTOR_DB;
  if(!file||resolve(file)!==file)throw new Error();
  const {watchdog,initialWatchdogState}=await import('./src/collector-watchdog.ts');
  const {writePrivate}=await import('./src/private-state.ts');
  if(process.argv.includes('--init')){
    if(lstatSync(`${file}.watchdog/state.json`,{throwIfNoEntry:false}))throw new Error();
    // An installation marker survives state loss. --init can never reset a recovery budget.
    const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600)throw new Error();
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);
    try{
      if(db.prepare("SELECT 1 FROM collector_meta WHERE id='watchdog_initialized'").get())throw new Error();
      db.prepare("INSERT INTO collector_meta(id,data) VALUES('watchdog_initialized','true')").run();
      writePrivate(`${file}.watchdog/state.json`,initialWatchdogState(Date.now()));
    }finally{db.close();}
    diagnostic('watchdog_initialized');
  }else{
    const {linuxAdapters}=await import('./src/watchdog-linux.ts');
    await watchdog(`${file}.watchdog/state.json`,linuxAdapters(file));
  }
}catch{diagnostic('watchdog_unavailable');process.exitCode=1;}
