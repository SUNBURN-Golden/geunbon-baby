import { beforeEach, expect, test, vi } from 'vitest';
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
