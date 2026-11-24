import { openSync, closeSync, constants, fstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CollectorStore } from '../store';
import { offerConfig } from '../offers/config';
import { providerClient } from '../offers/providers';
import { offerTransport } from '../offers/transport';
import { hashJson, verifyAttestation, type OfficialPolicy } from '../../../shared/official-seller';
import { RawStore } from '../../engine/raw-store';
import { attestOfficialSeller, officialSellerAdapters } from './official-verifier';
import { applyPacket, checkpointFile, siteClient } from './transport';
import { collectorSnapshot, fetchInventory, reconcileHistory, type Inventory } from './reconcile';

const [command, ...args] = process.argv.slice(2);
const input = Object.fromEntries(args.map(arg => /^--([a-z-]+)=(.+)$/.exec(arg)?.slice(1) ?? []));
const required = (name: string) => { if (!input[name]) throw new Error('argument_required'); return input[name]; };
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const client = () => siteClient(process.env.HISTORY_API_ORIGIN ?? 'http://127.0.0.1:8787', process.env.ADMIN_TOKEN ?? '');

async function main() {
  if (command === 'inventory') {
    const get = client();
    const inventory = await fetchInventory(p => get(`history-inventory${p.size ? `?${p}` : ''}`));
    checkpointFile(required('out'), inventory);
    process.stdout.write(JSON.stringify(inventory.manifest) + '\n');
  } else if (command === 'reconcile') {
    const get = client();
    const inventory: Inventory = input.inventory ? json(input.inventory) :
      await fetchInventory(p => get(`history-inventory${p.size ? `?${p}` : ''}`));
    const db = input.collector ? collectorSnapshot(input.collector) : null;
    let raw, store;
    try {
      if (input['raw-root']) {
        const options = json(required('artifact-policy'));
        if (!Array.isArray(options.permitted) || !options.permitted.every((id:unknown) => typeof id==='string') ||
            !Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs<1 || !statSync(input['raw-root']).isDirectory()) throw new Error('artifact_policy');
        const collector = new CollectorStore(required('collector'));
        store = collector;
        const complete = providerClient(collector,offerConfig(),offerTransport(collector,resolve(required('runtime-dir'))));
        const run = `seller-history:${crypto.randomUUID()}`;
        raw = { store:new RawStore(input['raw-root'],required('profile')),permitted:new Set<string>(options.permitted),
          maxAgeMs:options.maxAgeMs,complete:(index:0|1,request:Parameters<typeof complete>[1]) =>
            complete(index===0 ? 'extraction' : 'verification',request,{run,cycle:run}) };
      }
      const report = await reconcileHistory(inventory,input.queue ?? null,db,raw,async id => {
        try {
          const result = await get(`history-proof/${encodeURIComponent(id)}?generation=${inventory.manifest.generation}`) as { data: unknown };
          return result.data;
        } catch (error) {
          if (String(error).endsWith('site_404')) return null;
          throw error;
        }
      });
      checkpointFile(required('out'),report);
      const {inputs,packet,...summary} = report;
      void inputs;
      process.stdout.write(JSON.stringify({...summary,qualified:packet.operations.length}) + '\n');
    } finally { store?.close(); }
  } else if (command === 'apply') {
    const document = json(required('packet'));
    const packet = document.packet ?? document;
    const send = client();
    const { receipts, newlyAccepted: acceptedThisRun } = await applyPacket(packet,required('checkpoint'),operation => send('history-import',operation));
    const newlyAccepted: Record<string,number> = {};
    for (const operation of packet.operations.slice(receipts.length - acceptedThisRun, receipts.length)) {
      newlyAccepted[operation.source] = (newlyAccepted[operation.source] ?? 0)+1;
    }
    process.stdout.write(JSON.stringify({
      committed:receipts.length, packet_digest:await hashJson(packet), newly_accepted:newlyAccepted,
      distinct_campaigns:new Set(receipts.flatMap(r => (r.result as {data:{campaigns:string[]}}).data.campaigns)).size,
    }) + '\n');
  } else if (command === 'attest') {
    const policy: OfficialPolicy = json(required('policy'));
    const capture = json(required('capture'));
    const claim = json(required('claim'));
    const key_id = required('key-id');
    const fd = openSync(required('signing-key'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let encoded: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error('signing_key_permissions');
      encoded = readFileSync(fd);
    } finally { closeSync(fd); }
    const private_key = await crypto.subtle.importKey('pkcs8',Uint8Array.from(encoded),{name:'Ed25519'},false,['sign']);
    const store = new CollectorStore(required('collector'));
    try {
      const adapters = officialSellerAdapters(providerClient(store,offerConfig(),offerTransport(store,resolve(required('runtime-dir')))));
      const packet = await attestOfficialSeller(capture,claim,policy,adapters,{key_id,private_key});
      if (!packet || !await verifyAttestation(packet,policy)) throw new Error('unconfirmed_claim');
      checkpointFile(required('out'),packet);
      const receipt = await client()('official-sellers',{action:'store',packet});
      process.stdout.write(JSON.stringify(receipt) + '\n');
    } finally { store.close(); }
  } else throw new Error('history_command_required');
}
void main().catch(error => {
  const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'history_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
