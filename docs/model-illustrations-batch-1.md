# 상품 손그림 배치 1 후속 수정 (model-1–10)

2026-10-23 에이전트 제작·검수 기록. 사이트 정적 에셋과 카드 표시·오프라인 검증만 수정했다. 시드의 가격·출처·확인일, 상세 페이지, Linux 크롤러, 큐는 변경하지 않았다.

## 에셋 계약

model-1–20은 모두 편집 가능한 `1080×1080` SVG와 투명 `540×540`·`252×252` PNG를 사용한다. 배치 2의 252px 계약을 유지했다. 배치 1의 세로 PNG 12개는 삭제했고 디렉터리에는 SVG 20개와 PNG 40개만 남는다. 렌더러는 기본으로 전체 20개를 처리한다.

SVG는 `svg`, `title`, `g`, `path`만 사용한다. 제품 경로는 `fill="none"`, `stroke="#334338"`이며 둥근 선 끝·이음으로 그렸다. 표시 문자, 문자 윤곽 경로, 로고, 출처·날짜, 배경 사각형, 액자, 필터, 외부 참조는 없다. 상품명은 비표시 `<title>`·접근성 이름과 카드 HTML에만 있다. PNG의 투명 여백 2.5%와 잉크 비율 20% 미만을 픽셀 테스트로 확인한다.

카드는 손그림·상품명·공식가·현재 공구가 또는 없음의 4요소를 유지한다. 기존에 제거된 할인율 배지를 다시 넣지 않았다. `.model-deal`은 `nowrap`, 모바일 가격은 `clamp(20px, 5vw, 28px)`, 데스크톱 가격은 28px이다. 등록 선화에는 모두 `model-art-line`을 적용하고 다크 모드에서 밝게 반전한다. 미등록 model-21 이후의 자리표시는 유지한다.

## 공식 참조와 모델별 표현

기존 [공식 근거 기록](model-evidence-2026-10-23.md)과 시드의 공식 URL에서 출발했다. 아래 제조사 페이지의 제품 이미지를 임시 확인했다. 국내 번들 3·4의 기존 404 주소를 가격 근거로 되살리지 않았으며, 공식 신생아 번들 사진의 베이비세트·트레이 구성품과 개별 액세서리 주소를 교차 확인 대상으로 삼았다.

| ID | 공식 참조 | 표현·차이 |
| --- | --- | --- |
| 1 | [Tripp Trapp 너도밤나무](https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/1001.html) | L자 양측판, 조절 홈, 두께가 있는 좌판·발판, 뒤 가로봉, 체결 나사. 베이비세트·트레이·글라이더 없음 |
| 2 | [Tripp Trapp 오크](https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/4952.html) | 같은 의자 구조에 등받이·좌판 나뭇결을 별도 `grain` 그룹으로 표현 |
| 3 | [공식 번들 구성품](https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/tripp-trapp-newborn-complete-sk.html), [베이비세트 개별 주소](https://www.stokke.com/KOR/ko-kr/액세서리/트립트랩-액세서리/6500.html) | 의자에 슬릿 등받이·곡선 안전레일·가랑이 지지대 결합. `baby-set` 아래 `backrest`, `rail`, `crotch-guard`, `glider`로 분리. 트레이 없음 |
| 4 | 위 번들·베이비세트, [트레이 개별 주소](https://www.stokke.com/KOR/ko-kr/액세서리/트립트랩-액세서리/4285.html) | 장착 트레이의 안팎 테두리·흘림 방지 턱·아랫면 리브·클립. 오른쪽에 분리 베이비세트와 트레이를 추가해 model-3과 구분 |
| 5 | [신생아&이유식 번들](https://www.stokke.com/KOR/ko-kr/하이체어/트립트랩/tripp-trapp-newborn-complete-sk.html) | 왼쪽 의자+오목한 크래들, 어깨패드, 버클·스트랩, 토이행어, 각도 조절·장착부. 오른쪽 베이비세트·트레이·5점식 하네스 세로 배열. 하네스에는 두 어깨끈·허리벨트·가랑이끈·중앙 버클·조절링을 그림 |
| 6 | [Xplory X](https://www.stokke.com/KOR/ko-kr/유모차/스토케-익스플로리/5715.html) | 높은 중앙 기둥과 시트, 조절 관절, 캐노피, 큰 뒷바퀴·작은 앞바퀴, 바스켓 |
| 7 | [YOYO3 프레임](https://www.stokke.com/KOR/ko-kr/last-chance/yoyo-strollers-last-chance/6773.html) | 푸시 핸들, 접이식 관절, 시트 장착 프레임 링, 휠 포크·바스켓. 패브릭 시트·캐노피·배시넷 없음 |
| 8 | [YOYO3 6+](https://www.stokke.com/KOR/ko-kr/유모차/스토케-요요-유모차/yoyo-stroller-sk.html) | 같은 섀시에 패딩 시트·발받침·패널 봉제, 캐노피 주름·테두리, 안전벨트·버클 장착 |
| 9 | [YOYO 배시넷 구성](https://www.stokke.com/KOR/ko-kr/last-chance/yoyo-strollers-last-chance/yoyo-bassinet-stroller.html) | 하드쉘의 이중 테두리·매트리스·하부 받침·운반 손잡이, 덮개 봉제, 캐노피, 프레임 결합 어댑터. 참조 사진의 배경 시트형 유모차는 추가하지 않음 |
| 10 | [Fox 5 Renew](https://www.bugaboo.com/kr-ko/스트롤러/bugaboo-fox-5-renew/부가부-폭스-5-리뉴-디럭스-스트롤러-PM007564.html) | 큰 뒷바퀴·작은 앞바퀴, 시트·캐노피·바스켓, 이중 관과 접이 관절. model-11 SVG를 복제하지 않고 별도 경로로 제작 |

개별 액세서리의 미국 지역 경로는 404였고, 한국 지역 주소는 요청 응답을 받았으나 웹 리더로 본문을 확보하지 못했다. 따라서 해당 주소의 국내 판매 구성·가격을 새로 확인했다고 주장하지 않는다. 구성품의 시각 참조는 열리는 공식 신생아 번들의 제품 사진을 사용했다.

사진 처리 제한: 참조 이미지에 서버 축소 옵션을 요청했으나 정적 CDN이 이를 무시해 큰 응답이 내려왔다. 해상도를 확인한 뒤 임시 사진과 HTML을 삭제했다. 사진은 저장소·완성 에셋에 포함하지 않았다. 서버 축소 썸네일만 받았다고 기록하지 않는다.

## 세트 구성품 경로 검증

수치는 서로 다른 경로 수 / C·Q 곡선을 포함한 경로 수다. 의자 슬롯과 레일의 짧은 접합선도 각각 한 경로로 집계되므로, 수치 자체가 구성품의 정교함이나 상품 형태의 정확성을 보증하지 않는다. 형태는 PNG·카드의 육안 검수와 함께 판단해야 한다.

| 모델 | 그룹별 경로 / 곡선 |
| --- | --- |
| 3 | `chair` 54/51, `baby-set` 49/49 (하위 글라이더 포함) |
| 4 | `chair` 52/49, `baby-set` 33/33, `tray` 22/20, `tray-detail` 22/20 |
| 5 | `chair` 54/51, `newborn-set` 34/34, `baby-set` 37/37, `tray` 22/20, `harness` 24/24 |
| 8 | `frame` 28/28, `seat` 20/20, `canopy` 21/21, `harness` 24/24 |
| 9 | `frame` 28/28, `bassinet` 21/21, `footmuff` 22/22, `canopy` 21/21 |

가려지는 의자 등받이와 유모차 시트·캐노피 뒤 프레임 경로를 제거해 겹침을 줄였다. 투명 배경을 유지하기 위해 흰색 덧칠이나 마스크를 쓰지 않았다. 단품에 세트 그룹이 없는지, model-3과 4·model-7과 8/9·model-10과 11의 경로 집합이 다른지도 테스트한다.

### 검수 반려 후 트레이 수정

model-4 장착·분리 트레이와 model-5 트레이의 타원형 윤곽을 모두 평평한 뒤쪽 변과 둥근 앞쪽 변이 있는 D자형 반원 식판으로 교체했다. 바깥 윤곽·안쪽 흘림 방지 턱·낮은 식판 면을 구분하고, 앞쪽 외벽 두께·하부 플랜지·두 잠금 클립을 그렸다. 기존의 짧은 테두리 눈금은 제거했다. model-4에서는 식판에 가려지는 앞쪽 안전레일·가랑이 지지대 상부·좌판 선을 제거해 식판 면 위에 레일 고리가 겹치지 않게 했다.

model-4의 분리 베이비세트 하위 ID를 `detail-backrest`, `detail-rail`, `detail-crotch-guard`로 변경했다. 모든 SVG의 ID 유일성, 그룹 조회 시 일치 항목 1개, 세 트레이의 직선 뒤쪽 변·앞쪽 곡면·안으로 들어간 테두리를 검사하는 회귀 테스트를 추가했다. model-6의 손잡이·베이스가 거칠다는 비차단 의견은 남아 있으며 이번 트레이 수정에는 포함하지 않았다. 사람의 상품 감수와 CrazyFrontendManBOT 재검수는 여전히 필요하다.

## 로컬 검증과 시각 검수

```sh
npx tsx scripts/render-model-illustrations.ts
npm test -- tests/model-illustrations.test.ts tests/model-cards.test.ts tests/models-page.test.ts
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
npx tsx scripts/card-screenshots.ts --out .local/card-qa
git diff --check
```

초기 제작 시 관련 테스트 3개 파일·19개, 전체 테스트 61개 파일·900개, lint·타입 검사·Next.js 빌드·OpenNext Worker 빌드가 통과했다. 검수 반려 후 수정에서는 관련 테스트 3개 파일·21개와 스크린샷 검사를 다시 실행해 통과했다.

이번 수정의 최종 검증: lint·타입 검사, 전체 61개 파일·902개 테스트, `npm run build:worker`(내부 `npm run build` 포함), `git diff --check` 통과. `.local/card-qa/`의 전체 화면 4장과 카드 크롭 40장을 갱신하고 model-4·5의 라이트·다크 카드에서 D자형 식판과 분리 부품을 확인했다.

`.local/card-qa/`에 `mobile-light.png`, `mobile-dark.png`, `desktop-light.png`, `desktop-dark.png`와 model-1–10 카드 크롭 40장을 생성했다. 오프라인으로 실제 `ModelCard`·CSS·PNG를 렌더링하며 모든 네트워크 요청은 차단한다. 390px·1280px × 라이트·다크 모두 다음 검사가 통과했다.

- 모든 `.model-deal`의 높이 `0 < height <= 40px`, 같은 행의 카드 높이 차이 1px 이하.
- 이미지 20개의 디코딩·정사각 원본, 미등록 model-21 자리표시 1개, model-1–20 자리표시 0개.
- 가로 넘침 0, 라이트·다크 배경 구별.

스크린샷용 공구가 390,000·780,000·1,990,000원과 model-3의 가격 미확인은 레이아웃 픽스처다. 시드·DB에 기록하지 않는다. 7자리 가격도 모바일에서 한 줄이다.

에이전트가 전체 화면 4장과 크롭 40장을 직접 확인했다. 표시 글자·출처·날짜·배경판·이중 액자·점선·잘림·깨진 이미지는 발견하지 않았다. model-3의 가드 장착, model-4의 장착/분리 트레이, model-5의 크래들+별도 세 부품, model-7 프레임과 model-8 시트형·model-9 배시넷형의 차이를 확인했다. 다크 모드에서도 윤곽은 식별된다. 390px 카드에서는 미세한 봉제·조절링이 작아지므로 원본 SVG·540px PNG와 함께 검수했다. 이는 에이전트 검수이며 사람의 최종 상품 감수나 CrazyFrontendManBOT 재승인을 대신하지 않는다.

커밋·push·PR·배포·큐 파일 수정은 수행하지 않았다.
