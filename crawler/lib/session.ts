// Linux worker only. Never pass state or underlying errors to logs/diagnostics.
import type { BrowserContext } from 'playwright';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>;
export class SessionError extends Error {
  constructor() { super('크롤러 세션을 읽거나 저장하지 못했습니다. 세션 파일·권한·디스크를 수동 점검하세요.'); }
}

function validate(value: unknown): asserts value is SessionState {
  const state = value as SessionState | null;
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins) ||
    !state.cookies.every(c => c && ['name', 'value', 'domain', 'path'].every(key => typeof c[key as keyof typeof c] === 'string') &&
      Number.isFinite(c.expires) && typeof c.httpOnly === 'boolean' && typeof c.secure === 'boolean' && ['Strict', 'Lax', 'None'].includes(c.sameSite)) ||
    !state.origins.every(o => o && typeof o.origin === 'string' && Array.isArray(o.localStorage) &&
      o.localStorage.every(v => v && typeof v.name === 'string' && typeof v.value === 'string'))) throw new SessionError();
}

export function hasSessionCookie(cookies: SessionState['cookies'], now = Date.now()) {
  return cookies.some(c => c.name === 'sessionid' && c.value.trim().length > 0 &&
    ['instagram.com', '.instagram.com', 'www.instagram.com', '.www.instagram.com'].includes(c.domain) &&
    c.path === '/' && (c.expires === -1 || c.expires * 1000 > now));
}

export async function loadSession(file: string): Promise<SessionState | undefined> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SessionError();
  }
  try {
    const state: unknown = JSON.parse(raw);
    validate(state);
    return state;
  } catch { throw new SessionError(); }
}

async function safeIO<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw new SessionError(); }
}

export async function saveSession(context: BrowserContext, file: string, check: () => void = () => {}, verify: () => Promise<void> = async () => {}) {
  check();
  const state = await safeIO(() => context.storageState());
  check();
  validate(state);
  if (!hasSessionCookie(state.cookies)) throw new SessionError();
  const directory = dirname(file);
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  try {
    await safeIO(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    });
    check();
    await safeIO(async () => {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally { await handle.close(); }
    });
    await verify(); // Recheck the page after storage capture/disk work, before replacement.
    check(); // A failed/interrupted cycle must keep the previous valid state.
    await safeIO(() => rename(temporary, file));
  } finally { await unlink(temporary).catch(() => {}); }
}
