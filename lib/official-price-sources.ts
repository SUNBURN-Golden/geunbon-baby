import { assessPriceEvidence, digest, identityToken, instant, isOfficialPriceScope, type PriceEvidence } from '../shared/deal-price-evidence';

export function officialPriceGuard(evidence: PriceEvidence | null) {
  if (!evidence?.official) return { sql: '1', values: [] };
  if (!evidence.official_approval) return { sql: '0', values: [] };
  const { id, revision } = evidence.official_approval;
  const { url, observed_at } = evidence.official.source;
  const config = assessPriceEvidence(evidence).facts?.configuration;
  return {
    sql: `EXISTS (SELECT 1 FROM official_price_approvals a, json_each(a.scopes) s
       WHERE json_extract(s.value,'$.url') = ? AND json_extract(s.value,'$.id') = ?
       AND json_extract(s.value,'$.revision') = ?
       AND json_extract(s.value,'$.variant') IS ?
       AND json_extract(s.value,'$.approved_at') <= ?
       AND json_extract(s.value,'$.expires_at') > ?
       AND json_extract(s.value,'$.expires_at') > ?
       ${config ? "AND json_extract(s.value,'$.brand') = ? AND json_extract(s.value,'$.model') = ?" : ''})`,
    values: [url, id, revision, evidence.official_approval.variant ? JSON.stringify(evidence.official_approval.variant) : null, observed_at, observed_at, new Date(Date.now()).toISOString(), ...(config ? [identityToken(config.brand), identityToken(config.model)] : [])],
  };
}

export async function officialPriceAllowed(db: D1Database, evidence: PriceEvidence | null) {
  if (!evidence?.official) return true;
  const guard = officialPriceGuard(evidence);
  return !!await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first();
}

export async function syncOfficialPriceScopes(db: D1Database, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'invalid_source_approvals';
  const { observed_at, scopes } = input as Record<string, unknown>;
  if (!instant(observed_at) || Date.parse(observed_at) > Date.now() + 60_000 || !Array.isArray(scopes) || scopes.length > 100 ||
      !scopes.every(scope => isOfficialPriceScope(scope) && scope.approved_at <= observed_at &&
        scope.brand === identityToken(scope.brand) && scope.model === identityToken(scope.model)) ||
      new Set(scopes.map(scope => JSON.stringify([scope.url, scope.variant?.id]))).size !== scopes.length) return 'invalid_source_approvals';
  const body = JSON.stringify(scopes);
  const result = await db.prepare(`INSERT INTO official_price_approvals (id,observed_at,scopes) VALUES (1,?,?)
    ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at, scopes=excluded.scopes
    WHERE excluded.observed_at > official_price_approvals.observed_at`).bind(observed_at, body).run();
  if (result.meta.changes) return null;
  const replay = await db.prepare('SELECT 1 FROM official_price_approvals WHERE id = 1 AND observed_at = ? AND scopes = ?').bind(observed_at, body).first();
  return replay ? null : 'stale_source_approvals';
}

export async function officialScopeReceipt(input: { observed_at: string; scopes: unknown[] }, site: string) {
  return { site, revision: input.observed_at, digest: await digest(JSON.stringify(input.scopes)), scopes: input.scopes.length };
}
