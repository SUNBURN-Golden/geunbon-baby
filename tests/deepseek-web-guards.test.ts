import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { admitCall, budgetAllows, holdCall, hostMatchesDenied, isProhibitedUrl, perCallTokenReserve, releaseCall, settleCall } from '../crawler/src/deepseek-web/guards';
import { emptyMemory } from '../crawler/src/deepseek-web/memory';

describe('deepseek-web guards', () => {
  const config = loadDeepSeekWebConfig();
  test.each([
    'https://www.instagram.com/p/abc/',
    'https://i.threads.net/@x',
    'https://gonggumoa.com/deal/1',
    'http://example.com/insecure',
  ])('prohibited or unsafe %s', url => {
    expect(isProhibitedUrl(url, config).blocked).toBe(true);
  });
  test('approved https origin passes host policy', () => {
    expect(isProhibitedUrl('https://www.stokke.com/KOR/ko-kr/', config).blocked).toBe(false);
  });
  test('hostMatchesDenied covers subdomains', () => {
    expect(hostMatchesDenied('m.instagram.com', config.prohibited_hosts)).toBe(true);
  });
  test('token and request budget stops run', () => {
    const memory = emptyMemory();
    memory.cycle.token_spent = config.budget.max_tokens_per_run;
    expect(budgetAllows(memory.cycle, config).ok).toBe(false);
    const memory2 = emptyMemory();
    memory2.cycle.requests_spent = config.budget.max_requests_per_run;
    expect(budgetAllows(memory2.cycle, config).ok).toBe(false);
  });
  test('pre-request reservation blocks overshoot before completion', () => {
    const reserve = perCallTokenReserve(config);
    const memory = emptyMemory();
    memory.cycle.token_spent = config.budget.max_tokens_per_run - reserve;
    expect(admitCall(memory.cycle, config).ok).toBe(true);
    const admission = admitCall(memory.cycle, config);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    holdCall(memory.cycle, admission.reserve);
    expect(admitCall(memory.cycle, config).ok).toBe(false);
    settleCall(memory.cycle, admission.reserve, reserve);
    expect(memory.cycle.token_spent).toBe(config.budget.max_tokens_per_run);
    expect(admitCall(memory.cycle, config).ok).toBe(false);
    const m3 = emptyMemory();
    holdCall(m3.cycle, reserve);
    releaseCall(m3.cycle, reserve);
    expect(m3.cycle.tokens_reserved).toBe(0);
    expect(m3.cycle.requests_reserved).toBe(0);
  });
  test('config loads from package path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsw-'));
    expect(loadDeepSeekWebConfig().profile_id).toBe('deepseek-web');
    expect(dir).toBeTruthy();
  });
});
