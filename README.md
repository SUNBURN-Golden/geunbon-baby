# 아가마중

> 너는 건강하게만 와 주렴. 좋은 것은 우리가 골라 둘게.

오래 곁에 둘 프리미엄 근본 육아용품 가격 비교·공구 정보 MVP입니다. Stokke, Bugaboo, Cybex, BabyBjorn, Nuna 등 유모차·하이체어·카시트·바운서·아기띠를 다룹니다. 기저귀·분유·결제·주문 기능은 없습니다. 사이트는 Next.js App Router + TypeScript, OpenNext Cloudflare Workers, D1, R2를 사용합니다.

### 이름과 표기

화면 브랜드는 블루프린트와 같은 `lib/site-copy.ts`의 **아가마중**, 영문 워드마크는 **AGAMAJUNG**입니다(`tests/site.test.ts`에서 확인). 도메인은 `agamajoong.soulbound.co.kr`처럼 **agamajoong**, 패키지·Worker·D1·쿠키·PM2 앱과 Instagram 기본 사용자명 등 코드 식별자는 **agamajung**을 사용합니다.

## 시스템 구성과 경계

| 시스템 | 진입점·실행 위치 | 저장소 | 자격 증명·사이트 접점 |
| --- | --- | --- | --- |
| 사이트 | `worker.ts`, `app/**` · Cloudflare Workers. 로컬은 `wrangler dev --local` | D1 `DB`(사이트 `/migrations`), R2 `IMAGES` | ADMIN_TOKEN(관리), INGEST_TOKEN(수집 접수), COLLECTOR_STATUS_TOKEN(건수 접수), 선택 OAuth 키(예시 `.env.example` → `.dev.vars`). 아래 API 제공 |
| Instagram worker | `crawler/index.ts`, PM2용 `crawler/run.mjs` · Linux Node 22 + Playwright | `crawler/.session/`, `crawler/.cache/state.json` | AGAMAJUNG_IG_USER(기본 `agamajung`)·AGAMAJUNG_IG_PASSWORD 또는 저장 세션, AGAMAJUNG_API_URL·INGEST_TOKEN(예시 `crawler/.env.crawler.example` → 루트 `.env.crawler`). `POST /api/v1/ingest`로 post/story를 pending 접수. 호환 external_listing은 별도 external_candidates에 저장 |
| 독립 로컬 수집함 | `crawler/src/local-worker.ts`의 serve/discover, CLI `crawler/collector.mjs`, Chrome MV3 `tools/chrome-clipper/` · Linux, serve는 `127.0.0.1:4318` | `crawler/.cache/collector.sqlite`, 전용 `crawler/migrations/` | serve는 COLLECTOR_INTAKE_TOKEN·COLLECTOR_REVIEW_TOKEN·COLLECTOR_EXTENSION_ORIGIN, 확장은 인테이크 토큰, CLI는 검토 토큰. discover 자체에는 사이트·Instagram 자격 증명 불필요. 수집 자료를 사이트로 보내지 않음 |
| 건수 동기화 | `npm run collector:worker -- sync` → `crawler/src/local-worker.ts`, `crawler/src/status-sync.ts` · Linux | 위 SQLite의 트랜잭션 outbox → 사이트 D1 건수 스냅샷 | COLLECTOR_SITE_URL(HTTPS)·전용 COLLECTOR_STATUS_TOKEN. `POST /api/v1/collector/status`에 건수·보조 집계·작업기 ID·버전·시각만 전송 |

**Workers Cron은 수집기를 실행하지 않는 로그 stub입니다. Playwright와 OCR은 Linux에서만 실행합니다.** 사이트는 로컬 수집 레코드·URL·원문·셀러·근거를 가져오지 않습니다. 로컬 `seller_candidates`를 사이트 판매자로 자동 등록하지도 않습니다. 수집함의 `ready_to_publish`는 사람의 공개 검토를 마친 로컬 상태이며 실제 게시 동작이 아닙니다. Instagram pending → 사이트 관리자 승인 → deals 경로와 별개입니다.

Linux 수집 예약은 `npm run collector:worker -- schedule`의 상주 슬롯 관리로 실행합니다. KST 누락 슬롯 병합, 수동·예약 공통 실행, 상태 기록과 전환 절차는 [수집 일정 운영](docs/collector/scheduling.md)을 참고하세요. 운영 PM2 전환은 별도로 수행합니다.

3경로는 자동 RSS/API/사이트맵/링크 발견(`auto_discovery`), 승인된 공개 브라우저 추출(`browser_extract`), Chrome 수동 담기(`manual_clip`)입니다. 저장 전·AI 전달 전 공통 개인정보 필터(`shared/privacy-rules.ts`)를 적용하고 자료를 `untrusted_source_data`로 격리합니다. AI는 필수가 아니며 자료 속 지시로 도구 실행·상태 승격·게시를 하지 않습니다.

설치·운영은 [Linux 수집 시스템](crawler/README.md), [독립 로컬 수집함](crawler/README.md#독립-로컬-수집함), [건수 동기화](crawler/README.md#건수-동기화), [외부 공구 모음 이관](crawler/README.md#외부-공구-모음-이관), [Chrome 확장 안내](tools/chrome-clipper/README.md)를 참고하세요. 개발 작업 데몬 [tools/dev-daemon](tools/dev-daemon/README.md)과 PM2 앱 `agamajung-dev-daemon`은 위 수집·사이트 운영과 무관한 별도 도구입니다.

### 사이트에 표시하는 수집 현황

`/admin`은 후보(`discovered`)·원문 확인(`source_check_needed`)·중복 제외(`dedup_excluded`)·검증 완료(`verified_waiting`)·공개 대기(`ready_to_publish`)의 건수만 표시합니다. 미수신은 **미동기화**이며 0건으로 간주하지 않습니다. 생성 후 60분을 넘긴 현황은 **동기화 지연**입니다. 여러 작업기는 각각 표시하고 고유 자료량으로 합산하지 않습니다. 같은 버전의 다른 payload는 409이고 이전 버전은 최신 현황을 바꾸지 않습니다.

## 가격 원칙

최초 데이터는 **`seed/models.json`, `seed/tripp_trapp.json`만** 사용합니다. 공식 본문 확인 근거와 확인 불가 사유는 [모델 근거 기록](docs/model-evidence-2026-10-23.md)에 있습니다. 가격이 null이거나 수집되지 않았으면 **정보 없음**입니다. 시드에 공구가·일정이 없으므로 공구와 달력은 빈 화면이 정상입니다.

- 비교·표시하는 가격은 **공식가**와 **공구가** 두 종류뿐입니다. 공식가는 제조사·공식 수입사의 동일 구성 공식 페이지 본문에서 확인한 `verify_level: "page_body"` 가격만 사용하며, 공구가는 관리자가 원문 검수 후 승인한 공구 가격입니다.
- 해외가·당근 중고 시세·직구가·일반 판매처/백화점 행사가는 비교에서 제외합니다(`migrations/0004_official_groupbuy_only.sql`). 검색 요약·블로그·기사·legacy `external_listing`의 가격도 공식가 근거가 아닙니다.
- **가격을 절대 만들어 내지 않습니다 (never invent prices).** 공식가가 없으면 다른 판매처 가격이나 구성품 가격 합계로 대체하지 않습니다.
- `kr_retailers`는 판매자 이름과 출처 URL만 보관하며 가격은 포함하지 않습니다.
- `page_body`는 공식 제품 본문에서 정상가를 확인한 상태이고, `official_unpublished`는 동일 구성 미확인·접속 실패·수입사 미확인 등을 포함한 공식가 정보 없음 상태입니다. UI에는 "공식가 미확인 · 정보 없음"으로 표시합니다. 제조사의 가격 비공개를 단정하지 않으며 `evidence.reason`으로 사유를 구분합니다. 공식가는 `verify_level: "page_body"`인 가격만 표시합니다. `page_text`·`search_summary` 등 다른 수준의 기존 D1 행은 검증 수준과 확인일은 유지하되 페이지에서는 "정보 없음", API(`/api/v1/models`, `/api/v1/models/:id`의 `official_price`, `comparison.official.price`)에서는 `null`로 반환합니다. 공식가 미확인 모델은 다른 판매가나 부품 합산으로 대체하지 않습니다.
- 모든 공구는 광고이며 구매·결제는 판매처 링크아웃만 제공합니다. 아가마중은 거래 당사자가 아닙니다.

`seed/official-sources.json`의 브랜드별 공식 호스트·제품 경로 규칙과 차단 경로로 가격 출처를 제한합니다. 백화점·기사·리뷰·홈 페이지는 공식가 근거가 아닙니다. 모델별 `evidence`·`bundle`은 구성품·세대·호환·보증·설명서·인증 조사 기록이며, 미확인 항목은 추정하지 않습니다. 현재 D1/API/UI에는 조사 묶음을 추가하지 않습니다. 공식 근거 마이그레이션 `0008_official_evidence.sql`은 기존 모델 컬럼만 UPDATE합니다. **`lib/`·`app/`에서 시드를 import하지 마세요.** 큰 조사 기록과 로컬 네트워크 도구는 Workers 번들 밖에 둡니다.

CPSC 공개 REST(키 불필요)는 로컬 Node `scripts/recall-check.ts`에서 기본 질의와 모든 대체 표기(예: BabyBjörn·Maxi Cosi·Dorel)를 각각 제목·제품명으로 질의 후 RecallID 중복 제거와 전체 단어 브랜드 필터를 적용합니다. 질의별 원시 행 수·채택 수·필터 제외 ID/제목·조회 실패를 `seed/recalls.json`에 기록합니다. **리콜 결과 없음 ≠ 안전 보장**이며 해외 리콜의 국내 모델·로트 적용은 별도 판단합니다. SafetyKorea는 API 키 발급 전 `not_connected`입니다. 공유 순수 파서와 기존 크롤러 파서는 패리티 테스트로 검증하며 크롤러의 공유 파서 전환은 후속 과제입니다.

## 로컬 실행 (Wrangler 로컬 전용)

Node.js **22 이상**, npm이 필요합니다. 실제 Cloudflare 리소스를 생성하거나 배포할 필요가 없습니다.

```sh
npm ci
cp .env.example .dev.vars
```

`.dev.vars`의 ADMIN_TOKEN과 INGEST_TOKEN에 **각각 24자 이상이며 앞뒤 공백이 없는 서로 다른 임의 값**을 직접 설정합니다. COLLECTOR_STATUS_TOKEN도 설정 시 같은 길이·공백 규칙을 지키고 두 토큰과 모두 달라야 합니다. 관리자·수집 토큰 중 하나라도 누락되거나 규칙을 어기거나 현황 토큰과 같으면 admin/ingest API는 모두 503으로 닫히고 `/admin`에는 인증 설정 안내만 표시됩니다. 공개 읽기 API는 계속 사용할 수 있으며, collector/status는 별도로 현황 토큰을 검증합니다. 이 파일은 gitignore 대상입니다. `.env.example`에는 사이트 바인딩만 있습니다. 크롤러·수집기 변수는 `crawler/.env.crawler.example`을 루트 `.env.crawler`로 복사해 관리하며 `.dev.vars`에 넣지 마세요.

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

`npm run db:migrate`와 `npm run db:seed`는 모두 D1 `--local`만 사용합니다. `npm run dev`는 `build:worker`로 OpenNext 빌드 후 `wrangler dev --local`로 로컬 workerd/Miniflare만 실행합니다. 기본 접속 주소는 `http://localhost:8787`입니다. Next.js 자체 개발 서버는 사용하지 않습니다. 배포 스크립트는 제공하지 않으며 이 절차는 원격 리소스를 만들거나 배포하지 않습니다. 소스 수정 후 빌드를 다시 실행하세요. 시드는 `.local/seed.sql`로 생성되며 재실행해도 기존 검수·수집 데이터는 지우지 않습니다. 데이터 구조 변경은 `/migrations`에 추가합니다.

## Cloudflare 설정 (`wrangler.jsonc`)

저장소에 체크인된 운영 설정값은 다음과 같습니다. 식별자 문자열을 여기에 복사하지 않습니다.

| 설정 | 체크인된 내용 |
| --- | --- |
| Worker·진입점 | `name: agamajung`, `main: worker.ts`, `compatibility_date: 2026-10-01` |
| 계정·라우트 | `account_id` 및 `zone_id` 필드, custom domain `agamajoong.soulbound.co.kr` |
| D1 | `DB` → 데이터베이스 `agamajung`, `database_id` 필드, `migrations_dir: migrations` |
| R2 | `IMAGES` → 버킷 `agamajung-images` |
| 정적 파일 | `ASSETS` → `.open-next/assets` |
| 서비스 | `WORKER_SELF_REFERENCE` → `agamajung` |
| Cron | `0 */6 * * *` · `worker.ts`의 로그 stub |
| 호환·관측 | `nodejs_compat`, `global_fetch_strictly_public`, `observability.enabled: true` |

저장소는 이 값들이 가리키는 리소스의 존재·상태를 검증하거나 생성하지 않습니다. 운영 D1 마이그레이션·비밀 바인딩·배포는 운영자가 별도로 수행합니다.

R2 읽기는 `/api/v1/images/:key`에서 `public/` 아래 허용 이미지 파일만 제공합니다. 시드에 사진이 없어 제품 사진을 만들거나 임의 외부 이미지를 가져오지 않습니다. Instagram ingest는 R2 업로드를 지원하지 않습니다.

## 화면

다음은 `app/**/page.tsx`의 전체 경로입니다. `:id`는 소스의 `[id]` 동적 세그먼트를 뜻합니다.

| 경로 | 현재 기능·진입점 |
| --- | --- |
| `/` | 브랜드 소개·진행 중 공구만 공통 공구 카드로 표시·카테고리 링크. 로고로 진입. 소식지 메뉴는 이 페이지의 `/#letter`로 이동하며, 여기서 `/login`(로그인 시 `/me`)으로 구독 경로를 안내 |
| `/models` | 종류·브랜드·모델명 검색(`category`, `brand`, `q`). 공식가 메뉴. 브랜드 메뉴는 `/models?by=brand`. 진행 중 공구가 있는 모델 우선 |
| `/models/:id` | 해당 모델의 게시 공구를 공통 공구 카드로 표시, 공구가와 공식가 두 가격만 표시·비교. 공식가는 출처·확인일·검증 수준(`page_body`만 금액 표시)·수입사와 함께 표시. 모델 카드로 진입, 없는 모델은 404 |
| `/deals` | 검수·게시된 공구 목록을 공통 공구 카드로 표시, 예정·진행·종료 상태 안내. 공구 메뉴·홈에서 진입 |
| `/deals/:id` | 게시 공구 상세·판매자 증빙·광고·판매처 링크. 목록에서 진입. 없거나 철회된 공구는 전용 not-found 화면(404) |
| `/calendar` | 검수·게시된 공구를 시작일순으로 공통 공구 카드로 표시. 달력 메뉴·푸터 공구 달력 링크 |
| `/sellers` | 시드 출처(kr_retailers)와 관리자가 등록한 판매자의 출처와 통신판매업 신고·청약철회 7일·정식수입 증빙. 없으면 미확인. 목록 게재는 입점·보증이 아님. 푸터 판매자 안내 및 공구의 신뢰 안내 링크 |
| `/login` | 구글·카카오 로그인, 뉴스레터 기본 체크. 미설정 공급자는 숨김, 로그인된 사용자는 `/me`로 이동 |
| `/me` | 내 계정·뉴스레터 해지/재구독·로그아웃. 헤더 내 계정 링크. 비로그인 시 `/login`으로 이동 |
| `/admin` | ADMIN_TOKEN 인증 후 Instagram 원문 승인/반려, 판매자 관리, 공구 정정/철회, 외부 후보 조회/dismiss, 건수 현황 |

별도 `/brands` 페이지는 없습니다. `/models?by=brand`와 `GET /api/v1/brands`를 사용합니다.

`/models` 카드(`app/models/_card.tsx`)는 **상품명(브랜드+모델), 1:1 손그림, 공식가, 현재 공구가** 네 항목만 표시합니다. 공구가 없으면 **진행 중인 공구 없음**입니다. 광고·검증 배지·확인 시각·추가 메타데이터를 붙이지 않습니다. 출처 링크와 확인일(`checked_at`에 해당하는 현재 필드 `checked`)·검증 수준은 모델 상세에 표시합니다. `/`(진행 중 공구만)·`/deals`·`/calendar`·`/models/:id`는 하나의 공구 카드를 사용하며 광고·기간·공구가·검증된 공식가 비교·`rel=sponsored` 판매처 원문 링크·판매자 행이 있을 때 신뢰 정보 링크·직접 판매/거래 당사자가 아니라는 안내를 표시합니다. `/deals/:id` 상세도 광고·거래 안내를 유지합니다.

`/admin`은 httpOnly·SameSite strict·1시간 쿠키와 Server Actions 동일 origin 검증을 사용합니다. 로그아웃은 발급 시와 같은 Path=/admin·HttpOnly·SameSite=strict·Secure(프로덕션에서만) 속성으로 쿠키를 만료시킵니다. 서비스 토큰 설정이 잘못되면 기존 쿠키가 있어도 설정 안내만 표시하고 로그인·검수를 차단합니다. 공개 화면에는 대기 원문을 전달하지 않습니다. 로컬 관리자 접속은 localhost를 사용하고 공유/운영 환경은 HTTPS를 사용합니다. 토큰을 URL에 넣지 마세요.

관리자 쿠키에는 ADMIN_TOKEN 원문 대신 `v1.<만료>.<nonce>.<HMAC-SHA256 서명>`을 저장합니다. 로그인마다 임의 nonce를 생성하고 ADMIN_TOKEN을 키로 만료 시각과 nonce에 서명하며, 서버는 서명과 1시간 만료를 검증합니다. 쿠키 값은 `/api/v1/admin/*`의 `Authorization: Bearer` 토큰으로 사용할 수 없습니다. ADMIN_TOKEN을 교체하면 기존 세션은 즉시 무효화됩니다. 로그아웃은 브라우저 쿠키를 삭제하지만 서버에 세션 상태를 저장하지 않으므로, 로그아웃 전에 탈취된 쿠키는 만료까지(최대 1시간) `/admin`에서 유효합니다.

## 소셜 로그인

가입은 구글·카카오 소셜 로그인만 지원합니다(네이버·자체 가입폼 없음). 의존성 없이 OAuth 2.0 authorization code 흐름을 직접 구현했고 Workers의 `fetch`와 `crypto.subtle`만 씁니다.

- 흐름: `/login`의 한 `<form method="get">`에 뉴스레터 체크박스(기본 체크)와 공급자 버튼이 함께 있습니다. `GET /api/auth/login/{google,kakao}`가 state(구글은 PKCE 포함)와 체크박스 값을 `agamajung_oauth` 쿠키(httpOnly·SameSite=Lax·Path=/api/auth/callback·10분)에 담아 공급자로 302하고, `GET /api/auth/callback/{google,kakao}`가 state를 확인한 뒤 토큰 교환 → 이메일·공급자 id 조회 → D1 기록 → 세션 쿠키 발급 후 `/me`로 302합니다. 로그아웃은 `/me`의 서버 액션으로만 처리합니다(GET 라우트 없음). 모든 인증 응답은 `Cache-Control: no-store`입니다.
- 환경변수(`.dev.vars` 또는 운영 비밀 바인딩): `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`(둘 다 필요), `KAKAO_REST_KEY`(필수)·`KAKAO_CLIENT_SECRET`(선택), `AUTH_ORIGIN`(기본 `https://agamajoong.soulbound.co.kr`, 로컬은 `http://localhost:8787`). 설정되지 않은 공급자는 버튼이 숨겨지고 login·callback이 404이며, 모두 미설정이면 `/login`에 준비 중 안내만 보입니다. 쿠키 `Secure`는 `AUTH_ORIGIN`이 https일 때만 켜집니다. 리디렉트 URI는 Host 헤더가 아니라 `AUTH_ORIGIN`으로 고정됩니다.
- 운영자가 등록할 리디렉트 URI(Google Cloud Console, Kakao Developers):
  - `https://agamajoong.soulbound.co.kr/api/auth/callback/google`
  - `https://agamajoong.soulbound.co.kr/api/auth/callback/kakao`
  - 카카오는 동의항목에서 카카오계정(이메일)을 켜야 합니다.
- 수집 정보: 이메일과 공급자 id뿐입니다. 액세스·리프레시 토큰, 이름, 프로필은 저장하지 않습니다. 구글은 `email_verified`, 카카오는 `is_email_valid`·`is_email_verified`가 참인 이메일만 받습니다.
- 세션 토큰은 해시만 저장합니다(30일).
- 뉴스레터: 신규 가입 때만 체크박스 값과 동의 시각을 기록하고 재로그인은 값을 바꾸지 않습니다. `/me`에서 해지·재구독할 수 있습니다.
- 이메일이 같아도 공급자가 다르면 별도 계정입니다(자동 연결 없음). 따라서 **뉴스레터 발송 시 이메일 기준 중복 제거가 필요**합니다. **계정 삭제는 후속 과제**입니다. 레이트리밋은 Cloudflare 운영 설정에 맡깁니다.

## JSON REST API v1

읽기 응답은 `{ "data": ... }`, 실패는 `{ "error": "..." }`입니다. 현재 동일 origin API이며 향후 Expo 네이티브 클라이언트에서도 사용할 수 있습니다. 브라우저 cross-origin CORS는 열지 않았습니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/v1/brands` | 브랜드·모델 수 |
| GET | `/api/v1/models` | 모델 목록. 선택 쿼리 `brand`, `category` |
| GET | `/api/v1/models/:id` | 모델과 공식가·공구가 비교, 없으면 404 |
| GET | `/api/v1/deals` | 검수 완료 공구 (예정·진행·종료 포함) |
| GET | `/api/v1/sellers` | 판매자 및 배지 증빙 URL |
| GET | `/api/v1/calendar` | 시작일순 검수 완료 공구 |
| POST | `/api/v1/ingest` | INGEST_TOKEN. Instagram pending 접수 또는 쓰기 가능한 legacy 외부 후보 접수 |
| POST | `/api/v1/collector/status` | COLLECTOR_STATUS_TOKEN. 건수 스냅샷만 접수 |
| GET | `/api/v1/admin/collection-status` | ADMIN_TOKEN. 작업기별 다섯 상태·생성/수신 시각·지연 여부 |
| GET | `/api/v1/admin/queue` | ADMIN_TOKEN 전용, pending만 captured_at·id 오름차순 페이지. limit 기본/최대 100, 응답 `{ data, next_cursor }` |
| POST | `/api/v1/admin/review/:id` | 관리자 승인/반려, 승인 시 모델·판매자·귀속 근거 필수 |
| GET | `/api/v1/admin/sellers` | ADMIN_TOKEN 전용, 등록 판매자·검수된 연결 계정·미연결 수집 계정 |
| POST | `/api/v1/admin/sellers` | 판매자 등록, 선택 계정 연결은 `account_reviewed: true` 필수 |
| POST | `/api/v1/admin/sellers/:id` | `action: update` 증빙 전체 교체, `link_account` 검수 연결, `unlink_account` 해당 판매자의 연결만 해제 |
| GET | `/api/v1/admin/deals?status=published&limit=20&cursor=…` | ADMIN_TOKEN 전용, 상태 published(기본)/withdrawn/all, checked·id 내림차순 키셋 페이지. limit 1–50, 응답 `{ data, next_cursor }`, 전체 건수 제한 없음 |
| GET | `/api/v1/admin/deals/:id` | ADMIN_TOKEN 전용, 현재 값·전체 버전 이력·보존된 수집 원문 및 귀속 검수 근거 |
| POST | `/api/v1/admin/deals/:id` | ADMIN_TOKEN 전용, action correct/withdraw, expected_version·request_id·reason 필수 |
| GET | `/api/v1/admin/candidates` | ADMIN_TOKEN 전용, candidate만 captured_at·id 오름차순 페이지. limit 기본/최대 200, 응답 `{ data, next_cursor }` |
| POST | `/api/v1/admin/candidates/:id` | `{ "action": "dismiss" }`만 허용(그 외 400, 이미 처리됨 409, 없는 id 404) |
| GET | `/api/v1/images/:key` | R2 `IMAGES`의 `public/` 아래 jpg/jpeg/png/webp/avif. 허용 파일명·존재 여부 검사, 없으면 404 |
| GET | `/api/auth/login/google` | Google OAuth 시작. 공급자 미설정 시 404 |
| GET | `/api/auth/login/kakao` | Kakao OAuth 시작. 공급자 미설정 시 404 |
| GET | `/api/auth/callback/google` | Google OAuth 콜백 |
| GET | `/api/auth/callback/kakao` | Kakao OAuth 콜백 |

v1 분기는 `lib/api.ts`, 이미지 라우트는 `app/api/v1/images/[key]/route.ts`, OAuth는 `app/api/auth/[[...path]]/route.ts`와 `lib/auth.ts`에 있습니다. OAuth는 v1 밖의 별도 경로입니다. 공개 공구 상세 GET API는 없으며 모델 비교나 공구 목록을 사용합니다. 관리자 행은 모두 ADMIN_TOKEN이 필요합니다.

### 관리자 검수 목록 페이지 계약

`GET /api/v1/admin/queue`와 `GET /api/v1/admin/candidates`는 선택 쿼리 `limit`, `cursor`를 받습니다. `limit`은 십진 정수 1 이상이며 queue는 기본·최대 100, candidates는 기본·최대 200입니다. 한 번에 반환하는 건수만 제한하며 전체 목록에는 상한이 없습니다. 각 항목의 기존 필드는 유지하고 다음 페이지가 있으면 `next_cursor` 문자열을 반환합니다. 다음 요청에 그 문자열을 변경 없이 URL 인코딩하여 `cursor`로 전달하세요. 마지막 페이지와 빈 목록은 `next_cursor: null`이며, 전체 건수·페이지 번호는 제공하지 않습니다.

```json
{ "data": [], "next_cursor": null }
```

두 목록 모두 저장된 문자열의 `captured_at ASC, id ASC` 순서입니다. 동일한 수집 시각에서도 ID로 순서가 결정됩니다. queue는 `pending`만, candidates는 `candidate`만 반환하며 상태 필터로 승인·반려·dismiss 항목을 조회할 수 없습니다. 내부적으로 `limit + 1`건을 읽어 다음 페이지 유무를 확인하고 **마지막으로 반환한 항목**의 배타적 경계 `(captured_at, id) > (?, ?)`부터 이어갑니다. 커서의 기준 행이 승인·반려·dismiss·삭제되어도 계속 사용할 수 있습니다.

커서는 버전·목록 종류·원래 수집 시각·ID를 담은 정규 UTF-8 base64url JSON입니다. 자격 증명이나 접근 권한을 포함하지 않습니다. 서버는 디코딩 전 최대 2,048자 제한, 인코딩·버전·목록 종류·튜플·유효한 날짜/시각·비어 있지 않은 최대 256자 ID를 검증합니다. 저장된 ISO 오프셋, 날짜만 있는 값, 기존 SQLite UTC 시각 문자열도 원형을 유지해 SQL 경계를 비교합니다. 다른 목록의 커서는 재사용할 수 없습니다.

- 빈 값·잘못된 형식·과도한 길이·지원하지 않는 버전·다른 목록의 커서 또는 중복 `cursor`: HTTP 400 `{ "error": "invalid_cursor" }`.
- 범위 밖·소수·지수·공백 등을 포함한 `limit` 또는 중복 `limit`: HTTP 400 `{ "error": "invalid_limit" }`.
- 인증은 페이지 검증과 DB 조회보다 먼저 수행합니다. `Authorization: Bearer ADMIN_TOKEN`이 없거나 잘못되면 401, 서비스 토큰 설정 오류는 기존과 같이 503입니다. 수집/현황 토큰과 관리자 세션 쿠키 값은 API 토큰으로 사용할 수 없습니다. 성공·오류 모두 `Cache-Control: no-store`입니다.

이 목록은 스냅샷이 아닙니다. 검수·삭제된 항목은 사라지고 경계 뒤에 추가된 항목은 이어서 나타날 수 있습니다. 경계보다 앞선 시각/ID로 추가된 항목은 처음부터 다시 조회해야 합니다. 외부 후보의 재수집은 기존 `captured_at`을 변경하지 않습니다.

`/admin`은 각 목록을 20건씩 표시하고 `queue_cursor`, `candidate_cursor`를 독립적으로 사용합니다. 각 구역의 “다음 20건”·“처음부터”는 다른 구역과 `deal`, `deal_status`, `deal_cursor`를 유지합니다. 공구 필터 변경·ID 검색은 공구 위치만 초기화합니다. 승인·반려·확인 완료 및 판매자/공구 폼의 성공·입력 오류·충돌 리디렉션도 검증된 상태를 유지하며 고정 `/admin` 경로만 사용합니다. 검수 후에는 들어올 때의 커서부터 다시 읽어 남은 항목으로 페이지를 채웁니다. 잘못된 커서는 해당 구역만 처음부터 표시하고 안내하며, 동시 검수로 현재 위치가 비면 “처음부터”로 복구할 수 있습니다. DB 오류는 빈 목록으로 숨기지 않습니다.

사이트 D1의 `0012_admin_review_pagination.sql`은 두 테이블에 `(status, captured_at, id)` 인덱스를 추가하며 기존 데이터·인덱스를 유지합니다. Linux 수집기와 로컬 SQLite에는 적용하지 않습니다. 운영 적용과 검증·게시 절차는 운영자가 별도로 수행합니다.

### Instagram 수집과 검수

수집 JSON (최대 32KB, text 최대 20,000자):

```json
{
  "source_url": "https://www.instagram.com/p/원문ID/",
  "account": "실제_팔로잉_계정",
  "kind": "post",
  "text": "수집한 실제 원문",
  "captured_at": "2026-10-21T09:00:00+09:00",
  "suggestions": {
    "models": [{ "model_id": "model-1", "brand": "Stokke", "name": "트립트랩 하이체어(너도밤나무)", "matched": ["스토케", "트립트랩"], "confidence": 0.95 }],
    "price": { "value": 390000, "raw": "390,000원", "confidence": 0.9 },
    "dates": { "starts_at": "2026-10-26T00:00:00+09:00", "ends_at": "2026-10-28T23:59:59+09:00", "raw": "10/26~10/28", "confidence": 0.95 },
    "links": [{ "url": "", "kind": "link_in_bio", "confidence": 0.85 }],
    "confidence": 0.93
  }
}
```

위 예시는 프로토콜 설명용이며 시드/게시 데이터가 아닙니다. `kind`는 post/story, Instagram HTTPS 원문 URL만 허용합니다. `suggestions`는 선택(생략·null 가능)이고 크롤러 v2의 자동 추출 결과입니다. 형식이 어긋나면 400으로 거부됩니다. URL 중복은 기존 id/status를 반환합니다(202). 수집 즉시 pending, 공개 API/화면에는 미노출입니다. **제안은 `/admin` 검수 화면에 힌트로만 표시되며 사람이 승인하기 전까지 게시 데이터에 어떤 값도 반영되지 않습니다.**

`image_url`은 선택 항목(생략·null 가능)이며 최대 4,096자의 절대 HTTPS URL입니다. `cdninstagram.com`, `fbcdn.net` 및 실제 하위 도메인만 허용하고 사용자 정보·fragment·비표준 포트는 거부합니다. 서명 쿼리는 원문 그대로 저장하며 잘못된 값은 URL을 응답에 포함하지 않고 400으로 거부합니다. 이미 수집한 원문 URL은 이미지·본문을 덮어쓰지 않습니다. 이미지는 검수 대기열에만 저장되고 승인 전이나 반려 후에는 공개되지 않습니다.

승인 JSON은 `action: "approve"`, 등록된 `model_id`, `seller_id`, `title`, `price`(정수 원 또는 null), `starts_at`, `ends_at`(시간대 포함 ISO)을 받습니다. 이미지 포함 여부는 선택 boolean `include_image`로 지정하며 기본값은 true입니다. `/admin`의 인증된 미리보기 옆 “이미지 포함”을 해제하면 이미지 없이 게시합니다. 검수 API는 대체 `image_url`을 받지 않고 저장된 이미지만 승인 트랜잭션 안에서 복사합니다. 반려는 `{ "action": "reject" }`입니다. 승인 후 가격은 manual 검증 수준이며 원문 URL을 유지합니다. 이미 검수된 건은 409, 잘못된 입력은 400입니다. 게시와 검수 상태 변경은 D1 batch 트랜잭션으로 처리합니다. `/admin`의 모델·판매자 선택은 공란으로 시작하며 둘 다 직접 선택해야 합니다. 승인에는 `attribution`도 필수입니다. `account`는 정규화된 원문 계정과 선택한 판매자 사이에 검수된 연결이 있어야 합니다. `explicit`은 미연결·다른 판매자 연결·핸들이 아닌 계정에 사용할 수 있으며 `attribution_note`에 10–300자의 귀속 사유를 남겨야 합니다. 명시 귀속은 계정 연결을 만들거나 변경하지 않습니다. 반려에는 선택값·귀속 근거가 필요 없으며 브라우저 필수 입력 검증도 건너뜁니다.

`/admin`의 “판매자 등록·증빙”에서 대기열 유무와 무관하게 새 판매자를 등록할 수 있습니다. 등록·수정 입력은 `name`(100자 이하), `source_url`(HTTPS), 선택 증빙 `registration_source`, `withdrawal_source`, `official_import_source`입니다. 증빙을 비우면 NULL로 지워져 미확인으로 표시되며 원문 URL이나 계정으로 증빙을 추정하지 않습니다. URL은 자격 증명 없는 HTTPS만 허용합니다. 수정은 증빙 전체를 교체합니다.

등록 시 선택 `account`를 입력하거나 기존 판매자에 `link_account`할 때는 반드시 `account_reviewed: true`로 직접 확인해야 합니다. 계정은 앞뒤 공백·선행 @를 제거하고 소문자로 정규화하며 영문·숫자·점·밑줄 1–30자만 연결합니다. 한 계정은 한 판매자에만 연결할 수 있고 충돌은 409입니다. 계정 없는 등록은 기존 연결에 영향을 주지 않습니다. 핸들이 아닌 수집 계정은 따로 표시하며 명시 귀속만 가능합니다. 모든 판매자 관리 API는 ADMIN_TOKEN 전용이며 INGEST_TOKEN으로 관리할 수 없습니다. 수집 요청의 판매자 필드는 판매자를 생성하지 않습니다.

Linux 수집기의 `seller_candidates`는 사이트 판매자가 아니며 사이트가 가져오거나 자동 등록하지 않습니다. `external_candidates.seller_handle`도 판매자 등록·연결에 사용하지 않습니다. `seller_accounts` 및 승인 귀속 사유는 관리자 전용이며 공개 판매자·공구 응답에는 포함하지 않습니다.

게시된 공구는 `/admin`의 “게시된 공구 정정·철회”에서 관리합니다. 게시 중·철회됨·전체 탭과 “다음 20건”으로 오래된 공구까지 탐색하며, `/admin?deal=<id>`로 직접 찾을 수 있습니다. 원래 수집 본문·URL·이미지·판매자 귀속 사유와 검수 시각은 읽기 전용으로 보존합니다. 게시 시 v1 publish 이력을 만들고, 정정·철회마다 전체 상태와 사유를 다음 버전에 추가합니다. 사유·요청 ID·이력·수집 근거는 관리자 전용이며 공개 JSON에는 상태나 버전도 포함하지 않습니다.

정정(`action: "correct"`)은 등록된 `model_id`, 1–200자 `title`, 정수 원 또는 null `price`, 시간대 포함 `starts_at`·`ends_at`, boolean `include_image`를 모두 받습니다. 제목·사유는 앞뒤 공백을 제거하고 일정은 UTC로 정규화합니다. 이미지는 수집 원본에서 복원하거나 제거할 수만 있습니다. 원문 URL·검증 수준·판매자 귀속은 바꿀 수 없습니다. 판매자가 잘못되었으면 철회하세요. 정정 시 가격 확인일도 갱신합니다.

두 작업 모두 `expected_version`(1 이상 안전한 정수), `request_id`(영문·숫자·하이픈 16–64자, `review-` 접두사는 승인 이력용 예약), 10–300자 `reason`이 필요합니다. 폼은 렌더링할 때 각각 새 UUID를 생성합니다. 요청 ID는 정규화된 요청 내용의 SHA-256과 결합되므로 동일 요청을 재전송하면 200 `replayed: true`로 응답하고 버전·이력을 추가하지 않습니다. 같은 키의 다른 내용·동작·예상 버전은 409 `request_id_reused`입니다. 버전 경쟁은 409 `stale_version`과 `current_version`, 이미 철회된 공구의 새 작업은 409 `withdrawn`입니다. 버전 가드가 있는 D1 batch 하나에서 이력 추가와 현재 값 변경을 원자적으로 처리합니다.

`/admin`의 철회(`action: "withdraw"`) 폼은 공개 화면에서 내림 확인과 사유를 요구합니다. 철회는 최종 상태로 복원할 수 없으며, 모든 공개 목록·모델 비교·현재 공구가 카드·달력에서 사라지고 직접 상세 접근도 404가 됩니다. 동일 URL 재수집은 기존 approved 상태만 반환하고 원문이나 게시 내용을 바꾸지 않습니다. 재승인은 409이며 수집/현황 토큰으로 정정·철회 API를 호출할 수 없습니다. 이 기능은 사이트에만 속하며 Linux 수집기의 저장소나 게시 권한을 연결하지 않습니다.

승인·수집의 타임스탬프는 시간대 오프셋을 허용하며 UTC `YYYY-MM-DDTHH:MM:SS.SSSZ`로 정규화해 저장합니다. 존재하지 않는 날짜(예: 2월 30일)와 종료 ≤ 시작인 일정은 400으로 거부합니다. 제안 일정은 같은 엄격한 검증을 거치되 원문 값을 보존하며, 공개 화면의 일정·확인일은 KST로 표시합니다.

승인된 이미지는 공구 카드·상세 화면에서 브라우저가 직접 불러옵니다(`referrerPolicy="no-referrer"`, 지연 로딩, 서버 프록시·최적화 요청 없음). 이미지가 없거나 로딩에 실패해도 텍스트·가격·광고 및 거래 안내는 유지됩니다. **Instagram CDN URL은 만료될 수 있으므로 영구 보관을 보장하지 않습니다.** 현재 ingest는 R2 업로드를 지원하지 않습니다. R2 영구 저장은 업로드와 검수 후 공개 계약을 별도로 설계해야 합니다.

### 외부 공구 모음 후보 (`kind: "external_listing"`)

이 호환 ingest는 **현재도 쓰기 가능**합니다. INGEST_TOKEN으로 새 후보를 삽입하고, 같은 URL의 `candidate` 행은 제목·본문·판매자 단서·가격·일정·`last_seen_at` 등을 갱신합니다. `dismissed` 행은 그대로 두며 두 경우 모두 202와 저장된 id/status를 반환합니다. `crawler/lib/ingest.ts`도 이 종류의 전송과 `candidate`/`dismissed` 응답을 지원하지만, 현재 Instagram 실행부와 독립 로컬 수집함은 외부 후보를 이 경로로 보내지 않습니다. 관리자 권한은 목록 조회와 dismiss뿐입니다. 공구팡팡·맘캘린더·BUYG·스냅업 같은 외부 공구 모음 사이트의 가격은 지난 가격이거나 AI 요약일 수 있어 **후보로만** 저장합니다. 같은 `POST /api/v1/ingest`에 `kind: "external_listing"`을 보내면 `ingested_items`가 아니라 별도 테이블 `external_candidates`(마이그레이션 `0006`)에만 저장됩니다. 승인 API(`admin/review`)는 이 테이블을 읽지 않으므로 외부 후보는 공구가로 게시될 수 없고, 공개 GET API·화면은 이 테이블을 읽지 않습니다. `price_hint`·`price_raw`는 공구가나 공식가로 표시되지 않습니다. 후보를 공구로 승격하는 경로는 없습니다. Instagram 원문을 별도로 수집하고 사람이 승인한 경우에만 기존 게시 경로를 사용할 수 있습니다. `/admin`에는 참고용 목록과 “확인 완료”(dismiss) 버튼만 있습니다.

```json
{
  "kind": "external_listing",
  "source": "pangpang",
  "source_url": "https://09pangpang.com/deal/예시",
  "account": "pangpang",
  "title": "예시 제목",
  "text": "예시 제목 / 기간 10/26~10/28 / 가격 390,000원 / 셀러 @seller",
  "seller_handle": "seller", "seller_name": null, "seller_url": "https://www.instagram.com/seller/",
  "price_hint": 390000, "price_raw": "390,000원", "price_basis": "external_listing",
  "starts_at": "2026-10-26T00:00:00+09:00", "ends_at": "2026-10-28T23:59:59+09:00", "dates_raw": "10/26~10/28",
  "category": "high_chair", "model_match": true,
  "captured_at": "2026-10-22T00:30:00Z",
  "suggestions": { "models": [], "price": null, "dates": null, "links": [], "confidence": 0 }
}
```

위 값은 프로토콜 설명용 예시이며 실제 데이터가 아닙니다.

- 허용 소스·호스트는 `lib/data.ts`의 `EXTERNAL_SOURCES`(`pangpang`, `momcalendar`, `buyg`, `snapup`) 한 곳에서 검증합니다. 소스를 추가하려면 이 상수만 바꾸면 되고 DB 제약은 없습니다. `source`와 `source_url` 호스트(`www.` 변형 포함)가 일치하지 않거나 gonggumoa·Instagram·그 밖의 호스트, http, 자격 증명, fragment, 비표준 포트는 400입니다.
- `source_url`은 저장 전에 정규화합니다: 호스트 소문자·`www.` 제거, `utm_*`·`fbclid`·`gclid`·`igshid`·`ref`·`from`·`share` 제거, 남은 쿼리 키 순서 정렬, 끝 `/` 제거, 한글 경로 퍼센트 인코딩 통일. 정규화 결과가 UNIQUE 키이며 `/api/`, `/my/`, `/auth/` 경로는 서버에서도 400입니다.
- 길이 상한: `title` 200자, `text` 2,000자, `price_raw`·`dates_raw`·`seller_name` 100자(요청 전체 32KB). `image_url` 키가 있으면 400입니다. `model_match`는 boolean만 받습니다(누락 시 false).
- 같은 URL을 다시 보내면 `candidate` 상태일 때만 `last_seen_at`과 가격·일정·제목을 갱신하고, `dismissed`는 갱신하지 않고 같은 202로 응답합니다.

## 운영 일정

아래 값은 체크인된 기본값이며 실시간 실행 상태를 보증하지 않습니다. 수집 상세는 [설정과 주기](crawler/README.md#설정과-주기), [운영](crawler/README.md#운영)을 참고하세요.

| 시스템·모드 | 일정·제한 | 설정 근거 |
| --- | --- | --- |
| Instagram PM2 | `30 9,20 * * *`: 매일 KST 09:30·20:30, `AGAMAJUNG_ONCE=1`로 한 사이클 후 종료. `autorestart: false`, `stop_exit_codes: [75]` | `crawler/ecosystem.config.cjs`. cron은 **PM2 데몬**의 시간대이므로 데몬도 Asia/Seoul이어야 함. 자식 `TZ`만으로는 바뀌지 않음 |
| Instagram 공유 계정 휴식 | `06:45-08:00,13:00-14:00` KST(시작 포함·끝 제외). 브라우저·로그인·팔로우·스캔 중단, 실행 중에도 브라우저를 닫고 종료 후 지터 대기 | `quiet_windows`, `AGAMAJUNG_QUIET_WINDOWS`. 공유 계정에서 로그아웃하지 않음 |
| Instagram 직접 연속 모드 | 알림·홈 스토리 트레이 1–2분 지터, 프로필 재확인 최소 90분·스토리 최소 30분, 태그 발견 최소 6시간 간격. 작업 시간·행동 한도·휴식에 따라 지연 | `crawler/config/settings.json`, `crawler/index.ts` |
| Instagram systemd 대안 | 연속 모드, 실패 시 600초 뒤 재시작. `RestartPreventExitStatus=75`로 차단·챌린지 시 자동 재시작 금지 | `crawler/agamajung-crawler.service`. PM2와 동시 실행 금지 |
| Workers Cron | `0 */6 * * *`(UTC, 6시간 간격), 로그만 기록 | `wrangler.jsonc`, `worker.ts`. Linux 수집을 호출하지 않음 |
| 독립 discover/collect | Linux 상주 `schedule`: KST 09:20·15:20·21:20 / 09:40·15:40·21:40, 누락 병합 | `crawler/config/schedule.json`, `crawler/collector-scheduler.ecosystem.config.cjs`. 수집은 crawl 잠금으로 1개. [슬롯 운영](docs/collector/scheduling.md). [동시 실행과 잠금](crawler/README.md#동시-실행과-잠금) |
| 건수 sync | heartbeat 15분(`STATUS_HEARTBEAT_MS`). sync 호출 때 새 스냅샷 필요 여부 확인, 내장 timer 없음. 운영자는 15분 이하 간격으로 실행(같은 sync 중복은 자동 거부) | `crawler/src/status-sync.ts`, [동기화 운영](crawler/README.md#건수-동기화) |
| 사이트 현황 | 스냅샷 **생성** 후 60분 초과 시 동기화 지연 | `lib/collection-status.ts`. 수신 시각 기준이 아님 |

`pm2 start crawler/ecosystem.config.cjs`는 등록 즉시 한 번 실행합니다. 예약만 등록하는 절차와 보안 중단 후 수동 확인은 수집기 운영 문서를 따르세요. discover/collect는 별도 상주 스케줄러 정의를 제공하며 sync 타이머는 운영자가 관리합니다.

## 블루프린트와 다른 점

1. Google과 함께 **Kakao 로그인**을 구현했습니다. Naver·자체 가입폼은 없고 뉴스레터는 기본 체크입니다.
2. collector-status는 **POST `/api/v1/collector/status`**(현황 토큰)와 **GET `/api/v1/admin/collection-status`**(관리자)로 나뉘며 건수 스냅샷만 저장합니다.
3. `/brands` 페이지는 없고 `/models?by=brand`와 `GET /api/v1/brands`가 브랜드 탐색을 담당합니다.
4. `/me`, `/sellers`, `/api/v1/images/:key`(R2 `public/`만), 관리자 판매자·공구 정정/철회·후보 API가 추가되어 있습니다.
5. legacy **`kind: "external_listing"` ingest는 여전히 쓰기 가능**합니다. 새 external_candidates 삽입과 candidate 갱신만 하며 dismissed는 보존합니다. 관리자는 조회·dismiss만 할 수 있고 후보를 공구로 승격하는 경로는 없습니다. price_hint/price_raw는 공구가나 공식가로 표시되지 않습니다.
6. Workers Cron은 **로그 전용 stub**입니다. 모든 수집은 Linux에서 실행합니다.

## 검증

저장소 루트의 검증 명령입니다.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
npm run build:clipper
```

Vitest는 메모리 SQLite 및 로컬 파일로 가격 매핑·인증·검수 격리·중복·수집 일정·전송·복구·확장 동작을 검증하며 실제 소켓·fetch·브라우저 실행을 차단합니다. 문서 정확성은 `package.json`, `wrangler.jsonc`, `app/**/page.tsx`·`route.ts`, `lib/api.ts`, 수집기 진입점·CLI·PM2/systemd 설정과 링크를 읽기 전용으로 대조해 확인합니다. 코드 테스트만으로 문서가 정확해지지는 않습니다.

Worker 빌드 후 `wrangler dev --local --test-scheduled`와 로컬 `/__scheduled` 요청으로 Cron stub을 수동 확인할 수 있습니다. 이 확인도 원격 리소스를 사용하지 않습니다.

리콜 도구는 `--fixture <json> --sources <json> --out <json>`으로 네트워크 없이 실행할 수 있습니다. fixture는 브랜드별 `queries: { "검색어": { "title": [...], "product": [...] } }`로 대체 질의 결과를 구분할 수 있습니다. 기본 fixture 형식은 브랜드별 `{ "title": [CPSC 원시 행], "product": [CPSC 원시 행] }`이며 `{ "error": "blocked" }`로 실패를 재현합니다. 고정 User-Agent·요청 간 5초·응답 2MB 상한·리디렉트 금지·요청 제한 시간을 적용합니다. 일부 브랜드 실패는 해당 브랜드에만 기록하고, 전체 실패 시 출력 파일을 덮어쓰지 않습니다. 재조회 파일과 모델별 검토 결과는 별도이므로, 갱신 후 `bundle.safety.recalls.cpsc`도 다시 검토해야 합니다. 교차 검증 테스트가 오래된 모델별 검토 기록을 감지합니다. 실시간 네트워크 조회는 단위 테스트에 포함하지 않습니다.

## 사이트 손글씨 서체

제목·로고·강조 문구는 자체 호스팅 Excalifont(영문·숫자)와 Gaegu(한글)를 사용합니다. 본문·가격·표·광고·검증·법적 안내는 기존 sans를 유지합니다. 두 서체의 전체 OFL 라이선스는 `public/fonts/`에 포함되어 있습니다. 고정 원본·체크섬·한글 서브셋 재생성·CLS 및 모바일/데스크톱 검증 결과는 [서체 문서](docs/fonts/README.md)를 참고하세요.

`npm test`에 오프라인 서체 검증이 포함됩니다. `npm run build:worker`는 데몬의 기본 검증 외 추가 통합 검사입니다. 로컬 Wrangler 실행 후 브라우저 검증은 아래처럼 별도로 수행합니다.

```sh
npx tsx scripts/typography-check.ts --verify
```

CLS 비교에는 변경 전 `--baseline` 결과가 필요하며, 생성된 결과·스크린샷은 `.local/typography/`에 저장합니다. 수집기·사이트 데이터는 변경하지 않습니다.

## 상품 손그림 에셋

`lib/model-illustrations.ts`는 시드 41개 모델 모두에 `/img/models/model-N.svg`와 `1080×1080` 크기를 반환합니다. `public/img/models/`에는 1:1 정사각 SVG 41개만 있으며 카드는 `<img>`로 직접 표시합니다. `srcSet`·`sizes`·PNG 파생 파일·이미지 최적화 서버를 사용하지 않습니다. 런타임은 정적 ID 허용 목록만 사용하며 시드를 import하지 않습니다. 알 수 없는 ID는 `null`을 반환하고 브랜드 첫 글자 자리표시를 유지합니다.

그림은 투명 배경의 순수 선화이며 제품과 확인된 구성품만 그립니다. 글자·글자 모양 경로·로고·배경·액자·그림자·내장 래스터·외부 참조·스크립트는 허용하지 않습니다. 상품명은 HTML `alt`와 비표시 SVG `<title>`로 제공합니다. 카드의 네 항목(상품명·손그림·공식가·현재 공구가)은 그대로입니다.

```sh
npx tsx scripts/render-model-illustrations.ts            # 시드 41개 SVG 검증, 파일 생성 없음
npx tsx scripts/render-model-illustrations.ts model-32 model-39
npx tsx scripts/render-model-illustrations.ts --out .local/illustration-previews
npx tsx scripts/card-screenshots.ts --out .local/card-qa
```

검증·스크린샷은 Playwright로 서버·네트워크 없이 실행합니다. SVG를 252px·540px로 메모리 렌더링하여 정사각 크기·투명 여백(2.5%)·잉크 밀도(20% 미만)·잘림을 검사하며, PNG 미리보기는 명시한 `.local/` 하위 디렉터리에만 저장합니다. 스크린샷은 레지스트리가 아닌 **시드 전체**를 기준으로 하여 누락 등록도 실패시킵니다. 390px 모바일·1280px 데스크톱 × 라이트·다크 전체 화면 4장과 기본 41개 카드 164장을 저장합니다(`--cards model-32,model-39`로 개별 카드 저장 범위 선택). 이미지 디코딩·정사각 크기·공구가 행 높이(40px 이하)·같은 행 카드 높이·가로 넘침과 시드 밖 `model-42` 자리표시를 검사합니다. 경로 수나 자동 검사만으로 제품 충실도를 판정하지 않으며 출처와 렌더링을 눈으로 대조합니다.

model-32는 D.THRONE 공식 이니셜 갤러리 사진, model-39는 Silver Cross Thailand의 Dune 2 사진과 해당 세대 설명서로 외형을 확인했습니다(2026-10-31). 두 모델 모두 조립된 본체를 그렸으며 국내 부속품 묶음은 미확인입니다. 기존 모델의 글로벌 구성·작은 부속품 가독성·DUALFIX 트림 간 동일 구조 한계도 유지합니다. 새 근거·실행 결과와 과거 기록은 [배치 4 제작 기록](docs/model-illustrations-batch-4.md#8-svg-직접-표시-및-누락-모델-보완-2026-10-31)을 참고하세요. 참조 사진·설명서는 저장소에 추가하지 않습니다.

## 구현 기록 (참고용)

아래는 과거 구현·조사 시점의 기록입니다. 현재 설정·리소스 상태나 이번 문서 정리에서 실행한 작업을 뜻하지 않습니다. 현재 로컬 절차는 위의 로컬 실행 절을 따릅니다.

마이그레이션 `0005_users.sql`(users, user_identities, sessions)은 CREATE만 있는 add-only입니다. **로컬(`npm run db:migrate`)에만 적용했고 운영 D1 적용은 운영자가 따로 합니다.** 세션 토큰은 해시만 저장합니다(30일).

`0011_deal_lifecycle.sql`은 추가 전용 마이그레이션으로 기존 공구도 v1 publish 이력을 보존합니다. **로컬 D1에만 `npm run db:migrate`로 적용하며 운영 D1 적용은 운영자가 별도로 수행합니다.**

`0010_seller_onboarding.sql`은 추가 전용 마이그레이션입니다. **로컬(`npm run db:migrate`)에만 적용하며 운영 D1 적용은 운영자가 별도로 수행합니다.**

`0009_normalize_deal_timestamps.sql`은 기존 공구의 유효한 시작·종료를 함께 UTC로 바꾸는 전진 마이그레이션입니다. 잘못된 날짜나 역전된 일정은 원문 그대로 남겨 화면에 일정 미확인으로 표시합니다(이 행의 SQL 정렬은 기존 문자열 기준). **로컬(`npm run db:migrate`)에만 적용하고 운영 D1 적용은 운영자가 따로 합니다.**

`0007_collector_status.sql` 적용과 COLLECTOR_STATUS_TOKEN 운영 바인딩은 운영자가 별도로 수행하도록 안내했습니다. 로컬 수집함 DB와 사이트 D1을 연결하는 작업이 아닙니다.

41개 모델은 2026-10-23 공식 페이지 본문 확인을 시도하여 읽은 정상가와 확인 불가 상태를 구분했습니다. 이번 근거 정리에서는 공식가 확인 12개, 미확보 29개(접속 실패 16개)로 공개 공식가가 줄어듭니다. 트립트랩 오크 정상가는 기존 470,000원에서 공식 본문 510,000원으로 바뀝니다. 접속 실패 URL은 시도 기록으로만 남기고 출처 링크를 비웁니다. 기존 수입사 정보는 접속 오류만으로 삭제하지 않고 재확인 실패를 표시합니다. 세대·국내 정식 구성도 본문에서 확정하지 못하면 명시적 미확인 객체로 기록합니다. 세부 근거는 [모델 근거 기록](docs/model-evidence-2026-10-23.md)에 있습니다.

OAuth 구현 때 공급자 콘솔 설정은 수행하지 않았습니다. Instagram 상품 이미지 URL 구현은 R2에 저장하지 않았으며, 현재도 ingest 업로드 계약이 없습니다. CDN 직접 표시 계약은 현재 API 설명을 따릅니다.

공식 참조·구성품·세부 경로·시각 검수와 서버 축소 요청 제한은 [배치 1 제작 기록](docs/model-illustrations-batch-1.md), [배치 2 제작 기록](docs/model-illustrations-batch-2.md), [배치 3 제작 기록](docs/model-illustrations-batch-3.md), [배치 4 제작 기록](docs/model-illustrations-batch-4.md)에 있습니다.

Linux 수집 봇의 새 출처 탐색은 [소스 발견기](docs/collector/source-discoverer.md)를 사용합니다. `discover-sources`는 검색 API·승인된 sitemap/RSS/목록에서 별도 `source_candidates` 후보만 만들며 사이트·자료 접수·수집 권한과 분리됩니다. 기본 비활성이며 collect와 공유 요청 예산을 사용합니다. `discover-sources --dry-run`은 오프라인 계획 조회입니다.
