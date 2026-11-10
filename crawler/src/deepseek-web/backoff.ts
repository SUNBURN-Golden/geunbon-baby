import { join } from 'node:path';
import { atomicState, readState } from './atomic-state';
export type BackoffState = {
  schema_version: 1;
  status: 402 | 429;
  reason: 'deepseek_insufficient_balance' | 'deepseek_rate_limited';
  failures: number;
  failed_at: string;
  next_attempt_at: string;
};
export function readBackoff(dir: string): BackoffState | null {
  try {
    const b = JSON.parse(readState(join(dir, 'backoff.json')));
    if (b === null) return null;
    const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
    if (b.schema_version !== 1 || ![402, 429].includes(b.status) || b.reason !== (b.status === 402 ? 'deepseek_insufficient_balance' : 'deepseek_rate_limited') || !Number.isSafeInteger(b.failures) || b.failures < 1 || !timestamp(b.failed_at) || !timestamp(b.next_attempt_at) || Date.parse(b.next_attempt_at) <= Date.parse(b.failed_at) || Date.parse(b.next_attempt_at) - Date.parse(b.failed_at) !== backoffDelay(b.failures)) throw new Error();
    return b;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('backoff_state_unavailable');
  }
}
export const backoffDelay = (failures: number) => Math.min(6, 2 ** Math.min(3, failures - 1)) * 3600000;
export function saveBackoff(dir: string, state: BackoffState | null) {
  try { atomicState(join(dir, 'backoff.json'), state); } catch { throw new Error('backoff_state_unavailable'); }
}
export function failBackoff(dir: string, previous: BackoffState | null, status: 402 | 429, now: number) {
  const failures = Math.min(Number.MAX_SAFE_INTEGER, (previous?.failures ?? 0) + 1);
  const state: BackoffState = { schema_version: 1, status, reason: status === 402 ? 'deepseek_insufficient_balance' : 'deepseek_rate_limited', failures, failed_at: new Date(now).toISOString(), next_attempt_at: new Date(now + backoffDelay(failures)).toISOString() };
  saveBackoff(dir, state);
  return state;
}
export function backoffView(state: BackoffState | null, now: number) {
  return state ? { ...state, state: Date.parse(state.next_attempt_at) > now ? 'scheduled' as const : 'eligible' as const } : null;
}
