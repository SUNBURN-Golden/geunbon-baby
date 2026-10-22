// 외부 공구 모음 사이트용 robots.txt 파서와 요청 허용 판정. 의존성 없음.
// HTTP 요청(fetch.ts)과 브라우저 렌더링 라우팅(render.ts)이 같은 decide()를 호출한다.
export const USER_AGENT_TOKEN = 'agamajung-crawler';
export const USER_AGENT = 'agamajung-crawler/1.0 (+https://agamajoong.soulbound.co.kr)';

// robots.txt와 무관하게 항상 금지: 로그인·내부 API·회원 영역.
const HARD_BLOCK_DIRECTORIES = ['api', 'my', 'auth'];
const HARD_BLOCK_PREFIXES = ['/login', '/logout', '/signin', '/signup', '/admin', '/account', '/member', '/mypage', '/oauth', '/session'];
// 어떤 설정으로도 열 수 없는 호스트(하위 도메인 포함).
const DENIED_HOSTS = ['gonggumoa.com'];

export type DecisionReason = 'hard_block' | 'robots' | 'cross_origin' | 'scheme' | 'denylist';
export type Decision = { allowed: true } | { allowed: false; reason: DecisionReason };
export type RobotsRule = { allow: boolean; pattern: string };
export type Robots = { denyAll: boolean; rules: RobotsRule[] };
export const ALLOW_ALL: Robots = { denyAll: false, rules: [] };
export const DENY_ALL: Robots = { denyAll: true, rules: [] };

export const isDeniedHost = (host: string) => DENIED_HOSTS.some(denied => host === denied || host.endsWith(`.${denied}`));

export function isHardBlockedPath(pathname: string): boolean {
  const variants = new Set<string>();
  for (const raw of [pathname, safeDecode(pathname)]) variants.add(raw.toLowerCase().replace(/\/{2,}/g, '/'));
  return [...variants].some(path =>
    HARD_BLOCK_DIRECTORIES.some(dir => path === `/${dir}` || path.startsWith(`/${dir}/`)) ||
    HARD_BLOCK_PREFIXES.some(prefix => path.startsWith(prefix)));
}
function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseRobots(content: string, agent = USER_AGENT_TOKEN): Robots {
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let collecting = false;
  for (const line of content.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    const separator = clean.indexOf(':');
    if (separator < 0) continue;
    const field = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!collecting || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      collecting = true;
    } else if (field === 'allow' || field === 'disallow') {
      collecting = false;
      // 빈 Disallow는 "전부 허용"이므로 규칙으로 남기지 않는다.
      if (current && value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else collecting = false;
  }
  const named = groups.filter(group => group.agents.some(name => name !== '*' && agent.toLowerCase().includes(name)));
  const chosen = named.length ? named : groups.filter(group => group.agents.includes('*'));
  return { denyAll: false, rules: chosen.flatMap(group => group.rules) };
}

function patternMatches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(target);
}

// 가장 긴 패턴이 이기고, 길이가 같으면 Allow가 이긴다.
export function robotsAllows(robots: Robots, pathAndQuery: string): boolean {
  if (robots.denyAll) return false;
  let best: RobotsRule | null = null;
  for (const rule of robots.rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// robots를 넘기지 않으면 정적 검사(스킴·금지 호스트·origin·하드 금지 경로)만 한다.
export function decide(target: string | URL, origin: string, robots?: Robots | null): Decision {
  let url: URL;
  let base: URL;
  try { url = new URL(target); base = new URL(origin); } catch { return { allowed: false, reason: 'scheme' }; }
  if (url.protocol !== 'https:' || url.username || url.password) return { allowed: false, reason: 'scheme' };
  if (isDeniedHost(url.hostname.toLowerCase()) || isDeniedHost(base.hostname.toLowerCase())) return { allowed: false, reason: 'denylist' };
  if (url.origin !== base.origin) return { allowed: false, reason: 'cross_origin' };
  if (isHardBlockedPath(url.pathname)) return { allowed: false, reason: 'hard_block' };
  if (robots && !robotsAllows(robots, url.pathname + url.search)) return { allowed: false, reason: 'robots' };
  return { allowed: true };
}
