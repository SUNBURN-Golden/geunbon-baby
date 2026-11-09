import type { DeepSeekWebConfig } from './types';
import type { CollectorStore } from '../store';
import { isProhibitedUrl } from './guards';
export const EMERGENCY_STOP_META_ID = 'deepseek_web:emergency_stop';
export type EmergencyStop = { stopped: boolean; reason?: string; at?: string };
export function assertDomainPolicyReadable(store: CollectorStore) {
  try {
    store.get<EmergencyStop>('collector_meta', EMERGENCY_STOP_META_ID);
    store.list<{ stopped?: boolean }>('domain_state');
  } catch {
    throw new Error('domain_state_unavailable');
  }
}
export function isGlobalEmergencyStop(store: CollectorStore) {
  assertDomainPolicyReadable(store);
  return !!store.get<EmergencyStop>('collector_meta', EMERGENCY_STOP_META_ID)?.stopped;
}
/** Walk hostname suffixes so momcalendar.com stops www.momcalendar.com without touching other origins. */
export function isHostDomainStopped(store: CollectorStore, hostname: string) {
  assertDomainPolicyReadable(store);
  const labels = hostname.toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join('.');
    if (store.get<{ stopped?: boolean; reason?: string }>('domain_state', suffix)?.stopped) return true;
  }
  return false;
}
export type UrlPolicyResult = { blocked: boolean; reason: string | null };
export function evaluateUrlDomainPolicy(store: CollectorStore | undefined, url: string, config: DeepSeekWebConfig): UrlPolicyResult {
  const guard = isProhibitedUrl(url, config);
  if (guard.blocked) return { blocked: true, reason: guard.reason };
  if (!store) return { blocked: false, reason: null };
  if (isGlobalEmergencyStop(store)) return { blocked: true, reason: 'emergency_stop' };
  const host = new URL(url).hostname;
  if (isHostDomainStopped(store, host)) return { blocked: true, reason: 'domain_stopped' };
  return { blocked: false, reason: null };
}
