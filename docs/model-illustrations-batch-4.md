# 손그림 상품 이미지 배치 4 (model-31–41)

제작·공식 자료 확인: 2026-10-23. 편집 가능한 SVG 9개와 투명 PNG 18개를 추가하고 `lib/model-illustrations.ts`에 연결했다. **model-32(D.THRONE 이니셜)와 model-39(Silver Cross 듄2)는 기준 내 공식 썸네일을 확보하지 못해 그리지 않았고 등록하지 않았다(blocked).** 두 모델은 카드에서 브랜드 첫 글자 자리표시를 유지한다. 사이트의 정적 에셋·검수 도구·테스트·문서만 변경했다. 카드 컴포넌트·CSS, 시드, Linux 크롤러(`crawler/config/model-families.json` 포함), 마이그레이션, 큐 파일은 변경하지 않았다. 근거 문서 `model-evidence-2026-10-23.md`도 수정하지 않았다.

## 1. 규격

배치 3과 같다. `public/img/models/model-N.svg`가 편집 원본이다(`viewBox="0 0 1080 1080"`, 루트 그룹 `fill="none" stroke="#334338" stroke-width="5.5"` 라운드 캡·조인). 경로별 선 굵기는 5.2–6.0, 태그는 `svg/title/g/path`뿐이다. 글자 모양 경로·로고·표시 텍스트·배경판·액자·그림자·`transform`은 없고 시드 모델명은 비표시 `<title>`에만 있다. 필수 구성 그룹은 모두 최상위 `<g id="…">`이다. 동일 SVG를 오프라인 Playwright 렌더러로 540×540·252×252 투명 PNG로 만들었다. 카드 UI는 상품명·손그림·공식가·현재 공구가(또는 '진행 중인 공구 없음')만 표시하는 기존 구성 그대로다.

`SQUARE_MODEL_IDS`는 model-1–41에서 blocked 둘(32, 39)을 뺀 39개다. 자리표시 검증용 시드 밖 ID는 `model-42`로 옮겼다(`scripts/card-screenshots.ts`, `tests/models-page.test.ts`, `tests/model-cards.test.ts`).

## 2. 사진 처리

- 허용 기준: 가로·세로 300px 이하. 공식 CDN의 축소 파라미터(Shopify `width`, Demandware `sw/sh`, Maxi-Cosi·Doona·Ergobaby 공식 소형 이미지)만 요청했다.
- 참조 사진은 `.local/ref-batch4/`(gitignore)에서만 임시 확인했고 확인 직후 삭제했다. 로컬 축소본·사본은 만들지 않았다. 작업 종료 시 `.local/ref-batch4/`는 비어 있다(`find … | wc -l` = 0). 참조 사진은 저장소 어디에도 없다.
- 이 재시도 세션에서는 새 사진을 내려받지 않았다. 이전 시도에서 남긴 관찰 기록(실루엣·바퀴·캐노피·하네스·베이스·손잡이 체크리스트)과 공식 페이지 텍스트 기록만 사용했다.
- 공식 출처에서 기준 내 썸네일을 끝내 얻지 못한 모델은 그리지 않았다: model-32, model-39(아래 4절).

## 3. 모델별 구성 확정 표

상태는 `confirmed-single`(공식 자료상 본체만 포함), `confirmed-set`(공식 포함 목록 확인), `unconfirmed`(공식 자료에서 포함 목록을 찾지 못함)이다. **`unconfirmed`는 세트가 아니라는 뜻이 아니다.** 확인되지 않은 액세서리는 추정해서 넣지 않았고, 구성이 확인되면 `tests/model-illustrations.test.ts`의 `BATCH4` 표와 그림을 함께 갱신해야 한다. **확인한 구성은 해당 글로벌 시장 기준이며 국내 정식 구성과 다를 수 있다.** 시드의 국내 구성은 모두 `unconfirmed`다.

| ID | 상태 | 근거 URL (2026-10-23 UTC, 응답) | 그린 그룹 | 비고 |
| --- | --- | --- | --- | --- |
| 31 애스턴마틴 에그3 | confirmed-set (영국 공식 패키지) | https://eggstroller.com/pages/aston-martin-egg3 (11:03, 200), https://eggstroller.com/products/aston-martin-egg3-package-classic-grey (11:02, 200) | `chassis` `seat` `canopy` `wheels` `carrycot` `footmuff` `backpack` `seat-liner` `car-seat-adapters` `deluxe-blanket` `carrycot-sherpa-topper` `carrycot-fitted-sheets` `rain-covers` | 공식 "The Package" 목록: 유모차·캐리콧·백팩·풋머프, 멀티 카시트 어댑터, 리버서블 플리스 시트 라이너, 디럭스 블랭킷, 캐리콧 셰르파 토퍼, 캐리콧 핏티드 시트, 캐리콧·유모차 레인커버. 모두 별도 그룹으로 그림. 전시용 옵션 카시트는 기본 포함품이 아니라 제외. 날개 로고는 생략. model-30(단품)과 경로 집합이 다름 |
| 32 D.THRONE 이니셜 신생아 디럭스 | blocked | https://www.dthrone.com/102/?idx=58 (403 → 이후 재확인에서는 200이나 본문이 "접근할 수 없습니다" 후 `/`로 이동), https://shopdthrone.com/ (SSLError) | 없음 | 포함품 기록은 시드의 "본체"뿐(국내 구성 미확인). 공식 사진 접근 불가로 그리지 않음 |
| 33 듀얼픽스 프로 LUX | confirmed-set | https://www.britax-roemer.com/car-seats/baby-car-seats/dualfix-pro/2000040886.html (11:04, 200) | `shell` `harness` `integral-rotating-base` `newborn-insert` | 공식 갤러리에 신생아 인서트 컷 확인 |
| 34 STYLE | confirmed-set | …/dualfix-pro/2000040883.html (11:04, 200) | 33과 동일 | 구조 동일, 원단 차이는 작은 사진에서 확인 불가 → 봉제 차이를 지어내지 않음 |
| 35 CLASSIC | confirmed-set | …/dualfix-pro/2000040880.html (200) | 33과 동일 | 위와 같음 |
| 36 미카 360 프로 | confirmed-set | https://www.maxi-cosi.co.uk/car-seats/mica-360-pro (11:03, 200) | 33과 동일 | "Removable inlay: Yes, ISOFIX base included and attached". 회전 베이스 경로만 33–35와 다름 |
| 37 타이탄 프로 | confirmed-single | https://www.maxi-cosi.es/sillas-de-coche/titan-pro-i-size (11:08, 200), https://www.maxi-cosi.ie/car-seats/titan-pro (11:07, 200→Titan Pro² i-Size) | `shell` `harness` `isofix-tether` | "Removable inlay: No", ISOFIX 베이스는 일체형. 회전 베이스·분리 베이스·인서트 그룹 없음(구조 판단) |
| 38 리프2 | confirmed-set (미국 공식 "In the Box") | https://silvercrossus.com/product/silver-cross-reef-2-foldable-stroller/ (11:06, 200) | `chassis` `seat` `canopy` `wheels` `basket` `rain-cover` `newborn-apron` | 섀시·시트·레인커버, 뉴본 에이프런 포함. 캐리콧은 별도 옵션이라 그리지 않음. 영국 번들 URL은 다른 상품으로 리디렉트됨 |
| 39 듄2 | blocked | https://www.silvercrossbaby.com/products/dune-2 (404), `…/dune-2-pushchair-space`, `…/dune-space`, https://silvercross.com.au/products/dune-2-space, https://www.silvercrossbaby.ie/prams-pushchairs/dune-2 (모두 404), 공식 `products.json` 전체에 듄2 유모차 없음(Dune/Reef 액세서리만) | 없음 | 미국 공식 사이트의 Dune 사진은 2022년 1세대라 사용하지 않음 |
| 40 옴니 브리즈 | unconfirmed | 일본 공식 사용법 썸네일(300×169)로 외형 확인. https://ergobaby.jp/collections/omni-breeze 404, 영문 공식 페이지 ergobaby.com·ergobaby.eu·ergobaby.co.uk 403, ergobaby.com.au 404 | `body-panel` `shoulder-straps` `waist-belt` `buckle` | 구성 미확인, 본체만 묘사, 구성 확인 시 그룹 추가 필요. 문자·모델·아기 제외. 27·28·29와 경로 집합이 다름 |
| 41 두나 카시트 겸용 유모차 | unconfirmed | https://www.doona.com/en/car-seat-stroller/discover-doona (11:03, 200), …/discover-doona-plus (11:04, 200) | `infant-carrier` `integrated-wheels` `handle` | 공식 페이지는 ISOFIX 베이스·레인커버·풋머프 등을 "compatible accessories"로만 소개하고 기본 포함 목록은 없음. 구성 미확인, 본체만 묘사, 구성 확인 시 그룹 추가 필요. 별매 확인이 없으므로 `isofix-base` 부재를 단언하지 않음(테스트도 없음) |

## 4. 접속 실패와 대체 자료

국내몰 SSL·타임아웃 실패는 근거 문서에 이미 있어 수정하지 않았다. 이번 작업의 대체·실패 기록:

- D.THRONE: `m.shopdthrone.com/product/list_zoom.html?cate_no=82`, `shopdthrone.com/product/list.html?cate_no=82`, `shopdthrone.com/` SSLError, `http://shopdthrone.com/…` ConnectTimeout, `dthrone.com/102/?idx=58`·`/102` 403.
- Ergobaby: `ergobaby.com/baby-carrier/omni-breeze` 403, `ergobaby.eu` 403 → 일본 공식 사용법 썸네일로 외형만 확인.
- Silver Cross 듄2: 위 404 목록. 공식 카탈로그에서 듄2 유모차를 찾을 수 없어 리프2의 사진을 대신 쓰지 않았다.
- Maxi-Cosi `…/titan-pro`, `…/titan-pro-i-size`(UK)는 카테고리로 리디렉트됨 → ES·IE 공식 페이지 사용. `maxi-cosi.fr/sieges-auto/titan-pro` 404.
- 기준(300px·150KB)을 넘어 열람 없이 삭제한 URL: 없음(이 세션에서 받은 사진 없음).

## 5. 그룹별 고유 경로 / 곡선 경로 수

| ID | 그룹: 고유 경로/곡선(C·Q) |
| --- | --- |
| 31 | chassis 29/23, seat 22/21, canopy 20/20, wheels 33/33, carrycot 25/25, footmuff 26/26, backpack 22/22, seat-liner 22/22, car-seat-adapters 42/42, deluxe-blanket 22/22, carrycot-sherpa-topper 31/31, carrycot-fitted-sheets 22/22, rain-covers 31/31 |
| 33–35 | shell 35/35, harness 22/22, integral-rotating-base 24/24, newborn-insert 24/24 |
| 36 | shell 35/35, harness 22/22, integral-rotating-base 23/23, newborn-insert 24/24 |
| 37 | shell 35/35, harness 22/22, isofix-tether 22/22 |
| 38 | chassis 26/12, seat 25/25, canopy 20/20, wheels 21/21, basket 21/21, rain-cover 34/34, newborn-apron 29/29 |
| 40 | body-panel 25/25, shoulder-straps 22/20, waist-belt 22/22, buckle 22/22 |
| 41 | infant-carrier 33/33, integrated-wheels 37/31, handle 22/18 |

테스트는 `BATCH4` 표의 모든 그룹에 고유 경로 20개 이상·곡선 12개 이상을 요구하고, SVG의 최상위 그룹 ID 집합이 표와 정확히 같음을 검사한다. 경로 집합 쌍 비교는 `[30,31] [33,36] [34,36] [35,36] [27,40] [28,40] [29,40]`이다. **33·34·35는 공식 썸네일에서 구조 차이를 확인할 수 없어 서로 경로 집합이 같다.** 이는 의도한 예외이며(`DUALFIX trim variants` 테스트가 동일함을 명시), 쌍 비교 `[33,34] [33,35] [34,35]`와 `[38,39]`는 사유와 함께 뺐다. 그림 차이는 36의 베이스 경로뿐이라 카드에서 33–36의 구별은 약하다. 사람 검수에서 보강 대상이다.

## 6. 시각 검수 결과 (에이전트 화면 검수, 사람의 최종 감수를 대신하지 않음)

- 썸네일 확인 시점의 형태 대조 기록(관찰 요약): 31 뒤 큰 휠·앞 작은 휠, 포드 시트, 분절 캐노피, 분리 캐리콧·풋머프·백팩·라이너·어댑터 / 33–35 넓은 U 날개 셸, 인서트 패드, 가운데 버클, 낮은 회전 베이스와 수직 서포트 레그 / 36 긴 세로 셸, 아래 회전 테두리, 단일 수직 레그 / 37 높은 셸과 양옆 날개, 회전 디스크 없음 / 38 높고 각진 캐노피, 뒤로 기운 시트, 큰 뒷바퀴·작은 앞바퀴, 낮은 바스켓 / 40 넓은 어깨 패드·헤드지지판·허리 패드·옆 버클 / 41 길쭉한 셸·초록 캐노피, X 접이 프레임, 뒷 큰 휠·앞 작은 휠. 렌더링한 PNG와 대조했을 때 바퀴 수와 배치, 캐노피 형상, 레그·베이스, 하네스 경로, 손잡이 위치가 일치한다.
- 스크린샷(390px·1280px × 라이트·다크 전체 4장, 카드 36장)을 직접 열어 확인: 이미지 안 텍스트·로고 없음, 이중 액자 없음, 잘림 없음, 자리표시는 `model-42` 한 장뿐. 31(세트)과 단품이 즉시 구별되고 38도 레인커버·에이프런이 함께 보인다. 33/34/35/36은 서로 비슷하다(위 한계).
- model-31·38은 한 장에 여러 구성품을 나란히 두어 252px에서 구성품 크기가 작다. 잉크 비율 제한(20% 미만)에 맞추려고 장식선을 줄였다. 레인커버·핏티드 시트처럼 얇은 연질 구성품은 형태가 단순해 사람 검수에서 보강할 수 있다.

## 7. 실행한 명령

```sh
npx tsx scripts/render-model-illustrations.ts model-31 model-33 model-34 model-35 model-36 model-37 model-38 model-40 model-41
npm test -- tests/model-illustrations.test.ts tests/model-cards.test.ts tests/models-page.test.ts
npx tsx scripts/card-screenshots.ts --out .local/card-screenshots-batch4
npm test && npm run lint && npm run typecheck && npm run build && npm run build:worker
git diff --check
find .local/ref-batch4 -mindepth 1 | wc -l   # 0
```

## 8. SVG 직접 표시 및 누락 모델 보완 (2026-10-31)

위 1–7절은 2026-10-23 제작 당시의 기록이다. 현재는 두 blocked 모델의 시각 자료를 확보하여 보완했다. **시드 41개 모두 1080×1080 SVG로 등록되어 직접 표시되며 누락된 그림은 없다.** 기존 SVG 39개는 보존하고 32·39만 새로 그렸다. 사용하지 않는 PNG 파생 파일 78개는 소비 코드 검색 후 삭제했다. 카드의 상품명·손그림·공식가·현재 공구가 네 항목, 접근 가능한 상품명, lazy loading·async decoding은 유지한다. 런타임 정적 허용 목록에 시드를 import하지 않는다.

### 새 시각 근거와 범위

모두 2026-10-31에 직접 열람했다. 아래 사진·PDF는 gitignore된 `.local/illustration-references/`에서만 확인했으며 저장소에 추가하지 않는다. 과거 300px 썸네일 실패 기록은 그대로 보존하고, 이번에는 실제 내려받을 수 있는 제품 사진과 설명서 도해를 확인했다. 가격·국내 구성 근거·시드는 변경하지 않는다.

| 모델 | 출처·세대 확인 | 관찰하여 그린 형태 | 구성 판단 |
| --- | --- | --- | --- |
| 32 D.THRONE 이니셜 신생아 디럭스 유모차 | [D.THRONE 공식 상품 페이지](https://www.dthrone.com/102/?idx=58)의 상품명과 연결 갤러리 [750px JPEG](https://cdn-optimized.imweb.me/upload/S202101149e6675f8ef655/e477bf0e73af4.jpg?w=750). 웹 읽기로 본문·갤러리 연결 확인, CDN 사진 직접 열람 성공. 별도 HTML 다운로드는 403이어서 사진 출처를 다른 제품으로 대체하지 않았다. | 왼쪽을 향한 시트·낮아진 발받침, 넓고 둥근 분절 캐노피, 구부러진 범퍼, 오른쪽 위 푸시 핸들, 원형 시트 연결부, 앞쪽으로 휘는 프레임과 뒷다리, 큰 뒤 휠·작은 앞 휠, 깊은 하부 바스켓, 시트 하네스. 뒤쪽 먼 휠은 바스켓 아래 보이는 부분만 그렸다. | 조립 본체 외 분리 부품 없음. 모터·구동 장치·별도 어댑터·커버·캐리콧 등은 확인하지 못했으므로 추가하지 않음. 국내 포함품 묶음은 `unconfirmed` 유지. |
| 39 Silver Cross 듄2 | [Silver Cross Thailand 설명서 목록](https://silvercrossthailand.com/instruction-manuals/)의 **DUNE 2** 항목이 같은 세대 [제품 사진](https://silvercrossthailand.com/wp-content/uploads/2026/07/Dune_2_Mocha_3Q_World_Facing-1-600x600.webp)과 [Dune 2 Chassis & Seat PDF](https://silvercrossthailand.com/wp-content/uploads/2026/07/dune-seat-and-chassis-have-thai.pdf)를 함께 연결한다. 600px WEBP 직접 열람, PDF 표지·인쇄 페이지 3·6 도해 직접 렌더링·열람. 표지의 Dune 2 표기와 본문의 Silver Cross 제조사 연락처·silvercrossbaby.com 표기를 확인했다. 태국 지역 브랜드 사이트가 호스팅하는 제조사 설명서이며 국내 공식 구성 자료는 아니다. | 오른쪽을 향한 패딩 시트와 짧은 발받침, 앞쪽 활 모양 캐노피 림과 뒤쪽 분절, 푸시 핸들, 중앙 원형 접이 관절, 교차 프레임, 낮은 바스켓, 뒤쪽 큰 휠과 앞쪽 작은 스위블 휠, 곡선 범퍼, 가운데 버클과 어깨 하네스. 사진에서 가려진 먼 휠은 일부 윤곽만 표시. 설명서의 섀시·시트 조립 형태와 대조. | 본체만 그림. 설명서의 캐리콧·일부 액세서리 별매 표기는 국내 번들 포함 목록을 확정하지 않는다. 레인커버·에이프런·카시트·어댑터·캐리콧은 추가하지 않음. 1세대 Dune 또는 Reef 2 그림을 재사용하지 않았다. 국내 구성은 `unconfirmed`. |

두 SVG의 최상위 그룹은 `chassis`, `basket`, `wheels`, `seat`, `canopy`, `bumper-bar`, `harness`다. 제품 사진에서 관찰한 윤곽·접합부·봉제선·휠만 그리고 로고나 글자는 생략했다. 경로 수를 맞추기 위한 장식선을 추가하지 않았다. 테스트는 이 두 모델에 관찰한 그룹과 최소 윤곽 수(32: 6개, 39: 5개; 각 그룹 곡선 1개 이상)를 검사하며 기존 배치의 20개/12개 조건은 보존한다. 제품 충실도는 경로 수가 아니라 사진·설명서와 시각 대조하여 확인했다. Reef 2와 Dune 2의 경로 집합 차이도 이제 검사한다. DUALFIX 33–35의 동일 구조와 다른 모델의 기존 글로벌 구성 근거·불확실성은 변경하지 않았다.

### 현재 도구 계약

- `render-model-illustrations.ts`: 기본 대상은 레지스트리가 아니라 시드 전체. 누락 등록·파일을 실패로 처리한다. 허용 태그·정사각 크기·문자/활성 콘텐츠 금지 검사 후 252px·540px로 메모리 렌더링해 기존 잉크량(최소 크기×4, 면적 20% 미만)·2.5% 투명 여백을 확인한다. 기본은 파일 생성 없음. `--out .local/illustration-previews`를 명시해야 PNG 미리보기를 저장하며 `public/` 출력은 거부한다.
- `card-screenshots.ts`: 시드 41개와 알 수 없는 `model-42` fixture를 사용. `image/svg+xml` data URL로 SVG를 인라인하여 네트워크를 차단한다. 기본 전체 화면 4장·카드 164장을 저장한다. 41개 모두 디코딩·정사각 이미지·자리표시 없음, 네 항목 카드, 같은 행 높이·공구가 행 높이·가로 넘침을 확인하며 미등록 fixture의 자리표시는 별도로 유지한다. 네 항목 회귀는 `tests/models-page.test.ts`에서 시드 전체로 검증한다.

### 이번 검증 결과

- 영향받는 테스트 3개 파일: **72개 통과**. SVG 파일 목록 41개, 시드 전체 등록, 크기·허용 태그·비표시 제목·외부/활성 콘텐츠 금지, 구성 구별, unknown ID, 네 항목 카드 검사 통과.
- 오프라인 SVG 검사: **41/41**, 252px·540px 모두 투명 여백·잉크량·잘림 검사 통과. 기본 실행은 파일을 만들지 않음.
- 스크린샷: `.local/card-qa/`에 390px·1280px × 라이트·다크 전체 4장과 개별 카드 164장. 전체 네 화면 및 32·39의 네 모드 개별 카드를 직접 열어 확인했다. 제품 그림 안 글자·로고 없음, 잘림·가로 넘침 없음, 정사각 비율·행 높이·밝고 어두운 화면의 선 대비 확인. 기존 소형 부속품은 여전히 작게 표시되며 33–35의 트림을 선화만으로 구분할 수 없다는 한계는 유지한다. 자동 검사는 사람의 최종 제품 감수를 대신하지 않는다.
- `npm run lint`, `npm run typecheck`, `npm run build:worker`(Next.js 빌드 포함), `git diff --check` 통과.
- Wrangler 로컬 smoke: 격리된 `.local/svg-smoke-state` D1에 기존 마이그레이션·시드를 적용하고 `wrangler dev --local --persist-to .local/svg-smoke-state --port 8797`로 실행했다. 네 화면 모드 모두 실제 `/models`의 카드 41개·SVG 41개 디코딩·네 항목·자리표시 없음·가로 넘침 없음 확인. 각 SVG는 HTTP 200과 `image/svg+xml` 응답, 이미지 요청 41개는 모두 직접 SVG 경로였으며 PNG나 `/_next/image` 요청은 없었다. 실제 사이트 캡처도 `.local/card-qa/worker-*.png`에 저장했다. 원격 DB·배포·크롤러는 사용하지 않았다.
