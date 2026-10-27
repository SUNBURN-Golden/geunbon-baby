# 아가마중 데이터 기반 설계

DESIGN · 2026-10-27 KST · 승인 전 설계안. **원문에 없는 관계를 AI가 확정 데이터로 넣지 않는다.** 설계 순서는 **서비스가 답해야 할 질문 → 온톨로지 → 수집·검증 → 현실 상태 추적**이다. 근거가 없으면 **정보 없음**으로 답한다.

이번 산출물은 이 디렉터리의 Markdown 7개다. SQL과 JSON Schema는 문서 안의 후속 구현 초안이며 적용된 스키마가 아니다. 후속 작업은 준태님 설계 승인 뒤 [작업 단위](06-work-units.md)에 따라 나눈다.

## 읽는 순서

| 순서 | 문서 | 결정하는 내용 |
| --- | --- | --- |
| 1 | [대표 질문](01-questions.md) | 같은 모델·같은 구성의 가격 답변 계약과 근거 부족 처리 |
| 2 | [온톨로지](02-ontology.md) | 개체·관계·안정 ID·revision·디지털트윈 상태 전이 |
| 3 | [사실 메타데이터와 이력](03-fact-metadata-and-history.md) | 검증 상태, 시간 구간, 정정·상충, 스키마와 기존 데이터 이행 |
| 4 | [Daemon 역할](04-daemon-roles.md) | 단계별 입력·출력·멱등성·재개·비용 상한 |
| 5 | [소스 레지스트리](05-source-registry.md) | 초기 소스, 권한, 보관, 미지원 범위, Instagram 중단 |
| 6 | [작업 단위와 저장소 경계](06-work-units.md) | 후속 PR 순서·완료 기준·데이터 저장 및 운영 |

## 범위와 시스템 경계

[루트 README의 시스템 구성과 경계](../../README.md#시스템-구성과-경계)를 따른다. “사이트는 로컬 수집 레코드·URL·원문·셀러·근거를 가져오지 않습니다.”가 기본값이다. Next.js/Cloudflare 사이트(D1·R2)와 Linux 수집함(SQLite·Playwright)은 별도 시스템이다. Workers Cron은 로그 stub이며 수집기를 실행하지 않는다.

로컬 projection은 로컬 질의 결과다. 현행 사이트 접점은 전용 토큰을 쓰는 **건수 동기화**뿐이다. 별도로 존재하는 Instagram pending → 사이트 관리자 승인 → deals 경로를 로컬 fact 공개 경로로 간주하지 않는다. WU-11의 projection 전송·사이트 계약은 경계 변경에 대한 별도 결정 이후에만 진행한다. `ready_to_publish`도 로컬 검토 단계이지 게시 명령이 아니다.

공유 가능한 것은 큐·락·lease·재시도·비용 상한·체크포인트·도메인 속도 제한·egress 검사·개인정보 필터 엔진이다. 아가마중 온톨로지·데이터 접근·원장·레지스트리 항목·검수 내용·projection·자격 증명·Instagram halt 상태는 서비스별로 분리한다. 개발 작업 도구 `tools/dev-daemon`은 수집 인프라가 아니다. 이 작업은 큐 파일을 수정하지 않는다.

범위에서 제외하는 것은 프론트엔드(`app/` UI·화면·스타일), 수집기 구현, 실제 마이그레이션·D1 변경, 배포, 공식가 표시 정책 변경, 해외가·중고가 비교다. `/models` 카드의 기존 네 항목 규칙도 그대로다. 기존 `crawler/`, `shared/`, `lib/`, `migrations/`, `seed/`, 루트·crawler README와 `.gitignore`를 변경하지 않는다.

## 현재 구조를 읽은 기준

| 요청서의 초기 표현 | 저장소에서 확인한 구조 | 이행 기준 |
| --- | --- | --- |
| `crawler/local-worker.mjs` | 해당 파일 없음. [실제 worker](../../crawler/src/local-worker.ts)는 `serve/discover/sync`. [CLI](../../crawler/collector.mjs) → [cli.ts](../../crawler/src/cli.ts) | 실제 경로를 확장한다 |
| pm2 `agamajung-local-worker`, `agamajung-discover` | [체크인 설정](../../crawler/ecosystem.config.cjs)에는 `agamajung-crawler`만 있음(09:30·20:30 KST, 종료코드 75) | 로컬 수집함 타이머는 저장소 밖 운영자 관리. 실제 운영 등록 여부 미확인 |
| 사이트 `0001~0008` | [마이그레이션](../../migrations/)은 `0011`까지. 0009 UTC 정규화, 0010 판매자 등록, 0011 공구 정정·철회와 `deal_revisions` | 향후 사이트 번호 후보 0012. [수집함 migrations](../../crawler/migrations/)은 공용 엔진 0003까지 적용하며 fact ledger의 다음 후보는 0004. 구현 시 다시 확인 |
| `verification_status` | [공통 계약](../../shared/collection-schema.ts)의 처리 단계 5개 | pipeline status이며 새 `fact_status`와 별개 |
| `dedup_group_id` | [store](../../crawler/src/store.ts)의 문서 중복·계보 묶음 | 대상 식별 `entity_id`와 별개 |
| 외부 수집 enabled | [현행 설정](../../crawler/config/collector.json)의 5개 소스 모두 false | 레거시 [external-sources](../../crawler/config/external-sources.json)의 true는 권한 근거 아님. 현재 worker가 이를 import하지 않음 |
| `page_body` | [2026-10-23 모델 기록](../model-evidence-2026-10-23.md)은 에이전트 확인이며 사람 감수를 대신하지 않는다고 명시 | 새 원장에서는 `source_claim` + 검수 큐. 사이트 D1 정책은 유지 |

루트·crawler README, 사이트 0001~0011, 수집함 0001~0002, store·scheduler·발견 실행부·Instagram 진입점과 browser/halt를 기준으로 한다. 현재 DB는 foreign keys·WAL·`wx` 잠금 파일로 단일 실행을 보장한다. 아래 문서의 운영 제안은 현재 동작과 구분해 적었다. 외부 페이지·robots·약관을 이번 작업에서 새로 조회하거나 권한을 확인한 것은 아니다.

## 공통 용어

| 용어 | 정의 | 기존 대응 |
| --- | --- | --- |
| Product line(제품 라인) | 브랜드 아래 제품 라인 | seed brand·이름 단서, 관계는 검수 필요 |
| Model(모델) | 비교 기본 단위 | 기존 `models.id` (`model-N`) 유지 |
| Variant(연식·옵션) | 세대·연식·색상·재질·구성 변형 식별 | `model-families.json`, seed `bundle.generation` 단서 |
| Variant revision | 제조사 기본 구성·사양의 기간별 판 | 신규 |
| Seller(판매처) | 공식몰·판매처·공구 셀러 | `sellers`, 로컬 `seller_candidates`는 후보 |
| Offer(판매 조건) | 판매처 × variant × 채널의 안정 식별자 | 공구 `deals`가 일부 대응 |
| Offer revision | 구성·수량·옵션·배송·공구 조건·variant revision의 불변 묶음 | `deal_revisions`가 가까운 선례 |
| `bundle_signature` | 확인된 동일 구성의 비교 키 | 정의는 01 |
| Capture | 한 run에서 한 정규화 URL을 가져온 기록 | `collection_jobs` 일부 기능 |
| Fact(사실) | 주어·술어·조건·값과 근거·시간·검증 메타데이터 | `evidence_assertions` |
| Observation(스냅샷) | capture 시점 가격·재고 관측, append-only | 신규 |
| Twin(디지털트윈) | Offer·Model 현재 상태와 현실 변경에 따른 전이 이력 | `deals.status`·`deal_revisions` 일부 |
| `fact_status` | `verified/source_claim/ai_inference/unverified` | 03 매핑 참조 |
| `verification_basis` | `human_review/legacy_admin_approval/public_db_record` | 신규 |
| pipeline status | 후보~공개 대기의 다섯 처리 단계 | 기존 `verification_status` |
| Raw-source store(원문 저장소) | 허가된 원문을 두는 코드 저장소 밖 저장소 | 현행 `collector_meta`의 `fulltext:*` 이행 대상 |
| 정보 없음 | 근거 부재. 가격·관계를 추정해서 채우지 않는 답 | 기존 원칙 |

## 열린 질문 — 준태님 결정 필요

1. WU-11에서 사이트가 로컬 projection을 받을 수 있게 경계를 바꿀지. 승인한다면 `verified`만 별도 토큰·계약으로 보낼지. 결정 전 로컬에만 둔다.
2. pm2 `agamajung-local-worker`·`agamajung-discover`를 저장소에 체크인할지.
3. `hanset.mag`와 환경변수 `AGAMAJUNG_IG_USER`(기본 `agamajung`)의 관계. 확인 전 계정 변경·로그아웃 금지.
4. Instagram 중단 보고 채널과 담당자. 결정 전 로컬 health·halt 기록과 운영자 수동 확인을 사용한다.
5. 보관 기간: 원문 180일, Instagram 인용 90일, 백업 30일, 일반 인용·구조화 기록 무기한의 승인 여부. 소스별 허용 기간이 더 짧으면 그 기간을 우선한다.
6. AI 추출을 사용할지와 일·월 비용 상한. 미결정 시 AI 비활성화·예산 0.
7. 사은품·최소 인원을 `bundle_signature`에 넣을지. 기본안은 별도 조건 열이며 키에서 제외.
8. 공식몰 일반 판매가까지 비교할지. 기본안은 현재처럼 공식가·공구가만.
9. 에이전트가 확인한 `page_body` 12건을 사람 검수 없이 `verified`로 인정하는 예외를 둘지. 기본안은 예외 없이 검수 큐.
10. Instagram 약관 `unknown`에 대해 범위·기간을 명시한 운영 예외를 승인할지. 기본안은 disabled. disallowed는 예외로도 활성화 금지.
11. 사람이 직접 세션을 복구할 때 별도 입회 로그인 보조 모드를 둘지. 기본안은 두지 않음.
