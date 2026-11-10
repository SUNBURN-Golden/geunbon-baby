import { closeSync, constants, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { atomicState, readState, safePath, syncDirectory } from './atomic-state';
import { join } from 'node:path';
import type { DeepSeekWebConfig, RunMemory } from './types';
import { saveMemory } from './memory';
import { emptyCycle } from './memory-schema';
import { admitCall, holdCall, releaseCall, settleCall } from './guards';
/** Start a new per-tick budget window while preserving lifetime totals in memory. */
export function beginCycle(memory: RunMemory, cycleId: string): RunMemory {
  if (memory.pending_result || memory.active_cycle || memory.pending_audit || memory.cycle.token_spent || memory.cycle.requests_spent || memory.cycle.tokens_reserved || memory.cycle.requests_reserved) throw new Error('accounting_recovery_required');
  memory.cycle = emptyCycle(cycleId);
  memory.token_spent = 0;
  memory.tokens_reserved = 0;
  memory.requests_spent = 0;
  memory.requests_reserved = 0;
  return memory;
}
/** Replay an audit intent under writer ownership; only a matching incomplete tail is repairable. */
export async function flushPendingAudit(dir: string, memory: RunMemory, fault: (point: string) => void = () => {}) {
  try { await appendPendingAudit(dir, memory, fault); }
  catch (error) {
    if (error instanceof Error && ['audit_conflict', 'memory_unavailable'].includes(error.message)) throw error;
    throw new Error('audit_unavailable');
  }
}
async function appendPendingAudit(dir: string, memory: RunMemory, fault: (point: string) => void) {
  const row = memory.pending_audit;
  if (!row) return;
  const path = join(dir, 'cycle-audit.jsonl');
  let content = '';
  try { content = readState(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('audit_unavailable'); }
  const end = content.lastIndexOf('\n') + 1;
  const tail = content.slice(end);
  const encoded = JSON.stringify(row);
  let found = false;
  for (const line of content.slice(0, end).split('\n').filter(Boolean)) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw new Error('audit_conflict'); }
    if (parsed.cycle_id === row.cycle_id) {
      if (JSON.stringify(parsed) !== encoded || found) throw new Error('audit_conflict');
      found = true;
    }
  }
  if (tail && (found || !encoded.startsWith(tail))) throw new Error('audit_conflict');
  const fd = openSync(safePath(path), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (tail) ftruncateSync(fd, Buffer.byteLength(content.slice(0, end)));
    if (!found) {
      const buffer = Buffer.from(encoded + '\n');
      let written = 0;
      const offset = Buffer.byteLength(content.slice(0, end));
      while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written, offset + written);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dir);
  fault('audit_appended');
  memory.pending_audit = null;
  await saveMemory(dir, memory);
  fault('audit_cleared');
}
export async function finalizeCycle(dir: string, memory: RunMemory, meta: Record<string, unknown>, fault: (point: string) => void = () => {}) {
  if (memory.finalized_cycle_id === memory.cycle.cycle_id) {
    await flushPendingAudit(dir, memory, fault);
    return;
  }
  // Terminal checkpoint precedes the single replacement that folds lifetime totals.
  await saveMemory(dir, memory);
  fault('terminal_checkpoint');
  memory.lifetime.token_spent += memory.cycle.token_spent;
  memory.lifetime.requests += memory.cycle.requests_spent;
  memory.lifetime.model_calls += memory.cycle.requests_spent;
  memory.lifetime.cycles += 1;
  const audit = {
    at: memory.active_cycle?.snapshot.heartbeat_at ?? new Date().toISOString(),
    cycle_id: memory.cycle.cycle_id,
    cycle_token_spent: memory.cycle.token_spent,
    cycle_requests: memory.cycle.requests_spent,
    lifetime_token_spent: memory.lifetime.token_spent,
    lifetime_cycles: memory.lifetime.cycles,
    ...meta,
  };
  memory.finalized_cycle_id = memory.cycle.cycle_id;
  memory.terminal_summary = memory.active_cycle?.snapshot ?? null;
  memory.pending_audit = audit;
  memory.active_cycle = null;
  memory.cycle = emptyCycle(memory.cycle.cycle_id);
  memory.token_spent = memory.tokens_reserved = memory.requests_spent = memory.requests_reserved = 0;
  // Fold, marker, audit intent and active-budget reset are indivisible.
  atomicState(join(dir, 'memory.json'), memory);
  fault('lifetime_folded');
  await flushPendingAudit(dir, memory, fault);
}
export const cycleAdmit = (memory: RunMemory, config: DeepSeekWebConfig) => admitCall(memory.cycle, config);
export const cycleHold = (memory: RunMemory, reserve: number) => holdCall(memory.cycle, reserve);
export const cycleRelease = (memory: RunMemory, reserve: number) => releaseCall(memory.cycle, reserve);
export const cycleSettle = (memory: RunMemory, reserve: number, usage: number) => settleCall(memory.cycle, reserve, usage);
