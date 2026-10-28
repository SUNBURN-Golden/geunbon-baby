# Linux 빈 필드 탐색기

`crawler/src/missing-field/`는 기존 Linux SQLite·JobEngine·발견기·검수 경로를 확장한다. 네트워크·모델 호출은 0회이며 값을 생성하거나 기존 사실을 UPDATE하지 않는다. 적격 근거가 없으면 `value: null`(정보 없음)이다. 사이트 D1·UI·Workers Cron·건수 전송 계약에는 탐색기 자료를 추가하지 않는다. Instagram 세션·계정·프록시를 사용하지 않는다.

## 실행

고정 Node 22.22.3과 저장소 밖 `COLLECTOR_DB`, `COLLECTOR_RAW_DIR`을 사용한다. 기존 0700 디렉터리·0600 파일·심볼릭 링크 검사와 `crawl` 실행 잠금을 공유한다. CLI는 `.env.crawler`를 자동으로 읽지 않는다.

```sh
export COLLECTOR_DB=/workspace/agamajung/data/collector/collector.sqlite
export COLLECTOR_RAW_DIR=/workspace/agamajung/data/collector/raw
npm run collector:worker -- explore-missing --dry-run
npm run collector:worker -- explore-missing
npm run collector:worker -- explore-missing --resume RUN_ID
npm run collector:worker -- missing-fields --json
npm run collector:worker -- missing-fields --id SLOT_ID
npm run collector:worker -- missing-field-actions --json
npm run collector:worker -- missing-field-metrics --run RUN_ID --json
npm run collector:worker -- failures list
npm run collector:worker -- failures retry CHECKPOINT_ID
```

일반 실행은 ID·상태·건수만 출력한다. 조회 명령은 정제된 로컬 자료만 JSON으로 반환하며 목록은 최대 500개다. 로그에 토큰·쿠키·원문 오류를 넣지 않는다. `--dry-run`은 오프라인 건수·지표 미리보기이며 run·진단·작업·비용을 저장하지 않는다. 다만 CollectorStore를 여는 기존 동작에는 스키마 적용과 정책 변경에 따른 검수 무효화가 포함된다.

`agamajung-missing-field-explorer` run은 고정 대상 manifest·기준 미충족 슬롯 목록·규칙 버전을 저장한다. 슬롯별 evaluate 체크포인트와 aggregate 체크포인트를 사용한다. 자동 재시도·lease·실패 큐는 JobEngine의 최초 포함 3회 제한을 따른다. 실패 retry는 원래 기준 집합과 parent_run을 유지하는 탐색기 runner로 분기한다. 완료된 run도 `--resume`하면 변경된 입력과 지표를 다시 평가하며 기준 분모는 바뀌지 않는다.

## 슬롯과 네 분류

슬롯 ID는 `대상 참조 + 필수 필드 + 정규화 조건`이다. 프로필 `required_fields`의 모델 범위는 공식가·구성품·KC 인증·호환성·출시 연식, 판매제안 범위는 배송비·공구 조건이다. 연식·세대·body/set·시장·옵션을 분리하고 판매처·채널·제안·명시적 적용 기간도 보존한다. KC에는 명시적 KR 조건이 필요하다. 적용 여부 미확인은 분모에서 빼지 않는다.

판매제안은 배송비·공구 조건·가격 단서 전체에서 먼저 열거한 뒤, 각 제안마다 배송비와 공구 조건을 모두 검사한다. A의 배송비와 B의 공구 조건만 있어도 A의 공구 조건·B의 배송비를 분모에 포함한다. 배송비 슬롯은 비어 있을 때부터 `currency: KRW`로 정규화하므로 실제 무료 배송 수집 후에도 같은 슬롯과 기준 갭으로 추적된다. 통화는 공구 조건 슬롯에 전파하지 않는다.

확인된 `target_model_id`가 없으면 문서별 임시 대상을 사용한다. 같은 중복 그룹이라는 이유만으로 다른 문서의 값으로 채우지 않는다. 대상 연결이 변경되면 이전 run manifest·불변 진단·기준 집합을 보존하고 `missing_target_relinked` 이력을 남긴다.

재개 및 평가 commit은 고정 manifest의 슬롯이 현재 대상에도 적용되는지 확인한다. 사라진 슬롯은 stale로 보존하고 현재 목록·실행 슬롯 수에서 제외한다. `missing-fields --id`로 과거 슬롯을 조회하면 `retired: true`, `stale: true`, `fulfilled: false`를 반환한다. 대상 변경은 기존 갭의 해결로 계산하지 않으며 고정 기준에서는 `untracked`로 남긴다.

| 원인 | 확정에 필요한 자료 | 로컬 후속 작업 |
| --- | --- | --- |
| `unextracted` | 동일 규칙 진단기가 본문 위치·값 후보를 인식했지만 해당 capture의 추출 사실에 없음 | `improve_extractor`, capture·extract 체크포인트 연결 |
| `not_in_source` | 정상 완료한 명시적 검사 영역에서 정보가 없음 | `reverse_search`, 발견기 질의 연결 |
| `inaccessible` | 로그인·차단·권한·robots 거부·HTTP 200 로그인/빈 페이지 기록 | `hold_access`, 사유 기록 후 보류 |
| `conflict` | 공통 판정기가 동일 범위의 실제 상충 주장으로 판정 | `review`, 기존 검수 충돌 ID 연결 |

원인은 출처별이며 같은 슬롯에 여러 원인이 공존할 수 있다. 캐시 없음·잘림·표 일부만 검사·도구 실패·개인정보 정제로 검사 범위 손실·연결 불가·조건/호환 의미 미확인은 `assessment_pending`이다. 이는 다섯 번째 원인 분류가 아니다. 표제만으로 미추출이라고 하지 않는다. 값 후보와 현재 추출 사실이 있는데 서비스 연결만 없으면 미추출로 재분류하지 않는다.

`배송비는 무료입니다.`처럼 필드 단서가 있으나 지원하는 추출 구문이 아닌 문장은 진단기의 거부 후보와 위치를 남기고 `field_candidate_rejected`로 판정 대기한다. 이를 원문 부재로 분류하거나 역검색 요청으로 보내지 않는다. 진단 단서는 값을 추출·보완하는 근거로 사용하지 않는다.

필드 단서는 정제된 검사 영역의 각 줄 전체에서 검사한다. 진단 인용의 300자 제한 때문에 뒤쪽 단서를 버리지 않는다. 접근 실패는 최신 capture의 상태·사유 또는 그 capture ID에 결속된 실패 체크포인트로만 판정한다. 렌더링 중 HTTP 200 로그인/빈 페이지도 보류하지만, 이후 정상 capture나 같은 체크포인트의 성공적 재개에는 과거 실패를 적용하지 않는다. 접근 실패 상태는 평가 입력 digest에 포함하며 `missing-field@4`에서 이전 진단을 재평가한다.

파싱 캐시에는 검사 영역·도구 상태·잘림·정제 변화·`sanitized_text` locator 공간을 기록한다. 부재는 그 capture의 검사 영역과 시점에만 적용한다. 구버전/모호한 캐시는 부재 증거가 아니다. 원문을 못 본 경우 다른 출처 검색 성공만으로 부재를 확정하지 않는다.

## 실제 근거만 인정

Linux 전용 migration `0005_missing_field_explorer.sql`을 CollectorStore 개방 시 적용한다. 네 저장 계층은 기존 테이블을 유지한다.

```text
engine_captures → engine_extracted → engine_labels
                      ↓ extracted_assertion_links
                evidence_assertions / collection_records
```

신규 수집의 `submitExtracted()`는 capture·추출 버전·사실 ID·정제된 주장·출처·locator·인용을 확인한다. 개인정보 필터는 주장마다 따로 적용하여 배열에서 탈락한 항목 때문에 ID 대응이 이동하지 않는다. assertion·일대일 출처 연결·검수 무효화·receipt·outbox는 하나의 서비스 트랜잭션이다. HTTP/clipper 접수의 임의 추출 ID는 연결하지 않는다. receipt는 payload와 출처 ID manifest digest를 모두 결속한다. 서비스 commit 후 엔진 체크포인트 전 종료되어도 원래 receipt를 복구하며 철회 상태를 초기화하지 않는다. 같은 추출 사실을 새 예약에 재접수하면 `provenance_reused`다. 새 관측에는 새 capture가 필요하다.

충족에는 다음을 모두 요구한다.

- 실제 capture·추출 사실·서비스 assertion의 불변 연결, 활성 상태 및 유효한 값·조건
- 정상 capture의 출처 URL·해시·수집 시각, 적용 시점과 stated/observed 근거, extractor 버전
- 정제된 파싱 본문의 정확한 줄 locator와 인용, 같은 규칙 진단기로 재확인한 주장
- `verified` 또는 `source_claim` 사실, 현재 범위에 미해결 충돌·판정 대기 없음
- 공식가는 제조사/수입사 권한과 명시적 MSRP, KC는 scheme=KC 및 market=KR

해시만 있고 본문 구간을 확인할 수 없으면 충족하지 않는다. 검색 요약·AI 추론·미검증 값·연결 없는 사실·철회/대체·해결된 충돌의 비선택 주장은 제외한다. `source_claim`은 근거 확보일 뿐 사람 검수 완료가 아니다. 숫자 0은 실제 무료 배송일 때만 금액 값으로 유효하며 `정보 없음`, 빈 배열/객체, `원문 확인 필요`는 값으로 세지 않는다.

탐색기는 미추출 값을 직접 서비스에 넣지 않는다. 규칙 개선 뒤 기존 `collect`가 새 capture·사실·근거로 접수해야 한다. 파이프라인 `completeness_stage=preliminary`는 공통 값/적용 조건 검사이며 최종 충족에는 서비스 생명주기 검사가 추가된다.

기존 자료는 `backfill-engine`으로 명시적 `data.legacy_id`와 실제 assertion의 내용·출처를 검증하여 연결한다. native 연결이 있으면 중복 사실을 만들지 않는다. 과거 중복 사실은 삭제하지 않는다. 값·URL 유사성만으로 자동 매칭하지 않는다. legacy capture에 본문 근거가 없으면 연결이 있어도 충족하지 않는다.

## 병합과 검수

`merge-rules.ts`는 활성 독립 사실과 모든 사실의 조건에서 연식·세대·body/set·시장을 검사한다. 연도/세대 형식을 검증하고 서로 다른 세대를 임의의 동의어로 처리하지 않는다. 상충 축은 양쪽을 남기고 모든 자동 후보·수동 merge·근거 link에서 거부한다. 알 수 없는 축의 수동 연결은 허용하되 탐색기가 미확인 조건을 채우지는 않는다.

검사 범위에는 그룹 구성원뿐 아니라 이미 연결된 모든 활성 근거와 해당 원본 레코드의 독립 축도 포함한다. 축이 미확인인 그룹에 2025 근거를 연결한 뒤 2026 근거를 추가하는 것은 거부한다. 과거에 허용된 링크도 현재 `dedup-audit`에 보고하며 상충 상태에서는 탐색기 충족과 verify/ready를 차단한다.

`dedup-audit`는 과거 그룹과 문서 내부 축 모순을 보고한다. 운영자가 기존 `dedup-audit --apply`를 실행하면 가능한 그룹 분리와 감사 이력·검수 무효화를 수행한다. 문서 내부 모순은 자동으로 값을 고르지 않으므로 원문 검수가 필요하다. apply 전에도 위반 그룹의 탐색기 충족과 verify/ready는 차단된다.

`evidence-policy.ts`의 공통 판정은 동일 주장 / 공존 / 다른 범위 / 실제 충돌 / 판정 대기를 구분한다. 배송비도 판매처별로 분리한다. origin만 같은 두 문서를 같은 제안으로 단정하지 않는다. 명시적으로 겹치지 않는 기간은 분리하며 수집 시각 차이는 적용 기간 차이가 아니다. `호환성: EX-A | 호환` 같은 명시적 부품·긍정/부정 규칙만 구조화한다. 자유문은 의미가 불명확하면 보류한다. 다른 부품·인증·리콜 항목의 존재 자체를 충돌로 만들지 않는다. 문서 내부 모순도 검사한다.

충돌 행·사람 선택·사유는 삭제하지 않는다. `evidence_conflict_evaluations`는 규칙 버전·입력 digest·현재 비교와 선택 유효성을 불변 이력으로 보존한다. 정책 변경 시 기존 충돌을 현재 활성 근거로 재평가하고 오탐을 현재 차단 목록에서 제외한다. 의미가 모호해진 과거 선택은 승계하지 않는다. 변경/승인 그룹은 재검수가 필요하며 오탐 해제만으로 자동 승인하지 않는다. 조회·verify/ready·해결·건수 집계·탐색기가 같은 현재 판정을 읽는다.

선택 근거가 철회/대체되거나 원본 문서·적용 기간이 만료되면 갭이 재개방된다. 공통 충돌 판정기의 `reopened`를 검수·조회·집계·탐색기가 함께 사용하며 비선택 주장을 자동 채택하지 않는다. 새 근거의 명시적 충돌 해결 또는 기존 범위의 새 선택이 필요하다. 선택은 그룹·주장 ID·조건에 결속하며 다른 그룹으로 전파하지 않는다.

## 발견기 연결

역검색은 정제된 본문에 명시된 모델번호와 확인된 조건을 사용한다. KC 역검색에는 KR 근거도 필요하다. 기존 `feedbackQueries()`/`query()`의 공통 질의 생성기·결정적 질의 ID·재검색 기한을 사용한다. 연식·세대·구성·시장·옵션·판매처/채널을 질의에 보존한다. 문서 대상 참조는 결정적 entity ID로 매핑하고 원래 슬롯은 작업 연결에 남긴다.

슬롯의 누락·빈 조건은 본문에서 확인한 옵션·판매처를 덮어쓰지 않는다. 확인된 조건이 서로 다르면 해당 원문 대상으로 질의를 생성하지 않는다. `missing-field@5`는 이전 평가·역검색 작업을 재평가하며 과거 이력은 보존한다.

질의 등록·작업 연결은 탐색기 commit 안에서 처리한다. `discover-sources`가 현재 미해결 작업의 질의를 승인된 제공자·공유 비용 원장·깊이·페이지·질의 상한 안에서 소비하며 run·request 체크포인트를 연결한다. 원래 capture의 깊이를 계승하고 재실행으로 0으로 되돌리지 않는다. 제공자 비활성·모델번호/KR 근거/깊이 부족은 명시적 deferred 연결이다. 비용 제한은 발견기 체크포인트의 기존 비용 보류/실패 사유로 남는다.

결과 근거의 `capture_id`는 검색 응답을 가리킨다. 역검색을 유발한 원본은 별도 `origin_capture`로 체크포인트와 `source_discovery_paths.data`에 보존하고 후보 상세 조회에도 반환한다. `parent_id`는 기존 후보의 ID로만 사용한다. 같은 검색 근거를 재사용해도 원본별 경로를 보존하며 후보·사실을 중복 생성하지 않는다.

후보는 `source_candidates`에만 저장한다. 후보 발견은 수집 허가·필드 해결이 아니다. 승인된 본문을 실제 수집한 다음 탐색기를 재개해야 한다. 접근 제한은 중단 기록을 재사용하며 로그인·계정 교체·프록시·robots 우회를 추가하지 않는다. `hanset.mag` 세션을 조작하거나 로그아웃하지 않는다.

## 지표와 동시 변경

- 근거 확보 커버리지 = 적격 근거로 충족된 슬롯 / 전체 필수 슬롯
- 검수 완료 커버리지 = 충족되고 현재 그룹의 검수가 유효한 슬롯 / 전체 필수 슬롯
- 갭 해소율 = 고정 기준 시점 미충족 슬롯 중 현재 충족된 슬롯 / 기준 미충족 슬롯

전체·필드별·모델/판매제안별 분자/분모를 반환한다. 분모 0은 `rate:null`, `status:not_applicable`이다. 새 대상 유입은 갭 해소율 분모를 바꾸지 않는다. 병합/분리로 사라진 슬롯은 해결 대신 `untracked`다. 원인 건수는 출처별이므로 합계를 전체 갭 수로 표시하면 안 된다. 작업 생성·검색·후보 발견은 해결 수가 아니다. 철회·충돌로 재개방되면 현재 해결 수에서 빠진다.

검수 완료는 연결된 assertion이 현재 범위에 있고 `verified_evidence_version === evidence_version`이며 개인정보 정책·재확인 기한이 유효할 때만 인정한다. 과거 verify 이벤트나 다른 그룹의 승인을 사용하지 않는다.

serve의 변경과 공존하므로 실행 잠금만으로 일관성을 가정하지 않는다. 입력 digest에는 서비스 assertion 상태·그룹 버전/검수·현재 충돌·capture/parse/출처 연결과 정책 버전을 포함한다. commit 전 변경되면 BEGIN IMMEDIATE 안에서 재평가한다. 근거·그룹·검수 변경은 슬롯을 stale로 표시하고 조회도 digest·기한을 다시 검사한다. stale 결과는 `fulfilled:false,value:null`이다. 집계는 하나의 일관된 트랜잭션에서 생성하고 스냅샷의 `current`는 조회 시 현재 입력과 비교한다. 과거 스냅샷을 현재 수치로 사용하지 않는다.

롤아웃 시 기존 [동시 실행·고정 SQLite 절차](../../crawler/README.md#동시-실행과-잠금)를 따른다. 0004 자료는 보존되며 0005의 연결·진단·작업·평가·지표는 외래키와 불변성 제약을 가진다. 테스트는 비식별 fixture와 임시 외부 DB로 네트워크를 차단한다.
