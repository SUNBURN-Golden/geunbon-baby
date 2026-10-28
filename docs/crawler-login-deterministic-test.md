# crawler-login 캡처 테스트 수정·검증 기록 (PR 설명 인계용)

- [x] 범위: Linux 로그인 캡처 테스트 5개만 분리. 제품 코드·사이트·DB·큐 변경 없음. 기준 main `cdf152947395a9b94b4a1337e4fb3577d26fa704`, 작업 HEAD `1b77dbcc9bfd3d650a318f3969010f38fe89971e`; 해당 로그인·fixture·browser·session·health 파일은 main과 동일했다.
- [x] 환경: 2026-10-29, Linux 6.12.94+ x86_64, CPU 8개, npm 스크립트의 Node 22.22.3, npm 11.21.1, Vitest 4.1.12. 각 회차는 새 프로세스이며 네트워크·브라우저 실행은 기존 setup에서 차단했다.
- [x] 기준본: 브랜치 전환 없이 `git archive main package.json vitest.config.ts tests/setup.ts tests/crawler-login.test.ts tests/helpers crawler/lib crawler/config`를 저장소 밖 임시 디렉터리에 풀고 현재 설치된 node_modules를 연결했다.
- [x] 기준 명령: 기준본에서 `npm test -- tests/crawler-login.test.ts -t 'a recover surface during session capture' --no-cache --configLoader runner`를 조건별 50회 실행했다. 평상시는 추가 인위 부하 없음; 공유 호스트이므로 다른 작업의 부하는 통제하지 않았다.
- [x] 부하: 측정 전체 동안 Python CPU 루프 `while True: sum(i*i for i in range(10000))` 2개와 별도 임시 파일에 256 KiB 쓰기→flush→fsync→seek→읽기를 반복하는 I/O 프로세스 1개를 실행하고 종료했다. 세션·수집 데이터는 사용하지 않았다.
- [x] 기준 결과: 평상시 48/50 통과(8·41회 실패), 부하 49/50 통과(9회 실패). 모두 기존 441행 `expect(completed).toBe(true)`에서 false. 실제 파일 I/O와 가짜 타이머를 섞은 100회 반복은 I/O 완료 후 등록되는 타이머까지 처리한다는 보장이 없다.
- [x] 수정: `tests/crawler-login-capture.test.ts`와 `tests/helpers/login-capture-io.ts`에서 실제 ensureLogin·saveSession·health를 실행하고 파일·디렉터리만 메모리 SQLite로 대체했다. 고정 시계와 close/unlink Promise 경계로 순서를 제어하며 실제 파일 읽기 양보와 100회 폴링을 제거했다.
- [x] 수용 기준: 첫 snapshot 폐기, 재검증 전 기존 세션 유지, 재캡처 뒤에만 rename, capture 2회·session_reused 1회·임시 파일 없음. 나머지 4개 오류 사유·capture 1회·성공 이벤트 없음·120_005ms timeout·비밀값 비노출 단언을 유지했다. skip/only/retry·타임아웃 증가·기대값 약화 없음.
- [x] 수정 반복: `npm test -- tests/crawler-login-capture.test.ts --no-cache --configLoader runner`를 같은 조건별 50회 실행해 평상시 50/50, 부하 50/50 통과했다(회차마다 5개, 총 500개 시나리오 통과).
- [x] 최종: 전체 테스트 111파일·1,826개, lint·typecheck(`--incremental false`)·build 통과. 읽기 전용 소스와 TMPDIR(디렉터리 0555·파일 0444)에서도 핵심 5/5 통과: `npm test -- tests/crawler-login-capture.test.ts --no-cache --configLoader runner --pool threads`. 기본 forks는 캐시 비활성화 시에도 변환 임시 파일을 쓰므로 읽기 전용 재현에는 threads가 필요하다.
