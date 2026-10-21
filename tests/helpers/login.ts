import { vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import settingsJson from '../../crawler/config/settings.json';
import { parseSettings } from '../../crawler/lib/config';
import type { SessionState } from '../../crawler/lib/session';
import { mockPage, type Node } from './page';

export const sessionState = (): SessionState => ({
  cookies: [{ name: 'sessionid', value: 'offline-cookie-only', domain: '.instagram.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }],
  origins: [{ origin: 'https://www.instagram.com', localStorage: [{ name: 'offline-key', value: 'offline-storage-only' }] }],
});
export const loginSettings = () => {
  const settings = parseSettings(settingsJson);
  settings.delays_ms.navigation = [5, 5];
  settings.delays_ms.login = [20, 20];
  settings.delays_ms.action = [5, 5];
  return settings;
};
type Stage = 'login' | 'settling' | 'save' | 'notifications' | 'home' | 'activity' | 'challenge' | 'blocked' | 'unknown' | 'blank' | 'email-ko' | 'email-en';
export function loginFixture(options: {
  restored?: boolean; language?: 'en' | 'ko'; fullPage?: boolean; panel?: boolean;
  prompts?: boolean; submitDelay?: number; afterSubmit?: Stage; stuckPrompt?: boolean;
  bounceHome?: boolean; bounceActivity?: boolean; rootLogin?: boolean; staleCookie?: boolean;
} = {}) {
  let stage: Stage = options.restored ? 'home' : 'login';
  let cookies = options.restored || options.staleCookie ? sessionState().cookies : [];
  let navigations = 0;
  const titles = options.language === 'ko'
    ? { save: '로그인 정보를 저장하시겠어요?', notifications: '알림 설정' }
    : { save: 'Save your login info?', notifications: 'Turn on Notifications' };
  const dismiss = vi.fn(() => {
    if (!options.stuckPrompt) stage = stage === 'save' ? 'notifications' : 'home';
  });
  const decoy = vi.fn();
  const submit = vi.fn(() => {
    stage = 'settling';
    mock.setUrl('https://www.instagram.com/accounts/login/');
    setTimeout(() => {
      stage = options.afterSubmit ?? (options.prompts === false ? 'home' : 'save');
      cookies = sessionState().cookies;
      mock.setUrl(stage === 'challenge' ? 'https://www.instagram.com/challenge/' : 'https://www.instagram.com/');
    }, options.submitDelay ?? 40);
  });
  const fill = vi.fn();
  const surface = vi.fn(() => stage === 'blank' || stage === 'settling');
  const promptNode = (): Node[] => stage === 'save' || stage === 'notifications' ? [{
    text: titles[stage],
    children: selector => selector === 'role:button' ? [{ name: options.language === 'ko' ? '나중에 하기' : 'Not Now', click: dismiss }] : [],
  }] : [];
  const mock = mockPage(selector => {
    if (selector === 'input[name="username"]') return stage === 'login' ? [{ fill }] : [];
    if (selector === 'input[name="password"]') return stage === 'login' ? [{ fill }] : [];
    if (selector === 'button[type="submit"]') return stage === 'login' ? [{ click: submit }] : [];
    if (selector === 'input[name="code"], input[name="email_code"], input[name="confirmationCode"], input[name="confirmation_code"], input[name="emailCode"], input[inputmode="numeric"]') return stage.startsWith('email-') ? [{}] : [];
    if (selector === 'text') return stage === 'save' || stage === 'notifications' ? [{ text: titles[stage] }]
      : stage === 'email-ko' ? [{ text: '이메일을 확인하세요' }] : stage === 'email-en' ? [{ text: 'Check your email' }] : stage === 'blocked' ? [{ text: 'Action Blocked' }] : stage === 'challenge' ? [{ text: 'Enter the security code' }] : [];
    if (selector === 'role:dialog') return options.fullPage ? [] : stage === 'activity' ? [{ href: '/fresh_seller/' }] : promptNode();
    if (selector === 'main, [role="main"]') return options.fullPage ? promptNode() : [];
    if (selector === 'role:link' && (stage === 'home' || stage === 'activity')) return [
      { name: 'Profile', href: '/offline_user/' },
      ...(options.panel ? [{ name: 'Notifications', click: () => { stage = 'activity'; } }] : []),
    ];
    if (selector === 'role:button') return [{ name: 'Not Now', click: decoy }];
    if (selector === 'body') return [{ evaluate: surface }];
    if (selector === '[role="main"], main') return stage === 'activity' ? [{ href: '/fresh_seller/' }] : [];
    if (selector === 'a[href*="/stories/"]') return stage === 'home' ? [{ href: '/stories/story_seller/123/' }] : [];
    return [];
  });
  mock.goto.mockImplementation(async url => {
    mock.setUrl(url);
    if (url.includes('/accounts/activity/')) {
      stage = options.bounceActivity ? 'login' : 'activity';
      if (options.bounceActivity && !options.rootLogin) mock.setUrl('https://www.instagram.com/accounts/login/');
      if (options.bounceActivity && options.rootLogin) mock.setUrl('https://www.instagram.com/');
    } else if (++navigations > 1 && options.bounceHome) {
      stage = 'login';
      mock.setUrl('https://www.instagram.com/');
    }
  });
  const storageState = vi.fn(async () => ({ ...sessionState(), cookies }));
  const context = { cookies: vi.fn(async () => cookies), storageState } as unknown as BrowserContext;
  return { ...mock, context, storageState, submit, dismiss, decoy, fill, surface,
    setStage: (next: Stage) => { stage = next; },
    setCookies: (next: SessionState['cookies']) => { cookies = next; },
    stage: () => stage,
  };
}
