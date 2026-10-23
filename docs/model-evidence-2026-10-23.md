# 모델 공식 근거 확인 기록 · 2026-10-23

에이전트 확인 기록이며 사람의 최종 감수를 대신하지 않음. HTTP 본문을 실제 요청하여 텍스트를 읽었으며 검색 요약·캐시·AI 요약은 채택하지 않았다. 시각은 요청 시작 시각(KST). 접속 오류는 별도 재시도했고 TLS 검증을 끄지 않았다. 전문·사진은 저장소에 복제하지 않았다. 통화 기호는 짧은 근거에서 원 단위로 정규화했다.

## 판정상 주의

- `official_unpublished`는 제조사가 가격을 공개하지 않았다는 단정이 아니라, 이번 조사에서 공식 정상가를 확보하지 못했다는 상태다. 접속 실패·동일 구성 미확인·수입사 미확인은 reason으로 구분한다.
- 익스플로리 대체 페이지의 무료 표시는 재고/로딩 상태여서 가격으로 쓰지 않았다. 요요 묶음의 부품 가격도 전체 가격으로 사용하지 않았다. 후속 드래곤플라이 플러스 가격을 구형 모델에 대입하지 않았다. 단종 고지 원문은 확보하지 못해 구형 드래곤플라이는 `not_listed`로 기록했다.
- 계획서의 위치 번호 일부가 현재 배열과 다르다. 리뷰 주소는 model-20(피파 넥스트), 홈 주소는 model-24(아이스핀 메쉬)와 model-25(블리스)였다. 모델명·현재 배열 순서를 기준으로 처리했으며 순서와 이름은 유지했다.
- Cybex·Joie·Egg·Britax·Maxi-Cosi·Ergobaby의 기존 수입사명은 보존하고 공개 문자열에 “기존 정보, 재확인 실패”를 붙였다. 접속 오류는 기존 수입사 정보를 부정하는 근거가 아니다. 기존 국내몰 호스트도 재확인 대상으로 보존했다. Silver Cross·Ergobaby·Doona의 가격은 여전히 미확인이다. 실패 URL은 `evidence.source_attempt` 또는 `importer_basis.attempted_url`에만 기록하고 성공 출처의 checked_at을 붙이지 않는다. 읽은 근거가 없으면 source_url은 빈 문자열이며 화면에서 링크를 표시하지 않는다.
- Ergobaby·Doona는 국내 수입사 근거 미확보로 `importer_unconfirmed`, 가격 null이다. 기존 price.test의 model-40 null 검증은 유지한다. Silver Cross도 같은 처리다.
- Nuna 제조사 한국 사이트 하단의 주문 처리/사업자 안내로 에이원월드를 확인했다. 국내몰 본문은 TLS 오류로 읽지 못해 가격은 채택하지 않았다.
- 설명서 confirmed는 공식 설명서 목록에서 해당 모델 링크를 확인한 상태다. PDF 전체와 제조 로트별 적합성 검토를 완료했다는 의미가 아니다. 부가부 한국 목록은 구형 설명서만 노출되어 현행 모델은 not_found로 남겼다.
- 포함품 배열의 unconfirmed는 포함 사실이 아니며 확인할 조사 항목이다. 공란 호환 목록은 호환 부품이 없다는 뜻이 아니다. 보증·국내 인증번호도 확보한 사실만 기록했다.

## 리콜 확인

`npx tsx scripts/recall-check.ts --out seed/recalls.json`으로 실제 CPSC 공개 REST를 조회했다. 최초 요청에서 403을 받았으나 재조회가 성공했다. 모든 대체 표기의 제목/제품명 요청에서 파싱된 원시 행 합계가 raw_count이며 RecallID 중복 제거 후 브랜드 필터를 적용한 행이 kept다. 검색 요청에는 날짜 하한이 포함되지만 API 응답에 오래된 리콜도 있어 서버의 기간 필터를 보장하지 않는다.

Cybex는 운동기구 동명 회사를 배제하도록 CYBEX Strollers·Regal Lager·CYBEX baby·CYBEX GmbH 식별어를 쓴다. 브랜드별 기본 질의와 match_terms의 모든 대체 표기를 각각 제목·제품명으로 조회한다. Maxi-Cosi에는 Dorel을 포함한다. 대체 질의도 검색 완전성을 보장하지 않으며 자동차 좌석의 모든 리콜 관할을 포괄하지 않는다. 결과 없음은 안전을 보장하지 않으며 SafetyKorea는 API 키 발급 전 미연동이다. 해외 리콜 중 요요 및 드래곤플라이 계열은 국내 로트 적용 여부 unknown으로 남겼고, 다른 제품명은 not_this_model로 구분했다. Bugaboo 어댑터 리콜 938은 호환 어댑터 모델을 대조하지 못했으므로 unknown으로 보수적으로 정정했다. 국내 적용을 판정한 것은 아니다.

공식 본문 정상가 채택은 12개, 공식가 미확보는 29개다. 그중 fetch_failed는 16개이며 공개 화면 공식가가 “정보 없음”으로 바뀐다. 트립트랩 오크는 기존 470,000원에서 본문 확인 정상가 510,000원으로 상향된다. 세부 사유와 재시도 기록은 아래에 남긴다.

## 모델별 로그

### model-1 · Stokke — 트립트랩 하이체어(너도밤나무)

- 방문: https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/1001.html · 2026-10-23T13:41:19+09:00 · 200
- 판정: `page_body` — 트립트랩 하이체어(너도밤나무) / 가격 (VAT 포함): 430,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 트립트랩 하이체어(너도밤나무) 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 트립트랩 하이체어(너도밤나무) 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 하이체어 본체 [https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/1001.html · 2026-10-23T13:41:19+09:00]
- 호환 기록: 트립트랩 신생아 세트 / 베이비 세트 — 별도 판매. 본문에서 장착 사용 안내 확인; 구형 제조 로트와의 호환 미확인 [https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/1001.html · 2026-10-23T13:41:19+09:00]
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-2 · Stokke — 트립트랩 하이체어(오크)

- 방문: https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/4952.html · 2026-10-23T13:41:22+09:00 · 200
- 판정: `page_body` — 트립트랩 하이체어(오크) / 가격 (VAT 포함): 510,000원 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 트립트랩 하이체어(오크) 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 트립트랩 하이체어(오크) 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 오크 하이체어 본체 [https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/4952.html · 2026-10-23T13:41:22+09:00]
- 호환 기록: 트립트랩 신생아 세트 / 베이비 세트 — 별도 판매. 본문에서 장착 사용 안내 확인; 구형 제조 로트와의 호환 미확인 [https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/4952.html · 2026-10-23T13:41:22+09:00]
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-3 · Stokke — 트립트랩+베이비세트

- 방문: https://www.stokke.com/KOR/ko-kr/tripp-trapp/tripp-trapp-chair-baby-set.html · 2026-10-23T13:41:25+09:00 · 404
- 방문: https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/tripp-trapp-chair-baby-set.html · 2026-10-23T14:59:21+09:00 · 404
- 판정: `official_unpublished` / `not_listed` — 공식몰에서 동일 베이비세트 묶음의 정상가 확인 불가 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-4 · Stokke — 트립트랩+베이비세트+트레이(이유식세트)

- 방문: https://www.stokke.com/KOR/ko-kr/tripp-trapp/tripp-trapp-chair-baby-set.html · 2026-10-23T13:41:30+09:00 · 404
- 방문: https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/tripp-trapp-chair-baby-set.html · 2026-10-23T14:59:21+09:00 · 404
- 판정: `official_unpublished` / `not_listed` — 공식몰에서 동일 이유식 구성 상품을 확인하지 못해 개별 부품 가격을 합산하지 않음 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-5 · Stokke — 트립트랩 신생아&이유식 세트

- 방문: https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/tripp-trapp-newborn-complete-sk.html · 2026-10-23T13:41:34+09:00 · 200
- 판정: `page_body` — 트립트랩 신생아&이유식 세트 / 가격 (VAT 포함): 910,000원 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 트립트랩 신생아&이유식 세트 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 트립트랩 신생아&이유식 세트 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 신생아 & 이유식 세트(세부 구성품 미확인) [미확인: 번들 명칭은 확인했으나 상세 구성 목록이 동적으로 로드되어 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-6 · Stokke — 익스플로리 X

- 방문: https://www.stokke.com/KOR/ko-kr/571502.html · 2026-10-23T13:41:38+09:00 · 404
- 방문: https://www.stokke.com/KOR/ko-kr/571502.html · 2026-10-23T14:24:39+09:00 · 404
- 방문: https://www.stokke.com/KOR/ko-kr/유모차/스토케-익스플로리/5715.html · 2026-10-23T14:59:21+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 기존 제품 주소는 찾을 수 없으며 대체 제품 페이지는 재고 없음과 무료 표기여서 정상가로 채택하지 않음 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-7 · Stokke — 요요3 프레임

- 방문: https://www.stokke.com/KOR/ko-kr/유모차/스토케-요요-유모차/6773.html · 2026-10-23T13:41:44+09:00 · 200
- 방문: https://www.stokke.com/KOR/ko-kr/last-chance/yoyo-strollers-last-chance/6773.html · 2026-10-23T13:41:44+09:00 · 200
- 판정: `page_body` — 요요3 프레임 / 가격 (VAT 포함): 567,000원 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 요요3 프레임 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 요요3 프레임 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 요요³ 프레임 [https://www.stokke.com/KOR/ko-kr/last-chance/yoyo-strollers-last-chance/6773.html · 2026-10-23T13:41:44+09:00]
- 호환 기록: 뉴본 옵션 / 6+ 컬러 팩 — 별도 판매; 요요³ 프레임 본문에서 사용 가능 안내 확인 [https://www.stokke.com/KOR/ko-kr/last-chance/yoyo-strollers-last-chance/6773.html · 2026-10-23T13:41:44+09:00]
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-8 · Stokke — 요요3 6+ (프레임+시트)

- 방문: https://www.stokke.com/KOR/ko-kr/유모차/스토케-요요-유모차/yoyo-stroller-sk.html · 2026-10-23T13:41:47+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 묶음 페이지에서 프레임 합계가 확인되지 않고 시트 가격만 표시되어 전체 공식가 미확인 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-9 · Stokke — 요요 뉴본 배시넷 구성

- 방문: https://www.stokke.com/KOR/ko-kr/last-chance/yoyo-strollers-last-chance/yoyo-bassinet-stroller.html · 2026-10-23T13:41:52+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 묶음 페이지에서 프레임 합계가 확인되지 않고 뉴본 쉘 가격만 표시되어 전체 공식가 미확인 원래 검색 요약 근거를 폐기함.
- 설명서 검색: https://www.stokke.com/KOR/ko-kr/customer-service/user-guides.html · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-10 · Bugaboo — 폭스5 리뉴

- 방문: https://www.bugaboo.com/kr-ko/strollers/bugaboo-fox-5-renew/ · 2026-10-23T13:41:19+09:00 · 404
- 방문: https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00 · 200
- 판정: `page_body` — 폭스5 리뉴 / Original price: 2,340,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.bugaboo.com/kr-ko/folder-user_guides.html · 2026-10-23T13:44:09+09:00 · 200; not_found.
- 세대: 미확인 — 폭스5 리뉴 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 폭스5 리뉴 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 스트롤러 베이스 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]; 시트 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]; 배시넷 패브릭 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]; 퓨어브리즈 매트리스 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]; 썬 캐노피 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]; 언더시트 바스켓 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]
- 호환 기록: 카시트 어댑터 — 어댑터 사용 시 카시트 호환 안내. 카시트별 조합과 타 세대 호환은 별도 확인 필요 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T13:44:09+09:00]
- 보증: 공식몰 구매 시 보증 연장 안내. 기본 보증은 구매 지역·최초 구매자 조건 적용; 순정 또는 승인 부품만 사용 [https://www.bugaboo.com/kr-ko/품질-보증/ · 2026-10-23T13:44:09+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-11 · Bugaboo — 폭스5 느와르 리미티드

- 방문: https://www.bugaboo.com/kr-ko/strollers/bugaboo-fox-5-renew/ · 2026-10-23T13:41:22+09:00 · 404
- 방문: https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html · 2026-10-23T14:42:22+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 폭스 리뉴 일반 제품만 확인되어 느와르 한정판 가격으로 대체하지 않음 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.bugaboo.com/kr-ko/folder-user_guides.html · 2026-10-23T13:44:09+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-12 · Bugaboo — 버터플라이2(범퍼바 포함)

- 방문: https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00 · 200
- 판정: `page_body` — 버터플라이2(범퍼바 포함) / 상품 가격(할인 표기 없음): 950,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.bugaboo.com/kr-ko/folder-user_guides.html · 2026-10-23T13:44:09+09:00 · 200; not_found.
- 세대: 미확인 — 버터플라이2(범퍼바 포함) 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 버터플라이2(범퍼바 포함) 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 스트롤러 베이스 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00]; 시트 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00]; 썬 캐노피 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00]; 언더시트 바스켓 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00]; 범퍼바 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00]
- 호환 기록: 카시트 어댑터 — 어댑터 사용 시 카시트 호환 안내. 카시트별 조합과 타 세대 호환은 별도 확인 필요 [https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-butterfly-2/부가부-버터플라이-2-휴대용-스트롤러-범퍼바-포함-PM007649.html · 2026-10-23T13:41:24+09:00]
- 보증: 공식몰 구매 시 보증 연장 안내. 기본 보증은 구매 지역·최초 구매자 조건 적용; 순정 또는 승인 부품만 사용 [https://www.bugaboo.com/kr-ko/품질-보증/ · 2026-10-23T13:44:09+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-13 · Bugaboo — 드래곤플라이(배시넷 포함)

- 방문: https://www.bugaboo.com/kr-ko/strollers/bugaboo-dragonfly/ · 2026-10-23T13:41:26+09:00 · 404
- 방문: https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-dragonfly-plus-seat/부가부-드래곤플라이-플러스-절충형-스트롤러-PM007941.html · 2026-10-23T14:59:21+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 현행 드래곤플라이 플러스만 확인됨, 기존 배시넷 구성 및 단종 고지 본문은 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.bugaboo.com/kr-ko/folder-user_guides.html · 2026-10-23T13:44:09+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-14 · Bugaboo — 드래곤플라이 섀시(시트 구성)

- 방문: https://www.bugaboo.com/kr-ko/strollers/bugaboo-dragonfly/ · 2026-10-23T13:41:28+09:00 · 404
- 방문: https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-dragonfly-plus-seat/부가부-드래곤플라이-플러스-절충형-스트롤러-PM007941.html · 2026-10-23T14:59:21+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 현행 드래곤플라이 플러스 가격을 기존 시트 구성에 대입하지 않음 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.bugaboo.com/kr-ko/folder-user_guides.html · 2026-10-23T13:44:09+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-15 · Cybex — 프리암 4.0

- 방문: https://www.cybex-shop.co.kr/goods/goods_view.php?goodsNo=1000000344 · 2026-10-23T13:41:19+09:00 · fetch_failed (SSLError)
- 방문: https://www.cybex-shop.co.kr/goods/goods_view.php?goodsNo=1000000344 · 2026-10-23T14:24:39+09:00 · fetch_failed (ReadTimeout)
- 방문: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-16 · Cybex — 미오스 3.0

- 방문: https://www.cybex-shop.co.kr/goods/goods_view.php?goodsNo=1000000343 · 2026-10-23T13:41:28+09:00 · fetch_failed (SSLError)
- 방문: https://www.cybex-shop.co.kr/goods/goods_view.php?goodsNo=1000000343 · 2026-10-23T14:24:39+09:00 · fetch_failed (ReadTimeout)
- 방문: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-17 · Cybex — 멜리오 카본 3.0

- 방문: https://www.cybex-shop.co.kr/goods/goods_main.php?sno=29 · 2026-10-23T13:41:37+09:00 · fetch_failed (SSLError)
- 방문: https://www.cybex-shop.co.kr/goods/goods_main.php?sno=29 · 2026-10-23T14:24:39+09:00 · fetch_failed (ReadTimeout)
- 방문: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-18 · Cybex — 제로나 Gi (회전형 카시트)

- 방문: https://cybex-shop.co.kr/goods/goods_view.php?goodsNo=1000000491 · 2026-10-23T13:41:46+09:00 · fetch_failed (SSLError)
- 방문: https://cybex-shop.co.kr/goods/goods_view.php?goodsNo=1000000491 · 2026-10-23T14:24:39+09:00 · fetch_failed (ReadTimeout)
- 방문: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-19 · Cybex — 제로나 T

- 방문: https://www.cybex-shop.co.kr/goods/goods_main.php?sno=29 · 2026-10-23T13:41:56+09:00 · fetch_failed (SSLError)
- 방문: https://www.cybex-shop.co.kr/goods/goods_main.php?sno=29 · 2026-10-23T14:41:37+09:00 · fetch_failed (SSLError)
- 방문: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.cybex-online.com/ko/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-20 · Nuna — 피파 넥스트(바구니 카시트)

- 방문: https://aonebaby.co.kr/product/list.html?cate_no=24 · 2026-10-23T13:41:19+09:00 · fetch_failed (SSLError)
- 방문: https://aonebaby.co.kr/product/list.html?cate_no=24 · 2026-10-23T14:41:45+09:00 · fetch_failed (SSLError)
- 방문: https://nunababy.com/kr/storelocator · 2026-10-23T14:42:22+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://nunababy.com/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-21 · Nuna — 넥스트 시스템(토들넥스트+피파넥스트+베이스)

- 방문: https://aonebaby.co.kr/product/뉴나-넥스트-시스템토들넥스트피파넥스트베이스-아이사이즈-카시트-세트-사은품-쿨시트-후방거울/341/ · 2026-10-23T13:41:28+09:00 · fetch_failed (SSLError)
- 방문: https://aonebaby.co.kr/product/뉴나-넥스트-시스템토들넥스트피파넥스트베이스-아이사이즈-카시트-세트-사은품-쿨시트-후방거울/341/ · 2026-10-23T14:41:49+09:00 · fetch_failed (SSLError)
- 방문: https://nunababy.com/kr/storelocator · 2026-10-23T14:42:22+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://nunababy.com/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-22 · Nuna — 트리브 넥스트 트래블 시스템(+피파넥스트)

- 방문: https://aonebaby.co.kr/product/list.html?cate_no=24 · 2026-10-23T13:41:37+09:00 · fetch_failed (SSLError)
- 방문: https://aonebaby.co.kr/product/list.html?cate_no=24 · 2026-10-23T14:41:49+09:00 · fetch_failed (SSLError)
- 방문: https://nunababy.com/kr/storelocator · 2026-10-23T14:42:22+09:00 · 200
- 판정: `official_unpublished` / `not_listed` — 동일 트리브 트래블 시스템 국내 공식 묶음 정상가 미확인 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://nunababy.com/kr · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-23 · Joie — 아이스핀 360

- 방문: https://joiebaby.co.kr/product/조이-아이스핀360-아이사이즈-회전형-신생아-카시트/29/ · 2026-10-23T13:41:19+09:00 · fetch_failed (SSLError)
- 방문: https://joiebaby.co.kr/product/조이-아이스핀360-아이사이즈-회전형-신생아-카시트/29/ · 2026-10-23T14:41:49+09:00 · fetch_failed (SSLError)
- 방문: https://joiebaby.com/en · 2026-10-23T14:59:21+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://joiebaby.com/en/manuals · 2026-10-23T14:42:22+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-24 · Joie — 아이스핀 360 메쉬

- 방문: https://joiebaby.co.kr/product/list.html?cate_no=24 · 2026-10-23T13:41:28+09:00 · fetch_failed (SSLError)
- 방문: https://joiebaby.co.kr/product/list.html?cate_no=24 · 2026-10-23T14:41:49+09:00 · fetch_failed (SSLError)
- 방문: https://joiebaby.com/en · 2026-10-23T14:59:21+09:00 · 200
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://joiebaby.com/en/manuals · 2026-10-23T14:42:22+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-25 · BabyBjorn — 바운서 블리스

- 방문: https://next.babybjorn.kr/ · 2026-10-23T13:41:19+09:00 · 200
- 방문: https://www.babybjorn.kr/products/baby-bouncers/bouncer-bliss/ · 2026-10-23T13:44:09+09:00 · 200
- 판정: `page_body` — 바운서 블리스 / 상품 가격(할인 표기 없음): 310,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.babybjorn.kr/customer-service/manuals/ · 2026-10-23T13:44:10+09:00 · 200; confirmed.
- 세대: 미확인 — 바운서 블리스 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 바운서 블리스 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 바운서 본체와 패브릭 시트 [https://www.babybjorn.kr/products/baby-bouncers/bouncer-bliss/ · 2026-10-23T13:44:09+09:00]
- 호환 기록: 교체용 패브릭 시트 — 탈부착·교체 가능 안내 확인; 다른 모델·세대와의 공용 여부는 미확인 [https://www.babybjorn.kr/products/baby-bouncers/bouncer-bliss/ · 2026-10-23T13:44:09+09:00]
- 보증: 국내 정식 수입품 정품등록·구매증빙 필요. 제조 결함 기본 보증은 최초 구매 후 2년, 플러스 유상 서비스는 10년 내 조건부 제공 [https://www.babybjorn.kr/pages/general-warranty-policies/ · 2026-10-23T13:44:10+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-26 · BabyBjorn — 바운서 밸런스 소프트

- 방문: https://www.babybjorn.kr/selected/shop/ · 2026-10-23T13:41:22+09:00 · 200
- 방문: https://www.babybjorn.kr/products/baby-bouncers/bouncer-balance-soft/ · 2026-10-23T13:44:09+09:00 · 200
- 판정: `page_body` — 바운서 밸런스 소프트 / 상품 가격(할인 표기 없음): 310,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.babybjorn.kr/customer-service/manuals/ · 2026-10-23T13:44:10+09:00 · 200; confirmed.
- 세대: 미확인 — 바운서 밸런스 소프트 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 바운서 밸런스 소프트 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 바운서 본체와 패브릭 시트 [https://www.babybjorn.kr/products/baby-bouncers/bouncer-balance-soft/ · 2026-10-23T13:44:09+09:00]
- 호환 기록: 교체용 패브릭 시트 — 탈부착·교체 가능 안내 확인; 다른 모델·세대와의 공용 여부는 미확인 [https://www.babybjorn.kr/products/baby-bouncers/bouncer-balance-soft/ · 2026-10-23T13:44:09+09:00]
- 보증: 국내 정식 수입품 정품등록·구매증빙 필요. 제조 결함 기본 보증은 최초 구매 후 2년, 플러스 유상 서비스는 10년 내 조건부 제공 [https://www.babybjorn.kr/pages/general-warranty-policies/ · 2026-10-23T13:44:10+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-27 · BabyBjorn — 베이비 캐리어 하모니

- 방문: https://www.babybjorn.kr/products/baby-carriers/baby-carrier-harmony/ · 2026-10-23T13:41:25+09:00 · 200
- 판정: `page_body` — 베이비 캐리어 하모니 / 상품 가격(할인 표기 없음): 360,000원
- 설명서 검색: https://www.babybjorn.kr/customer-service/manuals/ · 2026-10-23T13:44:10+09:00 · 200; confirmed.
- 세대: 미확인 — 베이비 캐리어 하모니 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 베이비 캐리어 하모니 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 베이비 캐리어 하모니 본체 [https://www.babybjorn.kr/products/baby-carriers/baby-carrier-harmony/ · 2026-10-23T13:41:25+09:00]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 국내 정식 수입품 정품등록·구매증빙 필요. 제조 결함 기본 보증은 최초 구매 후 2년, 플러스 유상 서비스는 10년 내 조건부 제공 [https://www.babybjorn.kr/pages/general-warranty-policies/ · 2026-10-23T13:44:10+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-28 · BabyBjorn — 베이비 캐리어 원 에어

- 방문: https://www.babybjorn.kr/selected/shop/ · 2026-10-23T13:41:26+09:00 · 200
- 방문: https://www.babybjorn.kr/products/baby-carriers/baby-carrier-one-air/ · 2026-10-23T13:44:09+09:00 · 200
- 판정: `page_body` — 베이비 캐리어 원 에어 / 상품 가격(할인 표기 없음): 330,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.babybjorn.kr/customer-service/manuals/ · 2026-10-23T13:44:10+09:00 · 200; confirmed.
- 세대: 미확인 — 베이비 캐리어 원 에어 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 베이비 캐리어 원 에어 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 베이비 캐리어 원 에어 본체 [https://www.babybjorn.kr/products/baby-carriers/baby-carrier-one-air/ · 2026-10-23T13:44:09+09:00]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 국내 정식 수입품 정품등록·구매증빙 필요. 제조 결함 기본 보증은 최초 구매 후 2년, 플러스 유상 서비스는 10년 내 조건부 제공 [https://www.babybjorn.kr/pages/general-warranty-policies/ · 2026-10-23T13:44:10+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-29 · BabyBjorn — 베이비 캐리어 미니

- 방문: https://www.babybjorn.kr/selected/shop/ · 2026-10-23T13:41:29+09:00 · 200
- 방문: https://www.babybjorn.kr/products/baby-carriers/baby-carrier-mini/ · 2026-10-23T13:44:10+09:00 · 200
- 판정: `page_body` — 베이비 캐리어 미니 / 상품 가격(할인 표기 없음): 180,000원 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.babybjorn.kr/customer-service/manuals/ · 2026-10-23T13:44:10+09:00 · 200; confirmed.
- 세대: 미확인 — 베이비 캐리어 미니 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 베이비 캐리어 미니 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 베이비 캐리어 미니 본체 [https://www.babybjorn.kr/products/baby-carriers/baby-carrier-mini/ · 2026-10-23T13:44:10+09:00]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 국내 정식 수입품 정품등록·구매증빙 필요. 제조 결함 기본 보증은 최초 구매 후 2년, 플러스 유상 서비스는 10년 내 조건부 제공 [https://www.babybjorn.kr/pages/general-warranty-policies/ · 2026-10-23T13:44:10+09:00]
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-30 · Egg — 에그3 디럭스

- 방문: https://www.eggstroller.co.kr/goods/view?no=78 · 2026-10-23T13:41:19+09:00 · fetch_failed (SSLError)
- 방문: https://www.eggstroller.co.kr/goods/view?no=78 · 2026-10-23T14:41:53+09:00 · fetch_failed (SSLError)
- 방문: https://eggstroller.com/stockists/ · 2026-10-23T13:44:11+09:00 · 404
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://eggstroller.com/ · 2026-10-23T14:59:21+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-31 · Egg — 애스턴마틴 에그3

- 방문: https://www.eggstroller.co.kr/goods/view?no=128 · 2026-10-23T13:41:28+09:00 · fetch_failed (SSLError)
- 방문: https://www.eggstroller.co.kr/goods/view?no=128 · 2026-10-23T14:41:57+09:00 · fetch_failed (SSLError)
- 방문: https://eggstroller.com/stockists/ · 2026-10-23T13:44:11+09:00 · 404
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://eggstroller.com/ · 2026-10-23T14:59:21+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-32 · D.THRONE — 이니셜 신생아 디럭스 유모차

- 방문: https://www.dthrone.com/102/?idx=58 · 2026-10-23T13:41:30+09:00 · 200
- 판정: `page_body` — 이니셜 신생아 디럭스 유모차 / 상품 가격(할인 표기 없음): 1,090,000원
- 설명서 검색: https://www.dthrone.com/FAQ · 2026-10-23T13:44:11+09:00 · 403; not_found.
- 세대: 미확인 — 이니셜 신생아 디럭스 유모차 제품명만 확인; 제조 연도·부품 개정별 세대 구분은 확인하지 못함
- 국내 정식 구성: 미확인 — 이니셜 신생아 디럭스 유모차 페이지의 포함품은 별도 기록했으나 국내 판매 옵션별 정식 구성 범위는 확인하지 못함
- 포함품 기록: 이니셜 유모차 본체 [https://www.dthrone.com/102/?idx=58 · 2026-10-23T13:41:30+09:00]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-33 · Britax — 듀얼픽스 프로 LUX

- 방문: http://britaxmall.co.kr/lg_main/index.php · 2026-10-23T13:41:30+09:00 · fetch_failed (ConnectTimeout)
- 방문: http://britaxmall.co.kr/lg_main/index.php · 2026-10-23T14:41:57+09:00 · fetch_failed (ConnectTimeout)
- 방문: https://www.britax-roemer.com/service-support/user-instructions · 2026-10-23T13:44:12+09:00 · 404
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.britax-roemer.com/support/user-instructions · 2026-10-23T14:59:21+09:00 · 404; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-34 · Britax — 듀얼픽스 프로 STYLE

- 방문: http://britaxmall.co.kr/lg_main/index.php · 2026-10-23T13:42:01+09:00 · fetch_failed (ConnectTimeout)
- 방문: http://britaxmall.co.kr/lg_main/index.php · 2026-10-23T14:41:57+09:00 · fetch_failed (ConnectTimeout)
- 방문: https://www.britax-roemer.com/service-support/user-instructions · 2026-10-23T13:44:12+09:00 · 404
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.britax-roemer.com/support/user-instructions · 2026-10-23T14:59:21+09:00 · 404; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-35 · Britax — 듀얼픽스 프로 CLASSIC

- 방문: http://britaxmall.co.kr/lg_main/index.php · 2026-10-23T13:43:46+09:00 · fetch_failed (ConnectTimeout)
- 방문: http://britaxmall.co.kr/lg_main/index.php · 2026-10-23T14:41:57+09:00 · fetch_failed (ConnectTimeout)
- 방문: https://www.britax-roemer.com/service-support/user-instructions · 2026-10-23T13:44:12+09:00 · 404
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.britax-roemer.com/support/user-instructions · 2026-10-23T14:59:21+09:00 · 404; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-36 · Maxi-Cosi — 미카 360 프로

- 방문: http://www.mbaby.co.kr/shop/shopbrand.html?mcode=001&type=X&xcode=019 · 2026-10-23T13:41:33+09:00 · fetch_failed (ConnectTimeout)
- 방문: http://www.mbaby.co.kr/shop/shopbrand.html?mcode=001&type=X&xcode=019 · 2026-10-23T14:42:01+09:00 · fetch_failed (ConnectTimeout)
- 방문: https://www.maxi-cosi.com/international/retailers · 2026-10-23T13:44:12+09:00 · fetch_failed (ReadTimeout)
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.maxi-cosi.com/ · 2026-10-23T14:59:22+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-37 · Maxi-Cosi — 타이탄 프로

- 방문: http://www.mbaby.co.kr/shop/shopbrand.html?mcode=001&type=X&xcode=019 · 2026-10-23T13:42:04+09:00 · fetch_failed (ConnectTimeout)
- 방문: http://www.mbaby.co.kr/shop/shopbrand.html?mcode=001&type=X&xcode=019 · 2026-10-23T14:42:05+09:00 · fetch_failed (ConnectTimeout)
- 방문: https://www.maxi-cosi.com/international/retailers · 2026-10-23T13:44:12+09:00 · fetch_failed (ReadTimeout)
- 판정: `official_unpublished` / `fetch_failed` — 국내 공식몰 재시도 후에도 본문을 읽지 못해 정상가·국내 구성을 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.maxi-cosi.com/ · 2026-10-23T14:59:22+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-38 · Silver Cross — 리프2

- 방문: https://www.silvercrossbaby.com/ · 2026-10-23T13:41:37+09:00 · 200
- 판정: `official_unpublished` / `importer_unconfirmed` — 제조사 안내에서 국내 공식 수입사와 동일 국내 구성의 공식가를 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.silvercrossbaby.com/pages/instruction-manuals · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-39 · Silver Cross — 듄2

- 방문: https://www.silvercrossbaby.com/ · 2026-10-23T13:41:39+09:00 · 200
- 판정: `official_unpublished` / `importer_unconfirmed` — 제조사 안내에서 국내 공식 수입사와 동일 국내 구성의 공식가를 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.silvercrossbaby.com/pages/instruction-manuals · 2026-10-23T13:44:10+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-40 · Ergobaby — 옴니 브리즈

- 방문: https://ergobaby.com/international-distributors · 2026-10-23T13:41:37+09:00 · 404
- 방문: https://ergobaby.com/en-us/pages/international-distributors · 2026-10-23T13:44:10+09:00 · 403
- 판정: `official_unpublished` / `importer_unconfirmed` — 제조사 안내에서 국내 공식 수입사와 동일 국내 구성의 공식가를 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://ergobaby.com/en-us/pages/instructions · 2026-10-23T13:44:11+09:00 · 403; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

### model-41 · Doona — 두나 카시트 겸용 유모차

- 방문: https://www.doona.com/en-us/where-to-buy · 2026-10-23T13:41:39+09:00 · 404
- 방문: https://www.doona.com/en/store-locator · 2026-10-23T14:59:21+09:00 · 200
- 판정: `official_unpublished` / `importer_unconfirmed` — 제조사 안내에서 국내 공식 수입사와 동일 국내 구성의 공식가를 확인하지 못함 원래 검색 요약 근거를 폐기함. 기존 출처를 공식 제품/지원 주소로 교체함.
- 설명서 검색: https://www.doona.com/en-us/support/user-guides · 2026-10-23T13:44:11+09:00 · 200; not_found.
- 세대: 미확인 — 제조 연도·부품 개정별 세대 구분 미확인
- 국내 정식 구성: 미확인 — 국내 정식 기본 구성 상세 미확인
- 포함품 기록: 국내 기본 포함 구성품 미확인 [미확인: 공식 본문에서 기본 포함 목록을 확인하지 못함]
- 호환 기록: 확인한 부품 없음; 비호환을 뜻하지 않음
- 보증: 해당 국내 구성의 보증 조건 본문 미확인
- 인증: 확인 가능한 공식 텍스트에서 해당 국내 구성의 KC 인증번호를 확보하지 못함; 인증 부재를 뜻하지 않음

## 리뷰 수정 기록

실패 URL을 성공 출처로 채택한 기록을 철회했다(위 방문 행은 실패 시도 이력으로 유지). 세대와 국내 정식 구성은 제품명을 반복한 문구 대신 미확인 상태와 이유를 기록했다. 위 구성품·호환·보증 목록은 기존 본문 확인 당시 채택한 사실이며 이번 리뷰에서 새로 확인한 사실로 간주하지 않는다. CPSC 필터 제외 ID와 제목도 저장해 사후 검토가 가능하다.

### 대체 표기 실조회 결과 · 2026-10-23T15:25:16.978+09:00

총 52회 요청, 모든 브랜드 조회 완료. Maxi-Cosi 기본 표기로는 없던 모회사 Dorel 리콜 8건을 추가 검토 대상으로 기록했다. Dorel Home Furnishings·Dorel Asia 등 광범위한 동명 그룹 결과도 포함하므로 해당 국내 모델 리콜로 단정하지 않고 모두 unknown으로 두었다. BabyBjorn은 BabyBjorn·Baby Bjorn·BabyBjörn을 각각 조회했으나 결과가 없었다. 이는 안전 보장이 아니며 CPSC 외 관할과 검색 API의 한계가 있다.

| 브랜드 | 원시 행 합계 | 채택 고유 ID | 필터 제외 고유 ID |
| --- | ---: | ---: | ---: |
| Stokke | 5 | 4 | 0 |
| Bugaboo | 11 | 6 | 0 |
| Cybex | 13 | 2 | 5 |
| Nuna | 1 | 1 | 0 |
| Joie | 0 | 0 | 0 |
| BabyBjorn | 0 | 0 | 0 |
| Egg | 0 | 0 | 0 |
| D.THRONE | 0 | 0 | 0 |
| Britax | 12 | 8 | 0 |
| Maxi-Cosi | 10 | 8 | 0 |
| Silver Cross | 0 | 0 | 0 |
| Ergobaby | 1 | 1 | 0 |
| Doona | 0 | 0 | 0 |

Cybex의 제외된 운동기구 등 5건의 ID/제목은 seed/recalls.json의 rejected에 보존했다. 질의별 요청 필드와 응답 행 수는 requests에 남겼다. 원시 행 합계는 여러 질의에 중복 응답된 행을 포함한다. 모델별 검토 ID는 이번 스냅샷과 동기화했고 추가 ID의 국내 적용 여부는 추정하지 않았다.
