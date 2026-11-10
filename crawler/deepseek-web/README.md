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
| `memory.json` | v3: `cycle`(틱별 예산)·`lifetime`(누적)·`observed_urls`/`pending_urls` |
| `cycle-audit.jsonl` | 틱 종료 시 cycle↔lifetime 감사 로그 (기존 파일 이어쓰기) |
| `outcomes.jsonl` | 추출·차단·중복·리스팅 enqueue 등 zero/부분 결과 사유 |
| `review-queue.jsonl` | `pending` 검수 큐 |
| `heartbeat.json` | 최신 하트비트 (`collection_status`, `halt_reason`, `heartbeat_fresh`는 **쓰기 시점** 기준) |
| `validation-artifact.json` | 마지막 틱 스냅샷 — `heartbeat_fresh=true`만으로 **현재 라이브 상태를 증명하지 않음** |
| `proposals/*.json` | 파서 수정 제안 |

**예산(하드 캡 유지):** `config.json`의 `budget.max_tokens_per_run`(기본 32k)과 `max_requests_per_run`은 **daemon 틱마다** `cycle`에만 적용된다. `lifetime`은 감사용 누적이며 캡을 다시 소진하지 않는다. v1 `memory.json`의 `token_spent`/`requests_spent`는 마이그레이션 시 `lifetime`으로 이전되고, 다음 틱부터 `budget_tokens`로 영구 정지하지 않는다.

**09pangpang:** 검색·홈 리스팅 HTML은 모델 호출 없이 **설정 범위(유모차·하이체어·카시트·플레이짐·아기띠)에 맞는** `/post/` 만 `pending_urls`에 넣는다. `/post/...?pid=&source=search` 추적 파라미터는 canonical 시 제거한다. `outcomes.jsonl`은 `raw_product_count`와 `scope_counts`를 분리 기록한다.

**실패 메커니즘(2026-11-08 육아템 검색 증거):** HTML 30카드인데 `productCount:0`이었던 이유는 listing용 `?pid=&source=search` 링크가 `canonicalUrl`에서 거부돼 파서가 전부 `policy_block` 처리했기 때문이며, 스코프 필터 문제가 아니었다. 수정 후 동일 fixture에서 `raw_product_count:30`, `scoped_candidate_count:0`(액세서리·광의 육아용품만) → `listing_scope_no_core` + 허용된 핵심 검색 URL 제안.

**근본템 카탈로그:** `crawler/deepseek-web/geunbon-catalog.json` — 카테고리·브랜드·별칭·공개 검색어. daemon은 `catalog_search_cursor`로 `/search/r/` URL을 라운드로빈. 틱 리포트 `coverage`에 검색·listing·extracted 카운트.

**09pangpang (운영):** `listing_discovery`는 URL별 정책 버전·마지막 시도를 기록한다. **마이그레이션·정책 버전 미기록 observed listing**은 한 번 listing fetch/discovery를 허용한다(누적 `lifetime`·`observed_urls` 유지). 캐드 내 재시도는 `listing_refresh_min_ms`(기본 10분). 그 외 observed listing은 모델·불필요 fetch 없이 `idle_dedup` / `halt_reason: dedup_observed_seed`로 보고한다(`blocked` 아님).

## 상태 보존 업그레이드

운영자는 아래 supervision 안내에 따라 절대 경로 state와 호스트 시크릿을 보존한다. v1 누적 예산과 v2 업무 상태는 v3로 이행한다. 상태 파일을 삭제해 재시작하지 않는다. 브랜치 전환·게시·운영 재시작은 이 구현 작업에서 수행하지 않는다.

**`once`·`daemon`은 `COLLECTOR_DB` 필수**(없거나 읽을 수 없으면 `collector_db_required` / `collector_db_unavailable` / `domain_state_unavailable`). 정책은 **fetch 직전·리다이렉트 후·모델 직전**마다 재확인한다.

- **호스트별 `domain_state.stopped`** (예: `momcalendar.com`): 해당 호스트·서브도메인·리다이렉트 목적지만 차단. 다른 허용 도메인은 계속 수집한다. DB를 수정/삭제하지 않는다.
- **전역 긴급 중단**: `collector_meta` id `deepseek_web:emergency_stop` 에 `{ "stopped": true, "reason": "..." }` 가 있을 때만 `once`/`daemon` 전체가 `emergency_stop`으로 즉시 실패한다.

## PM2 (Linux, 부모 런타임 활성화)

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
# 박스에서: export DEEPSEEK_API_KEY=...  (이 README/저장소에 넣지 말 것)
# 모델: export DEEPSEEK_MODEL=<박스에서 검증한 DeepSeek 모델 id>
# (미설정 시 코드 기본값 deepseek-chat — Flash/Reasoner 여부는 박스에서 문서·대시보드로 확인 후 설정)
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

Schema 1 adds cycle ID, PID/mode, `heartbeat_at`, effective `cycle_interval_ms`, KST ISO `cycle_started_at_kst`/`cycle_ended_at_kst` (`+09:00`), `outcome`/fixed `reason`, attempted/succeeded model calls, provider-reported token subtotal, complete token total or `null`, `usage_complete`, extraction/review counts, `backoff`, and `last_completed_cycle`. `items_extracted` counts normalized in-scope results before dedup; `items_sent_to_review` counts confirmed new appends. Legacy `extractions` still counts review appends; `review_pending` is queue size. Existing report budget/coverage/listing/proposal/block fields retain their normal meanings.

`validation-artifact.json` shares the terminal snapshot's cycle ID and retains `profile`, `validated_at`, and warning fields. Each file uses private temporary files, fsync, rename and directory fsync; the two replacements are not simultaneous. Unsafe paths/symlinks are rejected. Deprecated `heartbeat_fresh`/`heartbeat_age_ms` describe write time only.

Recovery preserves a killed running cycle as `interrupted`, with actual end time **unknown**, a separate `interruption_observed_at_kst`, and `counts_complete: false`. Durable counters may undercount work performed immediately before a kill. `last_completed_cycle` retains the prior terminal summary while the next cycle runs. Waiting on backoff does **not** refresh cycle timestamps.

### Model backoff and accounting

Only typed **DeepSeek model API** HTTP 402/429 triggers persisted backoff, never public-source 429. `backoff.json` holds schema, allowlisted reason/status, consecutive failure count, failure time and deadline. Delays are **1h → 2h → 4h → 6h → 6h…**, including mixed 402/429 sequences. The first qualifying error stops further model calls. The daemon stays alive, waits until the deadline, then retries automatically. `once` returns immediately during backoff without opening the collector DB or making requests. Restarting preserves the deadline.

A successful completion response clears the sequence durably before more model work, even if later parsing/enqueueing fails. No-call policy/DB/emergency-stop/budget/empty/dedup cycles and other network/model failures neither increment nor clear it. An expired deadline with no call waits one normal interval; there is no busy loop. Current-cycle `reason` and unresolved `backoff` are separate. Corrupt or unwritable control state fails closed and retries initialization at normal cadence.

`memory.json` **v3** is the accounting checkpoint. It persists cycle/call intent before invocation, settles acknowledged usage before parsing or review appends, and stores a terminal checkpoint. One atomic replacement folds lifetime totals, sets `finalized_cycle_id`, retains a terminal summary/pending audit row, and clears the active budget. Recovery finishes the pending `cycle-audit.jsonl` append once, verifies duplicate IDs/content, repairs only a matching incomplete trailing append, fsyncs, and clears the intent before another cycle. Conflicting audit rows fail closed. v1 totals and v2 business state are retained; nonzero v2 active counters require matching existing audit/lifetime totals or explicit reconciliation.

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
