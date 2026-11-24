import { assessPriceEvidence, displayExclusion, filterOfferCapture, identityToken, isOfficialPriceScope, parsePriceEvidence, type OfficialPriceScope, type PriceEvidence } from '../../../shared/deal-price-evidence';
import { capturedRound } from '../../../shared/offer-round';
import { createPriceVerifier, type PriceCompletion } from '../deal-prices/verify';
import { readQueuePrices } from '../deal-prices/review-sidecar';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { canonicalUrl, filterText, sanitizeValue } from '../../../shared/privacy-rules';
import { hashJson } from '../../../shared/official-seller';
import { readQueue } from '../deepseek-web/review-queue';
import { reviewBundleItems, reviewPromotionFacts } from '../../../scripts/review-facts';
import type { RawStore } from '../../engine/raw-store';

type Row = Record<string, string | number | null>;
type Manifest = { generation: number; totals: Record<string, number> };
export type Inventory = { manifest: Manifest; rows: Record<string, Row[]> };
type State = 'linked' | 'newly_accepted' | 'held' | 'excluded' | 'unavailable';
export type Input = { source: string; id: string; state: State; reason: string; campaign_id?: string; url?: string;
  related?: string[]; proof?: PriceEvidence; locator?: string; preceding_observation?: string | null; reference?: { namespace: string; record_key: string; revision_key: string; item_key: string;
    source_url: string; observed_at: string | null; precision: 'instant' | 'day' | null }; checked?: unknown };

export type FetchInventory = (params: URLSearchParams) => Promise<unknown>;
export async function fetchInventory(get: FetchInventory): Promise<Inventory> {
  const manifest = await get(new URLSearchParams()) as Manifest;
  if (!Number.isSafeInteger(manifest?.generation) || !manifest.totals) throw new Error('inventory_invalid');
  const rows: Record<string, Row[]> = {};
  for (const [type, total] of Object.entries(manifest.totals)) {
    if (!/^[a-z_]+$/.test(type) || !Number.isSafeInteger(total) || total < 0) throw new Error('inventory_invalid');
    const data: Row[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const p = new URLSearchParams({ generation: String(manifest.generation), type, limit: '50' });
      if (cursor) p.set('cursor', cursor);
      const page = await get(p) as { generation: number; type: string; data: Row[]; next_cursor: string | null };
      if (page.generation !== manifest.generation || page.type !== type || !Array.isArray(page.data) || page.data.length > 50) throw new Error('inventory_invalid');
      data.push(...page.data);
      cursor = page.next_cursor;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || cursors.has(cursor) || !page.data.length) throw new Error('inventory_invalid');
        cursors.add(cursor);
      }
      if (data.length > total) throw new Error('inventory_count');
    } while (cursor !== null);
    if (data.length !== total) throw new Error('inventory_count');
    rows[type] = data;
  }
  const final = await get(new URLSearchParams()) as Manifest;
  if (final.generation !== manifest.generation) throw new Error('inventory_changed');
  return { manifest, rows };
}

function url(value: unknown) {
  try {
    if (typeof value === 'string') { canonicalUrl(value); return new URL(value).href; }
  } catch { /* report unavailable */ }
}
function date(value: unknown): { observed_at: string | null; precision: 'day' | 'instant' | null } {
  if (typeof value !== 'string') return { observed_at: null, precision: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().startsWith(value)) return { observed_at: value, precision: 'day' };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))) return { observed_at: new Date(value).toISOString(), precision: 'instant' };
  return { observed_at: null, precision: null };
}
function reference(namespace: string, record_key: string, revision_key: string, source_url: string, time: unknown) {
  return { namespace, record_key, revision_key, item_key: 'parent', source_url, ...date(time) };
}
function pending(source: string, id: string, sourceUrl: string | undefined, ref?: Input['reference']): Input {
  return { source, id, state: sourceUrl ? 'held' : 'unavailable', reason: sourceUrl ? 'historical_proof_required' : 'unsafe_or_missing_source',
    ...(sourceUrl ? { url: sourceUrl, reference: ref } : {}) };
}
function excluded(entry: Input, reason: string): Input { return { ...entry, state: 'excluded', reason }; }
function unavailable(entry: Input, reason: string): Input { return { ...entry, state: 'unavailable', reason }; }

export function collectorSnapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x => x.name));
    const read = (name: string, projection: string, order = 'id') => tables.has(name) ?
      db.prepare(`SELECT ${projection} FROM ${name} ORDER BY ${order}`).all() as Row[] : null;
    const result = {
      records: read('collection_records', 'id,url,group_id,status,data'),
      groups: read('dedup_groups', 'id,data'),
      assertions: read('evidence_assertions', 'id,record_id,data'),
      reviews: read('review_events', "id,json_extract(data,'$.group_id') AS group_id,json_extract(data,'$.decision') AS decision"),
      captures: read('engine_captures', "id,source_id,url_norm,fetched_at,status,content_hash,prev_capture_id,raw_ref IS NOT NULL AS retained,json_extract(data,'$.artifact_hash') AS artifact_hash"),
      facts: read('engine_extracted', "id,capture_id,field,effective_from,effective_from_basis,fact_status,json_extract(data,'$.value') AS value"),
      links: read('extracted_assertion_links', 'assertion_id,extracted_id', 'assertion_id,extracted_id'),
      offers: read('offer_identity','id,deal_id,revision,published_version'),
      offer_revisions: read('offer_product_revisions','id,offer_id,url,locator,observed_at,content_digest,failures'),
      offer_aliases: read('offer_alias','key AS id,offer_id','key'),
      offer_provenance: read('offer_provenance','json_array(offer_id,url,locator) AS id,offer_id,url,locator','offer_id,url,locator'),
      offer_receipts: read('offer_outbox','request_id AS id,offer_id,revision,state,candidate_id,body,receipt','request_id'),
    };
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
type LocalSnapshot = ReturnType<typeof collectorSnapshot>;
type Artifacts = { store: RawStore; permitted: ReadonlySet<string>; maxAgeMs: number; now?: number; complete?: PriceCompletion };
type Artifact = { failure: string } | { text: string; hash: string };
function readArtifact(capture: Row, artifacts?: Artifacts): Artifact {
  if (['restricted','blocked','skipped_policy'].includes(String(capture.status))) return { failure:'restricted' };
  if (capture.status === 'http_error') return { failure:'capture_failed' };
  if (typeof capture.artifact_hash !== 'string') return { failure: capture.retained ? 'missing_artifact_hash' : 'artifact_not_retained' };
  if (!artifacts || !artifacts.permitted.has(String(capture.source_id))) return { failure:'artifact_access_unavailable' };
  if (!/^[a-f0-9]{64}$/.test(capture.artifact_hash)) return { failure:'artifact_corrupt' };
  const now = artifacts.now ?? Date.now();
  const captured = Date.parse(String(capture.fetched_at));
  if (!Number.isFinite(captured) || captured > now || now-captured > artifacts.maxAgeMs) return { failure:'artifact_expired' };
  try {
    const path = artifacts.store.path(capture.artifact_hash);
    const bytes = artifacts.store.readArtifact(capture.artifact_hash);
    if (!bytes) return { failure:'artifact_missing_or_expired' };
    if (now-statSync(path).mtimeMs > artifacts.maxAgeMs) return { failure:'artifact_expired' };
    if (bytes.length > 80_000) return { failure:'artifact_too_large' };
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes).split(/\r?\n/u)
      .map(line => filterText(line,20_000)).filter(Boolean).join('\n');
    return text ? { text, hash:capture.artifact_hash } : { failure:'artifact_empty_after_filter' };
  } catch { return { failure:'artifact_corrupt' }; }
}
function rawRegions(text: string) {
  const lines = text.split('\n');
  const boundaries = lines.flatMap((line,index) => /^(?:\[상품\]|\[항목\])/u.test(line) ? [index] : []);
  const starts = boundaries.length ? boundaries : [0];
  return starts.flatMap((start,index) => {
    const region = filterOfferCapture(lines.slice(start,starts[index+1]).join('\n'));
    return region && /(?:공구가|공동구매가)/u.test(region) ? [{locator:`line:${start+1}`,text:region}] : [];
  });
}
function authority(rows: Row[]) {
  return rows.flatMap(row => {
    try { return (JSON.parse(String(row.scopes)) as unknown[]).filter(isOfficialPriceScope); } catch { return []; }
  });
}
function rawOfficial(offer: {url:string;at:string;text:string}, candidates: Row[], scopes: OfficialPriceScope[], artifacts: Artifacts) {
  const brand = identityToken(offer.text.match(/^브랜드\s*[:：]\s*(.+)$/mu)?.[1] ?? '');
  const model = identityToken(offer.text.match(/^모델\s*[:：]\s*(.+)$/mu)?.[1] ?? '');
  if (!brand || !model) return [];
  return candidates.flatMap(row => {
    const url = String(row.url_norm), observedAt = String(row.fetched_at);
    const matching = scopes.filter(s => s.url===url && s.brand===brand && s.model===model && s.approved_at<=observedAt
      && s.expires_at>observedAt && s.expires_at>offer.at);
    if (!matching.length || url===offer.url || Math.abs(Date.parse(offer.at)-Date.parse(observedAt))>=86_400_000) return [];
    const artifact = readArtifact(row,artifacts);
    if ('failure' in artifact) return [];
    const text = filterOfferCapture(artifact.text);
    return matching.map(scope => ({ url,text,observedAt,approval:{id:scope.id,revision:scope.revision,
      ...(scope.variant ? {variant:scope.variant} : {})},approvedAt:scope.approved_at }));
  });
}
function parse(value: Row['data']): Record<string, unknown> {
  try { return value && typeof value === 'string' ? JSON.parse(value) : {}; } catch { return {}; }
}
const safeValue = (v: unknown) => { try { return sanitizeValue(v); } catch { return null; } };
function indexed<T>(values: T[], key: (v: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const value of values) {
    const name = key(value), rows = index.get(name) ?? [];
    rows.push(value); index.set(name, rows);
  }
  return index;
}
// Only rows that can represent a source record or identity reference are
// reported as inputs. Derived state (observations, offer membership, evidence
// heads, receipts) is read below for qualification and must not inflate the
// per-source totals with held/unavailable entries.
const inputTables = new Set([
  'deals', 'ingested_items', 'external_candidates', 'external_occurrence_observations', 'seller_campaigns',
]);
export async function reconcileHistory(site: Inventory, queueDir: string | null, local: LocalSnapshot | null, artifacts?: Artifacts,
  loadProof?: (id:string) => Promise<unknown>) {
  const all: Input[] = [];
  const rows = site.rows;
  const byDeal = new Map((rows.campaign_deals ?? []).map(r => [String(r.deal_id), String(r.campaign_id)]));
  const deals = new Map((rows.deals ?? []).map(r => [String(r.id), r]));
  const promotions = new Map((rows.external_promotions ?? []).map(r => [String(r.candidate_id), String(r.deal_id)]));
  const candidates = new Map((rows.external_candidates ?? []).map(r => [String(r.id), r]));
  const observed = indexed(rows.campaign_observations ?? [], r => JSON.stringify([r.namespace,r.record_key,r.revision_key,r.item_key]));
  const rounds = new Map((rows.seller_campaigns ?? []).filter(row => !row.merged_into).map(r => [String(r.id),r]));
  const accepted = new Set((rows.campaign_observations ?? []).filter(row => !row.retracted_by).map(row => String(row.campaign_id)));
  // A retraction removes the affected public facts while keeping the audit
  // trail. Reconcile must not read the surviving published deal as a missing
  // membership and re-import the retracted price under a new observation key.
  const proofSupport = (retracted: boolean) => new Set((rows.campaign_observations ?? [])
    .filter(row => !!row.retracted_by === retracted && row.proof_id != null)
    .map(row => JSON.stringify([String(row.campaign_id), String(row.proof_id)])));
  const retractedProofs = proofSupport(true), acceptedProofs = proofSupport(false);
  const campaignFor = (id?: string) => id ? byDeal.get(id) ?? (rounds.has(id) ? id : undefined) : undefined;
  const live = (id: string) => accepted.has(id);
  const assigned = (entry: Input) => {
    if (!entry.reference || entry.state !== 'held') return entry;
    const r = entry.reference;
    const prior = observed.get(JSON.stringify([r.namespace,r.record_key,r.revision_key,r.item_key]))?.[0];
    if (!prior) return entry;
    if (prior.retracted_by) return excluded(entry,'retracted');
    const id = String(prior.campaign_id);
    return live(id) ? { ...entry, state:'linked' as const, campaign_id: id, reason:'assigned_observation' } : entry;
  };
  for (const [table, values] of Object.entries(rows)) {
    if (!inputTables.has(table)) continue;
    for (const row of values) {
      const id = String(row.id ?? row.deal_id ?? row.digest ?? row.candidate_id);
      const u = url(row.source_url ?? row.evidence_url);
      const newSource = table === 'ingested_items' ? 'site-ingest' : table === 'external_candidates' ? 'site-external' : null;
      let entry = pending(`d1:${table}`, id, u, u && newSource ? reference(newSource,id,String(row.price_revision ?? row.captured_at),u,row.last_seen_at ?? row.captured_at) : undefined);
      const candidate = table === 'external_candidates' ? promotions.get(id) ?? (row.promoted_deal_id ? String(row.promoted_deal_id) : undefined) : undefined;
      const direct = table === 'deals' || table === 'ingested_items' ? id :
        candidate ?? (row.campaign_id ? String(row.campaign_id) : row.deal_id ? String(row.deal_id) : table === 'seller_campaigns' ? id :
          table === 'external_occurrence_observations' ? promotions.get(String(row.candidate_id)) : undefined);
      const canonical = campaignFor(direct);
      const membership = table === 'deals' ? byDeal.get(id) : undefined;
      const proofKey = membership && row.price_evidence_id != null ?
        JSON.stringify([membership, String(row.price_evidence_id)]) : null;
      // A membership without any accepted observation, or a deal whose own
      // current proof was retracted, is inactive history, not an unmapped row.
      const retractedDeal = table === 'deals' && row.status === 'published' && membership !== undefined &&
        (!live(membership) || proofKey !== null && retractedProofs.has(proofKey) && !acceptedProofs.has(proofKey));
      if (['rejected','dismissed','withdrawn','revoked','superseded'].includes(String(row.status ?? row.state ?? row.disposition))) {
        entry = excluded(entry, String(row.status ?? row.state ?? row.disposition));
      } else if (retractedDeal) {
        entry = excluded(entry, 'retracted_history_membership');
      } else if (canonical && live(canonical)) {
        entry = { ...entry, state:'linked', reason:'site_identity', campaign_id:canonical };
      } else if (direct && deals.get(direct)?.status === 'withdrawn') entry = excluded(entry,'withdrawn');
      else if (table === 'deals' && row.status === 'published') {
        entry = { ...entry, state:'held',reason:'missing_history_membership' };
        if (loadProof && typeof row.price_evidence_id === 'string') {
          const proof = await parsePriceEvidence(await loadProof(row.price_evidence_id),!!row.verified_offer_id);
          if (proof?.offer && proof.official && assessPriceEvidence(proof).facts) {
            entry = { ...entry, proof,locator:'publication:' + row.price_evidence_id,
              reference:reference('site-deal',id,String(row.version),proof.offer_url,proof.offer.source.observed_at) };
          }
        }
      }
      else if (table === 'external_occurrence_observations' && candidates.get(String(row.candidate_id))?.status === 'dismissed') {
        entry = excluded(entry, 'dismissed');
      }
      all.push(assigned(entry));
    }
  }
  if (!queueDir) all.push({ source:'queue', id:'inventory', state:'unavailable', reason:'queue_not_supplied' });
  else {
    try {
      // readQueue returns the complete validated chain, including predecessors.
      const queue = await readQueue(queueDir);
      for (const item of queue) {
        const u = url(item.extraction.url);
        const time = item.revision?.observed_at ?? item.extraction.fact_check?.observed_at ?? item.extraction.checked_date;
        const entry = pending('queue',item.id,u,u ? reference('review-queue',item.id,item.revision?.content_hash ?? 'legacy',u,time) : undefined);
        all.push(item.status === 'rejected' ? excluded({...entry,preceding_observation:item.revision?.prior_revision_id ?? null},'rejected') : assigned({
          ...entry, checked: { ...reviewPromotionFacts(item.extraction), lines: reviewBundleItems(item.extraction).map(line =>
            ({ ...line, product_name: filterText(line.product_name,200), brand: line.brand ? filterText(line.brand,100) : null })),
          preceding_observation:item.revision?.prior_revision_id ?? null,
          proof:await readQueuePrices(queueDir,item).catch(() => null) ?? undefined,
          locator:'queue:' + item.id },
        }));
      }
    } catch { all.push({ source:'queue', id:'inventory', state:'unavailable', reason:'queue_invalid' }); }
  }
  const collectorTables = ['records','groups','assertions','reviews','captures','facts','links','offers',
    'offer_revisions','offer_aliases','offer_provenance','offer_receipts'] as const;
  for (const name of collectorTables) if (!local?.[name]) all.push({
    source:`collector:${name}`, id:'inventory', state:'unavailable', reason:'snapshot_table_unavailable',
  });
  if (local) {
    const localRecords = new Map<string, Input>(), captures = new Map<string, Input>();
    const groups = new Map((local.groups ?? []).map(g => [String(g.id),parse(g.data)]));
    for (const r of local.records ?? []) {
      const id = String(r.id), data = parse(r.data), u = url(r.url);
      const item = pending('collector:records',id,u,u ? reference('collector',id,String(data.record_version ?? 'legacy'),u,data.last_checked_at ?? data.collected_at) : undefined);
      const group = groups.get(String(r.group_id));
      const entry = data.identity_quarantined === true || r.status === 'dedup_excluded' ? excluded(item,'identity_quarantined_or_dedup_excluded') :
        data.conflict_detected === true || group?.unresolved_conflicts ? { ...item, reason:'conflicting_input' } : assigned(item);
      all.push(entry); localRecords.set(id,entry);
    }
    for (const c of local.captures ?? []) {
      const id = String(c.id), u = url(c.url_norm);
      const item = pending('collector:captures',id,u,u ? reference('collector',id,String(c.content_hash ?? 'legacy'),u,c.fetched_at) : undefined);
      const artifact = readArtifact(c,artifacts);
      const entry = 'failure' in artifact ? unavailable(item,artifact.failure) : assigned(item);
      all.push(entry); captures.set(id,entry);
      if ('text' in artifact && u && item.reference?.observed_at && entry.state==='held') {
        const at = item.reference.observed_at;
        for (const region of rawRegions(artifact.text)) {
          const matched = artifacts?.complete ? rawOfficial({url:u,at,text:region.text},local.captures ?? [],
            authority(rows.history_price_authority ?? []),artifacts) : [];
          const verifier = artifacts?.complete ? createPriceVerifier({
            complete:artifacts.complete, offerUrls:true,
            official:async () => matched.length === 1 ? matched[0] : null,
          }) : null;
          const proof = verifier && matched.length===1 ? await verifier(u,region.text,at) : null;
          all.push({ ...entry,id:`${id}:${region.locator}`,reference:{...item.reference,item_key:region.locator},
            checked:{ capture_hash:artifact.hash,locator:region.locator,source_url:u,captured_at:at },
            locator:region.locator,proof:proof ?? undefined,reason:proof ? assessPriceEvidence(proof).outcome : 'no_contemporaneous_official_capture' });
        }
      }
    }
    const collectedOffers = new Map<string, Input>();
    for (const r of local.offer_receipts ?? []) {
      const id = String(r.id), payload = parse(r.body), receipt = parse(r.receipt);
      const proof = await parsePriceEvidence(payload.price_evidence,true);
      const linked = campaignFor(String(receipt.deal_id ?? ''));
      const entry = pending('collector:offer_receipts',id,url(proof?.offer_url),proof?.offer ?
        reference('collector',id,String(r.revision),proof.offer_url,proof.offer.source.observed_at) : undefined);
      const item = r.state==='cancelled' ? excluded(entry,'outbox_cancelled') :
        r.state==='acked' && linked && live(linked) ? {...entry,state:'linked' as const,reason:'site_publication_receipt',campaign_id:linked} :
          assigned({...entry,proof:proof ?? undefined,locator:String(payload.locator ?? 'offer:' + id)});
      all.push(item);
      collectedOffers.set(String(r.offer_id),item);
    }
    for (const table of ['offers','offer_revisions','offer_aliases','offer_provenance'] as const) {
      for (const r of local[table] ?? []) {
        const entry = pending(`collector:${table}`,String(r.id),url(r.url));
        const offer = collectedOffers.get(String(r.offer_id ?? r.id));
        all.push(offer?.state==='linked' ? {...entry,state:'linked',reason:'site_publication_receipt',campaign_id:offer.campaign_id} : entry);
      }
    }
    const inherit = (source: string, id: string, parent: Input | undefined, checked?: unknown) => {
      if (!parent) return unavailable(pending(source,id,undefined),'unlinked_local_reference');
      return { source, id, state:parent.state, reason:parent.reason, campaign_id:parent.campaign_id, checked };
    };
    const facts = new Map<string, Input>();
    for (const f of local.facts ?? []) {
      const e = inherit('collector:facts',String(f.id),captures.get(String(f.capture_id)),
        f.fact_status === 'verified' ? { field: f.field, value: safeValue(f.value), effective_from: f.effective_from,
          effective_from_basis:f.effective_from_basis, captured_fact_id:f.id } : undefined);
      facts.set(e.id,e); all.push(e);
    }
    const assertions = new Map<string, Input>();
    for (const a of local.assertions ?? []) {
      const data = parse(a.data);
      const e = inherit('collector:assertions',String(a.id),localRecords.get(String(a.record_id)),
        data.level === 'authorized' ? { field:data.field, value:safeValue(data.value), observed_at:data.observed_at } : undefined);
      const item = data.withdrawn || data.superseded_by ? excluded(e,'withdrawn_or_superseded') : e;
      assertions.set(item.id,item); all.push(item);
    }
    const groupMembers = indexed(local.records ?? [], r => String(r.group_id));
    const member = (id: string) => localRecords.get(String(groupMembers.get(id)?.[0]?.id));
    for (const g of local.groups ?? []) all.push(inherit('collector:groups',String(g.id),member(String(g.id))));
    for (const r of local.reviews ?? []) all.push(inherit('collector:reviews',String(r.id),member(String(r.group_id))));
    for (const l of local.links ?? []) {
      const e = inherit('collector:links',`${l.assertion_id}:${l.extracted_id}`,assertions.get(String(l.assertion_id)));
      const f = facts.get(String(l.extracted_id));
      all.push(f?.state === 'unavailable' ? unavailable(e,f.reason) : e);
    }
  }
  const byURL = indexed(all.filter(x => x.url), x => {
    try { return canonicalUrl(x.url!); } catch { return x.url!; }
  });
  for (const matches of byURL.values()) {
    if (matches.length < 2) continue;
    const identities = [...new Set(matches.flatMap(m => m.campaign_id ? [m.campaign_id] : []))];
    for (const m of matches) if (m.state === 'held' && m.reason==='historical_proof_required' && identities.length) {
      m.reason = identities.length > 1 ? 'conflicting_campaigns_at_url' : 'reused_url_review';
      m.related = identities;
    }
  }
  const reconcileVersion = 1;
  const totals: Record<string, Partial<Record<State, number>>> = {};
  for (const item of all) {
    const counts = totals[item.source] ??= {};
    counts[item.state] = (counts[item.state] ?? 0) + 1;
  }
  const operations = await planImports(all,rows);
  const inputs = all.map(({proof,...item}) => { void proof; return item; });
  return { version: reconcileVersion, inventory_generation: site.manifest.generation, distinct_published_campaigns:
    accepted.size, totals, digest:await hashJson([reconcileVersion,site.manifest,inputs]), inputs, packet:{version:1,operations} };
}

async function planImports(inputs: Input[], rows: Inventory['rows']) {
  const operations = [];
  const aliases = rows.seller_identity_aliases ?? [];
  const deals = new Map((rows.deals ?? []).map(d => [String(d.id),d]));
  const memberships = new Map((rows.campaign_deals ?? []).map(r => [String(r.deal_id), String(r.campaign_id)]));
  // Never re-admit a price whose observation was retracted for this deal.
  const proofSupport = (retracted: boolean) => new Set((rows.campaign_observations ?? [])
    .filter(row => !!row.retracted_by === retracted && row.proof_id != null)
    .map(row => JSON.stringify([String(row.campaign_id), String(row.proof_id)])));
  const retractedProofs = proofSupport(true), acceptedProofs = proofSupport(false);
  for (const entry of inputs) {
    const proof = entry.proof, source = entry.reference, locator = entry.locator;
    if (entry.state!=='held' || !proof?.offer || !source || !locator) continue;
    const facts = assessPriceEvidence(proof).facts;
    if (!facts || displayExclusion(facts.deal_price_krw,facts.list_price_krw)) continue;
    const deal = source.namespace==='site-deal' ? deals.get(source.record_key) : undefined;
    const campaign = deal ? memberships.get(String(deal.id)) : undefined;
    const proofKey = campaign && deal?.price_evidence_id != null ?
      JSON.stringify([campaign, String(deal.price_evidence_id)]) : null;
    if (proofKey !== null && retractedProofs.has(proofKey) && !acceptedProofs.has(proofKey)) continue;
    const matches = aliases.filter(a => a.source_url && (deal ? a.seller_id===deal.seller_id : proof.offer!.source.text.includes(String(a.source_url))));
    if (matches.length!==1 || !deal && !capturedRound(proof.offer.source.text,source.source_url,locator)) continue;
    const models = (rows.models ?? []).filter(m => deal ? m.id===deal.model_id :
      identityToken(String(m.brand))===identityToken(facts.configuration.brand) &&
      identityToken(String(m.name))===identityToken(facts.configuration.model));
    if (models.length!==1) continue;
    const item = {
      observation:{...source,...date(proof.offer.source.observed_at)}, seller_id:matches[0].seller_id, seller_url:matches[0].source_url,
      model_id:models[0].id,title:`${models[0].brand} ${models[0].name}`,locator,price_evidence:proof,
      ...(deal ? {deal_id:deal.id,expected_version:deal.version,proof_id:deal.price_evidence_id} : {}),
    };
    operations.push({ request_id:await hashJson(item),source:entry.source,input_id:entry.id,
      reason:'Historical observation with bound source and prices', items:[item] });
    entry.reason='qualified_for_import';
  }
  return operations;
}
