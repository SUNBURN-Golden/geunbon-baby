import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = resolve(import.meta.dirname);
const session = resolve(root, '.session');
const cache = resolve(root, '.cache');
const username = process.env.AGAMAJUNG_IG_USER ?? 'jaytparkitrighthere@gmail.com';
const delay = (min = 15000, max = 45000) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
const MAX_ACCOUNTS = 3;
const MAX_POSTS = 2;
const MAX_STORIES = 3;
async function ocr(page: Page): Promise<string> {
  if (process.env.AGAMAJUNG_OCR !== '1') return '';
  const image = page.locator('img').filter({ visible: true }).last();
  if (!await image.count()) return '';
  const file = resolve(cache, 'story.png');
  await image.screenshot({ path: file });
  await chmod(file, 0o600);
  try { const { stdout } = await promisify(execFile)('tesseract', [file, 'stdout', '-l', process.env.AGAMAJUNG_OCR_LANG ?? 'kor+eng'], { timeout: 30000, maxBuffer: 32768 }); return stdout.trim(); }
  catch { console.info('OCR 미사용: tesseract 설치 및 언어팩을 확인하세요.'); return ''; }
}
async function checkpoint(page: Page) {
  if (/challenge|checkpoint|accounts\/login/.test(page.url())) throw new Error('수동 인증이 필요합니다. 자동 재시도하지 않습니다.');
}
async function login(context: BrowserContext, page: Page) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await delay();
  if (await page.locator('input[name="username"]').count()) {
    const password = process.env.AGAMAJUNG_IG_PASSWORD;
    if (!password) throw new Error('AGAMAJUNG_IG_PASSWORD 환경변수가 필요합니다.');
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await delay(20000, 30000);
  }
  await checkpoint(page);
  await context.storageState({ path: resolve(session, 'state.json') });
  await chmod(resolve(session, 'state.json'), 0o600);
}
async function main() {
  const endpoint = process.env.AGAMAJUNG_API_URL;
  const token = process.env.INGEST_TOKEN;
  if (!endpoint || !token) throw new Error('AGAMAJUNG_API_URL과 INGEST_TOKEN이 필요합니다.');
  const api = new URL('/api/v1/ingest', endpoint);
  if (api.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(api.hostname)) throw new Error('외부 API는 HTTPS가 필요합니다.');
  await mkdir(session, { recursive: true, mode: 0o700 }); await chmod(session, 0o700);
  await mkdir(cache, { recursive: true, mode: 0o700 }); await chmod(cache, 0o700);
  let state: string | undefined;
  try { await readFile(resolve(session, 'state.json')); state = resolve(session, 'state.json'); } catch {}
  const browser = await chromium.launch({ headless: process.env.AGAMAJUNG_HEADLESS !== '0' });
  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
  try {
    await login(context, page);
    let seen = new Set<string>();
    try { seen = new Set(JSON.parse(await readFile(resolve(cache, 'seen.json'), 'utf8')) as string[]); } catch {}
    let cycle = 0;
    while (!stopped) {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' }); await delay(); await checkpoint(page);
      await page.getByRole('link', { name: /^Instagram$/ }).first().click();
      await delay();
      await page.getByText(/^(Following|팔로잉)$/, { exact: true }).first().click();
      await delay(); await checkpoint(page);
      const accounts = [...new Set(await page.locator('a[href]').evaluateAll(links => links.map(a => a.getAttribute('href') ?? '').filter(h => /^\/[A-Za-z0-9._]+\/$/.test(h) && !/^\/(explore|reels|direct|accounts|stories)\//.test(h))))];
      if (!accounts.length) throw new Error('팔로잉 피드를 확인할 수 없습니다. UI 변경을 확인하세요.');
      const offset = (cycle++ * MAX_ACCOUNTS) % accounts.length;
      for (let i = 0; i < Math.min(MAX_ACCOUNTS, accounts.length) && !stopped; i++) {
        const account = accounts[(offset + i) % accounts.length].replaceAll('/', '');
        await page.goto(`https://www.instagram.com/${account}/`, { waitUntil: 'domcontentloaded' }); await delay(); await checkpoint(page);
        const follow = page.getByRole('button', { name: /^(Following|팔로잉)/ }).first();
        if (!await follow.count() || !await follow.isVisible()) continue;
        const posts = [...new Set(await page.locator('a[href*="/p/"],a[href*="/reel/"]').evaluateAll(links => links.map(a => (a as HTMLAnchorElement).href)))].slice(0, MAX_POSTS);
        const story = await page.locator(`a[href^="/stories/${account}/"]`).count() > 0;
        const send = async (url: string, kind: 'post' | 'story', text: string) => {
          if (seen.has(url) || !text.trim()) return;
          const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ source_url: url, account, kind, text: text.slice(0, 18000), captured_at: new Date().toISOString() }), signal: AbortSignal.timeout(30000), redirect: 'error' });
          if (!response.ok) throw new Error('수집 API 요청 실패. 인증·응답 상태를 별도로 확인하세요.');
          seen.add(url); await writeFile(resolve(cache, 'seen.json'), JSON.stringify([...seen].slice(-10000)), { mode: 0o600 });
          console.info('검수 대기열로 전송했습니다.');
        };
        for (const url of posts) {
          if (stopped || seen.has(url)) continue;
          await page.goto(url, { waitUntil: 'domcontentloaded' }); await delay(); await checkpoint(page);
          const caption = await page.locator('article').innerText();
          await send(new URL(page.url()).origin + new URL(page.url()).pathname, 'post', caption);
        }
        if (story && !stopped) {
          await page.goto(`https://www.instagram.com/stories/${account}/`, { waitUntil: 'domcontentloaded' }); await delay();
          for (let n = 0; n < MAX_STORIES && !stopped; n++) {
            await checkpoint(page);
            const url = new URL(page.url());
            if (!url.pathname.startsWith(`/stories/${account}/`) || !/^\d+$/.test(url.pathname.split('/')[3] ?? '')) break;
            await send(url.origin + url.pathname, 'story', await ocr(page));
            const next = page.getByRole('button', { name: /^(Next|다음)$/ }).first();
            if (!await next.count()) break;
            await next.click(); await delay();
          }
        }
      }
      if (process.env.AGAMAJUNG_ONCE === '1') break;
      await delay(3600000, 5400000);
    }
  } finally { await context.close(); await browser.close(); }
}
main().catch(() => { console.error('크롤러 중단: 인증·환경변수·화면 구조를 수동 점검하세요. 원시 오류와 인증 정보는 기록하지 않습니다.'); process.exitCode = 1; });
