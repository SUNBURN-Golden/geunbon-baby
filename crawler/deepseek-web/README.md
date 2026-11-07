# DeepSeek 공개 웹 전용 수집기 (아가마중)

Instagram·Threads **로그인/팔로/스크래핑 없음**. 기존 `PoliteFetcher`(robots·호스트 deny·속도 제한)만 사용하고, DeepSeek API(`DEEPSEEK_API_KEY`, 모델 `DEEPSEEK_MODEL`)로 공개 HTML에서 공구·가격 필드를 추출한다. 키는 박스 환경변수에만 둔다.

## 범위

- 유모차, 트립트랩/하이체어, 카시트, 플레이짐·모빌(예: 하베브릭스), 아기띠(예: 아티포페)
- 미확인 가격은 `"정보 없음"` (발명 금지)
- 파서 수정은 **제안 JSON만** `proposals/`에 기록 (`self_edit: false`). `crawler/lib/external/*` 및 규칙 파서는 런타임이 수정하지 않는다.

## 상태·출력

기본 디렉터리: `DEEPSEEK_WEB_STATE_DIR` 또는 `.local/deepseek-web/`

| 파일 | 설명 |
|------|------|
| `memory.json` | plan/act/observe/remember 메모리 |
| `review-queue.jsonl` | `pending` 검수 큐 |
| `heartbeat.json` | 최신 하트비트 |
| `validation-artifact.json` | 활성화 검증용 스냅샷 |
| `proposals/*.json` | 파서 수정 제안 |

**`once`·`daemon`은 `COLLECTOR_DB` 필수**(없거나 열 수 없으면 `collector_db_required` / `collector_db_unavailable`). 열리면 `domain_state`를 읽어 **전역 `domain_stopped`가 하나라도 있으면 즉시 실패**하고, 호스트별 stopped는 해당 URL만 건너뜁니다(`dry-run`+주입 store로 오프라인 검증).

## PM2 (Linux, 부모 런타임 활성화)

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
# 박스에서: export DEEPSEEK_API_KEY=...  (이 README/저장소에 넣지 말 것)
# 선택: export DEEPSEEK_MODEL=deepseek-chat
# 필수(once/daemon): export COLLECTOR_DB=/path/to/collector.sqlite

pm2 start crawler/deepseek-web.ecosystem.config.cjs
pm2 pid agamajung-deepseek-web          # 실제 PID 확인
pm2 logs agamajung-deepseek-web --lines 20

# 1회 오프라인 검증 (네트워크·API 없음)
DEEPSEEK_API_KEY=mock npm run deepseek-web -- dry-run

# 1회 실제 실행 (공개 GET + API — 운영자만)
# DEEPSEEK_API_KEY는 박스에만 설정
npm run deepseek-web -- once https://www.stokke.com/KOR/ko-kr/

# 중지
pm2 stop agamajung-deepseek-web

# 롤백(등록 해제)
pm2 delete agamajung-deepseek-web
```

출력 카운트·하트비트 freshness 확인:

```sh
cat .local/deepseek-web/validation-artifact.json
cat .local/deepseek-web/heartbeat.json
```

## 테스트

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm test -- tests/deepseek-web-guards.test.ts tests/deepseek-web-extract.test.ts tests/deepseek-web-runner.test.ts tests/deepseek-web-cli.test.ts
```

## 원격 브랜치 `dev-daemon/45-deepseek-web-harness-*`

GitHub에 해당 브랜치 아티팩트는 없었다. 본 패키지는 `main`의 공개 페치·검증 규칙을 재사용해 최소 복구 구현이다. dev-daemon `VERDICT` 파싱 이슈는 `tools/dev-daemon/stages.ts`의 기존 수정(#81)을 그대로 사용한다.
