import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashJson } from '../../../shared/official-seller';

export function siteClient(raw: string, token: string) {
  const url = new URL(raw);
  const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if (url.origin !== raw.replace(/\/$/, '') || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      !token || token.trim() !== token) throw new Error('site_configuration');
  return async (path: string, payload?: unknown) => {
    const response = await fetch(`${url.origin}/api/v1/admin/${path}`, {
      method:payload === undefined ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(20_000),
      headers:{ authorization:`Bearer ${token}`, 'content-type':'application/json' },
      ...(payload === undefined ? {} : { body:JSON.stringify(payload) }),
    });
    if (!response.ok) throw new Error(`site_${response.status}`);
    return response.json();
  };
}
export function checkpointFile(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp,path);
    const dir = openSync(dirname(path),'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (e) {
    try { unlinkSync(temp); } catch { /* temporary file was renamed */ }
    throw e;
  }
}
type Operation = Record<string, unknown> & { request_id: string };
type Receipt = { request_id: string; result: unknown };
export type AppliedPacket = { receipts: Receipt[]; newlyAccepted: number };
export async function applyPacket(packet: { version: number; operations: Operation[] }, checkpoint: string,
  send: (operation: Operation) => Promise<unknown>): Promise<AppliedPacket> {
  if (packet.version !== 1 || !Array.isArray(packet.operations) || packet.operations.some(o =>
    !o || typeof o.request_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(o.request_id))) throw new Error('packet_invalid');
  if (new Set(packet.operations.map(o => o.request_id)).size !== packet.operations.length) throw new Error('packet_duplicate_operation');
  const digest = await hashJson(packet);
  let state: { version: number; digest: string; receipts: { request_id: string; result: unknown }[] } = { version:1,digest,receipts:[] };
  try { state = JSON.parse(readFileSync(checkpoint,'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('checkpoint_invalid'); }
  if (state.version !== 1 || state.digest !== digest || !Array.isArray(state.receipts) || state.receipts.length > packet.operations.length ||
    state.receipts.some((receipt, i) => receipt?.request_id !== packet.operations[i].request_id)) throw new Error('checkpoint_mismatch');
  const previouslyCheckpointed = state.receipts.length;
  for (const operation of packet.operations.slice(previouslyCheckpointed)) {
    const result = await send(operation);
    state.receipts.push({request_id:operation.request_id,result});
    checkpointFile(checkpoint,state);
  }
  return { receipts: state.receipts, newlyAccepted: state.receipts.length - previouslyCheckpointed };
}
