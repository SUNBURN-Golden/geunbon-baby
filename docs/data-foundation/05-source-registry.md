# 05 · 소스 레지스트리와 Instagram 중단

[Daemon](04-daemon-roles.md) · 다음: [작업 단위](06-work-units.md)

## 레지스트리 계약

레지스트리 항목은 서비스 전용이다. 현행 [collector.json](../../crawler/config/collector.json)과 [공식 출처 규칙](../../seed/official-sources.json)을 이행 입력으로 삼는다. 소스 발견 자체가 수집·보관 권한을 부여하지 않는다. 아래 권한은 **외부 robots·약관을 새로 확인한 결과가 아니다**.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SourceRegistryEntryDraft",
  "type": "object",
  "required": ["id", "kind", "hosts", "paths", "blocked_paths", "adapter", "collectable_fields", "official_fields", "full_text_allowed", "permission", "refresh_ms", "retention", "unsupported", "halt_policy", "state", "enabled", "owner"],
  "properties": {
    "id": {"type": "string", "minLength": 1},
    "kind": {"enum": ["manufacturer", "importer", "government", "press", "blog", "interview", "event", "search", "unknown", "official", "importer_mall", "retailer", "group_buy", "public_db", "clue", "social"]},
    "origin": {"type": ["string", "null"]},
    "hosts": {"type": "array", "items": {"type": "string"}},
    "paths": {"type": "array", "items": {"type": "string"}},
    "blocked_paths": {"type": "array", "items": {"type": "string"}},
    "adapter": {"type": ["string", "null"]},
    "collectable_fields": {"type": "array", "items": {"type": "string"}},
    "official_fields": {"type": "array", "items": {"type": "string"}},
    "full_text_allowed": {"type": "boolean"},
    "permission": {
      "type": "object", "required": ["robots", "terms", "basis"],
      "properties": {
        "robots": {"$ref": "#/$defs/check"},
        "terms": {"$ref": "#/$defs/check"},
        "basis": {"type": ["string", "null"]},
        "exception": {
          "type": "object", "required": ["decided_by", "decided_at", "scope", "expires_at"],
          "properties": {
            "decided_by": {"type": "string", "minLength": 1},
            "decided_at": {"type": "string", "format": "date-time"},
            "scope": {"type": "string", "minLength": 1},
            "expires_at": {"type": "string", "format": "date-time"}
          }
        }
      }
    },
    "refresh_ms": {"type": ["integer", "null"], "minimum": 1},
    "retention": {"type": "object", "required": ["snippets", "full_text", "images"]},
    "unsupported": {"type": "array", "items": {"type": "object", "required": ["scope", "reason"]}},
    "halt_policy": {"type": "string"},
    "state": {"enum": ["active", "disabled", "halted"]},
    "enabled": {"type": "boolean"},
    "owner": {"type": "string", "minLength": 1}
  },
  "$defs": {
    "check": {
      "type": "object", "required": ["status", "checked_at", "url", "summary"],
      "properties": {
        "status": {"enum": ["allowed", "disallowed", "unknown"]},
        "checked_at": {"type": ["string", "null"], "format": "date-time"},
        "url": {"type": ["string", "null"]},
        "summary": {"type": ["string", "null"]}
      }
    }
  }
}
```

구조 검증 외에 WU-04 validator가 아래 의미 규칙을 강제한다.

- active/enabled=true는 robots·terms 모두 allowed이고 확인 URL·시각·판정 근거가 있을 때만 가능하다. unknown은 기본 disabled이며, 명시된 범위·결정자·날짜·만료일을 가진 유효한 exception이 있는 경우만 예외로 활성화할 수 있다. disallowed는 예외로도 활성화할 수 없다.
- enabled는 `state == active`의 파생값이며 모순을 거부한다. 영속 halt는 예외 승인으로 해제할 수 없다.
- full_text_allowed는 별도 전문 이용 허가·permission_basis 및 보관 기간을 요구한다. robots 허용만으로 저작물 재보관을 허가하지 않는다. 소스별 짧은 기간이 기본안보다 우선한다.
- source kind와 official_fields는 필드별 권한이다. 일반 공식몰 할인가를 official_msrp로 바꾸지 않는다. 공구 판매처의 직접 본문·사람 검수에 사용할 공구 가격 권한도 별도로 등록한다. Instagram·공구 모음은 official_fields가 없다.
- 호스트·경로·query_keys·redirect·egress·페이지/용량 상한을 현행 정책대로 검사한다. 차단 경로가 허용 경로보다 우선한다. 레거시 external-sources.json enabled를 권한 근거로 쓰지 않는다.

## 초기 실제 레코드 목록

모든 아래 행에 공통으로 `permission.robots/terms={status:unknown, checked_at:null, url:null, summary:null}`, `basis:null`, `state:disabled`, `enabled:false`, `owner:"아가마중 운영 담당(미지정)"`, `full_text_allowed:false`를 적용한다. exception은 없으며 자동 수집을 시작하지 않는다. 2026-10-23 본문 확인은 일회성 에이전트 조회이며 자동 수집 권한 확인이 아니다. 아래 시간·보관은 제안이며 활성화 전에 승인한다. kind가 복수 역할이면 레코드의 kind는 앞의 값, 나머지는 data 역할로 둔다.

공식 출처 공통 기본값 O: `collectable_fields=[official_msrp,components,manual_url,business_notice]`, `official_fields=[official_msrp,components]`(나머지 필드는 등록 후 검수), 갱신 7일, 인용 무기한 제안·전문/이미지 없음. blocked_paths는 seed의 `/article/`, `/board/`, `/review`, `/community`, `/event` 규칙을 그대로 이행한다. paths도 seed의 호스트별 정규식을 복사하며 범위를 넓히지 않는다. 호스트 없음은 paths=[]·adapter=null이다.

| id | kind / hosts·paths·adapter | 수집 필드·권한 | 주기·보관 | 지원 안 함 / 이유 |
| --- | --- | --- | --- | --- |
| official:stokke | official · www.stokke.com · `^/KOR/ko-kr/.+\.html$` · 승인 후 browser_extract | O | O | 리뷰·커뮤니티·이벤트: 공식 사양 아님 |
| official:bugaboo | official · www.bugaboo.com · seed PM/PV 제품 경로 · browser_extract 후보 | O | O | 현행 설명서 not_found; 근거 없는 설명서 연결 안 함 |
| official:cybex | official(importer_mall 역할 포함) · www.cybex-online.com, cybex-shop.co.kr, www.cybex-shop.co.kr · seed 경로 | O | O | 2026-10-23 접속 실패. 수입사 재확인 실패 |
| official:nuna | official(importer_mall) · nunababy.com, aonebaby.co.kr, www.aonebaby.co.kr · seed 경로 | O | O | 국내몰 TLS 오류. 가격 미채택, 검증 우회 금지 |
| official:joie | official(importer_mall) · joiebaby.com, aonebaby.co.kr, www.aonebaby.co.kr, joiebaby.co.kr, www.joiebaby.co.kr · seed 경로 | O | O | 국내몰 재확인 실패 |
| official:babybjorn | importer_mall · www.babybjorn.kr, next.babybjorn.kr · seed 경로 | O | O | 제품·지원 범위 밖 수집 안 함 |
| official:egg | official(importer_mall) · eggstroller.com, eggstroller.co.kr, www.eggstroller.co.kr · seed 경로 | O | O | 국내몰 재확인 실패 |
| official:dthrone | official · www.dthrone.com · seed 경로 | O | O | 지원 페이지 접근 실패 이력, 보증·설명서 추정 안 함 |
| official:britax | official(importer_mall) · www.britax-roemer.com, britaxmall.co.kr, www.britaxmall.co.kr · seed 경로 | O | O | 국내몰 재확인 실패 |
| official:maxi-cosi | official(importer_mall) · www.maxi-cosi.com, mbaby.co.kr, www.mbaby.co.kr · seed 경로 | O | O | 국내몰 재확인 실패 |
| official:silver-cross | official · hosts=[] | 수집/권한 필드=[] | 주기 null·원문 없음 | 국내 공식가 지원 안 함: 수입사 unconfirmed |
| official:doona | official · hosts=[] | 수집/권한 필드=[] | 같음 | 국내 공식가 지원 안 함: 수입사 unconfirmed |
| official:ergobaby | official · hosts=[] | 수집/권한 필드=[] | 같음 | 국내 공식가 지원 안 함: 수입사 재확인 실패·국내 호스트 없음 |
| public:cpsc | public_db · www.saferproducts.gov · /RestWebServices/Recall · cpsc | 리콜 ID·날짜·제품명·위험·URL / recalls | 1일(현행), 구조화 기록 무기한 제안, 전문 없음 | 국내 적용 자동 판정·검색 완전성 보장 안 함 |
| public:safetykorea | public_db · `hosts=[]` · 연결 후 확정 · adapter=null | KC 인증·리콜 후보 / official_fields=[] | 주기 null·원문 없음 | API 키 발급 전 not_connected. 엔드포인트·약관 미확인 |
| group:pangpang | group_buy · 09pangpang.com · `/` · links | 기간·판매처 링크·가격 단서 / 권한=[] | 6시간(현행), 인용 90일 제안 | 확정 가격·로그인 영역·상세 추적 지원 안 함 |
| group:momcalendar | group_buy · momcalendar.com · `/` · links | 같음 | 같음 | 같음 |
| group:buyg | group_buy · buyg.kr · `/` · links | 같음 | 같음 | 같음 |
| group:snapup | group_buy · snapup.co.kr · `/` · links | 같음 | 같음 | 같음 |
| retailer:* (등록 템플릿) | retailer · hosts=[] | 필드=[] / 권한=[] | 주기 null | 등록된 판매처 레코드 없음. 0010 승인 후 판매처별 등록·권한 별도 확인 |
| clue:press-blog | clue · hosts=[] · manual_clip | 출시·가격·구성 변경 단서 / 권한=[] | 수동, 인용 90일 제안 | 자동 검색 쿼리·확정 가격 지원 안 함. 미등록 공개 영역은 현행 클리퍼 정책 적용 |
| social:instagram | social · www.instagram.com · 승인된 post/story 범위 · 별도 Linux worker | 공구 공지·오픈/마감·가격/구성 변경 단서 / 권한=[] | 현행 09:30·20:30 KST, 마스킹 텍스트 90일 제안 | 이미지·사진 보관, 자동 로그인, 계정 교체·프록시·확정 데이터 직접 승격 지원 안 함 |

`retailer:*`는 wildcard 활성화 항목이 아니라 등록 템플릿이다. 공구 모음 상세 추적 미지원은 레거시 `follow_detail_links:false` 범위이며 현행 설정은 links 어댑터의 경로·깊이 상한을 따른다. 레거시 설정을 현재 런타임의 권한으로 해석하지 않는다. 전역 미지원은 해외가·당근/중고 시세, 로그인이 필요한 페이지, 이미지·사진 보관이다. Instagram 현행의 이미지 URL 접수·OCR와 이 목표 정책 차이도 WU-09에서 명시적으로 처리하며 이번에는 코드를 바꾸지 않는다.

## Instagram: 필수 단서 소스와 즉시 중단

Instagram은 공구 공지·가격/구성 변경·오픈·마감을 확인할 후보를 찾는 **필수 수집원**이다. 레지스트리에 반드시 포함하지만 약관 unknown 상태를 활성 상태로 꾸미지 않는다. 예외 승인 여부는 README 질문 10이다. 현행 pm2는 레지스트리와 연결되지 않은 기존 경로이며, 이 문서가 현행 운영을 승인하거나 중단 제어를 이미 구현했다는 뜻은 아니다.

[현재 browser.ts](../../crawler/lib/browser.ts)의 `completeLogin` 로그인 폼 분기(작성 시 194~211줄 부근)는 `AGAMAJUNG_IG_PASSWORD`로 입력·제출한다. 요청의 **로그인 요구 시 즉시 중단**과 맞지 않아 WU-09에서 교체한다. [종료코드 75 설정](../../crawler/ecosystem.config.cjs)은 자동 재시작만 막으며 다음 cron_restart를 막지 않는다. summary.json의 last_halt는 진단 요약이고 영속 실행 금지 장치가 아니다.

### WU-09 목표 절차

1. 로그인 폼, `/accounts/login`, 로그인 프롬프트, checkpoint·challenge·2FA·CAPTCHA·차단이 보이면 **입력·클릭 전에** 중단한다. 로그인은 `HaltError('login')`으로 처리하고 자동 로그인 경로를 제거한다. 예약 실행은 비밀번호 변수를 읽지 않는다. 사람 위장·계정 교체·프록시 우회·자동 재시도 금지.
2. `crawler/.session/halt.json`(0600, 디렉터리 0700, gitignore됨)에 `{reason, at, run, phase}`만 원자적으로 저장한다. reason은 login/challenge/2FA/CAPTCHA/blocked 분류다. 비밀값·원문 URL을 넣지 않는다. **화면 진단보다 먼저** 저장한다. 저장 실패도 종료코드 75·health/stderr 보고를 유지한다. halt를 저장할 수 없으면 재실행을 막도록 운영자가 스케줄러를 중지해야 한다.
3. 모든 시작 경로(`crawler/run.mjs`, `crawler/index.ts` 직접 실행, pm2 cron, 향후 stage)는 공통 main 안에서 loadEnvironment·launchBrowser 전에 halt를 확인한다. 파일이 있거나 손상·읽기 불가이면 fail-closed로 halted_skip을 기록하고 네트워크·브라우저 없이 75로 끝낸다. 없는 경우만 다음 단계로 간다. 레지스트리 disabled도 네트워크 전에 확인한다.
4. 사람이 원인·상태를 확인하고 직접 브라우저에서 세션을 복구한다. 공유 계정을 로그아웃하거나 세션을 지우지 않는다. 명시 해제 CLI 후보 `npm run crawler:halt -- clear --by <운영자> --note <사유>`만 halt를 해제한다(현재 없는 후속 명령). 배타 락으로 실행 중 해제를 거부하고 halt-history.jsonl에 사유·행위자·시각을 내구성 있게 기록한 뒤 해제한다. 실행 중 크롤러가 스스로 해제하지 못한다.
5. 해제 뒤 다음 허용 예약부터 재개한다. 해제는 레지스트리 권한 승인과 별개이며 둘 다 유효해야 한다.

**`hanset.mag` 계정은 절대 로그아웃하지 않는다.** 로그아웃 클릭/URL 경로가 없어야 하며 정적 검사한다. 다른 계정으로 로그인하거나 세션 파일을 삭제하지 않는다. 기존 휴식 시간 `06:45-08:00,13:00-14:00`을 유지한다. 기본 사용자 `agamajung`와 공유 계정 관계는 운영자 확인 사항이다.

### 사람 보고

halt 기록 후 health에 안전한 reason/run/phase와 halted를 남긴다. 운영자는 로컬 halt·마스킹된 `halt-*.txt/.png`를 확인하고 원인을 해소한 뒤 명시 해제 이력을 남긴다. 보고 채널·담당자는 README 질문 4이며 결정 전 로컬 기록을 운영자가 수동 확인한다. 향후 승인된 알림 어댑터는 reason·시각·run·로컬 기록 식별자만 보내고 세션·화면·원문·개인정보를 보내지 않는다. 이번 작업에서 메시지를 발송하지 않는다.

진단 캡처는 현행 redaction·0600 정책을 유지하고 30일 뒤 삭제한다. Instagram 수집 이미지·사진은 raw나 fixture에 저장하지 않는다. 영속 halt·해제 감사 이력은 로그 삭제와 분리해 보존한다.
