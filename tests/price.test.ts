import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../seed/models.json';
import { comparison, money, type Model } from '../lib/data';
const model = (i: number): Model => { const m = models[i - 1]; return { id: `model-${i}`, brand: m.brand, name: m.model, category: m.category, importer: m.kr_importer, official_price: m.kr_official_price_krw, source_url: m.source_url, checked: m.checked, verify_level: m.verify_level, note: m.note }; };
test('missing prices are never zero or inferred from notes', () => { assert.equal(money(null), '정보 없음'); assert.equal(money(undefined), '정보 없음'); assert.equal(money(0), '0원'); assert.equal(comparison(model(40), []).official.price, null); });
test('beech, oak and sets have separate overseas configurations', () => { assert.equal(comparison(model(1), []).overseas.length, 3); assert.deepEqual(comparison(model(2), []).overseas.map(p => p.krw), [409420]); assert.deepEqual(comparison(model(4), []).overseas.map(p => p.krw), [448236]); assert.equal(comparison(model(5), []).overseas.length, 0); });
test('unrelated products never inherit Tripp Trapp figures', () => { assert.equal(comparison(model(6), []).used, null); assert.deepEqual(comparison(model(27), []).overseas, []); });
test('used prices preserve asking-price context and unprovided verification', () => { const p = comparison(model(1), []); assert.equal(p.used?.chair_used.median, 350000); assert.match(p.used!.notice, /실거래가가 아닙니다/); assert.equal(p.used?.verify_level, 'seed_unspecified'); assert.deepEqual(p.gonggu, []); });
