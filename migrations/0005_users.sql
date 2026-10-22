-- 소셜 로그인 회원가입(구글·카카오). 받는 정보는 이메일과 공급자 id뿐이다.
-- add-only 마이그레이션이며 로컬에서만 적용한다. 운영 D1에는 운영자가 직접 적용한다.
-- 뉴스레터 구독 여부와 동의·해지 시각을 users에 함께 저장한다.
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL,
  newsletter_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(newsletter_opt_in IN (0,1)),
  newsletter_consented_at TEXT, newsletter_withdrawn_at TEXT);
CREATE TABLE user_identities (provider TEXT NOT NULL CHECK(provider IN ('google','kakao')),
  provider_user_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(provider, provider_user_id));
CREATE INDEX user_identities_user ON user_identities(user_id);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
