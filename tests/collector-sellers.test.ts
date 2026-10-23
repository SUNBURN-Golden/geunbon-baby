import { expect, test } from 'vitest';
import { fixture, intake, price, source } from './helpers/collector';
import type { Seller } from '../crawler/src/store';
test('legacy snapshot import is read-only, resumable and idempotent with separate historical hits',()=>{
 const f=fixture();try{
  const raw={candidates:{public_shop:{handle:'public_shop',found_via:'pangpang',sample_urls:['https://09pangpang.com/deal/1','https://09pangpang.com/deal/2'],matched_models:['model-1'],first_seen:'2026-01-01T00:00:00Z',last_seen:'2026-10-01T00:00:00Z',hits:12}}};const copy=JSON.stringify(raw);
  expect(f.store.importLegacy(raw)).toEqual({imported:1});f.reopen();expect(f.store.importLegacy(raw)).toEqual({imported:0});expect(JSON.stringify(raw)).toBe(copy);
  const s=f.store.list<Seller>('seller_candidates')[0];expect(s).toMatchObject({handle:'public_shop',found_via:'pangpang',hits:0,legacy_hits:12,first_seen:'2026-01-01T00:00:00.000Z',last_seen:'2026-10-01T00:00:00.000Z'});expect(s.sample_urls).toHaveLength(2);expect(f.store.list('seller_candidate_sources')).toHaveLength(2);
  intake(f.store,`${source.origin}/new`,{...price(),seller_handle:'public_shop'});expect(f.store.get<Seller>('seller_candidates',s.id)).toMatchObject({hits:1,legacy_hits:12,found_via:'pangpang'});f.store.reviewSeller(s.id,'manually_registered','운영자 수동 등록 확인');expect(f.store.get<Seller>('seller_candidates',s.id)?.status).toBe('manually_registered');
 }finally{f.close();}
});

test('all-rejected legacy samples remain retryable and changing last_seen does not duplicate source events',()=>{
 const f=fixture();try{
  const candidate={found_via:'legacy',sample_urls:['https://127.0.0.1/private'],matched_models:['model-1'],first_seen:'2026-01-01',last_seen:'2026-10-01',hits:5};
  expect(f.store.importLegacy({candidates:{public_shop:candidate}})).toEqual({imported:0});expect(f.store.list('legacy_imports')).toHaveLength(0);
  candidate.sample_urls=['https://gear.example.org/public'];expect(f.store.importLegacy({candidates:{public_shop:candidate}})).toEqual({imported:1});
  candidate.last_seen='2026-10-22';candidate.hits=9;f.reopen();expect(f.store.importLegacy({candidates:{public_shop:candidate}})).toEqual({imported:1});
  expect(f.store.list('seller_candidate_sources')).toHaveLength(1);expect(f.store.list<Seller>('seller_candidates')[0]).toMatchObject({hits:0,legacy_hits:9});
 }finally{f.close();}
});
