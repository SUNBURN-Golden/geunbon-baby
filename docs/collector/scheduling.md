# Linux 수집 일정

## 운영 호스트의 PM2 cron

운영 인벤토리는 [`crawler/ecosystem.all.config.cjs`](../../crawler/ecosystem.all.config.cjs)이며 PM2 데몬의 시간대는 Asia/Seoul입니다. discover는 09:20·15:20·21:20, collect는 09:40·15:40·21:40, discover-sources는 10:05, backfill-engine은 03:30에 시작합니다. 수집 스케줄과 출처 활성화는 각각 설정합니다.

설치된 PM2는 cron 재시작에도 `autostart`를 적용합니다. 예약 앱은 `autostart: true`, `autorestart: false`로 등록하며 자식의 시간 확인이 예약 시각과 다음 1분에만 실행을 허용합니다. 등록이나 부활이 예약 시간 밖에서 일어나면 수집 진입점에 도달하기 전에 종료합니다. 예약 호출은 확인 가능한 crawl 잠금 경합이 끝날 때까지 종료 신호를 받을 수 있는 상태로 대기합니다. 일반 CLI 호출은 짧은 대기 제한을 유지합니다.

PM2 cron 호출이 예약 시각보다 1분 넘게 지연되면 자식의 시간 확인이 해당 호출을 건너뛰며, 이 PM2 cron 모델에는 따라잡기가 없습니다. 따라잡기는 아래 대안 상주 스케줄러 모델만 제공합니다. 예약 시간 밖에서 종료한 예약 앱은 설치된 PM2가 `restart_delay` 설정 때문에 `stopped` 대신 pid 0의 `waiting restart`로 보고합니다. `autorestart: false`이므로 재시작은 예약되지 않으며, 자동 배포는 이 상태를 정상 휴면으로 검증합니다.

상주 스케줄러와 watchdog을 운영하던 호스트는 최초 전환 전에 스케줄 소유권을 정리합니다. 진행 중인 수집 작업을 마친 뒤 `agamajung-collector-scheduler`가 실행되거나 부활하지 않도록 라이브 등록과 저장본을 정리하고, 관련 시스템·사용자 watchdog 타이머와 서비스를 중지·비활성화합니다. 기존 SQLite의 슬롯 기록은 보존합니다. 자동 배포는 D1 적용 전에 `crawler_competing_scheduler` 또는 `crawler_competing_watchdog`를 기록하고, 이 조건이 해소되면 다음 재시도에서 진행합니다.

배포 또는 부활 후 PM2 등록은 예약 시각과 시작 preload를 함께 확인합니다. 저장된 슬롯 watermark는 완료된 호출의 중복 실행을 막습니다. 전환 검증에 실패하면 이전 링크와 등록을 복원하고 수집기 전환만 재시도합니다. 후보 인벤토리는 이름별로 검증하며 같은 선언의 순서 변경을 허용합니다. [컨트롤러 설치와 갱신](../../README.md#운영-자동-배포)

## 대안 운영 모델의 슬롯 따라잡기

`npm run collector:worker -- schedule`은 Linux 상주 프로세스다. 시작 즉시 검사하고, 각 검사 종료 후 60초 뒤 현재 벽시각으로 다시 판단한다. 별도 60초 평가 타이머는 긴 실행 중에도 heartbeat·작업별 평가·대기 호출을 기록한다. 시작 직후와 긴 실행을 시작하기 전에도 평가 시각을 `scheduler.json`에 먼저 게시하므로 watchdog 복구 확인이 실행 완료를 기다리지 않는다. 도래 슬롯도 진행 중 실행도 없는 유휴 검사는 `already_completed` 호출 행을 만들지 않고 평가 시각만 갱신한다. runner는 중복 호출하지 않고 수집은 직렬로 유지한다. 절전 중에는 실행할 수 없지만 깨어난 뒤 최신 도래 슬롯까지 한 번으로 합친다. Node는 저장소의 고정 22.22.3 런타임을 사용한다. HTTP `serve`와 수명이 분리되며 사이트·Workers Cron·D1·Instagram 세션을 사용하지 않는다. 기존 `src/scheduler.ts`는 요청 간격·robots·도메인 냉각 담당이다.

## 일정과 수동 호출

상주 스케줄러의 슬롯 설정은 `crawler/config/schedule.json`이다. 모든 시각은 호스트 시간대와 관계없이 KST로 계산한다.

| 작업 | KST | 기본 예약 |
| --- | --- | --- |
| discover | 09:20, 15:20, 21:20 | 활성 |
| collect | 09:40, 15:40, 21:40 | 활성 |
| discover-sources | 10:05 | 비활성, 운영 dump의 후보 일정 재확인 필요 |
| backfill-engine | 03:30 | 비활성, 운영 dump의 후보 일정 재확인 필요 |

예약 활성화는 출처·검색 제공자를 활성화하지 않는다. 이들이 전부 비활성이면 `disabled/sources_disabled`로 남고 성공 시각을 갱신하지 않는다. Instagram, sync, 빈 필드 탐색기에는 이 스케줄러의 일정을 부여하지 않는다.

```sh
npm run collector:worker -- schedule
npm run collector:worker -- collect
npm run collector:worker -- collect --resume RUN_ID
npm run collector:worker -- discover
npm run collector:worker -- discover-sources --dry-run
```

기본 수동 호출은 현재 도래 슬롯 처리 또는 기존 미완료 실행 재개다. 같은 슬롯을 반복 호출해도 새 수집을 강제하지 않는다. 오전·오후는 서로 다른 엔진 ID를 사용하며 수동·예약은 동일한 `{kind:'scheduled', at:슬롯 UTC ISO}` 키를 공유한다. 예약 비활성 작업의 명시적 수동 실행은 슬롯 없는 독립 실행이다. `--resume`으로 완료된 ID를 전달하면 `already_completed`이며 현재 슬롯을 선점하거나 성공 처리하지 않는다. `--dry-run`은 슬롯·활성 실행·성공 이력에서 제외한다. 기존 discover의 dry-run은 제한된 네트워크 검사이고 collect/discover-sources의 dry-run은 오프라인 미리보기다.

최초 이력이 없으면 최신 도래 슬롯 한 개만 처리한다(당일 첫 슬롯 전이면 전날 마지막 슬롯). 이후에는 마지막으로 선점한 슬롯 다음부터 최신 슬롯까지 병합 범위·개수를 남긴다. 여러 날 누락돼도 작업당 검사 회차에 최대 한 번이며 전체 작업은 직렬이다. 시계 역행은 처리 이력을 되돌리지 않는다. 일정 변경은 기존 버전·슬롯 귀속을 바꾸지 않는다.

## 상태와 성공 판정

Linux migration `0007_collection_schedule.sql`은 사이트 D1 migration과 별개다. `collection_schedule_runs`는 슬롯 묶음·실행 의도·엔진 ID·seed 완료·다음 재개 기한을, `collection_schedule_calls`는 개별 수동/예약 호출·신규/재개/건너뜀·시작/종료·결과·고정 사유·정수 건수를 저장한다. 호출 수와 엔진 체크포인트 attempts는 별개다. 슬롯별 고유 제약, 작업별 활성 실행 고유 제약, 엔진 ID 고유 제약과 귀속 변경 금지 trigger를 적용한다.

`<COLLECTOR_DB>.schedule/<job>.json`은 DB에서 재생성하는 요약이다. 디렉터리 0700, 파일 0600이며 symlink를 거부한다. 임시 파일 작성·fsync·rename·디렉터리 fsync로 게시한다. 누락/쓰기 실패를 빈 실행 이력으로 취급하지 않는다. SQLite만 중복 판단에 사용한다. 파일에는 마지막 성공 완료 시각과 마지막 성공 대상 슬롯을 따로 둔다. 잠금 실패 호출은 DB 호출 이력에만 추가하고 실행 중 요약과 마지막 성공을 덮어쓰지 않는다.

수동 CLI와 scheduler는 공통 JS bootstrap/결과 함수를 사용한다. 추적되는 진입점은 `crawler/local-worker.mjs`와 `crawler/collector-scheduler.mjs`다. 설정·동적 import·DB 초기화 전 호출 UUID와 시작 기록을 만들며 초기 오류도 고정 사유만 출력한다. stderr의 KST `collector_start`·`collector_end`도 유지한다.

stdout은 호출별 start/result NDJSON(`schema_version=1`)이다. skip·disabled·dry-run·초기 실패에도 `generated_at`이 있으며 `outcome`은 `succeeded`, `disabled`, `skipped`, `partial_failure`, `halted`, `exhausted`, `pending`, `interrupted`, `already_completed`, `dry_run`, `failed` 중 하나다. 시작은 outcome=null/reason=started다. 정상 무작업은 succeeded/no_work 조합이다. 서비스 수명과 scheduler heartbeat는 별도 이벤트다.

- 시각: UTC ISO `generated_at`, `started_at`, `ended_at`, `observed_at`. 강제 종료를 다음 소유자가 발견하면 이전 호출의 ended_at=null과 observed_at을 남긴다.
- 식별: job/source/call_id, logical_run_id, engine_run_id. 평가한 expected_slot과 실제 귀속 first_slot/target_slot/slot_count/schedule_version을 구분한다. 없는 값은 null이다.
- discover `counts.invocation`: pages_attempted, pages_ok, pages_failed, blocked_requests, parsed_items, eligible_items, submissions_accepted, subrequest_failures, sources_review. 이번 RunHealth 집계이며 submissions_accepted는 접수 성공 횟수다. 신규 상품 수가 아니다.
- collect `counts.engine`: checkpoints_done, checkpoints_failed, checkpoints_skipped, checkpoints_unfinished, service_receipts_confirmed. failed에는 실패성 skipped도 포함하므로 서로 배타적인 합계가 아니다. receipt는 완료된 service 체크포인트가 가리키는 로컬 receipt의 distinct 개수이며 복구 연결도 포함한다.
- collect `counts.invocation`: 동일 엔진 호출 전후 checkpoint_attempts_delta와 service_receipts_confirmed_delta. 미측정은 null이며 0으로 꾸미지 않는다.
- `result`에는 기존 결과 중 허용된 집계·고정 enum·불투명 ID만 남긴다. 커스텀 source ID는 hash로 표현한다. 원문/URL/예외/stack/환경/PM2 원문/인증 헤더는 출력하지 않는다. history_status는 recorded/unavailable을 구분한다.

Linux 전용 `0008_collection_observability.sql`은 calls에 expected_slot·schedule_version을 추가한다. 과거 행은 null로 유지한다. DB가 열리지 않아도 stdout에는 failed/initialization_failed와 call_history_unavailable 진단이 남는다. 결과 DB 확정 후 요약/출력 실패는 별도 summary_write_failed/result_publish_failed로 진단하며 수집을 반복하거나 결과를 실패로 덮어쓰지 않는다. bootstrap은 초기화 실패 시 고정 코드(`collectorFailure`)를 진단에 남기며, 추적되지 않는 CLI 명령도 stdout을 오염시키지 않고 stderr에 같은 고정 코드를 남긴다.

호출 이력은 상주 scheduler가 시간당 한 번 정리한다. 종료된 `collection_schedule_calls` 중 7일이 지난 행만 삭제하며 진행 중 호출·실행 귀속·요약의 최근 성공 기록은 건드리지 않는다. PM2 로그는 자동 회전하지 않으므로 운영 환경에서 `pm2-logrotate`(max_size/retain) 또는 시스템 logrotate를 별도로 설정한다.

| 엔진/작업 결과 | 슬롯 성공 | 후속 처리 |
| --- | --- | --- |
| finished, 미완료·실패 없음 | 최초 귀속 슬롯만 성공 | 정상 무작업도 허용 |
| finished, 실패 있음 | 갱신 없음 | 부분 실패 종료, 같은 슬롯 새 실행 금지 |
| 정책상 skipped/unsupported | 사유·건수 보존 | 실패 없는 정상 완료에 한해 허용 |
| running, 미래 retry 또는 lease | 갱신 없음 | pending, 가장 이른 실행 가능 시각까지 대기 |
| cost_wait | 갱신 없음 | deferred.next_at 이후 같은 엔진 재개 |
| exhausted | 갱신 없음 | 같은 KST 날짜 새 ID 금지, 다음 날 미완료 단계 이월 |
| halted | 갱신 없음 | 운영자가 도메인 중단 원인을 해소한 뒤 명시적 --resume |
| dry-run, disabled, 완료 ID 재반환 | 갱신 없음 | 별도 호출 결과 |
| discover 전송 실패/차단/하위 요청 실패 | 갱신 없음 | 부분 실패 종료 |
| discover 품질 검토 플래그/빈 결과 | 전송 실패가 없으면 정상 완료 | quality_review/no_work로 구분 |

종료코드 0이나 run.state=finished만으로 성공을 판단하지 않는다. 재개 기한은 pending/retry_wait/deferred의 `next_at`, leased의 `lease_until` 중 가장 이른 값이다. 다른 실행 가능한 체크포인트가 있으면 먼저 진행한다. 기한 전에는 runner·transport·recover를 부르지 않으며 attempts를 변경하지 않는다. 모순된 상태·잘못된 시각은 오류로 남겨 새 실행으로 우회하지 않는다.

예를 들어 09:40 실행 A가 15:50에 재개·성공해도 A의 성공 슬롯은 09:40이다. 15:40은 다음 검사에서 새 B로 처리한다. 대기 중에는 crawl 잠금을 해제하므로 다른 작업이 실행될 수 있다. 재기동도 lease를 강제 만료시키지 않는다. 만료 후 엔진의 기존 recover가 receipt·저장 출력을 재사용해 비용·근거·outbox 중복을 막는다. 최초 seed 완료는 영속화하며 재개 때 seed를 반복하지 않는다. seed 중 종료한 경우만 멱등 seed를 마친다.

이전 버전의 활성 엔진은 원래 귀속을 증명할 수 없으므로 `legacy_unassigned`로 채택한다. 그 복구 완료는 최신 슬롯 성공이 아니다. 이전 날짜 단위 완료 엔진은 채택하지 않는다. `failures retry`의 별도 parent_run 복구도 슬롯 없는 실행으로 남아 전체 슬롯 성공을 대신하지 않는다.

슬롯 선점 후 엔진 생성 전에 중단된 실행 의도가 있어도 별도 재시도 엔진의 자동 복구와 명시적 `--resume`을 허용한다. 원래 의도와 슬롯 없는 복구 기록을 따로 보존하고, 복구가 끝날 때까지 복구 엔진을 먼저 재개한다. 활성 슬롯 실행과 활성 복구 기록은 각각 하나, 엔진이 연결된 활성 실행은 작업별 하나로 제한한다. 복구 완료 후 다음 호출에서 원래 의도를 실행하며, 그동안 도래한 후속 슬롯은 이후 검사에서 처리한다. 결정적 키의 엔진이 이미 생성됐다면 해당 엔진의 기존 귀속 복구가 우선이다.

## 잠금과 중간 종료 복구

스케줄러는 `${db}.schedule.lock`, 실제 작업은 `${db}.crawl.lock`을 각각 사용한다. backfill-engine도 crawl 잠금을 사용한다. PID·시작 ticks·boot ID·최소 경과 시간·판독 불가 시 보존 규칙은 기존 구현과 같다. 잠금을 얻은 뒤 시각·DB를 다시 읽는다. 선점은 짧은 SQLite 트랜잭션으로 하고 네트워크나 재개 대기 동안 트랜잭션을 유지하지 않는다. CollectorStore의 중첩 트랜잭션 제한을 지킨다.

엔진 생성 전에 결정적 키를 포함한 실행 의도를 저장한다. 생성 후 반환 ID가 그 키인지 검증하고 귀속을 저장한다. 그 사이 종료하면 저장 키로 연결을 복구한다. 완료 후 요약 전 종료하면 엔진의 원래 finished_at과 귀속으로 해당 슬롯만 확정한다. 복구 관찰 시각을 성공 시각으로 만들지 않는다. 엔진 없는 작업이 실행 중 종료되면 interrupted로 끝내고 같은 슬롯을 자동 재실행하지 않는다. JSON 쓰기 실패 후에도 이미 끝난 수집은 다시 시작하지 않는다.

보장은 슬롯별 신규 논리 실행 선점 중복 방지, 동시 수집 1개, 기존 엔진의 멱등 복구다. 강제 종료 전후 외부 네트워크 작업의 정확히 한 번 실행까지 보장하지 않는다. 기존 일일 예산·공유 비용 cap·도메인 간격·재시도·지터·최대 attempts를 유지한다.

## 2026-10-31 누락 조사

2026-11-01 KST 작업 환경에서 아래 자료를 읽기 전용으로 확인했다. 운영 PM2를 호출하거나 등록·중단·재시작하지 않았다. PM2 dump와 환경 전체를 출력하지 않고 허용된 작업명·cron·시각만 추렸다.

| 출처 | 확인 사실 | 한계 |
| --- | --- | --- |
| `/home/box/.pm2/pm2.log`, 10/31 | discover 시작 07:16:03·17:22:05, collect 시작 01:16:34 | PM2 시작/online은 수집 성공의 증거가 아님. 로그 timestamp에는 UTC offset 없음 |
| 같은 로그, 10/30 | discover 01:23:27, collect 03:22:29, backfill 10:27:02, discover-sources 22:04:03 시작 | 예정 슬롯과 분까지 어긋남 |
| 현재 보존 `/home/box/.pm2/dump.pm2` | discover `20 9,15,21 * * *`, collect `40 9,15,21 * * *`, sources `5 10 * * *`, backfill `30 3 * * *` | 사건 당시 메모리의 cron 등록·실행 코드 버전 증명 아님 |
| 저장소 | 기존 PM2 설정은 Instagram worker만 정의, 보고된 `crawler/local-worker.mjs` 없음 | 당시 실제 외부 진입점은 별도 확인 필요 |
| 현재 `/etc/timezone`, `/etc/localtime`, `date` | Asia/Seoul, +09:00 | 사건 당시 PM2 데몬의 유효 시간대 증명 아님 |
| 현재 PM2 데몬 `/proc` 환경 | 명시적 TZ 항목 없음 | 자식 TZ와 구분해야 하며 당시 데몬 환경은 미확인 |
| system journal 부팅 목록·10/30–31 suspend/hibernate unit 조회 | 보존 journal 항목 없음 | 컨테이너 밖 호스트·VM 절전 여부를 반증하지 않음 |
| 설치된 PM2 `lib/Worker.js`, `God/ActionMethods.js`, `God.js` | cron callback은 restartProcessId, 재시작/실행 경로에 cron 해제·재등록 코드 있음 | 로그의 해제·등록만으로 cron 장애나 수동 재시작을 구분할 수 없음 |

**실제 원인은 미확정이다.** 절전·VM 일시 중지·이벤트 루프 지연 가설은 가능하지만 사건 당시 suspend/resume 증거가 없다. 단순 UTC↔KST 차이는 분까지 어긋난 시각을 설명하지 못한다. cron 재등록은 정상 재시작 경로에서도 발생하므로 원인이라고 단정하지 않는다. 새 상주 슬롯 이력은 누락 복구를 제공하지만 과거 원인을 증명하지 않는다.

확정하려면 운영자가 (1) 호스트/하이퍼바이저의 10/30–31 suspend/resume·시간 동기화 기록, (2) PM2 데몬 시작 시각·당시 TZ/시스템 시간대, (3) 수동 restart/reload·재등록 감사 기록, (4) 당시 script 경로·코드 버전·croner 버전을 같은 시간축에 대조해야 한다. 비밀 환경 덤프나 수집 원문을 문서에 첨부하지 않는다.

## 독립 Linux watchdog

`crawler/collector-watchdog.sh`를 같은 Linux 사용자·호스트·PID namespace와 동일 COLLECTOR_DB로 실행한다. PM2 밖의 user systemd service/timer 템플릿은 `crawler/systemd/`에 있다. 60초마다 검사하며 watchdog은 수집 runner를 직접 부르지 않는다. 외부 PM2 원문은 메모리에서 허용 필드만 검증하고 출력/저장하지 않는다.

`${db}.schedule/scheduler.json`은 0700 디렉터리/0600 파일이며 원자적 fsync/rename으로 게시한다. 프로세스 PID·boot ID·시작 ticks, checkout revision, 설정 hash, heartbeat, 작업별 평가 시각, 현재 call ID, 대기 사유, 마지막 진행 변경 시각을 담는다. heartbeat만 최신이고 실제 슬롯 평가가 멈췄는지도 별도로 판단한다. revision은 checkout 기준이며 dirty tree를 증명하지 않는다.

| 조건 | 진단/조치 |
| --- | --- |
| 활성 도래 슬롯 +5분, 해당 평가 call과 검증된 범위의 run 모두 없음 | missing_slot |
| heartbeat 또는 활성 작업별 평가가 180초 이상 오래됨 | 첫 관찰 stale_scheduler_suspected, 60초 뒤 재확인 stale_scheduler |
| 마지막 성공 귀속 슬롯이 현재보다 과거/없음 | last_success_stale와 현재 status/next_at. 최근 generated_at 하나로 성공 판정하지 않음 |
| 락 경합/이전 실행 대기 | slot_waiting_lock / slot_waiting_active_run |
| schedule 비활성 | schedule_disabled. 기대 슬롯/누락 경보를 만들지 않음 |
| 활성 schedule의 source 전부 비활성 | disabled/sources_disabled. 마지막 성공을 갱신하지 않음 |
| DB 조회 실패/설정 hash 불일치 | monitor_db_unavailable / schedule_config_mismatch. 자동 복구 차단 |
| 미래 retry/lease/cost 기한 | waiting_deadline. 기한 +5분 후 평가가 없으면 resume_overdue |
| 실행 중 15분간 진행 변경 없음 | progress_stale. 이것만으로 재시작하지 않음 |

PM2의 online/PID 파일만 믿지 않고 실제 `/proc` 신원·실행 경로·락 소유자와 대조한다. PID 0/부재도 검사한다. local-worker의 `GET /v1/readiness`는 loopback Host·Origin·검토 토큰 검증 후 DB 읽기 가능 여부와 인스턴스 신원만 반환한다. readiness timeout 단독, PM2 실패/잘못된 응답/중복 등록, 신원 불일치, `/proc` 검사 불가에는 재시작하지 않는다. 락 없이 실제 프로세스가 있으면 live_process_without_lock으로 보존하고 중복 기동하지 않는다.

자동 복구는 60초 간격 두 관찰에서 소유자 부재 또는 검증된 zombie를 확인하고 다른 살아 있는 동일 서비스/수집 작업 소유자가 없을 때만 대상 앱을 restart한다. 직전에도 다시 관찰한다. watchdog은 락을 삭제하지 않으며 새 서비스가 기존 30초 유예·신원·inode/device/내용 검사를 통과해서 회수한다. 살아 있는 정지 scheduler는 강제 종료하지 않는다. 복구하지 않았다는 사실을 별도로 기록한다. 60초 안에 새 local-worker readiness 또는 새 scheduler 신원+첫 활성 작업별 평가가 있어야 프로세스 복구 성공이다. 수집 성공과는 별개다. scheduler 복구 확인은 `scheduler.json`의 heartbeat·활성 작업별 평가 시각이 확인 시작 시점(수 초 허용 오차 포함) 이후인지와 `config_hash` 일치를 요구한다. watchdog과 scheduler는 같은 체크아웃·같은 `crawler/config/schedule.json`에서 실행해야 하며, 설정이 다르면 `schedule_config_mismatch`로 복구를 완료하지 않는다.

복구 상태는 `${db}.watchdog/state.json`(0700/0600)에 앱별 UUID·예약 시각·관찰 신원·조치/결과·최근 장애만 저장한다. 임시 파일→fsync→rename→디렉터리 fsync로 명령 전에 시도를 예약한다. 명령 중 종료한 reserved 시도도 상한에 포함한다. 앱별 최소 10분 간격, rolling 60분 최대 3회이며 재부팅/감시 재시작으로 초기화하지 않는다. 완료 시도·종료 장애는 7일, 열린 장애는 유지한다. 역행 시계/손상/읽기 실패/상태 파일 유실에는 자동 복구를 차단한다.

watchdog 전체 검사·상태 변경·복구는 영구 `${db}.watchdog.flock` inode에 대한 Linux flock으로 직렬화한다. 경합 호출은 작업 없이 종료한다. 락 파일을 지워 경합을 풀지 않는다. `.mjs`를 직접 실행하지 않고 shell 진입점을 사용한다. 최초 `--init`은 DB의 watchdog_initialized 표식을 먼저 남기므로 상태 유실 후 같은 명령으로 상한을 초기화할 수 없다. 실패한 설치나 상태 유실은 운영자가 기존 기록/백업을 확인해 복구해야 한다.

## 상주 스케줄러와 watchdog 전환 및 검증

다음은 대안 운영 모델의 전환 절차다. 구현 완료와 운영 복구 완료를 구분한다.

1. 검증된 revision으로 운영 체크아웃을 갱신하고 추적되는 JS/TS 진입점이 존재하는지 확인한다. 진행 수집은 정상 종료를 기다리고 일관된 DB 백업을 보존한다. lease/일일 상한/attempts/domain_stopped를 초기화하지 않는다.
2. 기존 discover/collect 일회성 cron과 sources/backfill 중복 재시작 등록을 제거한다. 비밀 환경 전체나 PM2 dump를 출력하지 않는다.
3. 저장소 밖 0700 DB/RAW 디렉터리와 전용 COLLECTOR_DB·COLLECTOR_RAW_DIR·검토 토큰을 비밀 환경에 주입한다. 출처·제공자 승인은 별도 정책을 유지한다. 고정 런타임으로 Linux migration을 적용하는 명령을 한 번 실행한다.
4. `crawler/local-worker.ecosystem.config.cjs`와 `collector-scheduler.ecosystem.config.cjs`를 각각 단일 fork 인스턴스로 등록한다. 둘 다 autorestart=false, max_restarts=1, restart_delay=10000, watch=false, cron_restart 없음, kill_timeout=90000, 고정 Node·명시적 로그 경로다. watchdog만 자동 복구한다. 실제 PM2 설정에 구형 cron/자동 재시작이 남으면 supervision_policy_mismatch로 전환 미완료다. Instagram/sync/사이트는 별도 시스템이다.
5. 같은 비밀 환경에서 `crawler/collector-watchdog.sh --init`을 최초 한 번 실행한다. 템플릿 service의 WorkingDirectory/ExecStart와 비밀 EnvironmentFile 경로를 설치 위치에 맞춰 user systemd로 설치하고 timer를 활성화한다. systemd는 PM2 밖에서 실행되어야 한다. PM2 실행 파일 경로가 필요하면 COLLECTOR_PM2_BIN으로 지정한다. 실제 서비스와 watchdog의 COLLECTOR_DB가 같아야 한다.
6. local-worker의 새 신원과 인증 readiness, scheduler 하나와 heartbeat/평가를 확인한다. 다음 도래 슬롯의 calls·runs·stdout을 서로 대조해 건수·귀속·성공/대기/실패를 확인해야 운영 복구 완료다. 최근 성공 파일이나 PM2 online만으로 완료하지 않는다.
7. 유지보수/롤백은 watchdog timer/service를 먼저 중지하고 앱을 정상 중단한다. DB 이력·lease를 보존하며 구형 cron과 동시 운영하지 않는다. 소유자 없는 `.sqlite.lock`은 [crawler README](../../crawler/README.md#동시-실행과-잠금)의 운영자 점검 절차로만 처리한다. SQLite -wal/-shm/-journal을 삭제하지 않는다.

### 2026-11-08 읽기 전용 재확인

운영 경로 `/workspace/agamajung/repo` HEAD는 `3bac379db7250cea7212adbe22ab4daee79465f6`이고 `crawler/src/schedule-worker.ts`가 없었다. 따라서 그 체크아웃에서는 #77 상주 따라잡기가 동작할 수 없다. 과거 cron 시각이 분까지 어긋난 직접 원인은 여전히 미확정이다. 운영 체크아웃/PM2/cron은 이 구현에서 변경하지 않았다. 별도 전환과 다음 도래 슬롯의 실제 결과를 확인하기 전에는 운영 복구 완료를 주장하지 않는다.

검증은 고정 Node를 PATH에 둔 상태에서 수행한다.

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm test -- tests/collection-schedule.test.ts tests/collector-concurrency.test.ts tests/source-discovery-cli.test.ts tests/collector-observability.test.ts tests/collector-watchdog.test.ts
npm test
npm run lint
npm run typecheck
```

테스트는 주입 시계·sleep·transport·락·결함 지점과 실제 AgamajungPipeline/SQLite를 사용한다. tests/setup.ts의 네트워크·소켓·실제 브라우저 차단을 유지한다. 정상/누락/병합·수동 경합·동일 슬롯 재호출·완료 ID 재반환·retry/lease/cost_wait·자정/역행·중간 종료·receipt 복구·권한·symlink·요약 실패를 확인한다. 실제 운영 네트워크 수집·PM2 전환·배포는 이 오프라인 검증에 포함되지 않는다.

## 공구 수집 실행권

공구 수집의 소유자는 `agamajung-deepseek-web daemon`입니다. 등록된 PM2 슬롯의 공구 작업은 발견 URL을 SQLite frontier에 추가합니다. 데몬은 출처 순서를 섞어 due URL을 claim하고, 여러 상품이 있는 페이지에서는 상품 단위로 cursor를 저장합니다. Instagram v2는 공유 세션 잠금으로 읽기를 조정하며 429와 계정 확인 경보가 있으면 KST 자정 이후 다시 읽습니다.

`status --json`의 `offer_idle_tick_ms`와 상태 디렉터리의 `metrics-hourly.jsonl`로 상주 작업과 시간별 성과를 확인합니다. 사이트의 `/admin`에서 `missing_official_coverage`, `missing_deadline`, `source_unavailable` 및 판독 불일치 등 상품별 보류 이유를 확인합니다. 요건을 통과한 상품은 자동 게시되며 유효성을 잃은 근거는 사이트 공개에서 철회됩니다.
