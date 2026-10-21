export type RedactionRule = { source: string; flags: string; replacement: string };

// Serializable rules are shared with the page so screenshot pixels and text use
// the same redaction. Include every configured token, not only INGEST_TOKEN.
export function redactionRules(): RedactionRule[] {
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => /password|token|secret|api[_-]?key|cookie|session/i.test(key) && value)
    .flatMap(([, value]) => [value!, encodeURIComponent(value!), new URLSearchParams({ v: value! }).toString().slice(2)])
    .sort((a, b) => b.length - a.length);
  return [
    ...[...new Set(secrets)].map(secret => ({ source: secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'g', replacement: '[redacted]' })),
    { source: '(Bearer\\s+)[A-Za-z0-9._~+/%=-]+', flags: 'gi', replacement: '$1[redacted]' },
    { source: '([\\w.-]*(?:token|password|secret|api[_-]?key)[\\w.-]*["\\\']?\\s*[:=]\\s*)(?:"[^"]*"|\'[^\']*\'|[^\\s&<>"\\\']+)', flags: 'gi', replacement: '$1[redacted]' },
    { source: '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b', flags: 'g', replacement: '[redacted]' },
    { source: '(https?://)[^/\\s@]+@', flags: 'gi', replacement: '$1[redacted]@' },
    { source: /((?:sessionid|ds_user_id|csrftoken|ig_did)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;&<>"']+)/.source, flags: 'gi', replacement: '$1[redacted]' },
    { source: /((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/.source, flags: 'gi', replacement: '$1[redacted]' },
  ];
}

export function redact(value: string): string {
  return redactionRules().reduce((text, rule) => text.replace(new RegExp(rule.source, rule.flags), rule.replacement), value);
}
