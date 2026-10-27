# Linux 공용 수집 엔진

`crawler/engine/`는 서비스 온톨로지·설정·사이트 D1을 import하지 않는다. SQLite 작업 상태, lease, 제한된 재시도, 비용, 다운로드·렌더·PDF/OCR·저장 포트를 제공한다. 아가마중 바인딩은 `crawler/src/agamajung/`, 도메인 정책·주소 결속·robots·간격은 기존 `Scheduler`, 서비스 계층은 기존 `CollectorStore.reserve/start/submit`을 사용한다. Workers와 사이트 UI에는 연결하지 않는다. 기존 Instagram worker·브라우저 세션은 사용하지 않는다.

Node 22 이상에서 실행한다. 아래 모든 새 명령에는 저장소 밖의 `COLLECTOR_DB`가 필요하며 collect/backfill/retry에는 `COLLECTOR_RAW_DIR`도 필요하다. 디렉터리 0700, 파일 0600, 심볼릭 링크는 거부한다. 환경변수 예시는 `crawler/.env.crawler.example`에 있다. 기존 serve/discover/sync의 기본 경로는 유지된다.

```sh
export COLLECTOR_DB=/workspace/agamajung/data/collector/collector.sqlite
export COLLECTOR_RAW_DIR=/workspace/agamajung/data/collector/raw
npm run collector:worker -- collect --dry-run
npm run collector:worker -- collect
npm run collector:worker -- collect --resume RUN_ID
npm run collector:worker -- engine-status --json
npm run collector:worker -- failures list
npm run collector:worker -- failures retry CHECKPOINT_ID
npm run collector:worker -- backfill-engine
npm run collector:worker -- dedup-audit
npm run collector:worker -- dedup-audit --apply
```

`--dry-run`은 오프라인 정책 미리보기다. 네트워크·본문 예산·서비스 접수를 실행하지 않는다. 활성 소스가 없고 작업도 없으면 finished로 끝난다. 소스 활성화는 `crawler/config/collector.json` 또는 `COLLECTOR_CONFIG`에서만 한다. 배포 프로필은 CPSC만 허용하고 기존 설정의 모든 소스는 disabled다. 수집은 허용된 출처만 제조사 → 수입사 → 카탈로그 → 공식 판매처 → 정부 순으로 시작한다. 기존 링크/RSS/sitemap/CPSC 어댑터를 사용하고 깊이·페이지 상한을 지킨다.

## 체크포인트와 중단

단계는 discover → fetch → render(동적 소스만) → parse → label → extract → service다. 단계 입력·버전·출력·attempts가 SQLite에 남는다. WAL-reset 수정이 포함된 고정 Node 런타임에서 WAL과 BEGIN IMMEDIATE, busy_timeout_ms/busy_retries, 3분 lease 및 1분 갱신을 사용한다. serve·discover·sync는 같은 DB를 공유하고, 같은 종류만 PID 실행 잠금(`${db}.{serve|crawl|sync}.lock`)으로 제한한다. discover·collect·failures retry는 crawl을 공유한다. 사망·PID 재사용·이전 부팅이 확인된 잠금만 자동 회수하며 판독 불가/생존 확인 불가 잠금은 보존한다. 기존 DB 전체 `.lock`은 경고 후 무시한다. [동시 실행·롤아웃 절차](../../crawler/README.md#동시-실행과-잠금)를 따른다.

실행 중인 run 또는 일일 상한 대기(cost_wait)가 있으면 같은 run을 채택한다. deferred의 next_at은 다음 KST 자정이다. 재시도는 최초 포함 3회, 최소 5분 지수 백오프·지터, 최대 6시간이며 도메인 냉각을 반영한다. 터미널 오류는 즉시 실패 큐에 기록한다. 실패 큐에는 고정 사유 코드·시도 횟수·다음 시각을 남기며 원문·응답·자격 증명은 출력하지 않는다. 수동 retry는 parent_run으로 연결된 새 run을 만든다. 원래 attempts·비용은 초기화하지 않는다.

run 상한은 exhausted로 멈춘다. 같은 run은 재개할 수 없고 다음 일일 슬롯이 미완료 단계만 carried_from으로 이월한다. 상한을 운영자가 늘릴 때도 기존 ledger 행은 변경하지 않는다. 설정 변경은 새 run/새 일일 scope에 적용된다.

로그인 폼·로그인 경로·challenge·차단·빈 페이지는 도메인을 stopped/access_restricted로 기록하고 run을 halted로 끝내며 CLI 종료코드는 75다. render 소스의 JS shell은 fetch에서 빈 페이지로 판정하지 않고 렌더 DOM을 확인한다. 영역 없음은 제한 신호를 먼저 확인한 뒤 region_missing으로 기록한다. 해제는 운영자가 원인과 domain_state를 확인하고 stopped를 명시적으로 해제한 뒤 `--resume`으로 한다. 새 수집이나 수동 retry도 stopped 도메인을 우회하지 않는다. 프록시·계정 교체·로그인 조작 경로는 없다.

service는 external 단계다. submit이 자체 트랜잭션으로 commit한 뒤 체크포인트를 확정한다. 중간 종료 시 만료 lease의 recover가 트랜잭션 없는 receipt 조회와 결정적 payload digest를 비교하므로 근거·예산·outbox·현황 버전이 늘지 않는다. 제출 유예는 기존 설정의 7일이며 만료는 submission_expired, 다른 payload는 payload_changed로 실패한다.

## 비용과 캐시

실제 transport 직전에 requests 1과 max_bytes(기본 2MiB)를 run/day 양쪽에 예약한다. robots·각 redirect·실패 응답·브라우저 script/stylesheet/xhr/fetch도 모두 이 경로를 사용한다. 차단된 리소스·비GET은 전송하지 않는다. 실제 수신한 허용 본문 바이트로 정산하고 DNS 실패는 요청 1/바이트 0이다. 2MiB를 넘는 응답은 response_size로 중단한다. 스트림에서 허용 크기만큼만 읽고 초과 데이터가 있으면 즉시 종료한다. 계량은 실제 읽은 본문 바이트를 사용한다. 재시작 시 고아 예약은 예약량 전부를 소진으로 간주한다. 남은 바이트 상한이 2MiB보다 작으면 작은 응답도 요청하지 않는 보수적 정책이다. run/day 모두 부족하면 day를 우선한다.

본문은 기존 new_body/recheck 예약·start를 HTTP 전에 실행한다. 같은 시도의 재진입은 같은 reservation을 사용한다. 모델은 기본 disabled/상한 0이며 규칙 라벨이 모호하고 enabled일 때만 격리한 `aiData()`와 별도 model_calls 예약을 사용한다. 외부 모델 제공자는 포함하지 않는다. DisabledModel은 네트워크 호출 0회로 unsupported를 반환한다. 모델은 라벨만 분류하고 사실이나 필수 필드를 채우지 않는다.

현재 규칙·프로필·로컬 도구 버전의 parse/label/extract 캐시가 모두 있거나 해시 일치 raw/spool이 있을 때만 ETag/Last-Modified를 보낸다. 304도 새 불변 capture를 만들고 새 capture에 캐시 사실을 결합한다. 캐시가 요청 도중 사라지면 무조건 요청을 한 번 더 한다. spool과 캐시가 모두 없으면 fetch부터 다시 열고 fetch_seq를 늘리며 시도 상한을 적용한다. 이전 capture는 변경하지 않는다.

raw 기본은 hash_only다. 임시 spool은 24시간 TTL, parse 확정 시 삭제한다. 영구 원문은 full_text_allowed·permission_basis가 있는 store 정책의 개인정보 필터 및 폼·스크립트·민감 속성 검사를 통과한 텍스트 원본에 한해 저장한다. 바이너리 원본·민감정보가 있는 원문은 임시 spool로만 도구에 전달하고 영구 raw_ref는 NULL로 남긴다. raw 경로는 `<RAW>/<profile>/sha256/ab/cd/<hash>`, 저장은 임시 파일·fsync·rename이다. DB·캐시·라벨·서비스 데이터에는 공통 개인정보 필터를 적용한 결과만 남긴다. fulltext:* 기존 메타데이터는 이 엔진이 수정하지 않는다.

PDF는 로컬 pdftotext, 이미지 OCR은 tesseract kor+eng을 사용한다. 도구가 없으면 engine_tool_support=unsupported와 체크포인트 skipped/unsupported_tool을 남기고 재시도하지 않는다. 시간 초과는 재시도 대상이다. 설치는 이 명령들이 자동 수행하지 않는다.

오프라인 테스트는 transport·execFile·렌더러·시계·난수·결함 지점을 주입한다. 실제 소켓·fetch·Playwright 실행은 tests/setup.ts가 차단한다.
