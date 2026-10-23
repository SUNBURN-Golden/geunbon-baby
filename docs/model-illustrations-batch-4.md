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
