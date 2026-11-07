import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import { budgetAllows, hostMatchesDenied, isProhibitedUrl } from '../crawler/src/deepseek-web/guards';
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
    const memory = { ...emptyMemory(), token_spent: config.budget.max_tokens_per_run, requests_spent: 0 };
    expect(budgetAllows(memory, config).ok).toBe(false);
    const m2 = { ...emptyMemory(), requests_spent: config.budget.max_requests_per_run };
    expect(budgetAllows(m2, config).ok).toBe(false);
  });
  test('config loads from package path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsw-'));
    expect(loadDeepSeekWebConfig().profile_id).toBe('deepseek-web');
    expect(dir).toBeTruthy();
  });
});
