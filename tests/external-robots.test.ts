import { expect, test } from 'vitest';
import { ALLOW_ALL, DENY_ALL, decide, isHardBlockedPath, parseRobots, robotsAllows } from '../crawler/lib/external/robots';

test('the agamajung-crawler group wins over the wildcard group', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: agamajung-crawler\nDisallow: /private/\n');
  expect(robotsAllows(robots, '/list')).toBe(true);
  expect(robotsAllows(robots, '/private/x')).toBe(false);
  expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /search'), '/search/r/x')).toBe(false);
});

test('longest match wins, ties go to Allow, wildcards and $ anchors work', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /a/\nAllow: /a/open/\nDisallow: /*.json$\nDisallow: /tie\nAllow: /tie\n# comment\nDisallow:\n');
  expect(robotsAllows(robots, '/a/x')).toBe(false);
  expect(robotsAllows(robots, '/a/open/x')).toBe(true);
  expect(robotsAllows(robots, '/data/list.json')).toBe(false);
  expect(robotsAllows(robots, '/data/list.json?x=1')).toBe(true);
  expect(robotsAllows(robots, '/tie')).toBe(true);
  expect(robotsAllows(robots, '/other')).toBe(true);
});

test('empty Disallow allows everything and deny-all policy blocks everything', () => {
  expect(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/x')).toBe(true);
  expect(robotsAllows(ALLOW_ALL, '/x')).toBe(true);
  expect(robotsAllows(DENY_ALL, '/x')).toBe(false);
});

test.each(['/api/v1/x', '/api', '/my/orders', '/auth/login', '/login', '/Logout', '/signin', '/signup', '/admin/x', '/account', '/member/join', '/mypage', '/oauth/cb', '/session', '//api/x', '/%61pi/x', '/%41PI/x'])('hard-blocked path %s', path => {
  expect(isHardBlockedPath(path)).toBe(true);
  expect(decide(`https://09pangpang.com${path}`, 'https://09pangpang.com', ALLOW_ALL)).toEqual({ allowed: false, reason: 'hard_block' });
});

test('decide reports the reason for each refusal', () => {
  const origin = 'https://09pangpang.com';
  const robots = parseRobots('User-agent: *\nDisallow: /search/private');
  expect(decide('https://09pangpang.com/search/r/x', origin, robots)).toEqual({ allowed: true });
  expect(decide('https://09pangpang.com/search/private/1', origin, robots)).toEqual({ allowed: false, reason: 'robots' });
  expect(decide('https://other.example.invalid/x', origin, robots)).toEqual({ allowed: false, reason: 'cross_origin' });
  expect(decide('http://09pangpang.com/x', origin, robots)).toEqual({ allowed: false, reason: 'scheme' });
  expect(decide('not a url', origin)).toEqual({ allowed: false, reason: 'scheme' });
});

test('gonggumoa.com and subdomains are refused even when robots.txt allows everything and the origin matches', () => {
  for (const host of ['gonggumoa.com', 'www.gonggumoa.com', 'm.gonggumoa.com']) {
    expect(decide(`https://${host}/`, `https://${host}`, ALLOW_ALL)).toEqual({ allowed: false, reason: 'denylist' });
  }
  expect(decide('https://notgonggumoa.com/', 'https://notgonggumoa.com', ALLOW_ALL)).toEqual({ allowed: true });
});
