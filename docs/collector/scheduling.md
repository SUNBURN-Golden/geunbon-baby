# Linux 수집 슬롯과 따라잡기

`npm run collector:worker -- schedule`은 Linux 상주 프로세스다. 시작 즉시 검사하고, 각 검사 종료 후 60초 뒤 현재 벽시각으로 다시 판단한다. 절전 중에는 실행할 수 없지만 깨어난 뒤 최신 도래 슬롯까지 한 번으로 합친다. Node는 저장소의 고정 22.22.3 런타임을 사용한다. HTTP `serve`와 수명이 분리되며 사이트·Workers Cron·D1·Instagram 세션을 사용하지 않는다. 기존 `src/scheduler.ts`는 요청 간격·robots·도메인 냉각 담당이다.

## 일정과 수동 호출

일정의 유일한 설정은 `crawler/config/schedule.json`이다. 모든 시각은 호스트 시간대와 관계없이 KST로 계산한다.

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

stderr의 `collector_start`·`collector_end`는 `at=…+09:00`, 작업명, UUID 호출 ID, 출처, 결과, 고정 사유를 포함한다. discover 상세 줄에도 KST 시각·호출 ID가 붙는다. stdout은 기존 작업의 JSON 결과를 유지하며 같은 슬롯 건너뜀은 stdout이 없다. 실행 중 JSON의 종료 시각은 null이다. 강제 종료를 다음 소유자가 발견하면 실제 종료 시각은 null로 두고 `observed_at`과 `interrupted/owner_gone`을 남긴다. 원본 예외·환경변수·자격 증명·URL·본문은 실행 기록에 넣지 않는다.

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

## 운영 전환과 검증

다음은 운영자가 별도 수행할 전환 절차다. 이 작업에서는 실행하지 않았다.

1. 기존 discover·collect 일회성 cron 등록을 제거하거나 비활성화했는지 확인한다. sources/backfill 후보 일정도 중복 등록되지 않게 점검한다. dump를 그대로 출력하면 비밀 환경이 노출될 수 있으므로 필요한 필드만 확인한다.
2. 진행 중인 수집을 종료까지 기다린다. 기존 PID 잠금과 engine lease를 삭제하거나 강제 만료시키지 않는다. DB의 일관된 백업을 보존한다.
3. 저장소 밖의 0700 DB/RAW 디렉터리와 전용 COLLECTOR_DB·COLLECTOR_RAW_DIR을 비밀 환경에서 주입한다. 출처·검색 제공자 설정은 기존 승인 정책을 따로 확인한다.
4. 고정 런타임으로 migration을 적용하는 명령을 한 번 실행하고, `crawler/collector-scheduler.ecosystem.config.cjs`의 상주 앱을 단일 인스턴스로 활성화한다. 이 정의에는 cron_restart가 없다. PM2는 생존만 관리한다. 기존 serve·Instagram·sync 운영은 각각 분리한다.
5. 시작/종료 로그·작업별 JSON·engine-status를 대조해 슬롯 귀속, pending 기한, 마지막 성공 슬롯을 확인한다. scheduler를 재시작해도 최근 처리 슬롯에 새 엔진이 생기지 않아야 한다.
6. 롤백은 scheduler를 정상 중단하고 진행 작업 종료 후 수행한다. 슬롯 DB 이력과 lease는 보존하며 구형 cron과 동시에 운영하지 않는다.

검증은 고정 Node를 PATH에 둔 상태에서 수행한다.

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm test -- tests/collection-schedule.test.ts tests/collector-concurrency.test.ts tests/source-discovery-cli.test.ts
npm test
npm run lint
npm run typecheck
```

테스트는 주입 시계·sleep·transport·락·결함 지점과 실제 AgamajungPipeline/SQLite를 사용한다. tests/setup.ts의 네트워크·소켓·실제 브라우저 차단을 유지한다. 정상/누락/병합·수동 경합·동일 슬롯 재호출·완료 ID 재반환·retry/lease/cost_wait·자정/역행·중간 종료·receipt 복구·권한·symlink·요약 실패를 확인한다. 실제 운영 네트워크 수집·PM2 전환·배포는 이 오프라인 검증에 포함되지 않는다.
