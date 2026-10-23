# 손그림 상품 이미지 배치 3 (model-21–30)

제작·공식 자료 확인: 2026-10-23. 편집 가능한 SVG 10개와 투명 PNG 20개를 추가하고 `lib/model-illustrations.ts`에 연결했다. 사이트의 정적 에셋·검수 도구만 변경했다. 카드 컴포넌트·CSS, 시드 가격·근거, Linux 크롤러와 큐 파일은 변경하지 않았다.

## 원본 규격과 사진 처리

`public/img/models/model-N.svg`가 편집 원본이다. `viewBox="0 0 1080 1080"`, 루트 그룹은 `fill="none" stroke="#334338" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"`이다. 경로별 선 굵기는 5.2–6.0으로 변주했다. 허용 태그는 `svg/title/g/path`뿐이며 제품 윤곽·봉제·입체 두께·결합부를 경로로 표현했다. 글자 모양 경로, 로고, 표시 텍스트, 배경판, 액자, 그림자는 없다. 시드 모델명은 비표시 `<title>` 및 접근성 이름에만 둔다. 동일 SVG를 기존 오프라인 Playwright 렌더러로 540×540·252×252 RGBA PNG로 만들었다.

사진은 제조사 페이지에서 찾은 이미지 URL에 서버 축소 옵션(Nuna 265px, Storyblok `/m/240x320`, Shopify `width=300`, Joie `width=300&height=300&fit=bounds`)을 지정하여 `.local/ref-batch3/`에서 임시 확인했다. 각 확인 직후 파일을 삭제했다. Joie CDN은 옵션을 무시하고 1200×1200을 반환했고, 첫 BASE next URL은 축소 대신 1100×1100 자리표시를 반환했다. 둘 다 확인 후 즉시 삭제했다. BASE next는 같은 공식 페이지의 다른 제품 이미지에 265px 옵션을 적용하여 실제 제품을 다시 확인했다. Joie의 로고 파비콘을 잘못 선택한 요청도 삭제하고 제품 사진으로 다시 확인했다. 원본을 로컬 축소해 참조로 저장하지 않았다.

TRIV next의 링어댑터는 아래 공식 설명서의 부품 목록과 장착 안내도 함께 확인했다. 설명서의 확인 페이지는 320px 썸네일로 열었고 PDF·텍스트·썸네일 모두 확인 후 삭제했다. 참조 디렉터리는 비어 있으며, 참조 사진·설명서를 저장소나 검수 결과물에 포함하지 않는다. 카드 스크린샷에는 새로 그린 선화만 들어간다.

## 모델별 공식 근거와 표현

아래는 외형 제작 근거이며 **가격·국내 정식 구성 재검증이 아니다.** 세트 구성은 이번 작업에서 지정한 범위로 그렸다. 국내 판매점 사은품이나 별도 호환 부품을 추정해 추가하지 않았다.

| ID | 확인한 공식 자료 | 표현한 구성·차이 |
| --- | --- | --- |
| 21 | [TODL next](https://nunababy.com/sg/todl-next-convertible-car-seat), [PIPA next](https://nunababy.com/sg/pipa-next-infant-car-seat-next-system), [BASE next](https://nunababy.com/sg/base-next) | 회전 시트·바구니 카시트·분리 베이스 3종을 나란히 배치. 시트의 헤드레스트 날개·측면 보호·패딩·하네스·회전 하부 경계, 피파의 운반 손잡이·캐노피·셸·벨트 가이드, 베이스의 상판·결합 가이드·ISOFIX 커넥터 2개·지지 다리·조절부·발을 구분. 피파는 기존 model-20의 제품 경로를 좌표 변환해 사용하되 별도 베이스를 추가 |
| 22 | [TRIV next](https://nunababy.com/usa/all-products/triv-next-stroller), [PIPA next](https://nunababy.com/sg/pipa-next-infant-car-seat-next-system), [TRIV next 공식 설명서](https://nunababy.com/media/catalog/product/n/u/nuna_trivnext_user_manual_tw_3513.pdf) | 시트 장착 유모차와 분리 피파, 그 아래 링어댑터를 배치. 큰 뒷바퀴·작은 앞바퀴·포크·바스켓·프레임 관절, 시트·발받침·캐노피, 어댑터의 안팎 링·하부 두께·양쪽 소켓·릴리스 버튼·접이부를 표현. 조립 상태에서 시트와 카시트를 동시에 끼운 모습으로 그리지 않음 |
| 23 | [i-Spin 360](https://joiebaby.com/en/carseats/toddler-child-car-seats/i-spin-360-spinning-baby-car-seat) | 깊은 날개형 셸·헤드레스트·시트 패딩·하네스·측면 보호부. 일체형 회전 베이스·ISOFIX 부위·서포트 레그 포함 |
| 24 | [동일 공식 제품 페이지의 Mercury Mesh 이미지](https://dd.joiebaby.com/media/catalog/product/p/0/p01-joie-spinning-car-seats-i-spin-360-mercury-mesh-hero-spin-right_2.jpg?width=300&height=300&fit=bounds) | 동일 계열의 셸·회전 베이스에 별도 측면·등받이·시트 메시 패널 구조선 추가. 사진의 회전 화살표·브랜드 문자는 옮기지 않음 |
| 25 | [국내 Bouncer Bliss](https://www.babybjorn.kr/products/baby-bouncers/bouncer-bliss/) | 길게 기울어진 패브릭 슬링·곡선 강철 프레임·낮은 삼각 지지·등받이 조절 결합부·패브릭 하네스와 양쪽 버튼. 사진 주변 소품·장난감은 추가하지 않음 |
| 26 | [국내 Bouncer Balance Soft](https://www.babybjorn.kr/products/baby-bouncers/bouncer-balance-soft/) | 두 부분 시트의 둥근 상부 봉제·메시 패널 구조·하부 봉제, Bliss와 다른 프레임 조절 힌지와 하네스 윤곽 |
| 27 | [국내 Baby Carrier Harmony](https://www.babybjorn.kr/products/baby-carriers/baby-carrier-harmony/) | 두꺼운 어깨 패드·헤드 서포트·세로 패널·측면 클립, 넓은 허리 벨트와 요추 패드·버클 |
| 28 | [국내 Baby Carrier One Air](https://www.babybjorn.kr/products/baby-carriers/baby-carrier-one-air/) | 높은 접이식 헤드 서포트·고정 버튼·본체 메시 패널 구조선·직사각 허리 버클. Harmony와 경로 집합이 다름 |
| 29 | [국내 Baby Carrier Mini](https://www.babybjorn.kr/products/baby-carriers/baby-carrier-mini/) | 작은 본체·접히는 헤드 서포트·측면 클립·교차 웨빙·하단 주름. 넓은 허리 패드 없음 |
| 30 | [egg3 Black Olive](https://eggstroller.com/products/egg3-stroller-black-olive), [egg3](https://eggstroller.com/products/egg3-stroller) | 시트 장착 유모차 단품. 곡선 캐노피·포드형 시트·발받침·곡선 섀시·큰 휠·바스켓. 국내 디럭스 구성이 `unconfirmed`이므로 공식 묶음 사진에 함께 있는 캐리콧·가방·액세서리는 추가하지 않음 |

### 접속 실패와 대체 자료

국내몰의 기존 SSL 접속 실패는 [모델 근거 기록](model-evidence-2026-10-23.md)의 model-21–24·30에 남아 있다. 해당 기록을 수정하지 않고 이번 그림에는 글로벌 제조사 자료를 사용했다.

| ID | 기존 국내 접속 실패 URL | 이번 대체 |
| --- | --- | --- |
| 21 | https://aonebaby.co.kr/product/뉴나-넥스트-시스템토들넥스트피파넥스트베이스-아이사이즈-카시트-세트-사은품-쿨시트-후방거울/341/ | 위 TODL/PIPA/BASE next 페이지 |
| 22 | https://aonebaby.co.kr/product/list.html?cate_no=24 | 위 TRIV next 페이지와 설명서 |
| 23 | https://joiebaby.co.kr/product/조이-아이스핀360-아이사이즈-회전형-신생아-카시트/29/ | 글로벌 i-Spin 360 페이지 |
| 24 | https://joiebaby.co.kr/product/list.html?cate_no=24 | 이번 추가 요청 `https://www.joiebaby.co.kr/product/detail.html?product_no=3916`도 SSLError. 글로벌 Mercury Mesh 사진으로 외형 확인 |
| 30 | https://www.eggstroller.co.kr/goods/view?no=78 | 글로벌 egg3·Black Olive 페이지 |

이번 탐색에서 `https://nunababy.com/sg/base-next-car-seat-base`는 404여서 `/sg/base-next`로 대체했다. `/sg/triv-next-compact-stroller`, `/sg/triv-next`, `/usa/strollers/triv-next`, `/usa/pipa-ring-adapter`, `/usa/accessories-extras/triv-series-ring-adapter`, `/uk/base-next`도 404였다. 위 표의 정상 응답 제품 페이지와 TRIV next 설명서를 사용했다. BASE next 첫 이미지의 자리표시를 제품 형태의 근거로 사용하지 않았다.

## 세트 구성 상세

좌표를 SVG 경로에 직접 반영해 변환 래퍼 없이 편집·안전 여백 검사가 가능하다. 경로 수는 윤곽·패딩·봉제·하네스·체결·두께 등의 서로 다른 구조선 수이며 동일 경로 복제로 수를 늘리지 않았다.

| 모델 | 독립 그룹 | 고유 경로 | 곡선 경로 | 카드에서 확인한 구조 |
| --- | --- | ---: | ---: | --- |
| 21 | `toddler-seat` | 40 | 40 | 헤드레스트·날개·하네스·패딩·회전 시트 하부 |
| 21 | `infant-carrier` | 53 | 46 | 바구니 셸·캐노피·높은 손잡이·하네스·가이드 |
| 21 | `isofix-base` | 36 | 36 | 분리된 베이스 상판·결합부·뒤 커넥터·조절 다리·발 |
| 22 | `stroller` | 80 | 76 | 시트·캐노피·관절·바스켓·휠·발받침을 갖춘 유모차 |
| 22 | `infant-carrier` | 53 | 46 | 유모차와 분리된 바구니 카시트 |
| 22 | `ring-adapter` | 25 | 25 | 두께가 있는 안팎 링·양쪽 소켓·버튼·접이부 |

model-21 베이스와 model-22 어댑터는 각각 최소 폭 300 SVG 단위를 검사한다. 각 그룹 20개 이상 고유 경로·12개 이상 곡선 경로와 32–1048의 안전 여백을 검사했다. model-20 피파 단품에는 분리 베이스가 없고, model-23·24에는 일체형 베이스 그룹이 있다. 23/24, 25/26, 27/28/29의 경로 집합 차이도 검사한다.

## 검수와 실행 결과

첫 제어점 여백 검사에서 model-21의 최외곽 제어점이 기준보다 0.59 작아 토들 시트 위치를 안쪽으로 조정했다. TRIV·egg3의 캐노피와 시트 뒤 프레임 경로도 가려지는 구간을 직접 잘라 정리했다. 덧칠·마스크·배경은 사용하지 않았다.

`.local/card-screenshots-batch3/`에 390px·1280px × 라이트·다크 전체 4장과 model-21–30 카드 40장을 생성했다. 전체 4장을 열고 신규 카드 40장을 네 조합의 모아보기로 열어 확인했다. model-21의 시트·피파·다리 베이스 3종, model-22의 시트 장착 유모차·피파·아래 링어댑터 3종을 구별했다. 표시 텍스트·문자 로고·배경판·이중 액자·잘림·깨진 이미지·가로 넘침은 발견하지 않았다. 모바일에서는 작은 봉제선이 축소되지만 독립 구성품 윤곽은 유지된다. 이는 에이전트의 화면 검수 기록이며 사람의 최종 상품 감수를 대신하지 않는다.

자리표시 픽스처는 model-31로 이동했다. 카드는 기존 상품명·손그림·공식가·현재 공구가(또는 진행 중인 공구 없음) 4요소를 유지한다. 기존 CSS의 다크 모드 필터만 사용한다.

```sh
npx tsx scripts/render-model-illustrations.ts model-21 model-22 model-23 model-24 model-25 model-26 model-27 model-28 model-29 model-30
npm test -- tests/model-illustrations.test.ts tests/model-cards.test.ts tests/models-page.test.ts
npx tsx scripts/card-screenshots.ts --out .local/card-screenshots-batch3
npx tsx scripts/card-screenshots.ts --out .local/card-screenshots-batch3-selected --cards model-21,model-22
npm test
npm run lint
npm run typecheck
npm run build
npm run build:worker
git diff --check
```

- 관련 테스트: 3개 파일·25개 통과.
- 전체 테스트: 62개 파일·917개 통과.
- lint·typecheck·Next.js build·Cloudflare Worker build 모두 통과. 빌드만 실행했고 배포하지 않았다.
- 기본 스크린샷 전체 4장·신규 카드 40장, 선택 인자 스크린샷 전체 4장·세트 카드 8장 생성. 디코딩·정사각 비율·공구가 행 높이·동일 행 카드 높이·자리표시·가로 넘침 검사 통과.
- PNG 20개 실제 픽셀의 투명도·RGBA·정사각 비율·2.5% 가장자리 여백 검사 통과.
- 참조 임시 디렉터리 비어 있음. `git diff --check` 통과. 변경 파일은 README·lib·scripts·tests·docs·신규 에셋만 해당한다.
- 커밋·push·PR·배포·브랜치 변경·큐 파일 수정은 수행하지 않았다.
