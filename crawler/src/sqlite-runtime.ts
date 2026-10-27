// https://www.sqlite.org/wal.html#walresetbug (including the two backports).
export const WAL_RESET_FIXED = [
  { line: '3.44', min: '3.44.6' },
  { line: '3.50', min: '3.50.7' },
  { any: '3.51.3' },
] as const;
export function sqliteRuntimeSafe(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts=version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  return WAL_RESET_FIXED.some(fix=>{
    if ('line' in fix && !version.startsWith(`${fix.line}.`)) return false;
    const minimum=('min' in fix?fix.min:fix.any).split('.').map(Number);
    for (let i=0;i<3;i++) if(parts[i]!==minimum[i]) return parts[i]>minimum[i];
    return true;
  });
}
