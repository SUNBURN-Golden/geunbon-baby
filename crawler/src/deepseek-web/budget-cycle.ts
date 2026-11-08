import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CycleBudget, DeepSeekWebConfig, LifetimeAudit, RunMemory } from './types';
import { admitCall, holdCall, releaseCall, settleCall } from './guards';
export function emptyCycle(cycleId: string): CycleBudget {
  return { cycle_id: cycleId, token_spent: 0, tokens_reserved: 0, requests_spent: 0, requests_reserved: 0 };
}
export function emptyLifetime(): LifetimeAudit {
  return { token_spent: 0, requests: 0, cycles: 0, model_calls: 0 };
}
export function migrateMemory(raw: Partial<RunMemory> & { version?: number }, cycleId: string): RunMemory {
  const lifetime = raw.lifetime ?? emptyLifetime();
  if (raw.version !== 2) {
    const legacyTokens = raw.token_spent ?? 0;
    const legacyRequests = raw.requests_spent ?? 0;
    lifetime.token_spent += legacyTokens;
    lifetime.requests += legacyRequests;
    lifetime.model_calls += legacyRequests;
    lifetime.cycles = lifetime.cycles || 0;
  }
  const cycle = emptyCycle(cycleId);
  return {
    version: 2,
    updated_at: raw.updated_at ?? new Date().toISOString(),
    plan_notes: raw.plan_notes ?? [],
    observed_urls: raw.observed_urls ?? [],
    pending_urls: raw.pending_urls ?? [],
    token_spent: 0,
    tokens_reserved: 0,
    requests_spent: 0,
    requests_reserved: 0,
    cycle,
    lifetime,
    last_heartbeat_at: raw.last_heartbeat_at ?? null,
    last_run_id: raw.last_run_id ?? null,
    last_collection_status: raw.last_collection_status ?? 'idle',
    listing_discovery: raw.listing_discovery ?? {},
    next_search_hints: raw.next_search_hints ?? [],
    output_counts: raw.output_counts ?? { extractions: 0, proposals: 0, blocked: 0, review_pending: 0 },
  };
}
/** Start a new per-tick budget window while preserving lifetime totals in memory. */
export function beginCycle(memory: RunMemory, cycleId: string): RunMemory {
  if (memory.cycle.token_spent > 0 || memory.cycle.requests_spent > 0) {
    memory.lifetime.token_spent += memory.cycle.token_spent;
    memory.lifetime.requests += memory.cycle.requests_spent;
    memory.lifetime.model_calls += memory.cycle.requests_spent;
  }
  memory.cycle = emptyCycle(cycleId);
  memory.token_spent = 0;
  memory.tokens_reserved = 0;
  memory.requests_spent = 0;
  memory.requests_reserved = 0;
  return memory;
}
export async function finalizeCycle(dir: string, memory: RunMemory, meta: Record<string, unknown>) {
  memory.lifetime.token_spent += memory.cycle.token_spent;
  memory.lifetime.requests += memory.cycle.requests_spent;
  memory.lifetime.model_calls += memory.cycle.requests_spent;
  memory.lifetime.cycles += 1;
  await mkdir(dir, { recursive: true });
  const audit = {
    at: new Date().toISOString(),
    cycle_id: memory.cycle.cycle_id,
    cycle_token_spent: memory.cycle.token_spent,
    cycle_requests: memory.cycle.requests_spent,
    lifetime_token_spent: memory.lifetime.token_spent,
    lifetime_cycles: memory.lifetime.cycles,
    ...meta,
  };
  await appendFile(join(dir, 'cycle-audit.jsonl'), `${JSON.stringify(audit)}\n`);
  memory.cycle = emptyCycle(memory.cycle.cycle_id);
  memory.token_spent = 0;
  memory.tokens_reserved = 0;
  memory.requests_spent = 0;
  memory.requests_reserved = 0;
}
export const cycleAdmit = (memory: RunMemory, config: DeepSeekWebConfig) => admitCall(memory.cycle, config);
export const cycleHold = (memory: RunMemory, reserve: number) => holdCall(memory.cycle, reserve);
export const cycleRelease = (memory: RunMemory, reserve: number) => releaseCall(memory.cycle, reserve);
export const cycleSettle = (memory: RunMemory, reserve: number, usage: number) => settleCall(memory.cycle, reserve, usage);
