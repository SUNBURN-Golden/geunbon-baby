# 아가마중 Linux 수집 시스템

공용 엔진의 `collect`·재개·비용·실패 큐는 [엔진 운영](../docs/collector/engine.md), 아가마중 프로필과 기존 DB 보존 이행은 [프로필·이행](../docs/collector/agamajung-profile.md)을 참고하세요.

사이트와 분리된 Linux 시스템의 운영 안내입니다. 저장소 루트의 [시스템 구성과 경계](../README.md#시스템-구성과-경계), [가격 원칙](../README.md#가격-원칙), [운영 일정](../README.md#운영-일정)을 현재 공통 기준으로 사용합니다. 화면 브랜드는 **아가마중**, 워드마크는 **AGAMAJUNG**, 도메인은 **agamajoong**, 코드·기본 Instagram 사용자명은 **agamajung**입니다.

- A. Instagram 수집 worker → [설치와 환경변수](#설치와-환경변수), [설정과 주기](#설정과-주기), [수집·팔로우·발견](#수집팔로우발견), [셀렉터 폴백과 진단](#셀렉터-폴백과-진단), [외부 공구 모음 이관](#외부-공구-모음-이관), [상태·건강 로그](#상태건강-로그), [운영](#운영), [검증](#검증), [상품 이미지 URL 계약](#상품-이미지-url-계약).
- B. 독립 로컬 수집함 → [독립 로컬 수집함](#독립-로컬-수집함), [수집 건강 요약](#수집-건강-요약), [외부 출처 활성화 절차](#외부-출처-활성화-절차), [어댑터와 수집 제한](#어댑터와-수집-제한).
- B-3. 건수 전송 전용 프로세스 → [건수 동기화](#건수-동기화). 과거 작업 기록은 [구현 기록 (참고용)](#구현-기록-참고용).

Instagram worker는 **Node.js 22 이상 + Playwright**로 본인 계정에서 접근이 허용된 콘텐츠를 수집해 `/api/v1/ingest`의 pending 검수 대기열로 보냅니다. 게시에는 관리자 승인이 필요합니다. 독립 수집함은 자체 SQLite에 저장하고, sync만 건수 스냅샷을 사이트에 보냅니다. **가격을 절대 만들어 내지 않습니다 (never invent prices).** 수집한 단서를 공식가나 공구가로 자동 승격하지 않습니다. Workers Cron은 로그 stub이며 Playwright/OCR을 실행하지 않습니다. 사이트는 로컬 레코드·근거를 가져오지 않습니다. `tools/dev-daemon`·PM2 `agamajung-dev-daemon`은 별도 개발 도구입니다.

## 설치와 환경변수

저장소 루트에서 `npm ci`를 실행합니다. Playwright는 `1.64.1`로 고정되어 있으며 Chromium headless shell revision `1248`을 사용합니다. 같은 사용자·브라우저 캐시에 해당 revision이 이미 있으면 다운로드가 필요 없습니다. 없으면 `npx playwright install chromium --only-shell`로 headless 실행에 필요한 항목만 설치해 디스크 사용을 줄입니다. `AGAMAJUNG_HEADLESS=0`으로 실행할 때는 전체 Chromium이 필요하므로 `npx playwright install chromium`을 사용합니다. Playwright 버전을 바꿀 때는 필요한 브라우저 revision도 함께 확인하세요.

OCR은 **기본 켜짐**이므로 tesseract와 한국어·영어 언어팩을 설치하고 `tesseract --list-langs`로 확인하세요. OCR을 끄려면 `AGAMAJUNG_OCR=0`을 설정합니다.

`crawler/.env.crawler.example`을 참고해(`cp crawler/.env.crawler.example .env.crawler`) 비밀 저장소나 gitignore 대상인 루트 `.env.crawler`로 환경변수를 주입합니다. 복사 명령은 저장소 루트에서 실행합니다. 크롤러는 시작 시 루트 `.env.crawler`가 있으면 읽고, 이미 주입된 환경변수는 유지합니다. 파일이 없으면 주입된 환경변수만 사용합니다. 비밀번호는 **`AGAMAJUNG_IG_PASSWORD` 환경변수에서만** 읽습니다. 명령행 인수·로그·git에 넣지 마세요.

| 변수 | 설명 |
| --- | --- |
| `AGAMAJUNG_IG_USER` | 로그인 사용자명. 기본값 `agamajung`. 이메일 대신 핸들을 사용하세요. 이메일이면 스토리 신호에서 본인 제외와 프로필 링크의 핸들 폴백이 동작하지 않습니다. |
| `AGAMAJUNG_IG_PASSWORD` | 로그인 비밀번호. 저장된 세션이 유효하면 생략 가능 |
| `AGAMAJUNG_API_URL` | API origin. localhost 외에는 HTTPS 필수 |
| `INGEST_TOKEN` | 수집 전용 Bearer 토큰. ADMIN_TOKEN과 분리 |
| `AGAMAJUNG_OCR` | 기본 켜짐. `0`이면 스토리 OCR·수집 생략, `1`이면 켜짐 |
| `AGAMAJUNG_OCR_LANG` | 기본 `kor+eng` |
| `AGAMAJUNG_HEADLESS=0` | 브라우저 표시. 최초 로그인·보안 확인용 |
| `AGAMAJUNG_ONCE=1` | 한 사이클 후 종료. 휴식 시간에 시작하면 종료 시각 + 지터까지 대기 후 실행 |
| `AGAMAJUNG_QUIET_WINDOWS` | 쉼표로 구분한 `HH:mm-HH:mm` 목록으로 휴식 시간 전체 덮어쓰기. 기본 `06:45-08:00,13:00-14:00`, 항상 `Asia/Seoul`. 예: `23:00-02:00,13:00-14:00` |
| `AGAMAJUNG_QUIET_WINDOW` | 이전 단일 휴식 시간 덮어쓰기 호환용. `AGAMAJUNG_QUIET_WINDOWS`가 있으면 복수형 변수를 우선 적용 |

```sh
node --env-file=.env.crawler --import tsx crawler/index.ts
```

`crawler/.session/state.json`에 Playwright storageState(쿠키와 origin별 로컬 저장소)를 함께 저장하고, 새 브라우저 컨텍스트의 첫 페이지를 만들기 전에 복원합니다. 유효한 저장 세션은 비밀번호 없이 재사용할 수 있습니다. 쿠키를 별도 파일로 중복 저장하거나 주입하지 않습니다.

로그인 제출은 시작당 최대 한 번입니다. 설정된 무작위 지연을 유지하면서 제출 후 최대 120초 동안 로그인 입력란이 사라지고, 유효한 Instagram 인증 쿠키와 로그인한 사용자용 탐색 메뉴가 모두 나타나기를 기다립니다. 한국어·영어의 로그인 정보 저장/알림 설정 안내가 보이면 해당 안내의 `나중에 하기`/`Not now` 버튼만 한 번씩 누르고 사라질 때까지 기다립니다. 홈 재방문과 인증 유지 확인에는 별도의 최대 120초를 부여하며, 같은 컨텍스트에서 확인한 뒤 세션 저장을 완료해야 `login_ok`/`session_reused`를 기록하고 수집을 시작합니다. 로그인 URL 밖에 있어도 로그인 입력란이 다시 나타나면 수집을 중단합니다.

로그인 상태는 `entry`(초기 진입), `submitted`(제출 후), `home`(인증 후 홈 재방문) 단계마다 최대 120초 안에서 1초 간격으로 확인합니다. 보이는 본문·입력/버튼/링크·인증 탐색 메뉴가 없고 보안확인·로그인 폼·안내 신호도 없는 실제 빈 화면만 `blank-loading`으로 분류합니다. DOM 읽기 실패와 미인식 안내는 `unknown`으로 남기며 복구 탐색하지 않습니다. 빈 상태가 연속 30초면 같은 컨텍스트에서 Instagram 홈으로 GET 탐색을 **단계당 최대 1회** 수행합니다. 이 복구로 시간 제한을 늘리거나 로그인 제출을 반복하지 않습니다. 저장 직전에 일시적으로 빈 화면이 되면 임시 세션을 버리고 같은 단계의 남은 시간 안에서 인증 확인·storageState 캡처를 다시 수행합니다. 휴식·종료 요청은 대기와 복구를 중단합니다.

`/auth_platform/codeentry/`와 한국어·영어 이메일 코드 안내 + 코드 입력 컨트롤 조합은 **challenge**입니다. 탐색 직후·대기 중·안내 닫기/복구 탐색/세션 저장 전에도 우선 검사합니다. 감지하면 즉시 중단하며 코드 입력·재전송·계속 버튼 클릭·복구 탐색을 수행하지 않습니다. 단순히 “코드”라는 단어가 있다는 이유로 보안확인으로 분류하지 않습니다.

빈 화면 복구 GET 뒤에도 설정된 `delays_ms.navigation`만큼 기다린 후 로그인 입력·인증 판정을 진행합니다. 대기는 해당 단계의 남은 제한 시간 안에서만 적용하며, 그동안에도 1초 간격으로 보안확인·휴식·종료 요청을 감시합니다.

세션 디렉터리는 0700, 파일은 0600이며 gitignore 대상입니다. 고유한 임시 파일을 쓴 뒤 rename으로 원자적으로 교체하며, 정상 완료한 사이클 뒤에도 갱신된 쿠키를 저장합니다. 로그인 실패·챌린지·휴식/종료 요청으로 중단한 사이클·무조건적인 종료 정리에서는 세션을 덮어쓰지 않습니다. 파일이 없는 경우만 최초 실행으로 취급하며, 손상·읽기·쓰기 실패는 원문/쿠키/브라우저 오류의 비밀값을 출력하지 않는 운영 오류로 중단합니다. 세션 오류가 휴식 시작과 겹쳐도 해당 실패를 유지하고 자동 재시도하지 않습니다. 챌린지·체크포인트·2FA·CAPTCHA·행동 차단은 즉시 중단하고 기존 진단과 종료코드 75를 유지합니다. 사람이 처리해야 하며 자동 우회하거나 재시도하지 않습니다.

## 설정과 주기

불리언은 문자열이 아닌 JSON `true`/`false`만 허용하며, 계정 객체의 알 수 없는 키는 거부합니다. 선택 필드는 키를 생략한 경우에만 `collect_images`는 true, `follow.allow_unverified`는 false, `brand`/`note`는 빈 문자열, `ocr.langs`는 `kor+eng`을 적용합니다(`null`은 오류). 계정의 `handle`·`scope`·`verified`·`follow`와 설정의 `discovery.enabled`·`ocr.enabled`는 필수입니다. `export-account` 조각을 붙여 넣을 때는 `scope`(`global` 또는 `kr`)를 추가하세요. `AGAMAJUNG_OCR`은 미설정·빈 값이면 파일 값을 유지하고 `0`·`1` 외의 값은 거부합니다.

- `config/accounts.json`: Stokke, BabyBjorn, Bugaboo, Nuna, Joie, Cybex, egg, D.THRONE 시드와 `#공구`, `#육아템공구`, `#스토케공구`, `#팔이피플` 등의 발견 태그. 기존 설정의 `verified: true` 계정만 기본 방문·팔로우 대상입니다. 미확인 한국 계정은 운영자가 핸들을 확인한 뒤 활성화합니다. 공구 셀러 계정(`brand`가 빈 문자열)은 `collect_images: false`로 등록해 아이 얼굴이 담길 수 있는 이미지 URL을 보내지 않습니다. `collect_images`를 생략하면 기본값은 true이며, 시드에 없이 손으로 팔로우한 셀러도 이미지가 수집되므로 시드에 등록해야 합니다. 핸들은 대소문자를 구분하지 않고 중복이면 실행 전에 오류로 거부합니다.
- `config/settings.json`: 속도·한도·OCR·재확인 주기·공유 계정 휴식 시간을 관리합니다. 상한은 0으로 설정해 해당 행동을 끌 수 있습니다. 지연 범위는 양수이며 최솟값 ≤ 최댓값이어야 합니다.
- `quiet_windows`: 휴식 시간 객체의 배열입니다. 공유 계정을 쓰는 다른 두 봇을 위해 매일 **06:45 포함 ~ 08:00 제외, 13:00 포함 ~ 14:00 제외(KST)** 동안 브라우저 실행·로그인·팔로우·모든 스캔을 멈춥니다. 각 객체는 `{ "start": "06:45", "end": "08:00", "timezone": "Asia/Seoul", "jitter_ms": [1000, 30000] }` 형식이며 두 기본 시간 모두 지터는 1~30초입니다. 키가 없으면 이전 `quiet_window` 객체를 하나짜리 배열로 읽고, 두 키 모두 없으면 위 두 시간을 적용합니다. 두 키가 함께 있으면 `quiet_windows`가 우선하며, 빈 배열 `[]`은 휴식을 끕니다.
- 겹치거나 맞닿은 시간은 자정 경계를 포함해 하나로 합칩니다. 합친 시간의 마지막 종료까지 기다린 뒤, 구성 시간들의 지터 최솟값 중 가장 큰 값과 최댓값 중 가장 큰 값 사이에서 한 번만 지터를 뽑아 더합니다. 합친 시간이 하루 전체를 덮으면 재개하지 않고 종료 요청을 기다립니다. 실행 중에는 **다음 합친 시간의 시작**에 타이머로 브라우저를 닫고, 각 페이지/셀렉터 호출 직전에도 시각을 확인합니다. 휴식 후 새 브라우저에서 로그인하고 사이클을 다시 시작하며, 중단된 사이클은 `AGAMAJUNG_ONCE=1`에서도 완료된 사이클로 세지 않습니다.
- `start`/`end`는 24시간제 `HH:mm`이며 `23:00-02:00`처럼 자정을 넘길 수 있습니다. 같은 시작·종료 시각, 잘못된 시각/지터/시간대, 잘못된 배열·환경변수 목록(빈 항목 포함)은 실행 전에 오류로 거부합니다. 시간대는 서버의 로컬 시간과 관계없이 `Asia/Seoul`로 고정합니다. 지터는 0 이상의 정수 밀리초 `[최소, 최대]`입니다. 환경변수는 시간 목록 전체를 교체하고 시작·종료만 덮어씁니다. 지터는 설정 배열의 같은 순번에서 가져오며, 추가 항목은 첫 항목의 지터를 사용합니다(빈 설정 배열이면 기본 지터). 이전 `AGAMAJUNG_QUIET_WINDOW`만 있으면 단일 시간으로 교체합니다.
- pm2 운영에서는 **매일 09:30과 20:30 Asia/Seoul에 한 사이클만** 실행한 뒤 브라우저를 닫고 종료합니다. 직접 연속 모드로 실행할 때 알림·홈 스토리 트레이는 기본 **1~2분 지터 주기**로 확인합니다. 사이클 시작 시각을 기준으로 다음 확인을 예약하며, 작업 시간이 길면 완료 즉시 다음 사이클로 넘어갑니다. 실제 간격에는 탐색·OCR 시간이 포함됩니다.
- 로그인한 계정의 프로필 링크에서 **기존 팔로잉 목록을 동기화**해 시드에 없는 계정도 폴링합니다. 첫 시도 후 최소 24시간 간격이며 실패·재시작에도 시도 시각을 유지합니다. 프로필 방문 상한과 휴식 시간(재개 지터 포함)을 지키며, 목록은 행동 지연을 두고 최대 50개 배치까지 스크롤합니다. 각 배치를 바로 저장하고, 부분 목록이나 중단 때문에 기존 팔로잉 기록을 지우지는 않습니다. `following_sync` 로그에 읽은 계정 수와 배치 상한 도달 여부를 남깁니다.
- 전체 프로필·게시물 스캔은 계정별 기본 **90분** 간격입니다. 같은 알림·스토리 신호가 계속 보여도 프로필을 매번 재스캔하지 않습니다. 스토리는 별도로 기본 **30분** 간격, 신호가 있는 계정을 직접 열어 확인합니다. 신호 없는 계정은 가장 오래 확인하지 않은 순서로 처리합니다.
- 사이클당 기본 최대 20계정·게시물 2개·스토리 5개를 처리합니다. 시간당 상한은 프로필 방문 30·게시물 40·스토리 20·팔로우 8·태그 페이지 2입니다. 알림·트레이 탐색은 이 프로필 상한과 별도입니다.

## 수집·팔로우·발견

1. 캡션과 스토리 이미지·영상 프레임 OCR에서 시드 모델/브랜드, 원화 가격, KST 공구 기간, URL·프로필 링크 안내를 추출합니다. 원문과 `suggestions`를 Bearer 인증 POST로 전송합니다. `collect_images: false` 계정은 개인정보를 마스킹한 텍스트와 그 텍스트에서 추출한 `suggestions`만 전송하고 이미지 URL은 보내지 않습니다. 추정값은 `/admin`에서만 표시하며 승인 전에 공개하지 않습니다. tesseract 실패·빈 캡션은 전송 완료로 기록하지 않습니다. 스토리는 처음 열 때와 다음 스토리로 이동할 때마다 미디어 준비를 기다려 즉시 일시 정지한 뒤 행동 지연과 OCR을 수행합니다. 이미 일시 정지된 스토리는 재생하지 않으며, 정지 컨트롤이 없으면 캡처를 건너뜁니다.
2. 게시물 URL은 추적 쿼리를 제거하고 정규화해 중복을 막습니다. 사이클 상한 때문에 처리하지 못한 게시물은 다음 스캔에서 다시 대상이 됩니다. URL은 리디렉트 없는 `202 application/json {data:{id,status}}` 응답에서 유효한 문자열 id와 해당 kind의 status를 확인한 뒤에만 전송 완료로 기록합니다. 잘못된 receipt·리디렉트·응답 유실은 사이클을 중단하고 다음 실행에서 재시도합니다. API도 URL별 중복을 막으므로 응답 유실 후 재전송해도 큐 항목이 늘지 않습니다.
3. 자동 팔로우는 설정의 `follow: true` 계정 중 기본 verified 계정만 한 사이클에 최대 1개 처리합니다. 기본 **일 20회·시간 8회**, **120~420초 무작위 최소 간격**입니다. 요청 전에 시도 횟수와 다음 허용 시각을 저장하므로 실패·재시작으로 한도가 초기화되지 않습니다. 요청됨(Requested)도 팔로우 상태로 취급하며, 버튼 미발견 계정은 90분 뒤 다시 확인합니다. `allow_unverified`로 미확인 시드의 팔로우를 명시적으로 허용할 수 있습니다.
4. 발견 탐색은 기본 최소 6시간 간격으로 태그 1개·게시물 최대 2개를 확인합니다. 태그 커서를 저장해 재시작 후에도 전체 목록을 순환합니다. 공구 문구나 모델이 있는 작성자를 `candidates`에 기록합니다. 발견 이력과 전송 이력은 별도여서 발견한 게시물도 이후 수집할 수 있습니다. 후보는 자동 팔로우하지 않으며, 운영자가 검수 후 accounts.json에 등록합니다.

## 셀렉터 폴백과 진단

- 게시물 링크는 `/p/CODE/`, `/reel/CODE/` 및 `/handle/p/CODE/`, `/handle/reel/CODE/`를 같은 원문 URL로 정규화합니다. 예약 경로·잘못된 핸들은 제외합니다. 실제 URL 형태와 `anchors` 진단을 함께 확인하세요.
- 캡션은 `article h1` → JSON-LD의 `articleBody`/`caption` → `article` 본문 → `main` 본문 → `meta[name="description"]`/`og:description` 순서로 최대 6,000자를 읽습니다. 잘릴 수 있는 meta는 마지막 대안입니다. JSON-LD 객체·배열·`@graph`를 지원하며 잘못된 JSON은 무시합니다.
- 작성자는 기존 DOM 링크 세 후보 → JSON-LD `author.url`(검증된 Instagram 프로필), `author.alternateName`(선행 `@` 제거), `author.identifier.value` → description의 `- handle on ` 순서입니다. identifier는 `propertyID`가 `username` 또는 `handle`인 경우만 사용해 내부 `User ID` 오인을 막습니다. 모든 결과를 프로필 핸들로 검증합니다.
- 스토리 트레이는 기존 `/stories/` 링크를 먼저 읽습니다. 유효한 링크가 하나라도 있으면 alt·aria-label 대안을 읽지 않습니다. 링크가 없으면 `main`의 버튼/목록 이미지 alt → 버튼 aria-label에서 한국어·영어 프로필 사진 이름을 읽으며, `article` 안의 피드 아바타는 제외합니다. 컨테이너 후보에서도 `article` 내부를 제외하고 이미지 alt가 3개 이상인 첫 `main ul`로 제한하며, 없으면 `main` 전체를 사용합니다. 로그인 핸들은 제외하고 중복 없이 최대 30개를 반환합니다.
- 로그인 프로필 링크는 접근성 이름 → 프로필 SVG가 있는 앵커 → 로그인 핸들과 일치하는 href → 로그인 핸들의 프로필 사진이 있는 nav 앵커 순서입니다. 모두 실패해도 로그인 식별자가 유효한 핸들이면 그 프로필로 진행하고 `following_profile_fallback`(`via: username`)을 기록합니다. 이메일이면 이 핸들 기반 대안과 본인 스토리 제외를 생략하므로 `AGAMAJUNG_IG_USER`에는 핸들을 권장합니다.
- 새 셀렉터 폴백은 속성·본문만 읽으며 클릭·탐색·입력을 하지 않습니다. 기존 탐색 뒤 보안확인 검사와 즉시 중단 정책은 유지합니다.
- `selector_miss`는 발견 캡션/작성자 누락을 각각 `discovery_caption`/`discovery_author`로 기록합니다(둘 다 없으면 두 이벤트). `profile_posts`/`discovery_posts`에는 조회한 앵커 수 `anchors`가 붙습니다. `anchors > 0`이면 CSS가 앵커를 찾았으므로 URL 형태를, `0`이면 CSS 자체를 점검합니다. 정규화 가설의 확인에는 이후 실제 수집 결과도 함께 확인해야 합니다.
- 전송 성공 이벤트 `post_sent`/`story_seen`은 가격 제안 존재 여부인 `price_found` boolean만 추가합니다. 캡션·가격 값은 건강 로그에 남기지 않습니다. 다음 예약 실행에서 `queue.size`와 `account_visit`, `post_sent.price_found` 및 남은 미스 스코프를 확인하세요. 기본 설정의 verified 계정이 사이클 큐 대상입니다. 실제 방문 수는 시간당 한도·휴식·보안 중단의 영향을 받습니다.

## 외부 공구 모음 이관

공개 외부 수집은 아래 독립 로컬 작업기로 이관했습니다. Instagram 프로세스는 외부 수집을 실행하지 않습니다. 구형 `AGAMAJUNG_EXTERNAL_DRY_RUN=1`은 주입 환경변수·`.env.crawler` 모두 이관 안내 후 설정/인증/Instagram 접근 전에 종료하며, `0`·`1`·빈 값 외에는 시작 전 종료코드 1로 거부합니다. 기존 `config/external-sources.json`은 구형 파서의 호환 자료이며 실행 설정은 `config/collector.json`입니다. 검토 전 사이트는 disabled로 출하합니다. 사이트의 legacy `POST /api/v1/ingest` + `kind: "external_listing"`은 INGEST_TOKEN으로 **현재도 쓰기 가능**합니다. `lib/api.ts`는 새 `external_candidates` 후보를 삽입하거나 정규화 URL이 같은 `candidate` 행의 제목·본문·판매자 단서·가격·일정·최근 확인 시각을 갱신합니다. `dismissed` 행은 바꾸지 않으며 둘 다 202와 id/status를 반환합니다. `crawler/lib/ingest.ts`는 이 전송과 candidate/dismissed 응답을 계속 지원하지만 현재 Instagram 실행부·신규 로컬 수집함은 이 경로로 외부 후보를 보내지 않습니다. 관리자는 GET `/api/v1/admin/candidates`와 POST `/api/v1/admin/candidates/:id`의 `{ "action": "dismiss" }`만 사용할 수 있습니다. 후보를 공구로 승격하는 경로는 없고 **price_hint/price_raw는 공구가나 공식가로 표시되지 않습니다.** 공개 API/화면은 후보 테이블을 읽지 않으며 신규 로컬 건수에도 합산하지 않습니다.

## 상태·건강 로그

- `crawler/.cache/state.json`: KST 날짜·시간별 행동 카운터, 다음 팔로우 허용 시각, 팔로잉 목록 동기화 시도 시각·계정, 계정 확인 시각, 전송/발견 URL 이력(각 최근 1만 개), 후보와 태그 커서. 임시 파일을 rename해 원자적으로 저장하며 0600입니다. 파일이 손상되면 한도를 초기화하는 대신 실행을 중단합니다. 이틀 전 카운터는 정리합니다.
- `crawler/logs/health-YYYY-MM-DD.jsonl`: UTC 일자별 순서 있는 이벤트 기록. 비밀번호·토큰·쿠키·수집 원문은 기록하지 않습니다. 단, `halt` 이벤트에는 비밀값을 가린 화면 텍스트 앞 200자(`preview`), 중단 이유(`reason`), URL 경로(`path`)를 남깁니다.
- 환경변수·설정·상태 파일 검증 전에 건강 로그를 초기화합니다. 종료 오류에는 비밀값을 가린 예외 종류·메시지·코드·스택(`error_name`, `error_message`, `error_code`, `error_stack`)을 기록하며, 로그 초기화/디스크 실패 때도 stderr에 같은 진단을 남깁니다. URL 쿼리·이메일·인증 정보는 가립니다.
- 상태가 바뀔 때만 `login_state`, 빈 화면 복구 직전에는 `login_recovery`를 기록합니다. 필드는 단계(`phase`), 상태(`state`: `challenge`/`blocked`/`login-form`/`known-prompt`/`authenticated`/`blank-loading`/`unknown`), 단계 경과 밀리초(`elapsed_ms`), 복구 횟수(`recoveries`)이며 화면 원문·입력값·URL은 넣지 않습니다. `authenticated` 상태의 탐색 메뉴만으로 성공하지 않으며 유효 쿠키·원자적 저장까지 확인합니다.
- 로그인 제출 전 `login_attempt`, 로그인 성공 확인 후 `login_ok`, 로그인 제출 없이 기존 세션을 확인하면 `session_reused`를 기록합니다. 아이디·비밀번호는 포함하지 않습니다.
- 모든 `HaltError`는 브라우저를 닫기 전에 `crawler/logs/halt-<UTC시각>-<고유값>.png`와 같은 이름의 `.txt`(이유·URL·보이는 페이지 텍스트)를 저장합니다. 파일 권한은 **0600**, 로그 디렉터리는 **0700**입니다. 환경변수의 비밀번호·토큰·시크릿, Bearer/JWT 및 토큰 필드를 가리고 화면 입력란을 숨긴 뒤 캡처합니다. 마스킹 전 본문 길이(`body_length`)와 최상위 html/body의 마스킹 여부(`root_masked`)도 txt/건강 로그에 기록합니다(읽기 실패는 `null`/`unknown`). 비밀값이 하위 노드에 있으면 상위 요소까지 숨기므로 **흰 PNG만으로 빈 화면을 판단하지 마세요**. `root_masked: true`이고 본문 길이가 0보다 크면 마스킹 결과일 수 있습니다. 로그인 사용자 식별값·이메일·Instagram 쿠키 필드도 진단에서 가립니다. 페이지 종료·디스크 오류 등으로 진단을 저장하지 못하면 `warn`을 기록하며, 종료코드 75는 유지합니다.
- 진단 DOM 마스킹은 전체 프레임을 합쳐 최대 5초만 기다립니다. 제한 시간 초과·실패 시 `root_masked`는 `null`/`unknown`으로 남기고 PNG를 생략하며, 중단 이벤트와 마스킹된 TXT는 저장합니다. 종료 요청은 프레임 응답을 기다리지 않고 진단을 중단하며 중단 이벤트는 한 번만 기록합니다.
- 휴식 전환은 건강 로그에 `quiet_window_enter`(시간대, 합친 시간의 종료·재개 예정 UTC 시각; 하루 전체 휴식이면 두 시각은 `null`), `quiet_window_exit`(지터 대기 완료 후 재개)로 기록합니다. 휴식 대기는 1초 단위로 종료 요청을 확인하며, 재개하지 않았으면 exit 이벤트를 남기지 않습니다.
- `crawler/logs/summary.json`: 현재 실행의 이벤트별 횟수, 마지막 이벤트, 로그 쓰기 실패 여부. `last_halt`에는 마지막 중단 이유·안전한 상태 분류·단계/경과/복구 횟수·본문 길이·루트 마스킹 여부만 남겨 종료/오류 이벤트 뒤에도 확인할 수 있습니다(화면 원문·URL 없음). 사이클과 종료 시 갱신합니다.
- OCR 화면 캡처는 `.cache/story.png`에 잠시 저장하고 성공·실패 모두 삭제합니다. 세션·캐시·로그는 모두 gitignore 대상입니다.

동일 상태 디렉터리를 쓰는 worker는 **한 개만** 실행하세요. pm2와 systemd를 동시에 실행하지 마세요. 운영 보존 정책에 맞춰 로그·캐시를 정리합니다.

챌린지·체크포인트·로그인 이탈·행동 차단은 종료코드 **75**로 중단합니다. API 실패는 **1**로 중단합니다. 보안확인·차단·로그인 실패를 프로세스 내에서 자동 재시도하지 않습니다. 위 로그인 단계 내의 빈 화면 GET 복구만 예외입니다. 개별 계정/발견 화면의 렌더 오류는 건너뛰고 기록합니다. aria/text와 여러 CSS 폴백을 쓰지만 실제 UI 변경은 `selector_miss` 로그를 보고 수동 점검해야 합니다.

## 운영

전체 기본 일정은 루트의 [운영 일정](../README.md#운영-일정)을 따릅니다. PM2 예약 실행과 systemd 연속 실행은 **둘 중 하나만** 선택합니다. 공유 계정은 브라우저에서 로그아웃하지 않습니다.

`agamajung-crawler.service` 주석대로 전용 사용자·비밀 환경파일·Node 22·브라우저를 준비한 뒤 단위 파일을 설치합니다. systemd는 ProtectHome을 사용하므로 주석에 지정한 `PLAYWRIGHT_BROWSERS_PATH`에 브라우저를 설치해야 합니다. 쓰기 경로는 crawler 아래로 제한합니다.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now agamajung-crawler
```

pm2를 사용할 때도 같은 환경변수를 비밀 저장소에서 주입하거나 루트 `.env.crawler`를 준비합니다. pm2 자체는 파일을 읽지 않지만 크롤러가 시작 시 읽습니다. 주입된 환경변수 변경 후 `pm2 restart agamajung-crawler --update-env`를 실행하세요. 주입된 값은 파일보다 우선하므로 `AGAMAJUNG_IG_USER`가 의도한 핸들인지 확인하세요. 기본값은 `agamajung`입니다.

```sh
pm2 start crawler/ecosystem.config.cjs
```

pm2는 JavaScript 진입점 `crawler/run.mjs`를 저장소의 Node 22 인터프리터와 `node_args: '--import tsx'`로 실행합니다. TypeScript 자동 인터프리터 감지를 피하면서 로컬 `tsx`로 `index.ts`를 불러옵니다. 설정 변경을 적용할 때도 위 ecosystem 파일을 사용하세요.

pm2 설정은 `cron_restart: '30 9,20 * * *'`, `autorestart: false`, `AGAMAJUNG_ONCE=1`, `stop_exit_codes: [75]`입니다. 성공·실패·차단 후 모두 다음 예약까지 종료 상태를 유지합니다. 메모리/파일 변경 재시작도 사용하지 않습니다. 두 공유 계정 휴식 시간은 `AGAMAJUNG_QUIET_WINDOWS=06:45-08:00,13:00-14:00`으로 고정합니다.

**cron은 pm2 데몬의 시간대**를 사용합니다. 이 Linux 박스의 데몬 시간대는 `Asia/Seoul`이어야 합니다. 자식 환경의 `TZ`만 바꾸어서는 cron 시간대가 바뀌지 않습니다. 위 `pm2 start` 명령은 즉시 한 번 실행하므로, 다음 예약까지 기다려야 하는 최초 등록에는 사용하지 마세요. 그 경우 PM2 API의 `prepare`에 `status: 'stopped'`, `autostart: true`, `instances` 생략으로 등록하면 프로세스를 시작하지 않고 cron만 등록합니다. `autostart: false`는 이후 cron 실행까지 막으므로 사용하지 않습니다. 등록 후 `pm2 save`로 보존하세요. systemd 예시는 `crawler/index.ts`를 직접 실행하는 연속 운영 방식이며 `Restart=on-failure`, `RestartSec=600`, `RestartPreventExitStatus=75`입니다. PM2와 함께 실행하지 않습니다. 독립 수집함의 discover/sync 타이머는 운영자가 별도로 관리하며 저장소에 포함되어 있지 않습니다.

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Vitest로 추출, KST 상한·지터·재시작, 발견 파싱·태그 순환, 셀렉터 폴백, 신호별 스캔 일정, 기존 팔로잉 가져오기·24시간 시도 제한·휴식 중 동기화 중단, 스토리 자동 넘김 회귀, OCR/전송/중복/실패 복구, 건강 로그와 API 검수 격리, 주입된 시계로 두 휴식 시간 경계·겹침/인접 병합·자정 통과·설정/환경변수 호환·로그인 생략·실행 중 중단·지터 후 재개·다음 시간 타이머를 확인합니다. 이메일 코드 challenge 우선 중단, 단계별 빈 화면 대기·GET 상한·시간 제한·저장 전 재확인과 기존 세션 보존, 중단 진단 파일·권한·비밀값 마스킹, 정리 실패 중에도 75 유지, 로그인 이벤트, pm2 진입점도 오프라인으로 검증합니다. API 테스트는 메모리 SQLite를 사용합니다. 테스트 설정에서 모든 소켓·실제 fetch·브라우저 실행을 차단하며, 필요한 응답은 mock으로 제공합니다. **테스트에는 네트워크 접속이 없습니다.**

## 상품 이미지 URL 계약

Linux 크롤러는 이미 열린 게시물·스토리에서 선택한 상품 이미지 URL을 선택 필드 `image_url`로 `/api/v1/ingest`에 함께 전송합니다. 게시물은 현재 글의 보이는 이미지에서 `currentSrc`를 우선하고 프로필·헤더·가려진 캐러셀 이미지를 제외합니다. 없을 때 같은 게시물의 `og:url`로 확인된 `og:image`만 대안으로 사용합니다. 스토리는 준비·일시 정지 후 선택한 동일 미디어로 OCR을 수행하고, 추출 후와 OCR 후 스토리 ID가 바뀌면 전송하지 않습니다. 영상은 유효한 poster가 있을 때만 이미지 URL을 보내며 영상 URL·blob URL·로컬 캡처 경로는 보내지 않습니다.

URL은 최대 4,096자의 HTTPS Instagram CDN(`cdninstagram.com`, `fbcdn.net` 및 실제 하위 도메인)만 허용하며 서명 쿼리를 그대로 유지합니다. 이미지 누락·잘못된 URL·선택 실패는 정상 캡션 전송을 막지 않고, OCR 가능한 영상 프레임·이미지도 URL 없이 수집할 수 있습니다. 휴식·halt 오류는 계속 전파합니다. 이미지 다운로드·추가 Instagram 탐색은 하지 않으며 URL·원시 미디어 오류를 로그에 남기지 않습니다. 기존 OCR 필수 조건·속도 제한·중복 처리·API 전달 성공 후 완료 기록을 유지합니다.

이미지는 승인 전까지 비공개입니다. 관리자는 미리보기를 확인하고 “이미지 포함”을 해제해 텍스트만 게시할 수 있습니다(`include_image: false`, 기본 true). 공개 화면은 브라우저 직접 로딩과 `no-referrer`를 사용하며 실패한 이미지를 숨깁니다. **CDN URL은 만료될 수 있습니다.** 현재 ingest는 업로드를 지원하지 않아 R2에 저장하지 않습니다. 영구 저장은 별도의 업로드·검수 후 공개 계약이 필요합니다. Playwright/OCR은 Linux에서만 실행하며 사이트·Workers로 옮기지 않습니다.

## 독립 로컬 수집함

DNS가 프록시 가상 IP를 반환하는 박스에서는 `private_network`로 실패할 수 있습니다. 기본 DNS 검사는 엄격하게 유지하며 운영자가 `COLLECTOR_TRUSTED_EGRESS_CIDRS="198.18.0.0/15"`처럼 신뢰 egress CIDR을 명시한 경우에만 해당 대역을 허용합니다(쉼표로 여러 개, 기본 빈 값). 루프백·링크로컬·멀티캐스트 등 금지 대역과 겹치는 설정은 거부하고, 모든 DNS 응답 주소와 리디렉트마다 재검사합니다. 신뢰 대역을 지정하면 그 대역 안에서는 주소 고정이 더 이상 보호하지 않으며, 프록시가 호스트명을 다시 해석하므로 DNS 리바인딩과 내부 호스트명 차단은 프록시 정책에 의존한다. 출처별 실패 원인은 `npm run collector -- jobs [--json]`, discover stdout의 `jobs`, stderr의 `discover source=` 출처별 종료 요약에서 확인합니다. 시도한 출처는 성공·실패 모두 한 줄씩 출력하며, `source_blocked`는 403/CAPTCHA 등 차단, `source_cooldown`은 429/5xx 냉각을 뜻합니다. 실패 작업은 `limits.failure_backoff_ms`(기본 300000, 5분) 후 다시 discover하면 재시도합니다. 이 설정이 없는 기존 운영 설정에도 기본값이 적용됩니다. job 요약은 로컬에만 남으며 사이트 스냅샷에 포함하지 않습니다.

Node 22.20 이상 Linux에서 `src/local-worker.ts`를 실행합니다. Instagram 자격 증명·사이트 INGEST_TOKEN 없이 수집과 로컬 검토가 가능합니다. 공개 브라우저 추출용 Playwright도 Linux의 독립 프로세스에서 실행합니다. Cron/Workers에서 실행하지 않습니다. `crawler/.cache/collector.sqlite`와 전용 `crawler/migrations/0001_collection.sql`은 사이트 D1과 분리됩니다. 세 경로는 auto_discovery(RSS/API/사이트맵/링크), browser_extract(승인된 공개 브라우저), manual_clip(Chrome MV3 확장)입니다. CLI 진입점은 `crawler/collector.mjs` → `crawler/src/cli.ts`이고, 확장은 [Chrome clipper README](../tools/chrome-clipper/README.md)를 따릅니다.

```sh
npm run collector:worker -- serve
npm run collector -- report
npm run collector -- report --json
npm run collector:worker -- discover --dry-run
npm run collector:worker -- discover
npm run collector:worker -- sync
```

`serve`는 loopback 127.0.0.1:4318만 엽니다. COLLECTOR_INTAKE_TOKEN·COLLECTOR_REVIEW_TOKEN은 서로 다른 24자 이상의 비밀로 주입하고 COLLECTOR_EXTENSION_ORIGIN에는 등록한 Chrome 확장 origin을 넣습니다. Host·Origin·토큰·JSON 형식·32KB 크기 제한을 검사합니다. 인테이크 토큰은 예약/조회/시작/취소/제출만 가능하고, CLI·검토 API는 별도 검토 토큰이 필요합니다. 토큰을 인자로 넘기거나 로그로 남기지 마세요. COLLECTOR_DB/COLLECTOR_CONFIG로 전용 경로를 바꿀 수 있습니다. 예시 환경 파일은 값의 목록일 뿐 자동 로드하지 않습니다. 환경을 프로세스에 주입하세요.

동일 DB를 쓰는 작업기는 하나만 실행합니다. 위 `discover`와 `sync`는 serve를 중지한 상태에서 실행하거나 운영 스케줄에서 순차 실행하세요. 수집을 자동 운영하려면 운영자가 Linux timer/cron으로 discover와 sync를 예약합니다. 저장소는 해당 타이머를 제공하지 않습니다. CLI 변경 명령은 실행 중인 serve API를 거치며 DB를 직접 수정하지 않습니다.

설정의 sources에는 출처 종류·브랜드 예산·origin/경로/쿼리 범위·시작점·어댑터·브라우저 승인/selector·공식 근거 권한·전문 보관 허가·재확인 간격·페이지 상한이 있습니다. 기본 소스는 모두 disabled입니다. 사이트별 robots/DOM과 범위를 운영자가 확인하고 아래 활성화 절차를 통과한 뒤 활성화하세요. 언론·인터뷰·블로그·행사·검색 링크도 발견 후보로 수용하지만 등록되지 않은 호스트를 방문하지 않습니다. 검색 쿼리를 생성하지 않으며 달력·페이지 조합을 제한합니다. 수동 담기에서 등록되지 않은 사이트는 선택한 공개 영역과 제한된 정형 사실만 받습니다.

### 수집 건강 요약

`discover` stdout JSON의 `health`는 이번 실행의 `mode`, `status`, `sources`, 검토가 필요한 출처 ID 목록 `review`를 담습니다. dry-run도 `{dry_run:true, health}`를 출력합니다. stderr에는 시도한 출처마다 `discover source=... status=...` 종료 요약 한 줄이 나오며, 모든 페이지가 실패하거나 차단된 출처도 포함됩니다. `failed=`는 실패 페이지 수, `reason=`은 가장 빈번한 실패 코드입니다. `jobs`/`report` 및 `jobs` CLI 형식은 그대로입니다. `review`여도 종료코드는 기존대로 0이므로 운영자는 반드시 `health.status`를 확인하세요.

| 지표 | 의미 |
| --- | --- |
| `pages_attempted` / `pages_ok` / `pages_failed` | 시도 / 측정·처리 완료 / 실패 페이지 수 |
| `pages_review` / `page_findings` | 정상 처리했지만 빈 결과 등의 소견이 있는 페이지 수 / 소견별 페이지 수 |
| `links_found` | 어댑터가 발견한 링크 수 |
| `parsed` | 목록 항목·피드 링크·리콜 수. 브라우저는 추출 영역 하나를 1로 셈 |
| `eligible` | 기존 유아용품 분류를 통과한 목록 항목, 방문 범위 안의 피드 링크, ID·이름이 있는 리콜, 또는 사실이 있는 브라우저 영역 수 |
| `price_checked` | 가격을 검사한 적격 목록 항목 수. 브라우저는 `clue_price`/`official_msrp` 사실 수 |
| `price_hints` | 위 검사 중 숫자 가격 단서가 있는 항목/사실 수 |
| `sent` | 로컬 저장소 제출에 성공한 항목 수. 페이지 영역 보관용 제출은 제외하며 dry-run은 항상 0 |
| `blocked` / `blocked_reasons` | robots·방문 정책·중단·냉각·네트워크 주소 정책이 거부한 요청 수 / 코드별 횟수. 리디렉트 체인은 한 번만 셈 |
| `failures` / `subrequest_failures` | 페이지 실패 코드별 횟수 / 영역 추출과 별개로 실패한 브라우저 XHR·스크립트 등 요청의 코드별 횟수 |

숫자 가격은 0보다 큰 안전한 정수 금액만 셉니다. 문자열은 `329,000원`처럼 금액 하나가 명확해야 합니다. `가격: 문의`, 범위 가격, 안전한 정수 범위를 넘는 금액은 단서로 세지 않습니다. 피드와 리콜 자체는 가격을 검사하지 않습니다.

검토 플래그는 `failed`(페이지 실패), `blocked`(거부된 요청), `not_attempted`(성공 페이지 없음), `zero_parsed`(파싱 결과 0), `zero_eligible`(파싱 결과는 있으나 적격 0), `zero_price_hints`(가격 검사 후 숫자 단서 0), `subrequest_failed`(브라우저 하위 요청 실패)입니다. 빈 결과 소견은 페이지마다 기록하므로 **다른 페이지가 정상이어도 selector 일치가 없는 페이지 하나만 있으면 출처는 항상 `review`**입니다. 의도적으로 막은 이미지·미디어·WebSocket·비 GET 요청은 거부/실패 지표에서 제외합니다. 탐색 문서 실패는 페이지 실패로만 세고, 차단된 하위 요청은 `blocked_reasons`로만 셉니다.

출처 `status`는 플래그가 없으면 `ok`, 하나라도 있으면 `review`입니다. 실행 전체는 시도한 페이지가 없으면 `idle`, 시도한 모든 출처가 `ok`이면 `ok`, 그 외에는 `review`입니다. 참고 메모 `price_not_applicable`은 CPSC 리콜처럼 가격이 적용되지 않는 경우, `price_not_assessed`는 적격 결과가 있지만 가격 검사를 하지 못한 경우입니다. 메모 자체는 상태를 바꾸지 않습니다.

건강 출력은 설정의 출처 ID·정수 건수·정해진 상태/코드만 포함합니다. URL·제목·인용·selector·핸들·가격 값은 출력하지 않습니다. 코드는 `^[a-z_]{1,40}$`만 허용하며 그 외 오류는 `error`입니다. 요약은 이번 실행의 로컬 출력으로만 남으며 Instagram 건강 로그·`sync` 스냅샷·사이트 D1에 포함하지 않습니다.

### 외부 출처 활성화 절차

1. 설정을 비공개 `COLLECTOR_CONFIG` 파일로 복사하고 대상 출처만 `enabled: true`로 설정합니다.
2. `npm run collector:worker -- discover --dry-run`을 실행합니다. RSS·사이트맵·링크 출처는 `max_pages` 예산 안에서 시작 페이지마다 최대 2개 항목 페이지도 검사합니다. `limits.max_depth`가 탐색을 허용해야 합니다. 레코드·근거·셀러·업무 큐·outbox는 저장하지 않으며 예산과 도메인 속도/중단 상태는 유지합니다.
3. 다음 조건을 모두 통과해야 합니다: 실행과 대상 출처의 `status=ok`, `pages_ok == pages_attempted`, `pages_review == 0`, `blocked=0`, 빈 `subrequest_failures`, `parsed>0`, `eligible>0`. `price_checked>0`이면 `price_hints>0`이어야 합니다. 메모에 `price_not_assessed`가 있으면 `max_pages`/`max_depth`를 늘려 항목 검사가 가능하도록 한 뒤 다시 dry-run합니다. CPSC의 `price_not_applicable`은 허용합니다.
4. 조건이 실패하면 아래 조치를 적용합니다.

   | 결과 | 조치 |
   | --- | --- |
   | `zero_parsed` | 상세 페이지를 포함한 selector/DOM 확인 |
   | `zero_eligible` | 범위·분류·허용 경로 확인 |
   | `zero_price_hints` | 가격 마크업·라벨 확인 |
   | `blocked` / `robots_*` / `source_blocked` | 중단하고 활성화하지 않음 |
   | `source_cooldown` | 냉각 후 다시 시도 |
   | `subrequest_failed` / `failed` | 해당 코드 확인 |

5. 통과한 출처를 운영 설정에서 활성화하고 첫 실제 실행 후 `health`를 다시 확인합니다.

### 어댑터와 수집 제한

CPSC JSON 어댑터는 [공식 REST 안내](https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information)의 `https://www.saferproducts.gov/RestWebServices/Recall?format=json&ProductName=Toddler`를 사용합니다. RecallID·URL·Title·RecallDate·Products[].Name을 리콜 근거로 매핑합니다. XML RSS/Atom·사이트맵/인덱스·공개 HTML 링크도 지원합니다. 일반 `/api/`·로그인·회원 경로 금지는 유지하며 CPSC의 등록 endpoint만 접근합니다. 브라우저의 모든 document/XHR/fetch/script/stylesheet GET도 공통 스케줄러/robots/주소 검사를 거칩니다. 쿠키 없는 브라우저에서만 읽으며 이미지·미디어·WebSocket은 차단합니다.

브랜드/KST 하루 발견 500개, 본문 추출 시도 200회, 별도 재확인 200회, 미확정 브랜드 공용 예산도 동일합니다. 모든 경로가 예약을 공유합니다. 같은 도메인은 응답 본문이 끝날 때까지 동시 1개, 간격은 5초와 Crawl-delay 중 큰 값, 깊이 2, 응답 2MB를 상한으로 둡니다. 재확인 기한이 지난 가격·조건은 새 탐색보다 먼저 배정합니다. DNS 공인 주소를 검사한 결과에 연결을 결속하고 리디렉트마다 정책을 재검사합니다. 429/5xx는 Retry-After와 최소 60초 냉각, 403/CAPTCHA/차단 화면은 수동 점검 전 중단합니다. 상태는 DB에 유지됩니다. 계정·프록시 교체 우회는 없습니다.

예약 API는 `/v1/intake/reservations`, `/v1/intake/reservations/:id/start`, `.../cancel`, `/v1/intake/clips/:clip_id`, `/v1/intake`입니다. 예약은 client·clip_id·attempt_id·URL·브랜드·경로·작업 종류·정책 버전에 결속됩니다. 바뀐 결속/멱등 payload는 409입니다. held는 10분/KST 자정까지만 유지하며 시작 시 spent로 옮기고 실패해도 환급하지 않습니다. 새 URL을 recheck로 요청할 수 없습니다. dry-run도 본문 시도 예산과 도메인 제한·중단 상태를 사용하지만 레코드·셀러·업무 큐·outbox는 저장하지 않습니다. 실행 허용 2분, 저장된 payload 제출 유예 7일입니다. ACK는 레코드·근거·셀러 이벤트·중복/충돌·검토 무효화·receipt·집계/outbox의 단일 트랜잭션 commit 뒤 반환합니다. 같은 접수 재전송은 기존 receipt를 반환합니다.

기본 저장은 구조화 사실과 근거당 300자 인용입니다. 공식 MSRP는 브랜드·시장 권한이 설정된 제조사/수입사가 명시한 권장소비자가만 인정합니다. 다른 가격은 clue_price입니다. 다른 조건의 옵션 가격은 별도로 보존하고, 같은 조건의 서로 다른 값이나 비교 조건이 불명확하면 충돌을 보존하여 공개 검토를 막습니다. 알려진 모델 계보는 `config/model-families.json`로 색상·재질·구성 옵션을 묶고 target_model_id를 지우지 않습니다. 명시적인 원문 관계와 정제된 장문 지문으로 문서 중복을 묶으며 추정 번역/불명확한 세대를 자동 병합하지 않습니다.

자료 읽기 단계에서는 입력/폼/편집·비공개 영역·사진을 제외하고, 확장 저장 전·로컬 저장 전·AI 전달 전에 같은 순수 개인정보 필터를 적용합니다. 전화/이메일/주소/주민번호, 아이 신상·개인 건강/금융·비밀 문자열을 지우거나 해당 줄을 버립니다. 필터는 정규식만으로 완전한 익명화를 보장하지 않으므로 필요한 영역·정형 라벨로 제한하고 판별 불가한 본문은 저장하지 않습니다. 인젝션 문장은 제외하고, 나머지 자료도 항상 untrusted_source_data로 취급합니다. 자료에서 명령 실행·임의 도구 호출·상태 승격·게시는 하지 않습니다. 전문은 허가 플래그와 허가 근거가 모두 있을 때만 별도 저장합니다. 신규 경로는 사진/영상·원문 오류/URL 로그를 저장하지 않습니다.

검토는 `/v1/groups`와 `/v1/groups/:id`에서 전체 묶음을 확인합니다. 변경 API는 `.../review`, `.../resolve`, `.../merge`, `.../split`, `.../representative`, `.../withdraw`, `.../link`입니다. 모두 expected_group_version·expected_evidence_version·review_scope_digest를 요구합니다. merge는 other_expected도 필요합니다. 비대표의 새 근거·리콜도 근거 버전과 검토 범위를 바꾸며 기존 사실/공개 승인을 같은 트랜잭션에서 무효화합니다. 해소 내역·선택된 assertion·이유·철회 이력은 원래 근거와 함께 보존합니다. 만료와 정책 변경도 재검토 대상입니다.

```sh
npm run collector -- groups list
npm run collector -- groups show <group-id>
npm run collector -- review-group <group-id> <review-json-file>
npm run collector -- sellers list --json
npm run collector -- sellers show instagram:<handle>
npm run collector -- sellers review instagram:<handle> manually_registered '수동 등록 확인'
npm run collector -- sellers export-account instagram:<handle>
npm run collector -- import-legacy-candidates --state <읽기전용-state.json-경로>
```

검토 JSON의 decision은 verify/ready이며 reviewer와 위 세 버전 필드를 넣습니다. ready에는 현재 근거 버전의 verify, 미해결 충돌 없음, 개인정보 검사·근거 위치·최신성이 필요합니다. 공개 대기는 게시하지 않습니다. 합계는 다섯 상태의 합이며 대표는 묶음마다 정확히 하나, 비대표는 dedup_excluded입니다. 예약/전달 대기·셀러는 레코드 건수에 더하지 않습니다.

기존 state.json 후보는 읽기만 하여 멱등 가져옵니다. 최초 found_via·표본 URL·모델·최초/최근 시각을 보존하고 기존 hits는 legacy_hits로 분리합니다. 잃어버린 후속 출처는 legacy_imports에 복구 불가로 표시합니다. 새 발견은 source 행과 hits로 누적하되 ACK 재전송에는 증가하지 않습니다. export-account는 verified/follow/collect_images 모두 false인 검토용 조각만 출력합니다. accounts.json·실제 팔로잉은 변경하지 않습니다. Instagram 태그 발견은 기존 상태 파일을 계속 사용합니다.

DB 디렉터리는 0700, DB/WAL/SHM/journal은 0600이고 심볼릭 링크·잘못된 권한·손상·쓰기 실패는 중단합니다. BEGIN IMMEDIATE·외래키·WAL·synchronous FULL을 사용합니다. 강제 종료로 `.lock`이 남으면 기존 프로세스가 종료되었음을 운영자가 확인한 뒤 lock만 제거하고 재시작하세요. DB 오류를 빈 DB로 바꾸지 않습니다.

### 건수 동기화

전송 진입점은 `npm run collector:worker -- sync`(`crawler/src/local-worker.ts` → `crawler/src/status-sync.ts`)이며 사이트의 `POST /api/v1/collector/status`만 호출합니다. 별도 동기화 프로세스로 실행하고 같은 DB의 serve/discover와 동시에 실행하지 않습니다.

sync는 별도 COLLECTOR_STATUS_TOKEN과 HTTPS COLLECTOR_SITE_URL만 사용하여 트랜잭션 outbox를 전송합니다. COLLECTOR_STATUS_TOKEN은 사이트에 바인딩한 것과 같은 값이며 `crawler/.env.crawler.example`에는 포함하지 않으므로 비밀 저장소에서 별도로 주입합니다. 전송 전에 검토 만료와 재확인 건수를 갱신하고, 최신 스냅샷을 만든 지 15분 이상 지났으면 더 높은 버전의 새 스냅샷을 추가합니다. 빈 수집함의 첫 sync도 0건인 버전 1을 만듭니다. 운영 타이머는 `npm run collector:worker -- sync`를 15분 이하 간격으로 실행하세요. 사이트는 스냅샷 생성 후 60분을 넘기면 동기화 지연으로 표시합니다. 대기 중인 항목은 변경하지 않고 새 버전만 추가하므로 응답 유실 후에도 같은 payload를 재전송합니다.

스냅샷은 건수·보조 지표·작업기 ID·버전·시각만 포함하며 실패하면 유지/재전송합니다. outbox는 리디렉트 없는 `200 application/json {data:{worker_id,version}}` 응답에서 일치하는 문자열 worker_id와 전송 버전 이상의 안전한 정수 version을 확인한 뒤에만 삭제합니다. 잘못된 receipt·본문 초과·본문 읽기 실패·응답 유실은 재전송 대상으로 남습니다. 사이트 버전이 로컬 카운터보다 높아도 삭제와 후속 전송을 계속하며 sync CLI JSON에 `site_version_ahead: true, site_version`으로 보고합니다. 카운터 자체는 바꾸지 않습니다. 오류 진단은 고정 코드만 사용하고 토큰·응답 본문·원래 전송 오류는 출력하지 않습니다. 실제 수집함·근거는 Linux에 남습니다. 자세한 Chrome 권한/재클릭 경계는 [확장 README](../tools/chrome-clipper/README.md)를 참고하세요.

로컬 DB를 새로 만들면 현황 버전은 1부터 다시 시작합니다. 같은 `worker_id`의 이전 높은 버전이 D1에 남아 있으면 새 현황은 반영되지 않습니다. DB 복구는 버전 메타데이터를 포함한 백업을 사용하세요. DB를 재구축할 때는 `COLLECTOR_CONFIG`의 `worker_id`를 새 식별자로 바꾸고, 관리자 화면에서 이전 작업기를 구분하세요. 서로 다른 작업기의 건수는 자동 합산하지 않습니다.

## 구현 기록 (참고용)

다음 문장은 과거 구현 당시의 기록이며 현재 운영·접속 상태를 증명하지 않습니다.

- 실제 Instagram 접속·로그인·수집은 이번 작업에서 실행하지 않았습니다.
- 이번 작업에서 시드 계정 핸들을 실시간 검증하지 않았습니다. 기존 환경의 이메일 사용자명을 핸들로 바꾸도록 안내했습니다. 현재 기본값은 `agamajung`입니다.
- 프로필 그리드의 핸들 포함 URL이 기존 selector 미스 원인이라는 설명은 가설이었으며, 이후 실제 실행의 anchors와 수집 결과로 확인하도록 했습니다.
- 이미지 URL 전달 당시 기록: “업로드 지원이 없어 이번 구현은 R2에 저장하지 않습니다.” 현재 계약도 CDN URL 직접 표시이며 영구 저장은 별도 설계 대상입니다.
