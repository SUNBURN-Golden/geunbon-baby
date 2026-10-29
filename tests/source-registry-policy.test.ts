import { expect, test } from 'vitest';
import { entryReason, registryUrl, scopeReason, validateEntry } from '../crawler/src/source-registry/policy';
import { loadRegistrySeed } from '../crawler/src/source-registry/seed';
import type { SourceRegistryEntry } from '../crawler/src/source-registry/types';
const NOW=Date.parse('2026-10-28T00:00:00Z');
function entry(): SourceRegistryEntry {
  return {...loadRegistrySeed().find(e=>e.source_id==='public:cpsc')!,source_id:'fixture',origin:'https://example.org',scope_hosts:['example.org'],allowed_path_prefixes:['/products/'],path_patterns:['^/products/[a-z-]+$'],query_keys:['id'],collectable_fields:['manual_url'],blocked_paths:['/review'],unsupported:[],permission:{robots:{status:'allowed',checked_at:'2026-10-27T00:00:00Z',evidence:'fixture robots'},terms:{status:'allowed',checked_at:'2026-10-27T00:00:00Z',evidence:'fixture terms'}},reevaluate_at:'2026-11-28T00:00:00Z'};
}
const url=()=>registryUrl('https://example.org/products/item');
test.each([
  'https://example.org/products/%69tem','https://example.org/products/%2fitem','https://example.org/products/%252fitem',
  'https://example.org/products/../item','https://example.org/products/%2e%2e/item','https://example.org/products//item',
  'https://example.org/products/item;extra','https://example.org/products/it\\em','https://example.org/products/item#fragment',
  'https://example.org/products/item\n','https://example.org/products/%zz','https://user:pass@example.org/products/item',
  'http://example.org/products/item','https://example.org:8443/products/item','https://example.org/products/login',
  'HTTPS://example.org/products/%69tem','https:example.org/products/item','https:///example.org/products/item',
])('ambiguous/encoded/private paths fail before normalization: %s',raw=>expect(()=>registryUrl(raw)).toThrow());
test('origin, hostname and both path constraints are AND requirements',()=>{
  const e=entry();expect(scopeReason(e,url())).toBeUndefined();
  expect(scopeReason({...e,scope_hosts:['other.example.org']},url())).toBe('host_mismatch');
  expect(scopeReason({...e,allowed_path_prefixes:[]},url())).toBe('path_mismatch');
  expect(scopeReason({...e,path_patterns:['^/other/']},url())).toBe('path_mismatch');
  expect(scopeReason(e,registryUrl('https://example.org/products-other/item'))).toBe('path_mismatch');
  expect(scopeReason(e,registryUrl('https://example.org/products/item?id=fixture'))).toBeUndefined();
  for(const query of ['?unknown=x','?id=x&id=y','?id=','?id=a%2Fb'])expect(scopeReason(e,registryUrl('https://example.org/products/item'+query))).toBe('query_denied');
});
test('block and unsupported scopes, inactive states, permission and reevaluation always deny',()=>{
  const e=entry();expect(entryReason(e,url(),['manual_url'],NOW)).toBeUndefined();
  for(const [patch,reason] of [
    [{blocked_paths:['/products/']},'blocked_path'],
    [{unsupported:[{scope:'*',reason:'fixture unsupported'}]},'unsupported'],
    [{unsupported:[{scope:'/products/',reason:'fixture unsupported'}]},'unsupported'],
    [{unsupported:[{scope:'manual_url',reason:'fixture unsupported'}]},'unsupported'],
    [{status:'excluded'},'inactive'],[{status:'deprioritized'},'inactive'],
    [{permission:{...e.permission,robots:{status:'unknown',checked_at:null,evidence:null}}},'permission_unknown'],
    [{permission:{...e.permission,terms:{status:'disallowed',checked_at:'2026-10-27T00:00:00Z',evidence:'fixture denial'}}},'permission_denied'],
    [{permission:{...e.permission,terms:{status:'allowed',checked_at:'2026-10-29T00:00:00Z',evidence:'fixture future'}}},'permission_unknown'],
    [{reevaluate_at:null},'reevaluation_due'],[{reevaluate_at:new Date(NOW).toISOString()},'reevaluation_due'],
  ] as [Partial<SourceRegistryEntry>,string][])expect(entryReason({...e,...patch},url(),['manual_url'],NOW)).toBe(reason);
});
test('schema rejects wildcard/alias hosts, ungrounded permission, invalid fields and scope',()=>{
  const e=entry();expect(validateEntry(e)).toEqual(e);
  for(const patch of [
    {scope_hosts:['*.example.org']},{scope_hosts:['example.org','alias.example.org']},{origin:null},
    {allowed_path_prefixes:['products/']},{allowed_path_prefixes:['/products/../']},
    {collectable_fields:['invented']},{permission:{...e.permission,terms:{status:'allowed',checked_at:null,evidence:null}}},
    {status:'active'},{retention:{...e.retention,snippets_days:-1}},{unsupported:[{scope:'*',reason:''}]},
  ])expect(()=>validateEntry({...e,...patch} as SourceRegistryEntry)).toThrow();
});
