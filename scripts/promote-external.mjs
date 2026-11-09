#!/usr/bin/env node
/**
 * Promote an external_candidates row (or DeepSeek review item) to a published /deals entry.
 *
 * Env: ADMIN_TOKEN (required), PROMOTE_API_ORIGIN (default http://127.0.0.1:8787)
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || 'true'];
}));

const origin = process.env.PROMOTE_API_ORIGIN ?? 'http://127.0.0.1:8787';
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error('ADMIN_TOKEN required');
  process.exit(1);
}

let candidateId = args['candidate-id'];
if (args['from-review-queue']) {
  const path = args['from-review-queue'];
  const line = Number(args.line ?? 0);
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const item = rows[line];
  if (!item?.extraction?.url) throw new Error('review queue line missing extraction.url');
  const ingest = await fetch(`${origin}/api/v1/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.INGEST_TOKEN ?? token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'external_listing',
      source: 'pangpang',
      source_url: item.extraction.url,
      title: `${item.extraction.brand} ${item.extraction.model}`.trim().slice(0, 200) || 'DeepSeek 추출 공구',
      text: item.extraction.notes ?? item.extraction.url,
      seller_handle: item.extraction.seller?.replace(/^@/, '') ?? null,
      price_hint: null,
      price_raw: item.extraction.gonggu_price === '정보 없음' ? null : item.extraction.gonggu_price,
      captured_at: new Date().toISOString(),
    }),
  });
  const ingested = await ingest.json();
  candidateId = ingested?.data?.id;
  if (!candidateId) {
    const listed = await fetch(`${origin}/api/v1/admin/candidates?limit=1`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
    candidateId = listed?.data?.[0]?.id;
  }
}

if (!candidateId) {
  console.error('--candidate-id=... or --from-review-queue=path --line=0 required');
  process.exit(1);
}

const body = {
  action: 'promote',
  request_id: args['request-id'] ?? randomUUID(),
  promoted_by: args['promoted-by'] ?? 'cli',
  seller_id: args['seller-id'] || null,
  model_id: args['model-id'] || null,
  reason: args.reason ?? 'CLI promote after manual review',
};
if (args['bundle-json']) body.bundle_items = JSON.parse(readFileSync(args['bundle-json'], 'utf8'));

const res = await fetch(`${origin}/api/v1/admin/candidates/${encodeURIComponent(candidateId)}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await res.json();
if (!res.ok) {
  console.error(data);
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
