# DeepSeek 공개 웹 전용 수집기 (아가마중)

Instagram·Threads **로그인/팔로/스크래핑 없음**. 기존 `PoliteFetcher`(robots·호스트 deny·속도 제한)만 사용하고, DeepSeek API(`DEEPSEEK_API_KEY`, 모델 `DEEPSEEK_MODEL`)로 공개 HTML에서 공구·가격 필드를 추출한다. 키는 박스 환경변수에만 둔다.

## 범위

- 유모차, 트립트랩/하이체어, 카시트, 플레이짐·모빌(예: 하베브릭스), 아기띠(예: 아티포페)
- 미확인 가격은 `"정보 없음"` (발명 금지)
- 파서 수정은 **제안 JSON만** `proposals/`에 기록 (`self_edit: false`). `crawler/lib/external/*` 및 규칙 파서는 런타임이 수정하지 않는다.

## 상태·출력

기본 디렉터리: `DEEPSEEK_WEB_STATE_DIR` 또는 `.local/deepseek-web/`

| 파일 | 설명 |
|------|------|
| `memory.json` | v5: `cycle`(틱별 예산)·`lifetime`(누적)·`observed_urls`/`pending_urls`·`gone_urls`(404/410 URL)·`fetch_retry_after`(호스트별 재시도 시각)·`rotation`(카테고리 공정 로테이션·공식 페이지 방문 기록) |
| `cycle-audit.jsonl` | 틱 종료 시 cycle↔lifetime 감사 로그 (기존 파일 이어쓰기) |
| `outcomes.jsonl` | 추출·차단·중복·리스팅 enqueue 등 zero/부분 결과 사유 |
| `review-queue.jsonl` | `pending` 검수 큐 |
| `heartbeat.json` | 최신 하트비트 (`collection_status`, `halt_reason`, `heartbeat_fresh`는 **쓰기 시점** 기준) |
| `validation-artifact.json` | 마지막 틱 스냅샷 — `heartbeat_fresh=true`만으로 **현재 라이브 상태를 증명하지 않음** |
| `proposals/*.json` | 파서 수정 제안 |

**예산과 수집 한도** — `budget.max_tokens_per_run`은 틱당 2,000,000토큰, `budget.max_requests_per_run`은 틱당 1,000회, `budget.max_completion_tokens`는 호출당 8,192토큰이다. `memory.max_queue_urls`는 5,000, `selection.max_pangpang_detail_per_cycle`은 200, `fetch.min_interval_ms`는 2,000이다. `lifetime`에는 감사용 누적 사용량을 기록한다. v1 `memory.json`의 `token_spent`와 `requests_spent`는 `lifetime`으로 이전된다.

공개 페이지의 404/410은 정규화된 URL을 `gone_urls`에 기록하고 대기열과 카테고리 정보에서 제거한다. 재발견·캐시 복구 시 해당 URL을 건너뛴다. 페이지 또는 robots.txt의 403/429는 응답 호스트의 유효한 `Retry-After`까지 요청을 보류하며, 헤더가 없거나 유효하지 않으면 응답 수신 시점부터 10분 뒤 재시도한다. robots.txt의 보류가 끝나면 같은 틱에서도 해당 origin의 다음 URL을 처리하기 전에 robots.txt를 다시 조회한다. robots.txt의 404/410은 페이지 접근을 허용한다. 다른 HTTP 오류와 요청·본문 타임아웃은 재시도 가능한 URL 결과로 기록한다. 실패한 URL은 모델을 호출하지 않으며 같은 틱에서 다음 URL을 처리한다.

**09pangpang:** 검색·홈 리스팅 HTML은 모델 호출 없이 **설정 범위(유모차·하이체어·카시트·플레이짐·아기띠)에 맞는** `/post/` 만 `pending_urls`에 넣는다. `/post/...?pid=&source=search` 추적 파라미터는 canonical 시 제거한다. `outcomes.jsonl`은 `raw_product_count`와 `scope_counts`를 분리 기록한다.

**실패 메커니즘(2026-11-08 육아템 검색 증거):** HTML 30카드인데 `productCount:0`이었던 이유는 listing용 `?pid=&source=search` 링크가 `canonicalUrl`에서 거부돼 파서가 전부 `policy_block` 처리했기 때문이며, 스코프 필터 문제가 아니었다. 수정 후 동일 fixture에서 `raw_product_count:30`, `scoped_candidate_count:0`(액세서리·광의 육아용품만) → `listing_scope_no_core` + 허용된 핵심 검색 URL 제안.

**근본템 카탈로그:** `crawler/deepseek-web/geunbon-catalog.json` — 카테고리·브랜드·별칭·공개 검색어. daemon은 `rotation.search_cursor`로 **카테고리별** `/search/r/` URL을 라운드로빈. 틱 리포트 `coverage`에 검색·listing·extracted·rotation·official 카운트. **v2(2026-11-12 검수 정밀화):** 각 상품에 `brand_aliases`(브랜드 토큰만)를 두고, 카탈로그 매칭은 **브랜드 토큰이 직접 보일 때만** 성립한다(아베크→Lovevery, 익싸 스위브→Nuna MIXX 같은 브랜드 무시 매핑 불가; 매칭 실패는 `null` 유지). 판매자 핸들 속 브랜드 단어(`@the_ergo_official`)나 `에르고`·`믹스` 같은 일반 명칭은 브랜드 증거가 아니며, listing 본문 텍스트는 브랜드 판단에서 제외해 카드 제목·카테고리만 식별에 쓴다. `category_rules`는 **중립 기본 블록리스트**다: `식품`, `생활가전`, `테크가전` 등 명시된 첫 세그먼트와 `키즈` 하위의 `장난감/완구`, `간식/베이커리` 등 리프만 거부하고(슬라임·가습온풍기·초콜릿 공구 제외), `유아용품`·`유모차`·`카시트`·빈 값은 중립으로 통과한다.

**09pangpang (운영):** `listing_discovery`는 URL별 정책 버전·마지막 시도를 기록한다. **마이그레이션·정책 버전 미기록 observed listing**은 한 번 listing fetch/discovery를 허용한다(누적 `lifetime`·`observed_urls` 유지). 캐드 내 재시도는 `listing_refresh_min_ms`(기본 10분). 그 외 observed listing은 모델·불필요 fetch 없이 `idle_dedup` / `halt_reason: dedup_observed_seed`로 보고한다(`blocked` 아님).

## 카테고리 로테이션과 공식 페이지 레인

**공정성:** `config.json`의 `selection.max_pages_per_cycle`(기본 12), `category_quota_per_cycle`(기본 1), `legacy_budget_per_cycle`(기본 1)로 틱 작업량을 제한한다. 순수 플래너 `rotation.ts`가 두 단계로 고른다.

1. **공식 방문:** due 공식 페이지를 카테고리 라운드로빈으로 가장 먼저 선택한다. 방문 전용·저빈도(기본 6시간)라 카탈로그 쿼터를 소비하지 않는다.
2. **혼합 로테이션:** 카테고리마다 틱당 최대 `category_quota_per_cycle`개의 pending 상세를 고르고, 작업이 없는 카테고리는 검색 1건을 고른다. 검색이 같은 로테이션 윈도우에 참여하므로 한 카테고리의 backlog가 모든 슬롯을 차지해 검색 전용 카테고리를 굶길 수 없다. 남은 pending은 다음 틱으로 넘어간다.
3. **Legacy:** `legacy_budget_per_cycle`을 예약하고 남는 슬롯은 미분류 작업에 쓴다. 시작점은 `rotation.legacy_cursor`로 회전해 한 URL이 예약 슬롯을 독점하지 못한다.

카테고리 순서는 `rotation.category_cursor`로 틱마다 회전한다. 매 틱 전체 pending 큐를 처리하지 않으며, 공정성 보장은 `categoryCap = max_pages_per_cycle - min(legacy_budget_per_cycle, legacy_work)`, `categoriesPerCycle = max(1, floor(categoryCap / category_quota_per_cycle))`, `N = ceil(C / min(categoriesPerCycle, categoryCap))`이다(예: 6개 카테고리, 2페이지, quota 1 → 3틱; 1페이지 → 6틱). 공식 방문이 예산을 모두 쓰는 틱은 이 N 계산에서 제외하고 다음 틱에 카테고리가 이어진다. 카테고리/쿼터/예산 정책이 바뀌면 `rotation.category_digest`가 달라져 커서만 초기화되고 `official_visits` 이력은 유지된다. 운영자 명시 URL과 `dry_run`은 플래너를 우회하며 커서를 전진시키지 않는다. `scope_categories`에서 제거된 카테고리의 pending 상세는 legacy 작업으로 취급해 큐에 영구히 남지 않는다.

**공식 페이지 레인(방문 전용):** `official_sources` 11건은 `seed/models.json`에서 파생했고 모두 `enabled:false`다. 활성화된 항목은 `SourceRegistryStore.decide()`가 허용할 때만 방문하며, 승인·시드·권한 변경은 하지 않는다. `PoliteFetcher`가 robots.txt를 실시간 확인하고, 리다이렉트를 포함한 **매 요청 직전**에 도메인 정책과 레지스트리 범위를 다시 검사한다. 방문 결과는 `official_visits`, `coverage.official`, `outcomes.jsonl`에 기록한다. HTML은 `candidateDecision`·모델 추출·추출 캐시·`pending_urls`/`observed_urls`로 절대 전달하지 않는다. 재방문 주기는 `official_recheck_ms`(기본 6시간)다. 공식 방문에도 404/410 제외와 403/429 호스트 보류를 적용하며, 다른 실패는 15분 뒤 재시도한다.

- D.THRONE는 `https://www.dthrone.com/102/?idx=58`의 `idx`를 `canonicalUrl`이 지원하지 않아 11건에서 제외했다.
- BabyBjörn URL은 레지스트리 경로 정규식이 요구하는 **끝 슬래시를 유지한 raw URL**로 fetch하고, 식별자 비교에만 슬래시가 제거된 `canonicalUrl`을 쓴다.
- `momcalendar.com`은 `prohibited_hosts`에 포함되어 공식 레인에서도 차단된다.

## 상태 보존 업그레이드

운영자는 아래 supervision 안내에 따라 절대 경로 state와 호스트 시크릿을 보존한다. v1 누적 예산과 v2/v3/v4 업무 상태는 v5로 이행한다. 상태 파일을 삭제해 재시작하지 않는다. 브랜치 전환·게시·운영 재시작은 이 구현 작업에서 수행하지 않는다.

**`once`·`daemon`은 `COLLECTOR_DB` 필수**(없거나 읽을 수 없으면 `collector_db_required` / `collector_db_unavailable` / `domain_state_unavailable`). 정책은 **fetch 직전·리다이렉트 후·모델 직전**마다 재확인한다.

- **호스트별 `domain_state.stopped`** (예: `momcalendar.com`): 해당 호스트·서브도메인·리다이렉트 목적지만 차단. 다른 허용 도메인은 계속 수집한다. DB를 수정/삭제하지 않는다.
- **전역 긴급 중단**: `collector_meta` id `deepseek_web:emergency_stop` 에 `{ "stopped": true, "reason": "..." }` 가 있을 때만 `once`/`daemon` 전체가 `emergency_stop`으로 즉시 실패한다.

## PM2 (Linux, 부모 런타임 활성화)

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
# 박스에서: export DEEPSEEK_API_KEY=...  (이 README/저장소에 넣지 말 것)
# 모델: export DEEPSEEK_MODEL=<박스에서 검증한 DeepSeek 모델 id>
# (기본 프로필 deepseek-flash; 활성화 전 아래 모델 프로필 이행 절차로 호스트에서 확인)
# 필수(once/daemon): export COLLECTOR_DB=/path/to/collector.sqlite

pm2 start crawler/deepseek-web.ecosystem.config.cjs
pm2 pid agamajung-deepseek-web          # 실제 PID 확인
pm2 logs agamajung-deepseek-web --lines 20

# 1회 오프라인 검증 (네트워크·API 없음)
DEEPSEEK_API_KEY=mock npm run deepseek-web -- dry-run

# 1회 실제 실행 (공개 GET + API — 운영자만)
# DEEPSEEK_API_KEY는 박스에만 설정
npm run deepseek-web -- once https://www.stokke.com/KOR/ko-kr/

# 중지
pm2 stop agamajung-deepseek-web

# 롤백(등록 해제)
pm2 delete agamajung-deepseek-web
```

출력 카운트·하트비트 freshness 확인:

```sh
cat .local/deepseek-web/validation-artifact.json
cat .local/deepseek-web/heartbeat.json
```

## 테스트

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm test -- tests/deepseek-web-*.test.ts
```

## 원격 브랜치 `dev-daemon/45-deepseek-web-harness-*`

GitHub에 해당 브랜치 아티팩트는 없었다. 본 패키지는 `main`의 공개 페치·검증 규칙을 재사용해 최소 복구 구현이다. dev-daemon `VERDICT` 파싱 이슈는 `tools/dev-daemon/stages.ts`의 기존 수정(#81)을 그대로 사용한다.

## Supervision, heartbeat and recovery (Linux only)

Scope assumption: this repair targets **`agamajung-deepseek-web`**. Repository entry points support that identity; the historical process name and exact cause of the November 9–10 outage have not been independently confirmed. `collector-scheduler.mjs` is the separate local scheduler, and `collector.mjs` is its review CLI. The scheduler/watchdog retains `autorestart: false`. `agamajung-crawler.service` starts Instagram and must not be reused for DeepSeek. No site/Cloudflare execution or IG/Threads automation is involved.

`crawler/deepseek-web.ecosystem.config.cjs` runs one fork, restarts unexpected exits after **60 seconds**, and has no watch or cron restart. `min_uptime: 120000` and `max_restarts: 20` bound repeated startup failures (the uptime window must exceed the restart delay). PM2 eventually leaves persistently failing startup in `errored`; an operator must fix storage/runtime/ownership and explicitly restart it. Collection initialization and API failures remain inside the daemon and retry without process churn. SIGTERM/SIGINT cancel waits and active requests; the 60-second shutdown allowance remains.

The following are **future host operations**, not actions performed by this task. Use the same dedicated Linux account, Node runtime, PM2 home and repository cwd at boot. Inject `COLLECTOR_DB`, `DEEPSEEK_API_KEY`, and optional existing model selection through the host secret mechanism. Do not print PM2 environment dumps or place credentials in config or command history. Use an absolute, private persistent state directory outside disposable checkouts:

```sh
export DEEPSEEK_WEB_STATE_DIR=/var/lib/agamajung/deepseek-web
# Operator provisions this directory for the dedicated account and injects secrets separately.
pm2 start crawler/deepseek-web.ecosystem.config.cjs
pm2 save
pm2 startup
# Follow PM2's generated service-install command for that account/runtime.
# After reboot, verify registration and actual heartbeat activity:
pm2 pid agamajung-deepseek-web
npm run deepseek-web -- status
```

Re-run `pm2 save` after intentional registration changes. The saved process list and host secret injection must survive reboot; registering an app without boot service setup does not provide boot recovery. Back up state together; do not delete `memory.json`, `backoff.json`, ownership DB or audit files to “fix” a failure. This task does not start/reload operational processes, configure boot services, or claim production recovery.

### Heartbeat contract

Path: **`${DEEPSEEK_WEB_STATE_DIR}/heartbeat.json`**, default **`<configured repository cwd>/.local/deepseek-web/heartbeat.json`**. Every owned cycle publishes a start and terminal snapshot, including DB/policy/emergency-stop/config/memory initialization failures. Writing requires writable safe storage and acquired writer ownership. If either fails, a fixed diagnostic is emitted, no model calls occur, and the prior heartbeat is preserved. Unknown historical totals and unread queue size are `null`.

Schema 2 retains the schema-1 cycle ID, PID/mode, `heartbeat_at`, effective `cycle_interval_ms`, KST ISO `cycle_started_at_kst`/`cycle_ended_at_kst` (`+09:00`), `outcome`/fixed `reason`, attempted/succeeded model calls, provider-reported token subtotal, complete token total or `null`, `usage_complete`, extraction/review counts, `backoff`, and `last_completed_cycle`. `items_extracted` counts normalized in-scope results before dedup; `items_sent_to_review` counts confirmed new appends. Legacy `extractions` still counts review appends; `review_pending` is queue size. Existing report budget/coverage/listing/proposal/block fields retain their normal meanings.

`validation-artifact.json` shares the terminal snapshot's cycle ID and retains `profile`, `validated_at`, and warning fields. Each file uses private temporary files, fsync, rename and directory fsync; the two replacements are not simultaneous. Unsafe paths/symlinks are rejected. Deprecated `heartbeat_fresh`/`heartbeat_age_ms` describe write time only.

Recovery preserves a killed running cycle as `interrupted`, with actual end time **unknown**, a separate `interruption_observed_at_kst`, and `counts_complete: false`. Durable counters may undercount work performed immediately before a kill. `last_completed_cycle` retains the prior terminal summary while the next cycle runs. Waiting on backoff does **not** refresh cycle timestamps.

### Model backoff and accounting

Only typed **DeepSeek model API** HTTP 402/429 triggers persisted backoff, never public-source 429. `backoff.json` holds schema, allowlisted reason/status, consecutive failure count, failure time and deadline. Delays are **1h → 2h → 4h → 6h → 6h…**, including mixed 402/429 sequences. The first qualifying error stops further model calls. The daemon stays alive, waits until the deadline, then retries automatically. `once` returns immediately during backoff without opening the collector DB or making requests. Restarting preserves the deadline.

A successful completion response clears the sequence durably before more model work, even if later parsing/enqueueing fails. No-call policy/DB/emergency-stop/budget/empty/dedup cycles and other network/model failures neither increment nor clear it. An expired deadline with no call waits one normal interval; there is no busy loop. Current-cycle `reason` and unresolved `backoff` are separate. Corrupt or unwritable control state fails closed and retries initialization at normal cadence.

`memory.json` **v5** is the accounting checkpoint. It persists cycle/call intent before invocation, checkpoints acknowledged usage together with a bounded validated result receipt before cache promotion or review appends, and stores a terminal checkpoint. One atomic replacement folds lifetime totals, sets `finalized_cycle_id`, retains a terminal summary/pending audit row, and clears the active budget. Recovery finishes the pending `cycle-audit.jsonl` append once, verifies duplicate IDs/content, repairs only a matching incomplete trailing append, fsyncs, and clears the intent before another cycle. Conflicting audit rows fail closed. v1 totals and v2 business state are retained; nonzero v2 active counters require matching existing audit/lifetime totals or explicit reconciliation.

Missing, negative, fractional or unreported token counts are unknown, never zero. Totals may be explicitly derived from both valid components. `deepseek_tokens_reported` is the known subtotal; `deepseek_tokens_used` is `null` if any call lacks accounting. A successful response with unknown usage keeps its reservation and stops the cycle with `usage_unknown`; reservations are not billed totals. A response lost before its durable settlement cannot prove exact provider billing. In-flight uncertainty survives recovery. Cap values, admission/reservation arithmetic and known-usage settlement rules remain unchanged; caps are per cycle and lifetime totals are cumulative audit values. The separate collector cost ledger is unchanged.

`writer-ownership.sqlite` is separate from `COLLECTOR_DB`, with a singleton record protected by short `BEGIN IMMEDIATE` transactions. Daemon ownership lasts through waits/backoff. PID, Linux start ticks, boot ID, acquisition time and random token identify the writer. Proven dead/reused-PID/previous-boot/repeatedly verified zombie owners become reclaimable after **30 seconds**; unverifiable, malformed, future-dated or permission-denied owners fail closed. Release matches only the caller token. Concurrent `once` returns `writer_busy`, or a read-only backoff report if a valid deadline is active, without overwriting the daemon's heartbeat. Never manually delete the ownership record while a writer might be alive.

Dry-run uses a newly created temporary directory by default and ignores the operational state override. An explicit test state directory is supported but cannot equal the configured operational directory. It cannot clear operational backoff or overwrite the operational heartbeat.

### Read-only status

```sh
npm run deepseek-web -- status
npm run deepseek-web -- status --json
```

Status dispatch precedes runner/store initialization: no database, queue, writer ownership, directory creation, writes or network calls. Credentials and `COLLECTOR_DB` are unnecessary; a read-only state directory works. It reads the heartbeat and timing environment only.

Freshness is `now - heartbeat_at > 2 * cycle_interval_ms`. Exactly two intervals is fresh; default ten-minute cadence becomes stale at twenty minutes plus 1ms. The saved interval defines freshness. The expected `DEEPSEEK_WEB_DAEMON_MS` (default `600000`, integer `1000..86400000`) is separately compared and `interval_mismatch` reports both; there is no competing 15-minute freshness setting. Invalid schema/required fields/timestamps, future snapshots, unknown interval, legacy snapshots, missing/corrupt/unreadable files report unknown freshness.

Exit codes: **0** fresh/valid/matching interval, **1** stale/valid/matching interval, **2** missing/invalid/unreadable/mismatched interval. Fresh activity can still have a failed outcome; long backoff can be both **stale** and **backoff scheduled**. Status reports KST times, outcome/reason, call/token/item counts, completeness and retry deadline.

### Offline acceptance

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm test -- tests/deepseek-web-*.test.ts tests/collector-run-lock.test.ts tests/collector-scheduler.test.ts tests/collector-watchdog.test.ts tests/source-registry-*.test.ts tests/external-robots.test.ts --maxWorkers=2
npm run lint
npm run typecheck
# Standalone Linux PM2 harness, isolated PM2_HOME/temp DB/state/logs, blocked network:
# Uses pm2 on PATH by default; optionally DEEPSEEK_TEST_PM2=/absolute/path/to/pm2
node --import tsx tests/helpers/deepseek-web-pm2-acceptance.mjs
```

The harness tests cycle updates, real SIGKILL/new PID with the production restart delay, singleton writer reclamation after grace, persisted backoff through restart, and read-only stale status. It starts/kills only its temporary PM2 daemon and deletes only its own temporary state. Unit/child-process tests inject clocks, clients and failures, including accounting/audit crash windows; they do not prove the historical outage's cause or operational installation health. Robots/ToS, momcalendar host/subdomain/redirect stops, source registry gates, privacy, emergency stop and review/publication rules are unchanged.


## Filtered Flash extraction and durable result reuse (Linux only)

The Linux collector owns URL discovery, canonical identity, scope filtering, cache state and human review. These changes do not add execution to Next.js/Cloudflare, alter D1/R2 or status-sync payloads, run the scheduler/Instagram worker, or publish deals.

The bounded work order is canonicalize/deduplicate → current domain/robots policy → fetch/revalidate → deterministic discovery and preparation → candidate decision → compatible result-cache lookup → current policy → budget admission on a miss → Flash → validate and checkpoint usage/result → cache promotion → idempotent review/proposal delivery. Detail URLs explicitly supplied or rediscovered are fetched again; `observed_urls`, `modeled_post_urls` and pending reviews are histories, not evidence of unchanged content. Listing cadence is retained. Budget denial leaves the miss pending while discovery and result-cache hits continue; emergency stop and scheduled model 402/429 backoff still stop work.

### Candidate and preparation contract

`candidate-filter.ts` version 3 requires a checked-in catalog product, an enabled category and group-buy evidence in one product region. Diapers/formula and accessory-only titles are excluded first. A detail page whose own status badge reads `종료`(또는 단독 `마감`)is rejected as `candidate_ended` before matching, evidence or any model call — a closed deal never reaches review. Source categories blocked by the catalog's `category_rules` blocklist are rejected as `candidate_excluded_category`, and catalog matching is brand-required (v2 above), so a seller handle or a generic line word alone can no longer map a product. The 09pangpang adapter requires its exact numeric post identity, one article and one identifying heading, plus seller/schedule fields or explicit group-buy text. Other HTML requires one product microdata region, article or main region with one identifying heading, and `공구`/`공동구매` wording in the title or an offer/schedule/conditions block. `공구 아님`, `공동구매 아님`, `공구 없음` invalidate their textual evidence. Ordinary retail discounts, navigation, recommendations, seller names and discovery hints cannot establish product identity. Price and end date may be missing.

No whole-document matching, rendering or OCR fallback is used. Rejections have fixed `candidate_*` codes, including `candidate_ended`, `candidate_empty`, `candidate_evidence_unavailable` and `candidate_preparation_limit`. Unsupported JavaScript/image evidence makes zero model calls. Offline positive and negative fixtures are in `tests/deepseek-web-cache.test.ts` and `tests/deepseek-web-review-precision.test.ts`.

`page-content.ts` uses the bounded HTML parser, removes scripts/forms/private/hidden and unrelated regions, and inspects privacy/injection lines before collapsing insignificant whitespace. Its immutable prepared text orders identity, source offer/schedule fields and description; raw date evidence is preserved. The source's own status badge (`text-status-*`) is read as `deal_status`(`종료`/단독 `마감` → `ended`, `예정` → `scheduled`, `오픈` → `open`; 텍스트로 분류하고 클래스 접미사나 페이지 전체의 `마감` 문구는 신호가 아님)but never enters the prepared text, prompt or content hash — a pure badge flip reuses the cached result, and any content change re-prepares and re-decides. The 12,000-character cutoff happens once. `preparation_truncated` records limited extraction coverage. Changes only outside this text reuse the result when candidate eligibility is unchanged. Discovery catalog hints never enter the prompt, normalization or cache identity.

### Cache and conditional requests

`extraction-cache/entries/<cache_key>.json` stores bounded, versioned candidate proof, sanitized validated results, original extraction time and pending delivery information. Raw HTML and provider responses are never stored. `extraction-cache/urls/<url_contract_key>.json` records the latest observed representation, exact fetch URL, safe ETag/Last-Modified and separate revalidation time. There is no TTL/LRU eviction in this change.

- `content_hash`: SHA-256 of the exact UTF-8 prepared text sent to Flash.
- `contract_hash`: SHA-256 of stable serialized provider/profile/parameters, immutable instructions/schema, prompt/preparation/privacy/identity/filter/validation versions, catalog and scope configuration.
- `cache_key`: SHA-256 of stable serialized canonical final URL, content hash and contract hash.
- `url_contract_key`: SHA-256 of canonical URL, contract hash and the fixed HTTP request representation.

**2026-11-11 검수 정밀화 버전:** preparation 3, candidate filter 3, catalog 2. `contract_hash`가 세 버전과 카탈로그 전체를 직렬화에 포함하므로 추출 캐시 계약은 1회 전환되고, 관찰된 URL은 다음 틱에 한 번씩 다시 가져온다(검수 이력·인간 결정·라이브 상태는 불변). 종료 감지는 deepseek-web `preparePage`에만 있다. 공용 파서 `crawler/lib/external/pangpang.ts`(`PANGPANG_VERSION`)와 외부 파이프라인·pre-storage 검증은 변경하지 않는다 — 종료 리스팅 카드는 상세 fetch 후 모델 호출 전에 거부된다(`candidate_ended`, `outcomes.jsonl`의 기존 `candidate_rejected` 기록 사용).

An entry is fsynced before its pointer is published. Missing/stale indexes and well-formed dangling pointers use unconditional fetch plus hash lookup. Corrupt, unreadable, symlinked or identity-inconsistent state fails closed with `extraction_cache_unavailable`; do not delete state to conceal a failure. A fresh 200 invalidates the old reuse pointer before parsing/model work, so incomplete or ineligible replacements cannot leave stale conditional reuse enabled. Historical content remains addressable by hash; the URL pointer follows observation order.

Safe validators are transmitted unchanged only for a reusable result and its exact request URL. They never go to robots or any redirect destination. Cross-origin redirects remain refused. Compatible 304 responses reuse the result after current policy checks; an unusable 304 receives exactly one unconditional GET, then `source_response_invalid` if still unusable. A 200 always compares prepared content regardless of validator changes.

### Model profile migration and stable prefix

The checked-in `flash` profile selects provider ID `deepseek-flash`, disabled thinking, JSON-object output and an 8,192-token completion limit. `DEEPSEEK_MODEL` selects a configured profile ID, provider ID or approved alias. An unregistered override, including legacy `deepseek-chat`, fails with `deepseek_model_profile_unverified` before requests; it is never silently mapped to Flash.

Before operational activation, the operator must verify the target account/gateway's model ID and supported parameters using its provider documentation/model inventory and dashboard. Register that verified ID in `config.json` under `model.profiles` with a unique profile ID, explicit aliases, `thinking: {"type":"disabled"}` and the unchanged completion limit, then set the selector through the host environment. Keep secrets in the host secret mechanism. If an existing `deepseek-chat` override is present, replace it with a verified selector or register it only after the host confirms that exact alias serves the approved Flash profile. This implementation performs no live completion, operational restart or activation.

DeepSeek's public [Chat Completions documentation](https://api-docs.deepseek.com/api/create-chat-completion/) lists `deepseek-flash` and disabled thinking. That establishes the public API contract, not account/gateway availability. Claude Code model-catalog warnings do not validate or invalidate this direct HTTP integration and require no Claude Code configuration changes here.

Every request has the same immutable system instructions followed by immutable user schema/rules, canonical URL, then `untrusted_source_data` with the prepared text last. No cycle time, mutable hints, hashes or catalog dump enters the prefix. Provider [context caching](https://api-docs.deepseek.com/guides/kv_cache/) is best effort; the local result cache is what guarantees zero repeated calls after durable valid-result acknowledgement.

### Results, recovery and review

Only strictly schema-valid, privacy-safe results (including `in_scope:false`) enter the cache. Empty, malformed, truncated, schema-invalid and transport/HTTP failures remain retryable. Source URL and observation date are collector metadata. Acknowledged usage is settled even if validation fails.

Memory v5 holds one bounded pending-result receipt alongside the existing call/accounting checkpoint; it adds no billing ledger. Recovery under writer ownership promotes that receipt before beginning another cycle. The cache then owns pending delivery, and deferred pages return through current source/robots/candidate checks. Failure to promote blocks model work. Finalization preserves the receipt. A result lost before acknowledgement remains uncertain; exactly-once provider billing is not claimed.

Review rows carry content/contract hashes, deterministic delivery ID, predecessor, change reason and extraction/observation times. The same effective revision adds nothing. Cross-URL duplicate detection compares a normalized **offer key** (2026-11-12): catalog product id(없으면 브랜드+모델 정규화), 판매자 핸들(`@somda.park` / `somda.park` / `@somda.park (인스타그램)` 동일), 확인된 거래 창(없으면 공백 제거 period), 최상위 가격, 정렬된 번들 항목. Raw 모델명 문구·period 띄어쓰기·사은품 표현 차이만 다른 같은 오퍼는(하베브릭스 838368/845247/839301 3중 큐잉)하나로 합쳐진다; 항목 가격·옵션 변경은 여전히 별도 검수 행을 만든다. Changed content and historical-content returns append new pending transitions; approved/rejected and legacy rows remain intact. Pending counts resolve the latest revision per canonical URL. A valid out-of-scope transition after an existing deal is visible for human review. Proposals use cache key plus proposal-rule version, so delivery retries add no duplicate files. Nothing publishes or changes a human decision automatically.

### Cycle metrics and compatibility

Heartbeat schema 2, validation artifacts, audit snapshots and read-only status add `deepseek_prompt_cache_hit_tokens`, `deepseek_prompt_cache_miss_tokens`, `deepseek_completion_tokens`, `cache_usage_complete`, `extraction_cache_hits`, `extraction_cache_misses`, `candidate_pages_accepted` and `candidate_pages_rejected`. Provider cache-hit and cache-miss counts must be nonnegative safe integers summing to valid prompt tokens. Missing/inconsistent breakdowns are unknown (`null`); completion and existing total-usage completeness remain independent. Zero-call cycles report zero tokens. Local reuse does not add prior call usage, and provider-cached input still consumes the existing caps without a billing discount.

Schema-1 heartbeats and validated memory versions 1–4 remain readable. Missing historical metrics become unknown, including embedded active/terminal/last-cycle snapshots. Existing pending audit rows are replayed byte-for-byte without enrichment; totals and recovery controls remain authoritative. New diagnostics expose fixed codes for cache, receipt, profile, result, review, proposal and source-response failures, never raw exceptions or provider/cache contents.

The offline acceptance suite uses injected clients/responses/clocks and temporary state. SIGKILL tests cover acknowledgement, entry/index writes, review/proposal delivery, receipt clearing and prior accounting/audit windows. No operational queue edits or live API requests are part of verification.


## Checked facts and weekly review

All new results run the pure Linux `crawler/lib/deal-fact-check.ts` pass against the
exact bounded `preparePage().text` supplied to Flash. Text beyond `PAGE_TEXT_LIMIT`,
model quotations/notes and discovery hints cannot verify facts. Normalized, complete
monetary tokens support safe integer KRW amounts; missing, mismatched, ambiguous or
invalid facts become actual JSON nulls. The checker does not replace a failed amount,
sum components or calculate a discount. Regular prices remain seller evidence and
never establish official MSRP authority.

Checked dates retain written year/month/day and day/hour/minute/second precision.
Yearless dates keep `year:null`. A year can propagate only across an unambiguous
written range, and an unsupported model year fails. Independently verified endpoints
survive a mismatch in the other endpoint. Contradictory ranges retain a diagnostic
quote and null schedules. The existing Instagram `extractDates` year-roll behavior
is separate and unchanged.

`deal-facts@1` / checked schema 1 records source URL, exact-text SHA-256, observation
instant, KST observation year, truncation, and bounded sanitized quotations with
UTF-16 offsets into that exact text. Every field has a value or a fixed failure
reason (`missing`, `not_found`, `ambiguous`, `invalid`, `contradictory_range`). A valid
envelope records that checking ran even when all fields are null. Source HTML and
provider responses are never included. Receipt/cache limits remain 48,000 bytes.

Raw validation precedes checking, checked validation and proposal construction,
then receipt version 2 is assigned and checkpointed with acknowledged usage. Cache
entry version 2 is required for reuse/304, proposals and checked review delivery.
Contract hashes include the checker/schema/interpretation versions. Memory v4 accepts
both receipt versions through separate original/checked validators. Recovery validates
the durable receipt; it does not re-run source verification without source text.

Version-1 entries/receipts remain readable and recoverable with accounting intact.
They cannot supply checked cache hits, conditional reuse or new review/proposal
outputs. An authorized revisit requires a fresh fetch and model call. Existing review
rows and human decisions remain untouched; read projections expose null facts and
`needs_fact_check`. Substantive comparison uses checked amounts/date components and
precision, including checked-versus-legacy status, without raw period wording or
quotation formatting. Source-content transitions and historical returns retain their
revision provenance and delivery IDs.

```sh
npm run deepseek-web -- weekly-review
npm run deepseek-web -- weekly-review --json
```

This command reads one validated `review-queue.jsonl` snapshot before runner/runtime
initialization. It needs no credentials, SQLite, writer ownership, writable state,
network, model, recovery or delivery operations. A missing queue is an empty packet
without directory creation; corrupt/incomplete JSONL fails without repair or partial
output. Exit 0 includes an empty packet; exit 2 uses `weekly_review_invalid_arguments`
or `weekly_review_unavailable`.

The packet captures one generation clock and uses Monday 00:00 KST through next
Monday exclusively. It resolves the latest revision per canonical URL first, omits
approved/rejected/out-of-scope revisions, and excludes `future_week` starts or `ended`
deadlines even when another fact is missing. Open-ended starts older than seven KST
calendar days remain reviewable with `possibly_ended`. Date-only ends remain valid
through their KST day, and explicit times expire once passed. Yearless screening uses
the recorded observation year without changing facts; cross-year and adjacent-year
December/January interpretations produce `year_ambiguous` and cannot screen on their
uncertain endpoints. Eligibility ages on every invocation without a model call.

JSON and human output include the captured time/week bounds, checked facts, missing
fields, warnings, exclusions, unique excluded-record counts, overlapping reason counts,
and separate decision/out-of-scope omissions. Legacy facts are never described as
rechecked. The existing October sample-page/mock-completion pair verifies positively
but is excluded as ended against the November 10 acceptance clock.

Manual `scripts/promote-external.mjs --from-review-queue=...` passes checked price and
schedule values, including explicit nulls, to candidate ingest and promotion using
only the exact ingest acknowledgement ID. Yearless or legacy facts promote as null.
Fully dated facts without a source time map to KST start-of-day or inclusive end-of-day
(`23:59:59.999`); local evidence retains original precision. Omitted promotion dates
keep candidate fallback, null clears it, valid timestamps replace it, and invalid
supplied values fail. A cleared candidate deadline cannot drive date-derived
`source_ended`. Publication remains an explicitly invoked human operation.

New offline regression suites: `deal-fact-check`, `deepseek-web-weekly-review`,
`external-checked-facts`, `review-promotion-facts`, plus the cache/recovery and
promotion/API suites. The weekly subprocess guard forbids runtime/cache/store loading,
network and state writes, and compares directory entries and queue bytes. The daemon
owns execution of these suites and repository validation/build checks.

## Verified deal prices

With `DEAL_PRICE_VERIFICATION=1`, the Linux runner verifies prices alongside metadata delivery. It captures the product region once, filters it for privacy, then sends the same bounded text independently to direct DeepSeek Flash and `qwen4-max-preview`. Price, deadline precision, and configuration must be present in the corresponding labeled source spans. The regular list price requires a separate authorized product page and two independent readings of that page. Usage settlement covers every attempted completion, including unusable output after a successful response. The workflow retains fixed outcomes and filtered evidence.

An official comparison requires one matching `price_variants` entry for an enabled product page. Each entry has a variant ID, catalog ID, exact configuration and optional source-visible SKUs. The catalog supplies brand and model aliases. Selected option rows and product headings must support the configuration and the whole-item price. Match the actual product path against the manufacturer/importer registry rules and approve the `official_msrp` field for that scope and expiry. The eleven existing configured official sources start disabled. Authorization is checked before every comparison fetch and every redirected request. Cache reuse requires a current authorized fetch and matching approval, verifier, model IDs, and source URLs and hashes.

Price sidecars bind to the queue revision and its prepared source hash. The manual promotion CLI accepts the current queue line and rechecks the official approval against `COLLECTOR_DB` before sending its evidence and before promotion. Regenerate older sidecars under the current verifier. For manual promotion by candidate ID, pass the reviewed ID with `--price-evidence-id` and its revision with `--expected-revision`. After changing official-source approval, sync the current registry scopes to the site. [Price-source synchronization](../README.md#검증-가격-수집과-일회성-백필)

With `AGAMAJUNG_API_URL` and `INGEST_TOKEN` configured, scheduled price-verification runs reserve one page slot to revisit an approved external offer, including archived offers and offers awaiting initial or replacement proof. The runner rotates through site targets, checks domain and robots policy, and stores a six-hour revisit deadline by default. The official page is checked even when the offer is unchanged. The site can renew unchanged facts, stage new observations, and invalidate other deals that depend on a contradicted official comparison. An explicit closure on an otherwise identical capture moves the deal to the archive using its last verified comparison. The site keeps observation revisions and still requires human review for changed prices, deadlines, or configurations.

Alibaba documents the Singapore Token Plan endpoint and `qwen4-max-preview` for interactive coding tools. The Linux host owner must verify account availability and permission for automated use before activation. The Qwen credential is read at runtime on Linux. No credential or raw provider response belongs in the sidecar. [Qwen model configuration](https://www.alibabacloud.com/help/en/model-studio/qwen-code)

Missing official coverage and price disagreements are review outcomes. A retryable provider failure retains the last evidence and leaves the source available for a later cycle, subject to existing request and token caps. Recover with the same state directory and current source approvals. Public-web collection blocks social domains. Threads uses an exact-permalink adapter with its own registry approval and live access check. [Threads and backfill operations](../README.md#검증-가격-수집과-일회성-백필)

The checked-in registry contains no approved comparison configurations. The configured product pages currently awaiting an exact variant mapping and authority are listed below. The synchronization command reports any remaining entries individually after mappings are configured.

- `stokke-tripp-trapp-1001`
- `stokke-tripp-trapp-4952`
- `stokke-tripp-trapp-newborn-complete`
- `stokke-yoyo3-frame-last-chance`
- `bugaboo-fox-5-renew`
- `bugaboo-butterfly-2`
- `babybjorn-bouncer-bliss`
- `babybjorn-bouncer-balance-soft`
- `babybjorn-carrier-harmony`
- `babybjorn-carrier-one-air`
- `babybjorn-carrier-mini`
