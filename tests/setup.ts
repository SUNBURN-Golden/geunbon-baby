import { Socket } from 'node:net';
import { beforeEach, vi } from 'vitest';
// Tests must fail closed: no browser launch, HTTP, loopback sockets, or real fetch.
vi.mock('playwright', () => ({ chromium: { launch: vi.fn(() => { throw new Error('Browser launch forbidden in tests'); }) } }));
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in tests; mock fetch explicitly'); }));
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('Sockets forbidden in tests'); });
});
