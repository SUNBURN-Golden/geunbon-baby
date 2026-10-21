import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { HaltError } from './browser';
import { health } from './health';
import { redact, redactionRules, type RedactionRule } from './redact';

// Runs only after a halt; no navigation, clicks or requests are performed here.
// This function is self-contained because Playwright evaluates it in the page.
export function redactDiagnosticPage(rules: RedactionRule[]) {
  // Avoid nested named functions: tsx adds __name helpers that are unavailable
  // when Playwright serializes this function into the browser context.
  const roots: (Document | ShadowRoot)[] = [document];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('script, style')) node.textContent = rules.reduce((text, rule) => text.replace(new RegExp(rule.source, rule.flags), rule.replacement), node.textContent ?? '');
    }
    for (const element of root.querySelectorAll('*')) {
      for (const name of ['title', 'alt', 'placeholder', 'value', 'aria-label']) {
        const value = element.getAttribute(name);
        if (value !== null) element.setAttribute(name, rules.reduce((text, rule) => text.replace(new RegExp(rule.source, rule.flags), rule.replacement), value));
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.value = '[redacted]';
        element.style.setProperty('visibility', 'hidden', 'important');
      }
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
}

export async function captureHalt(crawlerDir: string, reason: HaltError['reason'], page?: Page) {
  let url = '[unavailable]';
  let path = '[unavailable]';
  let text = '[visible text unavailable]';
  try { if (page) url = redact(page.url()); } catch { /* Closed page. */ }
  try { path = new URL(url).pathname; } catch { /* URL unavailable. */ }
  try { if (page) text = redact(await page.locator('body').innerText({ timeout: 5000 })); }
  catch { health('warn', { scope: 'halt_text' }); }
  health('halt', { reason, path, preview: text.replace(/\s+/g, ' ').trim().slice(0, 200) });

  const logs = resolve(crawlerDir, 'logs');
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const base = resolve(logs, `halt-${stamp}`);
  try {
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await chmod(logs, 0o700);
    await writeFile(`${base}.txt`, `Reason: ${reason}\nURL: ${url}\n\n${text}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(`${base}.txt`, 0o600);
  } catch { health('warn', { scope: 'halt_text_write' }); }

  if (!page) return;
  try {
    // Scrub before capturing. If this fails, never save an unsafe screenshot.
    for (const frame of page.frames()) await frame.evaluate(redactDiagnosticPage, redactionRules());
    const png = await page.screenshot({ type: 'png', timeout: 5000, animations: 'disabled' });
    await writeFile(`${base}.png`, png, { mode: 0o600, flag: 'wx' });
    await chmod(`${base}.png`, 0o600);
  } catch { health('warn', { scope: 'halt_screenshot' }); }
}
