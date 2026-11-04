import { decodeAdminReviewCursor, validateAdminDealPage } from './api';

export const ADMIN_NAVIGATION_KEYS = ['deal', 'deal_status', 'deal_cursor', 'queue_cursor', 'candidate_cursor'] as const;
type NavigationKey = typeof ADMIN_NAVIGATION_KEYS[number];
export type AdminNavigation = Partial<Record<NavigationKey, string>>;
export type AdminSearchParams = Record<string, string | string[] | undefined>;

// Links and posted return state have the same allowlist. No return URL is accepted.
export function parseAdminNavigation(params: AdminSearchParams) {
  const state: AdminNavigation = {}, invalid: NavigationKey[] = [];
  for (const key of ADMIN_NAVIGATION_KEYS) {
    const value = params[key];
    if (value === undefined) continue;
    try {
      if (typeof value !== 'string' || !value) throw new Error();
      if (key === 'deal' && !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error();
      if (key === 'deal_status' && !['published', 'withdrawn', 'all'].includes(value)) throw new Error();
      if (key === 'deal_cursor') validateAdminDealPage({ cursor: value });
      if (key === 'queue_cursor') decodeAdminReviewCursor('queue', value);
      if (key === 'candidate_cursor') decodeAdminReviewCursor('candidates', value);
      state[key] = value;
    } catch { invalid.push(key); }
  }
  // An invalid filter cannot retain a position within a different deal list.
  if (invalid.includes('deal_status')) delete state.deal_cursor;
  return { state, invalid };
}

export function adminNavigationFromForm(form: FormData): AdminNavigation {
  const params: AdminSearchParams = {};
  for (const key of ADMIN_NAVIGATION_KEYS) {
    const values = form.getAll(`nav_${key}`);
    if (values.length) params[key] = values.length === 1 && typeof values[0] === 'string' ? values[0] : [];
  }
  return parseAdminNavigation(params).state;
}

export function adminUrl(state: AdminNavigation, changes: Partial<Record<NavigationKey, string | undefined>> = {}, error?: string) {
  const validated = parseAdminNavigation({ ...state, ...changes }).state;
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  for (const key of ADMIN_NAVIGATION_KEYS) if (validated[key]) params.set(key, validated[key]);
  return `/admin${params.size ? `?${params}` : ''}`;
}

// Return-state inputs are deliberately kept out of mutation payloads.
export function adminMutationFields(form: FormData) {
  return Object.fromEntries([...form.entries()].filter(([name]) => !name.startsWith('nav_')));
}
