// Preload before crawler entrypoints: these guards do not depend on Vitest mocks
// or the dry-run implementation. Never read an operator's secret file.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const browserStub = `
  const forbidden = () => { throw new Error('Browser launch forbidden in child tests'); };
  export const chromium = { launch: forbidden, launchPersistentContext: forbidden };
  export default { chromium };
`;
const browserURL = `data:text/javascript,${encodeURIComponent(browserStub)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'playwright' || specifier === 'playwright-core') return { url: browserURL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const forbidden = message => () => { throw new Error(message); };
childProcess.spawn = forbidden('Browser process spawn forbidden in child tests');
childProcess.execFile = forbidden('Browser process execFile forbidden in child tests');
globalThis.fetch = forbidden('Network fetch forbidden in child tests');
net.Socket.prototype.connect = forbidden('Network socket forbidden in child tests');
tls.connect = forbidden('Network TLS forbidden in child tests');
dns.lookup = forbidden('Network DNS forbidden in child tests');
dns.promises.lookup = forbidden('Network DNS forbidden in child tests');

const loadEnvFile = process.loadEnvFile.bind(process);
process.loadEnvFile = () => {
  if (process.env.AGAMAJUNG_TEST_ENV_FILE) return loadEnvFile(process.env.AGAMAJUNG_TEST_ENV_FILE);
  throw Object.assign(new Error('Env file forbidden in child tests'), { code: 'ENOENT' });
};
syncBuiltinESMExports();
