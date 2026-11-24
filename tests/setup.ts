import { Socket } from 'node:net';
import { beforeEach, vi } from 'vitest';
// Tests must fail closed: no browser launch, HTTP, loopback sockets, or real fetch.
vi.mock('playwright', () => ({ chromium: { launch: vi.fn(() => { throw new Error('Browser launch forbidden in tests'); }) } }));
beforeEach(() => {
  // Model clients are constructed eagerly; tests that exercise them supply their own
  // clients. A fixture key keeps offline cycles independent of the host environment.
  vi.stubEnv('DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY || 'fixture-deepseek-api-key');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in tests; mock fetch explicitly'); }));
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('Sockets forbidden in tests'); });
});
