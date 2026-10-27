# 아가마중 수집 프로필과 이행

설정은 [agamajung.json](../../crawler/profiles/agamajung.json), 구현은 `crawler/src/agamajung/`이다. 유모차·카시트·바운서·하이체어·아기띠를 다루며 기저귀·분유·물티슈는 제외 키워드다. 프로필은 기본 deny이고 허용 소스 id는 collector.json에 존재해야 한다. 프로필은 소스를 활성화하지 않는다. 제조사·수입사에서 시작해 브랜드 → 제품 라인 → 모델번호 → 연식/옵션 → 판매처 → 호환 부품 순으로 확장하는 운영 설정을 사용한다. Instagram/Facebook 계열·금지 호스트, 5초 미만 간격, 승인 없는 렌더/원문 저장은 validator가 거부한다.

라벨은 제품사양·설명서·호환성·판매제안·리콜·출시 여섯 종류다. validator는 라벨 id/한국어 대응과 정확한 집합·중복을 검사하며 사실 필드 vocabulary와 섞지 않는다. 필수 필드는 공식가·구성품·배송비·공구 조건·KC 인증·호환성·출시 연식이다. 누락은 completeness=missing으로 기록하고 정보 없음으로 취급한다. 가격·필드·시각을 추정해 채우지 않는다. 규칙 추출은 직접 명시한 항목만 source_claim, 키워드 라벨은 unverified, 모델 라벨은 ai_inference다. 엔진은 verified를 만들지 않는다. 공식가 권한과 msrp_explicit이 없으면 clue_price다.

네 계층은 engine_captures(raw 참조/해시) → engine_extracted(사실) → engine_labels(분류) → 기존 collection_records/evidence_assertions(로컬 서비스)다. 사이트 D1이나 UI에는 레코드를 전송하지 않는다. 기존 sync만 건수 스냅샷을 전송한다.

모든 추출 사실에는 출처 URL·locator·최대 300자 근거·collected_at·effective_from/basis·검증 상태·extractor 버전이 있다. 조건과 claim slot을 ID에 포함하고 값은 포함하지 않는다. ID에는 locator가 없으므로 같은 필드·정규화 조건의 모든 locator를 통틀어 결정적 slot을 부여해 다중 주장을 보존한다. 같은 ID/같은 불변 데이터 재삽입은 no-op, 다른 내용은 immutable_id_conflict다. capture/extracted/labels는 UPDATE/DELETE할 수 없다. 같은 배송비라도 body/set 조건은 두 행으로 보존한다. 원문에 적용일이 없으면 관측 시각만 사용한다. 첫 관측의 change_window_start는 NULL, 실제 이전 값이 달랐으면 그 관측 시각, 같으면 이전 창을 승계한다. 다른 출처의 충돌은 기존 evidence_conflicts 검수 경로로 양쪽을 보존한다.

연식/세대, 본체(body)/세트(set), 한국(KR)/해외(overseas)의 알려진 값이 다르면 합칠 수 없다. family 키·alias·document_origin·document 키·수동 override 후보 모두 검사하고 manual merge/link는 409 merge_forbidden이다. 충돌하는 옛 override는 삭제하고 merge_forbidden_split 이벤트와 lineage를 남기며 양쪽 그룹을 재검수한다. 축이 없으면 기존 family 키를 유지한다. 알 수 없는 축과 알려진 축의 수동 연결은 허용하지만 서로 다른 알려진 축은 거부한다. 기존 위반 그룹은 dedup-audit가 보고하며 --apply만 분리한다. 레코드 수는 변하지 않는다.

## 기존 518건 이행

운영 DB를 이 작업에서 열거나 수정하지 않았다. 합성 518건으로 건수·data 보존·백업·무결성·멱등 backfill을 검증한다. 아래 절차는 운영자가 실행한다.

1. serve/discover/sync와 다른 DB 사용자들을 정지한다. 기존 report total을 기록한다(운영 기준 518).
2. 저장소 밖 목적지 디렉터리를 0700으로 만들고 SQLite backup으로 이동한다. 실행 예: `sqlite3 crawler/.cache/collector.sqlite ".backup /workspace/agamajung/data/collector/collector.sqlite"`. DB 파일은 0600으로 확인한다.
3. COLLECTOR_DB/COLLECTOR_RAW_DIR을 [엔진 운영 문서](engine.md)처럼 주입한다. 기존 경로를 삭제하지 않는다.
4. 첫 CollectorStore open은 user_version<3이면 `<db>.pre-0003-<UTC>-<uuid>.sqlite`를 VACUUM INTO로 백업하고 0003_engine.sql을 트랜잭션으로 적용한다. 기존 18개 테이블·dedup_keys의 행은 수정하지 않는다. quick_check=ok, foreign_key_check=빈 결과를 확인한다.
5. `npm run collector:worker -- backfill-engine`을 실행한다. 고정 legacy run/capture와 legacy-store@1 사실을 추가하며 authorized도 source_claim과 legacy_level로 남긴다. raw·라벨·검증 상태를 만들어 내지 않는다. superseded_by로 실제 이전 관측이 확인된 경우만 변경 창을 기록한다. 원문 locator가 없던 행은 legacy:locator_missing으로 명시한다.
6. 같은 backfill을 다시 실행해 추가 0건을 확인한다. 수집 재개 전에 backfill을 끝낸다. 기존 fulltext:* 메타데이터는 건드리지 않는다.
7. 기존 report total과 collection_records data를 대조한다. `dedup-audit`로 기존 위반을 확인하고 필요한 경우만 --apply한다. 원본 DB와 백업을 보관한 뒤 수집을 재개한다.

0003은 Linux collector.sqlite 전용이며 사이트 `/migrations`와 독립적이다. 현재 최신 버전은 [소스 발견기](source-discoverer.md)의 0004이며 후보 큐·조건별 근거·질의·경로만 추가한다. 후속 마이그레이션은 현재 head를 확인하고 0005부터 번호를 잡는다.
