# 아가마중 Instagram 수집 worker v2

Cloudflare가 아닌 **별도 Linux 머신**에서 Node.js 22 이상 + Playwright로 실행합니다. 이 문서의 검증은 단위 테스트(추출·API)로만 수행했으며 **실제 Instagram 접속·로그인·수집은 실행하지 않았습니다**. 본인 계정으로 접근이 허용되고 수집 동의를 받은 콘텐츠에만 사용하세요. 비공개 접근 우회·CAPTCHA 우회·자동 2FA 처리는 없습니다.

v2 변경점: 검수 가능한 시드 계정 설정 파일, 사람 속도 자동 팔로우(일일 상한·지터), 알림·스토리 트레이 기반 준실시간 폴링(신호 있는 계정 우선), 스토리 OCR 기본 켜짐, 캡션·OCR 텍스트에서 모델·가격·공구 일정·링크를 뽑아 검수 대기열에 '제안'으로 함께 전송, 공구 셀러·팔이피플 해시태그 발견(후보 기록만), 다중 후보 셀렉터, JSONL 상태 로그, systemd/pm2 실행 파일.

## 준비

저장소 루트에서 `npm ci`, `npx playwright install chromium`을 실행합니다. Linux 시스템 라이브러리가 필요하면 운영자가 Playwright 공식 설치 안내에 따라 설치합니다. 스토리 OCR은 **기본 켜짐**이므로 tesseract와 kor/eng 언어팩을 준비하세요(`tesseract --list-langs`로 확인). 끄려면 `AGAMAJUNG_OCR=0`.

환경변수는 `.env.example`을 참고해 별도 비밀 저장소 또는 쉘의 안전한 주입 기능으로 설정합니다. 비밀번호를 명령행 인수·로그·문서·git에 넣지 마세요. 루트 `.env.crawler`를 쓴다면 `node --env-file=.env.crawler`로 로드하고 이 파일은 gitignore 대상입니다.

| 변수 | 설명 |
| --- | --- |
| `AGAMAJUNG_IG_USER` | 로그인 아이디(기본값은 v1과 동일) |
| `AGAMAJUNG_IG_PASSWORD` | 로그인 비밀번호. 환경변수로만 사용 |
| `AGAMAJUNG_API_URL` | 아가마중 서버 origin. 로컬 외에는 HTTPS 필수 |
| `INGEST_TOKEN` | 수집 전용 토큰. ADMIN_TOKEN과 분리 |
| `AGAMAJUNG_OCR` | 기본 켜짐. `0`이면 스토리 수집 생략 |
| `AGAMAJUNG_OCR_LANG` | 기본 `kor+eng` |
| `AGAMAJUNG_HEADLESS=0` | 최초 수동 확인용 브라우저 표시 |
| `AGAMAJUNG_ONCE=1` | 한 틱만 실행하고 종료 |

## 설정 파일(config/, git에 함께 관리)

- **`config/accounts.json`** — 시드 계정 목록. Stokke·BabyBjorn·Bugaboo·Cybex·Nuna·Joie·egg·D.THRONE의 글로벌/한국 계정 후보를 싣는다. **`verified: false`는 핸들 실재 여부를 확인하지 못했다는 뜻**이다. 기본 설정에서는 verified 계정만 정기 방문·자동 팔로우 대상이 된다. 운영자가 Instagram에서 직접 핸들을 확인한 뒤 `verified`를 바꿔 활성화한다. 해시태그 목록(#공구 #육아공구 #트립트랩공구 + 브랜드 태그)도 여기서 관리한다.
- **`config/settings.json`** — 속도·한도. 폴링 간격(기본 3~7분 무작위), 틱당 계정 수, 시간당 행동 상한(프로필 방문 30·게시물 40·스토리 20·팔로우 8·해시태그 페이지 2), 팔로우 일일 상한(기본 20), 팔로우 최소 간격(120~420초), 지연 범위, OCR 설정, 재확인 주기. 값을 올리기 전 행동 제한 위험을 다시 검토한다.

## 실행

```sh
node --env-file=.env.crawler --import tsx crawler/index.ts   # 직접 실행(AGAMAJUNG_ONCE=1 권장)
pm2 start crawler/ecosystem.config.cjs                      # pm2(비밀은 --update-env로 주입)
sudo systemctl enable --now agamajung-crawler               # systemd(단위 파일 주석의 설치 절차 참조)
```

systemd 단위(`crawler/agamajung-crawler.service`)는 전용 사용자·`UMask=0077`·쓰기 경로 제한을 포함하고, 챌린지·차단으로 종료코드 75가 나오면 10분 간격 최대 3회만 재시작한다. 차단 원인은 사람이 확인한 뒤 재개한다.

## 동작

1. **준실시간 폴링** — 매 틱(3~7분 무작위)마다 홈 스토리 트레이와 알림(활동) 화면을 확인해 "방금 올라온" 신호를 만든다. 새 게시물·스토리 링·활동 신호가 있는 계정을 먼저 방문하고, 나머지는 가장 오래 확인한 계정 순으로 최대 `per_tick.max_accounts`(기본 5)개만 본다. 고정 3계정 순환이 아니다. 모든 방문·게시물 열람·스토리 오픈은 settings.json의 전역 시간당 상한 안에서만 일어난다.
2. **수집** — 프로필 그리드에서 이전에 본 게시물과 다른 URL만 열어 캡션을 읽고, 스토리 링이 있는 계정만 스토리를 열어 OCR(kor+eng) 텍스트를 얻는다. 원문과 함께 추출 제안을 `POST /api/v1/ingest`로 보낸다. 중복은 정규화 URL + 로컬 이력(`.cache/state.json`)으로 막는다.
3. **자동 추출 제안** — `crawler/lib/extract.ts`(순수 함수, `tests/extract.test.ts`로 검증)가 모델(시드 모델 목록 대조), 가격(`390,000원`·`39만원`·`39.9만`·`62만 8천원`·범위/할인 화살표), 공구 일정(`10/26`·`11월 2일`·`~` 범위·`부터/까지/오픈/마감` 힌트·오전/오후 시각, KST ISO 변환, 연말 연도 넘김), 링크(URL·프로필 링크 안내)를 뽑아 신뢰도와 함께 붙인다. **제안은 `/admin` 검수 화면에 힌트로만 표시되며 사람이 승인하기 전까지 게시되지 않는다.**
4. **자동 팔로우** — accounts.json에서 `follow: true`이고 아직 팔로우하지 않은 verified 계정을 한 틱에 최대 1개, 일 20개·시간 8개 상한, 120~420초 무작위 간격으로 팔로우한다. 팔로우 버튼이 보이지 않으면 건너뛰고 기록한다.
5. **공구 셀러·팔이피플 발견** — 최소 6시간 간격으로 해시태그 태그 페이지를 시간당 2개까지만 훑고, 공구 키워드나 시드 모델이 보이는 게시물의 계정을 **후보로만 기록**한다(`.cache/state.json`의 `candidates`). 발견 계정을 절대 자동 팔로우하지 않는다. 운영자가 후보와 원문을 검수한 뒤 accounts.json에 옮겨 적으면 다음 실행부터 팔로우 후보가 된다.

## 중단 조건

챌린지/체크포인트 화면, 로그인 이탈, "Action Blocked/일시적 제한" 안내, 수집 API 실패가 감지되면 즉시 중단하고 종료코드 75(또는 1)로 빠진다. **프로세스 안에서 자동 재시도하지 않는다.** 최초 2FA·보안 확인은 운영자가 직접 브라우저에서 처리한 뒤 다시 실행한다(`AGAMAJUNG_HEADLESS=0` 활용). 개별 계정 수집 중의 셀렉터 미스·렌더 오류는 그 계정만 건너뛰고 계속 진행하며 `selector_miss`/`error`로 상태 로그에 남는다.

Instagram UI·언어·A/B 테스트에 따라 화면 구조는 바뀐다. 셀렉터는 aria role·버튼/링크 이름(한국어+영어) 정규식 우선, CSS 폴백 다중 후보(`crawler/lib/selectors.ts`)로 구성했지만, 신호가 비면 `crawler/logs/`의 `selector_miss` 이벤트로 위치를 찾아 수동 점검해야 한다. **실서비스 동작 검증은 아직 없다.**

## 상태·로그·보안

- `crawler/logs/health-YYYY-MM-DD.jsonl` — 사건 단위 상태 로그(폴링, 전송, 팔로우, 후보 발견, 셀렉터 미스, 차단). 스칼라 값만 기록하고 **비밀번호·토큰·수집 원문은 절대 남기지 않는다**. gitignore 대상.
- `crawler/.cache/state.json` — 중복 URL 이력(최근 1만), 계정별 팔로잉·마지막 확인 시점, 시간대별 행동 카운터(이틀 후 자동 정리), 발견 후보 목록. 0600.
- `crawler/.session/state.json` — 쿠키/인증 포함. 폴더 0700·파일 0600. gitignore. 외부 공유·커밋 금지. OCR 스크린샷은 즉시 삭제한다.
- 전용 OS 사용자로 실행하고, 운영 보존 정책에 맞춰 로그·캐시를 정리한다. Playwright tracing·HAR·화면 녹화는 사용하지 않는다.

## 검증

```sh
npm run lint && npm run typecheck && npm test   # tests/extract.test.ts 가 추출 로직을 검증
```

Instagram 접속 없이 검증한다. 새 캡션 형태를 지원할 때는 `tests/extract.test.ts`에 실제 문구에 가까운 사례를 먼저 추가한다.
