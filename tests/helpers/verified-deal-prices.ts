import { readFileSync } from 'node:fs';
import { digest, PRICE_MODELS, PRICE_VERIFIER, type Configuration, type PriceEvidence, type Reading } from '../../shared/deal-price-evidence';
import { productText } from '../../crawler/src/deal-prices/verify';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/verified-deal-prices/${name}.html`, import.meta.url), 'utf8');
export const offerHtml = fixture('offer');
export const officialHtml = fixture('official');
export const officialUrl = 'https://official.example.com/products/test-model';
export const officialApproval = { id: 'a'.repeat(64), revision: 2 };
export const officialScope = { ...officialApproval, url: officialUrl, brand: 'testbrand', model: 'testmodel',
  approved_at: '2026-10-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' };
export const checkedAt = '2026-11-22T00:00:00.000Z';
export const endsAt = '2026-11-24T14:59:59.999Z';
export const startsAt = '2026-11-01T00:00:00.000Z';

export function mockReading(text: string, official: boolean): Reading {
  const span = (prefix: string) => {
    const quote = text.split('\n').find(line => line.startsWith(prefix))!;
    return { start: text.indexOf(quote), quote };
  };
  const labels = { brand: '브랜드', model: '모델', generation: '세대', option: '옵션', quantity: '수량', bundle: '구성' };
  const identity = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, span(label + ':')])) as NonNullable<Reading['identity']>;
  const configuration = Object.fromEntries(Object.entries(identity).map(([key, evidence]) => [key, evidence.quote.split(': ')[1]])) as Configuration;
  const price = span(official ? '정가:' : text.includes('전체 공구가:') ? '전체 공구가:' : '공구가:');
  const deadlineLabel = ['마감일:', '공구기간:', '기간:'].find(label => text.split('\n').some(line => line.startsWith(label)));
  return { amount: Number(price.quote.split(': ')[1].replace(/[^0-9]/g, '')), price,
    deadline: official || !deadlineLabel ? null : span(deadlineLabel), configuration, identity };
}

export async function exampleEvidence(url: string, offer = 390000, list = 430000): Promise<PriceEvidence> {
  const offerText = productText(offerHtml, url).replace('공구가: 390,000원', `${offer === 0 ? '전체 ' : ''}공구가: ${offer.toLocaleString('ko-KR')}원`);
  const listText = productText(officialHtml, officialUrl).replace('430,000', list.toLocaleString('ko-KR'));
  const a = mockReading(offerText, false), b = mockReading(listText, true);
  return { verifier: PRICE_VERIFIER, models: PRICE_MODELS, offer_url: url, failed: null, official_approval: officialApproval,
    offer: { source: { url, text: offerText, hash: await digest(offerText), observed_at: checkedAt }, readings: [a, structuredClone(a)] },
    official: { source: { url: officialUrl, text: listText, hash: await digest(listText), observed_at: checkedAt }, readings: [b, structuredClone(b)] } };
}
