import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWrite, DeployError, errorCode, finishAppend, isSha, readState, prepareAppend,
  type Attempt, type CrawlerSnapshot, type Migration, type Phase,
} from './state';
import { runtimePath } from './git';
import { uploadVersion } from './site';

export type Adapters = {
  prepare(path: string, sha: string): Promise<void>;
  verify(path: string, sha: string): Promise<void>;
  remove(path: string, sha: string): Promise<void>;
  fetch(): Promise<string>;
  validate(path: string, report: (name: string) => void): Promise<void>;
  copy(before: string | null, after: string): Promise<string>;
  serving(path: string): Promise<string>;
  pending(path: string): Promise<Migration[]>;
  migrate(path: string): Promise<unknown>;
  upload(path: string, output: string): Promise<unknown>;
  promote(path: string, version: string): Promise<unknown>;
  health(path: string, version: string, legacy: boolean): Promise<boolean>;
  rollback(path: string, version: string): Promise<unknown>;
  preflight(path: string, instagramRoot: string | null): Promise<CrawlerSnapshot>;
  current(): string | null;
  cutover(path: string, snapshot: CrawlerSnapshot): Promise<void>;
  restore(path: string, snapshot: CrawlerSnapshot): Promise<void>;
};

const rejectedChecks = new Set(['typecheck_failed', 'tests_failed', 'worker_build_failed', 'worker_bundle_failed', 'wrangler_config_invalid']);
const recoverablePhases = new Set<Phase>(['promote', 'health', 'rollback', 'cutover', 'restore']);
const pollMs = 300_000;
class StateWriteError extends DeployError {}

export function deployer(root: string, runtime: string, ops: Adapters, log: (code: string) => void, now = Date.now) {
  const store = join(root, 'state.json');
  // Re-read at the start of every poll. A failed state write always stops the
  // transition and the next poll reconciles from the last durable intent.
  let state = readState(root);
  const save = () => {
    try { atomicWrite(store, state); }
    catch { throw new StateWriteError('state_write_failed'); }
  };
  const report = (a: Attempt, name: string, outcome = 'ok') => {
    a.steps.push({ name, outcome });
    save();
  };
  const advance = (a: Attempt, phase: Phase, step: string) => {
    a.phase = phase;
    report(a, step);
  };

  function defer(sha: string) {
    const count = state.retry?.sha === sha ? Math.min(state.retry.count + 1, 5) : 1;
    state.retry = { sha, count, at: now() + Math.min(pollMs * 2 ** (count - 1), 3_600_000) };
  }
  function terminal(a: Attempt, status: 'deployed' | 'rejected' | 'failed' | 'partial' | 'superseded') {
    const ok = status === 'deployed';
    if (status === 'failed' || status === 'partial') defer(a.sha);
    else state.retry = null;
    if (status === 'rejected') state.rejected = a.sha;
    if (ok) {
      state.lastCrawler = a.sha;
      state.lastDeployed = a.sha;
      state.successful = [a.path, ...state.successful.filter(path => path !== a.path)].slice(0, 4);
    }
    state.event = { text: JSON.stringify({
      id: a.id, sha: a.sha, ok, status, steps: a.steps, duration: Math.max(0, now() - a.started),
      rollback: a.rollback, migrations: a.migrations ?? [],
    }) + '\n' };
    state.attempt = null;
    save();
  }

  function flushEvent() {
    const event = state.event;
    if (!event) return;
    const path = join(root, 'deploys.jsonl');
    if (!event.append) {
      event.append = prepareAppend(path, event.text);
      save();
    }
    finishAppend(path, event.append);
    state.event = null;
    save();
  }

  async function flushCopy() {
    const path = join(root, 'COPY_REVIEW.md');
    while (state.copy.length) {
      const review = state.copy[0];
      if (!review.append) {
        const text = await ops.copy(review.before, review.after);
        if (text) {
          review.append = prepareAppend(path, text);
          save();
        }
      }
      if (review.append) finishAppend(path, review.append);
      state.copy.shift();
      save();
    }
  }

  async function tryCopy() {
    try { await flushCopy(); }
    catch (error) {
      if (error instanceof StateWriteError) throw error;
      log('copy_review_pending');
    }
  }

  async function retain(sha: string | null) {
    const current = ops.current();
    const keep = new Set(state.successful.filter(path => path !== current).slice(0, 3));
    if (current) keep.add(current);
    if (sha && (state.retry?.sha === sha || state.lastSite === sha && state.lastCrawler !== sha)) keep.add(runtimePath(runtime, sha));
    if (state.attempt) {
      keep.add(state.attempt.path);
      const snapshot = state.attempt.crawler;
      if (snapshot?.link) keep.add(snapshot.link);
      for (const app of snapshot?.apps ?? []) keep.add(app.root);
    }
    if (state.instagramRoot) keep.add(state.instagramRoot);
    for (const [path, sha] of Object.entries(state.owned)) {
      if (keep.has(path)) continue;
      await ops.remove(path, sha);
      delete state.owned[path];
      save();
    }
  }

  async function expectVersion(a: Attempt, version: string) {
    if (await ops.serving(a.path) !== version) throw new DeployError('worker_version_drift');
  }

  async function processAttempt(a: Attempt) {
    try {
      if (a.phase !== 'prepare') await ops.verify(a.path, a.sha);
      for (;;) {
        switch (a.phase) {
          case 'prepare':
            if (state.owned[a.path] ? state.owned[a.path] !== a.sha : !!lstatSync(a.path, { throwIfNoEntry: false })) {
              throw new DeployError('runtime_sha_collision');
            }
            state.owned[a.path] = a.sha;
            save();
            await ops.prepare(a.path, a.sha);
            await ops.validate(a.path, step => report(a, step));
            await ops.preflight(a.path, state.instagramRoot);
            a.previous = await ops.serving(a.path);
            a.migrations = await ops.pending(a.path);
            advance(a, 'migrate', 'production_preflight');
            break;
          case 'migrate':
            await ops.preflight(a.path, state.instagramRoot);
            await expectVersion(a, a.previous!);
            await ops.migrate(a.path);
            a.output = join(root, 'upload-' + randomUUID() + '.jsonl');
            advance(a, 'upload', 'd1_migrations');
            break;
          case 'upload': {
            await expectVersion(a, a.previous!);
            const output = a.output!;
            if (!lstatSync(output, { throwIfNoEntry: false })) await ops.upload(a.path, output);
            try { a.version = uploadVersion(readFileSync(output, 'utf8')); }
            catch { throw new DeployError('upload_record_invalid'); }
            delete a.output;
            advance(a, 'promote', 'worker_upload');
            rmSync(output, { force: true });
            break;
          }
          case 'promote': {
            const serving = await ops.serving(a.path);
            if (serving !== a.version) {
              if (serving !== a.previous) throw new DeployError('worker_version_drift');
              await ops.promote(a.path, a.version!);
            }
            advance(a, 'health', serving === a.version ? 'worker_promotion_observed' : 'worker_promote');
            break;
          }
          case 'health': {
            if (await ops.health(a.path, a.version!, false)) {
              state.copy.push({ before: state.lastSite, after: a.sha });
              state.lastSite = a.sha;
              state.lastSiteVersion = a.version!;
              advance(a, 'crawler', 'site_health');
              await tryCopy();
            } else {
              a.rollback = { command: null, verified: false };
              a.phase = 'rollback';
              report(a, 'site_health', 'failed');
            }
            break;
          }
          case 'rollback': {
            const serving = await ops.serving(a.path);
            if (serving !== a.previous) {
              if (serving !== a.version) throw new DeployError('worker_version_drift');
              try {
                await ops.rollback(a.path, a.previous!);
                a.rollback!.command = 'ok';
              } catch {
                a.rollback!.command = 'failed';
              }
              report(a, 'worker_rollback_command', a.rollback!.command);
            } else if (a.rollback!.command === null) {
              a.rollback!.command = 'observed';
              report(a, 'worker_rollback_command', 'observed');
            }
            a.rollback!.verified = await ops.health(a.path, a.previous!, true);
            report(a, 'worker_rollback_verification', a.rollback!.verified ? 'ok' : 'failed');
            if (!a.rollback!.verified) throw new DeployError('worker_rollback_unverified');
            terminal(a, 'rejected');
            return;
          }
          case 'crawler':
            await expectVersion(a, state.lastSiteVersion!);
            a.crawler = await ops.preflight(a.path, state.instagramRoot);
            state.instagramRoot = a.crawler.instagramRoot;
            advance(a, 'cutover', 'crawler_snapshot');
            break;
          case 'cutover':
            try {
              await ops.cutover(a.path, a.crawler!);
            } catch (error) {
              if (errorCode(error) === 'crawler_cutover_waiting_for_jobs' && ops.current() === a.crawler!.link) {
                report(a, 'crawler_cutover', errorCode(error));
                terminal(a, 'partial');
                return;
              }
              a.phase = 'restore';
              report(a, 'crawler_cutover', errorCode(error));
              break;
            }
            report(a, 'crawler_verified_and_saved');
            terminal(a, 'deployed');
            return;
          case 'restore':
            await ops.restore(a.path, a.crawler!);
            report(a, 'crawler_restore');
            terminal(a, 'partial');
            return;
        }
      }
    } catch (error) {
      // If terminal state was saved or the state write itself failed, do not
      // create a second event or overwrite the pending intent.
      if (state.attempt !== a || error instanceof StateWriteError) throw error;
      const code = errorCode(error);
      report(a, a.phase, code);
      if (recoverablePhases.has(a.phase) || code === 'worker_version_drift') {
        defer(a.sha);
        save();
      } else {
        if (a.output) {
          try { rmSync(a.output, { force: true }); } catch { log('upload_cleanup_pending'); }
        }
        terminal(a, rejectedChecks.has(code) ? 'rejected' : state.lastSite === a.sha ? 'partial' : 'failed');
      }
      log(code);
    }
  }

  return {
    async poll() {
      state = readState(root);
      let sha: string | null = null;
      try {
        const fetched = await ops.fetch();
        if (!isSha(fetched)) throw new DeployError('fetch_failed');
        sha = fetched;
      } catch { log('fetch_failed'); }
      flushEvent();
      await tryCopy();
      if (sha && state.rejected && sha !== state.rejected) {
        state.rejected = null;
        save();
      }
      let a = state.attempt;
      if (a && sha && sha !== a.sha && ['prepare', 'crawler'].includes(a.phase)) {
        terminal(a, 'superseded');
        flushEvent();
        a = null;
      }
      const fullyDeployed = sha === state.lastDeployed && sha === state.lastSite && sha === state.lastCrawler;
      if (!a && sha && !fullyDeployed && sha !== state.rejected && !(state.retry?.sha === sha && state.retry.at > now())) {
        a = {
          id: randomUUID(), sha, path: runtimePath(runtime, sha), started: now(), steps: [],
          phase: state.lastSite === sha ? 'crawler' : 'prepare', rollback: null,
        };
        state.attempt = a;
        save();
      }
      if (a && !(state.retry?.sha === a.sha && state.retry.at > now()) && (sha || recoverablePhases.has(a.phase))) {
        await processAttempt(a);
        flushEvent();
      }
      try { await retain(sha); }
      catch { log('runtime_retention_pending'); }
    },
  };
}
