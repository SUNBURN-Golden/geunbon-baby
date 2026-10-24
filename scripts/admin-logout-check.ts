// Manual regression against local Wrangler only (not part of the offline Vitest suite).
// Prerequisites: matching ADMIN_TOKEN/INGEST_TOKEN in .dev.vars and this process,
// npm run db:migrate, npm run db:seed, npm run dev (wrangler dev --local),
// and installed Playwright Chromium (npx playwright install chromium).
// ADMIN_TOKEN=… INGEST_TOKEN=… npx tsx scripts/admin-logout-check.ts [--base http://localhost:8787]
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

async function main() {
  const results: string[] = [];
  const guardViolations = new Set<string>();
  const requestedUrls: string[] = [];
  let failed = false;
  let ORIGIN = '';
  let adminToken = '';
  let ingestToken = '';
  let id: string | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext;
  let tabA: Page;
  let tabB: Page;
  const check = (condition: unknown) => { if (!condition) throw new Error('Check failed'); };
  const onOrigin = (url: string) => {
    try { return new URL(url).origin === ORIGIN; } catch { return false; }
  };
  async function step(name: string, run: () => Promise<void> | void) {
    try {
      await run();
      check(guardViolations.size === 0);
      results.push(`PASS ${name}`);
    } catch {
      failed = true;
      results.push(`FAIL ${name}`);
      // Never print raw Playwright/fetch errors, headers, bodies, URLs or tokens.
      throw new Error('Step failed');
    }
  }
  async function local(path: string, init: RequestInit = {}) {
    const url = new URL(path, ORIGIN);
    if (!onOrigin(url.href) || url.username || url.password) {
      guardViolations.add('API origin');
      throw new Error('Local API guard');
    }
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) {
      guardViolations.add('API redirect');
      throw new Error('Local API redirect');
    }
    return response;
  }
  async function loginForm(page: Page) {
    await page.getByLabel('ADMIN_TOKEN', { exact: true }).waitFor({ state: 'visible' });
    check(await page.getByRole('heading', { name: '게시 전 검수', exact: true }).count() === 0);
  }

  try {
    await step('local-only configuration', () => {
      const args = process.argv.slice(2);
      check(args.length === 0 || (args.length === 2 && args[0] === '--base'));
      const base = new URL(args[1] ?? 'http://localhost:8787');
      check(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
      check(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash);
      ORIGIN = base.origin;
      adminToken = process.env.ADMIN_TOKEN ?? '';
      ingestToken = process.env.INGEST_TOKEN ?? '';
      check(adminToken && ingestToken && adminToken !== ingestToken);
    });

    await step('create pending local fixture', async () => {
      const response = await local('/api/v1/ingest', {
        method: 'POST',
        headers: { authorization: `Bearer ${ingestToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          // Stored as a string only; the browser check never opens this URL.
          source_url: `https://www.instagram.com/p/agamajung-logout-check-${Date.now()}/`,
          account: 'agamajung-logout-check',
          text: '[local fixture] admin logout regression — not real data',
          kind: 'post',
          captured_at: new Date().toISOString(),
        }),
      });
      check(response.status === 202);
      const body = await response.json() as { data?: { id?: unknown; status?: unknown } };
      if (typeof body.data?.id === 'string' && body.data.id) id = body.data.id;
      check(id && body.data?.status === 'pending');
    });

    await step('browser context guard', async () => {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ baseURL: ORIGIN, serviceWorkers: 'block' });
      context.setDefaultTimeout(15000);
      context.on('request', request => {
        requestedUrls.push(request.url());
        if (!onOrigin(request.url())) guardViolations.add('Browser request');
      });
      context.on('page', page => {
        if (page.url() !== 'about:blank' && !onOrigin(page.url())) guardViolations.add('New page');
      });
      // Context-wide and installed before newPage(): covers both tabs and popups.
      await context.route('**/*', async route => {
        const requestUrl = route.request().url();
        if (!onOrigin(requestUrl)) {
          guardViolations.add('Browser origin');
          await route.abort();
          return;
        }
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
          const location = response.headers()['location'];
          // Enhanced Server Actions may use x-action-redirect instead of Location.
          const actionRedirect = response.headers()['x-action-redirect']?.split(';')[0];
          const targets = [actionRedirect, response.status() >= 300 && response.status() < 400 ? location : undefined];
          if (targets.some(target => target && !onOrigin(new URL(target, requestUrl).href))) {
            guardViolations.add('Browser redirect');
            await route.abort();
            return;
          }
          // The browser follows same-origin redirects as new guarded requests.
          await route.fulfill({ response });
        } catch {
          guardViolations.add('Browser routing');
          await route.abort().catch(() => {});
        }
      });
      tabA = await context.newPage();
    });

    await step('login cookie attributes', async () => {
      await tabA.goto('/admin');
      await tabA.getByLabel('ADMIN_TOKEN', { exact: true }).fill(adminToken);
      await tabA.getByRole('button', { name: '안전하게 들어가기', exact: true }).click();
      await tabA.getByRole('heading', { name: '게시 전 검수', exact: true }).waitFor({ state: 'visible' });
      const cookies = (await context.cookies(`${ORIGIN}/admin`)).filter(cookie => cookie.name === 'agamajung_admin');
      check(cookies.length === 1);
      const cookie = cookies[0];
      check(cookie.path === '/admin' && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.secure);
      const now = Date.now() / 1000;
      check(cookie.expires > now && cookie.expires <= now + 3600);
    });

    await step('logout with a stale second tab', async () => {
      tabB = await context.newPage();
      await tabB.goto('/admin');
      await tabB.getByRole('heading', { name: '게시 전 검수', exact: true }).waitFor({ state: 'visible' });
      // Keep this queue loaded while tab A clears their shared browser cookie.
      await tabA.getByRole('button', { name: '로그아웃', exact: true }).click();
      await loginForm(tabA);
      check(!(await context.cookies(`${ORIGIN}/admin`)).some(cookie => cookie.name === 'agamajung_admin'));
    });

    await step('next admin request shows login', async () => {
      await tabA.reload();
      await loginForm(tabA);
    });

    await step('stale review action rejects logged-out browser', async () => {
      const form = tabB.locator('form').filter({ has: tabB.locator(`input[name="id"][value=${JSON.stringify(id)}]`) });
      check(await form.count() === 1);
      await form.getByRole('button', { name: '반려', exact: true }).click();
      await tabB.waitForURL(`${ORIGIN}/admin?error=auth`);
      await loginForm(tabB);
    });

    await step('fixture remains pending', async () => {
      const response = await local('/api/v1/admin/queue', { headers: { authorization: `Bearer ${adminToken}` } });
      check(response.status === 200);
      const body = await response.json() as { data?: { id: string; status: string }[] };
      check(Array.isArray(body.data) && body.data.some(item => item.id === id && item.status === 'pending'));
    });
  } catch {
    failed = true;
  } finally {
    if (id) {
      try {
        await step('cleanup local fixture', async () => {
          const response = await local(`/api/v1/admin/review/${encodeURIComponent(id!)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'reject' }),
          });
          check(response.status === 200 || response.status === 409);
        });
      } catch { /* Reported by step; still close the browser. */ }
    }
    if (browser) {
      try { await step('close browser', () => browser!.close()); } catch { /* Reported by step. */ }
    }
    if (guardViolations.size || requestedUrls.some(url => !onOrigin(url))) {
      failed = true;
      results.push('FAIL local-only traffic guard');
    } else if (ORIGIN) results.push('PASS local-only traffic guard');
    console.log(results.join('\n'));
    console.log(failed ? 'FAIL admin logout regression' : 'PASS admin logout regression');
    process.exitCode = failed ? 1 : 0;
  }
}

void main().catch(() => {
  console.error('FAIL admin logout check setup');
  process.exitCode = 1;
});
