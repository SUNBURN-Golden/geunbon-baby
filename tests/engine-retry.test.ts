import { expect, test } from 'vitest';
import { classify, CostCapError, nextAttemptAt } from '../crawler/engine';
test('retry backoff, jitter floor, six-hour ceiling and source cooldown',()=>{
 expect([1,2,3].map(n=>nextAttemptAt(0,n,'network_error',{},()=>0))).toEqual([300000,600000,1200000]);
 expect(nextAttemptAt(0,1,'source_cooldown',{next_at:10000000},()=>0)).toBe(10000000);
 expect(nextAttemptAt(0,20,'tool_timeout',{},()=>1)).toBe(21600000);
 expect(nextAttemptAt(0,1,'network_error',{base:1},()=>0)).toBe(300000);
});
test.each(['source_blocked','robots_denied','robots_unavailable','visit_not_allowed','private_network','domain_stopped','login_required','access_restricted','empty_page','response_size','payload_shape','payload_changed','submission_expired','merge_forbidden','region_missing'])('%s is terminal without automatic retry',code=>expect(classify(new Error(code))).toBe('terminal'));
test('costs and unavailable tools are distinct from retryable failures',()=>{
 expect(classify(new CostCapError('day'))).toBe('day');expect(classify(new CostCapError('run'))).toBe('run');expect(classify(new Error('daily_limit'))).toBe('day');expect(classify(new Error('unsupported'))).toBe('unsupported');expect(classify(new Error('network_error'))).toBe('retryable');
});
