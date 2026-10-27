# 01 · 서비스가 답해야 할 질문

[개요·용어·결정 사항](README.md) · 다음: [온톨로지](02-ontology.md)

## Q1. 같은 모델, 같은 구성으로 비교하면 어디가 얼마인가?

답은 판매처, 가격 종류·값·통화, 구성품·수량·옵션, 배송비 규칙, 공구 기간·최소 인원·사은품, 확인 시점, 근거 URL·위치, 사실 검증 상태와 판매 상태를 함께 제공한다. 현재 비교 범위는 **공식가·공구가**뿐이다. 일반 판매가·해외가·중고가는 제외한다. 공식 페이지에서 확보하지 못한 가격을 부품 합계나 판매처 가격으로 대체하지 않는다.

### 같은 구성의 조건

```text
bundle_signature = sha256(canonical_json({
  variant_revision_id,
  components: [{component_id, qty, option_id: string|null}]
}))
```

구성 목록은 `(component_id, option_id)`순으로 정렬하고 동일 항목 수량을 합친다. qty는 명시된 양의 정수이고 null option도 일관되게 직렬화한다. 색상·세대·재질은 Variant에 속하므로 동일한 `variant_revision_id`여야 한다. 제조사 기본 구성의 revision도 키에 포함한다. 미확인 세대를 임의로 같은 variant에 묶지 않는다. `model-N`은 보존하며 기존 모델의 세부 옵션 관계도 근거를 확인한 뒤 연결한다.

사은품·최소 인원은 기본안에서 키에 넣지 않고 별도 조건으로 표시한다(열린 질문 7). 배송비도 키에 넣지 않고 별도 열로 표시하며 가격에 합산하거나 최저 총액 순위를 만들지 않는다. 지역·회원 등 조건을 모르면 배송비는 정보 없음이다.

| `bundle_status` | 판정 | 비교 참여 |
| --- | --- | --- |
| `confirmed` | variant revision과 모든 구성·수량·옵션이 verified 근거로 식별됨 | 동일 키 그룹 참여 |
| `partial` | 일부 항목만 확인되거나 수량·세대가 빠짐 | “구성 미확인” 구역, 가격 비교 제외 |
| `unknown` | 구성 근거 없음 | “구성 미확인” 구역, 가격 비교 제외 |

이 상태는 검증 근거로 계산한 projection이다. seed `bundle.*.status='unconfirmed'`는 포함 사실이 아니라 조사 과제다.

### 답 선택 규칙(as_of T)

1. Offer별로 `effective_from ≤ T < effective_to`(NULL은 열린 구간)인, 정정으로 대체되지 않은 Offer revision을 선택한다.
2. revision에 연결된 구성의 `bundle_status=confirmed`인지 확인한다.
3. 그 revision·가격 종류·통화 조건에서 T를 포함하는, `superseded_by IS NULL`인 `verified` 가격 fact를 선택한다. 미해결 상충이 있으면 값 표시를 보류한다.
4. T 시점 twin 상태와 `last_confirmed_at`을 함께 반환한다. `last_confirmed_at`은 동일 값·동일 조건을 실제 관측한 최신 성공 capture 시각이다. 검수한 시각을 관측 시각으로 쓰지 않는다.
5. 현재 가격 답에는 active이며 유효한 공구만 쓴다. announced는 예정, sold_out은 품절, ended/withdrawn은 종료·철회로 구분한다. stale이면 “확인 필요”로 현재 비교에서 보류한다. 과거 질의는 해당 시점 상태를 반환한다.

`as_of`는 실제 적용 시간 기준이다. 사후 정정 이전에 시스템이 무엇을 알고 있었는지를 재현하려면 `known_at`(capture·review·correction 기록 시각)도 지정한다. 둘을 혼동하지 않는다.

### 현재 자료에 맞는 예시 답

[시드](../../seed/models.json) 첫 모델과 [근거 기록](../model-evidence-2026-10-23.md)의 실제 값이다. 에이전트가 확인한 공식 본문 가격이므로 새 원장에서는 `source_claim`이며 **검수 대기 구역**에만 둔다. 구성·배송·일정은 근거가 부족해 채우지 않는다. 현재 사이트 D1의 `page_body` 공식가 표시 정책은 이 원장의 검수 정책과 별도로 유지한다.

```json
{
  "model_id": "model-1",
  "model_name": "트립트랩 하이체어(너도밤나무)",
  "comparison_rows": [],
  "answer": "정보 없음",
  "review_pending": [{
    "seller": "스토케 공식몰",
    "price_type": "공식가",
    "price": 430000,
    "currency": "KRW",
    "components": [{"name": "하이체어 본체", "qty": null, "fact_status": "source_claim"}],
    "variant_revision_id": null,
    "bundle_signature": null,
    "bundle_status": "partial",
    "shipping": {"fee": null, "rule": "정보 없음"},
    "group_buy": {"starts_at": null, "ends_at": null, "minimum_people": null, "gifts": null},
    "observed_at": "2026-10-23T04:41:19Z",
    "source_checked_at_original": "2026-10-23T13:41:19+09:00",
    "source_url": "https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/1001.html",
    "evidence_locator": "제품명과 상품 상세 가격 영역(통화 기호를 원 단위로 정규화)",
    "fact_status": "source_claim",
    "review": "pending_human",
    "offer_state": null,
    "display": "출처 주장, 검수 전"
  }],
  "group_buy": {
    "seller": null, "price_type": "공구가", "price": null,
    "components": null, "shipping": null, "terms": null,
    "observed_at": null, "source_url": null, "evidence_locator": null,
    "status": "unverified", "display": "정보 없음"
  }
}
```

다음은 형식만 보여주는 가상 행이다. 실제 fixture·공개 데이터로 이행하지 않는다.

```json
{
  "example_only": true,
  "seller": "판매처-A", "price_type": "공구가", "price": "<KRW>",
  "variant_revision_id": "<확인된 variant revision>",
  "components": [{"component_id": "<부품 ID>", "qty": 1, "option_id": null}],
  "shipping": "<배송비 규칙>",
  "group_buy": {"period": "<시작~종료>", "minimum_people": "<명시 인원>", "gifts": "<명시 사은품>"},
  "observed_at": "<UTC 확인 시각>", "source_url": "<근거 URL>",
  "evidence_locator": "<본문 위치>", "fact_status": "verified", "offer_state": "active"
}
```

### 구성 변경 전후

판매처-A의 안정 Offer에 r1(구성 X), r2(구성 Y)가 있다. T1에서 r1과 그 열린 가격 구간을 닫고 r2를 연다. `as_of < T1`이면 r1은 X 그룹, `as_of ≥ T1`이면 r2는 Y 그룹이다. r1의 가격을 r2로 복사하지 않는다. r2 구성이 partial이면 “구성 미확인” 구역에만 두고, 가격 근거가 없으면 정보 없음이다.

## 이어서 답할 질문

| 질문 | 개체 | 속성 | 관계 | 시간 정보 | 검증 규칙 | 정보 없음 조건 |
| --- | --- | --- | --- | --- | --- | --- |
| Q2 이 액세서리는 이 모델·연식과 호환되는가? | Accessory, Variant revision, Evidence | 부품 번호, 세대·로트, 제외 조건 | `compatible_with` | 설명서 발행·적용 기간, 관측 시각 | 제조사·수입사 본문과 사람 검수. 구형 로트는 별도 판정 | 이름 유사·판매자 주장만 있거나 대상 로트 미식별 |
| Q3 KC 인증·리콜 이력이 있는가? | Certification, Recall, Variant revision | 유형·번호·기관·대상·날짜·`kr_applicability` | `applies_to` | 인증·발표·철회일, 조회 시각 | 공공 DB 레코드 존재와 국내 적용 판정 검수 분리. `applies/not_this_model/unknown` | 미연동·조회 실패·대상 불명. 결과 없음은 안전 보장이 아님 |
| Q4 가격·재고는 언제 어떻게 변했는가? | Observation, 가격 fact, Offer revision | 금액·통화·재고 | `observed_for` | observed_at, 유효 구간, 변경 추정 구간 | 검증된 같은 조건의 관측끼리 비교. 늦은 관측은 현재 구간을 닫지 않음 | 양 끝 관측 미확보 또는 상충 |
| Q5 공구 조건이 지금 유효한가? | Offer, GroupBuyTerms, Twin | 기간·최소 인원·사은품·판매 상태 | `has_terms` | starts_at/ends_at, last_confirmed_at, recheck | 본문 확인과 검수, 기간 도달 시 재확인. stale은 `now > last_confirmed_at + recheck`로 계산 | 재확인 기한 경과·최소 인원 충족 근거 없음·마감 불명 |
| Q6 구성품이 언제 바뀌었는가? | Variant revision, Offer revision, Component | 수량·옵션·구성 서명 | `includes`, `revision_of` | revision 유효 구간, 변경 창 | 제조사 기본 구성 변경과 판매처 구성 변경을 따로 확인 | 변경 전후 구성의 일부만 확인 |
| 후보 Q7 국내 공식 수입사는 누구인가? | Brand, Importer(Seller 역할), Evidence | 수입사명·대상·국내 유통 범위 | `official_importer_for` | 적용일·확인일 | seed importer_basis는 단서. 제조사 사업자·수입사 안내와 사람 검수 | unconfirmed/recheck_failed 또는 관계 근거 없음 |

변경 시점이 원문에 없으면 “마지막 이전 값 관측 ~ 첫 새 값 관측” 구간으로 답하고 정확한 실제 변경 시각을 단정하지 않는다.

## 공통 답변 규칙

근거 없음은 **정보 없음**, 미해결 상충은 **확인 중, 상충 근거 N건**(금액 보류), source_claim은 **출처 주장, 검수 전**(비교 제외)이다. AI 추론은 검수 큐에만 두고 확정 답에 섞지 않는다. 수집 실패·빈 목록을 무료·품절·리콜 없음으로 해석하지 않는다.
