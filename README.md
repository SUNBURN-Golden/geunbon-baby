# 아가마중

> 너는 건강하게만 와 주렴. 좋은 것은 우리가 골라 둘게.

오래 곁에 둘 프리미엄 근본 육아용품 가격 비교·공구 정보 MVP입니다. Next.js App Router + TypeScript, OpenNext Cloudflare Workers, D1, R2를 사용합니다. 기저귀·분유·결제·주문 기능은 없습니다.

## 로컬 실행 (Workers/Miniflare 전용)

Node.js **22 이상**, npm이 필요합니다. 실제 Cloudflare 리소스를 생성하거나 배포할 필요가 없습니다.

```sh
npm ci
cp .env.example .dev.vars
```

`.dev.vars`의 ADMIN_TOKEN과 INGEST_TOKEN에 **각각 24자 이상이며 앞뒤 공백이 없는 서로 다른 임의 값**을 직접 설정합니다. COLLECTOR_STATUS_TOKEN도 설정 시 같은 길이·공백 규칙을 지키고 두 토큰과 모두 달라야 합니다. 관리자·수집 토큰 중 하나라도 누락되거나 규칙을 어기거나 현황 토큰과 같으면 admin/ingest API는 모두 503으로 닫히고 `/admin`에는 인증 설정 안내만 표시됩니다. 공개 읽기 API는 계속 사용할 수 있으며, collector/status는 별도로 현황 토큰을 검증합니다. 이 파일은 gitignore 대상입니다. 크롤러 전용 환경변수는 별도의 로컬 파일로 분리해 관리하세요.

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
- `/admin`: ADMIN_TOKEN 로그인 후 검수 대기 원문 승인/반려. ADMIN_TOKEN·INGEST_TOKEN은 각각 24자 이상·앞뒤 공백 없이 설정하고 COLLECTOR_STATUS_TOKEN을 포함한 세 토큰은 모두 달라야 함. 관리자·수집 토큰 설정이 유효하지 않으면 기존 쿠키가 있어도 인증 설정 안내만 표시하고 로그인·검수 작업을 차단함. 크롤러가 보낸 자동 추출 제안(모델·가격·일정·링크 후보와 근거)은 참고용으로만 함께 표시. httpOnly·SameSite strict 1시간 쿠키, Next.js Server Actions의 동일 origin 검증 사용. 로그아웃은 발급 시와 같은 Path=/admin·HttpOnly·SameSite=strict·Secure(프로덕션에서만) 속성으로 쿠키를 만료시킴. 공개 화면에는 대기 원문을 전달하지 않음

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
| POST | `/api/v1/admin/review/:id` | 관리자 승인/반려, 승인 시 모델·판매자·귀속 근거 필수 |
| GET | `/api/v1/admin/sellers` | ADMIN_TOKEN 전용, 등록 판매자·검수된 연결 계정·미연결 수집 계정 |
| POST | `/api/v1/admin/sellers` | 판매자 등록, 선택 계정 연결은 `account_reviewed: true` 필수 |
| POST | `/api/v1/admin/sellers/:id` | `action: update` 증빙 전체 교체, `link_account` 검수 연결, `unlink_account` 해당 판매자의 연결만 해제 |
| GET | `/api/v1/admin/deals?status=published&limit=20&cursor=…` | ADMIN_TOKEN 전용, 상태 published(기본)/withdrawn/all, checked·id 내림차순 키셋 페이지. limit 1–50, 응답 `{ data, next_cursor }`, 전체 건수 제한 없음 |
| GET | `/api/v1/admin/deals/:id` | ADMIN_TOKEN 전용, 현재 값·전체 버전 이력·보존된 수집 원문 및 귀속 검수 근거 |
| POST | `/api/v1/admin/deals/:id` | ADMIN_TOKEN 전용, action correct/withdraw, expected_version·request_id·reason 필수 |
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

승인 JSON은 `action: "approve"`, 등록된 `model_id`, `seller_id`, `title`, `price`(정수 원 또는 null), `starts_at`, `ends_at`(시간대 포함 ISO)을 받습니다. 이미지 포함 여부는 선택 boolean `include_image`로 지정하며 기본값은 true입니다. `/admin`의 인증된 미리보기 옆 “이미지 포함”을 해제하면 이미지 없이 게시합니다. 검수 API는 대체 `image_url`을 받지 않고 저장된 이미지만 승인 트랜잭션 안에서 복사합니다. 반려는 `{ "action": "reject" }`입니다. 승인 후 가격은 manual 검증 수준이며 원문 URL을 유지합니다. 이미 검수된 건은 409, 잘못된 입력은 400입니다. 게시와 검수 상태 변경은 D1 batch 트랜잭션으로 처리합니다. `/admin`의 모델·판매자 선택은 공란으로 시작하며 둘 다 직접 선택해야 합니다. 승인에는 `attribution`도 필수입니다. `account`는 정규화된 원문 계정과 선택한 판매자 사이에 검수된 연결이 있어야 합니다. `explicit`은 미연결·다른 판매자 연결·핸들이 아닌 계정에 사용할 수 있으며 `attribution_note`에 10–300자의 귀속 사유를 남겨야 합니다. 명시 귀속은 계정 연결을 만들거나 변경하지 않습니다. 반려에는 선택값·귀속 근거가 필요 없으며 브라우저 필수 입력 검증도 건너뜁니다.

`/admin`의 “판매자 등록·증빙”에서 대기열 유무와 무관하게 새 판매자를 등록할 수 있습니다. 등록·수정 입력은 `name`(100자 이하), `source_url`(HTTPS), 선택 증빙 `registration_source`, `withdrawal_source`, `official_import_source`입니다. 증빙을 비우면 NULL로 지워져 미확인으로 표시되며 원문 URL이나 계정으로 증빙을 추정하지 않습니다. URL은 자격 증명 없는 HTTPS만 허용합니다. 수정은 증빙 전체를 교체합니다.

등록 시 선택 `account`를 입력하거나 기존 판매자에 `link_account`할 때는 반드시 `account_reviewed: true`로 직접 확인해야 합니다. 계정은 앞뒤 공백·선행 @를 제거하고 소문자로 정규화하며 영문·숫자·점·밑줄 1–30자만 연결합니다. 한 계정은 한 판매자에만 연결할 수 있고 충돌은 409입니다. 계정 없는 등록은 기존 연결에 영향을 주지 않습니다. 핸들이 아닌 수집 계정은 따로 표시하며 명시 귀속만 가능합니다. 모든 판매자 관리 API는 ADMIN_TOKEN 전용이며 INGEST_TOKEN으로 관리할 수 없습니다. 수집 요청의 판매자 필드는 판매자를 생성하지 않습니다.

Linux 수집기의 `seller_candidates`는 사이트 판매자가 아니며 사이트가 가져오거나 자동 등록하지 않습니다. `external_candidates.seller_handle`도 판매자 등록·연결에 사용하지 않습니다. `seller_accounts` 및 승인 귀속 사유는 관리자 전용이며 공개 판매자·공구 응답에는 포함하지 않습니다.

게시된 공구는 `/admin`의 “게시된 공구 정정·철회”에서 관리합니다. 게시 중·철회됨·전체 탭과 “다음 20건”으로 오래된 공구까지 탐색하며, `/admin?deal=<id>`로 직접 찾을 수 있습니다. 원래 수집 본문·URL·이미지·판매자 귀속 사유와 검수 시각은 읽기 전용으로 보존합니다. 게시 시 v1 publish 이력을 만들고, 정정·철회마다 전체 상태와 사유를 다음 버전에 추가합니다. 사유·요청 ID·이력·수집 근거는 관리자 전용이며 공개 JSON에는 상태나 버전도 포함하지 않습니다.

정정(`action: "correct"`)은 등록된 `model_id`, 1–200자 `title`, 정수 원 또는 null `price`, 시간대 포함 `starts_at`·`ends_at`, boolean `include_image`를 모두 받습니다. 제목·사유는 앞뒤 공백을 제거하고 일정은 UTC로 정규화합니다. 이미지는 수집 원본에서 복원하거나 제거할 수만 있습니다. 원문 URL·검증 수준·판매자 귀속은 바꿀 수 없습니다. 판매자가 잘못되었으면 철회하세요. 정정 시 가격 확인일도 갱신합니다.

두 작업 모두 `expected_version`(1 이상 안전한 정수), `request_id`(영문·숫자·하이픈 16–64자, `review-` 접두사는 승인 이력용 예약), 10–300자 `reason`이 필요합니다. 폼은 렌더링할 때 각각 새 UUID를 생성합니다. 요청 ID는 정규화된 요청 내용의 SHA-256과 결합되므로 동일 요청을 재전송하면 200 `replayed: true`로 응답하고 버전·이력을 추가하지 않습니다. 같은 키의 다른 내용·동작·예상 버전은 409 `request_id_reused`입니다. 버전 경쟁은 409 `stale_version`과 `current_version`, 이미 철회된 공구의 새 작업은 409 `withdrawn`입니다. 버전 가드가 있는 D1 batch 하나에서 이력 추가와 현재 값 변경을 원자적으로 처리합니다.

`/admin`의 철회(`action: "withdraw"`) 폼은 공개 화면에서 내림 확인과 사유를 요구합니다. 철회는 최종 상태로 복원할 수 없으며, 모든 공개 목록·모델 비교·현재 공구가 카드·달력에서 사라지고 직접 상세 접근도 404가 됩니다. 동일 URL 재수집은 기존 approved 상태만 반환하고 원문이나 게시 내용을 바꾸지 않습니다. 재승인은 409이며 수집/현황 토큰으로 정정·철회 API를 호출할 수 없습니다. 이 기능은 사이트에만 속하며 Linux 수집기의 저장소나 게시 권한을 연결하지 않습니다.

`0011_deal_lifecycle.sql`은 추가 전용 마이그레이션으로 기존 공구도 v1 publish 이력을 보존합니다. **로컬 D1에만 `npm run db:migrate`로 적용하며 운영 D1 적용은 운영자가 별도로 수행합니다.**

`0010_seller_onboarding.sql`은 추가 전용 마이그레이션입니다. **로컬(`npm run db:migrate`)에만 적용하며 운영 D1 적용은 운영자가 별도로 수행합니다.**

승인·수집의 타임스탬프는 시간대 오프셋을 허용하며 UTC `YYYY-MM-DDTHH:MM:SS.SSSZ`로 정규화해 저장합니다. 존재하지 않는 날짜(예: 2월 30일)와 종료 ≤ 시작인 일정은 400으로 거부합니다. 제안 일정은 같은 엄격한 검증을 거치되 원문 값을 보존하며, 공개 화면의 일정·확인일은 KST로 표시합니다.

`0009_normalize_deal_timestamps.sql`은 기존 공구의 유효한 시작·종료를 함께 UTC로 바꾸는 전진 마이그레이션입니다. 잘못된 날짜나 역전된 일정은 원문 그대로 남겨 화면에 일정 미확인으로 표시합니다(이 행의 SQL 정렬은 기존 문자열 기준). **로컬(`npm run db:migrate`)에만 적용하고 운영 D1 적용은 운영자가 따로 합니다.**

승인된 이미지는 공구 카드·상세 화면에서 브라우저가 직접 불러옵니다(`referrerPolicy="no-referrer"`, 지연 로딩, 서버 프록시·최적화 요청 없음). 이미지가 없거나 로딩에 실패해도 텍스트·가격·광고 및 거래 안내는 유지됩니다. **Instagram CDN URL은 만료될 수 있으므로 영구 보관을 보장하지 않습니다.** 현재 ingest는 R2 업로드를 지원하지 않습니다. R2 영구 저장은 업로드와 검수 후 공개 계약을 별도로 설계해야 합니다.

### 외부 공구 모음 후보 (`kind: "external_listing"`)

아래는 과거 external_candidates와의 호환 API이며 신규 수집기는 사용하지 않습니다. 기존 후보 조회·dismiss는 유지합니다. 공구팡팡·맘캘린더·BUYG·스냅업 같은 외부 공구 모음 사이트의 가격은 지난 가격이거나 AI 요약일 수 있어 **후보로만** 저장합니다. 같은 `POST /api/v1/ingest`에 `kind: "external_listing"`을 보내면 `ingested_items`가 아니라 별도 테이블 `external_candidates`(마이그레이션 `0006`)에만 저장됩니다. 승인 API(`admin/review`)는 이 테이블을 읽지 않으므로 외부 후보는 공구가로 게시될 수 없고, 공개 GET API·화면은 이 테이블을 읽지 않습니다. 인스타 원문으로 확인된 항목만 기존 경로로 공구가가 됩니다. `/admin`에는 참고용 목록과 “확인 완료”(dismiss) 버튼만 있습니다.

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

최초 데이터는 **`seed/models.json`, `seed/tripp_trapp.json`만** 사용합니다. 41개 모델은 2026-10-23 공식 페이지 본문 확인을 시도하여, 읽은 정상가와 확인 불가 상태를 구분했습니다. 확인 로그는 [모델 근거 기록](docs/model-evidence-2026-10-23.md)에 있습니다. 가격이 null이거나 수집되지 않았으면 **정보 없음**입니다. 시드에 공구가·일정이 없으므로 공구와 달력은 빈 화면이 정상입니다.

- 가격은 국내 공식가와 검수된 공구가만 보관·표시합니다. 해외가·환율·중고가·직구가·일반 판매처 할인가는 시드와 모델 메모에 보관하지 않습니다.
- `kr_retailers`는 판매자 이름과 출처 URL만 보관하며 가격은 포함하지 않습니다.
- `page_body`는 공식 제품 본문에서 정상가를 확인한 상태이고, `official_unpublished`는 동일 구성 미확인·접속 실패·수입사 미확인 등을 포함한 공식가 정보 없음 상태입니다. 제조사의 가격 비공개를 단정하지 않으며 `evidence.reason`으로 사유를 구분합니다. 기존 D1 행의 `page_text`·`search_summary` 표시 호환은 유지합니다. 공식가 미확인 모델은 다른 판매가나 부품 합산으로 대체하지 않습니다.
- 모든 공구는 광고이며 구매·결제는 판매처 링크아웃만 제공합니다. 아가마중은 거래 당사자가 아닙니다.

`seed/official-sources.json`의 브랜드별 공식 호스트·제품 경로 규칙과 차단 경로로 가격 출처를 제한합니다. 백화점·기사·리뷰·홈 페이지는 공식가 근거가 아닙니다. 모델별 `evidence`·`bundle`은 구성품·세대·호환·보증·설명서·인증 조사 기록이며, 미확인 항목은 추정하지 않습니다. 현재 D1/API/UI에는 조사 묶음을 추가하지 않습니다. 기존 모델 컬럼만 UPDATE 전용 `0008_official_evidence.sql`로 갱신합니다. **`lib/`·`app/`에서 시드를 import하지 마세요.** 큰 조사 기록과 로컬 네트워크 도구는 Workers 번들 밖에 둡니다.

CPSC 공개 REST(키 불필요)는 로컬 Node `scripts/recall-check.ts`에서 기본 질의와 모든 대체 표기(예: BabyBjörn·Maxi Cosi·Dorel)를 각각 제목·제품명으로 질의 후 RecallID 중복 제거와 전체 단어 브랜드 필터를 적용합니다. 질의별 원시 행 수·채택 수·필터 제외 ID/제목·조회 실패를 `seed/recalls.json`에 기록합니다. **리콜 결과 없음 ≠ 안전 보장**이며 해외 리콜의 국내 모델·로트 적용은 별도 판단합니다. SafetyKorea는 API 키 발급 전 `not_connected`입니다. 공유 순수 파서와 기존 크롤러 파서는 패리티 테스트로 검증하며 크롤러의 공유 파서 전환은 후속 과제입니다.

## 크롤러

별도 Linux Node+Playwright worker의 설치·보안·제약은 [crawler/README.md](crawler/README.md)를 참고하세요. Workers Cron에서 Instagram에 접속하지 않습니다. v2 크롤러는 검수 가능한 설정 파일(`crawler/config/`)로 시드 계정·속도 한도를 관리하고, 알림·스토리 트레이 신호로 수집 우선순위를 정하며, 캡션·스토리 OCR에서 모델·가격·공구 일정·링크를 자동 추출해 **제안**으로만 검수 대기열에 함께 전송합니다. 사람 승인 전까지 게시되지 않습니다. 자동 팔로우는 일일 상한·무작위 간격을 지키고 차단·챌린지 감지 시 즉시 중단합니다. 공개 외부 수집은 독립 Linux local-worker로 이관했습니다. Instagram 실행부는 외부 수집을 호출하지 않으며 신규 수집함을 사이트 ingest로 보내지 않습니다. 자세한 내용과 운영 전 dry-run 절차는 [crawler/README.md](crawler/README.md)의 “외부 공구 모음 사이트” 절을 참고하세요. 공유 계정을 쓰는 다른 두 봇을 위해 매일 **06:45~08:00, 13:00~14:00 Asia/Seoul**에는 브라우저·로그인·팔로우·스캔을 쉬고, 실행 중에도 다음 휴식 시작에 브라우저를 닫고 각 Instagram 행동 전에 확인합니다. `quiet_windows` 배열 설정이나 `AGAMAJUNG_QUIET_WINDOWS='06:45-08:00,13:00-14:00'` 환경변수로 여러 시간을 지정하며 자정 통과도 지원합니다. 겹치거나 맞닿은 시간은 합친 종료 후 지터를 한 번 더해 재개하고 건강 로그에 진입·종료를 남깁니다. 이전 `quiet_window` 설정과 `AGAMAJUNG_QUIET_WINDOW` 환경변수도 읽으며 각각 복수형이 우선합니다.

## 개발 작업 데몬

박스의 작업 큐·모델 폴백·독립 worktree·검수 후 PR squash merge 자동화는 [tools/dev-daemon/README.md](tools/dev-daemon/README.md)를 참고하세요. 사이트·크롤러와 별도 PM2 앱 `agamajung-dev-daemon`으로 실행합니다.

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
npx tsx scripts/recall-check.ts --out seed/recalls.json  # 로컬 공식 리콜 조회, 외부 네트워크 필요
npx tsx scripts/card-screenshots.ts --out <dir>   # /models 카드 모바일·데스크톱 × 라이트·다크 스크린샷 (서버·네트워크 불필요)
ADMIN_TOKEN=… INGEST_TOKEN=… npx tsx scripts/admin-logout-check.ts  # 수동 로컬 전용(기본 localhost:8787, --base로 변경): .dev.vars에 같은 토큰 설정, npm run db:migrate → npm run db:seed → npm run dev 및 Playwright Chromium 설치 필요
```

`tests`는 Vitest와 메모리 SQLite로 가격 매핑·인증·검수 격리·중복 및 크롤러 추출·한도·지터·발견·셀렉터·OCR 실패 복구를 확인합니다. 테스트에서 소켓·실제 fetch·브라우저 실행을 차단하며 네트워크 접속 없이 검증합니다. Worker 빌드 후 `wrangler dev --local --test-scheduled`와 로컬 `/__scheduled` 요청으로 Cron stub을 수동 확인할 수 있습니다. 배포 스크립트는 의도적으로 제공하지 않습니다.

리콜 도구는 `--fixture <json> --sources <json> --out <json>`으로 네트워크 없이 실행할 수 있습니다. fixture는 브랜드별 `queries: { "검색어": { "title": [...], "product": [...] } }`로 대체 질의 결과를 구분할 수 있습니다. 기본 fixture 형식은 브랜드별 `{ "title": [CPSC 원시 행], "product": [CPSC 원시 행] }`이며 `{ "error": "blocked" }`로 실패를 재현합니다. 고정 User-Agent·요청 간 5초·응답 2MB 상한·리디렉트 금지·요청 제한 시간을 적용합니다. 일부 브랜드 실패는 해당 브랜드에만 기록하고, 전체 실패 시 출력 파일을 덮어쓰지 않습니다. 재조회 파일과 모델별 검토 결과는 별도이므로, 갱신 후 `bundle.safety.recalls.cpsc`도 다시 검토해야 합니다. 교차 검증 테스트가 오래된 모델별 검토 기록을 감지합니다. 실시간 네트워크 조회는 단위 테스트에 포함하지 않습니다.

### 상품 손그림 에셋

`lib/model-illustrations.ts`가 모델별 이미지 규격을 반환합니다. model-1–41 중 등록된 39개(model-32·39 제외)는 모두 편집 가능한 `1080×1080` SVG와 투명 `540×540`·`252×252` PNG를 사용합니다. 신규 선화에는 제품 경로만 넣고 글자·로고·종이 배경·액자·그림자를 넣지 않습니다. 상품명은 HTML `alt`와 비표시 SVG `<title>`로 제공합니다.

```sh
npx tsx scripts/render-model-illustrations.ts            # 등록된 39개 전부 두 크기로 재생성
npx tsx scripts/render-model-illustrations.ts model-13   # 특정 모델만
npx tsx scripts/card-screenshots.ts --out .local/card-qa
```

렌더링·스크린샷은 기존 Playwright를 쓰며 서버나 네트워크가 필요 없습니다. 스크린샷은 등록된 39개 모델과 미등록 자리표시 1개를 모바일 390px·데스크톱 1280px × 라이트·다크에서 확인하며 이미지 디코딩 완료 후 전체 화면 4장과 기본 model-31–41 중 등록된 9개 카드 36장(`--cards model-31,model-33`으로 선택 가능)을 저장합니다. 모든 공구가 행의 높이(40px 이하), 정사각 이미지 디코딩, 같은 행 카드 높이, 자리표시와 가로 넘침을 검사합니다. 공식 참조·구성품·세부 경로·시각 검수 기록은 [배치 1 제작 기록](docs/model-illustrations-batch-1.md), [배치 2 제작 기록](docs/model-illustrations-batch-2.md), [배치 3 제작 기록](docs/model-illustrations-batch-3.md), [배치 4 제작 기록](docs/model-illustrations-batch-4.md)을 참고하세요. model-32·39는 기준 내 공식 썸네일을 확보하지 못해 자리표시를 유지합니다. 참조 사진은 임시 확인 후 삭제하며 저장소에 보관하지 않습니다. 서버 축소 요청의 제한은 배치 1 제작 기록에 남겼습니다.

## Linux 로컬 수집함과 사이트 현황

신규 3경로(auto_discovery / browser_extract / manual_clip)는 [독립 작업기](crawler/README.md#독립-로컬-수집함)가 소유합니다. Chrome 수동 담기는 [확장 안내](tools/chrome-clipper/README.md)를 따릅니다. 로컬 SQLite와 마이그레이션은 `crawler/` 아래에 있고 Workers 번들에 포함하지 않습니다. AI는 필수 의존성이 아니며 공개 API나 게시 테이블과 연결하지 않습니다.

사이트에는 **건수 스냅샷만** 저장합니다. `migrations/0007_collector_status.sql` 적용과 COLLECTOR_STATUS_TOKEN 바인딩은 운영자가 별도로 수행합니다. URL·원문·셀러·근거는 사이트로 보내지 않습니다.

| API | 권한 | 동작 |
| --- | --- | --- |
| POST `/api/v1/collector/status` | 별도의 COLLECTOR_STATUS_TOKEN | 작업기별 단조 버전 스냅샷 접수 |
| GET `/api/v1/admin/collection-status` | ADMIN_TOKEN | 다섯 상태·생성/수신 시각·지연 여부 |

`/admin`은 후보(discovered)·원문 확인(source_check_needed)·중복 제외(dedup_excluded)·검증 완료(verified_waiting)·공개 대기(ready_to_publish)를 표시합니다. 미수신은 **미동기화**, 생성 후 1시간이 지난 현황은 **동기화 지연**으로 표시합니다. 미수신을 0건으로 보이지 않습니다. 여러 작업기는 각각 표시하며 고유 자료량으로 합산하지 않습니다. 같은 버전의 다른 payload는 409, 이전 버전은 최신 현황을 바꾸지 않습니다.

`ready_to_publish`는 현재 묶음의 근거 버전으로 사실 검토·공개 검토를 마친 상태입니다. 실제 게시를 실행하지 않습니다. 기존 Instagram ingest → 관리자 승인 → deals 경로와 과거 external_candidates는 별개로 유지합니다.

추가 명령: `npm run collector:worker -- serve`, `npm run collector:worker -- discover --dry-run`, `npm run collector -- report --json`, `npm run build:clipper`. 검증 명령은 기존 lint·typecheck·test·build·build:worker와 build:clipper입니다. 테스트는 외부 네트워크/브라우저를 차단하며 실제 SQLite 파일 복구·트랜잭션 실패·자식 프로세스 종료·확장 재시작을 검증합니다.

이번 근거 정리에서는 공식가 확인 12개, 미확보 29개(접속 실패 16개)로 공개 공식가가 줄어듭니다. 트립트랩 오크 정상가는 기존 470,000원에서 공식 본문 510,000원으로 바뀝니다. 접속 실패 URL은 시도 기록으로만 남기고 출처 링크를 비웁니다. 기존 수입사 정보는 접속 오류만으로 삭제하지 않고 재확인 실패를 표시합니다. 세대·국내 정식 구성도 본문에서 확정하지 못하면 명시적 미확인 객체로 기록합니다.
