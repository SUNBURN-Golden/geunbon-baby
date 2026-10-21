import { beforeEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { DealImage } from '../app/deals/_image';
const state = vi.hoisted(() => ({ failed: null as string | null }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => [state.failed, (value: string) => { state.failed = value; }],
}));
beforeEach(() => { state.failed = null; });
test('expired/failed images hide quietly; a changed URL may load again', () => {
  const src = 'https://cdninstagram.com/expired.jpg?sig=synthetic';
  const props = { src, alt: 'Fixture product' };
  const image = DealImage(props)!;
  expect(image.props.src).toBe(src);
  expect(image.props.referrerPolicy).toBe('no-referrer');
  image.props.onError();
  expect(DealImage(props)).toBeNull();
  expect(DealImage({ ...props, src: 'https://fbcdn.net/replacement.jpg' })).not.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test('a supplied letter placeholder replaces missing, unsafe and failed images', () => {
  const fallback = createElement('span', { className: 'active-deal-mark', 'aria-hidden': true }, 'C');
  const props = { src: 'https://cdninstagram.com/chair.jpg', alt: 'Chair 상품 이미지', fallback };
  for (const src of [null, '', 'https://example.com/chair.jpg']) {
    expect(DealImage({ ...props, src })).toBe(fallback);
  }
  const image = DealImage(props)!;
  image.props.onError();
  expect(DealImage(props)).toBe(fallback);
  expect(DealImage({ ...props, src: 'https://fbcdn.net/replacement.jpg' })).not.toBe(fallback);
  expect(fetch).not.toHaveBeenCalled();
});
