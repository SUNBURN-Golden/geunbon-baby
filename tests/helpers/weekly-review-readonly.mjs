import './offline-child.mjs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const state = resolve(process.env.DEEPSEEK_WEB_STATE_DIR);
const inState = path => { try { const p=resolve(String(path)); return p===state || p.startsWith(state+sep); } catch { return false; } };
for (const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','rmSync','unlinkSync','chmodSync','truncateSync']) {
  const original = fs[name]; fs[name] = (...args) => { if (args.some(inState)) throw new Error('weekly_state_write_forbidden'); return original(...args); };
}
for (const name of ['writeFile','appendFile','mkdir','rename','rm','unlink','chmod','truncate']) {
  const original = fsp[name]; fsp[name] = (...args) => { if (args.some(inState)) throw new Error('weekly_state_write_forbidden'); return original(...args); };
}
const open = fs.openSync;
fs.openSync = (path, flags, ...args) => {
  if (inState(path) && (typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)) !== 0)) throw new Error('weekly_state_write_forbidden');
  return open(path,flags,...args);
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:sqlite' || /(?:runtime-store|extraction-cache|cache-delivery|writer-ownership|\/runner|\/lifecycle|\/store)(?:\.|$)/.test(specifier)) throw new Error('weekly_runtime_load_forbidden');
  return next(specifier, context);
} });
syncBuiltinESMExports();
