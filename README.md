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

별도 Linux DeepSeek 공개 웹 앱 `agamajung-deepseek-web`은 [전용 supervision·heartbeat·backoff 안내](crawler/deepseek-web/README.md#supervision-heartbeat-and-recovery-linux-only)를 따릅니다. 기본 heartbeat는 `<repository>/.local/deepseek-web/heartbeat.json`이며 `npm run deepseek-web -- status`로 읽기 전용 확인합니다. 로컬 scheduler/watchdog·Instagram service·사이트 Workers와 별개입니다. 이번 복구 범위의 프로세스 신원은 저장소 근거에 따른 가정이며 과거 장애 원인을 확정하지 않습니다.

**Workers Cron은 수집기를 실행하지 않는 로그 stub입니다. Playwright와 OCR은 Linux에서만 실행합니다.** 기존 건수 동기화는 로컬 수집 레코드를 보내지 않습니다. 공구 데몬은 별도의 인증된 ingest 경로로 상품별 검증 근거를 보냅니다. 로컬 `seller_candidates`를 사이트 판매자로 자동 등록하지도 않습니다. 수집함의 `ready_to_publish`는 사람의 공개 검토를 마친 로컬 상태이며 실제 게시 동작이 아닙니다. Instagram pending → 사이트 관리자 승인 → deals 경로와 별개입니다.

이 운영 호스트의 Linux 수집 예약은 [PM2 cron](docs/collector/scheduling.md)으로 실행합니다. 상주 슬롯 스케줄러와 systemd watchdog은 별도 운영 모델입니다. PM2 online이나 최근 로그 하나는 수집 성공의 증거가 아닙니다.

3경로는 자동 RSS/API/사이트맵/링크 발견(`auto_discovery`), 승인된 공개 브라우저 추출(`browser_extract`), Chrome 수동 담기(`manual_clip`)입니다. 저장 전·AI 전달 전 공통 개인정보 필터(`shared/privacy-rules.ts`)를 적용하고 자료를 `untrusted_source_data`로 격리합니다. AI는 필수가 아니며 자료 속 지시로 도구 실행·상태 승격·게시를 하지 않습니다.

설치·운영은 [Linux 수집 시스템](crawler/README.md), [독립 로컬 수집함](crawler/README.md#독립-로컬-수집함), [건수 동기화](crawler/README.md#건수-동기화), [외부 공구 모음 이관](crawler/README.md#외부-공구-모음-이관), [Chrome 확장 안내](tools/chrome-clipper/README.md)를 참고하세요. 개발 작업 데몬 [tools/dev-daemon](tools/dev-daemon/README.md)과 PM2 앱 `agamajung-dev-daemon`은 위 수집·사이트 운영과 무관한 별도 도구입니다.

### 사이트에 표시하는 수집 현황

`/admin`은 사이트 D1에 저장된 건수 스냅샷만 읽어 후보(`discovered`)·원문 확인(`source_check_needed`)·중복 제외(`dedup_excluded`)·검증 완료(`verified_waiting`)·공개 대기(`ready_to_publish`)를 표시합니다.

| 조건 | 표시 |
| --- | --- |
| 조회 성공, 수신된 스냅샷 없음 | **미동기화**, 건수 없음 |
| 유효한 스냅샷, 생성 후 60분 이하 | **동기화됨**, 저장된 건수·생성/수신 시각 |
| 유효한 스냅샷, 생성 후 60분 초과 | **동기화 지연**, 저장된 건수·생성/수신 시각 |
| D1 조회 실패 또는 저장된 JSON·스냅샷 구조·집계·시각 오류 | **수집 현황을 불러오지 못했습니다**, 건수·시각·동기화 성공 표시 없음 |

미수신과 읽기 실패는 0건으로 간주하지 않습니다. 유효한 스냅샷에 실제로 저장된 0건은 표시합니다. 여러 작업기는 각각 표시하고 고유 자료량으로 합산하지 않습니다. 하나라도 잘못된 행이 있으면 수집 현황 전체를 읽기 실패로 표시하며 일부 작업기만 정상인 것처럼 표시하지 않습니다. 같은 버전의 다른 payload는 409이고 이전 버전은 최신 현황을 바꾸지 않습니다.

읽기 실패는 Linux 수집기의 건강 상태를 판단하는 근거가 아닙니다. 새로고침 후에도 계속되면 사이트 D1 가용성, `DB` 바인딩, `0007_collector_status.sql` 적용 여부와 저장된 스냅샷의 무결성을 확인하세요. 화면에는 DB 오류·원시 payload·자격 증명을 표시하지 않습니다. 다른 관리자 구역은 각자의 조회가 성공하면 검수·판매자·공구·후보 폼을 계속 사용할 수 있습니다. 전체 D1 장애에서는 이 기능들의 사용을 보장하지 않습니다.

**동기화 지연**이면 별도 Linux 시스템의 [건수 동기화](crawler/README.md#건수-동기화) 실행 간격과 outbox·재전송 상태를 확인하세요. 사이트에서 수집기를 실행하거나 Linux SQLite에 접근하지 않습니다.

## 가격 원칙

최초 데이터는 **`seed/models.json`, `seed/tripp_trapp.json`만** 사용합니다. 공식 본문 확인 근거와 확인 불가 사유는 [모델 근거 기록](docs/model-evidence-2026-10-23.md)에 있습니다. 가격이 null이거나 수집되지 않았으면 **정보 없음**입니다. 시드에 공구가·일정이 없으므로 공구와 달력은 빈 화면이 정상입니다.

- 비교·표시하는 가격은 **공식가**와 **공구가** 두 종류뿐입니다. 공식가는 제조사·공식 수입사의 동일 구성 공식 페이지 본문에서 확인한 `verify_level: "page_body"` 가격만 사용하며, 공구가는 현재 원문 근거가 확인된 공구 가격입니다.
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

`npm run db:migrate`와 `npm run db:seed`는 모두 D1 `--local`만 사용합니다. `npm run dev`는 `build:worker`로 OpenNext 빌드 후 `wrangler dev --local`로 로컬 workerd/Miniflare만 실행합니다. 기본 접속 주소는 `http://localhost:8787`입니다. Next.js 자체 개발 서버는 사용하지 않습니다. 이 로컬 절차는 원격 리소스를 만들거나 배포하지 않습니다. 소스 수정 후 빌드를 다시 실행하세요. 시드는 `.local/seed.sql`로 생성되며 재실행해도 기존 검수·수집 데이터는 지우지 않습니다. 데이터 구조 변경은 `/migrations`에 추가합니다.

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

운영 자동 배포는 아래 절차로 기존 Worker와 D1을 사용합니다. 사이트의 비밀 바인딩은 Cloudflare에서 관리합니다.

R2 읽기는 `/api/v1/images/:key`에서 `public/` 아래 허용 이미지 파일만 제공합니다. 시드에 사진이 없어 제품 사진을 만들거나 임의 외부 이미지를 가져오지 않습니다. Instagram ingest는 R2 업로드를 지원하지 않습니다.

## 운영 자동 배포

운영 Linux 호스트에서 Node 22와 KST로 실행되는 기존 PM2를 사용합니다. 설치 스크립트는 체크아웃의 revision이 로컬 `origin/main`에 포함되는지 확인하고 해당 커밋의 추적 파일과 잠긴 의존성을 `/workspace/agamajung/auto-deploy/controllers/<sha>`에 설치합니다. 같은 revision으로 다시 실행하면 정상 서비스의 PID를 유지하고 PM2 등록을 저장합니다. 컨트롤러 자체를 갱신할 때는 검증된 새 revision에서 설치를 다시 실행합니다. `--dry-run`은 설치 계획만 출력합니다.

```sh
tools/auto-deploy/install.sh --dry-run
tools/auto-deploy/install.sh
```

`agamajung-auto-deploy`는 flock으로 한 인스턴스만 실행하며 5분마다 `origin/main`을 가져옵니다. 폴링 사이의 여러 병합은 최신 SHA에 함께 반영됩니다. 개발 데몬이 병합을 담당하고 Git 폴링이 배포를 시작합니다. 후보는 별도 detached worktree에서 `npm ci --include=dev`, 타입 검사, 테스트, OpenNext 빌드, Wrangler dry-run 번들 검사를 통과해야 합니다. 타입 검사·테스트·빌드·번들 실패 SHA는 main이 이동할 때까지 보류하고 일시적 장애는 backoff 후 재시도합니다.

첫 운영 전환 전 기존 PM2 상주 스케줄러와 systemd watchdog을 사용 중이라면 운영자가 수집 스케줄의 소유권을 한 번 정리해야 합니다. 컨트롤러는 D1 적용 전에 실행 중인 PM2 등록, 저장본, 관련 watchdog 상태를 검사합니다. 경쟁 서비스가 있는 동안에는 보류 사유를 기록하며, 정리 후 다음 재시도에서 자동으로 진행합니다. [첫 전환 절차](docs/collector/scheduling.md#운영-호스트의-pm2-cron)

- **사이트**는 새 빌드가 검증되면 원격 `agamajung` D1 마이그레이션을 적용하고 Wrangler 버전 업로드 결과에 기록된 ID만 100% 승격합니다. 적용 전 대기 SQL 파일과 `DROP`/`ALTER` 표시를 기록합니다. 마이그레이션은 현재 Worker와 새 Worker가 모두 사용할 수 있어야 합니다. Worker 롤백이나 이후 마이그레이션·업로드 실패에도 이미 적용된 D1 변경은 남습니다. [Cloudflare Worker 롤백](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- **사이트 상태 확인**은 JSON을 요청한 홈페이지 `{"ok":true}`와 `/api/v1/deals?limit=5`의 JSON 응답, 후보 버전 100%를 확인합니다. 일반 브라우저 요청에는 HTML을 제공하며, `Accept: application/json` 요청은 실제 홈페이지의 HTTP 200 HTML 응답이 끝까지 정상 렌더링된 뒤에만 성공합니다. 실패 시 이전 버전을 명시해 롤백하고, 이전 버전 100%와 HTML 홈페이지·공구 JSON을 다시 확인합니다. 예상 밖의 버전이나 확인되지 않은 롤백은 복구가 끝날 때까지 새 승격을 보류합니다.
- **Linux 수집기**는 사이트 확인 후 일회성 작업이 끝나면 `/workspace/agamajung/runtime/current`를 원자적으로 전환하고 `crawler/ecosystem.all.config.cjs`의 관리 앱을 다시 등록합니다. 로컬 인증 readiness, 새 PID의 DeepSeek heartbeat, cron 등록, PM2 저장을 검증합니다. 장애 시 이전 링크와 등록을 복구하고 정상 Worker를 유지합니다. 부분 배포는 수집기 단계만 재시도하며 복구 완료 후 더 최신 main이 대체할 수 있습니다. 현재와 직전 세 개의 성공한 수집기 런타임을 보존합니다. [Linux 수집기 운영](crawler/README.md#운영-pm2-런타임)
- 사이트 인증은 인증된 Wrangler 명령에만 `/home/box/.secrets/agamajung_cf_token`을 읽어서 전달합니다. Linux 수집기는 시작할 때 각 자식 프로세스에서 `/home/box/.secrets/agamajung_crawler.env`를 읽습니다. 소유자 전용 `0600` 파일의 `KEY=value` 설정이 상속값보다 우선합니다. PM2 등록과 저장본에는 이 값이 들어가지 않습니다.

`/workspace/agamajung/auto-deploy/state.json`에 단계별 상태와 복구 정보를, `deploys.jsonl`에 시도별 결과를 저장합니다. 결과의 `status`가 `partial`이면 사이트는 정상이며 Linux 수집기가 복구 또는 재시도 중입니다. `COPY_REVIEW.md`에는 정상 확인된 사이트 SHA 사이의 `lib/copy/**`, `lib/site-copy.ts`, `lib/deals-copy.ts`, `lib/auth-copy.ts` 변경 문구를 추가합니다. 첫 기록은 이전 SHA 없는 스냅샷이며 문구 검토는 배포와 독립적으로 진행합니다.

후보의 crawler 인벤토리는 앱 이름으로 비교합니다. 여섯 앱의 선언이 같으면 순서를 바꿔도 통과합니다. 누락·중복 또는 승인된 실행 경로, 인수, preload, 일정, 실행 설정의 변경은 D1 적용 전에 `crawler_ecosystem_mismatch`로 보류합니다. 컨트롤러는 설치된 revision의 인벤토리에서 PM2 등록을 생성합니다. 의도적으로 운영 인벤토리를 변경할 때는 변경을 승인한 revision에 맞춰 컨트롤러도 갱신합니다.

현장 전환 시 운영 Worker 버전과 두 공개 응답, 로컬 인증 readiness와 DeepSeek heartbeat, 다음 도래 cron의 결과를 확인합니다. PM2 저장과 부활 테스트는 별도 PM2 홈과 fixture 설정으로 재현할 수 있습니다.

## 화면

다음은 `app/**/page.tsx`의 전체 경로입니다. `:id`는 소스의 `[id]` 동적 세그먼트를 뜻합니다.

| 경로 | 현재 기능·진입점 |
| --- | --- |
| `/` | 진행 중인 공구 수·최대 할인, 카테고리·브랜드 필터, 오늘 마감·역대 최저가·할인율 TOP·새로 열린 공구. 첫 카드에서 게시 원문으로 이동. 소식지는 `/#letter` |
| `/models` | 종류·브랜드·모델명 검색(`category`, `brand`, `q`). 공식가 메뉴. 브랜드 메뉴는 `/models?by=brand`. 진행 중 공구가 있는 모델 우선 |
| `/models/:id` | 해당 모델의 게시 공구를 공통 공구 카드로 표시, 공구가와 공식가 두 가격만 표시·비교. 공식가는 출처·확인일·검증 수준(`page_body`만 금액 표시)·수입사와 함께 표시. 현재가 옆에서 이메일 알림 신청. 모델 카드로 진입, 없는 모델은 404 |
| `/deals` | 검수·게시된 공구 목록을 공통 공구 카드로 표시, 예정·진행·종료 상태 안내. 공구 메뉴·홈에서 진입 |
| `/deals/:id` | 게시 공구 상세·판매자 증빙·광고·판매처 링크. 목록에서 진입. 없거나 철회된 공구는 전용 not-found 화면(404) |
| `/calendar` | 검수·게시된 공구를 시작일순으로 공통 공구 카드로 표시. 달력 메뉴·푸터 공구 달력 링크 |
| `/sellers` | 시드 출처(kr_retailers)와 관리자가 등록한 판매자의 출처와 통신판매업 신고·청약철회 7일·정식수입 증빙. 없으면 미확인. 목록 게재는 입점·보증이 아님. 공개 판매자별 이메일 알림 신청. 푸터 판매자 안내 및 공구의 신뢰 안내 링크 |
| `/login` | Google 로그인만 지원, 별도 가입 양식 없이 뉴스레터 기본 체크. Google 미설정 시 안내만 표시, 로그인된 사용자는 `/me`로 이동 |
| `/me` | 내 계정·뉴스레터 해지/재구독·로그아웃. 헤더 내 계정 링크. 비로그인 시 `/login`으로 이동 |
| `/admin` | ADMIN_TOKEN 인증 후 Instagram 원문 승인/반려, 판매자 관리, 공구 정정/철회·회차 확인, 외부 후보 조회/dismiss, 건수 현황 |

별도 `/brands` 페이지는 없습니다. `/models?by=brand`와 `GET /api/v1/brands`를 사용합니다.

`/models`의 `q`, `brand`, `category`, `by`가 반복되면 **빈 문자열을 포함해 첫 번째 값만** 사용합니다. 누락되거나 빈 배열이면 값 없음으로 처리하며 공백·대소문자는 보존합니다. 빈 값은 해당 필터를 해제하므로 `?q=&q=Stokke`는 검색 제한이 없습니다. 검색은 대소문자를 구분하지 않고 브랜드·종류는 정확히 일치해야 하며, `by`의 첫 값이 `brand`일 때만 브랜드순으로 정렬합니다. 진행 중 공구 우선순위는 유지합니다.

`/models` 카드(`app/models/_card.tsx`)는 **상품명(브랜드+모델), 1:1 손그림, 공식가, 현재 공구가** 네 항목만 표시합니다. 공구가 없으면 **진행 중인 공구 없음**입니다. 광고·검증 배지·확인 시각·추가 메타데이터를 붙이지 않습니다. 출처 링크와 확인일(`checked_at`에 해당하는 현재 필드 `checked`)·검증 수준은 모델 상세에 표시합니다.

`/`·`/deals`·`/calendar`·`/models/:id`는 같은 공구 카드를 사용합니다. 카드와 상세의 **공구 바로가기**는 게시 원문으로 연결하며 외부 모음에서 게시된 공구는 그 모음의 링크일 수 있습니다. 광고·거래 안내와 사이트 D1의 공개 판매자 증빙을 함께 표시합니다. 검수된 회차가 있는 경우 **공구 N회째**는 아가마중에 기록된 해당 판매자의 열린 회차 순서입니다. 여러 게시물이 한 회차에 속하면 같은 번호를 표시합니다. 공유 미확인 판매자 행은 각 공구에 저장된 원문 귀속만 표시합니다.

### 홈과 비교 근거

홈의 카테고리와 브랜드는 `category`, `brand` URL 매개변수를 하나씩 사용합니다. 각 칩은 다른 그룹의 선택을 유지하고 자기 그룹을 해당 값으로 바꿨을 때의 고유 공구 수를 표시합니다. 묶음 공구는 한 상품 항목에서 두 조건이 동시에 맞아야 합니다. 여섯 카테고리는 0건이어도 표시합니다. 브랜드는 D1 카탈로그와 게시된 상품 항목의 브랜드를 사용합니다.

진행 중인 공구는 검증된 공구가·정가·마감일을 갖춘 공개 공구입니다. 시작 시각이 없더라도 원문에서 주문 가능을 확인한 공구는 마감까지 집계합니다. 오늘 마감은 KST 자정 직전까지, 새로 열린 공구는 오늘과 앞선 6개 KST 날짜에 원문에서 확인한 오픈 시각을 사용합니다. 각 섹션은 필터와 정렬을 적용해 최대 3개를 표시합니다. 오늘 마감과 역대 최저가는 마감 시각순, 할인율 TOP은 정수 할인율 내림차순 뒤 마감 시각순, 새로 열린 공구는 오픈 시각 내림차순입니다. 마지막 동률은 공구 ID순이며 내용이 있는 섹션을 먼저 표시합니다.

홈의 건수·할인·필터·카드·다음 갱신 시각은 하나의 D1 SELECT에서 읽습니다. 공구 시작, 마감 직후, 공식가 근거·승인 만료, 한국 자정에 현재 필터로 화면을 갱신합니다. 시드만 있으면 0개와 상품 목록 링크가 표시됩니다.

`0019_hook_ux.sql`은 게시 시점에 유효한 가격 확인과 공식가 승인을 함께 보존합니다. `/models` 카드의 공식가는 표시한 최저 공구가의 근거와 카탈로그의 모델·세대·옵션·수량·구성이 일치할 때만 취소선을 적용합니다.

**판매자 공구 회차 확인**에는 확인된 판매자, 원문에 근거한 행사 식별자·시작 시각·근거 URL을 기록합니다. 한 행사에 여러 게시물을 연결할 때 같은 판매자와 식별자를 사용합니다. 역대 최저가는 실제로 열린 공개 공구 중 같은 구성의 가격을 판매자 전체에서 비교하고, 더 이른 검수 회차의 가격이 있는 경우에 표시합니다. 같은 회차의 상충 가격은 회차 비교 근거에서 제외하고, 회차가 확인되지 않은 공개 공구도 더 저렴한 동일 구성 가격이면 최저가 판정에 반영합니다. 철회된 공구는 공개 판정에서 즉시 제외되며 확인 근거 URL과 귀속 기록은 관리자 화면에 보관합니다.

`/admin`은 httpOnly·SameSite strict·1시간 쿠키와 Server Actions 동일 origin 검증을 사용합니다. 로그아웃은 발급 시와 같은 Path=/admin·HttpOnly·SameSite=strict·Secure(프로덕션에서만) 속성으로 쿠키를 만료시킵니다. 서비스 토큰 설정이 잘못되면 기존 쿠키가 있어도 설정 안내만 표시하고 로그인·검수를 차단합니다. 공개 화면에는 대기 원문을 전달하지 않습니다. 로컬 관리자 접속은 localhost를 사용하고 공유/운영 환경은 HTTPS를 사용합니다. 토큰을 URL에 넣지 마세요.

관리자 쿠키에는 ADMIN_TOKEN 원문 대신 `v1.<만료>.<nonce>.<HMAC-SHA256 서명>`을 저장합니다. 로그인마다 임의 nonce를 생성하고 ADMIN_TOKEN을 키로 만료 시각과 nonce에 서명하며, 서버는 서명과 1시간 만료를 검증합니다. 쿠키 값은 `/api/v1/admin/*`의 `Authorization: Bearer` 토큰으로 사용할 수 없습니다. ADMIN_TOKEN을 교체하면 기존 세션은 즉시 무효화됩니다. 로그아웃은 브라우저 쿠키를 삭제하지만 서버에 세션 상태를 저장하지 않으므로, 로그아웃 전에 탈취된 쿠키는 만료까지(최대 1시간) `/admin`에서 유효합니다.

## 소셜 로그인

가입은 **Google OAuth 로그인만** 지원합니다. Kakao·Naver는 후속 과제이며 별도 가입 양식은 없습니다. 의존성 없이 OAuth 2.0 authorization code 흐름을 직접 구현했고 Workers의 `fetch`와 `crypto.subtle`만 씁니다.

- 흐름: `/login`의 한 `<form method="get">`에 뉴스레터 체크박스(기본 체크)와 Google 버튼 하나가 함께 있습니다. `GET /api/auth/login/google`이 state·PKCE와 체크박스 값을 `agamajung_oauth` 쿠키(httpOnly·SameSite=Lax·Path=/api/auth/callback·10분)에 담아 Google로 302하고, `GET /api/auth/callback/google`이 state를 확인한 뒤 토큰 교환 → 이메일·공급자 id 조회 → D1 기록 → 세션 쿠키 발급 후 `/me`로 302합니다. 로그아웃은 `/me`의 서버 액션으로만 처리합니다(GET 라우트 없음). 모든 인증 응답은 `Cache-Control: no-store`입니다.
- 환경변수(`.dev.vars` 또는 운영 비밀 바인딩): `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`(둘 다 필요), `AUTH_ORIGIN`(기본 `https://agamajoong.soulbound.co.kr`, 로컬은 `http://localhost:8787`). Google 자격 증명 중 하나라도 없으면 버튼·폼 없이 준비 중 안내만 보이고 Google login·callback은 404입니다. 쿠키 `Secure`는 `AUTH_ORIGIN`이 https일 때만 켜집니다. 리디렉트 URI는 Host 헤더가 아니라 `AUTH_ORIGIN`으로 고정됩니다.
- Google Cloud Console에 등록할 리디렉트 URI는 `https://agamajoong.soulbound.co.kr/api/auth/callback/google`입니다. 로컬에서는 `AUTH_ORIGIN`에 맞는 Google 콜백 URI를 별도로 등록합니다.
- Google 콜백은 일치하는 state와 유효한 PKCE verifier가 필수입니다. verifier는 43~128자의 영문·숫자·`-._~`만 허용하며 토큰 교환에 `code_verifier`로 항상 전달합니다. 누락·null·빈 값·길이/문자 오류는 공급자 요청이나 DB 접근 전에 `/login?error=state`로 302하고 state 쿠키를 만료시킵니다.
- `/api/auth/login/kakao`와 `/api/auth/callback/kakao`는 **항상 404·본문 `Not found`·`Cache-Control: no-store`**입니다. 기존 `KAKAO_REST_KEY`·`KAKAO_CLIENT_SECRET` 바인딩, 인증 코드, 이전 state 쿠키나 유효한 Google state 쿠키가 있어도 공급자 요청이나 DB 접근 전에 거부합니다. 리디렉트나 쿠키 발급·변경은 없습니다. 기존 바인딩은 무시하므로 배포 환경에서 먼저 제거할 필요가 없습니다.
- 수집 정보: 이메일과 Google 계정 id뿐입니다. 액세스·리프레시 토큰, 이름, 프로필은 저장하지 않습니다. Google의 `email_verified`가 참인 이메일만 받습니다.
- 세션 토큰은 해시만 저장합니다(30일). 기존 Kakao 계정·identity·유효 세션은 그대로 보존합니다. `0005_users.sql` 변경이나 데이터 마이그레이션은 없으며, 기존 세션은 정상 만료나 로그아웃까지 `/me`와 뉴스레터 설정을 계속 사용할 수 있습니다. 이후 Kakao로 새 세션을 만들 수는 없습니다.
- 뉴스레터: 신규 가입 때만 로그인 시작 시 제출한 체크박스 값을 저장하고, 체크한 경우 동의 시각을 기록합니다. 콜백의 쿼리 매개변수로 이 선택을 바꿀 수 없습니다. 재로그인은 기존 선택·동의·해지 시각을 바꾸지 않습니다. `/me`에서 해지·재구독할 수 있고 같은 선택의 반복 제출은 시각을 바꾸지 않습니다.
- 계정은 `(provider, provider_user_id)`로 조회합니다. 기존 Kakao 계정과 이메일이 같은 Google 로그인도 별도 계정을 만들며 기존 계정을 수정하거나 자동 연결하지 않습니다. 따라서 **뉴스레터 발송 시 이메일 기준 중복 제거가 필요**합니다. **계정 삭제는 후속 과제**입니다. 레이트리밋은 Cloudflare 운영 설정에 맡깁니다. 이 인증 설정은 사이트 전용이며 Linux 수집기의 로그인·자격 증명·저장소와 분리됩니다.

## JSON REST API v1

읽기 응답은 `{ "data": ... }`, 실패는 `{ "error": "..." }`입니다. 현재 동일 origin API이며 공개 읽기 API는 향후 Expo 네이티브 클라이언트에서도 사용할 수 있습니다. 관리자 호환 현황 API는 공개 모바일 클라이언트에 `ADMIN_TOKEN`, `INGEST_TOKEN`, `COLLECTOR_STATUS_TOKEN`을 포함할 권한을 부여하지 않습니다. 관리용 서비스 자격 증명은 서버 측에만 보관합니다. 브라우저 cross-origin CORS는 열지 않았습니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/v1/brands` | 브랜드·모델 수 |
| GET | `/api/v1/models` | 모델 목록. 선택 쿼리 `brand`, `category` |
| GET | `/api/v1/models/:id` | 모델과 공식가·현재 공구가 요약·공구 이력 페이지, 없으면 404 |
| GET | `/api/v1/deals` | 검수 완료 공구 이력 페이지 (예정·진행·종료·일정 미확인 포함) |
| GET | `/api/v1/sellers` | 판매자 및 배지 증빙 URL |
| GET | `/api/v1/calendar` | 시작일순 검수 완료 공구 이력 페이지 |
| POST | `/api/v1/alerts` | 익명 이메일 알림 신청, 모델 또는 판매자 한 곳 |
| POST | `/api/v1/ingest` | INGEST_TOKEN. Instagram pending 접수 또는 쓰기 가능한 legacy 외부 후보 접수 |
| POST | `/api/v1/collector/status` | COLLECTOR_STATUS_TOKEN. 건수 스냅샷만 접수 |
| GET | `/api/v1/collector-status` | ADMIN_TOKEN 전용 관리용 호환 경로. `/api/v1/admin/collection-status`와 동일한 건수 현황 |
| GET | `/api/v1/admin/collection-status` | ADMIN_TOKEN. 작업기별 다섯 상태·생성/수신 시각·지연 여부 |
| GET | `/api/v1/admin/queue` | ADMIN_TOKEN 전용, pending만 captured_at·id 오름차순 페이지. limit 기본/최대 100, 응답 `{ data, next_cursor }` |
| POST | `/api/v1/admin/review/:id` | 관리자 승인/반려, 승인 시 모델·판매자·귀속 근거 필수 |
| GET | `/api/v1/admin/sellers` | ADMIN_TOKEN 전용, 등록 판매자·검수된 연결 계정·미연결 수집 계정 |
| POST | `/api/v1/admin/sellers` | 판매자 등록, 선택 계정 연결은 `account_reviewed: true` 필수 |
| POST | `/api/v1/admin/sellers/:id` | `action: update` 증빙 전체 교체, `link_account` 검수 연결, `unlink_account` 해당 판매자의 연결만 해제 |
| GET | `/api/v1/admin/deals?status=published&limit=20&cursor=…` | ADMIN_TOKEN 전용, 상태 published(기본)/withdrawn/all, checked·id 내림차순 키셋 페이지. limit 1–50, 응답 `{ data, next_cursor }`, 전체 건수 제한 없음 |
| GET | `/api/v1/admin/deals/:id` | ADMIN_TOKEN 전용, 현재 값·전체 버전 이력·보존된 수집 원문 및 귀속 검수 근거 |
| POST | `/api/v1/admin/deals/:id` | ADMIN_TOKEN 전용, action correct/withdraw, expected_version·request_id·reason 필수 |
| POST | `/api/v1/admin/deals/:id/round` | ADMIN_TOKEN 전용, `expected_version`, `action: confirm`, `confirmed: true`, `seller_id`, `event_key`, `opened_at`, `source_url`. 현재 연결 해제는 `action: clear` |
| GET | `/api/v1/admin/candidates` | ADMIN_TOKEN 전용, candidate만 captured_at·id 오름차순 페이지. limit 기본/최대 200, 응답 `{ data, next_cursor }` |
| POST | `/api/v1/admin/candidates/:id` | `{ "action": "dismiss" }`만 허용(그 외 400, 이미 처리됨 409, 없는 id 404) |
| GET | `/api/v1/images/:key` | R2 `IMAGES`의 `public/` 아래 jpg/jpeg/png/webp/avif. 허용 파일명·존재 여부 검사, 없으면 404 |
| GET | `/api/auth/login/google` | Google OAuth 시작. 공급자 미설정 시 404 |
| GET | `/api/auth/login/kakao` | 비활성. 기존 설정과 무관하게 DB·공급자 접근 전 항상 404·본문 `Not found`·no-store |
| GET | `/api/auth/callback/google` | Google OAuth 콜백. Google 미설정 시 404 |
| GET | `/api/auth/callback/kakao` | 비활성. 코드·state 쿠키·기존 설정과 무관하게 항상 404·본문 `Not found`·no-store |

v1 분기는 `lib/api.ts`, 이미지 라우트는 `app/api/v1/images/[key]/route.ts`, OAuth는 `app/api/auth/[[...path]]/route.ts`와 `lib/auth.ts`에 있습니다. OAuth는 v1 밖의 별도 경로입니다. 공개 공구 상세 GET API는 없으며 모델 비교나 공구 목록을 사용합니다. 관리자 행은 모두 ADMIN_TOKEN이 필요합니다.

### 이메일 알림 신청

`POST /api/v1/alerts`는 `email`, `target_type` (`model` 또는 `seller`), `target_id`를 JSON이나 URL 인코딩 폼 본문으로 받습니다. 두 형식 모두 파싱 전 32 KiB 상한을 적용합니다. D1에 저장이 확인되면 최초·중복 JSON 요청 모두 200 `{ "result": "success" }`를 반환합니다. 이메일 양끝 공백을 제거하고 도메인의 대소문자를 통일한 키를 대상별로 중복 제거합니다. 이메일의 로컬 부분과 최초 배송 주소를 보존합니다.

브라우저 폼은 같은 경로로 POST하고 성공 시 대상 화면의 폼 위치로 303 이동합니다. JSON의 잘못된 요청은 `invalid` 또는 `target`, 없는 대상은 404 `target`, 저장 실패는 503 `retry`를 반환합니다. 이메일은 요청 URL·리디렉션·응답에 넣지 않습니다. `0019_hook_ux.sql`은 사이트 D1에 검수 근거와 알림 신청 테이블을 추가합니다. 알림 발송은 후속 단계입니다.

### 공개 공구 이력 페이지 계약 (호환성 변경)

**기존 전체 이력 응답을 기본 20건의 페이지로 변경했습니다.** `/api/v1/deals`, `/api/v1/calendar`, `/api/v1/models/:id`는 `limit`(1–50, 기본 20)과 `cursor`를 받습니다. 클라이언트는 `next_cursor`가 null이 될 때까지 이어서 요청해야 오래된 공구를 모두 볼 수 있습니다. 전체 이력 건수에는 상한이 없습니다. 모든 조회·집계·페이지 문맥 조회는 `status = 'published'`만 대상으로 합니다.

첫 요청과 이어서 요청하는 예시입니다. 반환한 커서를 수정하지 않고 URL 인코딩합니다. 같은 크기를 권장하지만 페이지 크기는 변경할 수 있습니다.

```js
const first = await fetch('/api/v1/deals?limit=20').then(r => r.json());
if (first.next_cursor !== null) {
  const next = await fetch('/api/v1/deals?' + new URLSearchParams({
    limit: '20', cursor: first.next_cursor,
  })).then(r => r.json());
}
// calendar: /api/v1/calendar?limit=20&cursor=<URL-encoded next_cursor>
// model: /api/v1/models/model-1?limit=20&cursor=<URL-encoded next_cursor>
```

공구·달력 응답은 `{ data: Deal[], next_cursor: string | null }`입니다. 기존 공구 필드와 `advertisement: true`, `notice`는 유지합니다. 모델 응답은 기존 모델 필드 및 배열 위치를 유지하고 현재 가격 요약을 추가합니다.

```text
{
  data: {
    ...existingModelFields,
    comparison: {
      official: existingOfficialComparison,
      gonggu: Deal[],
      current: { active_count: number, lowest_price: number | null }
    }
  },
  next_cursor: string | null
}
```

`comparison.gonggu`의 광고 필드는 유지하며 공식가는 계속 `page_body`만 표시합니다. `lib/data.ts`의 순수 `comparison()` 자체는 `official`, `gonggu`만 반환합니다. `current`는 API 조립 시 추가하고, 조회한 이력 페이지와 무관하게 요청 시각의 전체 활성 공구에서 집계합니다. 활성 공구 없음은 count 0/minimum null, 활성 가격이 모두 null이면 양수 count/minimum null, 숫자와 null 혼합은 최저 숫자, 0원은 유효한 최저가입니다. 모델 카드는 각각 “진행 중인 공구 없음”, “정보 없음”, 최저가를 표시하며 네 항목 규칙을 유지합니다.

마지막 페이지는 남은 항목만 반환하며, 정확히 limit개 남았더라도 `next_cursor: null`입니다. 빈 첫 페이지와 동시 변경으로 비어진 계속 위치 모두 API에서 아래처럼 응답합니다. 모델은 `comparison.gonggu: []`, 최상위 `next_cursor: null`이고 현재 요약은 별도로 유지합니다.

```json
{ "data": [], "next_cursor": null }
```

| 화면/API | 순서 및 평가 시각 |
| --- | --- |
| `/api/v1/deals`, `/api/v1/calendar`, 모델 상세 API/화면, `/calendar` | 저장된 `starts_at ASC, id ASC`. NULL 시작은 ID순 첫 구간, 빈 문자열·공백·잘못된 문자열은 비NULL 구간. 이력 정렬은 시각과 무관하며 상태/현재가는 요청 시각을 한 번 캡처 |
| `/deals` | 진행 → 예정 → 종료 → 미확인. 진행은 정규화된 종료 오름차순, 예정은 시작 오름차순, 종료는 유효 종료 내림차순, 각 동률은 ID 오름차순. 미확인은 ID순 |
| 홈 | 요청 시각의 필터별 공구·섹션과 정확한 집계, 단일 SELECT에서 최대 12개 카드 문맥 반환 |
| `/models` | 선택 모델의 현재 요약만 배치 집계, 활성 모델 우선·기존 필터/안정 순서 유지 |

`/deals` 첫 페이지는 기준 시각 T0를 정하고 이후 커서가 T0를 유지합니다. 섹션과 정렬은 T0를 사용합니다. 가격 근거 유효성, 진행 중 전체 건수와 카운트다운은 요청 시각을 사용합니다. “처음부터 최신 정보로 보기” 링크는 커서를 제거하여 새 시각을 정합니다. 달력과 모델 이력은 각 요청 시각으로 상태를 표시합니다. 모델 상세의 현재가 요약은 이력 위치에 의존하지 않습니다.

일정 SQL은 `parseTimestamp()`/`normalizeTimestamp()`와 같은 엄격한 달력·시간·1–3자리 소수초·명시 오프셋(최대 23:59)·UTC 4자리 연도를 검증하며 저장값은 변경하지 않습니다. `source_ended = 1`은 항상 종료, 유효 역전 구간은 미확인, 종료 < T이고 시작이 없거나 유효하면 종료, 시작 > T이면 예정, 유효한 비역전 두 끝점은 시작/종료 시각을 포함해 진행입니다. 나머지는 미확인입니다. NULL·빈 문자열은 부재, 공백은 존재하는 잘못된 값으로 취급합니다. 원문 종료이며 유효한 종료가 없으면 정렬에 Unix epoch를 사용합니다. 날짜 문구는 기존 KST 렌더러를 사용합니다.

커서는 `[1, surface, ordering, model_scope, partition_or_phase, key, id, T0]`의 정규 UTF-8 base64url JSON이며 최대 2,048자입니다. endpoint/화면·순서·모델·NULL/비NULL 구간 또는 상태 구간에 묶입니다. ID/모델 ID는 비어 있지 않은 최대 200자(제어문자 제외), 역사 경계 문자열은 최대 256자로 빈 값·잘못된 legacy 문자열도 원형 보존합니다. 진행/예정/종료 키와 T0는 정규 UTC instant여야 하고 미확인 키는 null입니다. 시간순 커서의 T0는 null입니다. 모든 SQL 값은 바인딩하며 anchor 행을 다시 조회하지 않습니다. 커서는 공개 탐색 데이터이며 인증 수단·서명된 스냅샷이 아닙니다.

- 중복·빈 값·범위 밖·소수·공백 등의 `limit`: D1 접근 전 HTTP 400 `{ "error": "invalid_limit" }`.
- 중복·빈 값·잘못된 인코딩/튜플·다른 endpoint/모델 등의 `cursor`: D1 접근 전 HTTP 400 `{ "error": "invalid_cursor" }`.
- 성공·오류 모두 `Cache-Control: no-store`. DB 오류는 빈 이력이나 0건 집계로 숨기지 않습니다. 화면은 잘못된 페이지에 복구 링크, 비어진 계속 위치에는 최신 목록 안내를 표시합니다.

키셋은 마지막 **반환한** 항목의 배타적 경계에서 이어가며 한 건을 더 읽어 다음 페이지를 판단합니다. NULL 시작 구간을 다 읽으면 같은 페이지의 남은 공간을 비NULL 구간으로 채웁니다. 종료는 시간 DESC/ID ASC의 혼합 방향을 따로 비교합니다. 후보를 먼저 한정한 뒤 최대 limit개의 공개 문맥을 조인하고 원래 순서를 복원합니다. 이 조회는 DB 스냅샷이 아닙니다. 철회는 다음 읽기부터 즉시 제외되고 삭제/철회된 anchor 커서도 유효합니다. 정정·삽입·과거 시각으로 추가된 공구는 탐색 결과를 바꿀 수 있으며 처음부터 다시 조회하면 최신 위치를 볼 수 있습니다.

사이트 D1의 `0014_public_deal_queries.sql`은 시간순·모델별 시간순·유효 구간·예정·종료·원문 종료·불완전 일정 인덱스를 추가합니다. `0017_normalized_deal_indexes.sql`은 같은 정규화 식을 두 가상 열로 옮겨 인덱스에서 재사용합니다. 정정·철회 시 Workerd가 같은 검증식을 여러 번 컴파일할 필요가 줄어듭니다. SQL 표현과 정적 published 조건은 `lib/deal-query-sql.ts`와 일치하며 동적 시간은 바인딩합니다. 미확인은 영구 미확인, 시작만 유효하면서 S ≤ T0, 시작 부재/종료 유효하면서 E ≥ T0의 세 겹치지 않는 스트림을 ID순 병합합니다. 만료된 종료-only 일정은 end 범위 탐색으로 제외합니다. 동적 미확인의 ID 정렬은 해당 불완전 일정 범위에 한정되며 완전한 과거 이력을 스캔하지 않습니다.

전송 상한은 이력 후보 `limit + 1`, 상태별 여러 스트림을 포함한 `/deals` 전체 후보 최대 `8 × (limit + 1)`, 문맥 조회 최대 limit입니다. 건수는 한 행, 모델 요약은 요청 모델당 최대 한 행이며 80개씩 배치합니다. 정확한 건수·구간 집계는 적합한 인덱스 항목을 읽고 동적 미확인은 적합 범위를 정렬할 수 있으므로 DB 작업량이 상수라고 보장하지 않습니다. Linux 수집기 저장소·마이그레이션·예약에는 적용하지 않습니다.

검증은 `npx vitest run tests/public-deal-pagination.test.ts`로 실행합니다. 전체 사이트 마이그레이션을 적용한 100,000개 이상의 합성 공구/100모델 fixture를 재사용하고 순회·경계·시간·집계·공개 필드·실패·실제 링크·결과 크기·EXPLAIN 계획을 검사합니다. Python SQLite progress handler로 10k/100k 완전 과거/만료 종료-only 일정에 대한 미확인 탐색의 VM 작업량도 비교합니다. 실제 데이터나 Linux SQLite를 사용하지 않습니다.

### 관리자 건수 현황 호환 API

`GET /api/v1/collector-status`는 `GET /api/v1/admin/collection-status`와 같은 인증·응답을 사용하는 관리용 호환 경로입니다. 두 경로 모두 `Authorization: Bearer ADMIN_TOKEN`이 필요하며, 누락·오류 또는 수집/현황 토큰·관리자 세션 쿠키 값을 bearer로 사용하면 401입니다. D1 조회 전에 관리자·수집 토큰이 각각 24자 이상, 앞뒤 공백 없이 서로 다른지 검증하고 선택 현황 토큰과의 충돌도 차단합니다. 설정 오류는 인증보다 먼저 503으로 거부합니다. 별개의 현황 토큰이 누락되거나 짧아도 관리자 읽기를 차단하지 않으며, 현황 토큰의 강도는 기존 POST 접수 경로에서 별도로 검증합니다.

응답은 `{ "data": { "synced": false, "workers": [] } }`(미수신) 또는 `synced: true`와 작업기별 `{ snapshot, received_at, stale }`입니다. `snapshot`에는 `worker_id`, `version`, `generated_at`, 다섯 상태의 `counts`, 보조 집계 `total`, `unique`, `groups`, `unresolved_conflicts`, `recheck_due`만 있습니다. 로컬 수집 레코드·URL·원문·근거는 제공하지 않습니다. 유효한 저장값 0건은 유지하고, 미수신을 0건으로 만들지 않습니다. 여러 작업기는 작업기 ID순으로 각각 반환하며 합산하지 않습니다. `stale`은 수신 시각이 아니라 생성 후 **60분 초과**일 때 true이며, 정확히 60분은 false입니다.

D1 오류나 잘못된 저장 스냅샷은 원시 자료·부분 결과 없이 일반 503 오류를 반환합니다. 호환 경로의 인증된 POST는 405이며, 성공 및 401/503/405 응답 모두 `Cache-Control: no-store`입니다. 이 API는 사이트 D1의 건수만 읽으며 Linux 수집기 실행·동기화나 로컬 저장소 접근을 허용하지 않습니다.

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

수집 JSON (최대 96KB, text 최대 20,000자):

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

`image_url`은 선택 항목(생략·null 가능)이며 최대 4,096자의 절대 HTTPS URL입니다. `cdninstagram.com`, `fbcdn.net` 및 실제 하위 도메인만 허용하고 사용자 정보·fragment·비표준 포트는 거부합니다. 서명 쿼리는 원문 그대로 저장하며 잘못된 값은 URL을 응답에 포함하지 않고 400으로 거부합니다. 중복 수집 시 최초 이미지는 보존합니다. 검수 대기 항목에서 더 최근에 수집한 수정 캡션에 해당 가격 근거가 있으면 본문·수집 시각·근거를 함께 갱신합니다. 이미지는 검수 대기열에만 저장되고 승인 전이나 반려 후에는 공개되지 않습니다.

승인 JSON은 `action: "approve"`, 등록된 `model_id`, `seller_id`, `title`, `price`(정수 원 또는 null), `starts_at`, `ends_at`(시간대 포함 ISO)을 받습니다. 이미지 포함 여부는 선택 boolean `include_image`로 지정하며 기본값은 true입니다. `/admin`의 인증된 미리보기 옆 “이미지 포함”을 해제하면 이미지 없이 게시합니다. 검수 API는 대체 `image_url`을 받지 않고 저장된 이미지만 승인 트랜잭션 안에서 복사합니다. 반려는 `{ "action": "reject" }`입니다. 승인 후 가격은 manual 검증 수준이며 원문 URL을 유지합니다. 이미 검수된 건은 409, 잘못된 입력은 400입니다. 게시와 검수 상태 변경은 D1 batch 트랜잭션으로 처리합니다. `/admin`의 모델·판매자 선택은 공란으로 시작하며 둘 다 직접 선택해야 합니다. 승인에는 `attribution`도 필수입니다. `account`는 정규화된 원문 계정과 선택한 판매자 사이에 검수된 연결이 있어야 합니다. `explicit`은 미연결·다른 판매자 연결·핸들이 아닌 계정에 사용할 수 있으며 `attribution_note`에 10–300자의 귀속 사유를 남겨야 합니다. 명시 귀속은 계정 연결을 만들거나 변경하지 않습니다. 반려에는 선택값·귀속 근거가 필요 없으며 브라우저 필수 입력 검증도 건너뜁니다.

`/admin`의 “판매자 등록·증빙”에서 대기열 유무와 무관하게 새 판매자를 등록할 수 있습니다. 등록·수정 입력은 `name`(100자 이하), `source_url`(HTTPS), 선택 증빙 `registration_source`, `withdrawal_source`, `official_import_source`입니다. 증빙을 비우면 NULL로 지워져 미확인으로 표시되며 원문 URL이나 계정으로 증빙을 추정하지 않습니다. URL은 자격 증명 없는 HTTPS만 허용합니다. 수정은 증빙 전체를 교체합니다.

등록 시 선택 `account`를 입력하거나 기존 판매자에 `link_account`할 때는 반드시 `account_reviewed: true`로 직접 확인해야 합니다. 계정은 앞뒤 공백·선행 @를 제거하고 소문자로 정규화하며 영문·숫자·점·밑줄 1–30자만 연결합니다. 한 계정은 한 판매자에만 연결할 수 있고 충돌은 409입니다. 계정 없는 등록은 기존 연결에 영향을 주지 않습니다. 핸들이 아닌 수집 계정은 따로 표시하며 명시 귀속만 가능합니다. 모든 판매자 관리 API는 ADMIN_TOKEN 전용이며 INGEST_TOKEN으로 관리할 수 없습니다. 수집 요청의 판매자 필드는 판매자를 생성하지 않습니다.

Linux 수집기의 `seller_candidates`는 사이트 판매자가 아니며 사이트가 가져오거나 자동 등록하지 않습니다. `external_candidates.seller_handle`도 판매자 등록·연결에 사용하지 않습니다. `seller_accounts` 및 승인 귀속 사유는 관리자 전용이며 공개 판매자·공구 응답에는 포함하지 않습니다.

게시된 공구는 `/admin`의 “게시된 공구 정정·철회”에서 관리합니다. 게시 중·철회됨·전체 탭과 “다음 20건”으로 오래된 공구까지 탐색하며, `/admin?deal=<id>`로 직접 찾을 수 있습니다. 원래 수집 본문·URL·이미지·판매자 귀속 사유와 검수 시각은 읽기 전용으로 보존합니다. 게시 시 v1 publish 이력을 만들고, 정정·철회마다 전체 상태와 사유를 다음 버전에 추가합니다. 사유·요청 ID·이력·수집 근거는 관리자 전용이며 공개 JSON에는 상태나 버전도 포함하지 않습니다.

정정(`action: "correct"`)은 등록된 `model_id`, 1–200자 `title`, 정수 원 또는 null `price`, 시간대 포함 `starts_at`·`ends_at`, boolean `include_image`를 모두 받습니다. 제목·사유는 앞뒤 공백을 제거하고 일정은 UTC로 정규화합니다. 이미지는 수집 원본에서 복원하거나 제거할 수만 있습니다. 원문 URL·검증 수준·판매자 귀속은 바꿀 수 없습니다. 판매자가 잘못되었으면 철회하세요. 제목이나 이미지 선택만 정정하면 가격 근거와 확인 시각을 그대로 이어갑니다.

두 작업 모두 `expected_version`(1 이상 안전한 정수), `request_id`(영문·숫자·하이픈 16–64자, `review-` 접두사는 승인 이력용 예약), 10–300자 `reason`이 필요합니다. 폼은 렌더링할 때 각각 새 UUID를 생성합니다. 요청 ID는 정규화된 요청 내용의 SHA-256과 결합되므로 동일 요청을 재전송하면 200 `replayed: true`로 응답하고 버전·이력을 추가하지 않습니다. 같은 키의 다른 내용·동작·예상 버전은 409 `request_id_reused`입니다. 버전 경쟁은 409 `stale_version`과 `current_version`, 이미 철회된 공구의 새 작업은 409 `withdrawn`입니다. 버전 가드가 있는 D1 batch 하나에서 이력 추가와 현재 값 변경을 원자적으로 처리합니다.

`/admin`의 철회(`action: "withdraw"`) 폼은 공개 화면에서 내림 확인과 사유를 요구합니다. 철회는 최종 상태로 복원할 수 없으며, 모든 공개 목록·모델 비교·현재 공구가 카드·달력에서 사라지고 직접 상세 접근도 404가 됩니다. 동일 URL 재수집은 기존 approved 상태만 반환하고 원문이나 게시 내용을 바꾸지 않습니다. 재승인은 409이며 수집/현황 토큰으로 정정·철회 API를 호출할 수 없습니다. 이 기능은 사이트에만 속하며 Linux 수집기의 저장소나 게시 권한을 연결하지 않습니다.

승인·수집의 타임스탬프는 시간대 오프셋을 허용하며 UTC `YYYY-MM-DDTHH:MM:SS.SSSZ`로 정규화해 저장합니다. 존재하지 않는 날짜(예: 2월 30일)와 종료 ≤ 시작인 일정은 400으로 거부합니다. 제안 일정은 같은 엄격한 검증을 거치되 원문 값을 보존하며, 공개 화면의 일정·확인일은 KST로 표시합니다.

승인된 이미지는 공구 카드·상세 화면에서 브라우저가 직접 불러옵니다(`referrerPolicy="no-referrer"`, 지연 로딩, 서버 프록시·최적화 요청 없음). 이미지가 없거나 로딩에 실패해도 텍스트·가격·광고 및 거래 안내는 유지됩니다. **Instagram CDN URL은 만료될 수 있으므로 영구 보관을 보장하지 않습니다.** 현재 ingest는 R2 업로드를 지원하지 않습니다. R2 영구 저장은 업로드와 검수 후 공개 계약을 별도로 설계해야 합니다.

### 외부 공구 모음 후보 (`kind: "external_listing"`)

`POST /api/v1/ingest`에 `kind: "external_listing"`을 보내면 공구팡팡·맘캘린더·BUYG·스냅업 자료를 `external_candidates`에 접수합니다. 같은 URL의 대기 후보에는 가장 최근에 수집한 제목·본문·단서·일정·revision을 유지합니다. 응답은 202와 저장된 ID·상태·revision을 반환합니다. `price_hint`와 `price_raw`는 검수 단서입니다. 관리자는 외부 후보를 별도로 검수하고, 현재 수집 본문과 revision에 연결된 검증 근거를 선택할 수 있습니다. 공개 화면에는 사람의 검수와 가격 공개 조건을 통과한 공구가 표시됩니다.

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
| 독립 수집 PM2 cron | KST discover 09:20·15:20·21:20, collect 09:40·15:40·21:40, discover-sources 10:05, backfill-engine 03:30 | `crawler/ecosystem.all.config.cjs`. 예약 호출은 이전 작업의 crawl 잠금을 기다림. [수집 일정](docs/collector/scheduling.md) |
| 건수 sync | heartbeat 15분(`STATUS_HEARTBEAT_MS`). sync 호출 때 새 스냅샷 필요 여부 확인, 내장 timer 없음. 운영자는 15분 이하 간격으로 실행(같은 sync 중복은 자동 거부) | `crawler/src/status-sync.ts`, [동기화 운영](crawler/README.md#건수-동기화) |
| 사이트 현황 | 스냅샷 **생성** 후 60분 초과 시 동기화 지연 | `lib/collection-status.ts`. 수신 시각 기준이 아님 |

`pm2 start crawler/ecosystem.config.cjs`는 등록 즉시 한 번 실행합니다. 예약만 등록하는 절차와 보안 중단 후 수동 확인은 수집기 운영 문서를 따르세요. 이 호스트의 수집기 등록과 전환은 자동 배포 서비스가 관리하며 sync 타이머는 운영자가 관리합니다.

사이트 현황의 **읽기 실패**와 Linux 전송의 **동기화 지연**은 점검 경로가 다릅니다. 읽기 실패는 사이트 D1·바인딩·마이그레이션·저장 스냅샷을, 지연은 Linux sync 실행 간격·outbox를 확인합니다. 구체적인 상태 구분은 [사이트에 표시하는 수집 현황](#사이트에-표시하는-수집-현황)을 따릅니다.

## 블루프린트와 다른 점

인증은 블루프린트대로 Google만 활성화하며 Kakao·Naver는 보류합니다. 별도 가입 양식 없이 뉴스레터는 기본 체크입니다. 기존 Kakao identity·세션을 보존하는 것은 새 Kakao 로그인을 허용하지 않습니다.

1. collector-status는 **POST `/api/v1/collector/status`**(현황 토큰)와 **GET `/api/v1/admin/collection-status`**(관리자)로 나뉘며 건수 스냅샷만 저장합니다. 블루프린트의 **GET `/api/v1/collector-status`**는 같은 관리자 전용 읽기의 호환 경로입니다.
2. `/brands` 페이지는 없고 `/models?by=brand`와 `GET /api/v1/brands`가 브랜드 탐색을 담당합니다.
3. `/me`, `/sellers`, `/api/v1/images/:key`(R2 `public/`만), 관리자 판매자·공구 정정/철회·후보 API가 추가되어 있습니다.
4. legacy **`kind: "external_listing"` ingest는 여전히 쓰기 가능**합니다. 새 external_candidates 삽입과 candidate 갱신만 하며 dismissed는 보존합니다. 관리자는 조회·dismiss만 할 수 있고 후보를 공구로 승격하는 경로는 없습니다. price_hint/price_raw는 공구가나 공식가로 표시되지 않습니다.
5. Workers Cron은 **로그 전용 stub**입니다. 모든 수집은 Linux에서 실행합니다.

## 검증

저장소 루트의 검증 명령입니다.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
npm run build:clipper
npx playwright install chromium
npm run check:hook-ux
```

`check:hook-ux`는 Worker 빌드 뒤 새 `.local/hook-ux-*/` 디렉터리에만 사이트 마이그레이션과 일반 시드를 적용합니다. 같은 로컬 D1로 Wrangler를 실행해 빈 홈을 확인한 뒤 이 실행 전용 합성 공구를 추가합니다. 390×844·1280×900·폭 320px의 두 테마, 첫 가격과 CTA의 위치, 필터와 뒤로 가기, 원문 링크, 타이머 갱신, 이미지 지연/실패, 네이티브·하이드레이션 폼과 D1 저장을 검사합니다. 러너가 브라우저와 Wrangler를 종료하며 스크린샷 및 `measurements.json`을 해당 디렉터리에 저장합니다. 검사 실패 시 종료 코드가 0이 아닙니다.

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

그림은 투명 배경의 순수 선화이며 제품과 확인된 구성품만 그립니다. 글자·글자 모양 경로·로고·배경·액자·그림자·내장 래스터·외부 참조·스크립트는 허용하지 않습니다. 상품명은 HTML `alt`와 비표시 SVG `<title>`로 제공합니다. 카드의 네 항목(상품명·손그림·공식가·현재 공구가)은 그대로입니다. 진행 중 공구의 가격만 미확인이면 공구 행에 **정보 없음**을 표시하고 공식가 행도 유지합니다. **진행 중인 공구 없음**은 활성 공구 자체가 없을 때 표시합니다.

```sh
npx tsx scripts/render-model-illustrations.ts            # 시드 41개 SVG 검증, 파일 생성 없음
npx tsx scripts/render-model-illustrations.ts model-32 model-39
npx tsx scripts/render-model-illustrations.ts --out .local/illustration-previews
npx tsx scripts/card-screenshots.ts --out .local/card-qa
```

위 명령은 Playwright로 서버·네트워크 없이 실행합니다. SVG를 252px·540px로 메모리 렌더링하여 정사각 크기·투명 여백(2.5%)·잉크 밀도(20% 미만)·잘림을 검사하며, PNG 미리보기는 명시한 `.local/` 하위 디렉터리에만 저장합니다. 오프라인 카드 화면은 가격 있음·가격 미확인·공구 없음과 시드 밖 `model-42` 자리표시를 위한 합성 fixture입니다. 합성 가격은 시드나 D1에 저장하지 않습니다.

실제 Workers의 `/models`와 정적 SVG 응답은 별도로 검증합니다. 아래 절차는 새 전용 로컬 D1 디렉터리를 사용하며, 모든 D1·Wrangler 명령에 같은 `--persist-to`를 유지합니다. 기존 검수·수집 데이터가 있는 디렉터리를 사용하지 마세요.

```sh
npm test -- tests/model-illustrations.test.ts tests/model-cards.test.ts tests/models-page.test.ts
npm run build:worker
npx wrangler d1 migrations apply DB --local --persist-to .local/svg-smoke-state
npx tsx scripts/seed.ts
npx wrangler d1 execute DB --local --persist-to .local/svg-smoke-state --file=.local/seed.sql
npx wrangler dev --local --persist-to .local/svg-smoke-state --port 8797
```

Worker가 실행 중인 상태에서 다른 터미널로 확인합니다. `--origin`은 로컬 HTTP 주소만 허용하고 해당 origin 밖의 브라우저 요청은 차단합니다.

```sh
npx tsx scripts/card-screenshots.ts --origin http://localhost:8797 --out .local/worker-card-qa --cards model-4,model-5,model-21,model-22
```

두 카드 모드는 레지스트리가 아닌 **시드 전체**를 기준으로 하여 누락 등록도 실패시킵니다. 390px 모바일·1280px 데스크톱 × 라이트·다크 전체 화면 4장과 기본 41개 카드 164장을 `.local/` 아래 저장합니다(`--cards`는 개별 카드 저장 범위만 선택). 41개 그림을 모두 디코딩한 뒤 네 항목의 내용·정사각 원본/표시 크기·잘림·공구가 행 높이(40px 이하)·같은 행 카드 높이·가로 넘침·서체와 테마를 검사합니다. Workers 모드는 시드의 검증된 공식가와 공구 없음 상태를 대조하고, 정확한 SVG 경로 41개가 모두 HTTP 200·`image/svg+xml`로 응답하며 PNG·이미지 최적화 요청이 없는지 확인합니다. 성공한 검사 기록은 각 출력 디렉터리의 `checks.json`에 저장합니다. 전체 화면과 구성품 카드(model-4·5·21·22)를 눈으로 검토하여 글자·로고 부재와 구성품 가독성도 확인하세요. 경로 수나 자동 검사만으로 제품 충실도를 판정하지 않으며 출처와 렌더링을 눈으로 대조합니다.

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

## 검증된 공동구매 가격

사이트 D1 마이그레이션 `0016_verified_deal_prices.sql` 적용 시 기존 가격과 검수 이력은 보존되고 기존 공구의 가격 검증 상태는 미확인으로 시작합니다. 모든 공개 공구 조회는 승인 상태, 현재 공구 revision에 연결된 검증 근거, 확인된 공구가·정가·마감일·출처·확인 시각을 먼저 확인합니다. 정가는 같은 모델·세대·옵션·수량·구성의 제조사 또는 공식 수입사 제품 페이지에서 확인합니다. 두 판독에서 공구가와 마감일, 공식 페이지의 정가와 구성이 정확히 일치해야 합니다. 명시적으로 전체 상품이 0원인 경우만 공구가 0원을 인정합니다. 날짜만 명시된 마감은 KST 해당 날짜의 마지막 밀리초까지입니다.

할인율은 D1에서 정수로 내림 계산합니다. 390,000원과 430,000원의 할인율은 9%입니다. 할인율이 1% 미만인 경우, 정가와 같은 경우, 정가를 넘는 경우 모두 관리자 화면에만 남습니다. 각각 `discount_below_one_percent`, `equal_price`, `above_list`로 기록하며 관리자 화면에서 확인할 수 있습니다. 공구 카드 및 상세의 가격 비교에는 공구 검증 근거의 정가를 사용합니다. 모델 목록의 공식가는 기존 모델 근거를 쓰며 현재 공구가는 공개 가능한 진행 중 공구의 최저가입니다.

- 홈페이지는 진행 중 전체 건수와 최대 할인율, 오늘 마감·역대 최저가·할인율 TOP·새로 열린 공구를 보여 줍니다. `/deals`는 진행 중 → 오픈 예정 → 종료 → 시작 일정 미확인 순입니다. 진행 중 공구는 할인율 내림차순, 마감일 오름차순, ID 순입니다. 마감 임박 정렬은 마감일과 ID 순입니다. 시작일 없이 주문 가능 상태를 원문에서 확인한 공구는 마감 시각까지 진행 중으로 집계합니다. 주문 상태를 확인하지 못한 공구는 마감 전까지 시작 일정 미확인으로 표시하며 마감 시각을 지나면 종료로 이동합니다. 원문에서 종료를 확인한 공구도 종료에 표시됩니다.
- `GET /api/v1/deals?sort=discount`와 `?sort=ending`은 같은 진행 중 정렬과 섹션 순서를 제공합니다. `sort` 생략 시 기존 시작일과 ID 순을 유지합니다. 달력과 모델 공구 이력도 기존 시간 순서입니다. 기존 시간 순 커서는 계속 사용 가능합니다. 정렬된 목록의 커서는 화면·정렬·섹션·범위·기준 시각에 귀속됩니다. 이전 공구 화면의 섹션 커서는 처음부터 다시 열어 주세요.
- 공개 공구 객체는 `deal_price_krw`, `list_price_krw`, `discount_pct`, `ends_at`, `price_source_url`, `list_price_source_url`, `price_checked_at`를 포함하며 `price`는 공구가의 호환 별칭입니다. 검증 근거와 검수 이력은 관리자 전용입니다. 공개 조건을 충족하지 않는 `/deals/:id`는 404를 반환합니다. `/rss.xml`은 진행 중 공구를, `/sitemap.xml`은 종료 이력을 포함한 모든 공개 공구 상세 URL을 제공합니다.
- 사이트는 관리자 전용 `POST /api/v1/admin/price-sources`로 동기화한 공식 상품 URL·모델·승인 revision·만료를 가격 근거 접수·게시 승인·공개 조회에서 확인합니다. 공식 확인 시각부터 24시간 또는 승인 만료 중 먼저 도달하는 시점에 공개를 중단합니다. 검수 화면을 연 후 근거나 수집 revision이 달라지면 새로고침 후 검수해야 합니다. 게시 후 달라진 가격·마감·구성은 재검수까지 비공개로 전환됩니다. Linux 공개 웹 수집기는 수집 인증으로 `external_price_observation`을 보내 게시된 외부 공구의 변경·종료를 알립니다.
- 공구 및 관리자 검증 문구는 `lib/copy/deals.ko.ts`에서 관리합니다. 정상 사이트 버전 간 `lib/copy/**` 변경은 기존 `COPY_REVIEW.md` 검토 흐름에 포함됩니다.
- 마이그레이션과 검증 필터가 운영에 활성화된 뒤, 사용을 승인받은 Linux 수집 호스트에서 `npm run backfill:prices`를 한 번 실행합니다. 본문이 바뀌거나 이전 해시를 확인할 수 없는 경우 새 관찰을 별도로 보존하고 현재 revision에서 명시적으로 선택해 적용합니다. 중단 시 같은 체크포인트로 이어서 실행할 수 있습니다. [Linux 실행과 복구](crawler/README.md#검증-가격-수집과-일회성-백필)

0016은 기존 Worker의 쓰기와 이력을 유지합니다. 기존 조회 인덱스의 이름과 정렬 키는 보존하며, 구형 Worker의 정정·철회 SQL을 workerd에서 실행할 수 있도록 인덱스 필터를 게시 상태로 단순화했습니다. 기존 `7f8d7d8` Worker는 마이그레이션 뒤에도 기존 공개 조건으로 읽으므로 이 버전으로 돌아가면 가격 미확인 공구가 다시 공개될 수 있습니다. 전환 내내 비공개 조건을 유지하려면 먼저 기존 쓰기 경로를 가진 호환 Worker에서 공구 공개 조회를 빈 결과와 상세 404로 전환하세요. 기존 자동 배포의 홈페이지 HTML·JSON과 공구 JSON 확인을 통과한 호환 버전이 100% 트래픽을 받는 것을 확인한 다음 0016 릴리스를 진행합니다. 자동 배포 한 번의 폴링에서 두 변경이 함께 반영될 수 있으므로 병합 순서만으로는 이 전환이 성립하지 않습니다.

## 공동구매 자동 게시

Linux `agamajung-deepseek-web` 데몬은 공개 출처와 Instagram v2에서 받은 상품별 관찰을 수집합니다. 사이트는 인증된 `verified_offer_v2` 요청의 상품 ID와 공식 가격 승인을 확인하고, DeepSeek Flash와 Qwen4-Max Preview의 독립 판독을 검증합니다. 공구가·정가·마감일·구성·원문을 모두 확인한 상품은 검수자 조작 없이 기존 ingest와 promote 경로를 거쳐 모델 상세 및 공구 화면에 표시됩니다. 사이트 배포 일정과 개별 상품의 게시 시점은 독립적입니다.

보류된 상품은 `/admin`의 자동 게시 보류에서 원문, 확인 시각, 다음 확인 시각, `missing_official_coverage`, `missing_deadline`, `qwen_disagrees`, `source_unavailable` 등 확인이 필요한 조건을 볼 수 있습니다. 같은 상품이 재확인을 통과하면 보류 목록에서 빠집니다. 발행 후 증거가 달라지면 공개 가격 근거를 해제하고, 원문 종료나 마감 시각 경과는 유효한 근거가 있는 상품을 종료로 이동합니다. 공개 화면과 피드는 동일한 D1 공개 조건을 읽습니다.

`0017_verified_offers.sql`은 상품별 게시 이력과 요청 영수증을 추가합니다. `0018_play_gyms.sql`은 하베브릭스 바람개비 아기체육관과 Lovevery The Play Gym을 추가하며 두 모델의 국내 공식가는 확인 전까지 정보 없음으로 표시합니다. [하베브릭스 제품 페이지](https://m.whittlestore.com/views/shop/shopview?iniCategory=91&pack_content_id=4463&thisCategory=546) · [Lovevery 제품 페이지](https://lovevery.com/products/the-play-gym)

시간별 수집 및 비용 집계, Instagram 중단 경보와 재개 시각은 Linux 상태 디렉터리의 `metrics-hourly.jsonl`에서 확인합니다. [Linux 운영](crawler/deepseek-web/README.md#연속-수집과-게시)
