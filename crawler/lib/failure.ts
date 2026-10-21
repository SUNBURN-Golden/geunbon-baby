import { redact } from './redact';

// Never inspect arbitrary thrown objects, causes, request headers or error.input.
// Playwright stacks can include credential values and URLs in their call logs.
const scrub = (value: string) => redact(value)
  .replace(/https?:\/\/[^\s<>"']+/gi, url => url.replace(/[?#].*$/, '?[redacted]'))
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]')
  .slice(0, 12_000);

export function failureDetails(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { error_name: 'NonError', error_message: '[non-Error exception]' };
  const code = (error as NodeJS.ErrnoException).code;
  return {
    error_name: scrub(error.name),
    error_message: scrub(error.message),
    ...(typeof code === 'string' ? { error_code: scrub(code) } : {}),
    ...(error.stack ? { error_stack: scrub(error.stack) } : {}),
  };
}
