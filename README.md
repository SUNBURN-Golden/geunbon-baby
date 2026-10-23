# 아가마중

> 너는 건강하게만 와 주렴. 좋은 것은 우리가 골라 둘게.

오래 곁에 둘 프리미엄 근본 육아용품 가격 비교·공구 정보 MVP입니다. Next.js App Router + TypeScript, OpenNext Cloudflare Workers, D1, R2를 사용합니다. 기저귀·분유·결제·주문 기능은 없습니다.

## 로컬 실행 (Workers/Miniflare 전용)

Node.js **22 이상**, npm이 필요합니다. 실제 Cloudflare 리소스를 생성하거나 배포할 필요가 없습니다.

```sh
npm ci
cp .env.example .dev.vars
```

`.dev.vars`의 ADMIN_TOKEN과 INGEST_TOKEN에 **서로 다른 충분히 긴 임의 값**을 직접 설정합니다. 비워두면 관련 API는 503으로 닫힙니다. 이 파일은 gitignore 대상입니다. 크롤러 전용 환경변수는 별도의 로컬 파일로 분리해 관리하세요.

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

`npm run dev`는 OpenNext 빌드 후 `wrangler dev --local`로 로컬 workerd/Miniflare만 실행합니다. 기본 접속 주소는 `http://localhost:8787`입니다. `next dev`는 사용하지 않습니다. 소스 수정 후 빌드를 다시 실행하세요. 시드는 `.local/seed.sql`로 생성되며 재실행해도 기존 검수·수집 데이터는 지우지 않습니다. 데이터 구조 변경은 `/migrations`에 추가합니다.

`wrangler.jsonc`의 D1 UUID는 **로컬용 자리표시자**입니다. 실제 배포 시 운영자가 이미 준비한 리소스 ID/버킷명과 비밀 바인딩을 별도로 설정해야 합니다. 이 MVP 작업에서는 리소스 생성, 업로드, 배포를 수행하지 않습니다. Cron은 6시간 간격의 로그 stub일 뿐 크롤러를 Workers에서 실행하지 않습니다. R2는 `IMAGES` 바인딩이며 `/api/v1/images/:key`가 `public/` 아래 검수된 jpg/png/webp/avif 파일만 읽습니다. 시드에 사진이 없어 제품 사진을 만들거나 임의 외부 이미지를 가져오지 않습니다.

## 화면

- `/`: 브랜드 소개
- `/models`: 종류·브랜드·모델명 검색. 카드에는 상품명·손그림·공식가·진행 중 공구가만 표시하고 진행 중인 공구가 있는 모델을 먼저 보여줌. 손그림은 `public/img/models/` 정적 에셋이며 `lib/model-illustrations.ts` 목록으로 연결하고, 없는 모델은 자리표시를 씀
- `/models/:id`: 공구가 / 공식가 / 해외가 / 당근 중고 시세, 출처·확인일·검증 수준
- `/deals`, `/calendar`: 검수 완료 공구 및 일정 (전부 **광고** 표시)
- `/sellers`: 통신판매업 신고·청약철회 7일·정식수입 증빙. 시드에 증빙이 없으므로 미확인으로 표시
- `/login`, `/me`: 구글·카카오 소셜 로그인 가입(자체 가입폼 없음)과 내 계정(뉴스레터 해지·재구독, 로그아웃). 아래 "소셜 로그인" 참고
- `/admin`: ADMIN_TOKEN 로그인 후 검수 대기 원문 승인/반려. 크롤러가 보낸 자동 추출 제안(모델·가격·일정·링크 후보와 근거)은 참고용으로만 함께 표시. httpOnly·SameSite strict 1시간 쿠키, Next.js Server Actions의 동일 origin 검증 사용. 공개 화면에는 대기 원문을 전달하지 않음

로컬 HTTP의 localhost는 브라우저 secure cookie 예외가 적용됩니다. 관리자 접속은 localhost를 사용하세요. 공유/운영 환경은 HTTPS가 필수입니다. 토큰을 URL에 넣지 마세요. 운영 공개 전 관리자 경로와 ingest에 Cloudflare Access/WAF 등의 접근통제·레이트리밋을 별도로 설정하는 것을 권장합니다.

## 소셜 로그인

가입은 구글·카카오 소셜 로그인만 지원합니다(네이버·자체 가입폼 없음). 의존성 없이 OAuth 2.0 authorization code 흐름을 직접 구현했고 Workers의 `fetch`와 `crypto.subtle`만 씁니다.

- 흐름: `/login`의 한 `<form method="get">`에 뉴스레터 체크박스(기본 체크)와 공급자 버튼이 함께 있습니다. `GET /api/auth/login/{google,kakao}`가 state(구글은 PKCE 포함)와 체크박스 값을 `agamajung_oauth` 쿠키(httpOnly·SameSite=Lax·Path=/api/auth/callback·10분)에 담아 공급자로 302하고, `GET /api/auth/callback/{google,kakao}`가 state를 확인한 뒤 토큰 교환 → 이메일·공급자 id 조회 → D1 기록 → 세션 쿠키 발급 후 `/me`로 302합니다. 로그아웃은 `/me`의 서버 액션으로만 처리합니다(GET 라우트 없음). 모든 인증 응답은 `Cache-Control: no-store`입니다.
- 환경변수(`.dev.vars` 또는 운영 비밀 바인딩): `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`(둘 다 필요), `KAKAO_REST_KEY`(필수)·`KAKAO_CLIENT_SECRET`(선택), `AUTH_ORIGIN`(기본 `https://agamajoong.soulbound.co.kr`, 로컬은 `http://localhost:8787`). 설정되지 않은 공급자는 버튼이 숨겨지고 login·callback이 404이며, 모두 미설정이면 `/login`에 준비 중 안내만 보입니다. 쿠키 `Secure`는 `AUTH_ORIGIN`이 https일 때만 켜집니다. 리디렉트 URI는 Host 헤더가 아니라 `AUTH_ORIGIN`으로 고정됩니다.
- 운영자가 등록할 리디렉트 URI(Google Cloud Console, Kakao Developers):
  - `https://agamajoong.soulbound.co.kr/api/auth/callback/google`
  - `https://agamajoong.soulbound.co.kr/api/auth/callback/kakao`
  - 카카오는 동의항목에서 카카오계정(이메일)을 켜야 합니다. 이 작업에서는 공급자 콘솔 설정을 하지 않았습니다.
- 수집 정보: 이메일과 공급자 id뿐입니다. 액세스·리프레시 토큰, 이름, 프로필은 저장하지 않습니다. 구글은 `email_verified`, 카카오는 `is_email_valid`·`is_email_verified`가 참인 이메일만 받습니다.
- 마이그레이션 `0005_users.sql`(users, user_identities, sessions)은 CREATE만 있는 add-only입니다. **로컬(`npm run db:migrate`)에만 적용했고 운영 D1 적용은 운영자가 따로 합니다.** 세션 토큰은 해시만 저장합니다(30일).
- 뉴스레터: 신규 가입 때만 체크박스 값과 동의 시각을 기록하고 재로그인은 값을 바꾸지 않습니다. `/me`에서 해지·재구독할 수 있습니다.
- 이메일이 같아도 공급자가 다르면 별도 계정입니다(자동 연결 없음). 따라서 **뉴스레터 발송 시 이메일 기준 중복 제거가 필요**합니다. **계정 삭제는 후속 과제**입니다. 레이트리밋은 Cloudflare 운영 설정에 맡깁니다.

## JSON REST API v1

읽기 응답은 `{ "data": ... }`, 실패는 `{ "error": "..." }`입니다. 현재 동일 origin API이며 향후 Expo 네이티브 클라이언트에서도 사용할 수 있습니다. 브라우저 cross-origin CORS는 열지 않았습니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/v1/brands` | 브랜드·모델 수 |
| GET | `/api/v1/models?brand=Stokke&category=high_chair` | 모델 목록 |
| GET | `/api/v1/models/model-1` | 모델과 가격 비교 |
| GET | `/api/v1/deals` | 검수 완료 공구 (예정·진행·종료 포함) |
| GET | `/api/v1/sellers` | 판매자 및 배지 증빙 URL |
| GET | `/api/v1/calendar` | 시작일순 검수 완료 공구 |
| POST | `/api/v1/ingest` | `Authorization: Bearer INGEST_TOKEN` |
| GET | `/api/v1/admin/queue` | `Authorization: Bearer ADMIN_TOKEN`, 최대 100건 |
| POST | `/api/v1/admin/review/:id` | 관리자 승인/반려 |
| GET | `/api/v1/admin/candidates` | `Authorization: Bearer ADMIN_TOKEN`, 외부 공구 모음 후보(candidate) 최대 200건 |
| POST | `/api/v1/admin/candidates/:id` | `{ "action": "dismiss" }`만 허용(그 외 400, 이미 처리됨 409, 없는 id 404) |

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

승인 JSON은 `action: "approve"`, 등록된 `model_id`, `seller_id`, `title`, `price`(정수 원 또는 null), `starts_at`, `ends_at`(시간대 포함 ISO)을 받습니다. 이미지 포함 여부는 선택 boolean `include_image`로 지정하며 기본값은 true입니다. `/admin`의 인증된 미리보기 옆 “이미지 포함”을 해제하면 이미지 없이 게시합니다. 검수 API는 대체 `image_url`을 받지 않고 저장된 이미지만 승인 트랜잭션 안에서 복사합니다. 반려는 `{ "action": "reject" }`입니다. 승인 후 가격은 manual 검증 수준이며 원문 URL을 유지합니다. 이미 검수된 건은 409, 잘못된 입력은 400입니다. 게시와 검수 상태 변경은 D1 batch 트랜잭션으로 처리합니다. 판매자 신규 등록·배지 증빙은 현재 관리자 UI 범위에 없으며 운영자가 검증한 근거를 D1 마이그레이션으로 추가해야 합니다.

승인된 이미지는 공구 카드·상세 화면에서 브라우저가 직접 불러옵니다(`referrerPolicy="no-referrer"`, 지연 로딩, 서버 프록시·최적화 요청 없음). 이미지가 없거나 로딩에 실패해도 텍스트·가격·광고 및 거래 안내는 유지됩니다. **Instagram CDN URL은 만료될 수 있으므로 영구 보관을 보장하지 않습니다.** 현재 ingest는 R2 업로드를 지원하지 않습니다. R2 영구 저장은 업로드와 검수 후 공개 계약을 별도로 설계해야 합니다.

### 외부 공구 모음 후보 (`kind: "external_listing"`)

공구팡팡·맘캘린더·BUYG·스냅업 같은 외부 공구 모음 사이트의 가격은 지난 가격이거나 AI 요약일 수 있어 **후보로만** 저장합니다. 같은 `POST /api/v1/ingest`에 `kind: "external_listing"`을 보내면 `ingested_items`가 아니라 별도 테이블 `external_candidates`(마이그레이션 `0006`)에만 저장됩니다. 승인 API(`admin/review`)는 이 테이블을 읽지 않으므로 외부 후보는 공구가로 게시될 수 없고, 공개 GET API·화면은 이 테이블을 읽지 않습니다. 인스타 원문으로 확인된 항목만 기존 경로로 공구가가 됩니다. `/admin`에는 참고용 목록과 “확인 완료”(dismiss) 버튼만 있습니다.

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

## 가격 원칙

최초 데이터는 **`seed/models.json`, `seed/tripp_trapp.json`만** 사용합니다. 시드 자체를 실시간 재검증했다는 의미는 아닙니다. 가격이 null이거나 수집되지 않았으면 **정보 없음**입니다. 시드에 공구가·일정이 없으므로 공구와 달력은 빈 화면이 정상입니다.

- 가격은 국내 공식가와 검수된 공구가만 보관·표시합니다. 해외가·환율·중고가·직구가·일반 판매처 할인가는 시드와 모델 메모에 보관하지 않습니다.
- `kr_retailers`는 판매자 이름과 출처 URL만 보관하며 가격은 포함하지 않습니다.
- `page_text`와 `search_summary`의 근거 차이를 보존합니다. 공식가 미확인 모델은 다른 판매가로 대체하지 않습니다.
- 모든 공구는 광고이며 구매·결제는 판매처 링크아웃만 제공합니다. 아가마중은 거래 당사자가 아닙니다.

## 크롤러

별도 Linux Node+Playwright worker의 설치·보안·제약은 [crawler/README.md](crawler/README.md)를 참고하세요. Workers Cron에서 Instagram에 접속하지 않습니다. v2 크롤러는 검수 가능한 설정 파일(`crawler/config/`)로 시드 계정·속도 한도를 관리하고, 알림·스토리 트레이 신호로 수집 우선순위를 정하며, 캡션·스토리 OCR에서 모델·가격·공구 일정·링크를 자동 추출해 **제안**으로만 검수 대기열에 함께 전송합니다. 사람 승인 전까지 게시되지 않습니다. 자동 팔로우는 일일 상한·무작위 간격을 지키고 차단·챌린지 감지 시 즉시 중단합니다. 외부 공구 모음 사이트(공구팡팡·맘캘린더·BUYG·스냅업)는 같은 크롤러가 Instagram 사이클 전에 공개 페이지만 읽어 후보로 보냅니다(robots.txt 준수, 로그인 없음, 공구모아 수집 금지). 자세한 내용과 운영 전 dry-run 절차는 [crawler/README.md](crawler/README.md)의 “외부 공구 모음 사이트” 절을 참고하세요. 공유 계정을 쓰는 다른 두 봇을 위해 매일 **06:45~08:00, 13:00~14:00 Asia/Seoul**에는 브라우저·로그인·팔로우·스캔을 쉬고, 실행 중에도 다음 휴식 시작에 브라우저를 닫고 각 Instagram 행동 전에 확인합니다. `quiet_windows` 배열 설정이나 `AGAMAJUNG_QUIET_WINDOWS='06:45-08:00,13:00-14:00'` 환경변수로 여러 시간을 지정하며 자정 통과도 지원합니다. 겹치거나 맞닿은 시간은 합친 종료 후 지터를 한 번 더해 재개하고 건강 로그에 진입·종료를 남깁니다. 이전 `quiet_window` 설정과 `AGAMAJUNG_QUIET_WINDOW` 환경변수도 읽으며 각각 복수형이 우선합니다.

## 개발 작업 데몬

박스의 작업 큐·모델 폴백·독립 worktree·검수 후 PR squash merge 자동화는 [tools/dev-daemon/README.md](tools/dev-daemon/README.md)를 참고하세요. 사이트·크롤러와 별도 PM2 앱 `agamajung-dev-daemon`으로 실행합니다.

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
npx tsx scripts/card-screenshots.ts --out <dir>   # /models 카드 모바일·데스크톱 × 라이트·다크 스크린샷 (서버·네트워크 불필요)
```

`tests`는 Vitest와 메모리 SQLite로 가격 매핑·인증·검수 격리·중복 및 크롤러 추출·한도·지터·발견·셀렉터·OCR 실패 복구를 확인합니다. 테스트에서 소켓·실제 fetch·브라우저 실행을 차단하며 네트워크 접속 없이 검증합니다. Worker 빌드 후 `wrangler dev --local --test-scheduled`와 로컬 `/__scheduled` 요청으로 Cron stub을 수동 확인할 수 있습니다. 배포 스크립트는 의도적으로 제공하지 않습니다.

### 상품 손그림 에셋

`lib/model-illustrations.ts`가 모델별 이미지 규격을 반환합니다. 기존 여섯 모델은 SVG와 `540×675`·`252×315` PNG를 유지하며, model-11–20은 편집 가능한 `1080×1080` SVG와 투명 `540×540`·`252×252` PNG를 사용합니다. 신규 선화에는 제품 경로만 넣고 글자·로고·종이 배경·액자·그림자를 넣지 않습니다. 상품명은 HTML `alt`와 비표시 SVG `<title>`로 제공합니다.

```sh
npx tsx scripts/render-model-illustrations.ts            # 이번 배치만 두 크기로 재생성
npx tsx scripts/render-model-illustrations.ts model-13   # 특정 모델만
npx tsx scripts/card-screenshots.ts --out .local/card-screenshots-batch2
```

렌더링·스크린샷은 기존 Playwright를 쓰며 서버나 네트워크가 필요 없습니다. 스크린샷은 신규 열 모델과 기존 이미지·자리표시를 모바일 390px·데스크톱 1280px × 라이트·다크에서 확인하며 이미지 디코딩 완료 후 전체 화면 4장과 신규 카드 40장을 저장합니다. 공식 참조·구성품·세부 경로·시각 검수 기록은 [배치 2 제작 기록](docs/model-illustrations-batch-2.md)을 참고하세요. 참조 사진은 서버에서 축소된 작은 썸네일만 임시 확인하고 즉시 삭제하며 저장소에 보관하지 않습니다.
