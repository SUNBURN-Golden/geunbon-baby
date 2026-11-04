# Linux 공용 수집 엔진

`crawler/engine/`는 서비스 온톨로지·설정·사이트 D1을 import하지 않는다. SQLite 작업 상태, lease, 제한된 재시도, 비용, 다운로드·렌더·PDF/OCR·저장 포트를 제공한다. 아가마중 바인딩은 `crawler/src/agamajung/`, 도메인 정책·주소 결속·robots·간격은 기존 `Scheduler`, 서비스 계층은 기존 `CollectorStore.reserve/start/submit`을 사용한다. Workers와 사이트 UI에는 연결하지 않는다. 기존 Instagram worker·브라우저 세션은 사용하지 않는다.

Node 22 이상에서 실행한다. 아래 모든 새 명령에는 저장소 밖의 `COLLECTOR_DB`가 필요하며 collect와 collect 실패 재시도에는 `COLLECTOR_RAW_DIR`도 필요하다. 소스 발견기는 응답 파일 디렉터리를 요구하지 않는다. 디렉터리 0700, 파일 0600, 심볼릭 링크는 거부한다. 환경변수 예시는 `crawler/.env.crawler.example`에 있다. 기존 serve/discover/sync의 기본 경로는 유지된다.

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

단계는 discover → fetch → render(동적 소스만) → parse → label → extract → service다. 단계 입력·버전·출력·attempts가 SQLite에 남는다. WAL-reset 수정이 포함된 고정 Node 런타임에서 WAL과 BEGIN IMMEDIATE, busy_timeout_ms/busy_retries, 3분 lease 및 1분 갱신을 사용한다. serve·discover·sync는 같은 DB를 공유하고, 같은 종류만 PID 실행 잠금(`${db}.{serve|crawl|sync|schedule}.lock`)으로 제한한다. discover·collect·failures retry는 crawl을 공유한다. 사망·PID 재사용·이전 부팅이 확인된 잠금만 자동 회수하며 판독 불가/생존 확인 불가 잠금은 보존한다. 기존 DB 전체 `.lock`은 경고 후 무시한다. [동시 실행·롤아웃 절차](../../crawler/README.md#동시-실행과-잠금)를 따른다.

실행 중인 run 또는 일일 상한 대기(cost_wait)가 있으면 같은 run을 채택한다. deferred의 next_at은 다음 KST 자정이다. 재시도는 최초 포함 3회, 최소 5분 지수 백오프·지터, 최대 6시간이며 도메인 냉각을 반영한다. 터미널 오류는 즉시 실패 큐에 기록한다. 실패 큐에는 고정 사유 코드·시도 횟수·다음 시각을 남기며 원문·응답·자격 증명은 출력하지 않는다. 수동 retry는 parent_run으로 연결된 새 run을 만든다. 원래 attempts·비용은 초기화하지 않는다.

run 상한은 exhausted로 멈춘다. 같은 run은 재개할 수 없고 다음 일일 슬롯이 미완료 단계만 carried_from으로 이월한다. 상한을 운영자가 늘릴 때도 기존 ledger 행은 변경하지 않는다. 설정 변경은 새 run/새 일일 scope에 적용된다.

로그인 폼·로그인 경로·challenge·차단·빈 페이지는 도메인을 stopped/access_restricted로 기록하고 run을 halted로 끝내며 CLI 종료코드는 75다. render 소스의 JS shell은 fetch에서 빈 페이지로 판정하지 않고 렌더 DOM을 확인한다. 영역 없음은 제한 신호를 먼저 확인한 뒤 region_missing으로 기록한다. 해제는 운영자가 원인과 domain_state를 확인하고 stopped를 명시적으로 해제한 뒤 `--resume`으로 한다. 새 수집이나 수동 retry도 stopped 도메인을 우회하지 않는다. 프록시·계정 교체·로그인 조작 경로는 없다.

service는 external 단계다. submit이 자체 트랜잭션으로 commit한 뒤 체크포인트를 확정한다. 중간 종료 시 만료 lease의 recover가 트랜잭션 없는 receipt 조회와 결정적 payload digest를 비교하므로 근거·예산·outbox·현황 버전이 늘지 않는다. 제출 유예는 기존 설정의 7일이며 만료는 submission_expired, 다른 payload는 payload_changed로 실패한다.

## 비용과 캐시

실제 transport 직전에 requests 1과 max_bytes(기본 2MiB)를 run/day 양쪽에 예약한다. robots·각 redirect·실패 응답·브라우저 script/stylesheet/xhr/fetch도 모두 이 경로를 사용한다. 차단된 리소스·비GET은 전송하지 않는다. 실제 수신한 허용 본문 바이트로 정산하고 DNS 실패는 요청 1/바이트 0이다. 2MiB를 넘는 응답은 response_size로 중단한다. 스트림에서 허용 크기만큼만 읽고 초과 데이터가 있으면 즉시 종료한다. 계량은 실제 읽은 본문 바이트를 사용한다. 재시작 시 고아 예약은 예약량 전부를 소진으로 간주한다. 남은 바이트 상한이 2MiB보다 작으면 작은 응답도 요청하지 않는 보수적 정책이다. run/day 모두 부족하면 day를 우선한다.

본문은 기존 new_body/recheck 예약·start를 HTTP 전에 실행한다. 같은 시도의 재진입은 같은 reservation을 사용한다. 모델은 기본 disabled/상한 0이며 규칙 라벨이 모호하고 enabled일 때만 격리한 `aiData()`와 별도 model_calls 예약을 사용한다. 외부 모델 제공자는 포함하지 않는다. DisabledModel은 네트워크 호출 0회로 unsupported를 반환한다. 모델은 라벨만 분류하고 사실이나 필수 필드를 채우지 않는다.

### 저장 전 준비와 지원 범위

fetch는 원본을 제한된 메모리에서 취득하고 SHA-256을 계산한 뒤, 필요하면 **파싱 전에** 렌더링한다. 선택 영역·주장·링크·제목·원문 관계·위치 정보까지 개인정보/인젝션 검사를 마치고 스키마와 전체 파생물 해시를 검증한다. 원래 응답·HTML·바이너리·응답 객체·도구 stderr·예외 메시지를 SQLite, 로그, 임시 파일에 넘기지 않는다. checkpoint에는 참조와 제한된 운영 정보만 남기고, 준비 결과는 직렬화 전에 제거한다. 실행 사이 원본 버퍼 맵은 없다. 종료 정리 실행 여부와 무관하게 이 경계가 성립한다.

| 취득/도구 경로 | collect의 처리 |
| --- | --- |
| 정적 HTML, 지원 XML/RSS/sitemap, CPSC JSON | 제한된 메모리에서 추출·검사 |
| 기존 Chromium renderer | 비영속 실행 미검증으로 unsupported. HTTP 취득 전 거부 |
| 기존 경로 기반 pdftotext/tesseract | 원본 임시 파일이 필요하므로 unsupported |
| 명시적 memory-only 시험 어댑터 | bounded bytes/HTML과 취소 신호, 시간/출력 제한 및 동일 검사 경계 적용 |

`policy.render || source.browser`는 정적 셸 파싱으로 대체하지 않는다. 렌더된 제한/로그인 신호 검사가 영역 없음 판정보다 우선한다. 실행 파일 설치 여부는 비영속 처리 권한이 아니다. 향후 subprocess 구현에는 고정 인수, 제한된 stdin/stdout, 시간 제한/취소, 내용이 있는 임시 파일을 만들지 않는다는 검증이 모두 필요하다. `-` 인수만으로는 허용하지 않는다. unsupported는 fetch에서 skipped/unsupported 및 고정 도구 코드로 끝나며 후속 checkpoint와 자동 재시도가 없다. Instagram worker의 독립 브라우저·세션·OCR은 변경하지 않는다.

검사 예산은 설정된 응답 바이트 상한(최대 2MiB), 중첩 128, 누적 노드/텍스트/속성/토큰 50,000, 공유 작업량 8,000,000, 태그 8,192자로 제한한다. 비공개/숨김/입력/폼/편집 영역도 스캔 예산에 포함한다. 반복 선택·텍스트 순회·조상 검사도 동일 작업 예산을 쓴다. JSON은 JSON.parse 전에 어휘/중첩 검사를 수행하며 DTD/entity 선언 확장은 거부한다. 일반 발견 링크는 500, Pangpang 열거는 별도로 최대 4,096(기존 768링크 계수 포함), 주장은 30, 선택 텍스트는 20,000자/줄 1,000자, 전체 직렬화 파생물은 2MiB다. 구조/작업량 초과는 고정 preparation_limit으로 끝나고 내용 캐시를 남기지 않는다. 의도적인 출력 절단은 truncated 및 불완전 검사를 기록하고 완전한 부재 판정에 사용하지 않는다. 전체 필드 값을 검사한 뒤 길이를 줄이며 이미 정제된 값만으로 filter_changed=false를 추정하지 않는다.

### 보존 정책과 해시

| 정책 | SQLite | 파일 |
| --- | --- | --- |
| hash_only | 원본 응답 해시·안전한 출처·검사된 제한 영역의 근거/링크 파생물 | 내용 파일 없음. spool도 없음 |
| store | 같은 파생물 + 선택적 artifact 참조 | full_text_allowed와 비어 있지 않은 permission_basis를 모두 확인한 정제 텍스트만 |

RawStore에는 원본 byte write/read나 spool API가 없다. Linux 바인딩이 제공한 **런타임 검증기**와 보존 권한 검사를 임시 파일을 열기 전에 통과해야 한다. 경로는 `<RAW>/<profile>/inspected-v1/sha256/ab/cd/<artifact-hash>`이며 파일 0600/디렉터리 0700, 심볼릭 링크 거부·내용 해시 검사·원자적 쓰기를 유지한다. 원래 markup과 바이너리는 저장하지 않는다. 근거 캐시는 전문 보관소가 아니며 별도 JSON 파일이나 collector_meta.fulltext:* 복제본을 만들지 않는다. 기존 서비스 전문 저장도 별도 허가 경계를 유지한다.

engine_captures.content_hash는 **원본 응답 바이트**의 SHA-256이다. capture.data는 preparation identity/version/mode, 정규 직렬화한 검사 파생물의 derivative_hash, 선택적인 artifact_hash/format을 기록한다. raw_ref가 있으면 정제 텍스트만 가리킨다. 원본·파생물·파일 해시는 서로 다른 대상을 증명한다. ETag는 전체 제한 길이 값이 그대로 검사를 통과할 때만, Last-Modified는 제한된 정상 HTTP date일 때만 보관/재전송한다. 정제된 ETag를 새 validator로 쓰지 않는다.

store의 순서는 메모리 검증/직렬화 → 파일 쓰기/fsync/rename/디렉터리 fsync → capture·parse/link caches·fetch 완료·다음 checkpoint의 SQLite 단일 트랜잭션이다. 파일과 DB는 공동 원자적이지 않으므로 DB 확정 전 사망하면 참조 없는 **정제된** 파일이 남을 수 있다. 내용 주소 쓰기는 멱등적이다. crawl 잠금 아래 cleanup이 확정 참조를 조회하여 새 namespace 안에서만 24시간 지난 미참조 파일/임시 파일을 제거한다. **과거 raw/spool은 읽거나 재사용하거나 자동 삭제하지 않는다.** 과거 자료 정리는 별도 운영 작업이며 새 경로의 부재 검증이 과거 파일 삭제를 의미하지 않는다.

### 캐시와 복구

현재 source/URL, privacy/schema/parser/extractor/labeler/render/tool/selector/URL 정책의 정확한 identity와 준비 모드가 일치하고 검사된 parse 및 필요한 link 파생물(정상 빈 결과 포함)이 모두 유효해야 재사용한다. 파생물 해시와 스키마를 다시 검사한다. label/extract 캐시나 선택적인 텍스트 파일은 필수 조건이 아니다. label/extract만 없으면 parse에서 재생성하고 모델이 필요한 경우 원래 모델 기능·비용 제한을 따른다.

유효한 파생물이 있을 때만 conditional validator를 전송한다. 304 뒤에도 재확인하며 요청 중 파생물이 사라지면 기존의 무조건 요청 1회를 유지한다. 유효 304도 새 불변 capture를 만들고 원본 해시를 유지하면서 새 관측을 그 capture에 결속한다. parser/preparation 버전 변경, parse/link 손실, 렌더 모드 불일치는 **legacy raw 유무와 관계없이 fetch부터 다시 시작**한다. 재취득은 새 요청 비용·기존 시도 상한/예약/예산과 fetch_seq를 사용한다. 원본 구조를 보관하지 않아 기존 자료의 재파싱은 지원하지 않는다.

취득 확정 전 중단은 다시 계량하는 새 요청이 필요하다. 확정 후 render/parse는 원본을 읽지 않고 준비 모드를 확인하고 검사된 근거·링크의 후속 작업만 확정한다. 렌더 실패는 취득 실패 capture를 남기며 성공 복구는 새 capture를 만든다. 준비 실패는 원본 해시·안전한 출처와 고정 사유만 남길 수 있고 내용 캐시는 없다. 원래 예외 문자열과 임의 unsupported_tool 값을 실패 큐/로그에 기록하지 않는다. 이미 제출된 receipt 복구가 새 수집보다 우선하며 원래 추출/출처 manifest를 사용한다. 불변 capture/fact/claim slot/provenance/receipt/outbox 계약을 유지한다.

소스 발견기는 같은 문서/JSON 예산과 최종 검사 경계를 쓰며 원본 응답 파일이나 spool cleanup 의존성이 없다. 제공자 locator/cursor도 검사하고 URL-only 약관은 제목/요약을 보존하지 않는다. 제공자가 원본 응답 해시·바이트 길이를 필수 제공하며 매핑 결과의 해시를 원본 해시로 대체하지 않는다. collect cache는 정확한 준비/출처/URL 정책 identity에서만 받으며 legacy parse 버전의 substring fallback은 없다.

오프라인 테스트는 transport·memory-only 도구·렌더러·시계·난수·결함 지점을 주입한다. collector-pre-storage suites는 시도된 파일/SQL 바인딩, DB/WAL, 파생물, 로그, SIGKILL 후 새 프로세스 복구를 검사한다. 검증은 daemon이 고정 Node 22.22.3으로 집중 suite → 전체 tests → lint → typecheck 순서로 실행한다. 실제 소켓·fetch·Playwright 실행은 tests/setup.ts가 차단한다.

## 소스 발견기와 공유 비용

[소스 발견기](source-discoverer.md)는 같은 JobEngine·Scheduler·CostLedger·저장 포트를 사용하고 별도 실행 ID `agamajung-source-discovery`와 `source_candidates`를 사용한다. 사이트·기존 자료 접수에는 연결하지 않는다. Linux migration 최신 버전은 0004이며 0003 단독 마이그레이션도 유지한다.

`agamajung/cost-policy.ts`가 두 명령의 공통 비용 소유자 `agamajung`과 `profile.cost_caps.day`를 결정한다. 엔진은 일반적인 추가 `CostScope`만 받는다. 공유 day·run·추가 범위를 원자적으로 예약하고 같은 ticket으로 정산/고아 회수한다. 같은 scope는 중복 예약하거나 공통 cap을 대체할 수 없다. 당일 cap은 동결하며 다음 일일 scope는 현재 프로필 설정을 쓴다. 국소 일일 제한은 해당 작업만 deferred로 두고 다른 작업을 계속한다. 수동 retry는 원래 run 비용 계보와 attempts를 보존하며 접근 제한 실패는 retry로 해제하지 않는다. 발견기의 crawl 잠금은 collect/discover/retry와 공통이다.

## 빈 필드 탐색기와 서비스 출처 연결

Linux 최신 migration은 0005다. [빈 필드 탐색기](missing-field-explorer.md)는 공용 JobEngine의 별도 run·체크포인트·실패 큐와 crawl 잠금을 사용하며 외부 호출·비용 소비가 없다. 도메인 바인딩의 service 단계는 추출 버전/ID를 `submitExtracted()`에 전달한다. 서비스 assertion·불변 출처 연결·receipt는 원자적으로 저장되고 복구는 payload/출처 manifest digest를 함께 확인한다. 공용 엔진에는 모델/검수 정책을 추가하지 않는다. 파싱 검사 범위와 값·적용 조건을 통과한 preliminary completeness와 서비스 생명주기를 반영한 최종 커버리지를 구분한다.

## 영속 슬롯 실행 계약

최신 Linux migration은 0007이다. collect와 예약 실행은 [슬롯·따라잡기 운영](scheduling.md)의 공통 crawl 잠금·실행 의도를 사용한다. 기본 수동 collect는 현재 도래 슬롯 또는 기존 미완료 엔진을 처리한다. 날짜 단위 ID를 새 슬롯으로 재귀속하지 않는다. 완료 ID의 --resume·dry-run·disabled는 슬롯 성공을 갱신하지 않는다. pending은 체크포인트 기한 이후 같은 엔진을 재개하고 seed 완료 표시를 보존한다. 이전 실행이 다음 슬롯 뒤에 끝나도 최초 슬롯만 성공 처리한다. 같은 슬롯에서 새 논리 실행을 만드는 자동 재실행과 기존 엔진의 기한 기반 재개를 구분한다.
