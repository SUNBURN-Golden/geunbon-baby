import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { HaltError } from './browser';
import { health, loginDiagnosticState } from './health';
import { redactionRules, type RedactionRule } from './redact';

// Runs only after a halt; no navigation, clicks or requests are performed here.
// This function is self-contained because Playwright evaluates it in the page.
export function redactDiagnosticPage(rules: RedactionRule[]) {
  // Avoid nested named functions: tsx adds __name helpers that are unavailable
  // when Playwright serializes this function into the browser context.
  let rootMasked = false;
  const roots: (Document | ShadowRoot)[] = [document];
  for (const root of roots) {
    // Inspect containers before editing any text nodes: a secret can span
    // sibling/nested nodes without appearing in any individual text node.
    for (const element of root.querySelectorAll('*')) {
      const text = element.textContent ?? '';
      if (rules.some(rule => new RegExp(rule.source, rule.flags).test(text))) {
        if (element === document.documentElement || element === document.body) rootMasked = true;
        const style = (element as HTMLElement | SVGElement).style;
        style.setProperty('visibility', 'hidden', 'important');
        // Opacity also masks descendants that explicitly restore visibility.
        style.setProperty('opacity', '0', 'important');
      }
    }
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
        element.style.setProperty('opacity', '0', 'important');
      }
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return { root_masked: rootMasked };
}

export async function captureHalt(crawlerDir: string, reason: HaltError['reason'], page?: Page, signal?: AbortSignal) {
  const username = process.env.AGAMAJUNG_IG_USER;
  const rules = [
    ...redactionRules(),
    { source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g', replacement: '[redacted]' },
    ...(username ? [username, encodeURIComponent(username)].map(value => ({ source: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'g', replacement: '[redacted]' })) : []),
    { source: /((?:sessionid|ds_user_id|csrftoken|ig_did)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;&<>"']+)/.source, flags: 'gi', replacement: '$1[redacted]' },
  ];
  const scrub = (value: string) => rules.reduce((text, rule) => text.replace(new RegExp(rule.source, rule.flags), rule.replacement), value);
  let url = '[unavailable]';
  let path = '[unavailable]';
  let text = '[visible text unavailable]';
  let bodyLength: number | null = null;
  let rootMasked: boolean | null = null;
  let maskFailed = false;
  try { if (page && !signal?.aborted) url = scrub(page.url()); } catch { /* Closed page. */ }
  try { path = new URL(url).pathname; } catch { /* URL unavailable. */ }
  try {
    if (page && !signal?.aborted) {
      const original = await page.locator('body').innerText({ timeout: 5000 });
      bodyLength = original.length;
      text = scrub(original);
    }
  }
  catch { if (!signal?.aborted) health('warn', { scope: 'halt_text' }); }
  const observation = loginDiagnosticState();
  const state = reason === 'challenge' || reason === 'blocked' ? reason : observation.state ?? 'unknown';
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    health('halt', { ...observation, state, body_length: bodyLength, root_masked: signal?.aborted ? null : rootMasked, reason, path, preview: text.replace(/\s+/g, ' ').trim().slice(0, 200) });
  };
  // A frame evaluation has no Playwright timeout. Keep the halt observable if
  // the orchestrator aborts diagnostics while that evaluation is still pending.
  signal?.addEventListener('abort', report, { once: true });
  let maskTimer: ReturnType<typeof setTimeout> | undefined;
  let abortMask: (() => void) | undefined;
  let masking = true;
  try {
    if (page && !signal?.aborted) {
      // Bound the entire scrub, including all frames. A late result must never
      // enable a screenshot or resume masking after timeout/abort.
      const interrupted = new Promise<never>((_, reject) => {
        maskTimer = setTimeout(() => reject(new Error('diagnostic mask timeout')), 5000);
        abortMask = () => reject(new Error('diagnostic mask aborted'));
        signal?.addEventListener('abort', abortMask, { once: true });
      });
      const mask = async () => {
        let masked: boolean | null = null;
        for (const frame of page.frames()) {
          if (!masking || signal?.aborted) break;
          const result = await frame.evaluate(redactDiagnosticPage, rules);
          if (typeof result?.root_masked === 'boolean') masked = (masked ?? false) || result.root_masked;
        }
        return masked;
      };
      rootMasked = await Promise.race([mask(), interrupted]);
    }
  } catch { maskFailed = true; rootMasked = null; }
  finally {
    masking = false;
    clearTimeout(maskTimer);
    if (abortMask) signal?.removeEventListener('abort', abortMask);
    report();
    signal?.removeEventListener('abort', report);
  }
  if (signal?.aborted) return;

  const logs = resolve(crawlerDir, 'logs');
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const base = resolve(logs, `halt-${stamp}`);
  try {
    await mkdir(logs, { recursive: true, mode: 0o700 });
    if (signal?.aborted) return;
    await chmod(logs, 0o700);
    if (signal?.aborted) return;
    await writeFile(`${base}.txt`, `Reason: ${reason}\nURL: ${url}\nState: ${state}\nBody length: ${bodyLength ?? 'unknown'}\nRoot masked: ${rootMasked ?? 'unknown'}\n\n${text}\n`, { mode: 0o600, flag: 'wx', signal });
    await chmod(`${base}.txt`, 0o600);
  } catch { health('warn', { scope: 'halt_text_write' }); }

  if (!page || signal?.aborted) return;
  try {
    // If any frame could not be scrubbed, never save an unsafe screenshot.
    if (maskFailed) throw new Error('diagnostic mask unavailable');
    if (signal?.aborted) return;
    const png = await page.screenshot({ type: 'png', timeout: 5000, animations: 'disabled' });
    if (signal?.aborted) return;
    await writeFile(`${base}.png`, png, { mode: 0o600, flag: 'wx', signal });
    await chmod(`${base}.png`, 0o600);
  } catch { if (!signal?.aborted) health('warn', { scope: 'halt_screenshot' }); }
}
