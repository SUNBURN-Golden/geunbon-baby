import type { QuietWindow } from './quiet-window';
import { QuietWindowError, quietWindowsAt } from './quiet-window';
import type { health } from './health';

// All effects and the clock are injected so the actual scheduler is tested offline.
type LoopDependencies<Session> = {
  now: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  schedule: (callback: () => void, ms: number) => () => void;
  stopped: () => boolean;
  open: (check: () => void) => Promise<Session>;
  login: (session: Session) => Promise<void>;
  cycle: (session: Session, check: () => void) => Promise<void>;
  close: (session: Session) => Promise<void>;
  save: () => Promise<void>;
  flush: () => Promise<void>;
  log: typeof health;
  isFatal: (error: unknown) => boolean;
  onFatal?: (error: unknown, session: Session | undefined, signal: AbortSignal) => Promise<void>;
};
class LoopStopped extends Error {}

export async function runMainLoop<Session>(
  options: { quietWindows: QuietWindow[]; pollMinutes: [number, number]; once: boolean },
  deps: LoopDependencies<Session>,
) {
  let session: Session | undefined;
  let closing: Promise<void> | undefined;
  let cancelTimer = () => {};
  let resumeAt: number | undefined;
  let failed = false;
  let diagnostics: AbortController | undefined;

  const enterQuiet = () => {
    const quiet = quietWindowsAt(options.quietWindows, deps.now());
    if (quiet.endAt === null || resumeAt !== undefined) return;
    const [min, max] = quiet.jitter_ms!;
    resumeAt = quiet.endAt + min + deps.random() * (max - min);
    diagnostics?.abort();
    deps.log('quiet_window_enter', {
      timezone: 'Asia/Seoul',
      end_at: Number.isFinite(quiet.endAt) ? new Date(quiet.endAt).toISOString() : null,
      resume_at: Number.isFinite(resumeAt) ? new Date(resumeAt).toISOString() : null,
    });
  };
  const closeSession = () => {
    cancelTimer();
    if (session !== undefined) {
      const current = session;
      session = undefined;
      closing = deps.close(current);
      // Timer-triggered closure is awaited by the loop, including any failure.
      void closing.catch(() => {});
    }
    return closing ?? Promise.resolve();
  };
  const check = () => {
    if (deps.stopped()) throw new LoopStopped();
    enterQuiet();
    if (resumeAt !== undefined) throw new QuietWindowError();
  };
  const armTimer = () => {
    cancelTimer();
    const nextStartAt = quietWindowsAt(options.quietWindows, deps.now()).nextStartAt;
    if (!Number.isFinite(nextStartAt)) return;
    cancelTimer = deps.schedule(() => {
      enterQuiet();
      if (resumeAt !== undefined) void closeSession();
      else armTimer(); // A backwards wall-clock adjustment must not start quiet early.
    }, Math.max(0, nextStartAt - deps.now()));
  };

  try {
    while (!deps.stopped()) {
      enterQuiet();
      if (resumeAt !== undefined) {
        await closeSession();
        await deps.save();
        await deps.flush();
        // Short sleeps keep SIGINT/SIGTERM responsive even in an overnight window.
        while (!deps.stopped() && deps.now() < resumeAt) await deps.sleep(Math.min(1000, resumeAt - deps.now()));
        if (deps.stopped()) break;
        const quiet = quietWindowsAt(options.quietWindows, deps.now());
        if (quiet.endAt !== null) {
          // Clock jumps or unusually long jitter can carry us into the next window.
          resumeAt = quiet.endAt + quiet.jitter_ms![0];
          continue;
        }
        resumeAt = undefined;
        deps.log('quiet_window_exit', { timezone: 'Asia/Seoul' });
        await deps.flush();
        continue;
      }
      try {
        check();
        if (session === undefined) {
          closing = undefined;
          armTimer();
          session = await deps.open(check);
          check();
          await deps.login(session);
        }
        check();
        const cycleStarted = deps.now();
        await deps.cycle(session, check);
        check();
        await deps.save();
        await deps.flush();
        if (options.once) break;
        const [min, max] = options.pollMinutes;
        const until = cycleStarted + (min + deps.random() * (max - min)) * 60_000;
        while (!deps.stopped() && deps.now() < until) {
          check();
          await deps.sleep(Math.min(1000, until - deps.now()));
        }
      } catch (error) {
        if (deps.isFatal(error)) throw error;
        if (error instanceof LoopStopped) break;
        if (error instanceof QuietWindowError || resumeAt !== undefined) {
          await closeSession();
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    failed = true;
    if (deps.isFatal(error) && deps.onFatal) {
      // Keep the boundary timer armed during diagnostics, including stalled
      // page/filesystem calls. Quiet hours abort capture and close the session.
      diagnostics = new AbortController();
      enterQuiet();
      if (resumeAt !== undefined) {
        diagnostics.abort();
        void closeSession();
      }
      let onAbort = () => {};
      const aborted = new Promise<void>(resolve => { onAbort = resolve; });
      diagnostics.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([
          deps.onFatal(error, session, diagnostics.signal),
          diagnostics.signal.aborted ? Promise.resolve() : aborted,
        ]);
      } catch { deps.log('warn', { scope: 'halt_diagnostics' }); }
      finally { diagnostics.signal.removeEventListener('abort', onAbort); }
    }
    throw error;
  } finally {
    // Close before disk work; no browser remains open during a quiet window.
    try {
      try { await closeSession(); }
      finally {
        try { await deps.save(); }
        finally { await deps.flush(); }
      }
    } catch (error) {
      // A cleanup failure must never turn a HaltError into a restartable error.
      if (!failed) throw error;
      deps.log('warn', { scope: 'cleanup' });
    }
  }
}
