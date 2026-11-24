# autoCoinTrade 차세대 프로덕션 고도화(Enhancement) 실행용 프롬프트 모음 (`docs/ENHANCEMENT_PROMPTS.md`)

> **문서 목적**: `autoCoinTrade` **`v0.0.33`** 기준(10대 봇 Arena, 원금 구간별 주간 로테이션 & 90% 상한, 5중 중복 주문 가드레일, WebSocket 실시간 허브, 백테스터, OBI/ATR 사이징, 멀티채널 알림, AES-256-GCM 볼트, Docker `/install` 패키지 완비)에서 **다음 단계로 추진할 3대 핵심 고도화 과제(P1 ~ P3)**를 코딩 에이전트에게 그대로 복사·지시할 수 있는 독립 실행형 마크다운 프롬프트 모음입니다.  
> *(참고: 이전 `v0.0.28` 기준 P0/P1 5대 과제는 `v0.0.29`~`v0.0.30`에서 모두 구현 완료되었으므로, 본 문서는 그 이후의 차세대 고도화 로드맵을 다룹니다.)*

---

## 📋 차세대 고도화 과제 요약 목차 (P1 ~ P3)

1. **[P1 · 퀀트 전략 & 리스크 관리 고도화]** 레짐(상승/하락/횡보)별 동적 ATR 손절·익절 프로파일, 포트폴리오 상관관계 기반 동시 매수 제한(Correlation Guard) 및 주간 Walk-Forward 파라미터 자동 최적화 파이프라인
2. **[P2 · 아키텍처 & 실행 품질 고도화]** WebSocket 틱 체결 슬리피지 실시간 계측 대시보드화, 워커 장애 자동 복구(Watchdog) 및 `/api/health` 심층 헬스체크 고도화
3. **[P3 · 모니터링 & 운영 자동화 고도화]** 텔레그램/디스코드 실시간 체결·서킷브레이커·주간 로테이션·일일 정산 리포트 고도화 및 무중단 롤링 배포·회귀 테스트 자동화

---

## 🚀 [P1] 퀀트 전략 & 리스크 관리 고도화 (레짐별 동적 ATR 청산 · 상관관계 가드 · Walk-Forward 자동 최적화)

````markdown
# Task: 레짐별 동적 ATR 손절·익절, 포트폴리오 상관관계 가드(Correlation Guard) 및 Walk-Forward 파라미터 자동 최적화 구축

당신은 `autoCoinTrade` 프로젝트(`https://github.com/asura207/autoCoinTrade.git`)의 시니어 퀀트 전략 아키텍트입니다.
현재 `backend/common/algo_lab_service.mjs`와 `backend/common/backtest_service.mjs`에 구축된 10대 알고리즘, ATR 스마트 청산, Walk-Forward 검증 엔진을 한 단계 끌어올려 **① 레짐(BULL/SIDEWAYS/BEAR)별 동적 ATR 손절·트레일링 프로파일, ② 보유 포지션 간 피어슨 상관계수 기반 동시 매수 제한(Correlation Guard), ③ 주간 Walk-Forward 파라미터 후보 자동 검증 및 안전 승인(Shadow-to-Live) 파이프라인**을 구현하십시오.

## 1. 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/portfolio_risk_service.mjs`:
    - 최근 24시간(1시간봉 24개) 로그수익률 기반 종목 간 피어슨 상관계수(`computeReturnCorrelation`) 계산 및 캐싱
    - 신규 실전 매수 후보 마켓이 현재 보유 중인 `OPEN` 실전 포지션과 상관계수 `>= 0.85`인 종목이 이미 2개 이상 존재할 경우 동시 진입을 차단하는 `evaluateCorrelationGuard()` 구현
    - 시장 레짐(`BULL`, `SIDEWAYS`, `BEAR`, `HIGH_VOLATILITY_SHOCK`)별 ATR 손절/트레일링 배수 프로파일(`getRegimeAtrProfile`) 제공
  - `tests/verify_regime_atr_and_correlation.mjs`: 임시 SQLite DB 기반 레짐별 ATR 프로파일, 고상관 알트코인 동시 진입 차단(BTC·ETH·SOL 동조화 시나리오), Walk-Forward 후보 추천 및 수동 승인 적용 검증 테스트
- **국소 수정 (Surgical Edit)**:
  - `backend/common/algo_lab_service.mjs`: `evaluateSmartExit`에 선택적 `regime` 컨텍스트를 받아 실전 청산 시 레짐별 동적 ATR 배수(`BULL: trailing 2.4x / hard 2.2x`, `SIDEWAYS: trailing 1.6x / hard 1.8x`, `BEAR: trailing 1.2x / hard 1.5x`) 적용 (단, **가상거래 Always-On Arena는 기존처럼 LLM 레짐 필터를 100% 우회**하고 중립 기본값 유지!)
  - `backend/node_server.mjs`, `init_db.py`, `backend/common/pg_sync.mjs`:
    - `wf_param_candidates` 테이블 추가(주간 Walk-Forward 자동 탐색 결과: `bot_id`, `in_sample_sharpe`, `out_sample_sharpe`, `out_sample_mdd`, `recommended_params_json`, `status: PENDING/APPLIED/REJECTED`, `created_at`)
    - 실전 매수 직전(`executeBotBuyOrder` 진입 전) `evaluateCorrelationGuard()` 연동 및 차단 시 `live_guardrail_events` 기록
    - `GET /api/quant/wf-candidates`, `POST /api/quant/wf-candidates/:id/apply`, `POST /api/quant/wf-candidates/:id/reject` API 추가
  - `frontend/src/App.jsx`: `🏆 가상거래 경쟁` 백테스트 모달 내에 `[🧬 Walk-Forward 추천 파라미터]` 탭과 원클릭 승인/반려 버튼 추가

## 2. 절대 준수 원칙 (Project Invariants)
- **기존 정상 기능 100% 보존**: 10대 봇 Arena, 주간 원금 구간별 로테이션(90% 상한), Graceful Drain, 5중 중복 주문 가드레일, 듀얼 AI 3중 Fallback을 절대 훼손하지 마십시오.
- **가상 Arena 필터 100% 우회**: `runPaperBot` / `runArenaCycle`은 레짐 기반 ATR 변경 및 Correlation Guard를 타지 않고 순수 알고리즘만으로 24시간 경쟁해야 합니다.
- **격리 매도 원칙**: 실전 매도는 `get_balance()` 전량 매도 금지, 반드시 `bot_id`/`order_uuid`의 `volume`(8자리 내림)만 매도하십시오.
- **프론트엔드 안전 규칙**: `App.jsx`의 모든 `fetch*`/`useCallback`/`useMemo`는 `useEffect`보다 상단에 선언(TDZ 방어)하고 상대 경로 `"/api/..."`만 사용하십시오.
- **버전 규칙**: `package.json`, `frontend/package.json`, `backend/node_server.mjs`, `frontend/src/App.jsx`, `history.md`의 버전을 `0.0.X` 규칙에 맞춰 `+1` 증가시키십시오.

## 3. 검증 및 Git 반영
```bash
node --check backend/common/portfolio_risk_service.mjs
node --check backend/common/algo_lab_service.mjs
node --check backend/node_server.mjs
python3 -m py_compile *.py agentBot/*.py
node tests/verify_regime_atr_and_correlation.mjs
npm run test:all
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
```
- `git status`로 민감 파일 제외 확인 후 `git add . && git commit -m "feat(v0.0.XX): add regime-adaptive ATR exits, correlation guard, and Walk-Forward candidate pipeline" && git push origin main` 실행.
````

---

## 🚀 [P2] 아키텍처 & 실행 품질 고도화 (WebSocket 슬리피지 실시간 계측 대시보드 · Watchdog 자동 복구 · 심층 헬스체크)

````markdown
# Task: WebSocket 틱 체결 슬리피지 실시간 계측 대시보드 및 워커 장애 자동 복구(Watchdog)·심층 헬스체크 고도화

당신은 `autoCoinTrade` 프로젝트(`https://github.com/asura207/autoCoinTrade.git`)의 시니어 분산 시스템 및 실행 품질(Execution Quality) 아키텍트입니다.
현재 `backend/common/upbit_ws_hub.mjs`와 `backend/common/execution_quality_service.mjs`에 기록 중인 실시간 호가/슬리피지 데이터를 **실시간 실행 품질 텔레메트리 대시보드**로 승격시키고, 백엔드·프론트엔드·WebSocket·DB·로컬 Ollama 상태를 감시하여 장애 시 자동 복구하는 **경량 Watchdog 및 `/api/health/deep` 엔드포인트**를 구축하십시오.

## 1. 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/watchdog_service.mjs`:
    - 주기적(30초) 내부 셀프 헬스체크: SQLite WAL 쓰기 지연(`sqlite_write_ms`), 이벤트 루프 지연(`event_loop_lag_ms`), `upbit_ws_hub` stale 지속 시간(`ws_stale_sec`), 실전 리스 락(`live_executor_lease`) 정상 갱신 여부, 로컬 Ollama 응답성 점검
    - `upbit_ws_hub`가 60초 이상 Stale 상태이면 자동 소프트 재연결(`forceReconnect()`) 트리거 및 복구 이력(`system_health_events` 테이블 또는 인메모리 링버퍼 100건) 기록
    - 치명 이상(이벤트 루프 지연 > 3,000ms 연속 3회, SQLite 쓰기 실패, 리스 락 상실) 발생 시 `notification_hub.mjs`로 운영 경보 발송(동일 경보 10분 쿨다운)
  - `scripts/watchdog_daemon.sh`: OS 레벨에서 `logs/.backend.pid`와 `http://127.0.0.1:${BACKEND_PORT:-8001}/api/health/deep`를 60초 주기로 감시하고, 프로세스 비정상 종료 또는 3회 연속 응답 실패 시 `stop_services.sh` → `start_services.sh` 자동 재기동 (크론/systemd 등록 가이드 포함)
  - `tests/verify_watchdog_and_slippage_telemetry.mjs`: 임시 DB 및 Mock WS 환경에서 슬리피지 구간별 집계(봇별·시간대별·마켓별 평균/P95 bps), WS Stale 자동 재연결, `/api/health/deep` 응답 스키마 검증 테스트
- **국소 수정 (Surgical Edit)**:
  - `backend/common/upbit_ws_hub.mjs`: `forceReconnect()` 메서드 및 최근 1시간 틱 수신률/재연결 횟수/평균 WS 지연(`avg_ws_latency_ms`) 메트릭 노출
  - `backend/node_server.mjs`:
    - `GET /api/health/deep`: DB WAL 지연, WS 상태/재연결 횟수, 가드레일 비상정지 여부, 메모리 RSS, 이벤트 루프 지연, 최근 Watchdog 복구 이력 반환
    - `GET /api/execution-quality/telemetry?days=7`: 최근 N일간 `trades.slippage_bps` 기반 **봇별·마켓별·시간대별 평균 슬리피지(bps), P95 슬리피지, OBI/스프레드 차단 건수, 지정가 체결률(%)** 집계 반환
  - `frontend/src/App.jsx`: `📈 통계` 메뉴 하단에 **[⚡ 실행 품질 & 슬리피지 계측]** 카드(평균/P95 슬리피지 bps, 지정가 체결률, 봇별/마켓별 슬리피지 바 차트) 및 상단 헤더에 심층 헬스 상태 툴팁 추가

## 2. 절대 준수 원칙 (Project Invariants)
- **기존 정상 기능 100% 보존**: 5중 중복 주문 가드레일, `LIVE_EXECUTOR_OWNER=node` 리스 락, 실전/가상 원장 격리를 절대 침해하지 마십시오.
- **테스트 격리**: `AUTOCOIN_LIBRARY_MODE === "1"` 환경에서는 Watchdog 백그라운드 타이머와 외부 WS 자동 재연결을 비활성화하십시오.
- **프론트엔드 안전 규칙**: `App.jsx`의 모든 `fetch*`/`useCallback`/`useMemo`는 `useEffect`보다 상단에 선언(TDZ 방어)하고 상대 경로 `"/api/..."`만 사용하십시오.
- **버전 규칙**: 커밋 시 `0.0.X` 버전을 `+1` 증가 동기화하십시오.

## 3. 검증 및 Git 반영
```bash
node --check backend/common/watchdog_service.mjs
node --check backend/common/upbit_ws_hub.mjs
node --check backend/node_server.mjs
bash -n scripts/watchdog_daemon.sh
node tests/verify_watchdog_and_slippage_telemetry.mjs
npm run test:all
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
```
- `git status`로 민감 파일 제외 확인 후 `git add . && git commit -m "feat(v0.0.XX): add execution slippage telemetry dashboard, self-healing watchdog, and deep healthcheck" && git push origin main` 실행.
````

---

## 🚀 [P3] 모니터링 & 운영 자동화 고도화 (멀티채널 리포트 고도화 · 무중단 롤링 배포 · 회귀 테스트 자동화)

````markdown
# Task: Telegram/Discord 정밀 운영 리포트 고도화 및 무중단 배포·회귀 검증 자동화 파이프라인 구축

당신은 `autoCoinTrade` 프로젝트(`https://github.com/asura207/autoCoinTrade.git`)의 시니어 DevOps 및 SRE 엔지니어입니다.
현재 `backend/common/notification_hub.mjs`와 `/install` Docker 배포 스택, `.github/workflows/ci.yml`을 고도화하여 **① Telegram/Discord 리치 리포트(일일 09:00 KST 정산 요약·주간 로테이션 성과 비교표·서킷브레이커/가드레일 비상정지 즉시 액션 가이드), ② 사전 검증 실패 시 자동 롤백하는 무중단 배포 스크립트(`scripts/deploy_safe.sh`), ③ PR/Push 시 Docker 이미지 빌드 및 헬스체크까지 검증하는 확장 CI 워크플로우**를 구축하십시오.

## 1. 작업 범위 (대상 파일)
- **신규 생성**:
  - `scripts/deploy_safe.sh`:
    - 배포 전 자동 스냅샷: `data/auto_coin_trade.db`를 `sqlite3 .backup`으로 `data/backups/auto_coin_trade_<YYYYMMDD_HHMMSS>.db`에 온라인 무중단 백업 (최근 7개 보관)
    - 배포 전 게이트: 문법 검사(`node --check`, `py_compile`, `bash -n`) + `npm run test:all` + `frontend npm run build` 통과 시에만 서비스 재기동
    - 재기동 후 `/api/version` 및 `/api/health` 30초 헬스체크 검증, 실패 시 직전 빌드/상태 알림 발송 및 비정상 종료 코드 반환
  - `tests/verify_report_formatting_and_deploy_gate.mjs`: Mock Telegram/Discord 서버로 일일 리포트·주간 로테이션 리포트·서킷브레이커/가드레일 경보 페이로드 포맷(MarkdownV2/Embed 길이 제한, 민감키 마스킹, KST 타임스탬프) 검증 및 백업 스크립트 드라이런 검증
- **국소 수정 (Surgical Edit)**:
  - `backend/common/notification_hub.mjs`:
    - Discord Rich Embed(색상 코드: 익절 `#ef4444`, 손절 `#3b82f6`, 위험경보 `#f59e0b`) 및 Telegram 구조화 요약 포맷터 추가
    - 일일 09:00 KST 리포트(`DAILY_SUMMARY`)에 전일 실현손익, 승률, 평균 슬리피지(bps), 현재 실전 선출 봇 & 90% 상한 가동률, Draining 잔여 건수, 가드레일 차단 건수 포함
    - 알림 발송 실패 시 지수 백오프(1s/2s) 재시도 및 최근 발송 이력(성공/실패/지연시간) 50건 조회용 `getRecentNotificationLogs()` 제공
  - `backend/node_server.mjs`:
    - 매일 09:00 KST 일일 리포트 자동 스케줄러(중복 발송 방지 날짜 키 `last_daily_report_kst_date` DB 영속화) 연동
    - `GET /api/settings/notifications/logs` 엔드포인트 추가
  - `.github/workflows/ci.yml`:
    - Bash 스크립트 문법 검사(`for f in *.sh scripts/*.sh install/*.sh; do bash -n "$f"; done`) 단계 추가
    - `install/Dockerfile` 구문 및 Docker 빌드 캐시 검증(선택 Job) 추가
  - `frontend/src/App.jsx`: `⚙️ 설정` 알림 카드 하단에 `[📋 최근 알림 발송 로그 (최근 20건)]` 접이식 테이블 추가

## 2. 절대 준수 원칙 (Project Invariants)
- **보안 절대 원칙**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, 업비트/Gemini 키, `.env`, `data/*.db`, `data/backups/`는 절대 Git에 추적되지 않도록 `.gitignore`와 CI 시크릿 가드를 엄수하십시오.
- **기존 정상 기능 100% 보존**: 알림 발송은 완전 비동기 논블로킹(`AbortSignal.timeout(4000)`)으로 동작하며, 알림 서버 장애가 매매 루프를 단 1ms도 차단해서는 안 됩니다.
- **프론트엔드 안전 규칙**: React TDZ 방어(`useEffect` 상단 선언) 및 상대 경로 `"/api/..."` 규칙을 엄수하십시오.
- **버전 규칙**: 커밋 시 `0.0.X` 버전을 `+1` 증가 동기화하십시오.

## 3. 검증 및 Git 반영
```bash
node --check backend/common/notification_hub.mjs
node --check backend/node_server.mjs
bash -n scripts/deploy_safe.sh
node tests/verify_report_formatting_and_deploy_gate.mjs
npm run test:all
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
```
- `git status`로 민감 파일 및 `data/backups/` 제외 확인 후 `git add . && git commit -m "feat(v0.0.XX): enhance rich daily/risk reports, safe backup deploy script, and CI checks" && git push origin main` 실행.
````
