# Linux 소스 발견기

`discover-sources`는 새 출처를 찾아 Linux SQLite의 `source_candidates`에 **discovered**로만 저장한다. 후보는 수집 허가·공식 출처·공식가 근거가 아니다. 사람이 출처·약관·영역을 평가하고 기존 수집 설정에 별도로 승인해야 수집할 수 있다. 사이트 D1, UI, 기존 자료 접수·중복 그룹·outbox·5단계 건수에는 연결하지 않는다. Instagram worker나 공유 브라우저 세션을 사용하지 않는다.

## 실행

Node 22 이상, Linux, 외부 `COLLECTOR_DB`와 `COLLECTOR_RAW_DIR`이 필요하다. 디렉터리 0700·파일 0600·심볼릭 링크 검사를 기존 엔진과 공유한다. `collector:worker`는 `.env.crawler`를 자동으로 읽지 않으므로 환경을 직접 주입한다.

```sh
export COLLECTOR_DB=/workspace/agamajung/data/collector/collector.sqlite
export COLLECTOR_RAW_DIR=/workspace/agamajung/data/collector/raw
export COLLECTOR_DISCOVERY_CONFIG=/workspace/agamajung/data/collector/source-discovery.json
npm run collector:worker -- discover-sources --dry-run
npm run collector:worker -- discover-sources
npm run collector:worker -- discover-sources --resume RUN_ID
npm run collector:worker -- source-candidates --json
npm run collector:worker -- source-candidates --id CANDIDATE_ID
npm run collector:worker -- engine-status --json
npm run collector:worker -- failures list
npm run collector:worker -- failures retry CHECKPOINT_ID
```

설정 파일의 출발점은 `crawler/config/source-discovery.json`이다. 기본값은 전체 비활성·제공자 없음·탐색 소스 없음이다. **새 명령의 dry-run은 완전 오프라인 계획 조회**이며 요청·후보 삽입·비용 예약/정산·고아 예약 회수를 하지 않는다. DB 열기에 따른 스키마 적용은 가능하다. 기존 `discover --dry-run`은 네트워크 검사와 업무 예산을 사용하는 별도 명령이다.

일반 실행 출력은 run ID·상태·후보 수·체크포인트 건수·잘린 체크포인트 수다. 상세 URL·조건·인용·검증 상태·보류 사유는 후보 조회로만 확인한다. 목록은 최대 500건이며 상세는 ID로 조회한다. 낮은 점수와 식별 손실 후보도 검토용으로 보존한다.

## 설정과 제공자 허가

설정은 `COLLECTOR_DISCOVERY_CONFIG`로 선택하며 미지정 시 체크인된 비활성 파일을 쓴다.

- `regions`, `languages`(ko/en), `years`(연도 또는 current), `events`의 한국어/영어 사전과 프로필 카테고리의 곱을 커서로 계획한다. 연도·차원·제공자 순서는 run 시작 시 고정한다. 배열 전체 곱을 생성하지 않는다. `max_queries`는 페이지·환류를 포함한 run 작업 수를 제한한다.
- `source_ids`는 기존 `COLLECTOR_CONFIG`의 enabled 소스 중 아가마중 프로필 `domain_policy.sources`에도 승인된 정적 문서 소스만 가리킨다. 제조사 → 수입사 → 카탈로그 → 공식 판매처 → 정부 순이다. 기존 설정의 CPSC API는 제품 사실 수집용이며 이 문서 탐색 명령에서는 제외한다.
- `source_hints`는 소스 ID별 검색 관련도용 카테고리·지역 등의 명시적인 문맥이다(예: `{"catalog":"유모차 KR"}`). sitemap index처럼 본문 단서가 없는 목록 탐색에 사용할 수 있다. 제품 사실·시장 조건으로 승격하지 않는다.
- `pagination_selectors`는 소스 ID별 기존 단순 selector 문법으로 다음 페이지 링크를 지정한다. `rel=next`도 지원한다. 번호나 경로를 만들어 요청하지 않는다.

JSON API 제공자 항목 예시(합성 주소, 실제 서비스 이용 허가를 의미하지 않음):

```json
{
  "id": "example-search",
  "enabled": false,
  "endpoint": "https://search.example.org/api/search",
  "query_param": "q",
  "cursor_param": "cursor",
  "results_path": "results",
  "url_path": "url",
  "title_path": "title",
  "summary_path": "summary",
  "next_cursor_path": "next",
  "auth_env": "COLLECTOR_SEARCH_API_KEY",
  "terms": {
    "status": "unconfirmed",
    "basis": "",
    "checked_at": "",
    "storage": "none",
    "cursor_storage": false
  }
}
```

요청하려면 전체 `enabled`, 제공자 `enabled`, 약관 `status=approved`, 정제된 허가 근거·확인 시각, `storage=urls|snippets`가 모두 필요하다. 허가·결과 보관 권한은 운영자가 확인한다. `urls`는 제목·요약을 저장하지 않는다. cursor 보관이 허용되지 않거나 영숫자/밑줄/하이픈 128자 이내가 아니면 다음 페이지를 중단하고 잘림으로 보고한다. 점 구분 필드 경로만 지원하며 실행 코드·임의 JSONPath를 받지 않는다.

인증은 해당 환경변수의 Bearer 값을 **정확한 고정 endpoint에만** 붙인다. endpoint에 쿼리·userinfo·fragment·비표준 포트를 넣을 수 없고 모든 리디렉트를 거부한다. DNS 결속·공개 주소 검사·30초 제한·응답 크기·도메인 간격·중단 상태와 비용 예약은 기존 Scheduler를 통과한다. 인증 헤더·완성된 검색 요청 URL·원래 응답은 DB·체크포인트·로그에 저장하지 않는다. 응답의 해시·바이트 수와 허용된 정제 결과만 남긴다. 실제 검색 공급자의 약관을 이 구현이 확인한 것은 아니다.

## URL과 경로

기존 `canonicalUrl()`의 허용 범위를 넓히지 않는다. 새 후보 경로는 원시 링크를 추출한 직후 전용 정책에 전달한다. 같은 파서를 사용하는 기존 `discoverLinks()` wrapper는 기존 자료 URL 정규화를 유지한다.

`url_policies` 예시:

```json
{
  "host": "shop.example.org",
  "path": "/item",
  "version": "shop-item@1",
  "keys": {"product_no":{"format":"code","max_length":40}},
  "required_keys": ["product_no"],
  "duplicates": "reject"
}
```

정확한 호스트·경로에서만 검증된 식별자를 보존한다. `code`는 문자·숫자·밑줄·점·하이픈, `digits`는 숫자만 허용한다. 대소문자는 유지하고 인코딩·매개변수 순서는 정규화한다. 추적 매개변수는 제거한다. 민감 키는 정책보다 우선하여 제거한다. 알 수 없는 키·중복·부적합 값·필수 키 누락·fragment·민감 매개변수로 동일성을 보장할 수 없으면 `identity_loss`, `canonical_url=NULL`로 저장한다. 손실 링크는 정제 표시 URL로 합치지 않고 capture·locator로 식별한다. 위험한 구조는 목적지를 저장하지 않는다. 제거한 원래 URL이나 값을 ID 재료에 넣지 않는다. 후보에는 적용 URL 정책 사본을 보존하고 조회에서도 검증하여 설정 변경 후에도 식별자가 유지된다.

검색 목적지는 기본적으로 후보만 기록한다. 미등록 목적지에는 HEAD·robots·본문 요청을 보내지 않는다. 후속 이동도 이미 승인된 문서 영역·안전한 URL 정책을 모두 통과해야 한다. SNS·주문·첨부는 부모 관계로 남긴다. Instagram 등 금지 호스트에는 방문하지 않는다. 첨부는 승인 후 기존 collect의 PDF/OCR 경로에서 다룬다. 표시 URL만 있고 raw_ref가 없는 손실 후보는 원래 목적지를 복구할 수 없다. 원문 참조·해시는 연결된 capture에서 확인한다.

시작 깊이는 0, 링크·검색 결과·개체 검색 환류는 +1, 페이지네이션은 같은 깊이다. 경로·조건·깊이는 체크포인트에 남고 재개·환류로 초기화하지 않는다. 순환 URL·cursor·목록 상한·500개 파서 잘림은 중단/잘림으로 기록한다. 관련도는 브랜드/모델 30·카테고리 25·지역/언어 15·연도/행사 15·승인된 직접 관계 15의 중복 없는 규칙 점수다. 제외 품목·명시적 모델 불일치·식별 손실·임계값 미달은 추가 탐색을 막는다.

명시적인 브랜드 → 제품 라인 → 모델번호 → 연식/옵션 → 판매처 → 호환 부품·행사명을 검색에 환류한다. 기존 extracted 사실도 사용한다. 필수 필드 조회는 같은 대상·정규화 조건에서만 비교한다. KC 역검색은 명시적인 모델번호와 KR 조건이 있을 때만 생성한다. 결과 없음은 부재 증거가 아니며 값이나 시장·연식·body/set을 추정하지 않는다. 모델 호출은 0회다.

## 저장·비용·복구

Linux 전용 `0004_source_discovery.sql`이 후보·불변 근거·질의·추가 경로 근거를 만든다. 기존 0003 및 자료는 보존한다. 후보는 `(profile, canonical_url)`, 근거는 `(candidate,capture,locator,relation,subject,conditions,claim_slot,extractor)`로 멱등이다. 정제된 주장들을 정렬·완전 중복 제거하여 slot을 배정한다. 같은 조건의 상충 주장도 별개다. 동일 ID의 다른 내용은 무결성 오류이고 기존 근거를 덮어쓰지 않는다. 같은 capture의 재처리는 관측 횟수·시각을 늘리지 않는다. 후보 관측 수는 근거의 서로 다른 capture 수다. 같은 주장을 재사용한 경로의 부모·질의·깊이는 별도 추가 기록으로 남긴다.

원문은 기존 외부 raw capture의 참조·해시, 추출은 기존 extracted 사실, 라벨은 기존 여섯 분류, 로컬 후보 큐는 별도 service 용도다. 검색 요약은 제품 사실이 아니며 `unverified`, 직접 본문 링크 단서는 `source_claim`이다. 근거는 URL·위치·관측 시각·적용 시점/근거·extractor 버전을 가진다. 명시적 시점이 없으면 capture 시각과 observed를 쓴다. 연식·세대·body/set·KR/해외·옵션이 다른 근거는 분리한다.

| 제한 | 기본값 |
| --- | --- |
| 의미 깊이 / 추가 탐색 점수 | 2 / 50 |
| 발견 run | 40 요청·20MiB |
| 발견 KST 일 | 100 요청·50MiB |
| 소스 및 origin KST 일 | 각 20 요청·10MiB |
| endpoint별 제공자 KST 일 | 20 요청·10MiB |
| 목록 페이지 / 신규 후보 KST 일 | 최대 20 / 500 |
| 응답 / 요청 간격 | 기존 최대 2MiB / 5초와 Crawl-delay 중 큰 값 |
| 재시도 / 모델 호출 | 최초 포함 자동 3회 / 0회 |

실행 ID는 `agamajung-source-discovery`, 공통 비용 소유자는 collect와 같은 `agamajung`이다. 공유 일일 cap은 **공통 프로필의 600 요청·300MiB**이며 발견기 설정으로 덮어쓸 수 없다. 모든 추가 범위를 같은 트랜잭션에서 검사·예약하고 한 ticket으로 정확히 한 번 정산한다. origin·endpoint 키를 공유하므로 소스/제공자 별칭으로 한도를 늘릴 수 없다. robots·리디렉트·실패·재시도도 실제 요청마다 소비한다. 고아 예약은 전량 소비로 회수한다. 신규 후보 한도는 삽입과 함께 적용하며, 응답이 잔여 한도보다 크면 저장한 prefix 다음부터 다음 날 계속한다.

당일 원장 cap은 생성 후 동결된다. `engine-status`의 cap/held/spent가 현재 값이고 `next_day_shared_caps`는 현재 공통 설정이다. 새 날짜는 재개 run의 옛 계획이 아니라 현재 공통 프로필 설정으로 생성한다. 공유 일일 한도는 두 명령을, 발견 일일 한도는 발견기만, 소스/origin/제공자 한도는 해당 작업만 다음 KST 자정까지 보류한다. 다른 소스는 계속한다. run 상한은 exhausted가 되고 다음 슬롯이 미완료 작업을 이월한다. 기존 인테이크 업무 예산은 별도다.

실행·실패 재시도는 collect/discover와 같은 crawl 잠금을 쓴다. serve/sync와 WAL을 공유한다. 단계 결과·후속 작업·후보·근거·질의 cursor를 한 트랜잭션으로 확정한다. 영속 응답 캐시가 있으면 재요청하지 않는다. 영속화 전 죽은 요청은 재시도될 수 있고 다시 계량한다. 저장 멱등성을 보장하며 외부 요청의 exactly-once는 보장하지 않는다. 수동 retry는 실행 종류를 보존하고 원래 run의 비용·attempts를 이어받는다.

403·HTTP 200 로그인/빈 HTML/challenge는 영속 halt와 안전한 사유 코드로 남긴다. 정상 JSON 빈 배열은 성공이다. 자동 재시도·새 슬롯·수동 실패 retry가 접근 제한을 해제하지 않는다. 운영자가 원인·허가를 확인한 후 기존 도메인 중단 상태 및 해당 halted run을 명시적으로 검토해야 한다. 계정 교체·사람 위장·프록시·robots/약관 우회·공유 계정 로그아웃을 하지 않는다.

테스트는 `tests/source-discovery-*.test.ts` 및 기존 엔진·파서·개인정보·스케줄러 회귀 테스트다. fixture는 비식별 합성 데이터이며 소켓·fetch·브라우저 차단을 유지한다. 필수 검증은 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, Workers 경계는 `npm run build:worker`다.
