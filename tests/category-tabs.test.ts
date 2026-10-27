import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { CategoryTabs } from '../app/_category-tabs';
import { categories } from '../lib/data';

test('index links retain every existing category with one current page and native keyboard behavior', () => {
  const html = renderToStaticMarkup(createElement(CategoryTabs, { base: '/models', category: 'carrier', by: 'brand', brand: 'A&B', q: 'Chair' }));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  for (const label of Object.values(categories)) expect(html).toContain(label);
  expect(html).toContain('aria-current="page" href="/models?category=carrier&amp;by=brand&amp;brand=A%26B&amp;q=Chair"');
  expect(html).not.toContain('role="tab"');
  expect(html).not.toContain('tabindex="-1"');
  expect(html).not.toContain('onclick');
});
