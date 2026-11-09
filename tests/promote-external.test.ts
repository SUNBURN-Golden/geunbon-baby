import { readFile, readdir } from 'node:fs/promises';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { handleApi } from '../lib/api';
import { detectSourceEnded, promoteExternalCandidate } from '../lib/promote-external';
import { dealTimingFor, isDealPubliclyActive } from '../lib/deals';
import { DealBundleList, DealDetail } from '../app/deals/_components';
import { dealsCopy } from '../lib/deals-copy';
import { memoryD1 } from './helpers/sqlite';
import type { DealWithContext } from '../lib/deals';

let memory: ReturnType<typeof memoryD1>;
async function migrate() {
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    for (const statement of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) {
      await memory.db.prepare(statement).run();
    }
  }
}

beforeEach(async () => {
  memory = memoryD1();
  await migrate();
  await memory.db.prepare("INSERT INTO sellers (id,name,source_url) VALUES ('seller-1','테스트 판매처','https://09pangpang.com/')").run();
  await memory.db.prepare("INSERT INTO models (id,brand,name,category,importer,official_price,source_url,checked,verify_level,note) VALUES ('model-joy','Joie','아이스핀','car_seat','Joie',NULL,'https://joiebaby.com/','2026-10-01','official_unpublished','')").run();
  await memory.db.prepare(`INSERT INTO external_candidates (id,source,source_url,title,text,seller_handle,seller_name,price_hint,price_raw,captured_at,last_seen_at)
    VALUES ('cand-1','pangpang','https://09pangpang.com/post/1001','조이 카시트 모음전','베베스완 외 6건 묶음', 'shop_a', '샵A', NULL, '정보 없음','2026-10-22T00:30:00.000Z','2026-10-22T09:30:00.000Z')`).run();
});

afterEach(() => memory.close());

describe('promoteExternalCandidate', () => {
  test('creates deal with null price and bundle items', async () => {
    const result = await promoteExternalCandidate(memory.db, {
      candidate_id: 'cand-1',
      promoted_by: 'test-admin',
      request_id: 'req-promote-001',
      reason: 'fixture promote after review',
      bundle_items: [
        { product_name: '조이 카시트', brand: 'Joie', model_id: 'model-joy', price: null },
        { product_name: '베베스완 외 6건', brand: null, price: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    const deal = await memory.db.prepare('SELECT * FROM deals WHERE id = ?').bind(result.deal_id).first<{ price: number | null; origin: string; model_id: string | null }>();
    expect(deal?.origin).toBe('external_web');
    expect(deal?.price).toBeNull();
    const bundle = await memory.db.prepare('SELECT COUNT(*) AS n FROM deal_bundle_items WHERE deal_id = ?').bind(result.deal_id).first<{ n: number }>();
    expect(bundle?.n).toBe(2);
    const audit = await memory.db.prepare('SELECT promoted_by FROM external_promotions WHERE candidate_id = ?').bind('cand-1').first<{ promoted_by: string }>();
    expect(audit?.promoted_by).toBe('test-admin');
  });

  test('idempotent on duplicate promote', async () => {
    const first = await promoteExternalCandidate(memory.db, { candidate_id: 'cand-1', promoted_by: 'a', request_id: 'req-1', reason: 'first promote call' });
    const second = await promoteExternalCandidate(memory.db, { candidate_id: 'cand-1', promoted_by: 'b', request_id: 'req-2', reason: 'duplicate attempt' });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.deal_id).toBe(second.deal_id);
      expect(second.created).toBe(false);
    }
  });

  test('ended source not counted active', () => {
    const deal = {
      starts_at: '2026-10-20T00:00:00Z',
      ends_at: null,
      source_ended: 1,
    };
    expect(isDealPubliclyActive(deal, Date.parse('2026-10-21T03:00:00Z'))).toBe(false);
    expect(dealTimingFor(deal, Date.parse('2026-10-21T03:00:00Z')).state).toBe('ended');
  });

  test('detectSourceEnded from text', () => {
    expect(detectSourceEnded({ text: '공구 종료', dates_raw: null, ends_at: null })).toBe(true);
  });
});

test('admin API promote route', async () => {
  const env = {
    DB: memory.db,
    ADMIN_TOKEN: 'fixture-admin-token-separation-0001',
    INGEST_TOKEN: 'fixture-ingest-token-separation-0002',
    COLLECTOR_STATUS_TOKEN: 'fixture-status-token-separation-0003',
  };
  const res = await handleApi(new Request('https://x/api/v1/admin/candidates/cand-1', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture-admin-token-separation-0001', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'promote', request_id: 'req-api-100', promoted_by: 'api-test', reason: 'API promote path test' }),
  }), ['admin', 'candidates', 'cand-1'], env as never);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { deal_id: string } };
  expect(body.data.deal_id).toBeTruthy();
});

test('bundle rendering on deal detail', () => {
  const deal: DealWithContext = {
    id: 'd1', model_id: null, seller_id: 'seller-1', title: '묶음 공구', price: null,
    source_url: 'https://09pangpang.com/post/1001', image_url: null, verify_level: 'manual', checked: '2026-10-22T00:00:00.000Z',
    starts_at: null, ends_at: null, origin: 'external_web', source_host: '09pangpang.com', source_ended: 0,
    brand_label: 'Joie', category_label: 'car_seat',
    model_joined_id: null, model_name: null, model_official_price: null, model_checked: null, model_verify_level: null,
    seller_joined_id: 'seller-1', seller_name: '샵A', seller_registration_source: null, seller_withdrawal_source: null, seller_official_import_source: null,
  };
  const html = renderToStaticMarkup(createElement(DealDetail, {
    deal,
    nowMs: Date.parse('2026-10-21T03:00:00Z'),
    bundleItems: [{ id: 'b1', deal_id: 'd1', position: 0, brand: 'Joie', product_name: '아이스핀', model_id: 'model-joy', price: null }],
  }));
  expect(html).toContain(dealsCopy.bundleHeading);
  expect(html).toContain(dealsCopy.unknownGongguPrice);
  expect(html).toContain(dealsCopy.externalDisclaimer);
  expect(html).toContain('/models/model-joy');
});
