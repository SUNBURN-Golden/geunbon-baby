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
- `/admin`: ADMIN_TOKEN 로그인 후 검수 대기 원문 승인/반려. httpOnly·SameSite strict 1시간 쿠키, Next.js Server Actions의 동일 origin 검증 사용. 공개 화면에는 대기 원문을 전달하지 않음

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
  "captured_at": "2026-10-21T09:00:00+09:00"
}
```

위 예시는 프로토콜 설명용이며 시드/게시 데이터가 아닙니다. `kind`는 post/story, Instagram HTTPS 원문 URL만 허용합니다. URL 중복은 기존 id/status를 반환합니다(202). 수집 즉시 pending, 공개 API/화면에는 미노출입니다.

승인 JSON은 `action: "approve"`, 등록된 `model_id`, `seller_id`, `title`, `price`(정수 원 또는 null), `starts_at`, `ends_at`(시간대 포함 ISO)을 받습니다. 반려는 `{ "action": "reject" }`입니다. 승인 후 가격은 manual 검증 수준이며 원문 URL을 유지합니다. 이미 검수된 건은 409, 잘못된 입력은 400입니다. 게시와 검수 상태 변경은 D1 batch 트랜잭션으로 처리합니다. 판매자 신규 등록·배지 증빙은 현재 관리자 UI 범위에 없으며 운영자가 검증한 근거를 D1 마이그레이션으로 추가해야 합니다.

## 가격 원칙

최초 데이터는 **`seed/models.json`, `seed/tripp_trapp.json`만** 사용합니다. 시드 자체를 실시간 재검증했다는 의미는 아닙니다. 가격이 null이거나 수집되지 않았으면 **정보 없음**입니다. 시드에 공구가·일정이 없으므로 공구와 달력은 빈 화면이 정상입니다.

- 모델 1~5의 트립트랩 구성과 동일한 해외 구성만 연결합니다. 구성 미확인 직구·과거 할인·기사의 범위 가격을 현재 단일 가격으로 변환하지 않습니다.
- 해외 환산가는 시드의 원화 금액을 그대로 사용하고 환율 근거·판매세·배송/관부가세 주의를 표시합니다. 해외/중고의 검증 수준이 시드에 없으면 `seed_unspecified`로 표시합니다.
- 당근은 서초4동 검색의 구성·소재 혼합 **호가** 통계입니다. 해당 모델의 실거래가나 보장 시세가 아닙니다.
- `page_text`와 `search_summary`의 근거 차이 및 가격 불일치 메모를 보존합니다.
- 모든 공구는 광고이며 구매·결제는 판매처 링크아웃만 제공합니다. 아가마중은 거래 당사자가 아닙니다.

## 크롤러

별도 Linux Node+Playwright worker의 설치·보안·제약은 [crawler/README.md](crawler/README.md)를 참고하세요. Workers Cron에서 Instagram에 접속하지 않습니다. 크롤러는 자동 가격 파싱/게시 없이 검수 원문만 전달합니다.

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
```

`tests`는 가격 매핑·미확인 가격·인증·API 공개 격리·승인/반려·중복을 로컬 Miniflare D1으로 확인합니다. Instagram 접속 없이 검증합니다. Worker 빌드 후 `wrangler dev --local --test-scheduled`와 로컬 `/__scheduled` 요청으로 Cron stub을 수동 확인할 수 있습니다. 배포 스크립트는 의도적으로 제공하지 않습니다.
