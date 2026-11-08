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
| `memory.json` | v2: `cycle`(틱별 예산)·`lifetime`(누적)·`observed_urls`/`pending_urls` |
| `cycle-audit.jsonl` | 틱 종료 시 cycle↔lifetime 감사 로그 (기존 파일 이어쓰기) |
| `outcomes.jsonl` | 추출·차단·중복·리스팅 enqueue 등 zero/부분 결과 사유 |
| `review-queue.jsonl` | `pending` 검수 큐 |
| `heartbeat.json` | 최신 하트비트 (`collection_status`, `halt_reason`, `heartbeat_fresh`는 **쓰기 시점** 기준) |
| `validation-artifact.json` | 마지막 틱 스냅샷 — `heartbeat_fresh=true`만으로 **현재 라이브 상태를 증명하지 않음** |
| `proposals/*.json` | 파서 수정 제안 |

**예산(하드 캡 유지):** `config.json`의 `budget.max_tokens_per_run`(기본 32k)과 `max_requests_per_run`은 **daemon 틱마다** `cycle`에만 적용된다. `lifetime`은 감사용 누적이며 캡을 다시 소진하지 않는다. v1 `memory.json`의 `token_spent`/`requests_spent`는 마이그레이션 시 `lifetime`으로 이전되고, 다음 틱부터 `budget_tokens`로 영구 정지하지 않는다.

**09pangpang:** 검색·홈 리스팅 HTML은 모델 호출 없이 프리미엄/육아 카테고리 후보의 `/post/` URL을 `pending_urls`에 넣는다. `listing_discovery`는 URL별 정책 버전·마지막 시도를 기록한다. **마이그레이션·정책 버전 미기록 observed listing**은 한 번 listing fetch/discovery를 허용한다(누적 `lifetime`·`observed_urls` 유지). 캐드 내 재시도는 `listing_refresh_min_ms`(기본 10분). 그 외 observed listing은 모델·불필요 fetch 없이 `idle_dedup` / `halt_reason: dedup_observed_seed`로 보고한다(`blocked` 아님).

## 박스 업그레이드 (8214336 → 최신, state 보존)

```sh
cd /path/to/geunbon-baby
git fetch origin cursor/deepseek-web-collector-0251
git checkout cursor/deepseek-web-collector-0251
npm ci && npm run typecheck && npm test -- tests/deepseek-web-*.test.ts
# DEEPSEEK_WEB_STATE_DIR(또는 .local/deepseek-web) 삭제하지 말 것 — v1 memory 자동 마이그레이션
pm2 reload agamajung-deepseek-web --update-env
```

정상 틱 후 기대: `memory.json` `version: 2`, `cycle.token_spent`는 틱별, `lifetime.token_spent`는 누적, `collection_status`가 `budget_saturated`일 때 `halt_reason: budget_tokens`와 **해당 틱** `cycle_requests_spent: 0`이 함께 기록된다.

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
