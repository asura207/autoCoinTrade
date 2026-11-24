# autoCoinTrade 전수 QA 테스트 명세서 및 점검 리포트 (`docs/QA_CHECKLIST.md`)

> **기준 베이스라인**: `v0.0.32` (Commit `ef3c75d` + 후속 기능/패치 `41dccb2` ~ `0d9613c` + Docker `/install` 전환) → **수정·재검증 완료 버전**: `v0.0.33`  
> **점검 범위**: 전체 마크다운 문서(`README.md`, `SETUP_GUIDE.md`, `howtorun.md`, `initRule.md`, `prompt.md`, `history.md`, `install/README.md`), 백엔드(`backend/node_server.mjs`, `backend/common/*.mjs`), 프론트엔드(`frontend/src/App.jsx`, `frontend/src/styles.css`, `frontend/server.mjs`), 파이썬 엔진(`main_orchestrator.py`, `bots.py`, `market_hub.py`, `llm_filter_worker.py`, `init_db.py`, `agentBot/bot_10_jack_kellogg.py`), 루트·`/install` 실행/종료/Docker 스크립트, CI(`.github/workflows/ci.yml`), 자동화 검증 스위트(`tests/*.mjs`, `tests/qa_python_verification.py`).  
> **안전 원칙**: 모든 자동화 테스트는 격리된 임시 SQLite DB(`os.tmpdir()`) 및 Mock 업비트/Ollama/Gemini HTTP 서버만 사용하며, 운영 DB(`data/auto_coin_trade.db`) 및 실계좌 API를 절대 호출하지 않습니다.

---

## 📊 6대 영역 QA 수행 결과 요약 (`v0.0.33`)

| 영역 | 점검 대상 | 총 항목 | 최초 점검 (Baseline) | 최종 점검 (수정 후) | 비고 |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **[영역 1] 멀티프로세스 동시성 및 중복 주문 방어** | `live_order_guardrail.mjs`, `node_server.mjs`, `bots.py`, `sqlite_db.mjs`, `init_db.py` | 6 | 6 PASS / 0 FAIL | **6 PASS (100%)** | `verify_duplicate_order_guard.mjs` 7대 스트레스 시나리오 + WAL/마이그레이션 통과 |
| **[영역 2] 가상 Arena(10대 봇) & 실전 매매·주간 자동 로테이션 무결성** | `algo_lab_service.mjs`, `node_server.mjs`, `bots.py`, `bot_10_jack_kellogg.py` | 9 | 8 PASS / 1 FAIL | **9 PASS (100%)** | **[BUG-01 수정]** `bots.py` Graceful Drain 레거시 DB(`global_cap_krw==0`) Zero-Sum 누락 수정 |
| **[영역 3] 듀얼 AI 게이트웨이 & 로컬 Ollama 3중 Fallback** | `node_server.mjs`, `llm_filter_worker.py`, `App.jsx` | 6 | 6 PASS / 0 FAIL | **6 PASS (100%)** | `verify_ollama_integration.mjs`, `verify_dual_ai_and_live_universe.mjs`, 절단 JSON 제어블록 복구·정제 검증 |
| **[영역 4] 시세 캐시(Rate Limit) & PostgreSQL 이중 원장 동기화** | `upbit_ws_hub.mjs`, `market_hub.py`, `pg_sync.mjs`, `execution_quality_service.mjs` | 5 | 5 PASS / 0 FAIL | **5 PASS (100%)** | `verify_upbit_ws_hub.mjs`, `verify_execution_quality_and_sizing.mjs`, `DB_MODE=sqlite` 분기 통과 |
| **[영역 5] 프론트엔드 UI/UX, React TDZ 및 SSE 스트리밍 안정성** | `frontend/src/App.jsx`, `frontend/src/styles.css`, `frontend/server.mjs` | 6 | 6 PASS / 0 FAIL | **6 PASS (100%)** | `App()` 내부 TDZ 0건, 상대경로 `"/api/..."` 100%, `vite build` 0 errors |
| **[영역 6] 루트/Docker `/install` 스크립트, CI 및 보안 격리** | `.gitignore`, `.github/workflows/ci.yml`, `start/stop_services.*`, `install/*`, `*.md` | 6 | 2 PASS / 4 FAIL | **6 PASS (100%)** | **[BUG-02~05 수정]** `--sqlite` 삭제, `/install` Docker 시크릿 `.gitignore`/CI 가드 추가, 전체 테스트 CI 연동, `v0.0.33` 동기화 |
| **합계** | **전체 플랫폼 6대 영역** | **38** | **33 PASS / 5 FAIL** | **38 PASS / 0 FAIL (100%)** | **Node 13종 + Python 7종 전수 통과 · 프론트엔드 프로덕션 빌드 0 에러** |

---

## [영역 1] 멀티프로세스 동시성 및 중복 주문 방어

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-1.1** | `LIVE_EXECUTOR_OWNER=node` 단일 실전 실행 주체 격리 | `backend/common/live_order_guardrail.mjs`, `bots.py:1030`, `main_orchestrator.py` | `PASS` | `PASS` | 불일치 엔진의 실전 주문 API 진입 즉시 하드 차단 (`verify_duplicate_order_guard.mjs`, `qa_python_verification.py` PASS). |
| **QA-1.2** | SQLite `live_executor_lease` 원자적 리스 락 (TTL 30초) | `backend/common/live_order_guardrail.mjs`, `backend/node_server.mjs` | `PASS` | `PASS` | `BEGIN IMMEDIATE` 단일 행 리스 점유/하트비트 갱신 및 좀비 프로세스 충돌 차단 검증 완료. |
| **QA-1.3** | `live_order_intents` `PENDING` 선차감 + 업비트 `identifier` 멱등성 | `backend/common/live_order_guardrail.mjs`, `backend/node_server.mjs` | `PASS` | `PASS` | 동시 5~10회 `Promise.all` Storm 시 업비트 전송 1건·원화 차감 1회, 타임아웃 정산 이중 환불 방지 통과. |
| **QA-1.4** | 프로세스 내 `(bot_id, market)` Async Mutex & 쿨다운·하드캡·비상정지 | `backend/common/live_order_guardrail.mjs`, `backend/node_server.mjs` | `PASS` | `PASS` | 재진입 900초 쿨다운, 봇 60초 간격, 시간/일일 한도, 이상 감지 비상 정지 및 수동 해제 API 검증 통과. |
| **QA-1.5** | SQLite WAL 모드 (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`) | `backend/common/sqlite_db.mjs`, `init_db.py` | `PASS` | `PASS` | 단일 경로 `data/auto_coin_trade.db`, WAL 모드 및 `withDbWriteLock` 직렬화 유지. |
| **QA-1.6** | 자동 `ALTER TABLE` 스키마 마이그레이션 및 Node↔Python 스키마 호환성 | `backend/node_server.mjs`, `init_db.py`, `backend/common/pg_sync.mjs` | `PASS` | `PASS` | `capital_restoration_logs`, `drain_handoff_logs`, `live_order_intents`, `bot_positions.buy_reason` 등 누락 없음. |

---

## [영역 2] 가상 Arena(10대 봇) & 실전 매매·주간 자동 로테이션 무결성

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-2.1** | 10대 알고리즘 봇(`bot_01`~`bot_10`) 상시 가상 Arena 가동 및 LLM/BTC 필터 100% 우회 | `backend/common/algo_lab_service.mjs`, `tests/qa_full_verification.mjs` | `PASS` | `PASS` | `HOLD_CASH`, `final_risk_alert`, `BLOCK`, BTC 20MA 하락장에서도 가상 Arena 100% 정상 체결 및 실전 원장 완전 격리. |
| **QA-2.2** | `Zero-Division` / `NaN` / `Infinity` / `curPrice <= 0` 방어 | `backend/common/algo_lab_service.mjs`, `agentBot/bot_10_jack_kellogg.py` | `PASS` | `PASS` | 평탄 RSI=50, 0거래량 RVOL=0, 파산 봇 7일 수익률 캡, `first_buy == 0` 방어 모두 검증 통과. |
| **QA-2.3** | `bot_10` Jack Kellogg (VWAP · LRC ±2σ · RVOL · 2분할 · 즉시 회전 방지) | `backend/common/algo_lab_service.mjs`, `agentBot/bot_10_jack_kellogg.py:229-237` | `PASS` | `PASS` | `rvol_breakout_live/arena`, `vwap_gap_live/arena` 파라미터 동기화 및 `<0.6%` 초박리 즉시 회전 차단 통과. |
| **QA-2.4** | 원금 구간별 주간 자동 로테이션 (1~3개 균등 배분 · 단일 90% 상한 가드) | `backend/common/algo_lab_service.mjs`, `tests/verify_capital_tier_rotation_90cap.mjs` | `PASS` | `PASS` | 원금 구간별 1~3대 선출, 균등 배분, 단일 90% 상한 불변식, 10% 예비비 보존 9대 시나리오 통과. |
| **QA-2.5** | 탈락 봇 Graceful Drain (강제 청산 금지 · 신규 매수 차단 · 정산 원화 복원 Zero-Sum) | `backend/node_server.mjs:10619-10726`, `bots.py:1949-1990` | `FAIL` | `PASS` | **[BUG-01 수정]** `bots.py`에서 `global_cap_krw == 0` & `target_capital_krw == 0`(레거시/미동기화 DB) 시 정산금이 `surplus_reserve`로 유실되어 `qa_python_verification.py::test_04` 실패 → `allocation_ratio` 비례 Zero-Sum 분배 및 `floor` 자투리 배분 폴백 복구 완료. |
| **QA-2.6** | 격리 매도 (`get_balance()` 전량 매도 금지 & `bot_id`/`order_uuid` 수량 보호) | `backend/node_server.mjs`, `bots.py:1465` | `PASS` | `PASS` | `get_balance()` 호출 0건, `/v1/accounts` 오류 시 DB 보존 및 타 봇 보유 수량 침범 차단 통과. |
| **QA-2.7** | 소수점 8자리 내림(`ROUND_DOWN` / `floorTo8DecimalsStr`) 및 `< 1 KRW` 코인 단가 정밀도 | `backend/node_server.mjs`, `bots.py` | `PASS` | `PASS` | `0.29` 정밀도 손실 없음, 과학적 표기법 배제, `0.0245` 단가 0원화 방지 통과. |
| **QA-2.8** | 최유리 지정가 미체결 취소(`cancel_order`) · 체결 정산 · 수수료 완충(`1.0005`) · 최소주문 `5,000원` | `backend/node_server.mjs`, `bots.py` | `PASS` | `PASS` | 지정가 타임아웃 취소 후 체결 수량/수수료 정산, 최소 주문금액 방어, 시장가 매도 `price: null` 복원력 통과. |
| **QA-2.9** | 백테스팅 & Walk-Forward(70/30) 엔진 Zero Look-Ahead 검증 | `backend/common/backtest_service.mjs`, `tests/verify_backtest_engine.mjs` | `PASS` | `PASS` | 미래 데이터 참조 차단, 수수료/슬리피지 반영, 10대 봇 시뮬레이션 통과. |

---

## [영역 3] 듀얼 AI 게이트웨이(Gemini Flash/Pro) & 로컬 Ollama 3중 Fallback

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-3.1** | `market_regime_filter` `bot_01`~`bot_10` 개별 제어(`ALLOW`/`BLOCK`) | `backend/node_server.mjs`, `llm_filter_worker.py` | `PASS` | `PASS` | 10대 봇 표준 ID 매핑, 전 봇 `BLOCK` 시 역추세/그리드(`bot_05/06/08/10`) 0.5x 보정 가드, BEAR 감성부호 보정 통과. |
| **QA-3.2** | `BLOCK` / `final_risk_alert = 1` 시 보유 포지션 매도 루프 비차단 | `backend/node_server.mjs`, `bots.py` | `PASS` | `PASS` | 매도 청산 평가가 AI 게이트웨이 검사 이전에 독립 수행되어 손절/익절 정상 작동. |
| **QA-3.3** | 로컬 Ollama(`qwen3-news`) ➔ Gemini Flash ➔ BTC 20MA 3중 무중단 Fallback | `backend/node_server.mjs`, `llm_filter_worker.py`, `tests/verify_ollama_integration.mjs` | `PASS` | `PASS` | Ollama 타임아웃/장애 시 지수 백오프 Gemini Flash → BTC 20MA 기계적 안전 모드 전환 검증 통과. |
| **QA-3.4** | Ollama 단독 운용 시 Sticky `BLOCK` 해제 및 BTC 0원 Fail-Safe | `tests/qa_full_verification.mjs`, `tests/verify_dual_ai_and_live_universe.mjs` | `PASS` | `PASS` | Gemini 미설정 환경 정상 복구 및 BTC 시세 수신 불가 시 `SIDEWAYS/0.5x` Fail-Safe 통과. |
| **QA-3.5** | LLM 토큰 절단/미완성 제어 JSON 블록 복구 및 브리핑 마크다운 정제 | `backend/node_server.mjs:785-888`, `frontend/src/App.jsx:1097-1152` | `PASS` | `PASS` | `parsePartialRegimeJson` / `stripControlJsonFromBriefingText` / `sanitizeBriefingMarkdown`로 원시 제어 JSON 노출 차단 및 핵심 필드 복구. |
| **QA-3.6** | Python `risk_alert: "false"` 문자열 오판 방지 및 Gemini 429 쿨다운 루프 해소 | `llm_filter_worker.py`, `tests/qa_python_verification.py`, `tests/verify_dual_ai_and_live_universe.mjs` | `PASS` | `PASS` | `_parse_bool_flag` 및 429 쿨다운 분리 정상 검증. |

---

## [영역 4] 시세 캐시(Rate Limit) & PostgreSQL 이중 원장 동기화

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-4.1** | `upbit_ws_hub.mjs` 실시간 WebSocket 스트림 & `>5,000ms` REST 자동 폴백 | `backend/common/upbit_ws_hub.mjs`, `tests/verify_upbit_ws_hub.mjs` | `PASS` | `PASS` | 60초 PING, 지수 백오프 재연결, 틱 반응형 즉시 청산(`1,500ms` 디바운스) 통과. |
| **QA-4.2** | `market_hub.py` / `node_server.mjs` `120ms` Rate Limit & HTTP 429 지수 백오프 | `market_hub.py`, `backend/node_server.mjs` | `PASS` | `PASS` | 퍼블릭 API 호출 쓰로틀링 및 429/503 백오프 유지. |
| **QA-4.3** | 호가창(OBI) · 스프레드 가드 · REST 폴백 · ATR 역가중 사이징 & 슬리피지 원장 | `backend/common/execution_quality_service.mjs`, `tests/verify_execution_quality_and_sizing.mjs` | `PASS` | `PASS` | 스프레드/OBI 차단, 호가 REST 폴백, 최소 주문 `5,250원` 하한 보장, `slippage_bps` 기록 통과. |
| **QA-4.4** | `pg_sync.mjs` PostgreSQL UPSERT 동기화 및 `DB_MODE=sqlite` 단독 분기 | `backend/common/pg_sync.mjs`, `init_db.py` | `PASS` | `PASS` | `DB_MODE=sqlite` / `PG_SYNC_ENABLED=false` 시 무에러 스킵, PG UPSERT 및 `ON CONFLICT` 구문 호환 유지. |
| **QA-4.5** | AES-256-GCM 암호화 볼트 & 멀티채널 알림 허브(예제 플레이스홀더 차단) | `backend/common/crypto_vault.mjs`, `backend/common/notification_hub.mjs` | `PASS` | `PASS` | `verify_crypto_vault.mjs` & `verify_notification_hub_and_journal.mjs` 전수 통과. |

---

## [영역 5] 프론트엔드 UI/UX, React TDZ 및 SSE 스트리밍 안정성

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-5.1** | React TDZ(Temporal Dead Zone) 방어 — `App()` 내 모든 `useEffect` 참조 심볼 상단 선언 | `frontend/src/App.jsx:1437-4650` | `PASS` | `PASS` | AST/정규식 정적 전수 검사 결과 `App()` 내부 TDZ 위반 0건 확인. |
| **QA-5.2** | API 및 SSE 호출 상대 경로(`"/api/..."`) 준수 (하드코딩 `localhost:8001` 0건) | `frontend/src/App.jsx` | `PASS` | `PASS` | `localhost:8001` / `127.0.0.1:8001` 하드코딩 0건, 전 호출 상대경로 사용. |
| **QA-5.3** | SSE 스트리밍 클린업 & 미완성 JSON 제어 블록 마스킹 | `frontend/src/App.jsx:1097-1152` | `PASS` | `PASS` | `AbortController` 클린업 및 스트리밍 중 제어 JSON 수신 안내 문구 표출 정상. |
| **QA-5.4** | 기본 입장 코드(`stock`/`ㄴ새차`) · 통계 기준일(`2026.10.01`) · 한국식 손익 색상(`#ef4444`/`#3b82f6`) | `frontend/src/App.jsx`, `tests/qa_full_verification.mjs` | `PASS` | `PASS` | 인증 게이트, 기준일 `2026.10.01` 6개 지점, 빨강(`#ef4444`)/파랑(`#3b82f6`) 표준 색상 일치. |
| **QA-5.5** | 뉴스 테이블 `48px` 행 높이 고정 및 50건 페이징 | `frontend/src/styles.css`, `frontend/src/App.jsx` | `PASS` | `PASS` | `height: 48px; max-height: 48px; line-height: 48px;` 유지 및 1줄 말줄임 적용. |
| **QA-5.6** | 프로덕션 정적 서버(`frontend/server.mjs`) & Vite 프로덕션 빌드 (`npm run build`) | `frontend/server.mjs`, `frontend/dist/` | `PASS` | `PASS` | `vite build` 0 errors, 번들 정상 생성 (`571ms`). |

---

## [영역 6] 루트 실행/종료 스크립트, `/install` Docker 패키지, CI 및 보안 격리

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-6.1** | 루트/스크립트/`/install` Bash 구문 검증 (`bash -n`) | `*.sh`, `scripts/*.sh`, `install/*.sh` | `PASS` | `PASS` | `start_services.sh`(`./` 분리 경로 오폭 방지), `stop_services.sh`, `install/AutoCoinTrade_*.sh` 전체 문법 0 에러. |
| **QA-6.2** | 작업 트리 미추적 임시 파일(`--sqlite`) 제거 | repo root | `FAIL` | `PASS` | **[BUG-02 수정]** 루트에 잔존하던 0바이트 오타 파일 `--sqlite` 삭제 완료. |
| **QA-6.3** | Docker `/install` 런타임 민감 파일 Git 제외 (`.gitignore`) | `.gitignore:19-25, 51-62` | `FAIL` | `PASS` | **[BUG-03 수정]** 신규 Docker `/install` 스택이 생성하는 `install/.env`, `install/config/upbit_config.json`, `install/data/*.db*`, `install/data/.session_secret`, `install/data/.vault_master_key`를 `.gitignore`에 추가. |
| **QA-6.4** | GitHub Actions CI 시크릿 가드 & 전체 테스트 스위트 실행 | `.github/workflows/ci.yml:50, 74`, `package.json:31-33` | `FAIL` | `PASS` | **[BUG-04 수정]** CI 시크릿 가드에 `install/.env`, `install/config/upbit_config.json` 추가 및 `verify_duplicate_order_guard.mjs`, `verify_dual_ai_and_live_universe.mjs`, `verify_capital_tier_rotation_90cap.mjs`를 `npm run test:enhancements` 및 CI에 편입. |
| **QA-6.5** | `/install/app` 동기화 스크립트 (`scripts/build_install_package.sh`) | `scripts/build_install_package.sh`, `install/Dockerfile` | `PASS` | `PASS` | `build_install_package.sh` 재실행으로 `bots.py` 수정본 및 `v0.0.33` 메타데이터 `/install/app` 완전 동기화. |
| **QA-6.6** | 버전 관리 정책(`0.0.X`) 및 문서·코드 일괄 동기화 | `package.json`, `frontend/package.json`, `node_server.mjs`, `App.jsx`, `README.md`, `history.md` | `FAIL` | `PASS` | **[BUG-05 수정]** 전 파일 `v0.0.33` 일괄 동기화 및 `docs/ENHANCEMENT_PROMPTS.md` 차세대 P1~P3 프롬프트 현행화. |

---

## 🧪 자동화 QA 검증 스위트 실행 목록 (전수 14개 스위트 PASS)

- **Core Suite (`npm test`)**:
  - `tests/verify_rotation_drain_edge_cases.mjs`
  - `tests/verify_all_bots_and_execution.mjs`
  - `tests/verify_log_rotation.mjs`
  - `tests/verify_ollama_integration.mjs`
  - `tests/qa_full_verification.mjs`
- **Enhancement & Safety Suite (`npm run test:enhancements`)**:
  - `tests/verify_upbit_ws_hub.mjs`
  - `tests/verify_backtest_engine.mjs`
  - `tests/verify_execution_quality_and_sizing.mjs`
  - `tests/verify_notification_hub_and_journal.mjs`
  - `tests/verify_crypto_vault.mjs`
  - `tests/verify_duplicate_order_guard.mjs`
  - `tests/verify_dual_ai_and_live_universe.mjs`
  - `tests/verify_capital_tier_rotation_90cap.mjs`
- **Python Verification Suite (`npm run test:py`)**:
  - `tests/qa_python_verification.py` (7/7 tests PASS)
