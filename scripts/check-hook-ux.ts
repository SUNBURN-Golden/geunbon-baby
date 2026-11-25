import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { dealsCopy } from '../lib/deals-copy';
import { homeCopy } from '../lib/copy/home.ko';
import { fixtureProofBody, fixtureScope } from '../tests/helpers/public-deal-fixture';
import { requestClaim, seal, verifiedFixture, verifiedFixtureModel } from '../tests/helpers/verified-offer';
import { digest } from '../shared/deal-price-evidence';
import { CLOSE_OFFER, offerRegionDigest, type FailedOffer } from '../shared/verified-offer';
import { buildSeedSql } from './seed-sql';

const root = resolve(import.meta.dirname, '..');
const local = resolve(root, '.local');
await access(resolve(root, '.open-next/worker.js')).catch(() => { throw new Error('Run npm run build:worker first'); });
await mkdir(local, { recursive: true });
const output = await mkdtemp(resolve(local, 'hook-ux-'));
const persist = resolve(output, 'd1');
const config = resolve(output, 'wrangler.json');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' };
const adminToken = randomUUID();
const ingestToken = randomUUID();
await writeFile(resolve(output, '.dev.vars'), `ADMIN_TOKEN=${adminToken}\nINGEST_TOKEN=${ingestToken}\n`, { mode: 0o600 });
// The isolated local config never loads the repository's .dev.vars.
await writeFile(config, JSON.stringify({
  name: 'agamajung-hook-ux',
  main: resolve(root, 'worker.ts'),
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
  assets: { directory: resolve(root, '.open-next/assets'), binding: 'ASSETS' },
  services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'agamajung-hook-ux' }],
  d1_databases: [{ binding: 'DB', database_name: 'agamajung-hook-ux', database_id: 'hook-ux-qa', migrations_dir: resolve(root, 'migrations') }],
  r2_buckets: [{ binding: 'IMAGES', bucket_name: 'agamajung-hook-ux-images' }],
}));
const run = promisify(execFile);
const localArgs = ['--local', '--persist-to', persist, '--config', config];
async function d1(args: string[]) {
  const { stdout } = await run(process.execPath, [wrangler, 'd1', ...args, ...localArgs], { cwd: root, env });
  return stdout;
}
async function admin(path: string, body: Record<string, unknown>) {
  return fetch(`${origin}/api/v1/admin/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function ingest(body: object) {
  return fetch(`${origin}/api/v1/ingest`, {
    method: 'POST', headers: { authorization: `Bearer ${ingestToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function rows<T>(sql: string) {
  const result = await d1(['execute', 'DB', '--json', '--command', sql]);
  return JSON.parse(result)[0].results as T[];
}
async function applySql(name: string, sql: string) {
  const file = resolve(output, name);
  await writeFile(file, sql);
  await d1(['execute', 'DB', '--file', file]);
}
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const address = socket.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
await d1(['migrations', 'apply', 'DB']);
await applySql('seed.sql', buildSeedSql().sql);
const worker = spawn(process.execPath, [wrangler, 'dev', ...localArgs, '--ip', '127.0.0.1', '--port', String(port), '--show-interactive-dev-session=false'], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(worker, 'exit');
let workerLog = '';
for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { workerLog += String(chunk); });
let browser: Browser | undefined;
const measurements: Record<string, unknown>[] = [];
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
const imageURL = 'https://cdninstagram.com/hook-ux-qa.png';
const source = 'https://example.test/hook-ux/today-a';
const stubImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
const ready = async () => {
  for (let attempt = 0; attempt < 80 && worker.exitCode === null; attempt++) {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1500), headers: { accept: 'application/json' } }).catch(() => null);
    if (response?.ok && (await response.json() as { ok: boolean }).ok) return;
    await delay(250);
  }
  throw new Error('Local Worker did not return a healthy HTML-backed JSON response');
};
const dimensions = [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
  { width: 320, height: 844 },
];
const themes = ['light', 'dark'] as const;
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

function kstMidnight(now: number) {
  const offset = 9 * 3_600_000;
  const day = 86_400_000;
  return (Math.floor((now + offset) / day) + 1) * day - offset;
}
const iso = (ms: number) => new Date(ms).toISOString();

function fixtures(now: number) {
  const midnight = kstMidnight(now);
  const rows = [
    ['today-a', 'model-1', 390000, now - 3_600_000, midnight - 1000, imageURL],
    ['today-b', 'model-7', 420000, now - 7_200_000, midnight - 500, null],
    ['later', 'model-1', 400000, now - 10_800_000, midnight + 86_400_000, null],
  ] as const;
  const approval = `
    INSERT INTO official_price_approvals VALUES (1,${quote(iso(now))},${quote(JSON.stringify([fixtureScope]))});
    INSERT INTO sellers (id,name,source_url,official_import_source)
    VALUES ('ext-qa-unknown','QA shared seller','https://example.test/seller','https://example.test/official-import');
  `;
  return approval + rows.map(([id, model, price, start, end, image]) => {
    const url = `https://example.test/hook-ux/${id}`;
    const captured = quote(iso(now));
    return `
      INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at,status)
      VALUES ('qa-${id}',${quote(url)},'qa','QA-only fixture','post',${captured},'approved');
      INSERT INTO deal_price_evidence (id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
      VALUES ('qa-proof-${id}','deal','qa-${id}','1','verified',${quote(fixtureProofBody(url, iso(now)))},${captured},${captured});
      INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at,image_url,
        deal_price_krw,list_price_krw,price_source_url,list_price_source_url,price_checked_at,price_verification,price_evidence_id,price_evidence_version)
      VALUES ('qa-${id}','${model}','seller-1','${id === 'today-a' ? '스토케 트립트랩 공구' : id}',${price},${quote(url)},
        'manual',${captured},${quote(iso(start))},${quote(iso(end))},${image ? quote(image) : 'NULL'},
        ${price},500000,${quote(url)},${quote(fixtureScope.url)},${captured},'verified','qa-proof-${id}',1);
      INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,model_id,seller_id,title,price,
        starts_at,ends_at,checked,status,created_at,price_evidence_id)
      SELECT 'qa-rev-${id}',id,version,'publish','qa-${id}','qa','${model}',seller_id,title,price,
        starts_at,ends_at,checked,status,${captured},price_evidence_id FROM deals WHERE id='qa-${id}';
    `;
  }).join('\n');
}

async function firstOfferPositions(page: Page) {
  return page.locator('.deal-card').first().evaluate(card => {
    const [price, listPrice, discount, cta] = ['.deal-price', 'del', '.deal-discount', '.deal-primary'].map(selector => {
      const element = card.querySelector<HTMLElement>(selector)!;
      const { x, y, width, height } = element.getBoundingClientRect();
      const points = [[x + width / 2, y + height / 2], [x + 3, y + height / 2], [x + width - 3, y + height / 2]];
      const unobscured = points.every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
      return { x, y, width, height, unobscured };
    });
    return { price, listPrice, discount, cta, scrollY, width: innerWidth, height: innerHeight };
  });
}

function checkFirstOffer(positions: Awaited<ReturnType<typeof firstOfferPositions>>) {
  assert.equal(positions.scrollY, 0);
  for (const box of [positions.price, positions.listPrice, positions.discount, positions.cta]) {
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= positions.width && box.y + box.height <= positions.height && box.unobscured,
      `First offer is outside the visible viewport: ${JSON.stringify(positions)}`);
  }
  assert(positions.cta.height >= 44);
}

async function checkHero(page: Page, count: number) {
  await page.getByRole('heading', { level: 1, name: homeCopy.active(count), exact: true }).waitFor();
}

async function matrix(browser: Browser, name: string, count: number, heading?: string) {
  for (const viewport of dimensions) for (const colorScheme of themes) {
    const context = await browser.newContext({ viewport, colorScheme });
    await context.route(imageURL, route => route.fulfill({ contentType: 'image/png', body: stubImage }));
    const page = await context.newPage();
    const response = await page.goto(origin);
    assert.equal(response?.status(), 200);
    await checkHero(page, count);
    assert.equal(await page.locator('.home-facet-row').first().locator('a').count(), 6);
    assert((await page.locator('.home-facet-row').last().locator('a').count()) >= 12);
    const facets = await page.locator('.home-facet-row').evaluateAll(rows => rows.map(row => {
      const scrollable = row.scrollWidth > row.clientWidth;
      row.scrollLeft = row.scrollWidth;
      const moved = row.scrollLeft > 0;
      row.scrollLeft = 0;
      return { scrollable, moved };
    }));
    if (viewport.width < 768) assert(facets.every(row => row.scrollable && row.moved));
    const grid = await page.evaluate(() => {
      const list = document.querySelector('.home-section .deal-list');
      return { columns: list ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 0, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert(!grid.overflow);
    if (count) {
      assert.equal(grid.columns, viewport.width < 768 ? 1 : 3);
      assert.equal(await page.locator('.home-section').first().locator('h2').first().textContent(), heading);
      checkFirstOffer(await firstOfferPositions(page));
    } else {
      assert.equal(await page.locator('.deal-card').count(), 0);
      assert.equal(await page.locator('.home-saving').count(), 0);
      await page.locator('.home-catalog[href="/models"]').waitFor();
    }
    const key = `${name}-${viewport.width}-${colorScheme}`;
    measurements.push({ key, viewport, colorScheme, ...grid, facets, ...(count ? { firstOffer: await firstOfferPositions(page) } : {}) });
    await page.screenshot({ path: resolve(output, `${key}.png`) });
    await context.close();
  }
}

async function navigation(browser: Browser) {
  const context = await browser.newContext({ viewport: dimensions[0] });
  await context.route(imageURL, route => route.fulfill({ contentType: 'image/png', body: stubImage }));
  await context.route(source, route => route.fulfill({ body: 'QA source' }));
  const page = await context.newPage();
  await page.goto(origin);
  const categoryRow = page.getByRole('list', { name: homeCopy.categoryFilters });
  await categoryRow.getByRole('link', { name: '유모차 1', exact: true }).click();
  await checkHero(page, 1);
  await categoryRow.getByRole('link', { name: '하이체어 2', exact: true }).waitFor();
  const brandRow = page.getByRole('list', { name: homeCopy.brandFilters });
  await brandRow.getByRole('link', { name: 'Stokke 1', exact: true }).click();
  await checkHero(page, 1);
  assert.match(page.url(), /category=stroller&brand=Stokke/);
  await page.goBack();
  await checkHero(page, 1);
  assert(!new URL(page.url()).searchParams.has('brand'));
  await page.goBack();
  await checkHero(page, 3);
  await categoryRow.getByRole('link', { name: '유모차 1', exact: true }).click();
  await checkHero(page, 1);
  await page.getByRole('link', { name: homeCopy.clear }).click();
  await checkHero(page, 3);
  const cta = page.locator('.deal-card').first().getByRole('link', { name: homeCopy.openOffer, exact: true });
  assert.equal(await cta.getAttribute('href'), source);
  assert.equal(await cta.getAttribute('rel'), 'sponsored noopener noreferrer');
  const popupEvent = page.waitForEvent('popup');
  await cta.click();
  const popup = await popupEvent;
  await popup.waitForURL(source);
  await popup.close();
  await page.locator('.deal-card').first().locator('h2 a').click();
  await page.waitForURL('**/deals/qa-today-a');
  const detail = page.locator('.deal-detail').getByRole('link', { name: homeCopy.openOffer, exact: true });
  assert.equal(await detail.getAttribute('href'), source);
  assert.equal(await detail.getAttribute('rel'), 'sponsored noopener noreferrer');
  await page.setViewportSize(dimensions[1]);
  const shell = await page.locator('.deals-page').boundingBox();
  const card = await page.locator('.deal-detail').boundingBox();
  assert(shell && card);
  const left = card.x - shell.x;
  const right = shell.x + shell.width - (card.x + card.width);
  assert(Math.abs(left - right) <= 2, `desktop detail card is centered (left ${left}, right ${right})`);
  await page.setViewportSize(dimensions[0]);
  await page.locator('a[href="/sellers#trust-seller-1"]').click();
  await page.waitForURL('**/sellers#trust-seller-1');
  await page.waitForFunction(() => document.activeElement?.id === 'trust-seller-1');
  const placeholder = page.locator('#trust-ext-qa-unknown');
  await placeholder.getByRole('heading', { name: 'QA shared seller' }).waitFor();
  assert.equal(await placeholder.locator('a[href="https://example.test/official-import"]').count(), 1);
  assert.equal(await placeholder.locator('.alert-form').count(), 0);
  await context.close();
}

async function frozenPagination(browser: Browser, restoredDeadline: number) {
  const expiry = Date.now() + 8000;
  await applySql('cursor-boundary.sql', `UPDATE deals SET ends_at=${quote(iso(expiry))} WHERE id='qa-today-b';`);
  const page = await browser.newPage();
  await page.route(imageURL, route => route.fulfill({ contentType: 'image/png', body: stubImage }));
  try {
    await page.goto(`${origin}/deals?limit=1`);
    const reference = page.locator('.deals-page > p time');
    const t0 = (await reference.getAttribute('datetime'))!;
    assert.equal(await page.locator('.active-deal-count').textContent(), '3');
    const next = (await page.getByRole('link', { name: dealsCopy.nextPage }).getAttribute('href'))!;
    await delay(Math.max(0, expiry + 20 - Date.now()));
    await page.goto(new URL(next, origin).href);
    assert.equal(await reference.getAttribute('datetime'), t0);
    assert.equal(await page.locator('.active-deal-count').textContent(), '2');
    assert.equal(await page.locator('#deals-active + .deal-list .deal-title-link').getAttribute('href'), '/deals/qa-later');
    const close = (await page.locator('.deal-countdown time').getAttribute('datetime'))!;
    const timer = page.locator('.deal-timer');
    const before = Number(await timer.getAttribute('data-remaining'));
    const frozen = Math.ceil((Date.parse(close) - Date.parse(t0)) / 1000);
    assert(before < frozen);
    await page.waitForFunction(previous => Number(document.querySelector('.deal-timer')?.getAttribute('data-remaining')) < previous, before);
  } finally {
    await page.close();
    await applySql('cursor-restore.sql', `UPDATE deals SET ends_at=${quote(iso(restoredDeadline))} WHERE id='qa-today-b';`);
  }
}

async function stableMedia(browser: Browser, fail: boolean) {
  const context = await browser.newContext({ viewport: dimensions[0] });
  const page = await context.newPage();
  const hydration = gate();
  const media = gate();
  const fonts = gate();
  await page.route('**/*.woff2', async route => { await fonts.promise; await route.continue(); });
  await page.route('**/_next/static/**/*.js*', async route => { await hydration.promise; await route.continue(); });
  await page.route(imageURL, async route => {
    await media.promise;
    if (fail) await route.abort();
    else await route.fulfill({ contentType: 'image/png', body: stubImage });
  });
  try {
    await page.goto(origin, { waitUntil: 'commit' });
    await page.locator('.deal-card .deal-primary').first().waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.home-section .deal-list')!).display === 'grid');
    const before = await firstOfferPositions(page);
    checkFirstOffer(before);
    const remaining = await page.locator('.deal-timer').first().getAttribute('data-remaining');
    hydration.open();
    await page.waitForFunction(value => document.querySelector('.deal-timer')!.getAttribute('data-remaining') !== value, remaining);
    const hydrated = await firstOfferPositions(page);
    assert.deepEqual(hydrated, before);
    media.open();
    if (fail) await page.locator('.deal-card').first().locator('img').waitFor({ state: 'detached' });
    else await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('.deal-card img');
      return image?.complete && image.naturalWidth > 0;
    });
    const settled = await firstOfferPositions(page);
    assert.deepEqual(settled, before);
    fonts.open();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    assert.deepEqual(await firstOfferPositions(page), before);
    measurements.push({ key: fail ? 'failed-approved-media' : 'slow-approved-media', before, hydrated, settled });
  } finally {
    hydration.open();
    media.open();
    fonts.open();
    await context.close();
  }
}

async function submitAlert(browser: Browser, kind: 'model' | 'seller', mode: 'native' | 'delayed' | 'hydrated') {
  const context = await browser.newContext({ viewport: dimensions[0], javaScriptEnabled: mode !== 'native' });
  const page = await context.newPage();
  const hydration = gate();
  const email = 'Hook.QA+parent@EXAMPLE.TEST';
  if (mode === 'delayed') await page.route('**/_next/static/**/*.js*', async route => { await hydration.promise; await route.continue(); });
  try {
    const target = kind === 'seller' ? 'seller-1' : 'model-2'; // Model 2 has no active offer.
    await page.goto(origin + (kind === 'seller' ? '/sellers' : `/models/${target}`), { waitUntil: mode === 'delayed' ? 'commit' : 'load' });
    const form = page.locator(`#alert-${kind}-${target}`);
    assert.equal(await form.getAttribute('method'), 'post');
    assert.equal(await form.getAttribute('action'), '/api/v1/alerts');
    if (mode === 'hydrated') await page.waitForFunction(id => Object.keys(document.getElementById(id)!).some(key => key.startsWith('__react')), `alert-${kind}-${target}`);
    await form.getByLabel(homeCopy.alert.email).fill(email);
    const reply = page.waitForResponse(response => response.url() === `${origin}/api/v1/alerts`);
    const landing = mode === 'hydrated' ? null : page.waitForResponse(next => next.url().includes('?alert=success') && next.request().isNavigationRequest());
    await form.getByRole('button', { name: homeCopy.alert.submit }).click({ noWaitAfter: true });
    const response = await reply;
    assert.equal(response.request().method(), 'POST');
    assert(response.request().postData()?.includes(mode === 'hydrated' ? email : encodeURIComponent(email)));
    assert(!response.request().url().toLowerCase().includes(email.toLowerCase()));
    if (mode === 'hydrated') {
      assert.equal(response.status(), 200);
      assert.deepEqual(await response.json(), { result: 'success' });
      assert(!response.headers().location);
    } else {
      assert.equal(response.status(), 303);
      const location = response.headers().location;
      assert.match(location, /\?alert=success/);
      assert(!decodeURIComponent(location).toLowerCase().includes(email.toLowerCase()));
      const final = (await landing)!;
      assert(!(await final.text()).toLowerCase().includes(email.toLowerCase()));
    }
    await form.getByRole('status').filter({ hasText: homeCopy.alert.success }).waitFor();
    assert(!decodeURIComponent(page.url()).toLowerCase().includes(email.toLowerCase()));
  } finally {
    hydration.open();
    await context.close();
  }
}

async function verifyPublicationHistory(browser: Browser) {
  const { brand, name, category } = verifiedFixtureModel;
  await applySql('typed-model.sql', `UPDATE models SET brand=${quote(brand)}, name=${quote(name)}, category=${quote(category)} WHERE id='model-1';`);
  const catalog = await rows<{ id: string; brand: string; name: string; category: string }>('SELECT id,brand,name,category FROM models');
  const stamp = Date.now();
  const checked = iso(stamp);
  const ends = iso(stamp + 86_400_000);
  const early = iso(stamp - 3 * 86_400_000);
  const recent = iso(stamp - 86_400_000);
  const before = await verifiedFixture(390000, 430000, 'earlier', early, { checked, ends, catalog, source: 'https://seller.example.com/earlier' });
  const current = await verifiedFixture(390000, 430000, 'current', recent, { checked, ends, catalog, source: 'https://seller.example.com/current' });
  assert.equal((await admin('price-sources', { observed_at: checked, scopes: [fixtureScope, before.scope, current.scope] })).status, 200);
  async function publish(fixture: typeof before, opening: string) {
    const { offer, id } = fixture;
    assert.equal((await ingest(offer)).status, 202);
    const result = await admin(`candidates/${id}`, await requestClaim(offer));
    assert.equal(result.status, 200, 'the local Worker commits the accepted offer and its price evidence');
    const { data } = await result.json() as { data: { deal_id: string; committed_revision: number } };
    assert.equal(data.committed_revision, 1);
    const [seller] = await rows<{ seller_id: string }>(`SELECT seller_id FROM deals WHERE id=${quote(data.deal_id)}`);
    assert.equal((await admin(`deals/${data.deal_id}/round`, {
      action: 'confirm', expected_version: 1, confirmed: true, seller_id: seller.seller_id,
      event_key: offer.locator.replace(':', '-'), opened_at: opening, source_url: offer.facts.source_url,
    })).status, 200);
    return data.deal_id;
  }
  await publish(before, early);
  const prior = before.offer;
  const closure = '공구 종료';
  const region = { url: prior.facts.source_url, seller_url: prior.facts.seller_url, locator: prior.locator,
    availability_badge: { value: 'closed' as const, locator: 'product:closed' } };
  const content_digest = await offerRegionDigest(closure, region, prior.facts.image_url);
  const closed = await seal({ ...prior, revision: 2, expected_version: 1, content_digest,
    facts: { ...prior.facts, availability: 'closed' as const }, closure: { text: closure, hash: await digest(closure) },
    liveness: { ...region, checked_at: checked, product_digest: content_digest },
  });
  assert.equal((await ingest(closed)).status, 202);
  assert.equal((await admin(`candidates/${before.id}`, await requestClaim(closed, CLOSE_OFFER))).status, 200);

  await publish(current, recent);
  const page = await browser.newPage({ viewport: dimensions[0] });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(origin);
    await checkHero(page, 1);
    const low = page.locator('[data-home-section="low"]');
    await low.getByText(homeCopy.lowBasis).waitFor();
    checkFirstOffer(await firstOfferPositions(page));
    await low.getByText(homeCopy.rounds(1), { exact: false }).waitFor();
    assert.equal(await low.locator('.deal-primary').getAttribute('href'), current.offer.facts.source_url);
    assert.equal(await page.locator('[data-home-section="new"] .deal-card').count(), 1);

    const { facts: _, metadata: __, price_evidence: ___, liveness: ____, ...base } = current.offer;
    void [_, __, ___, ____];
    const failed: FailedOffer = await seal({ ...base, revision: 2, expected_version: 1, previous_digest: current.offer.digest,
      failure: { title: 'Changed QA source', source_url: current.offer.facts.source_url, gates: ['source_changed'], retry_at: null, evidence: '공구 정보 변경' },
    });
    assert.equal((await ingest(failed)).status, 202);
    await page.reload();
    await checkHero(page, 0);
    assert.equal(await low.locator('.deal-card').count(), 0);
    const [saved] = await rows<{ observed: number; invalidated: number }>(`SELECT
      (SELECT COUNT(*) FROM deal_price_history WHERE deal_id LIKE 'deal-verified-%') AS observed,
      (SELECT COUNT(*) FROM invalidated_publication_proofs WHERE deal_id LIKE 'deal-verified-%') AS invalidated`);
    assert.deepEqual(saved, { observed: 2, invalidated: 1 });
  } finally { await page.close(); }
}

try {
  await ready();
  browser = await chromium.launch();
  await matrix(browser, 'seed-only', 0);
  const untilMidnight = kstMidnight(Date.now()) - Date.now();
  if (untilMidnight < 45_000) await delay(untilMidnight + 250);
  const snapshotAt = Date.now();
  await applySql('fixtures.sql', fixtures(snapshotAt));
  await matrix(browser, 'populated', 3, homeCopy.sections.closing.title);
  await navigation(browser);
  await frozenPagination(browser, kstMidnight(snapshotAt) - 500);
  await stableMedia(browser, false);
  await stableMedia(browser, true);

  for (const mode of ['native', 'delayed', 'hydrated'] as const) {
    await submitAlert(browser, 'model', mode);
    await submitAlert(browser, 'seller', mode);
  }
  const result = await d1(['execute', 'DB', '--json', '--command',
    'SELECT model_id, seller_id, COUNT(*) AS count FROM alert_subscriptions GROUP BY model_id, seller_id ORDER BY seller_id']);
  assert.deepEqual(JSON.parse(result)[0].results, [
    { model_id: 'model-2', seller_id: null, count: 1 },
    { model_id: null, seller_id: 'seller-1', count: 1 },
  ]);

  const expiry = Date.now() + 6500;
  await applySql('transition.sql', `UPDATE deals SET ends_at=${quote(iso(expiry))} WHERE id IN ('qa-today-a','qa-today-b');`);
  const page = await browser.newPage({ viewport: dimensions[0] });
  await page.route(imageURL, route => route.fulfill({ contentType: 'image/png', body: stubImage }));
  let refreshes = 0;
  await page.goto(origin);
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/' && req.isNavigationRequest()) refreshes++;
  });
  await checkHero(page, 3);
  await checkHero(page, 1);
  assert.equal(refreshes, 1, 'simultaneous expiries share one refresh');
  await page.close();
  await matrix(browser, 'no-closings-today', 1, homeCopy.sections.discount.title);
  const corrected = await admin('deals/qa-later', {
    action: 'correct', expected_version: 1, request_id: randomUUID(), reason: 'QA verified title correction',
    model_id: 'model-1', price: 400000, title: 'Corrected QA offer', include_image: false,
    starts_at: iso(snapshotAt - 10_800_000), ends_at: iso(kstMidnight(snapshotAt) + 86_400_000),
  });
  assert.equal(corrected.status, 200, 'local workerd must commit the correction');
  const withdrawnResult = await admin('deals/qa-later', {
    action: 'withdraw', expected_version: 2, request_id: randomUUID(), reason: 'QA verified withdrawal',
  });
  assert.equal(withdrawnResult.status, 200, 'local workerd must commit the withdrawal');
  const withdrawn = await browser.newPage();
  await withdrawn.goto(origin);
  await checkHero(withdrawn, 0);
  assert.equal((await withdrawn.request.get(`${origin}/deals/qa-later`)).status(), 404);
  await withdrawn.close();
  await verifyPublicationHistory(browser);
  await applySql('health-failure.sql', 'ALTER TABLE deal_price_history RENAME TO qa_unavailable_history;');
  const health = await fetch(origin, { headers: { accept: 'application/json' } });
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false });
  await applySql('health-recovery.sql', 'ALTER TABLE qa_unavailable_history RENAME TO deal_price_history;');
  await ready();
  console.log(`Hook UX passed. Screenshots and measurements: ${output}`);
} finally {
  await browser?.close();
  if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
  await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => worker.kill('SIGKILL'))]);
  await writeFile(resolve(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await writeFile(resolve(output, 'worker.log'), workerLog.replaceAll(adminToken, '[redacted]').replaceAll(ingestToken, '[redacted]'));
}
