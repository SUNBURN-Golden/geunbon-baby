# 아가마중 Instagram 수집 worker

Cloudflare가 아닌 **별도 Linux 머신**에서 Node.js 22 이상으로 실행합니다. 이 작업에서는 Instagram 접속·로그인·실제 수집을 실행하지 않았습니다. 본인 계정에서 접근이 허용되고 수집 동의를 받은 콘텐츠에만 사용하세요. 비공개 접근 우회·CAPTCHA 우회·자동 2FA 처리는 없습니다.

## 준비

저장소 루트에서 `npm ci`, `npx playwright install chromium`을 실행합니다. Linux 시스템 라이브러리가 필요하면 운영자가 Playwright 공식 설치 안내에 따라 설치합니다. OCR은 선택 사항이며 tesseract와 kor/eng 언어팩을 별도로 준비합니다.

`.env.example`을 참고해 별도 비밀 저장소 또는 쉘의 안전한 환경 주입 기능으로 아래 환경변수를 설정합니다. 비밀번호를 명령행 인수·로그·문서·git에 넣지 마세요. `.env.example`은 값이 없는 템플릿입니다. 루트 `.env.crawler`를 사용한다면 Node의 `--env-file=.env.crawler` 옵션으로 로드할 수 있고 이 파일은 gitignore 대상입니다.

- `AGAMAJUNG_IG_USER`: 기본 `jaytparkitrighthere@gmail.com`
- `AGAMAJUNG_IG_PASSWORD`: 로그인 비밀번호, 환경변수로만 사용
- `AGAMAJUNG_API_URL`: 아가마중 서버 origin. 로컬 외에는 HTTPS 필수
- `INGEST_TOKEN`: 서버와 동일한 수집 전용 토큰. ADMIN_TOKEN을 사용하지 않습니다.
- `AGAMAJUNG_HEADLESS=0`: 최초 수동 확인용 브라우저 표시 (X/원격 데스크톱 필요)
- `AGAMAJUNG_ONCE=1`: 최초 한 사이클 후 종료, 연속 폴링은 `0`
- `AGAMAJUNG_OCR=1`: 스토리의 표시 이미지를 tesseract로 읽기. 미설정 시 스토리 이미지 수집·전송 생략
- `AGAMAJUNG_OCR_LANG=kor+eng`

실행: `node --env-file=.env.crawler --import tsx crawler/index.ts`

## 동작과 제한

브라우저의 팔로잉 피드에서 계정을 찾고, 프로필의 팔로잉 버튼으로 다시 확인합니다. 한 사이클 최대 3계정, 계정별 최근 게시물 2개 및 스토리 3개까지만 살펴봅니다. 탐색 간 15~45초, 사이클 간 60~90분의 무작위 대기를 적용합니다. 모든 팔로잉 계정의 완전한 목록이나 사라지는 스토리의 수집을 보장하지 않습니다. 미리 접근 가능한 팔로잉 피드에 나타나는 계정들을 순환합니다.

Instagram UI·언어·A/B 테스트에 따라 셀렉터가 달라집니다. 팔로잉 메뉴·프로필 버튼·스토리 링크가 인식되지 않으면 코드를 수동 점검해야 합니다. **실서비스에서 동작 검증되지 않은 MVP**입니다. 인증/체크포인트/2FA·차단·네트워크/API 실패 시 중단하고 자동 재시도하지 않습니다. 최초 2FA 등은 운영자가 직접 브라우저에서 처리한 후 다시 실행해야 합니다. 현재 구현은 도전 화면을 감지하면 중단하므로 별도 수동 브라우저에서 생성한 Playwright storageState를 같은 경로에 안전하게 저장할 수도 있습니다.

게시물 원문과 스토리 OCR 텍스트만 `POST /api/v1/ingest`로 보냅니다. 가격·모델·판매자·일정은 추측하거나 자동 게시하지 않습니다. `/admin` 검수에서 원문 근거를 확인하고 연결해야 합니다. 중복은 정규화한 원문 URL 및 로컬 URL 이력으로 제거합니다. 인증값·원시 오류·원문을 로그로 출력하지 않습니다. OCR 실패는 가격 생성 없이 생략합니다.

## 세션 보안

`crawler/.session/state.json`은 쿠키/인증 정보를 포함합니다. 폴더 권한 0700, 파일 권한 0600으로 저장되며 gitignore 처리됩니다. `crawler/.cache/`도 비공개로 취급하세요(OCR 스크린샷 및 중복 URL 이력). 세션·캐시를 외부 공유하거나 커밋하지 마세요. 별도 전용 OS 사용자로 실행하고 운영 보존 정책에 맞춰 정리하세요. Playwright tracing·HAR·스크린 녹화는 활성화하지 않습니다. 운영 시 접근통제·토큰 교체·최소 수집 범위를 적용하세요.
