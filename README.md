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
- `/models`: 종류·브랜드·모델명 검색
- `/models/:id`: 공구가 / 공식가 / 해외가 / 당근 중고 시세, 출처·확인일·검증 수준
- `/deals`, `/calendar`: 검수 완료 공구 및 일정 (전부 **광고** 표시)
- `/sellers`: 통신판매업 신고·청약철회 7일·정식수입 증빙. 시드에 증빙이 없으므로 미확인으로 표시
- `/admin`: ADMIN_TOKEN 로그인 후 검수 대기 원문 승인/반려. 크롤러가 보낸 자동 추출 제안(모델·가격·일정·링크 후보와 근거)은 참고용으로만 함께 표시. httpOnly·SameSite strict 1시간 쿠키, Next.js Server Actions의 동일 origin 검증 사용. 공개 화면에는 대기 원문을 전달하지 않음

로컬 HTTP의 localhost는 브라우저 secure cookie 예외가 적용됩니다. 관리자 접속은 localhost를 사용하세요. 공유/운영 환경은 HTTPS가 필수입니다. 토큰을 URL에 넣지 마세요. 운영 공개 전 관리자 경로와 ingest에 Cloudflare Access/WAF 등의 접근통제·레이트리밋을 별도로 설정하는 것을 권장합니다.

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

## 가격 원칙

최초 데이터는 **`seed/models.json`, `seed/tripp_trapp.json`만** 사용합니다. 시드 자체를 실시간 재검증했다는 의미는 아닙니다. 가격이 null이거나 수집되지 않았으면 **정보 없음**입니다. 시드에 공구가·일정이 없으므로 공구와 달력은 빈 화면이 정상입니다.

- 가격은 국내 공식가와 검수된 공구가만 보관·표시합니다. 해외가·환율·중고가·직구가·일반 판매처 할인가는 시드와 모델 메모에 보관하지 않습니다.
- `kr_retailers`는 판매자 이름과 출처 URL만 보관하며 가격은 포함하지 않습니다.
- `page_text`와 `search_summary`의 근거 차이를 보존합니다. 공식가 미확인 모델은 다른 판매가로 대체하지 않습니다.
- 모든 공구는 광고이며 구매·결제는 판매처 링크아웃만 제공합니다. 아가마중은 거래 당사자가 아닙니다.

## 크롤러

별도 Linux Node+Playwright worker의 설치·보안·제약은 [crawler/README.md](crawler/README.md)를 참고하세요. Workers Cron에서 Instagram에 접속하지 않습니다. v2 크롤러는 검수 가능한 설정 파일(`crawler/config/`)로 시드 계정·속도 한도를 관리하고, 알림·스토리 트레이 신호로 수집 우선순위를 정하며, 캡션·스토리 OCR에서 모델·가격·공구 일정·링크를 자동 추출해 **제안**으로만 검수 대기열에 함께 전송합니다. 사람 승인 전까지 게시되지 않습니다. 자동 팔로우는 일일 상한·무작위 간격을 지키고 차단·챌린지 감지 시 즉시 중단합니다. 공유 계정을 쓰는 다른 두 봇을 위해 매일 **06:45~08:00, 13:00~14:00 Asia/Seoul**에는 브라우저·로그인·팔로우·스캔을 쉬고, 실행 중에도 다음 휴식 시작에 브라우저를 닫고 각 Instagram 행동 전에 확인합니다. `quiet_windows` 배열 설정이나 `AGAMAJUNG_QUIET_WINDOWS='06:45-08:00,13:00-14:00'` 환경변수로 여러 시간을 지정하며 자정 통과도 지원합니다. 겹치거나 맞닿은 시간은 합친 종료 후 지터를 한 번 더해 재개하고 건강 로그에 진입·종료를 남깁니다. 이전 `quiet_window` 설정과 `AGAMAJUNG_QUIET_WINDOW` 환경변수도 읽으며 각각 복수형이 우선합니다.

## 개발 작업 데몬

박스의 작업 큐·모델 폴백·독립 worktree·검수 후 PR squash merge 자동화는 [tools/dev-daemon/README.md](tools/dev-daemon/README.md)를 참고하세요. 사이트·크롤러와 별도 PM2 앱 `agamajung-dev-daemon`으로 실행합니다.

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
```

`tests`는 Vitest와 메모리 SQLite로 가격 매핑·인증·검수 격리·중복 및 크롤러 추출·한도·지터·발견·셀렉터·OCR 실패 복구를 확인합니다. 테스트에서 소켓·실제 fetch·브라우저 실행을 차단하며 네트워크 접속 없이 검증합니다. Worker 빌드 후 `wrangler dev --local --test-scheduled`와 로컬 `/__scheduled` 요청으로 Cron stub을 수동 확인할 수 있습니다. 배포 스크립트는 의도적으로 제공하지 않습니다.
