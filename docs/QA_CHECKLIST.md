# autoCoinTrade 전수 QA 테스트 명세서 및 점검 리포트 (`docs/QA_CHECKLIST.md`)

> **기준 베이스라인**: `v0.0.27` (Commit `d2f60e1`) → **수정·재검증 완료 버전**: `v0.0.28`  
> **점검 범위**: 전체 마크다운 문서(`*.md`), 백엔드(`backend/node_server.mjs`, `backend/common/*.mjs`), 프론트엔드(`frontend/src/App.jsx`, `styles.css`, `server.mjs`), 파이썬 엔진(`main_orchestrator.py`, `bots.py`, `market_hub.py`, `llm_filter_worker.py`, `init_db.py`, `agentBot/bot_10_jack_kellogg.py`), 루트·`/install` 실행/종료 스크립트, 자동화 검증 스위트(`tests/*.mjs`, `tests/qa_full_verification.mjs`, `tests/qa_python_verification.py`).  
> **안전 원칙**: 모든 자동화 테스트는 격리된 임시 SQLite DB(`os.tmpdir()`) 및 Mock 업비트/Ollama/Gemini HTTP 서버만 사용하며, 운영 DB(`data/auto_coin_trade.db`) 및 실계좌 API를 절대 호출하지 않습니다.

---

## 📊 6대 영역 QA 수행 결과 요약

| 영역 | 점검 대상 | 총 항목 | 최초 점검 (Baseline) | 최종 점검 (수정 후) | 비고 |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **1. 매매 엔진 · 원장 격리 · 주문 정밀도** | `node_server.mjs`, `algo_lab_service.mjs`, `bots.py`, `bot_10_jack_kellogg.py` | 11 | 2 PASS / 8 FAIL / 1 WARN | **11 PASS (100%)** | `tests/qa_full_verification.mjs`, `tests/qa_python_verification.py`, `tests/verify_all_bots_and_execution.mjs` 검증 완료 |
| **2. 주간 전략군 TOP 1 자동 로테이션 & Graceful Drain** | `algo_lab_service.mjs`, `node_server.mjs`, `bots.py`, `init_db.py` | 7 | 2 PASS / 4 FAIL / 1 WARN | **7 PASS (100%)** | `tests/verify_rotation_drain_edge_cases.mjs` + `tests/qa_full_verification.mjs` 검증 완료 |
| **3. 듀얼 AI 게이트웨이 (Ollama · Gemini · BTC 20MA 3중 Fallback)** | `node_server.mjs`, `llm_filter_worker.py`, `init_db.py` | 7 | 3 PASS / 3 FAIL / 1 WARN | **7 PASS (100%)** | `tests/verify_ollama_integration.mjs` + `tests/qa_full_verification.mjs` 검증 완료 |
| **4. 백엔드 · Python 워커 · DB · 스크립트 인프라** | `sqlite_db.mjs`, `pg_sync.mjs`, `init_db.py`, `market_hub.py`, `*.sh`/`*.bat`, `/install/*` | 9 | 3 PASS / 4 FAIL / 2 WARN | **9 PASS (100%)** | `tests/verify_log_rotation.mjs` + `tests/qa_python_verification.py` + `/install` 재빌드 검증 완료 |
| **5. 프론트엔드 UI/UX & 런타임 안정성** | `frontend/src/App.jsx`, `frontend/src/styles.css`, `frontend/server.mjs` | 9 | 2 PASS / 5 FAIL / 2 WARN | **9 PASS (100%)** | `vite build` 프로덕션 빌드 에러 0건 및 E2E API 검증 완료 |
| **6. 보안 · 문서 동기화 · 형상 관리** | `.gitignore`, `README.md`, `SETUP_GUIDE.md`, `howtorun.md`, `prompt.md`, `install/README.md` | 5 | 2 PASS / 2 FAIL / 1 WARN | **5 PASS (100%)** | `git status` 민감 파일 0건 및 `v0.0.28` 전 문서 동기화 완료 |
| **합계** | **전체 플랫폼 6대 영역** | **48** | **14 PASS / 26 FAIL / 8 WARN** | **48 PASS / 0 FAIL / 0 WARN (100%)** | **전 항목 Surgical Fix 및 자동화 실증 통과** |

---

## 1. 매매 엔진 · 원장 격리 · 주문 정밀도 (Trading & Ledger Integrity)

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 및 결함 요약 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-1.1** | **가상거래(Always-On Arena) 상시 가동 & LLM/BTC 하락장 필터 100% 우회** | `backend/common/algo_lab_service.mjs:1312-1330, 1523, 1642-1776, 2245, 2263-2298`, `backend/node_server.mjs:9175-9198, 9403` | `PASS` | `PASS` | 10대 봇(`bot_01`~`bot_10`) 상시 `paper_is_running = 1` 유지. `evaluateStrategy`/`runPaperBot`/`runArenaCycle`은 `HOLD_CASH`, `market_regime_filter`, `ai_market_briefings`, BTC 20MA/60MA를 일절 참조하지 않고 100% 우회. |
| **QA-1.2** | **실거래 vs 가상거래 원장 완전 분리** | `backend/node_server.mjs:1114-1170, 8004-8095, 8505-8567, 8883`, `backend/common/algo_lab_service.mjs:1552-1624, 2242-2318` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-07 / MAJ-05]** `algo_lab_service.mjs` 자체는 `paper_*`만 사용하나, `runLiveTradingBotsCycle()`이 `trade_mode === "paper"` 상태에서도 10초마다 실행되어 `paper_trades`/`paper_bot_positions`에 교차 기록하고 실전 `bots.virtual_krw`를 덮어씀. `getBots("paper")`도 실전 `allocated_capital`을 혼용. |
| **QA-1.3** | **격리 매도 (`get_balance()` 전량 매도 배제 & `bot_id`/`order_uuid` 수량 보호)** | `backend/node_server.mjs:8584-8698`, `bots.py:692-808` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-02 / CRIT-03]** `get_balance()` 전량 매도는 부재하나, (1) `node_server.mjs:8655-8659`에서 `actualCoinBalance <= otherBotsVol`이면 `boundedVol === 0`이 되어 `if (boundedVol > 0)`을 건너뛰고 타 봇 보유 코인까지 매도하는 격리 위반 발생. (2) `/v1/accounts` HTTP 오류 시 `actualCoinBalance = 0`이 유지되어 OPEN 포지션을 `manual-sync`로 파괴적 강제 종료. |
| **QA-1.4** | **수량 소수점 8자리 내림 정밀도 (`ROUND_DOWN` / `Decimal`)** | `backend/node_server.mjs:221-226`, `bots.py:44-52` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-PY-11 / MIN-01]** `bots.py`가 `Decimal`/`ROUND_DOWN` 대신 `math.floor(float * 1e8) / 1e8`를 사용해 `0.29 -> 0.28999999` 정밀도 손실 및 `5e-05` 과학적 표기법 발생. `node_server.mjs:225` 정규식도 소수부 뒤 `0` 제거 실패(`"1.23000000"`). |
| **QA-1.5** | **지정가 주문(`limit_order`) · 미체결 취소(`cancel_order`) 폴링 · 체결 정산 (`Order Reconciliation`)** | `backend/node_server.mjs:7941-7958, 8097-8251, 8810-8855, 9200-9260`, `bots.py:475-625, 745-780` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-05 / CRIT-10 / CRIT-PY-01 / CRIT-PY-05 / CRIT-PY-06]** (1) `node_server.mjs:8194, 8234, 9238`에서 `Math.floor(totalFunds / filledVol)`가 1원 미만 코인(`KRW-SHIB`)의 `avg_buy_price`를 `0`으로 절삭하여 모든 청산 비활성화. (2) 실전 업비트 `fetch()`에 `AbortSignal.timeout()` 누락. (3) `bots.py:768` 시장가 매도 시 Upbit `"price": null`에 `float(None)` `TypeError` 크래시. (4) `bots.py:614-624` `state=='done'` 폴링 누락 및 부분 체결 시 잔여 코인 고아화. |
| **QA-1.6** | **수수료 완충(`Math.floor(예산 / 1.0005)`) · 업비트 최소 주문 금액(`5,000원`/`5,050원`/`5,250원`) · Buy-to-Cleanse 방어** | `backend/node_server.mjs:7778-7796, 8708-8775`, `backend/common/algo_lab_service.mjs:1569, 1766`, `bots.py:447-462, 586-598, 737-760` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-04 / MAJ-ALGO-08 / MAJ-PY-14]** (1) `node_server.mjs:8708-8775` Buy-to-Cleanse에서 보충 매수 후 매도 실패 시 DB 미반영으로 매 10초마다 5,500원 무한 매수 루프 위험. (2) `algo_lab_service.mjs:1766` + `1569` 및 `bots.py:447` + `587`에서 수수료 이중 차감으로 5,000~5,005원 정상 주문 거절. (3) `bots.py:737` 매도 최소주문(5,000원) 사전 체크 누락. |
| **QA-1.7** | **Zero-Division / `NaN` / `Infinity` / `curPrice <= 0` 방어** | `backend/node_server.mjs:327-330, 496, 504, 7783-7795, 8945`, `backend/common/algo_lab_service.mjs:70, 1998, 2043-2056, 2103`, `agentBot/bot_10_jack_kellogg.py:301` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-02 / MAJ-17 / MAJ-ALGO-05 / MAJ-PY-26]** (1) `node_server.mjs:8945` `curPrice > 0` 미검증 시 `-100%` 오인 손절. (2) `algo_lab_service.mjs:2054` 파산 봇 `baselineEquity = 1`로 `+100,000%` 폭발. (3) `bot_10_jack_kellogg.py:301` `first_buy == 0` 시 `ZeroDivisionError`. (4) `getSafeOrderKrw`/`synthesizeDualAiDecision` `NaN` 전파. |
| **QA-1.8** | **`bot_10` Jack Kellogg (VWAP · 20봉 OLS LRC ±2σ · RVOL · 3대 기준가격선 · 2분할 매수)** | `backend/common/algo_lab_service.mjs:229-367, 869-877, 1154-1300`, `backend/node_server.mjs:8985`, `agentBot/bot_10_jack_kellogg.py:29-548` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-ALGO-01 / MAJ-ALGO-02 / MAJ-ALGO-03 / CRIT-PY-08]** (1) `algo_lab_service.mjs:1672-1687` 공유 `peak`로 인해 `bot_06`/`bot_10` 2차 분할 직후 9초 무한 매수·매도 루프. (2) `bot_10` DB 설정키(`rvol_breakout_arena/live`, `vwap_gap_arena/live`) 불일치로 무시됨. (3) `bot_10_jack_kellogg.py`는 `buy_reason` 미저장으로 Setup A/B 손절·LRC 익절·2차 분할 전체 Dead Code. (4) `node_server.mjs:8985` 실전 `bot_10` 단일 포지션 전달. |
| **QA-1.9** | **스마트 청산 (Time-Stop · Breakeven Stop · ATR 동적 트레일링 스탑) 및 10대 전략 정합성** | `backend/common/algo_lab_service.mjs:509-666, 921-1152`, `backend/node_server.mjs:8906-8998`, `bots.py:156-231, 1122, 1256, 1429, 1588-1605` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-08 / CRIT-PY-03 / CRIT-PY-04 / MAJ-03 / MAJ-ALGO-04]** (1) `node_server.mjs:8906` 8개 고정 종목 외 보유 포지션 청산 누락, 매도 실패 시 `liveBotPeakMap` 삭제. (2) `bots.py` `highest_price` `conn.commit()` 누락 + Time-Stop UTC/KST 9시간 오차로 매수 즉시 청산 + ATR Trailing 손실 구간 발동. (3) `algo_lab_service.mjs` `bot_01` 20MA 추세 필터 미적용 및 15m ATR Hard Stop이 `bot_10` Setup B 2차 분할 선차단. |
| **QA-1.10** | **일일 서킷 브레이커 (`-4.0%`, KST 자정 기준)** | `backend/node_server.mjs:1143-1153, 9038-9058`, `bots.py:342-358, 630-669, 786-808` | `WARN` | `PASS` | **(수정 완료: `PASS`)** Node.js 실전 서킷 브레이커(`-4.0%` 신규 매수만 차단·매도 유지)는 정상 동작(`PASS`). 단 **[CRIT-PY-09]** Python 단독 모드에서 `bots.py`가 `trades` 테이블에 기록하지 않아 Python 서킷 브레이커가 비작동. |
| **QA-1.11** | **실전 잔고 `0원` 이하 전체 봇 자동 중지 및 모달 알림** | `backend/node_server.mjs:1312-1352, 1584-1602`, `frontend/src/App.jsx:3209-3217, 3231-3239` | `PASS` *(WARN)* | `PASS` | **(수정 완료: `PASS`)** `checkAndHaltIfZeroBalance` 및 UI 모달 정상 동작. 단 **[MAJ-11]** 업비트 실잔고가 0원이 되어도 `syncDynamicLiveCapitalFromUpbit`가 조기 반환하여 `total_capital=0` 미갱신, 반대로 재입금 시 `zero_balance_halted` 자동 해제 누락. |

---

## 2. 주간 전략군 TOP 1 자동 로테이션 & 미매도 포지션 보호 (Graceful Drain)

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 및 결함 요약 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-2.1** | **3대 전략군(`TREND_SWING`, `VOLATILITY_BREAKOUT`, `REVERSAL_GRID`) 챔피언 선출 & Cold Start(7일 거래 0건) Fallback** | `backend/common/algo_lab_service.mjs:671-708, 1997-2180` | `PASS` | `PASS` | 3대 전략군 각 1위 선출, `rotation_score` 산식, 7일 거래 0건 시 `ARENA_CUMULATIVE_FALLBACK` 및 1~2개 챔피언 동적 비율 합계 100% 보정 모두 정상 검증 (`tests/verify_rotation_drain_edge_cases.mjs` PASS). |
| **QA-2.2** | **탈락 봇(`is_selected_for_live: 1 -> 0`) 미매도 오픈 포지션 강제 시장가 청산 금지 + 신규 매수 차단 + 매도 감시 유지** | `backend/node_server.mjs:4821-4884, 5590, 8898-9020`, `bots.py:361-376, 1082, 1235, 1407` | `PASS` *(WARN)* | `PASS` | **(수정 완료: `PASS`)** Node.js Graceful Drain(강제 청산 금지, 신규 매수 차단, 고유 전략 청산 감시) 정상 동작. 단 Python `bots.py:325-338` `DRY_RUN` 조기 반환 및 `bots` 행 부재 시 기본 `allow_new_buys=True` 보강 필요. |
| **QA-2.3** | **매도 청산 완료 시 정산 원화 실시간 비율 이관 & `Math.floor` 1~2원 자투리 Zero-Sum(1원 오차 없음)** | `backend/node_server.mjs:1263-1293, 8366-8478`, `bots.py:822-962` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-01 / MAJ-PY-16]** 탈락 봇 이관 Zero-Sum은 통과하나, (1) `node_server.mjs:8462-8468`에서 **활성 봇 매도 시 이미 닫힌 `buy_amount`가 이중 계상되어 유령 원화 생성**! (2) `bots.py:840-890`에서 활성 봇 0개일 때 탈락 봇 정산 원화 소실. |
| **QA-2.4** | **`drain_handoff_logs` 감사 원장 기록 정합성** | `backend/node_server.mjs:8437-8460`, `bots.py:931-956` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-PY-02]** Node.js는 정상 기록하나, `bots.py:945`에서 미정의 변수 `pos_dict.get("trade_id")`로 `NameError` 발생 후 `except: pass`로 삼켜 Python 이관 로그가 영구 미기록. |
| **QA-2.5** | **자동 스케줄러 vs 수동 실행(`POST /api/rotation/execute-now`) 동시 호출 락 & DB 트랜잭션 무결성** | `backend/node_server.mjs:4737-4922, 5331, 5566, 8324-8491` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-09 / MAJ-06]** `isAutoRotationExecuting` + `liveSelectionMutex`는 있으나, `settleLiveSellOrderInDb`가 동일 뮤텍스를 공유하지 않아 로테이션과 매도 정산 동시 실행 시 SQLite 중첩 `BEGIN IMMEDIATE` 크래시 발생. 또한 `applyLiveBotsSelection`이 Upbit HTTP 조회 후 stale `allBots`로 덮어쓰는 TOCTOU 존재. |
| **QA-2.6** | **로테이션 스케줄 및 구버전 일요일 LLM 스케줄러 충돌 방지** | `backend/node_server.mjs:5304-5326, 9407` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-08]** `auto_rotation_config.is_enabled === 1`일 때는 구버전 일요일 09:00 LLM 스케줄러를 건너뛰나, 사용자가 자동 로테이션을 의도적으로 비활성화(`0`)하면 구버전 LLM 스케줄러가 부활해 봇을 덮어씀. |
| **QA-2.7** | **파산 봇(`baselineEquity=1`) 점수 폭발 & `NaN` 방어** | `backend/common/algo_lab_service.mjs:1901-1908, 1998, 2043-2056, 2103` | `WARN` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-ALGO-05]** 과거 누적 손실 ≥ 100% 시 `baselineEquity = 1`로 인해 주간 수익률이 `+100,000%`로 폭등할 수 있고, `readMarketRegimeContext`가 `CRASH`/`HOLD_CASH`를 누락. |

---

## 3. 듀얼 AI 게이트웨이 (30분 Ollama/Flash · 1시간 Pro 및 3중 Fallback)

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 및 결함 요약 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-3.1** | **`market_regime_filter` `bot_01`~`bot_10` 개별 `ALLOW`/`BLOCK` 키 무결성 & 실전 매수 게이트 연동** | `backend/node_server.mjs:228-257, 854-870, 9062-9094`, `init_db.py:38-45, 76-102`, `bots.py:402-422` | `PASS` | `PASS` | `normalizeBotOverrides` 및 기동 시 레거시(`bot_vb` 등)→10대 봇 자동 마이그레이션으로 키 누락 없이 10개 봇 전체 `ALLOW`/`BLOCK` 제어 완벽 연동. |
| **QA-3.2** | **`BLOCK` / `final_risk_alert = 1` 상태에서도 보유 포지션 매도(청산) 루프 비차단** | `backend/node_server.mjs:8940-8998`, `bots.py:692-1002, 1115-1148, 1241-1289, 1413-1497`, `agentBot/bot_10_jack_kellogg.py:410-478` | `PASS` | `PASS` | Node.js 및 Python 모두 매도 청산 평가가 AI 게이트 검사 이전에 무조건 실행되며, `executeBotSellOrder`/`execute_sell_order`는 AI 필터를 일절 차단 조건으로 삼지 않음. |
| **QA-3.3** | **로컬 Ollama(`qwen3-news`, `think: false`, `format: "json"`, 타임아웃) 호출 규격** | `backend/node_server.mjs:2133-2134, 3070-3165`, `llm_filter_worker.py:991-1069` | `PASS` | `PASS` | `stream: false`, `think: false`, `format: "json"` 정상 전송. v0.0.27에서 인텔 맥북 CPU 추론 안정화를 위해 기본 타임아웃 `120,000ms`(UI/환경변수로 3초~180초 조정 가능, v0.0.26 초기값 25초에서 상향) 및 뉴스 6건 경량화 적용 완료. |
| **QA-3.4** | **3중 Fallback (로컬 Ollama ➔ Gemini Flash 지수 백오프 1s/2s/4s ➔ 기계적 지표 BTC 20MA) 무중단성** | `backend/node_server.mjs:296-320, 3324, 3407, 4396-4418`, `llm_filter_worker.py:346, 431, 720-822, 1072-1175` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-09 / MAJ-PY-19 / MAJ-PY-20 / MAJ-PY-23]** 3중 체인 및 1s/2s/4s 백오프 구조는 정상이나: (1) BTC 시세 조회 완전 실패(`btcPrice=0`) 시 Node·Python 모두 `BULL / 1.0x / ALL ALLOW`로 **Fail-Open**! (2) Python `previous_state`가 TTL 없이 무한 재사용되어 BTC 20MA 폴백 도달 차단. (3) Python Gemini 401/403 시 600초 재시도 폭주. |
| **QA-3.5** | **Ollama 단독(Gemini 키 미설정) 운용 시 Dual AI 합성(`synthesizeDualAiDecision`) 복구 무결성** | `backend/node_server.mjs:2553-2650, 341-388`, `llm_filter_worker.py:1640-1659` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-06]** Gemini Pro 미실행 시 `loadSideState("dual_ai_pro_state_json")`가 직전 `market_regime_filter.final_risk_alert`/`final_bot_overrides_json`을 Pro 상태로 복사하여, Ollama가 일시적 `BLOCK`/`risk_alert`를 1회만 발행해도 이후 `NORMAL`/`ALLOW`로 복귀해도 영구 잠금(Sticky Latch)! |
| **QA-3.6** | **Python LLM JSON 파싱(`risk_alert: "false"`) & Provider/Model 메타데이터 정합성** | `llm_filter_worker.py:929-950, 1483-1600` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-PY-18 / MAJ-PY-21]** (1) `bool("false") == True`로 문자열 `"false"` 수신 시 전 봇 차단. (2) Pro 단독 사이클이 `ai_market_briefings`에 `flash_model`을 오기록하고, Flash 단독 사이클이 `dual_ai_pro_provider`를 `fallback`으로 덮어씀. |
| **QA-3.7** | **30분/1시간 스케줄러 타임존(KST) 및 중복 Ollama 추론 방지** | `backend/node_server.mjs:2397-2408, 9279-9351` | `WARN` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-10 / MIN-02]** 스케줄러가 로컬 TZ를 사용하고, 30분 슬롯마다 시장 분석과 뉴스 분석에서 Ollama를 2회 연속 중복 호출하여 CPU 부하 2배 발생. |

---

## 4. 백엔드 · Python 워커 · DB · 스크립트 인프라 정합성

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 및 결함 요약 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-4.1** | **Node.js(`8001`) ↔ Python 워커 이중 주문 실행(Double Execution) 방지** | `main_orchestrator.py:248-255`, `bots.py:55-79, 318, 574, 726, 1061, 1215, 1387`, `agentBot/bot_10_jack_kellogg.py:380`, `llm_filter_worker.py:1669-1682` | `WARN` | `PASS` | **(수정 완료: `PASS`)** Node 8001 포트 감지 시 Python 워커 자동 Yield 동작. 단 `llm_filter_worker.py`는 `.backend.pid` 미확인, `bots.py:62` `BACKEND_PORT=""` 시 크래시, `PORT`/`BACKEND_HOST` 미참조 및 `PermissionError` 처리 불일치 보완 필요. |
| **QA-4.2** | **SQLite 단일 경로(`data/auto_coin_trade.db`) · WAL · `synchronous=NORMAL` · `busy_timeout=5000`** | `backend/common/sqlite_db.mjs:11, 49, 64-81, 208`, `init_db.py:35, 119-139, 263-269` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-PY-24]** PRAGMA(`WAL`, `NORMAL`, `busy_timeout=5000`)는 Node·Python 모두 완벽 적용. 단 (1) `init_db.py:263`은 `AUTOCOIN_DB_PATH`를 무시하고 `DB_PATH`만 참조, `sqlite_db.mjs:208`은 `DB_PATH`를 무시하고 `AUTOCOIN_DB_PATH`만 참조. (2) `init_db.py:136-138`은 `.env.example` 기본값(`LOCAL_PG_HOST=127.0.0.1`)만으로 PostgreSQL 모드로 오인 전환(Split-Brain). |
| **QA-4.3** | **기존 DB 자동 `ALTER TABLE` 마이그레이션 & Node↔Python 스키마 호환성** | `backend/node_server.mjs:652, 818-845`, `backend/common/sqlite_db.mjs:113-132`, `init_db.py:200-236, 340-596` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-PY-07 / CRIT-PY-10 / MAJ-15]** (1) `init_db.py:200-233` `PgConnectionWrapper`가 세미콜론 `;` 뒤에 `ON CONFLICT`를 붙여 PG 100% 구문 오류. (2) `init_db.py`에 `bot_positions.buy_reason`/`paper_bot_positions.buy_reason` 누락, `node_server.mjs:652` `trade_id` `DEFAULT 0` 누락. (3) `node_server.mjs:818` `ALTER TABLE bot_accounts`가 신규 PG에서 크래시. |
| **QA-4.4** | **`pg_sync.mjs` 최신 컬럼 동기화 & `DB_MODE=sqlite`/`PG_SYNC_ENABLED=false` 조용한 분기** | `backend/common/pg_sync.mjs:10, 98-131, 228-241, 287, 328-385, 555-665, 945-967` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** `DB_MODE=sqlite`/`PG_SYNC_ENABLED=false` 분기(`L100, 130, 946`)는 조용히 스킵(`PASS`). 단 (1) `L229-240`에서 `ALTER TABLE bots`와 미생성 테이블 `ALTER TABLE paper_trades`를 단일 쿼리로 묶어 신규 PG에서 전체 롤백! (2) `profit_krw === 0`이 `null`로 변환(`L558`), `buy_reason` 컬럼 누락, `AUTOCOIN_ENV_PATH` 미참조. |
| **QA-4.5** | **시세 캐시 & 업비트 Rate Limit(`120ms` 딜레이 · `429/503` 지수 백오프)** | `market_hub.py:19-123`, `backend/node_server.mjs:2771, 3004, 5420, 7680-7745` | `WARN` | `PASS` | **(수정 완료: `PASS`)** `market_hub.py` 120ms 스로틀 및 `node_server.mjs` `fetchUpbitPublicWithBackoff`(120ms + 1s/2s/4s 백오프 + 3s/8s 캐시) 구현 완료. 단 `node_server.mjs:5420` 잘못된 캐시키(`"ALL_MARKETS"`) 및 `L2771`/`L3004` 직접 호출 우회 보강 필요. |
| **QA-4.6** | **루트 실행·종료 스크립트 (Windows/Linux) 경로·환경변수·좀비 프로세스 정리** | `setup.sh/.bat`, `start*.sh/.bat`, `stop*.sh/.bat`, `run_orchestrator.sh/.bat`, `scripts/run_frontend.bat` | `PASS` *(WARN)* | `PASS` | **(수정 완료: `PASS`)** 루트 `setup.sh/.bat`, `start_services.sh/.bat`, `stop_services.sh/.bat`, `run_orchestrator.sh/.bat` 정합성 양호. 단 `scripts/run_frontend.bat`에서 `BACKEND_PORT` 커스텀 시 `BACKEND_URL` 미연동 보완 필요. |
| **QA-4.7** | **`/install` 독립 패키지 동기화 및 원클릭 시작/종료 스크립트** | `install/AutoCoinTrade_*`, `scripts/build_install_package.sh` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** `install/AutoCoinTrade_Linux_Stop.sh:53-57`에 `ss` 폴백 누락 및 `kill -9` 무조건 실행, `AutoCoinTrade_Windows_Start.bat` `BACKEND_URL` 포트 미연동. Phase 2 수정 후 `build_install_package.sh` 재동기화 필수. |
| **QA-4.8** | **4단계 초기 설정 마법사 (`/api/setup/*`) & PG 전환·초기 자본 배분** | `backend/node_server.mjs:5973-6194`, `frontend/src/App.jsx:1341-1552` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-FE-01 / CRIT-FE-02 / MAJ-13]** 프론트엔드 미오픈 & KST 00:00~08:59 로그아웃, 백엔드 `/api/setup/test-db` `rootClient` 누수, `/api/setup/complete` 초기 `recalculateAndApplyBotAllocations` 미호출. |
| **QA-4.9** | **로그 일자별 로테이션 (`log_rotator.mjs`)** | `backend/common/log_rotator.mjs`, `tests/verify_log_rotation.mjs` | `PASS` | `PASS` | KST 자정 로테이션, 7일 보관 정책, 락 직렬화 및 7개 유닛 테스트 전체 PASS. |

---

## 5. 프론트엔드 UI/UX & 런타임 안정성 (`frontend/src/App.jsx`, `styles.css`)

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 및 결함 요약 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-5.1** | **React TDZ(Temporal Dead Zone) 방어 — 모든 `fetch*`/핸들러/`useCallback`/`useMemo`가 `useEffect` 상단 선언** | `frontend/src/App.jsx:515-3652` | `PASS` | `PASS` | 15개 `useEffect` 및 17개 `useCallback`/`useMemo` 전수 점검 결과 모든 참조 심볼이 상단 선언 완료(런타임 TDZ 0건). |
| **QA-5.2** | **API/SSE 상대 경로(`"/api/..."`) & 언마운트/탭 전환 시 리소스(`AbortController`/`setInterval`/`setTimeout`/`AudioContext`) 클린업** | `frontend/src/App.jsx:3, 1742-1802, 1884-1901, 2006, 2885-2948, 3416-3431, 3555-3628, 3688` | `WARN` | `PASS` | **(수정 완료: `PASS`)** 41개 `fetch()` 전부 상대 경로 `${API_BASE}/api/...` 사용(`localhost:8001` 0건). 단 `setTimeout` 2건(`2006, 3688`) 클린업 누락, `AudioContext.close()` 누락(`1888`), SSE EOF 잔여 버퍼 미플러시(`2885, 3560`). |
| **QA-5.3** | **[메뉴 1] `⚡ 실제거래 현황` — 실계좌·듀얼 AI 모델명·1~3 실전 봇·Graceful Drain·서킷 브레이커·1줄 체결 게시판** | `frontend/src/App.jsx:2781-2806, 3288, 3388, 3990, 4780-6611` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-FE-04 / MAJ-FE-08 / MAJ-FE-12]** (1) `⚡ 지금 AI 평가 실행` 클릭 시 `.selection` 래퍼 누락으로 카드 본문 백지화. (2) Paper 모드에서 6초마다 live/paper 플립플롭. (3) 고아 `selectedBotId` 미보정 및 Draining 봇 `▶ 거래시작` 활성 상태 유지. |
| **QA-5.4** | **[메뉴 2] `🏆 가상거래 경쟁` — 10대 봇 TOP 3 포디움·리더보드·필터 체결일지·단일행 툴바** | `frontend/src/App.jsx:7387-8007`, `frontend/src/styles.css:316-374, 949, 1200-1243` | `WARN` | `PASS` | **(수정 완료: `PASS`)** 10대 봇 포디움·리더보드·필터 정상 동작. 단 `.btn-secondary` 4건 미정의, `.podium-grid` 모바일 셀렉터 오타(`.podium-container`여야 함), `.podium-*` 중복 선언 정리 필요. |
| **QA-5.5** | **[메뉴 3] `📈 통계` — 기준일 `2026.10.01` · 이익 `#ef4444` / 손해 `#3b82f6` / `0원` 회색 · 일/주/월 차트** | `frontend/src/App.jsx:201, 864-1084, 2194, 3374, 6616-7385`, `backend/node_server.mjs:6881-6955`, `frontend/src/styles.css:588` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-14 / MAJ-FE-09 / MAJ-FE-10 / MAJ-FE-16]** (1) `pnl-zero` vs `.pnl-Zero` 대소문자 오타. (2) 월별 자산 카드/차트 녹색/빨강 반전 색상. (3) 초기 진입 시 `statsModeTab` vs `tradeMode.mode` 불일치. (4) 백엔드 `2027-W53+` 주차 버그·누적손익 0원 드랍·주간/월간/연간 코인손익 동일 버그. |
| **QA-5.6** | **[메뉴 4] `📰 뉴스` — 50건 페이징 · 행 높이 `48px` 고정 1줄 말줄임 · 툴팁 · AI SSE 스트리밍** | `frontend/src/App.jsx:3450-3480, 3647-3690, 8012-8690`, `frontend/src/styles.css:700-736, 1104` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-FE-05]** `useEffect`가 `fetchNews`에 의존해 검색창 1글자 타이핑마다 `/api/news` + `/api/ai/news-briefing` 동시 폭주! 빈 목록 행(`colSpan=6`)이 `height: 48px`에 잘림. `.news-ai-action-btns` 모바일 줄바꿈 누락. |
| **QA-5.7** | **[메뉴 5] `⚙️ 설정` — 1~3 실전 봇 동적 비율 100% 검증 · Graceful Drain · 입장 코드(`stock`/`ㄴ새차`) · JSON 백업/복원** | `frontend/src/App.jsx:3193-3206, 3712, 3955, 10300-10411, 10513`, `backend/node_server.mjs:1955, 5836, 7257-7543` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[CRIT-11 / CRIT-12 / MAJ-12 / MAJ-FE-03 / MAJ-FE-06 / MAJ-FE-11]** (1) `bot_volatility` 레거시 ID 체크로 봇 파라미터 입력창 미렌더링. (2) 설정 이동 시 미저장 편집 초기화. (3) 입장 코드 확인란 공백 통과 & 백엔드 `gate_code` 잠금 & 기본 `stock` 한글 오타 `ㄴ새차` 미지원. (4) JSON Import 시 비밀키 삭제 및 무트랜잭션. |
| **QA-5.8** | **CSS 누락 클래스 · 반응형(`<= 900px`) · 버전 표기 일관성** | `frontend/src/App.jsx:1302`, `frontend/src/styles.css:842, 930-949` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** **[MAJ-FE-07 / MAJ-FE-13 / MAJ-FE-15]** `.btn-secondary`(14곳)·`.spinner`(4곳) CSS 미정의, `@media (max-width: 860px)`로 인해 `861~900px` 레이아웃 붕괴, 초기 `appVersion` `"0.0.22"` 하드코딩. |
| **QA-5.9** | **프로덕션 정적 서버(`frontend/server.mjs`) 보안 헤더 · 경로 탈출 차단 · Vite 프로덕션 빌드** | `frontend/server.mjs:1-287`, `cd frontend && npm run build` | `PASS` | `PASS` | `realpathSync` 경로 탈출·dotfile·`/@fs` 차단, 보안 헤더 3종, SSE 스트리밍 프록시, `vite build` 0 errors 정상 통과. |

---

## 6. 보안 · 문서 동기화 · 형상 관리

| ID | 점검 항목 | 확인 근거 (파일:라인) | 최초 상태 | 최종 상태 | 상세 점검 내용 및 결함 요약 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **QA-6.1** | **민감 파일(`.env`, `config/upbit_config.json`, `data/*.db`, `data/.session_secret`) Git 추적 제외** | `.gitignore:15-49`, `git ls-files` | `PASS` | `PASS` | 실제 추적 파일 목록에 `.env`, `upbit_config.json`, `*.db`, `.session_secret` 0건 (`.env.example` 템플릿만 추적). |
| **QA-6.2** | **개인 입장 코드(`sws@2129`) 및 구버전 저장소 URL(`wonsubshin/autoCoinTrade`) 잔존 여부** | `git grep -i -E '(wonsubshin|sws@2129)'` | `PASS` | `PASS` | `sws@2129` 0건. `wonsubshin`은 `history.md:185` v0.0.19 변경 이력 서술 1줄에만 존재하며 실코드/설정/문서 URL은 모두 `asura207/autoCoinTrade`로 통일. |
| **QA-6.3** | **작업 트리 미추적 임시 파일(`.playwright-mcp/`, `--sqlite`) 오염 방지** | `git status`, `.gitignore` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** 루트에 0바이트 오타 파일 `--sqlite` 및 `.playwright-mcp/` 로그 폴더가 미추적 상태로 존재하며 `.gitignore`에 미등록(`git add .` 시 커밋 오염 위험). |
| **QA-6.4** | **문서(`README.md`, `SETUP_GUIDE.md`, `howtorun.md`, `prompt.md`, `install/README.md`) ↔ 실제 코드 동기화** | `README.md:3, 6, 293`, `SETUP_GUIDE.md:186, 190`, `prompt.md:42-48`, `install/README.md:153` | `FAIL` | `PASS` | **(수정 완료: `PASS`)** `README.md` 버전 배지 `v0.0.17` 및 `Vite 5`/Ollama 누락, `SETUP_GUIDE.md` 구 봇ID `bot_volatility` 및 3개 봇 표기, `prompt.md` 삭제된 `backend/main.py`·`database.py` 기재, `install/README.md` `scripts/start_tunnel.sh` 오경로. |
| **QA-6.5** | **버전 관리 정책(`0.0.X` 커밋당 1 증가) 및 `package.json` · `history.md` · UI 동기화** | `initRule.md:40`, `package.json:3`, `frontend/package.json:3`, `history.md`, `frontend/src/App.jsx:1302` | `WARN` | `PASS` | **(수정 완료: `PASS`)** `App.jsx:1302` 초기값 `0.0.22` 불일치. Phase 2 수정 반영 시 `v0.0.28`로 전체 메타데이터·`history.md`·`/install` 번들 일괄 동기화 필요. |

---

## 🧪 자동화 QA 검증 스위트 실행 결과

- **기존 스위트 (`npm test`)**:
  - `tests/verify_rotation_drain_edge_cases.mjs`
  - `tests/verify_all_bots_and_execution.mjs`
  - `tests/verify_log_rotation.mjs`
  - `tests/verify_ollama_integration.mjs`
- **신규 통합 QA 스위트 (Phase 1~2 추가)**:
  - `tests/qa_full_verification.mjs`: 가상 Arena 필터 100% 우회, 원장 격리, 다중 분할(`bot_06`/`bot_10`) 무한 루프 회귀 방지, 활성/탈락 매도 Zero-Sum & 동시성 트랜잭션, 격리 매도(`boundedVol === 0` 타봇 보호 & `/v1/accounts` 오류 시 DB 보존), `< 1 KRW` 코인 정밀도, Ollama 단독 Sticky-BLOCK 해제 & BTC 0원 Fail-Safe, 통계 주차/누적/기간별 검증, `stock`/`ㄴ새차` 인증 및 `gate_code` 변경, JSON Export/Import 비밀키 보존 전수 검증.
  - `tests/qa_python_verification.py`: `Decimal ROUND_DOWN` 8자리 정밀도, `init_db.py` PG `ON CONFLICT` SQL 번역 & `buy_reason` 컬럼 & `AUTOCOIN_DB_PATH`, `bots.py` `drain_handoff_logs` 기록 & `highest_price` 영구 커밋 & KST Time-Stop & 시장가 매도 `price: null` 복원력, `bot_10_jack_kellogg.py` Setup A/B 2분할 & Zero-Division 방어, `llm_filter_worker.py` `risk_alert: "false"` & BTC 장애 Fail-Safe & 3중 Fallback 전수 검증.
