import type { DeepSeekWebConfig, ScopedCategory } from './types';
import type { PangpangProduct } from '../../lib/external/pangpang';

const ACCESSORY_OR_BROAD = /유모차용품|폰거치|거치대|스카프|빕|투약|가습기|자석교구|자석보드|맘스보드|교구|기저귀가방|겨울옷|목스카프|용품\s*빕|밀크베이비|미니두두|버드시아|코코보드|벨베이비\s*자석/i;
const CORE_CATEGORY_PATH = /유모차\/카시트|>\s*유모차\s*$|>\s*카시트\s*$|하이체어|트립트랩|플레이짐|아기띠|play\s*gym|모빌/i;

export type CoreScopeVerdict = 'core' | 'accessory_or_broad' | 'outside_scope';

export function classifyCoreScope(product: Pick<PangpangProduct, 'title' | 'category_text' | 'text'>, config: DeepSeekWebConfig): CoreScopeVerdict {
  const title = product.title ?? '';
  const category = product.category_text ?? '';
  const blob = `${title}\n${category}`;
  if (ACCESSORY_OR_BROAD.test(blob)) return 'accessory_or_broad';
  if (/^키즈\s*>\s*육아용품\s*$/.test(category.trim()) && !CORE_CATEGORY_PATH.test(blob) && !titleMatchesCore(title, config)) {
    return 'accessory_or_broad';
  }
  if (CORE_CATEGORY_PATH.test(category) && titleMatchesCore(title, config)) return 'core';
  if (titleMatchesCore(title, config) || categoryMatchesScoped(category, config)) {
    if (ACCESSORY_OR_BROAD.test(title)) return 'accessory_or_broad';
    return 'core';
  }
  return 'outside_scope';
}

function titleMatchesCore(title: string, config: DeepSeekWebConfig) {
  const t = title.trim();
  if (!t) return false;
  for (const cat of config.scope_categories) {
    if (cat.ko.some(k => t.includes(k))) return true;
    if (cat.examples.some(ex => new RegExp(ex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t))) return true;
  }
  return false;
}

function categoryMatchesScoped(category: string, config: DeepSeekWebConfig) {
  for (const cat of config.scope_categories) {
    if (cat.ko.some(k => category.includes(k))) return true;
  }
  return CORE_CATEGORY_PATH.test(category);
}

export function corePublicSearchUrls(config: DeepSeekWebConfig, limit = 6) {
  const terms: string[] = [];
  for (const cat of config.scope_categories) {
    for (const ko of cat.ko) {
      if (ko.length >= 2 && !/^육아/.test(ko)) terms.push(ko);
    }
  }
  const unique = [...new Set([...terms, '유모차', '카시트', '트립트랩', '하이체어', '플레이짐', '아기띠'])];
  return unique.slice(0, limit).map(t => `https://09pangpang.com/search/r/${encodeURIComponent(t)}`);
}

export function scopeRollup(products: PangpangProduct[], config: DeepSeekWebConfig) {
  const counts = { core: 0, accessory_or_broad: 0, outside_scope: 0 };
  const core: PangpangProduct[] = [];
  for (const p of products) {
    const v = classifyCoreScope(p, config);
    counts[v]++;
    if (v === 'core') core.push(p);
  }
  return { counts, core };
}
