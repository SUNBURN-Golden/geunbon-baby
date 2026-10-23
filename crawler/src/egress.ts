import { isIP } from 'node:net';
import { CollectorError } from './store';
import { publicAddress } from './scheduler';

export type Cidr = { family: 4 | 6; base: bigint; bits: number; text: string };
function numeric(ip: string, family: 4 | 6): bigint {
  if (family === 4) return ip.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
  // Expand an embedded IPv4 tail before expanding IPv6 compression.
  ip = ip.replace(/\d+\.\d+\.\d+\.\d+$/, tail => {
    const n = numeric(tail, 4);
    return `${(n >> 16n).toString(16)}:${(n & 65535n).toString(16)}`;
  });
  const [left, right] = ip.split('::');
  const head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
  const parts = right === undefined ? head : [...head, ...Array<string>(8-head.length-tail.length).fill('0'), ...tail];
  return parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
}
function parse(text: string): Cidr {
  const parts = text.split('/'), family = isIP(parts[0]);
  if (parts.length !== 2 || (family !== 4 && family !== 6) || parts[0].includes('%') || !/^\d+$/.test(parts[1])) throw new CollectorError('trusted_egress_config');
  const bits = Number(parts[1]), width = family === 4 ? 32 : 128;
  if (bits > width) throw new CollectorError('trusted_egress_config');
  const shift = BigInt(width-bits), base = (numeric(parts[0], family) >> shift) << shift;
  return {family, base, bits, text};
}
function high(c: Cidr) { return c.base + (1n << BigInt((c.family === 4 ? 32 : 128)-c.bits))-1n; }
const forbidden = ['0.0.0.0/8','127.0.0.0/8','169.254.0.0/16','224.0.0.0/3','::/128','::1/128','fe80::/10','ff00::/8','::ffff:0:0/96'].map(parse);
export function parseTrustedEgress(raw: string | undefined): Cidr[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean).map(text => {
    const c = parse(text);
    if (forbidden.some(f => f.family === c.family && c.base <= high(f) && f.base <= high(c))) throw new CollectorError('trusted_egress_config');
    return c;
  });
}
export function inCidr(ip: string, cidr: Cidr): boolean {
  const family = isIP(ip);
  if (family !== cidr.family || ip.includes('%')) return false;
  const n = numeric(ip, family);
  if (family === 6 && n >> 32n === 65535n) return false;
  return n >= cidr.base && n <= high(cidr);
}
export function addressAllowed(ip: string, trusted: Cidr[]): boolean {
  return publicAddress(ip) || trusted.some(c => inCidr(ip, c));
}
