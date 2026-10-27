# 06 · GitHub 작업 단위와 데이터 저장 경계

[소스 레지스트리](05-source-registry.md) · [개요·열린 질문](README.md)

## 코드와 데이터의 경계

후속 구현에서 GitHub에 올리는 단위는 **스키마, 수집기, 검증 규칙, 마이그레이션, 비식별 fixture, 운영 문서**다. 이번 작업은 DESIGN 문서 7개만 추가한다. 실제 raw-source store와 서비스 DB는 코드 저장소에 넣지 않는다. 저장소 안 ignored 경로도 Git 저장의 허용을 뜻하지 않는다.

fixture에는 토큰·쿠키·개인정보·실제 개인 계정 핸들·Instagram CDN 서명 URL을 넣지 않는다. 공개 공식 본문 외 실제 판매처 가격도 복제하지 않는다. 실가격은 승인된 공식 seed의 값만 사용하고 그 밖은 null 또는 example_only 자리표시를 쓴다. 이 문서의 `hanset.mag`·기본 `agamajung`는 계정 보호 지시를 위한 예외이며 fixture에는 넣지 않는다.

| 대상 | 위치 | 접근 경로·권한 | 백업 | 보관 |
| --- | --- | --- | --- | --- |
| 수집함 DB | 현행 crawler/.cache/collector.sqlite 또는 COLLECTOR_DB | Linux 운영 사용자만, 디렉터리 0700·파일 0600. CLI 변경은 serve 검토 API, 배치 작업은 DB 락을 얻어 순차 접근 | 매일 SQLite `.backup` → 암호화 별도 디스크, 일관된 복사본·정기 복원 확인 | 구조화 기록 무기한 제안, 백업본 30일 |
| Raw-source store | 저장소 밖 `/var/lib/agamajung/raw/`, AGAMAJUNG_RAW_DIR 제안 | 같은 사용자, 0700/0600, capture ID·해시로만 참조. 웹 공개 경로·사이트 DB 접근 없음 | 주 1회 암호화 별도 디스크, 소스 허가 범위 내만 | 전문 최대 180일·소스별 더 짧은 기간 우선 |
| 서비스 DB | Cloudflare D1 agamajung, 로컬은 .wrangler/ | 사이트 Worker binding·운영자, Linux SQLite와 분리. raw/세션 접근 금지 | 운영 D1 Time Travel 및 계정 정책에 따른 복원 절차. 사용 가능 기간은 운영자가 실제 플랜에서 확인 | 기존 운영 정책, 새 원장 설계로 임의 변경 없음 |
| 세션·halt | crawler/.session/ | 0700·파일 0600, 운영자만. 소스별 계정 접근 분리 | 백업하지 않음 | 세션·halt·해제 이력 임의 삭제 금지. 중단 해제는 감사 CLI로만 |
| 로그·halt 진단 | crawler/logs/ | 0700/0600, 기존 redaction 적용 | 없음 | 30일 제안. 영속 halt 상태와 구분 |

원문 저장은 임시 파일 → fsync/rename → capture 참조 확정 순서로 하고 미참조 잔여 파일을 정리한다. DB·raw의 일관된 백업 manifest에 capture ID·해시·정책 버전을 기록한다. 복원 시 foreign_key_check/quick_check·샘플 근거 접근·체크포인트를 확인하고, **만료된 raw/인용을 서비스 재개 전에 다시 제거**한다. 원문 삭제가 오래된 백업에서 되살아나지 않게 백업 수명·삭제 manifest를 적용한다. 세션·자격 증명은 백업 manifest에 포함하지 않는다.

현행 `collector_meta fulltext:*`는 허가된 전문을 DB JSON에 보관하므로, 후속 WU-12에서 권한·보관 기한 확인 → 외부 raw 이전 → 해시/참조 검증 → 원본 전문 제거를 중단·복원 가능한 작업으로 진행한다. 불변 facts에는 전문을 넣지 않는다.

[현행 .gitignore](../../.gitignore)는 이미 crawler/.cache/, crawler/.session/, crawler/logs/, .local/, .wrangler/, .env*를 제외한다. WU-12에서 `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `/raw/`, `*.warc` 가드를 제안한다. 이번에는 수정하지 않는다. tracked 파일에서 DB magic·DB/세션/raw 경로를 검사하고, fixture는 [privacy-rules](../../shared/privacy-rules.ts)를 재사용해 토큰·이메일·전화·서명 URL을 검사한다. 공개 공식 근거의 의도된 필드 외 민감한 값은 차단한다.

## 후속 작업 목록

공용 수집 엔진이 `crawler/migrations/0003_engine.sql`을 사용하므로 fact ledger는 0004부터 시작하며 착수 시 head를 다시 확인한다.

아래 번호는 순서와 의존성을 뜻한다. 각 PR은 해당 스키마/수집기/검증 규칙·필요한 migration·비식별 fixture·운영 문서를 함께 포함한다. 번호 후보는 착수 시 현재 migration head를 다시 확인한다. 작업 데몬이 검증·커밋·공개를 관리하며 이 설계 작업에서는 커밋·push·PR 생성·배포를 하지 않는다.

| 순서 | 의존 | 각 PR 범위 | 완료 기준 |
| --- | --- | --- | --- |
| WU-01 | 없음 | 이 설계 문서 7개 | 요청 §1~6 및 리뷰 7건 대응, 용어·링크·예시·경계 검토, 준태님 승인 |
| WU-02 | 01 승인 | shared/fact-schema.ts 후보, Fact JSON Schema·의미 validator·비식별 fixture | verified 필수 근거·검수 필드, human_review 행위자, observed의 change_window_start, UTC·조건·개인정보 검증 |
| WU-03 | 02 | crawler/migrations/0004_fact_ledger.sql 후보·원장 저장 API·멱등 backfill | 아래 원장 테스트. page_body는 source_claim+검수 큐. 기존 로컬 경로 회귀 통과 |
| WU-04 | 02 | 소스 레지스트리 파일·validator·초기 disabled 레코드 | unknown→disabled, 유효 exception만 예외, disallowed 절대 거부, 예외 결정자·날짜·범위·만료 필수, legacy enabled 무시 |
| WU-05 | 03 | run/capture·stage 체크포인트·lease·실패 큐·비용 상한·저장 API 연결 | 04 테스트 (c)(d), 강제 실패 stage부터 재개, attempts·예산 미초기화 |
| WU-06 | 05 | 변경 감지·추출 결과 캐시·Observation | 04 테스트 (a)(b)(e), 동일 본문 새 관측·왕복 변경 보존 |
| WU-07 | 03,04 | 동일 대상 식별·aliases·모호성 검수 | AI가 verified로 직접 승격되는 경로 없음, 문서 dedup과 entity 분리, 모호한 세대·로트 자동 병합 금지 |
| WU-08 | 06,07 | Twin·Variant/Offer revision·가격 구간·정정/상충 분류 | 아래 전이·원자성·as_of 검증 |
| WU-09 | 04 | Instagram 입력 전 중단·영속 halt·시작 가드·해제 CLI·레지스트리 연동·이미지 보관 차이 정리 | 아래 무네트워크 halt 테스트, 운영 문서. 결정되지 않은 권한 예외로 실행 금지 |
| WU-10 | 03 | KC/Recall 개체·CPSC 매핑·검수 규칙, SafetyKorea는 키 발급 후 | public_db_record 존재와 적용 판정 분리. unknown·not_connected·조회 실패 보존 |
| WU-11 | 08 및 준태님 경계 변경 결정 | 로컬 projection 질의·버전 계약. 승인 시에만 사이트 계약·migrations/0012 후보 | verified만 별도 최소 payload·토큰, 원문 비전송, 공개 검토·계약 테스트. 결정 전 로컬 projection까지만 |
| WU-12 | 05 | 품질 보고·백업/복원·보관·raw 외부 이행·gitignore 가드·인용 purge | 만료 quote NULL·해시 유지·복원 후 재삭제·가드 검사. quote 스키마 의존 03 포함 |

WU-06은 source_claim 관측 경로를 먼저 검증한다. 네 구간의 verified 가격 전이는 WU-08과 함께 통합 검증한다. 사이트 0012는 예약·실행된 migration이 아니며 0011 이후의 변경에 따라 번호를 조정한다.

### WU-03 원장 완료 기준

기존 테스트 통과와 backfill 재실행 추가 0건에 더해, foreign_keys=ON 메모리 SQLite에서 확인한다.

- `PRAGMA table_info`로 facts 비종료 열 전부를 열거해 각 UPDATE 거부. effective_to·superseded_by는 NULL→값 각 1회만 허용, 재변경·초기화 거부.
- facts·observations·captures·corrections·fact_conflicts·conflict_resolutions·review_events의 DELETE와 append-only 테이블 UPDATE 거부.
- INSERT OR REPLACE/UPSERT로 기존 행의 내용·시간·대상 변경 거부. recursive_triggers ON/OFF 모두 확인. 모든 불변 열 비교, data만 같은 변조도 거부.
- 동일 observation pair+동일 데이터는 무시, 다른 값/관측 시각/상태/ID 충돌은 capture_conflict. capture의 고유 run/source/url 충돌도 덮어쓰기 금지.
- 겹치는 verified 구간 및 열린 구간을 닫기 전 새 구간 삽입 거부. source_claim 상충 주장은 양쪽 보존.
- deferred FK 정정 순서, 누락 새 fact rollback, quote 만료 전 삭제·만료 후 재삽입 거부.

### WU-08 상태·이력 완료 기준

전이 표의 모든 행을 검증한다. 구간 닫기·새 fact·상태 전이가 원자적이어야 하며 두 번째 문장을 실패시키면 이전 구간도 열린 채 rollback되어야 한다. 역순 관측은 현재를 닫지 않는다. 다른 출처·겹치는 기간은 상충, 검증된 서로 다른 기간은 정상 변경, 동일 기간 오류는 정정이다. 부분 기간 정정의 나머지 구간도 보존한다.

구성 변경 전후 as_of 질의, variant revision 변경 후 판매처 미확인의 partial 처리, partial/unknown 비교 제외, 가격의 revision 간 복사 방지, stale 계산, 인증·리콜 대상 unknown을 확인한다. revision·twin 불변 가드와 중첩 거부도 테스트한다.

### WU-09 Instagram 완료 기준

모두 네트워크·실제 계정 없이 mock으로 확인한다.

- 로그인 폼/경로/프롬프트 발견 시 fill/click 0회, 영속 halt 먼저 기록. challenge·CAPTCHA·차단에도 동일 정책.
- halt 파일이 있으면 main이 loadEnvironment/launchBrowser/네트워크를 호출하지 않고 75로 종료. 두 번째 예약 재시작에서도 동일.
- 손상·읽기 불가 halt는 halted, 진단 실패에도 중단 상태·종료코드 유지. halt 저장 실패 운영 보고 경로 확인.
- 명시 해제 명령 후에만 실행 가능하며 감사 이력이 남음. 실행 중 해제·자동 해제 거부.
- crawler 로그아웃 클릭·URL 정적 검사, 계정 교체·세션 삭제 경로 없음, 기존 공유 휴식 유지.

## 이번 DESIGN 검증

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`가 기존 동작을 그대로 검사한다. 문서의 상대 링크·실제 경로·예시 가격의 seed 대응·민감값 패턴·변경 파일 범위를 확인한다. 03 핵심 DDL을 메모리 SQLite에서 문법·주요 거부 동작으로 점검하며 이는 후속 WU-03 전체 회귀 테스트를 대체하지 않는다. 실제 migration·수집·권한 활성화는 수행하지 않는다.
