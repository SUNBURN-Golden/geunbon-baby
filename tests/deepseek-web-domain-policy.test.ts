import { describe, expect, test } from 'vitest';
import { fixture } from './helpers/collector';
import { loadDeepSeekWebConfig } from '../crawler/src/deepseek-web/config';
import {
  EMERGENCY_STOP_META_ID,
  evaluateUrlDomainPolicy,
  isGlobalEmergencyStop,
  isHostDomainStopped,
} from '../crawler/src/deepseek-web/domain-policy';

describe('deepseek-web domain policy decoupling', () => {
  const config = loadDeepSeekWebConfig();
  test('momcalendar stop does not imply global emergency', () => {
    const f = fixture();
    f.store.put('domain_state', 'momcalendar.com', { stopped: true, next_at: 0, reason: 'blocked' });
    expect(isGlobalEmergencyStop(f.store)).toBe(false);
    expect(isHostDomainStopped(f.store, 'www.momcalendar.com')).toBe(true);
    expect(isHostDomainStopped(f.store, 'fixture.example')).toBe(false);
    // momcalendar.com is now also hard-prohibited before the DB domain state is consulted.
    expect(evaluateUrlDomainPolicy(f.store, 'https://momcalendar.com/deal', config).reason).toBe('prohibited_domain');
    expect(evaluateUrlDomainPolicy(f.store, 'https://fixture.example/x', config).blocked).toBe(false);
    f.store.put('domain_state', 'fixture.example', { stopped: true, next_at: 0, reason: 'blocked' });
    expect(evaluateUrlDomainPolicy(f.store, 'https://fixture.example/x', config).reason).toBe('domain_stopped');
    f.close();
  });
  test('explicit collector_meta emergency_stop halts all urls', () => {
    const f = fixture();
    f.store.put('collector_meta', EMERGENCY_STOP_META_ID, { stopped: true, reason: 'operator_halt' });
    expect(isGlobalEmergencyStop(f.store)).toBe(true);
    expect(evaluateUrlDomainPolicy(f.store, 'https://fixture.example/x', config).reason).toBe('emergency_stop');
    f.close();
  });
});
