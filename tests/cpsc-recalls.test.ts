import { expect, test } from 'vitest';
import { parseCpscRecalls, filterByBrand, mergeRecalls } from '../shared/cpsc-recalls';
import { discoverLinks } from '../crawler/src/discovery/adapters';

const row = (id: number, title = 'Stokke stroller') => ({ RecallID: id, URL: `https://www.cpsc.gov/Recalls/${id}`, Title: title, RecallDate: '2026-10-01', Products: [{ Name: title }], Manufacturers: [{ Name: 'Example' }] });
const json = JSON.stringify([row(1), row(2)]);
const xml = '<ArrayOfRecall><Recall><RecallID>1</RecallID><URL>https://www.cpsc.gov/Recalls/1</URL><Title><![CDATA[Stokke stroller]]></Title><RecallDate>2026-10-01</RecallDate><Products><Product><Name>Stokke stroller</Name></Product></Products></Recall></ArrayOfRecall>';

test('parses JSON and XML fields, empty arrays, schema failures and row cap', () => {
  expect(parseCpscRecalls(json)[0]).toMatchObject({ recall_id: '1', title: 'Stokke stroller', recall_date: '2026-10-01', product_names: ['Stokke stroller'], manufacturer_names: ['Example'] });
  expect(parseCpscRecalls(xml)[0]).toMatchObject({ recall_id: '1', title: 'Stokke stroller', product_names: ['Stokke stroller'] });
  expect(parseCpscRecalls('[]')).toEqual([]);
  expect(() => parseCpscRecalls('{}')).toThrow('cpsc_schema');
  expect(() => parseCpscRecalls('null')).toThrow('cpsc_schema');
  expect(parseCpscRecalls(JSON.stringify(Array.from({ length: 501 }, (_, i) => row(i))))).toHaveLength(500);
  expect(parseCpscRecalls('<Root>' + xml.repeat(501) + '</Root>')).toHaveLength(500);
  expect(parseCpscRecalls(JSON.stringify([row(1), { ...row(2), URL: 'javascript:alert(1)' }, { ...row(3), RecallID: 1.5 }]))).toHaveLength(1);
});

test('deduplicates RecallID and keeps only whole-word brand matches with the matched term', () => {
  expect(mergeRecalls(parseCpscRecalls(json), parseCpscRecalls(json))).toHaveLength(2);
  const rows = parseCpscRecalls(JSON.stringify([row(1, 'Egg cooker'), row(2, 'Egg Stroller recall'), row(3, 'Stokkeland chair'), row(4, 'STOKKE stroller')]));
  expect(filterByBrand(rows, ['egg stroller'])).toMatchObject([{ recall_id: '2', matched_term: 'egg stroller' }]);
  expect(filterByBrand(rows, ['Stokke']).map(r => r.recall_id)).toEqual(['4']);
  const manufacturerOnly = parseCpscRecalls(JSON.stringify([{ ...row(5, 'Chair'), Manufacturers: [{ Name: 'Stokke AS' }] }]));
  expect(filterByBrand(manufacturerOnly, ['Stokke'])).toHaveLength(1);
  expect(filterByBrand(rows, [''])).toEqual([]);
});

for (const [name, body] of [['json', json], ['xml', xml]] as const) {
  test(`Linux discovery adapter parity: ${name} IDs, URLs and dates`, () => {
    const local = parseCpscRecalls(body).map(r => [r.recall_id, r.url, r.recall_date]).sort();
    const crawler = discoverLinks(body, 'https://www.cpsc.gov/', 'cpsc').map(r => [r.recall!.id, r.url, r.recall!.date]).sort();
    expect(local).toEqual(crawler);
  });
}
