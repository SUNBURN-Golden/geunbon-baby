import { canonicalJson, reject, safeSource, statement } from './history-review';

const sources = {
  ingested_items: ['id', 'id,source_url,kind,captured_at,status,reviewed_at,attribution'],
  external_candidates: ['id', 'id,source,source_url,starts_at,ends_at,captured_at,last_seen_at,status,reviewed_at,promoted_deal_id,price_revision'],
  deals: ['id', 'id,model_id,seller_id,deal_price_krw,list_price_krw,price_evidence_id,source_url,starts_at,ends_at,status,version,origin,external_candidate_id,source_ended,verified_offer_id'],
  external_promotions: ['id', 'id,candidate_id,deal_id,source_url,promoted_at,request_id,request_hash'],
  deal_revisions: ['id', 'id,deal_id,version,action,request_hash,model_id,seller_id,price,ends_at,status,created_at,price_evidence_id'],
  deal_bundle_items: ['id', 'id,deal_id,position,brand,product_name,model_id,price'],
  sellers: ['id', 'id,name,handle,source_url'],
  seller_identity_aliases: ["json_array(platform,identity)", 'platform,identity,seller_id,source_url,evidence_ref'],
  seller_handle_aliases: ['handle','handle,seller_id'],
  seller_identity_redirects: ['seller_id','seller_id,canonical_id'],
  models: ['id', 'id,brand,name,category'],
  seller_campaigns: ['id', 'id,seller_id,source_url,evidence_ref,starts_at,version,merged_into'],
  campaign_deals: ['deal_id', 'deal_id,campaign_id'],
  campaign_observations: ['id', 'id,namespace,record_key,revision_key,item_key,source_url,observed_at,precision,campaign_id,proof_id,retracted_by'],
  campaign_offers: ['id', 'id,campaign_id,deal_id,line_id,model_id,configuration_key,scope,closed_at'],
  offer_price_observations: ['id', 'id,campaign_id,offer_id,amount,list_amount,point_time,ends_at,proof_id,approval_id,approval_revision'],
  history_reconciliation: ["json_array(namespace,record_key)", 'namespace,record_key,reason'],
  official_attestations: ['digest', 'digest,key_id,seller_id,brand_id,campaign_id,evidence_url'],
  official_approvals: ['digest', 'digest,state,decided_at'],
  history_operations: ['id','id,action,namespace,record_key,revision_key,item_key,deal_id,deal_version,proof_id'],
  history_receipts: ['id', 'id,digest,result,created_at'],
  deal_price_evidence: ['id','id,target_kind,target_id,target_revision,outcome,observed_at,created_at'],
  history_price_authority: ['observed_at','observed_at,scopes'],
  deal_price_evidence_heads: ["json_array(target_kind,target_id,target_revision)",'target_kind,target_id,target_revision,evidence_id'],
  verified_offer_candidates: ['id','id,revision,digest,state,checked_at,deal_id'],
  verified_offer_evidence: ["json_array(candidate_id,revision)",'candidate_id,revision,digest,offer_key,campaign_key,source_url,locator'],
  verified_offer_aliases: ['offer_key','offer_key,candidate_id'],
  verified_offer_provenance: ["json_array(candidate_id,source_url,locator)",'candidate_id,source_url,locator,observed_at'],
  verified_offer_operations: ['request_id','request_id,request_hash,action,candidate_id,revision,digest,deal_id,expected_version,committed_at'],
  verified_offer_receipts: ['request_id','request_id,deal_id,committed_revision'],
} as const;
type Source = keyof typeof sources;
type InventoryRow = Record<string, string | number | null>;
const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(canonicalJson(value)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function decode(value: string): unknown {
  if (value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) return reject('inventory_cursor');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))); }
  catch { return reject('inventory_cursor'); }
}
function publicSource(value: string) {
  try {
    const url = new URL(safeSource(value));
    const parameters = url.searchParams;
    for (const name of [...parameters.keys()]) {
      if (!['id', 'p', 'page', 'lang', 'recallid', 'format', 'productname', 'title', 'source'].includes(name) ||
          parameters.getAll(name).length !== 1 || !/^[a-zA-Z0-9_.-]{1,60}$/.test(parameters.get(name)!)) parameters.delete(name);
    }
    return url.href;
  } catch { return null; }
}
export async function inventory(db: D1Database, params: URLSearchParams) {
  if (['type', 'generation', 'cursor', 'limit'].some(name => params.getAll(name).length > 1)) reject('inventory_cursor');
  const type = params.get('type');
  const rawCursor = params.get('cursor');
  if (!type) {
    if (params.size) reject('inventory_cursor');
    const row = await db.prepare(`SELECT generation,${Object.keys(sources).map(t => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(',')} FROM history_generation WHERE id=1`).first<Record<string, number>>();
    if (!row) return reject('inventory_unavailable', 503);
    const { generation, ...totals } = row;
    return { generation, totals };
  }
  if (!Object.hasOwn(sources, type)) return reject('inventory_type');
  const generation = Number(params.get('generation'));
  const size = params.get('limit') ?? '30';
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(size) || !Number.isSafeInteger(generation) || generation < 1) return reject('inventory_cursor');
  let anchor = '';
  if (rawCursor !== null) {
    const cursor = decode(rawCursor);
    if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== generation || cursor[1] !== type ||
        typeof cursor[2] !== 'string' || !cursor[2] || cursor[2].length > 4096 || encode(cursor) !== rawCursor) return reject('inventory_cursor');
    anchor = cursor[2];
  }
  const [id, cols] = sources[type as Source];
  const limit = Number(size);
  const sql = `SELECT g.generation AS inventory_generation,p.* FROM history_generation g LEFT JOIN
    (SELECT ${id} AS inventory_key,${cols} FROM ${type} WHERE ${id}>? ORDER BY ${id} LIMIT ?) p ON g.generation=? WHERE g.id=1 ORDER BY p.inventory_key`;
  const { results } = await statement(db, sql, anchor, limit + 1, generation).all<InventoryRow>();
  if (results[0]?.inventory_generation !== generation) return reject('inventory_changed', 409);
  const data = results.filter(row => row.inventory_key !== null).slice(0, limit).map(sourceRow => {
    const row = { ...sourceRow };
    delete row.inventory_generation;
    delete row.inventory_key;
    for (const field of ['source_url', 'evidence_url']) if (typeof row[field] === 'string') row[field] = publicSource(row[field]);
    return row;
  });
  return { generation, type, data, next_cursor: results.length > limit ? encode([generation, type, results[limit-1].inventory_key]) : null };
}
