#!/bin/sh
set -eu
# The inode is permanent: never delete this file to break a lock.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
: "${COLLECTOR_DB:?COLLECTOR_DB required}"
umask 077
# Refuse symlinks/unsafe lock files before flock opens them (including parents).
node_modules/node/bin/node --input-type=module -e '
import {lstatSync,realpathSync,openSync,closeSync,constants} from "node:fs";
import {dirname,resolve} from "node:path";
try {
const db=process.env.COLLECTOR_DB,dir=dirname(db),p=db+".watchdog.flock";
const d=lstatSync(dir);
if(resolve(db)!==db||realpathSync(dir)!==dir||!d.isDirectory()||(d.mode&0o777)!==0o700||d.uid!==process.getuid())process.exit(1);
try{closeSync(openSync(p,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600));}catch(e){if(e.code!=="EEXIST")throw e;}
const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600||s.uid!==process.getuid())process.exit(1);
} catch { console.log(JSON.stringify({schema_version:1,event:"watchdog",generated_at:new Date().toISOString(),code:"watchdog_preflight_failed",automatic_recovery:false}));process.exit(1); }
'
export COLLECTOR_WATCHDOG_LOCKED=1
exec flock --nonblock --conflict-exit-code 0 "${COLLECTOR_DB}.watchdog.flock" node_modules/node/bin/node --import tsx crawler/collector-watchdog.mjs "$@" 2>/dev/null
