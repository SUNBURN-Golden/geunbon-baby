# 04 · Daemon 역할과 실패 후 재개

[원장](03-fact-metadata-and-history.md) · 다음: [소스 레지스트리](05-source-registry.md)

## 실행·수집 식별

스케줄러가 예약 슬롯별 `collection_runs(id=UUID, scheduled_for, started_at, data)`를 먼저 만든다. `(worker_id, scheduled_for, schedule_kind)`의 예약 키는 유일하게 만들어 같은 슬롯의 중복 run을 막는다. 같은 run의 재시도·실패 후 재개는 **같은 run_id**를 사용하고 다음 예약 슬롯은 새 run_id다.

`capture_id = H(run_id, source_id, url_norm)`이며 URL 정규화 버전과 원래 URL의 안전한 매핑을 기록한다. 콘텐츠 해시는 수집·이벤트 멱등성 키가 아니라 `content_hash + extractor@version` 추출 결과 캐시 키다. 변경 이벤트 키는 **capture_id**다. A→B→A→B에서 두 번째 A/B 이벤트도 잃지 않는다.

Capture는 불변인 한 번의 완료 결과다. HTTP 재시도 등 미완료 시도는 `fetch_attempts(run_id, capture_id, attempt, status, at)`로 따로 남기고 성공 또는 terminal 결과 확정 때만 capture를 기록한다. 403·로그인·CAPTCHA는 terminal blocked이며 재시도하지 않는다. terminal 오류 capture를 성공 내용으로 덮어쓰지 않는다. 재개는 저장된 capture를 재사용하고, 아직 성공 capture가 없는 재시도 가능 단계만 제한 안에서 다시 요청한다. 상한 소진 후 운영자가 재수집을 승인하면 연결된 새 run을 생성한다.

## 역할별 계약

모든 체크포인트는 로컬 SQLite에 있으며 파일 시스템 raw 저장을 참조만 한다. 각 stage의 출력과 완료 체크포인트를 한 트랜잭션으로 확정한다.

| 역할 | 입력 | 출력 | 멱등성 키 | 체크포인트 위치 |
| --- | --- | --- | --- | --- |
| 소스 발견 | 권한·활성 상태가 유효한 레지스트리 entries | 후보 URL 집합 | source_id + url_norm(집합 등록), 실행은 run_id 포함 | `stage_checkpoints(run_id,discover,key)`·현행 collection_jobs |
| 증분 수집 | 후보·재확인 기한·권한 버전 | captures + 허가된 raw 참조 | capture_id | captures, fetch_attempts, domain_state, daily_budgets |
| 변경 감지 | capture와 동일 source_id/url_norm의 직전 성공 capture | changed/unchanged 결과, 변경 이벤트 | capture_id(결과 1건, 최초 기준선은 change event 아님) | `stage_checkpoints`, `change_events` |
| 정보 추출 | changed capture 또는 최초 capture | source_claim/unverified fact 후보, AI는 ai_inference | 캐시 content_hash+extractor@ver, fact ID에는 capture_id 포함 | `extraction_results`, `stage_checkpoints` |
| 동일 대상 식별 | 단서·aliases·model-families | subject_id 후보, 모호하면 검수 | fact_id + resolver@ver | `resolution_events`, `stage_checkpoints` |
| 근거 검증 | 후보·원문 위치·레지스트리 필드 권한 | 검수 큐, 사람 승인 시 별도 verified fact | fact_id + review_event_id | review_events·검수 큐·stage_checkpoints |
| 관측 기록 | 성공 capture + 새/캐시 추출 결과 | observations. 같은 내용도 capture별 한 건 | offer_revision_id + capture_id | observations·stage_checkpoints |
| 상태·이력 갱신 | 새 verified fact 또는 검증된 시간 이벤트 | 가격 구간·revision·twin 전이 | fact_id + transition_kind(타이머는 fact_id+deadline) | twin_states·stage_checkpoints |
| 서비스 결과 재계산 | 검증 원장·상태·기간·재확인 정책 | Q1~Q6 로컬 projection | as_of + 입력 digest + projection@ver | projection_runs |
| 품질 점검 | 원장·레지스트리·단계 결과 | stale·상충·고아·partial·실패 보고 | run_id + quality@ver | quality_reports |

정보 추출 → 대상 식별 → 근거 검증은 논리 순서다. 사람 검수가 지연되어도 source_claim 관측은 기록한다. 이 관측만으로 현재 verified 가격·상태 구간을 바꾸지 않는다. 검수 결과가 늦게 오면 [03의 과거 관측 규칙](03-fact-metadata-and-history.md)을 적용한다.

본문이 unchanged이면 다시 추출하지 않고 캐시 결과를 해당 capture에 재결합한다. 새 Observation과 근거 참조는 남긴다. `last_confirmed_at` 갱신은 동일 값·동일 revision·성공 관측이며 기존 검수 범위에 드는 경우만 가능하다. 차단 화면·빈 본문·추출기 버전 변경·구성 미확인은 동일 확인으로 취급하지 않는다. 기존 fact_status를 observation 열에서 UPDATE하지 않는다.

## 공통 운영 요건

- 현행 DB `.lock`의 `wx` 생성과 `BEGIN IMMEDIATE`를 유지한다. 현재 serve/discover/sync는 같은 DB를 순차 사용한다. stage lease `job_leases(stage, run_id, key, owner, expires_at)`를 추가하되 DB 단일 실행 제한을 임의로 없애지 않는다. 만료 lease를 회수할 때 체크포인트를 먼저 확인한다. stale 파일 락은 운영자가 이전 프로세스 종료를 확인한 뒤 해제한다.
- `stage_checkpoints`에는 입력 digest·정책/추출기 버전·출력 ID·phase·attempts·error_code·다음 실행 가능 시각을 기록한다. 입력 버전이 달라지면 새 stage 작업을 만든다. 성공 stage를 되돌리지 않고 실패한 stage부터 재개한다.
- 재시도 기본안은 최초 포함 최대 3회, 지수 backoff다. 현행 failure_backoff_ms=300000을 하한으로 삼고 429/5xx는 Retry-After 및 최소 60초 냉각 중 더 긴 값을 따른다. 403·CAPTCHA·로그인·권한 거부는 재시도하지 않고 소스를 중단한다.
- 상한 소진은 `failed_jobs(run_id, stage, key, code, attempts)`로 보내고 다음 단계 입력으로 쓰지 않는다. 같은 run 재개가 횟수·예산을 초기화해서는 안 된다.
- 현행 KST 일별·브랜드별 예산은 발견 500, 새 본문 200, 재확인 200이다. 요청 전 예약, 성공/실패 시 정산을 유지한다. 전체 run 상한·원문 저장량 상한도 둔다. 도메인 최소 간격 5000ms, max_depth=2, max_bytes=2097152, max_pages=20을 기본 상한으로 유지한다.
- AI는 기본 비활성화·예산 0. 활성화 결정 시 일·월 금액 및 호출/토큰 상한을 요청 전에 예약하고 재시도 비용도 포함한다. 초과는 중단·보고하며 확정 값을 만들지 않는다.
- 개인정보 필터를 저장 전·AI 전 두 번 적용하고 자료는 `untrusted_source_data`로 격리한다. 원문의 지시는 실행 명령·검증 승격·게시 권한이 아니다.

## 현행에서의 이행 경로

[실제 worker](../../crawler/src/local-worker.ts)는 `serve/discover/sync`, [CLI](../../crawler/collector.mjs)는 `src/cli.ts`를 사용한다. 요청서의 `crawler/local-worker.mjs`는 없다. [store](../../crawler/src/store.ts)의 collection_jobs·예약·daily_budgets·domain_state·review_events·sync_outbox를 보존하면서 1) run/capture/단계 체크포인트, 2) 추출·식별·검증, 3) observation/twin/projection 순으로 확장한다. 기존 collection_jobs는 새 run/stage 키에 연결하고 backfill은 재실행 가능하게 한다.

[pm2 설정](../../crawler/ecosystem.config.cjs)의 체크인 앱은 Instagram `agamajung-crawler` 하나다. `agamajung-local-worker`·`agamajung-discover`는 저장소 밖 관리 대상으로 이름만 요청에 등장하며 운영 등록 여부는 확인되지 않았다. 체크인 여부는 README 열린 질문 2다. Instagram은 별도 프로세스이고 필수 **단서 → 검수** 경로로만 연결한다. 사이트 건수 sync의 outbox 계약과 본문 비전송 경계는 유지한다.

## WU-05/06 필수 검증

| 시나리오 | 기대 결과 |
| --- | --- |
| 같은 본문 다음 날 재확인 | capture 2, observation 2, change event 0, 추출 1회. last_confirmed_at 전진 |
| 네 run에서 A→B→A→B | capture 4, observation 4, change event 3. 각 변경을 검수하면 가격 구간 4개, 닫힌 구간 3개. 추출 캐시는 A/B 각 1회 가능 |
| capture 후 observation 직전 강제 실패 → 같은 run 재개 | capture 1, observation 1, 재요청 0 |
| 같은 run 동시 시작 | 예약 키·락·lease로 한 실행만 출력 확정 |
| 같은 run에서 같은 관측 재삽입 | 전체 행 동일이면 no-op, 다른 열/내용이면 capture_conflict |
| 재시도 상한·예산 초과 | 실패 단계·누적 attempts 유지. 이전 성공 stage 재실행 없음 |
