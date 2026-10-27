# 03 · 사실 메타데이터·불변 원장·정정 이력

[온톨로지](02-ontology.md) · 다음: [Daemon](04-daemon-roles.md)

## 모든 사실에 붙는 envelope

관계 fact도 값 fact와 같은 메타데이터를 갖는다. `subject_id`는 안정 ID이고 aliases는 entity_aliases에서 참조한다. 가격은 정수 KRW 또는 null이며 null을 0으로 해석하지 않는다.

| 구분 | 필드·의미 |
| --- | --- |
| 식별 | `fact_id = H(capture_id, extractor@version, subject_id, predicate, conditions_key)` 또는 검수 이벤트를 포함한 결정적 ID. 여러 주장은 정규화된 조건/주장 슬롯으로 분리 |
| 내용 | subject_id, predicate, conditions_key(Offer revision·가격 종류·통화·판매 채널 등), value 또는 object_id |
| 출처 | source_id, capture_id, source_url, evidence_ids → evidence_snippets, content_hash |
| 시간 | collected_at(수집), observed_at(원문 관측), effective_from(실제 적용 시작), effective_from_basis=`stated/observed`, change_window_start, effective_to |
| 검증 | fact_status, verification_basis, reviewed_by/reviewed_at, extractor/version, review_event_id, 권한 정책 버전 |
| 권한·보관 | license, permission_basis, retention_until(필드 자체 필수, 무기한은 null), raw 참조의 보관 정책 |
| 정정 | superseded_by, corrections의 사유·행위자·기록 시각 |

DB의 제약용 필드는 열로 두고 나머지 envelope는 기존 idiom인 `data TEXT CHECK(json_valid(data))`에 둔다. WU-02 validator가 열과 JSON의 동일성·전체 필수 필드·UTC 정규형·ID 참조를 검사한 뒤 같은 트랜잭션으로 저장한다. SQL의 json_valid만으로 envelope가 검증되었다고 보지 않는다. 인용·원문을 facts.data에 중복 저장하지 않는다.

`collected_at`과 `effective_from`은 다르다. 명시된 적용일이 있으면 stated, 없으면 observed_at을 effective_from의 관측상 경계로 사용한다. 실제 변경 순간을 알았다는 뜻은 아니다. observed이면 `change_window_start`는 이전 값의 마지막 관측 시각, 첫 관측으로 이전 값이 없으면 null이다. 실제 변경 창은 `(change_window_start, observed_at]`로 답한다. 지연 검수 시 reviewed_at을 effective_from으로 쓰지 않는다.

인용은 fact가 아닌 `evidence_snippets`에 최대 300자로 둔다. evidence_locator는 CSS/JSON pointer/PDF 페이지·표/캡션 영역과 주변 제품·옵션 식별 문구를 담는다. capture·본문 해시와 묶어 위치가 이동해도 당시 근거를 찾는다. 보관 만료 시 quote만 NULL로 지우고 quote_hash·locator·purged_at을 남긴다. 원문 재수집으로 만료를 임의 연장하지 않는다.

## fact_status와 검수

| 상태 | 의미 | 확정 답·전이 |
| --- | --- | --- |
| verified | 허용된 검증 근거가 있는 사실 | 상충·구성·stale 규칙도 통과해야 사용 |
| source_claim | 출처가 실제 주장한 값, 아직 서비스 검수 전 | 검수 큐, 비교 제외 |
| ai_inference | AI가 추론한 관계·값 | 검수 큐 전용, 직접 승격 금지 |
| unverified | 대상·값·근거 일부 미확인 | 검수 큐, 비교 제외 |

verified는 다음 verification_basis 중 하나를 요구한다.

- `human_review`: 사람이 원문 위치·대상·조건을 확인했고 review_events에 행위자·시각·근거 IDs·검수 범위가 있다. source_claim에서 verified를 만들 때는 레지스트리 official_fields의 해당 필드 권한도 필요하다. 공구 단서는 직접 판매처 근거를 새로 확보해 그 소스에서 검증한다.
- `legacy_admin_approval`: 기존 관리자 승인 deals(0001/0011). 원래 승인자 미기록 플래그를 남긴다. 가격·기간 등 실제 승인 필드만 포함하며 미기록 구성까지 verified로 넓히지 않는다.
- `public_db_record`: 공공 DB 레코드 자체의 존재. reviewed_at은 레코드 검증 이벤트 시각이며 사람 검수로 가장하지 않는다. 국내 대상 적용 관계는 사람 검수 전 unverified다.

상태를 UPDATE하지 않는다. 사람 검수는 새 verified fact를 만들고 원래 source_claim/ai_inference를 남긴다. 특히 AI fact ID를 새 verified로 재사용하지 않는다. AI 제안을 보았더라도 사람이 독립된 원문 근거를 지정한 새 fact만 확정할 수 있다. 검수 대상 변경 시 과거 승인을 재사용하지 않는다.

## 변경·정정·상충·역순 도착

키 K=`(subject_id,predicate,conditions_key)`다. conditions_key에 Offer revision과 통화·가격 종류를 넣어 다른 판매 조건을 섞지 않는다. source_id는 K에 포함하지 않아 다른 출처의 상충을 발견할 수 있다.

| 상황 | 판정 | 처리 |
| --- | --- | --- |
| 같은 소스 새 capture, 값이 달라지고 새 적용 시각 > 현재 구간 시작 | 정상 변경 후보 | source_claim 단계에서는 구간 유지. 검수 후 한 트랜잭션으로 이전 구간 닫기·새 verified fact·필요한 twin 추가 |
| 같은 기간의 이전 값이 틀렸다는 정정 공지·사람 판단 | 정정 | 이전 superseded_by를 새 fact ID로 설정, 해당 기간 새 fact 추가, corrections에 사유·행위자·근거 보존 |
| 다른 소스가 겹치는 기간에 다른 값 주장 | cross_source 상충 | 양쪽 원문 주장을 보존하고 fact_conflicts 추가, Q1 금액 보류 |
| 같은 소스 두 capture가 같은 적용 기간에 다른 값 | same_source_flip 상충 | 덮어쓰지 않고 검수. 변경 시점이 구별되지 않으면 정상 변경으로 단정 금지 |
| 서로 다른 Offer revision 값 | 다른 K | 상충 아님 |
| 늦게 도착한 관측(관측 시각 < 현재 열린 구간 시작) | 역사 보강 후보 | 현재 구간을 닫지 않음. 해당 과거 구간과 같으면 확인 관측만 추가, 다르면 late_divergent 검수. 가장 이른 구간보다 앞이면 자동 삽입하지 않고 검수 |

시간이 다르더라도 출처가 달라지는 경우에는 먼저 동일 판매 조건·권한·실제 적용 기간을 확인한다. 겹치지 않는 검증된 적용 기간이면 정상 변경 가능하고, 관측일만 다르다고 상충이 해소되는 것은 아니다. 하나의 키에 상충하는 verified 구간 두 개를 넣지는 않는다. 두 주장은 source_claim 원본으로 보존하고, 이미 verified인 쪽도 미해결 conflict로 projection에서 보류한다.

corrections와 conflict_resolutions는 append-only다. 해결은 기존 conflict의 resolved 값을 수정하는 대신 별도 resolution 이벤트로 남긴다. 잘못된 해결도 새 정정 이벤트로 취소한다. 기간 일부만 정정하면 원래 행을 supersede하고 나머지 조각 및 정정 구간을 각각 새로 만들어 전체 기간을 보전한다. 단일 effective_to를 되돌려 열지 않는다.

### 원자성과 불변성

facts는 effective_to·superseded_by만 각각 NULL→값으로 한 번 바꿀 수 있다. 나머지 열·JSON은 불변이며 DELETE 금지다. captures·observations·corrections·fact_conflicts·conflict_resolutions·review_events는 UPDATE/DELETE 금지다. 동일 키의 완전히 같은 재삽입만 no-op이며 다른 열을 바꾸는 `INSERT OR REPLACE`도 거부한다. data만 비교하면 시간·대상 변경을 놓치므로 모든 불변 열을 비교한다.

verified의 열린 구간은 K마다 하나, 닫힌 구간도 중첩 금지다. “닫기 → 새 행 → twin 전이 → 체크포인트”를 한 BEGIN IMMEDIATE에서 처리한다. 정정은 deferred FK로 “superseded_by 설정 → 새 fact 추가”를 허용한다. 두 번째 문장 실패·FK 위반이면 전체 rollback한다. 새 fact가 구간을 벗어나거나 역순이면 트랜잭션 전에 검수로 돌린다.

변경 예시는 430,000원인 **검수 완료 가정** 구간을 닫고 자리표시 새 가격을 추가하는 두 문장이다. 실제 시드 가격은 아직 source_claim이므로 바로 적용하지 않는다. 바인딩 `:new_envelope`의 value는 `<KRW>` 자리표시를 실제 검증값으로 교체해야 하며 그 값을 여기서 만들지 않는다.

```sql
BEGIN IMMEDIATE;
UPDATE facts SET effective_to = :new_effective_from
 WHERE id = :old_verified_fact_id AND effective_to IS NULL AND superseded_by IS NULL;
-- 애플리케이션은 changes()=1을 확인한다. 0이면 rollback/검수.
INSERT INTO facts(id,subject_id,predicate,conditions_key,source_id,capture_id,
 fact_status,effective_from,effective_from_basis,effective_to,superseded_by,data)
 VALUES(:new_fact_id,:subject_id,'price',:conditions_key,:source_id,:capture_id,
 'verified',:new_effective_from,:time_basis,NULL,NULL,:new_envelope);
COMMIT;
```

## SQL 초안 — 로컬 원장, 실행 가능한 핵심 제약

후보 파일은 `crawler/migrations/0003_fact_ledger.sql`이며 이번에는 만들지 않는다. 사이트 D1 마이그레이션이 아니다. 모든 시간은 UTC `YYYY-MM-DDTHH:MM:SSZ`로 정규화해 문자열 비교하고, 입력 validator가 실제 날짜·정밀도를 검사한다. 아래는 핵심 테이블·이력 가드다. stage 운영 테이블은 WU-05, revision·twin 종료 가드는 WU-08에서 같은 불변 패턴으로 완성한다. 기존 수집함 migration 뒤에 적용할 수 있도록 review_events는 기존 구조를 유지한다.

```sql
PRAGMA foreign_keys=ON;
CREATE TABLE entities (
 id TEXT PRIMARY KEY NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('brand','product_line','model','variant','variant_revision','seller','offer','offer_revision','accessory','component','certification','recall','shipping_rule')),
 parent_id TEXT REFERENCES entities(id),
 effective_from TEXT, effective_to TEXT,
 data TEXT NOT NULL CHECK(json_valid(data)),
 CHECK(effective_to IS NULL OR effective_to > effective_from)
);
CREATE TABLE entity_aliases (
 entity_id TEXT NOT NULL REFERENCES entities(id), alias_norm TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(entity_id,alias_norm)
);
CREATE TABLE collection_runs (
 id TEXT PRIMARY KEY NOT NULL, scheduled_for TEXT NOT NULL, started_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE UNIQUE INDEX collection_run_slot ON collection_runs(
 json_extract(data,'$.worker_id'),scheduled_for,json_extract(data,'$.schedule_kind'));
CREATE TABLE captures (
 id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES collection_runs(id),
 source_id TEXT NOT NULL, url_norm TEXT NOT NULL, fetched_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ok','http_error','blocked','skipped_policy')),
 content_hash TEXT, prev_capture_id TEXT REFERENCES captures(id),
 data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(run_id,source_id,url_norm)
);
CREATE TABLE evidence_snippets (
 id TEXT PRIMARY KEY NOT NULL, capture_id TEXT NOT NULL REFERENCES captures(id),
 evidence_locator TEXT NOT NULL CHECK(length(evidence_locator)>0),
 quote TEXT CHECK(quote IS NULL OR length(quote)<=300), quote_hash TEXT NOT NULL,
 retention_until TEXT, purged_at TEXT,
 CHECK(purged_at IS NULL OR (quote IS NULL AND retention_until IS NOT NULL AND purged_at>=retention_until))
);
CREATE TABLE facts (
 id TEXT PRIMARY KEY NOT NULL, subject_id TEXT NOT NULL REFERENCES entities(id),
 predicate TEXT NOT NULL, conditions_key TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL,
 capture_id TEXT REFERENCES captures(id),
 fact_status TEXT NOT NULL CHECK(fact_status IN ('verified','source_claim','ai_inference','unverified')),
 effective_from TEXT NOT NULL,
 effective_from_basis TEXT NOT NULL CHECK(effective_from_basis IN ('stated','observed')),
 effective_to TEXT,
 superseded_by TEXT REFERENCES facts(id) DEFERRABLE INITIALLY DEFERRED,
 data TEXT NOT NULL CHECK(json_valid(data)),
 CHECK(effective_to IS NULL OR effective_to>effective_from),
 CHECK(superseded_by IS NULL OR superseded_by<>id)
);
CREATE UNIQUE INDEX facts_one_open_verified ON facts(subject_id,predicate,conditions_key)
 WHERE fact_status='verified' AND effective_to IS NULL AND superseded_by IS NULL;
CREATE TRIGGER facts_close_only BEFORE UPDATE ON facts WHEN
 NEW.id IS NOT OLD.id OR NEW.subject_id IS NOT OLD.subject_id OR NEW.predicate IS NOT OLD.predicate
 OR NEW.conditions_key IS NOT OLD.conditions_key OR NEW.source_id IS NOT OLD.source_id
 OR NEW.capture_id IS NOT OLD.capture_id OR NEW.fact_status IS NOT OLD.fact_status
 OR NEW.effective_from IS NOT OLD.effective_from OR NEW.effective_from_basis IS NOT OLD.effective_from_basis
 OR NEW.data IS NOT OLD.data
 OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS NOT OLD.effective_to)
 OR (OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS NOT OLD.superseded_by)
 BEGIN SELECT RAISE(ABORT,'close_only'); END;
CREATE TRIGGER facts_no_delete BEFORE DELETE ON facts
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER facts_no_replace BEFORE INSERT ON facts WHEN EXISTS(SELECT 1 FROM facts WHERE id=NEW.id)
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM facts f WHERE
 f.id IS NEW.id AND f.subject_id IS NEW.subject_id AND f.predicate IS NEW.predicate
 AND f.conditions_key IS NEW.conditions_key AND f.source_id IS NEW.source_id
 AND f.capture_id IS NEW.capture_id AND f.fact_status IS NEW.fact_status
 AND f.effective_from IS NEW.effective_from AND f.effective_from_basis IS NEW.effective_from_basis
 AND f.effective_to IS NEW.effective_to AND f.superseded_by IS NEW.superseded_by AND f.data IS NEW.data)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'fact_id_conflict') END; END;
CREATE TRIGGER facts_no_overlap BEFORE INSERT ON facts
 WHEN NEW.fact_status='verified' AND NEW.superseded_by IS NULL AND EXISTS(
 SELECT 1 FROM facts f WHERE f.subject_id=NEW.subject_id AND f.predicate=NEW.predicate
 AND f.conditions_key=NEW.conditions_key AND f.fact_status='verified'
 AND f.superseded_by IS NULL AND f.id<>NEW.id
 AND f.effective_from<COALESCE(NEW.effective_to,'9999-12-31T23:59:59Z')
 AND COALESCE(f.effective_to,'9999-12-31T23:59:59Z')>NEW.effective_from)
 BEGIN SELECT RAISE(ABORT,'verified_period_overlap'); END;
CREATE TABLE observations (
 id TEXT PRIMARY KEY NOT NULL, offer_revision_id TEXT NOT NULL REFERENCES entities(id),
 capture_id TEXT NOT NULL REFERENCES captures(id), observed_at TEXT NOT NULL,
 fact_status TEXT NOT NULL CHECK(fact_status IN ('verified','source_claim','ai_inference','unverified')),
 data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(offer_revision_id,capture_id)
);
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER observations_dedupe BEFORE INSERT ON observations WHEN EXISTS(
 SELECT 1 FROM observations WHERE id=NEW.id OR (offer_revision_id=NEW.offer_revision_id AND capture_id=NEW.capture_id))
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM observations o WHERE
 o.offer_revision_id IS NEW.offer_revision_id AND o.capture_id IS NEW.capture_id
 AND o.observed_at IS NEW.observed_at AND o.fact_status IS NEW.fact_status AND o.data IS NEW.data)
 AND NOT EXISTS(SELECT 1 FROM observations WHERE id=NEW.id
 AND (offer_revision_id IS NOT NEW.offer_revision_id OR capture_id IS NOT NEW.capture_id))
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'capture_conflict') END; END;
CREATE TABLE corrections (
 id TEXT PRIMARY KEY NOT NULL, old_fact_id TEXT NOT NULL REFERENCES facts(id),
 new_fact_id TEXT NOT NULL REFERENCES facts(id), at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE fact_conflicts (
 id TEXT PRIMARY KEY NOT NULL, left_fact_id TEXT NOT NULL REFERENCES facts(id),
 right_fact_id TEXT NOT NULL REFERENCES facts(id),
 kind TEXT NOT NULL CHECK(kind IN ('cross_source','same_source_flip','late_divergent')),
 at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE conflict_resolutions (
 id TEXT PRIMARY KEY NOT NULL, conflict_id TEXT NOT NULL REFERENCES fact_conflicts(id),
 at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS review_events (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));

-- recursive_triggers=OFF여도 INSERT OR REPLACE를 INSERT 단계에서 차단한다.
CREATE TRIGGER captures_no_update BEFORE UPDATE ON captures
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER captures_no_delete BEFORE DELETE ON captures
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER captures_no_replace BEFORE INSERT ON captures WHEN EXISTS(
 SELECT 1 FROM captures WHERE id=NEW.id OR (run_id=NEW.run_id AND source_id=NEW.source_id AND url_norm=NEW.url_norm))
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM captures c WHERE
 c.id IS NEW.id AND c.run_id IS NEW.run_id AND c.source_id IS NEW.source_id AND c.url_norm IS NEW.url_norm
 AND c.fetched_at IS NEW.fetched_at AND c.status IS NEW.status AND c.content_hash IS NEW.content_hash
 AND c.prev_capture_id IS NEW.prev_capture_id AND c.data IS NEW.data)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'capture_id_conflict') END; END;
CREATE TRIGGER corrections_no_update BEFORE UPDATE ON corrections
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER corrections_no_delete BEFORE DELETE ON corrections
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER corrections_no_replace BEFORE INSERT ON corrections WHEN EXISTS(SELECT 1 FROM corrections WHERE id=NEW.id)
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM corrections t WHERE t.id IS NEW.id AND t.old_fact_id IS NEW.old_fact_id AND t.new_fact_id IS NEW.new_fact_id AND t.at IS NEW.at AND t.data IS NEW.data)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'immutable_id_conflict') END; END;
CREATE TRIGGER fact_conflicts_no_update BEFORE UPDATE ON fact_conflicts
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER fact_conflicts_no_delete BEFORE DELETE ON fact_conflicts
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER fact_conflicts_no_replace BEFORE INSERT ON fact_conflicts WHEN EXISTS(SELECT 1 FROM fact_conflicts WHERE id=NEW.id)
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM fact_conflicts t WHERE t.id IS NEW.id AND t.left_fact_id IS NEW.left_fact_id AND t.right_fact_id IS NEW.right_fact_id AND t.kind IS NEW.kind AND t.at IS NEW.at AND t.data IS NEW.data)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'immutable_id_conflict') END; END;
CREATE TRIGGER conflict_resolutions_no_update BEFORE UPDATE ON conflict_resolutions
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER conflict_resolutions_no_delete BEFORE DELETE ON conflict_resolutions
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER conflict_resolutions_no_replace BEFORE INSERT ON conflict_resolutions WHEN EXISTS(SELECT 1 FROM conflict_resolutions WHERE id=NEW.id)
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM conflict_resolutions t WHERE t.id IS NEW.id AND t.conflict_id IS NEW.conflict_id AND t.at IS NEW.at AND t.data IS NEW.data)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'immutable_id_conflict') END; END;
CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER review_events_no_replace BEFORE INSERT ON review_events WHEN EXISTS(SELECT 1 FROM review_events WHERE id=NEW.id)
 BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM review_events t WHERE t.id IS NEW.id AND t.data IS NEW.data)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'immutable_id_conflict') END; END;
CREATE TRIGGER evidence_snippets_purge_only BEFORE UPDATE ON evidence_snippets WHEN
 NEW.id IS NOT OLD.id OR NEW.capture_id IS NOT OLD.capture_id
 OR NEW.evidence_locator IS NOT OLD.evidence_locator OR NEW.quote_hash IS NOT OLD.quote_hash
 OR NEW.retention_until IS NOT OLD.retention_until
 OR OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL OR NEW.quote IS NOT NULL
 OR OLD.retention_until IS NULL OR NEW.purged_at<OLD.retention_until
 BEGIN SELECT RAISE(ABORT,'purge_only'); END;
CREATE TRIGGER evidence_snippets_no_delete BEFORE DELETE ON evidence_snippets
 BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER evidence_snippets_no_replace BEFORE INSERT ON evidence_snippets
 WHEN EXISTS(SELECT 1 FROM evidence_snippets WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
```

WU-03는 새 열을 추가할 때 UPDATE 거부 트리거와 동일성 비교에도 그 열이 포함되도록 `PRAGMA table_info` 기반 검사를 둔다. observations의 ID는 `H(offer_revision_id,capture_id)`를 쓴다. ledger의 INSERT OR REPLACE는 사용하지 않으며 동일 재시도는 기존 출력 ID를 재사용한다. 위 가드는 잘못된 호출까지 방어한다. JSON은 canonical serialization을 사용해 동일성 비교를 안정화한다.

`entities`의 revision 행과 `twin_states(id,entity_id,state,entered_at,exited_at,cause_fact_id,data)`는 WU-08에서 내용 불변·종료 NULL→값 1회·DELETE/REPLACE 거부, 열린 상태 entity당 하나, 기간 중첩 거부를 적용한다. revision의 superseded_by도 정정 용도로만 한 번 허용한다. 단순 entities UPDATE로 과거 구성·관계를 바꿀 수 없어야 한다. 관계·별칭 검증 근거는 facts/review events에서 추적한다. 초안 entities.data 자체는 검증된 관계 원장이 아니다.

## JSON Schema 초안 — Fact envelope

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FactEnvelopeDraft",
  "type": "object",
  "required": ["fact_id", "subject_id", "predicate", "conditions_key", "value", "source_id", "capture_id", "source_url", "evidence_ids", "collected_at", "effective_from", "effective_from_basis", "fact_status", "license", "permission_basis", "retention_until", "extractor"],
  "properties": {
    "fact_id": {"type": "string", "minLength": 1},
    "subject_id": {"type": "string", "minLength": 1},
    "predicate": {"type": "string", "minLength": 1},
    "conditions_key": {"type": "string"},
    "value": {}, "object_id": {"type": ["string", "null"]},
    "source_id": {"type": "string", "minLength": 1},
    "capture_id": {"type": ["string", "null"]},
    "source_url": {"type": ["string", "null"]},
    "evidence_ids": {"type": "array", "items": {"type": "string", "minLength": 1}, "uniqueItems": true},
    "collected_at": {"type": "string", "format": "date-time"},
    "effective_from": {"type": "string", "format": "date-time"},
    "effective_from_basis": {"enum": ["stated", "observed"]},
    "change_window_start": {"type": ["string", "null"], "format": "date-time"},
    "effective_to": {"type": ["string", "null"], "format": "date-time"},
    "fact_status": {"enum": ["verified", "source_claim", "ai_inference", "unverified"]},
    "verification_basis": {"enum": ["human_review", "legacy_admin_approval", "public_db_record"]},
    "reviewed_at": {"type": "string", "format": "date-time"},
    "reviewed_by": {"type": "string", "minLength": 1},
    "review_event_id": {"type": "string", "minLength": 1},
    "license": {"type": ["string", "null"]},
    "permission_basis": {"type": ["string", "null"]},
    "retention_until": {"type": ["string", "null"], "format": "date-time"},
    "extractor": {"type": "string", "minLength": 1}
  },
  "allOf": [
    {
      "if": {"properties": {"fact_status": {"const": "verified"}}, "required": ["fact_status"]},
      "then": {
        "required": ["source_url", "evidence_ids", "verification_basis", "reviewed_at", "review_event_id"],
        "properties": {"source_url": {"type": "string", "format": "uri", "minLength": 1}, "evidence_ids": {"minItems": 1}}
      }
    },
    {
      "if": {"properties": {"verification_basis": {"const": "human_review"}}, "required": ["verification_basis"]},
      "then": {"required": ["reviewed_by"]}
    },
    {
      "if": {"properties": {"effective_from_basis": {"const": "observed"}}, "required": ["effective_from_basis"]},
      "then": {"required": ["change_window_start"]}
    }
  ]
}
```

value는 관계 fact에서 null + object_id를 사용한다. predicate별 값 스키마·기간 선후·source_url 자격 증명/쿼리 제거·evidence_ids의 존재 및 대상 일치·retention 정책은 의미 validator가 추가 검사한다. legacy_admin_approval은 reviewed_by를 만들어 넣지 않고 actor_missing=true와 당시 승인 근거를 보존한다. 원문·locator를 복원할 수 없는 legacy 값은 verified를 만들지 않고 검수로 보낸다.

## 기존 필드 → 새 원장 매핑

| 기존 | 위치 | 새 필드·처리 |
| --- | --- | --- |
| verification_status 5단계 | shared/collection-schema.ts | pipeline status 그대로, fact_status와 별개 |
| Evidence.level=clue | crawler/src/store.ts | source_claim |
| Evidence.level=authorized + 그룹 verify | store | 해당 evidence version·scope digest와 행위자 있는 review_events가 맞으면 새 verified(human_review), 없으면 source_claim + 검수 |
| Evidence.quote/locator | store | evidence_snippets, fact의 evidence_ids |
| Evidence.observed_at | store | collected_at/observed_at. 명시 적용일만 stated, 없으면 observed + 변경 창 |
| Evidence.withdrawn/superseded_by | store | corrections + superseded_by. 철회도 사유 이벤트 보존 |
| CollectionRecord.evidence_locator[] | schema | fact별 evidence_ids로 분해. 레코드 전체 위치를 모든 fact 근거로 복사하지 않음 |
| dedup_group_id, dedup_groups.lineage | schema/store | 문서 중복·계보 그대로, entity_id와 분리 |
| target_model_id | schema | 동일 대상 식별 subject_id 후보. 무검수 관계 확정 금지 |
| conflict_detected, evidence_conflicts | store | fact_conflicts, 별도 conflict_resolutions |
| full_text_allowed + permission_basis | config/store | license/permission_basis, 허용 raw만 외부 store로 이행 |
| next_recheck_at, recheck_ms | schema/config | last_confirmed_at과 stale 계산, 저장 상태 아님 |
| models.verify_level=page_body + official_price/checked/source_url, seed evidence | D1 0001/0008, seed | **source_claim**, basis=agent_page_body_2026-10-23 + 검수 큐. effective_from=seed evidence.checked_at(UTC), basis=observed. 사람 검수 뒤 새 verified. 사이트 D1 verify_level 표시 정책은 그대로 |
| official_unpublished + reason | D1/seed | 값 없는 확인 시도 capture. 실패 URL은 source_attempt에서만, 답은 정보 없음 |
| page_text/search_summary | D1 legacy | source_claim, 공식가 표시 금지 유지 |
| deals.manual + 관리자 승인 + deal_revisions | D1 0001/0011 | 승인 필드만 verified(legacy_admin_approval), actor_missing 표시. revision 이력은 Offer revision으로 이행하되 가격만 바뀐 revision도 원래 감사 이력 보존 |
| ingested_items.suggestions | 0002 | 규칙 추출 unverified, AI 추출 ai_inference |
| external_candidates.price_hint | 0006 | source_claim 단서, 가격 확정 승격 금지 |
| seed bundle.*.status=unconfirmed | seed | unverified 조사 항목. 일부 확인은 partial, 전부 근거 없음은 unknown |
| seed compatible[], safety, recalls.json | seed | 호환 source_claim, 공공 리콜 레코드 존재 public_db_record. 국내 적용 관계는 검수 전 unverified |

기존 날짜만 있는 D1 checked에는 임의 시각을 붙이지 않는다. seed 근거 시각이 정확히 대응할 때만 복원하고, 복원 불가하면 날짜 정밀도·unknown 시각을 legacy data로 보존해 검수한다. 현재 모델 ID·배열 순서·이름을 재확인하고 파일 경로+행의 안정 digest를 backfill 키로 삼는다. 재실행 추가 0건이어야 한다. 모델 근거 12건의 에이전트 확인을 사람 검수로 바꾸는 예외는 기본적으로 없다(README 질문 9).

## 보관 기본안

구조화 fact·observation·정정 이력은 무기한, 일반 허용 소스 인용도 무기한 제안이다. Instagram 인용과 공구 모음·언론/블로그 단서는 90일, 허가된 원문 전문은 180일, halt 진단 로그는 30일이다. Instagram 이미지·사진은 저장하지 않는다. 영속 세션·halt 감사 이력은 운영 상태로 별도 관리한다.

무기한은 권한 확인의 대체물이 아니다. 소스 허용 조건이 짧으면 더 짧은 기한을 쓰고 허가 불명 전문은 보관하지 않는다. 수집 허용과 이용·보관 허용을 분리한다. quote 만료 후 근거 해시·위치·삭제 이벤트는 남지만 원문 재검증이 불가할 수 있음을 품질 보고에 표시한다. 저장 위치·백업·복원 후 만료 재적용은 [06](06-work-units.md)을 따른다.
