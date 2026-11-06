# 아가마중 Chrome 담기 (Manifest V3)

브라우저는 공개 자료의 필요한 영역만 읽습니다. 예약·예산·근거·중복·검토 상태는 Linux 작업기가 소유합니다. 입력란, 폼, 편집 영역, 비공개 대화·프로필, 이미지·영상은 추출하지 않습니다. 로그인이 필요한 자료는 담지 마세요.

1. 루트에서 `npm run build:clipper`를 실행합니다. `dist/`는 빌드 산출물이며 커밋하지 않습니다.
2. `chrome://extensions` 개발자 모드에서 `tools/chrome-clipper/dist`를 압축해제 확장으로 로드합니다.
3. 확장 ID로 Linux의 `COLLECTOR_EXTENSION_ORIGIN=chrome-extension://<ID>`를 설정합니다. `COLLECTOR_INTAKE_TOKEN`과 같은 페어링 토큰을 확장의 옵션 페이지에 입력합니다. 사이트/검토 토큰을 사용하지 않습니다.
4. 공개 페이지에서 필요한 문장을 선택하고 확장 아이콘 **이 자료 담기**를 누릅니다. 기본적으로 선택한 영역만 읽습니다. 승인된 사이트는 설정한 본문 selector를 사용합니다. 정형 라벨(브랜드:, 모델:, 구성품:, 권장소비자가:, 가격:, 공구 조건:, 설명서:, 인증:, 리콜:)에 해당하는 사실과 최대 300자의 근거만 저장합니다. 라벨이 없으면 명시적인 원화 금액 하나만 단서로 추출하고, 그것도 없으면 본문 사실 없이 원문 확인 대상으로 접수합니다.

작업기 인테이크는 `http://127.0.0.1:4318` 전용입니다. 다른 머신의 Linux에는 운영자가 SSH 로컬 포워딩을 구성합니다. 토큰은 확장 전용 저장소에만 두고 콘텐츠 스크립트나 페이지에 넘기지 않습니다. storage 접근 수준도 TRUSTED_CONTEXTS로 제한합니다.

기본 권한은 activeTab·scripting·storage·alarms 및 loopback 연결뿐입니다. 쿠키·방문 기록·전체 호스트 권한을 요구하지 않습니다. `crawler/config/collector.json`의 enabled + browser 승인 소스만 빌드 시 optional_host_permissions에 들어갑니다. 설정 변경 후 다시 빌드·로드하세요. 옵션의 자동 읽기를 켜는 사용자 동작에서 해당 호스트 권한을 요청하며, 열린 페이지의 승인된 영역만 읽습니다. 자동 읽기 기능은 기본 꺼짐이며 자체 탐색을 하지 않습니다. 철회한 권한으로는 새 추출이 실행되지 않습니다.

작업은 DOM을 읽기 전에 `clip:<clip_id>`로 영속화됩니다. 예약 응답 유실은 같은 attempt_id로 복원하고 저장된 payload는 탭이 없어도 재전송합니다. 작업기의 commit 뒤 ACK가 사라져도 기존 receipt를 조회하여 완료합니다. 서비스 워커가 다시 만들어지면 저장 항목과 작업기 상태를 대조합니다. 재시도 알람은 1분 간격입니다.

배지의 **접수**는 로컬 DB의 ACK를 확인한 상태입니다. **대기**는 연결·저장·설정 확인이 필요한 상태이며 **재클릭**은 추출 시작 후 payload가 저장되기 전에 종료되거나 문서/권한을 잃은 상태입니다.

예약 URL과 추출 직전 `location.href`의 정규화된 전체 주소를 비교합니다. `/product?id=A`에서 `/product?id=B`로 이동하거나 식별 쿼리를 추가·제거하면 본문을 읽지 않고 **재클릭**으로 종료합니다. 쿼리 키 순서, 추적 파라미터, fragment 차이는 같은 정규화 규칙으로 처리하며, 같은 키의 중복 값 순서는 유지합니다. 새 클릭만 새 문서의 예약을 만듭니다. 이미 저장된 payload는 탭 이동 후에도 원래 예약으로 복구하며 다시 읽지 않습니다. 선택 영역·탭 원문 복구는 보장하지 않습니다. 재클릭에는 새 attempt_id와 새 예산이 필요합니다. 예약은 10분/KST 자정까지만 유효하고 시작한 시도는 환급하지 않습니다. payload 접수 유예기간은 7일입니다.

단위 테스트는 Chrome API/시간/로컬 호출을 주입하고 JSON 저장 상태만 남긴 뒤 새 전달 엔진을 만듭니다. 실제 Chrome·페이지·네트워크는 테스트에서 사용하지 않습니다.

권한과 생명주기 근거: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [서비스 워커 복구](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

전달 실패는 작업별 `last_error`(HTTP 상태 코드만)와 `retry_count`로 남깁니다. 연결 오류·408·429·서버 오류는 1분부터 최대 6시간까지 지수 간격으로 재시도하고 Retry-After가 더 길면 그 시간을 따릅니다. 8회 실패 또는 403·409 등의 재시도로 해결되지 않는 응답은 자동 재시도를 멈추고 배지에 **실패**를 표시합니다. 한도·권한·정책 설정을 확인한 뒤 새로 클릭하세요. 오류 응답 원문은 저장하지 않습니다. 라벨 없는 선택 문장도 명시적인 원화 금액이 하나면 `clue_price`로만 추출하며 공식가로 승격하지 않습니다.

URL identity v2 supports only `id`, `p`, `page`, `lang`, `recallid`, `format`,
`productname`, and `title`; each occurrence must have a valid, privacy-safe value.
`product_no`, `sku` and other unknown keys reject the click before job storage.
Known tracking keys are stripped without retaining their values. The only `source`
exception is a sole `source=home` on an exact HTTPS numeric 09pangpang post URL.
Collector source/discovery configuration can restrict supported identifiers only.

Update Linux and run `npm run build:clipper`, then reload the extension together.
The extension checks identity without DOM access before starting an attempt and
checks again before extraction. Identity, binding and policy failures stop as
**재클릭**; expired delivery becomes **실패**. Only bounded fixed error codes are
stored. Saved current payloads still recover after tab navigation without another
DOM read. Unfinished legacy jobs discard payloads and require a fresh click;
exact original committed receipts can acknowledge historical jobs. Linux preserves
legacy records in quarantine, excluding automatic rechecks and dedup/evidence
reuse. A collision with such a URL requires explicit identity review; a new click
cannot upgrade it. No site execution or status-sync payload changes are involved.
