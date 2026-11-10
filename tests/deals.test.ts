import { readdir, readFile } from 'node:fs/promises';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DEAL_SELECT, dealTiming, formatDealDate, formatGap, priceGap, sortDeals, type DealWithContext } from '../lib/deals';
import { dealsCopy } from '../lib/deals-copy';
import { DealActions, DealCard, DealCardLinks, DealDetail, DealList, DealStateChip, PriceGap } from '../app/deals/_components';
import DealNotFound from '../app/deals/[id]/not-found';
import DealsPage, { dynamic as listDynamic } from '../app/deals/page';
import DealDetailPage, { dynamic as detailDynamic } from '../app/deals/[id]/page';
import { all } from '../lib/db';
import { memoryD1 } from './helpers/sqlite';
import Layout from '../app/layout';
import { siteCopy } from '../lib/site-copy';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  usePathname: () => '/deals',
  useSearchParams: () => new URLSearchParams(),
}));

const nowMs = Date.parse('2026-10-21T03:00:00Z');
// Extra legacy fields must never reach the UI, even if supplied by a caller.
const fixture: DealWithContext & { model_note: string } = {
  id: 'deal-1', model_id: 'model-1', seller_id: 'seller-1', title: 'A carefully checked deal',
  image_url: null, price: 390000, source_url: 'https://www.instagram.com/p/example/',
  verify_level: 'manual', checked: '2026-10-20T16:00:00Z',
  starts_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-22T14:59:59Z',
  model_joined_id: 'model-1', model_name: 'Example model', model_official_price: 430000,
  model_checked: '2026-10-18', model_verify_level: 'page_body', model_note: 'Other retailer: 123,456 KRW; used: 98,765 KRW.',
  seller_joined_id: 'seller-1', seller_name: 'Example seller',
  seller_registration_source: null, seller_withdrawal_source: null, seller_official_import_source: null,
};
const card = (patch: Partial<DealWithContext> = {}) => renderToStaticMarkup(createElement(DealCard, { deal: { ...fixture, ...patch }, nowMs }));
const detail = (patch: Partial<DealWithContext> = {}) => renderToStaticMarkup(createElement(DealDetail, { deal: { ...fixture, ...patch }, nowMs }));

test.each(['page_text', 'search_summary'])('deal cards and details hide %s prices and all comparisons', model_verify_level => {
  for (const render of [card, detail]) {
    const html = render({ model_verify_level });
    expect(html).toContain(dealsCopy.unknownOfficial);
    expect(html).not.toContain('430,000');
    expect(html).not.toContain('class="deal-gap');
    expect(html).not.toContain('class="deal-tone');
    expect(html).toContain('390,000');
  }
  const html = detail({ model_verify_level });
  expect(html).toContain(dealsCopy.officialEvidence);
  expect(html).not.toContain(dealsCopy.officialChecked);
  expect(html).toContain('2026.10.18');
  expect(html).toContain(model_verify_level === 'page_text' ? dealsCopy.pageText : dealsCopy.searchSummary);
});

test.each(['page_text', 'search_summary'])('PriceGap gates %s prices even when a caller supplies a gap', model_verify_level => {
  const html = renderToStaticMarkup(createElement(PriceGap, {
    deal: { ...fixture, model_verify_level }, gap: priceGap(400000, 430000),
  }));
  expect(html).toContain(dealsCopy.unknownOfficial);
  expect(html).not.toContain('430,000');
  expect(html).not.toContain('class="deal-gap');
});

describe('price comparisons', () => {
  test.each([
    [null, 100], [100, null], [0, 0], [100, -1], [-1, 100],
    [NaN, 100], [100, NaN], [Infinity, 100], [100, Infinity],
  ])('rejects missing or invalid prices (%s, %s)', (price, official) => {
    expect(priceGap(price, official)).toBeNull();
  });

  test('preserves zero, direction and signed arithmetic', () => {
    expect(priceGap(0, 100)).toEqual({ relation: 'below', won: 100, percent: 100 });
    expect(priceGap(80, 100)).toEqual({ relation: 'below', won: 20, percent: 20 });
    expect(priceGap(100, 100)).toEqual({ relation: 'equal', won: 0, percent: 0 });
    expect(priceGap(120, 100)).toEqual({ relation: 'above', won: -20, percent: -20 });
  });

  test('formats absolute differences, one decimal and tiny nonzero percentages', () => {
    expect(formatGap(priceGap(87654, 100000)!)).toBe(dealsCopy.below.replace('{percent}', '12.3').replace('{won}', '12,346'));
    expect(formatGap(priceGap(123456, 100000)!)).toBe(dealsCopy.above.replace('{percent}', '23.5').replace('{won}', '23,456'));
    expect(formatGap(priceGap(100, 100)!)).toBe(dealsCopy.equal);
    for (const price of [99999, 100001]) {
      expect(formatGap(priceGap(price, 100000)!)).toContain('<0.1%');
      expect(formatGap(priceGap(price, 100000)!)).not.toContain('-');
    }
    expect(formatGap(priceGap(99900, 100000)!)).toContain('0.1%');
    expect(formatGap(priceGap(0, 100000)!)).toContain('100.0%');
  });
});

describe('schedule and ordering', () => {
  const start = '2026-10-21T00:00:00+09:00';
  const end = '2026-10-22T00:00:00+09:00';

  test('retains inclusive start/end boundaries', () => {
    expect(dealTiming(start, end, Date.parse(start) - 1)).toEqual({ state: 'upcoming', days: 1 });
    expect(dealTiming(start, end, Date.parse(start))).toEqual({ state: 'active', days: 1 });
    expect(dealTiming(start, end, Date.parse(end))).toEqual({ state: 'active', days: 0 });
    expect(dealTiming(start, end, Date.parse(end) + 1)).toEqual({ state: 'ended', days: null });
    expect(dealTiming(start, start, Date.parse(start))).toEqual({ state: 'active', days: 0 });
  });

  test('counts KST calendar days across midnight, even one millisecond apart', () => {
    const midnight = Date.parse('2026-10-21T15:00:00Z');
    expect(dealTiming(start, end, midnight - 1)).toEqual({ state: 'active', days: 1 });
    expect(dealTiming(start, end, midnight)).toEqual({ state: 'active', days: 0 });
    expect(dealTiming('2026-10-22T12:00:00+09:00', '2026-10-23T12:00:00+09:00', midnight)).toEqual({ state: 'upcoming', days: 0 });
    expect(dealTiming('2026-10-21', '2026-10-22', nowMs)).toEqual({ state: 'unknown', days: null });
  });

  test.each(['', 'not a date', '2026-13-01', '2026-02-30', '2026-02-29T00:00:00Z',
    '2026-10-21T24:00:00Z', '2026-10-21T00:60:00Z', '2026-10-21T00:00:00+25:00', '2026-10-21T00:00:00',
  ])('rejects malformed, normalized or ambiguous dates: %s', invalid => {
    expect(dealTiming(invalid, end, nowMs)).toEqual({ state: 'unknown', days: null });
    expect(dealTiming(start, invalid, nowMs)).toEqual({ state: 'unknown', days: null });
  });

  test('rejects reversed dates and invalid clocks; accepts leap days', () => {
    expect(dealTiming(end, start, nowMs)).toEqual({ state: 'unknown', days: null });
    expect(dealTiming(start, end, NaN)).toEqual({ state: 'unknown', days: null });
    expect(dealTiming(start, end, Infinity)).toEqual({ state: 'unknown', days: null });
    expect(dealTiming('2024-02-29T00:00:00Z', '2024-03-01T00:00:00Z', nowMs).state).toBe('ended');
  });

  test('sorts every group by its own time, breaks ties by ID and never mutates input', () => {
    const deal = (id: string, starts_at: string, ends_at: string) => Object.freeze({ ...fixture, id, starts_at: starts_at.length === 10 ? `${starts_at}T00:00:00Z` : starts_at, ends_at: ends_at.length === 10 ? `${ends_at}T00:00:00Z` : ends_at, extra: id });
    const input = Object.freeze([
      deal('unknown-z', 'bad', end), deal('ended-old', '2026-10-01', '2026-10-02'),
      deal('upcoming-late', '2026-10-25', '2026-10-26'), deal('active-late', start, '2026-10-24'),
      deal('active-b', start, end), deal('upcoming-b', '2026-10-23', '2026-10-24'),
      deal('ended-b', '2026-10-19', '2026-10-20'), deal('active-a', start, end),
      deal('upcoming-a', '2026-10-23', '2026-10-25'), deal('ended-a', '2026-10-18', '2026-10-20'),
      deal('unknown-a', end, start),
    ]);
    const before = [...input];
    const sorted = sortDeals(input, nowMs);
    expect(sorted.map(d => d.id)).toEqual(['active-a', 'active-b', 'active-late', 'upcoming-a', 'upcoming-b', 'upcoming-late', 'ended-a', 'ended-b', 'ended-old', 'unknown-a', 'unknown-z']);
    expect(input).toEqual(before);
    expect(sorted).not.toBe(input);
    expect(sorted[0]).toBe(input[7]);
    expect(sorted[0].extra).toBe('active-a');
    expect(sortDeals([...input].reverse(), nowMs)).toEqual(sorted);
    expect(sortDeals([], nowMs)).toEqual([]);
  });

  test('formats KST periods and independent confirmation dates', () => {
    expect(formatDealDate('2026-10-20T16:00:00Z', true)).toBe('2026.10.21 01:00');
    expect(formatDealDate('2026-10-18')).toBe('2026.10.18');
    expect(formatDealDate(null)).toBeNull();
    expect(formatDealDate('2026-02-30')).toBeNull();
  });
});

describe('server rendered deals UI', () => {
  test.each([
    {},
    { starts_at: '2026-10-25T00:00:00Z', ends_at: '2026-10-26T00:00:00Z' },
    { ends_at: '2026-10-21T02:00:00Z' },
  ])('detail links to its seller evidence regardless of schedule (%j)', patch => {
    expect(detail(patch)).toContain('href="/sellers#trust-seller-1"');
  });

  test('a missing seller keeps the unknown label without a trust link', () => {
    const html = detail({ seller_joined_id: null, seller_name: null });
    expect(html).toContain(dealsCopy.unknownSeller);
    expect(html).not.toContain('/sellers#');
    expect(html).not.toContain(dealsCopy.sellerTrust);
  });

  test('detail and card seller links use native anchors for fragment focus', () => {
    function sellerLinks(node: ReactNode): ReactElement<{ href?: string; children?: ReactNode }>[] {
      const found: ReactElement<{ href?: string; children?: ReactNode }>[] = [];
      Children.forEach(node, child => {
        if (!isValidElement<{ href?: string; children?: ReactNode }>(child)) return;
        if (child.props.href?.startsWith('/sellers#')) found.push(child);
        found.push(...sellerLinks(child.props.children));
      });
      return found;
    }
    for (const tree of [DealActions({ deal: fixture }), DealCardLinks({ deal: fixture })]) {
      const links = sellerLinks(tree);
      expect(links).toHaveLength(1);
      expect(links[0].type).toBe('a');
      expect(links[0].props.href).toBe('/sellers#trust-seller-1');
    }
    const parts = Children.toArray(DealCard({ deal: fixture, nowMs }).props.children);
    expect(parts.filter(part => isValidElement(part) && part.type === DealCardLinks)).toHaveLength(1);
  });

  test('list articles advertise, link their h2 to detail and include source, seller and disclaimer', () => {
    const html = card();
    expect(html).toContain('<article class="deal-card">');
    expect(html).toMatch(/<h2><a[^>]+href="\/deals\/deal-1"/);
    expect(html).toContain(dealsCopy.ad);
    expect(html).toContain(dealsCopy.active);
    expect(html).toContain(fixture.title);
    expect(html).toContain('390,000');
    expect(html).toContain(dealsCopy.groupBuyPrice);
    expect(html).toContain(dealsCopy.officialPrice);
    expect(html).toContain('430,000');
    expect(html.replace(/<[^>]+>/g, "")).toContain(formatGap(priceGap(fixture.price, fixture.model_official_price)!));
    expect(html).toMatch(/<span class="deal-gap-chunk"> · [^<]*(낮아요|높아요)<\/span>/);
    expect(html).toContain(dealsCopy.good);
    expect(html).toContain(`href="${fixture.source_url}" target="_blank" rel="sponsored noopener noreferrer"`);
    expect(html).toContain('href="/sellers#trust-seller-1"');
    expect(html.match(/class="deal-disclaimer"/g)).toHaveLength(1);
    expect(html.endsWith(`<p class="deal-disclaimer">${dealsCopy.disclaimer}</p></article>`)).toBe(true);
    expect(html).not.toContain('id="deal-new-tab"');
    expect(html).not.toContain('/models/');
  });

  test('cards without a joined seller retain the source and disclaimer without a dangling trust link', () => {
    const html = card({ seller_joined_id: null, seller_name: null });
    expect(html).not.toContain('/sellers#');
    expect(html).toContain(`href="${fixture.source_url}" target="_blank" rel="sponsored noopener noreferrer"`);
    expect(html).toContain(dealsCopy.newTab);
    expect(html.match(/class="deal-disclaimer"/g)).toHaveLength(1);
  });

  test('list cards omit qualification, verification, model notes and confirmation dates', () => {
    const html = card();
    for (const copy of [dealsCopy.qualification, dealsCopy.dealChecked, dealsCopy.officialChecked,
      dealsCopy.dealEvidence, dealsCopy.officialEvidence,
      dealsCopy.pageBody, dealsCopy.manual, fixture.model_note!, '2026.10.21', '2026.10.18']) {
      expect(html).not.toContain(copy);
    }
    expect(html.match(/<time /g)).toHaveLength(2);
    expect(html).not.toMatch(/<time[^>]*>2026\.10\.18/);
  });

  test('detail preserves qualification, verification, both dates and disclaimer while hiding price-bearing notes', () => {
    const html = detail();
    expect(html).toContain(dealsCopy.qualification);
    expect(html).toContain(dealsCopy.dealChecked);
    expect(html).toContain(dealsCopy.officialChecked);
    expect(html).toContain(dealsCopy.pageBody);
    expect(html).toContain(dealsCopy.manual);
    expect(html).not.toContain(fixture.model_note);
    expect(html).toContain('2026.10.21');
    expect(html).toContain('2026.10.18');
    expect(html.indexOf(dealsCopy.qualification)).toBeLessThan(html.indexOf(dealsCopy.good));
    expect(html.match(/class="deal-disclaimer"/g)).toHaveLength(1);
    expect(html).toContain(dealsCopy.disclaimer);
  });

  test('detail header advertises and one source action describes its new tab', () => {
    const html = detail();
    expect(html).toMatch(new RegExp(`<header class="deal-header">.*${dealsCopy.ad}.*<h1>`));
    expect(html).toContain(`href="${fixture.source_url}" target="_blank" rel="sponsored noopener noreferrer" aria-describedby="deal-new-tab"`);
    expect(html).toContain(`id="deal-new-tab">${dealsCopy.newTab}`);
    expect(html.match(/class="deal-actions"/g)).toHaveLength(1);
    expect(html.match(/class="deal-primary"/g)).toHaveLength(1);
    expect(html).toContain(dealsCopy.primary);
    expect(html).toContain('href="/models/model-1"');
    expect(html).toContain(fixture.seller_name);
    expect(html).toContain('2026.10.20 09:00');
    expect(html).toContain('2026.10.22 23:59');
  });

  test('ended deals retain one last-checked line on cards and full context on detail, without recommendations', () => {
    const patch = { ends_at: '2026-10-21T02:00:00Z' };
    for (const html of [card(patch), detail(patch)]) {
      expect(html.replace(/<span class="keep-line">|<\/span>/g, '')).toContain(`${dealsCopy.archived} · <time dateTime="${fixture.checked}">2026.10.21</time>`);
      expect(html).toMatch(/<span class="keep-line">\S+ · <time /);
      expect(html).not.toContain('class="deal-tone');
      expect(html).not.toContain(dealsCopy.remaining.replace('{n}', '0'));
    }
    const endedCard = card(patch);
    expect(endedCard).toContain(dealsCopy.ended);
    expect(endedCard).not.toContain(dealsCopy.qualification);
    expect(endedCard).not.toContain(dealsCopy.dealChecked);
    expect(endedCard).not.toContain(dealsCopy.officialChecked);
    expect(endedCard).not.toContain('2026.10.18');
    expect(endedCard.match(/class="deal-disclaimer"/g)).toHaveLength(1);
    expect(detail(patch)).toContain(dealsCopy.officialChecked);
    expect(detail(patch)).toContain('2026.10.18');
    expect(detail(patch)).toContain(fixture.source_url);
    expect(detail({ ...patch, price: 500000 })).not.toContain(dealsCopy.wait);
  });

  test('equal/above prices get a waiting badge, unknown comparisons get neither gap nor badge', () => {
    expect(card({ price: 430000 })).toContain(dealsCopy.equal);
    expect(card({ price: 430000 })).toContain(dealsCopy.wait);
    expect(card({ price: 500000 })).toContain(dealsCopy.wait);
    for (const patch of [{ price: null }, { model_official_price: null }, { model_official_price: 0 }, { model_joined_id: null }]) {
      const html = card(patch);
      expect(html).not.toContain('class="deal-gap"');
      expect(html).not.toContain('class="deal-tone');
    }
    expect(card({ price: 0 })).toContain(`>0<span>${dealsCopy.won}</span>`);
    expect(card({ price: null })).toContain(dealsCopy.unknownPrice);
    expect(card({ price: null })).toContain('정보 없음');
    expect(card({ model_official_price: null })).toContain('390,000');
    expect(card({ model_official_price: null })).toContain(dealsCopy.unknownOfficial);
  });

  test('failed official retrieval retains the deal price and neutral evidence with its date', () => {
    const html = detail({ model_verify_level: 'official_unpublished', model_official_price: null });
    for (const text of [dealsCopy.officialEvidence, dealsCopy.officialUnconfirmed, dealsCopy.unknownOfficial, '390,000', '2026.10.18']) {
      expect(html).toContain(text);
    }
    for (const text of [dealsCopy.officialChecked, '미공개', '비공개', 'class="deal-gap"', 'class="deal-tone', '430,000']) {
      expect(html).not.toContain(text);
    }
  });

  test.each([0, null])('official price %s with a legacy level uses a neutral evidence heading', model_official_price => {
    const html = detail({ model_official_price, model_verify_level: 'page_text' });
    expect(html).toContain(dealsCopy.officialEvidence);
    expect(html).toContain(dealsCopy.pageText);
    expect(html).not.toContain(dealsCopy.officialChecked);
  });

  test('an unconfirmed level cannot claim official confirmation even with a numeric price', () => {
    const html = detail({ model_verify_level: 'official_unpublished' }).replace(/<[^>]+>/g, '');
    expect(html).toContain(dealsCopy.officialEvidence);
    expect(html).not.toContain(dealsCopy.officialChecked);
  });

  test('missing deal price retains evidence and confirmed official metadata without substituting a price', () => {
    const html = detail({ price: null });
    expect(html).toContain(dealsCopy.dealEvidence);
    expect(html).toContain('정보 없음');
    expect(html).not.toContain(dealsCopy.dealChecked);
    expect(html).toContain(dealsCopy.officialChecked);
    expect(html).toContain('2026.10.21');
    expect(html).not.toContain('390,000');
    expect(html).not.toContain('class="deal-price"');
  });

  test('zero deal price remains known and keeps the confirmed headings', () => {
    const html = detail({ price: 0 });
    expect(html).toContain('>0<span>원</span>');
    expect(html).toContain(dealsCopy.dealChecked);
    expect(html).toContain(dealsCopy.officialChecked);
  });

  test('missing joined rows retain the deal, hide the model action and provide a seller fallback', () => {
    const html = detail({ model_joined_id: null, model_name: null, seller_joined_id: null, seller_name: null });
    expect(html).toContain(dealsCopy.unknownSeller);
    expect(html).toContain('390,000');
    expect(html).toContain(fixture.source_url);
    expect(html).not.toContain('/models/');
    expect(html).not.toContain(dealsCopy.secondary);
    expect(html).not.toContain('class="deal-gap"');
  });

  test('today and unknown schedules are explicit; empty and not-found states are concise', () => {
    expect(renderToStaticMarkup(createElement(DealStateChip, { timing: { state: 'active', days: 0 } }))).toContain(dealsCopy.endsToday);
    expect(renderToStaticMarkup(createElement(DealStateChip, { timing: { state: 'upcoming', days: 0 } }))).toContain(dealsCopy.startsToday);
    expect(detail({ starts_at: 'invalid' })).toContain(dealsCopy.unknownSchedule);
    expect(detail({ starts_at: 'invalid' })).not.toContain(dealsCopy.good);
    expect(renderToStaticMarkup(createElement(DealList, { deals: [], nowMs }))).toBe(`<p class="deal-empty">${dealsCopy.empty}</p>`);
    const missing = renderToStaticMarkup(createElement(DealNotFound));
    expect(missing).toContain(dealsCopy.missing);
    expect(missing).toContain('href="/deals"');
  });
});

describe('theme contrast', () => {
  // Validate the actual design tokens without launching a browser or server.
  const luminance = (hex: string) => {
    const expanded = hex.length === 4 ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1);
    const [r, g, b] = expanded.match(/.{2}/g)!.map(c => parseInt(c, 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  const contrast = (foreground: string, background: string) => {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  test.each(['light', 'dark'])('%s advertising labels, recommendations, context and actions meet AA', async theme => {
    const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
    const tokens = Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[\da-f]{3,6})\s*;/gi)].map(match => [match[1], match[2]]));
    const prefix = theme === 'dark' ? '--dark-' : '--';
    for (const [foreground, background] of [
      ['text', 'surface'], ['text', 'surface-2'], ['text', 'clay'],
      ['muted', 'surface'], ['on-accent', 'accent'], ['muted', 'neutral'], ['text', 'surface'],
      ['accent', 'surface'], ['accent', 'surface-2'], ['muted', 'bg'],
    ]) {
      expect(contrast(tokens[prefix + foreground], tokens[prefix + background])).toBeGreaterThanOrEqual(4.5);
    }
    // Focus rings sit outside controls, against the page/card surfaces.
    for (const background of ['bg', 'surface']) {
      expect(contrast(tokens[prefix + 'accent'], tokens[prefix + background])).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('dynamic routes and LEFT JOIN projection', () => {
  const memory = memoryD1();
  beforeAll(async () => {
    context.db = memory.db;
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
      const schema = await readFile(new URL(file, dir), 'utf8');
      for (const sql of schema.split(';').filter(sql => sql.trim())) await memory.db.prepare(sql).run();
    }
    // Model/seller deletion and old incomplete records must not hide a deal.
    await memory.db.prepare('PRAGMA foreign_keys = OFF').run();
    await memory.db.prepare("INSERT INTO models VALUES ('model-1', 'Brand', 'Model', 'high_chair', 'Importer', 430000, 'https://example.com/model', '2026-10-18', 'search_summary', 'Retailer 123,456원; overseas $799; used 234,567원')").run();
    await memory.db.prepare("INSERT INTO sellers (id, name, source_url) VALUES ('seller-1', 'Seller', 'https://example.com/seller')").run();
    await memory.db.prepare("INSERT INTO seller_accounts VALUES ('private.account.marker', 'seller-1', '2026-10-20')").run();
    await memory.db.prepare("INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at, attribution, attribution_note) VALUES ('deal-1', 'https://example.com/private-source', 'private.account.marker', 'private ingestion marker', 'post', '2026-10-20', 'explicit', 'private attribution marker')").run();
    for (const d of [fixture, { ...fixture, id: 'missing-joins', model_id: 'absent-model', seller_id: 'absent-seller' }]) {
      await memory.db.prepare('INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(d.id, d.model_id, d.seller_id, d.title, d.price, d.source_url, d.verify_level, d.checked, d.starts_at, d.ends_at, d.id === fixture.id ? 'https://cdninstagram.com/fixture.jpg?x=1&sig=synthetic%2Bvalue' : null).run();
    }
  });
  afterAll(() => memory.close());

  test('aliased columns preserve deal identity and confirmation metadata, even for missing joins', async () => {
    const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toHaveProperty('model_note');
    expect(rows.find(d => d.id === fixture.id)).toMatchObject({
      id: 'deal-1', checked: fixture.checked, verify_level: 'manual', source_url: fixture.source_url,
      image_url: 'https://cdninstagram.com/fixture.jpg?x=1&sig=synthetic%2Bvalue', model_joined_id: 'model-1', model_checked: '2026-10-18', model_verify_level: 'search_summary', seller_name: 'Seller',
    });
    expect(rows.find(d => d.id === 'missing-joins')).toMatchObject({
      model_joined_id: null, seller_joined_id: null, seller_name: null,
      seller_registration_source: null, seller_withdrawal_source: null, seller_official_import_source: null,
    });
  });

  const evidence = [
    ['seller_registration_source', '통신판매업 신고', 'https://example.com/registration'],
    ['seller_withdrawal_source', '청약철회 7일', 'https://example.com/withdrawal'],
    ['seller_official_import_source', '정식수입', 'https://example.com/import'],
  ] as const;

  test('bounded list and detail preserve seller evidence without evidence fetches', async () => {
    await memory.db.prepare('UPDATE sellers SET registration_source = ?, withdrawal_source = ?, official_import_source = ? WHERE id = ?')
      .bind(...evidence.map(([, , url]) => url), 'seller-1').run();
    // Observe executed reads as well as preparations, after all fixture writes.
    const statementPrototype = Object.getPrototypeOf(memory.db.prepare(DEAL_SELECT)) as D1PreparedStatement;
    const prepare = vi.spyOn(memory.db, 'prepare');
    const bind = vi.spyOn(statementPrototype, 'bind');
    const readAll = vi.spyOn(statementPrototype, 'all');
    const readFirst = vi.spyOn(statementPrototype, 'first');
    try {
      const list = renderToStaticMarkup(await DealsPage());
      expect(list.match(/class="deal-card"/g)).toHaveLength(2);
      expect(list.match(/class="badge verified"/g)).toHaveLength(3);
      expect(list.match(/· 미확인/g)).toHaveLength(3);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('COUNT(*) AS count'))).toBe(true);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('SELECT id,')).every(([sql]) => sql.includes('LIMIT ?'))).toBe(true);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('d.id IN (?,?)'))).toBe(true);
      expect([...list.matchAll(/href="\/deals\/([^"]+)"/g)].map(m => m[1])).toEqual(['deal-1', 'missing-joins']);
      expect(readFirst).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();

      vi.clearAllMocks();

      const detail = renderToStaticMarkup(await DealDetailPage({ params: Promise.resolve({ id: fixture.id }) }));
      expect(detail.match(/class="badge verified"/g)).toHaveLength(3);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenNthCalledWith(1, `${DEAL_SELECT} AND d.id = ?`);
      expect(prepare).toHaveBeenNthCalledWith(2, expect.stringContaining('deal_bundle_items'));
      expect(bind).toHaveBeenCalledWith(fixture.id);
      expect(readFirst).toHaveBeenCalledTimes(1);
      expect(readAll).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      bind.mockRestore();
      readAll.mockRestore();
      readFirst.mockRestore();
      await memory.db.prepare('UPDATE sellers SET registration_source = NULL, withdrawal_source = NULL, official_import_source = NULL').run();
    }
  });

  // All eight combinations catch swapped fields and states inferred from another badge.
  test.each([
    ...Array.from({ length: 8 }, (_, mask) => ({ name: `evidence mask ${mask}`, mask, blank: false })),
    { name: 'empty and whitespace evidence', mask: 0, blank: true },
  ])('both deal routes render independent stored evidence: $name', async ({ mask, blank }) => {
    const sources = evidence.map(([, , url], index) => mask & (1 << index) ? url : blank ? ['', ' ', '\t'][index] : null);
    await memory.db.prepare('UPDATE sellers SET registration_source = ?, withdrawal_source = ?, official_import_source = ? WHERE id = ?')
      .bind(...sources, 'seller-1').run();
    try {
      const rows = await all<DealWithContext>(memory.db, DEAL_SELECT);
      const row = rows.find(d => d.id === fixture.id)!;
      evidence.forEach(([field], index) => expect(row[field]).toBe(sources[index]));
      const list = await DealsPage();
      const detail = await DealDetailPage({ params: Promise.resolve({ id: fixture.id }) });
      for (const page of [list, detail]) {
        const html = renderToStaticMarkup(createElement(Layout, null, page));
        const article = html.match(/<article class="deal-(?:card|detail)">[\s\S]*?<\/article>/)![0];
        const badges = article.match(/<div class="badges">([\s\S]*?)<\/div>/)![1];
        expect(badges.match(/class="badge(?: verified)?"/g)).toHaveLength(3);
        evidence.forEach(([, label, url], index) => {
          if (mask & (1 << index)) {
            expect(badges).toContain(`<a class="badge verified" href="${url}" target="_blank" rel="noopener noreferrer">${label} · 근거 확인 ↗</a>`);
          } else {
            expect(badges).toContain(`<span class="badge">${label} · 미확인</span>`);
            expect(badges).not.toContain(`href="${url}"`);
          }
        });
        expect(badges.indexOf(evidence[0][1])).toBeLessThan(badges.indexOf(evidence[1][1]));
        expect(badges.indexOf(evidence[1][1])).toBeLessThan(badges.indexOf(evidence[2][1]));
        expect(article).toContain(`class="deal-ad">${dealsCopy.ad}`);
        expect(article).toContain(`href="${fixture.source_url}" target="_blank" rel="sponsored noopener noreferrer"`);
        expect(article).toContain(dealsCopy.disclaimer);
        expect(article).toContain('href="/sellers#trust-seller-1"');
        expect(html).toContain(siteCopy.transactionNotice);
        expect(html).toContain(siteCopy.transactionTerms);
        for (const marker of ['private.account.marker', 'private ingestion marker', 'private attribution marker', 'attribution', 'seller_accounts']) {
          expect(JSON.stringify(rows)).not.toContain(marker);
          expect(html).not.toContain(marker);
        }
      }
    } finally {
      await memory.db.prepare('UPDATE sellers SET registration_source = NULL, withdrawal_source = NULL, official_import_source = NULL').run();
    }
  });

  test('missing seller remains visible on both routes with three noninteractive unconfirmed badges', async () => {
    const pages = [await DealsPage(), await DealDetailPage({ params: Promise.resolve({ id: 'missing-joins' }) })];
    for (const page of pages) {
      const html = renderToStaticMarkup(createElement(Layout, null, page));
      const articles = html.match(/<article class="deal-(?:card|detail)">[\s\S]*?<\/article>/g)!;
      const article = articles.find(a => a.includes('/deals/missing-joins')) ?? articles[0];
      const badges = article.match(/<div class="badges">([\s\S]*?)<\/div>/)![1];
      expect(badges.match(/· 미확인/g)).toHaveLength(3);
      expect(badges).not.toContain('<a');
      expect(article).not.toContain('/sellers#');
      expect(article).toContain(fixture.title);
      expect(article).toContain(`class="deal-ad">${dealsCopy.ad}`);
      expect(article).toContain(`href="${fixture.source_url}" target="_blank" rel="sponsored noopener noreferrer"`);
      expect(article).toContain(dealsCopy.disclaimer);
      expect(html).toContain(siteCopy.transactionNotice);
    }
  });

  test('both routes are dynamic and capture time only once per render', async () => {
    expect(listDynamic).toBe('force-dynamic');
    expect(detailDynamic).toBe('force-dynamic');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const list = renderToStaticMarkup(await DealsPage());
    expect(list).toContain('/deals/deal-1');
    expect(list).toContain(dealsCopy.unknownOfficial);
    expect(list).not.toContain('430,000');
    expect(list).not.toContain('class="deal-gap');
    expect(list).not.toContain('class="deal-tone');
    expect(clock).toHaveBeenCalledTimes(1);
    clock.mockClear();
    const html = renderToStaticMarkup(await DealDetailPage({ params: Promise.resolve({ id: fixture.id }) }));
    expect(html).toContain(fixture.title);
    expect(html).toContain(dealsCopy.unknownOfficial);
    expect(html).not.toContain('430,000');
    expect(html).not.toContain('class="deal-gap');
    expect(html).not.toContain('class="deal-tone');
    expect(html).not.toContain('123,456');
    expect(html).not.toContain('234,567');
    expect(html).not.toContain('$799');
    expect(clock).toHaveBeenCalledTimes(1);
  });

  test('list page renders one disclaimer at the end of each card', async () => {
    const html = renderToStaticMarkup(await DealsPage());
    expect(html.match(/class="deal-card"/g)).toHaveLength(2);
    expect(html.match(/class="deal-disclaimer"/g)).toHaveLength(2);
    expect(html).toContain('</article></div><nav aria-label="공구 목록 페이지">');
  });

  test('awaits params, binds IDs literally, and calls notFound for missing records', async () => {
    const html = renderToStaticMarkup(await DealDetailPage({ params: Promise.resolve({ id: 'missing-joins' }) }));
    expect(html).toContain(dealsCopy.unknownSeller);
    for (const id of ['absent', "' OR 1=1 --"]) {
      await expect(DealDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });
});

describe('deal images', () => {
  test('cards and details render images without changing existing text, prices, advertising or notices', () => {
    const image_url = 'https://cdninstagram.com/product.jpg?sig=synthetic%2B&x=1';
    for (const render of [card, detail]) {
      const html = render({ image_url });
      expect(html).toContain('class="deal-image"');
      expect(html).toContain('src="https://cdninstagram.com/product.jpg?sig=synthetic%2B&amp;x=1"');
      expect(html).toContain(`alt="${fixture.model_name} 상품 이미지"`);
      expect(html).toContain('width="640" height="480"');
      expect(html).toContain('loading="lazy"');
      expect(html).toContain('referrerPolicy="no-referrer"');
      expect(html).not.toContain('/_next/image');
      expect(html).toContain(dealsCopy.ad);
      expect(html).toContain('390,000');
      expect(html).toContain(fixture.title);
      expect(html.replace(/<img[^>]*>/g, '')).toBe(render());
    }
    expect(detail({ image_url })).toContain(dealsCopy.disclaimer);
  });

  test('image alt falls back to the deal title without a joined model name', () => {
    for (const render of [card, detail]) {
      for (const patch of [{ model_joined_id: null }, { model_name: null }]) {
        expect(render({ ...patch, image_url: 'https://fbcdn.net/product.jpg' }))
          .toContain(`alt="${fixture.title} 상품 이미지"`);
      }
    }
  });

  test.each([null, '', 'blob:local', 'https://example.com/unapproved.jpg'])('missing/invalid image %s leaves text-only content', image_url => {
    for (const render of [card, detail]) {
      const html = render({ image_url });
      expect(html).not.toContain('<img');
      expect(html).toContain(fixture.title);
      expect(html).toContain(dealsCopy.ad);
      expect(html).toContain('390,000');
    }
  });
});
