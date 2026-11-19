# autoCoinTrade 프로덕션 고도화(Enhancement) 실행용 프롬프트 모음 (`docs/ENHANCEMENT_PROMPTS.md`)

> **문서 목적**: 본 문서는 `autoCoinTrade` (`v0.0.28` 기준) 코드베이스의 전수 QA 및 아키텍처 진단을 바탕으로 도출된 **상위 5대 핵심 고도화 과제**를 즉시 코딩 에이전트에게 지시하여 구현할 수 있도록 작성된 **독립 실행형(Self-Contained) 마크다운 프롬프트 모음**입니다.  
> 각 과제는 기존 정상 작동 기능(실계좌 연동, 10대 봇 Arena, 주간 로테이션 & Graceful Drain, 듀얼 AI 3중 Fallback, 통계/뉴스/설정 마법사)을 100% 보존하면서 무중단 점진적 확장이 가능하도록 설계되었습니다.

---

## 📋 고도화 과제 요약 목차

1. **[과제 1 · P0] 업비트 WebSocket 실시간 시세·호가·체결 스트림 허브 및 틱 반응형 스마트 청산 엔진**
2. **[과제 2 · P0] 업비트 과거 캔들 기반 정량 백테스팅(Backtester) & 워크포워드(Walk-Forward) 검증기**
3. **[과제 3 · P1] 호가창 불균형(OBI) · 멀티 타임프레임(MTF) 필터 · ATR 변동성 역가중 포지션 사이징 & 슬리피지 원장**
4. **[과제 4 · P1] 텔레그램/디스코드 실시간 체결·리스크 알림 허브 & 캔들 차트 타점(BUY/SELL)·트레이드 저널 UI**
5. **[과제 5 · P1] AES-256-GCM API 키 암호화 볼트(Vault) · Docker Compose 배포 · GitHub Actions CI/CD 파이프라인**

---

## 🚀 [과제 1 · P0] 업비트 WebSocket 실시간 시세·호가·체결 스트림 허브 및 틱 반응형 스마트 청산 엔진

````markdown
# Task: 업비트 WebSocket(`wss://api.upbit.com/websocket/v1`) 실시간 스트림 허브 구축 및 틱 반응형 청산 고도화

당신은 `autoCoinTrade` 프로젝트의 시니어 퀀트 시스템 아키텍트입니다.
현재 9~10초 주기 REST 폴링(`fetchUpbitTickersMap`)에 의존하는 시세/호가 수집 구조를 **업비트 공식 WebSocket 실시간 멀티플렉서 + REST 자동 폴백(Fallback) 하이브리드 아키텍처**로 고도화하십시오.

## 1. 목표 및 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/upbit_ws_hub.mjs`: 업비트 WebSocket(`wss://api.upbit.com/websocket/v1`) 연결 관리, `ticker`·`orderbook`·`trade` 실시간 구독, 지수 백오프 재연결(1s→2s→4s→8s, 최대 30s), Ping/Pong 하트비트(60초), 인메모리 최신 스냅샷 및 틱 이벤트 브로드캐스터
  - `tests/verify_upbit_ws_hub.mjs`: 로컬 Mock WebSocket 서버 기반 스트림 수신·재연결·REST 폴백·틱 즉시 손절/트레일링 스탑 트리거 자동화 테스트
- **국소 수정(Surgical Edit)**:
  - `backend/node_server.mjs`: `upbitTickersCache`를 `upbit_ws_hub.mjs` 실시간 캐시와 연동(WebSocket 연결 정상 시 REST 호출 생략, 스트림 지연 `> 5,000ms` 시 기존 `fetchUpbitTickersMap` REST 폴백 자동 작동), 오픈 포지션 보유 종목 급변(`±0.8%` 이상 틱 변동 또는 손절/트레일링 스탑 도달) 시 10초 주기를 기다리지 않고 즉시 청산 평가(`evaluateSmartExit`) 트리거(단, 종목별 `1,500ms` 디바운스 락 적용), `GET /api/upbit/status` 및 `GET /api/system/overview`에 `ws_status`(`connected`, `latency_ms`, `subscribed_markets`, `fallback_mode`) 포함
  - `frontend/src/App.jsx`: 좌측 사이드바 업비트 통신 상태 박스에 WebSocket 실시간 스트림 배지(`WS 실시간` vs `REST 폴백`) 및 툴팁 정보 표출

## 2. 단계별 구체적 구현 명세
1. **WebSocket 스트림 허브 (`backend/common/upbit_ws_hub.mjs`)**:
   - Node.js 22 내장 `WebSocket` 또는 표준 RFC-6455 프레이밍 클라이언트를 사용하여 외부 무거운 의존성 없이 `wss://api.upbit.com/websocket/v1`에 연결합니다.
   - 구독 대상 마켓: 상위 거래대금 유니버스(최대 25개) + 현재 `bot_positions` 및 `paper_bot_positions`의 모든 `OPEN` 포지션 마켓 합집합을 동적 재구독(`updateSubscriptions(markets)`)합니다.
   - 구독 메시지 포맷: `[{"ticket":"autocoin-ws"},{"type":"ticker","codes":[...],"isOnlyRealtime":true},{"type":"orderbook","codes":[...],"isOnlyRealtime":true}]`.
   - `getLatestTicker(market)`, `getLatestOrderbook(market)`, `getWsHealth()` 메서드를 제공하고, 마지막 수신 시각이 `5,000ms`를 초과하면 `isStale: true`를 반환하여 즉시 REST 폴백이 작동하도록 구현합니다.
2. **틱 반응형 스마트 청산 (`backend/node_server.mjs`)**:
   - `upbit_ws_hub`에서 `OPEN` 실전 포지션 보유 마켓의 `trade_price`가 갱신될 때:
     - `liveBotPeakMap`의 최고가를 실시간 갱신합니다.
     - 현재가가 해당 포지션의 `ATR_HARD_STOP`, `ATR_TRAILING_STOP`, `BREAKEVEN_STOP`, 또는 봇별 `stop_loss_pct` 이하로 이탈한 경우 `withDbWriteLock` 및 마켓별 인플라이트 락(`inFlightTickExitSet`) 하에서 즉시 `executeBotSellOrder`를 호출합니다.
3. **프론트엔드 상태 표시 (`frontend/src/App.jsx`)**:
   - `upbitStatus` 상태 객체에 `ws_connected`, `transport_mode`(`"WS"` / `"REST"`)를 반영하여 좌측 상단 상태 인디케이터 옆에 `WS` 마이크로 배지를 렌더링합니다.
4. **예외 처리**:
   - `AUTOCOIN_LIBRARY_MODE === "1"` 테스트 환경에서는 외부 업비트 WebSocket 자동 연결을 비활성화하고 주입된 Mock URL만 연결하도록 방어합니다.
   - WebSocket 소켓 에러/종료 시 프로세스가 크래시(`uncaughtException`)되지 않도록 모든 `error`/`close` 이벤트를 안전하게 포착합니다.

## 3. 프로젝트 절대 준수 규칙
- **국소 수정(Surgical Fix)**: 기존 실계좌 조회, 10대 봇 Arena, 주간 로테이션 & Graceful Drain, 듀얼 AI 브리핑, 통계, 뉴스, 설정 마법사 기능을 절대 훼손하지 마십시오.
- **격리 매도 원칙**: 실전 매도 시 `get_balance()` 전량 조회 매도를 절대 금지하며, 반드시 본인 `bot_id` 및 `order_uuid`에 기록된 `volume`(소수점 8자리 내림 `floorTo8DecimalsStr`)만 매도하십시오.
- **가상 Arena 100% 필터 우회**: `algo_lab_service.mjs`의 10대 봇 가상거래는 LLM 시황 필터(`HOLD_CASH`, `market_regime_filter`) 및 BTC 20MA 하락장 차단을 100% 우회해야 합니다.
- **프론트엔드 안전성**: 모든 `fetch*`, 핸들러, `useCallback`, `useMemo`는 반드시 `useEffect`보다 코드 상단에 선언(React TDZ 방어)하고, 모든 API/SSE 호출은 `"/api/..."` 상대 경로만 사용하십시오.
- **DB 동시성**: SQLite `data/auto_coin_trade.db` 단일 경로 및 `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`을 유지하십시오.
- **버전 규칙**: 커밋 시 `package.json`, `frontend/package.json`, `frontend/src/App.jsx`, `history.md`, `/install` 패키지의 버전을 `0.0.X` 규칙에 맞춰 `+1` 증가 동기화하십시오.

## 4. 검증 및 Git 반영 지침
```bash
node --check backend/common/upbit_ws_hub.mjs
node --check backend/node_server.mjs
python3 -m py_compile *.py agentBot/*.py
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
node tests/verify_upbit_ws_hub.mjs
npm test
python3 tests/qa_python_verification.py
```
- `git status`로 `.env`, `config/upbit_config.json`, `data/*.db` 등 민감 파일이 포함되지 않았는지 확인한 뒤 커밋 및 푸시하십시오:
```bash
git add .
git commit -m "feat: add Upbit WebSocket real-time ticker/orderbook hub with tick-reactive smart exits"
git push origin main
```
````

---

## 🚀 [과제 2 · P0] 업비트 과거 캔들 기반 정량 백테스팅(Backtester) & 워크포워드(Walk-Forward) 검증기

````markdown
# Task: 10대 알고리즘(`bot_01`~`bot_10`) 과거 캔들 기반 정량 백테스팅 & 워크포워드 검증 엔진 구축

당신은 `autoCoinTrade` 프로젝트의 시니어 퀀트 리서치 엔지니어이자 풀스택 아키텍트입니다.
현재 실시간 포워드 가상 매매만 지원하는 `backend/common/algo_lab_service.mjs`의 `evaluateStrategy` 및 `evaluateSmartExit` 순수 수식 엔진을 재사용하여, **업비트 과거 OHLCV 캔들 기반 정량 백테스팅(Backtesting) 및 워크포워드(Walk-Forward) 파라미터 검증 시스템**을 구축하십시오.

## 1. 목표 및 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/backtest_service.mjs`: 과거 캔들 수집·SQLite 로컬 캐싱(`historical_candles` 테이블), 바-바이-바(Bar-by-Bar) 시뮬레이터(미래 참조 Look-Ahead Bias 완전 차단), 수수료(`0.05%`) + 가변 슬리피지(`0.05%~0.15%`) 반영, 성과 지표(총수익률, CAGR, MDD, 승률, 손익비 Profit Factor, Sharpe Ratio, Sortino Ratio, 평균 보유시간) 및 워크포워드(In-Sample 70% / Out-of-Sample 30%) 그리드 검증기
  - `tests/verify_backtest_engine.mjs`: 임시 DB와 결정론적 합성 캔들 데이터를 이용한 Look-Ahead Bias 방지, 수수료/슬리피지 차감, 10대 봇 백테스트 결과 및 API 엔드포인트 검증 스크립트
- **국소 수정(Surgical Edit)**:
  - `backend/node_server.mjs`, `init_db.py`, `backend/common/pg_sync.mjs`: `historical_candles` 및 `backtest_runs` 테이블 스키마/마이그레이션 추가, `POST /api/backtest/run`, `GET /api/backtest/history`, `POST /api/backtest/apply-params` 엔드포인트 추가
  - `frontend/src/App.jsx`, `frontend/src/styles.css`: `🏆 가상거래 경쟁` 메뉴 상단 툴바에 `[📊 과거 캔들 백테스트]` 모달/드로어 추가 (대상 봇 `bot_01`~`bot_10`, 마켓, 기간 7일/30일/90일, 슬리피지 bps 설정, 에쿼티 커브 SVG 차트, 주요 정량 지표 카드, `[이 파라미터를 봇 설정에 적용]` 버튼)

## 2. 단계별 구체적 구현 명세
1. **DB 스키마 확장 (`backend/node_server.mjs`, `init_db.py`, `backend/common/pg_sync.mjs`)**:
   - `historical_candles`: `(market TEXT, unit TEXT, candle_time_kst TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY (market, unit, candle_time_kst))` — 한 번 조회한 과거 캔들을 로컬 캐싱하고 업비트 `120ms` Rate Limit을 엄격히 준수합니다.
   - `backtest_runs`: `(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, markets_json TEXT, unit TEXT, start_date TEXT, end_date TEXT, initial_capital INTEGER, final_equity INTEGER, total_return_pct REAL, mdd_pct REAL, win_rate_pct REAL, profit_factor REAL, sharpe_ratio REAL, trade_count INTEGER, params_json TEXT, equity_curve_json TEXT, trades_json TEXT, created_at TEXT)`.
2. **백테스팅 & 워크포워드 엔진 (`backend/common/backtest_service.mjs`)**:
   - 시점 `t` 평가 시 반드시 `0 .. t`까지의 캔들 슬라이스만 `buildIndicators` 및 `evaluateStrategy(botId, mdSlice, indSlice, openPositions, { params, isLive: false })`에 전달하여 미래 데이터 참조(Look-Ahead Bias)를 원천 차단합니다.
   - 매수 체결가는 `close * (1 + slippageBps / 10000)`, 매도 체결가는 `close * (1 - slippageBps / 10000)`를 적용하고 양방향 수수료 `0.05%`를 차감합니다.
   - `bot_06` 및 `bot_10`의 다단계 분할 매수(포지션별 독립 `peakPrice` 및 동일 캔들 재진입 금지) 규칙을 `runPaperBot`과 100% 동일하게 적용합니다.
3. **프론트엔드 백테스트 UI (`frontend/src/App.jsx`, `frontend/src/styles.css`)**:
   - `🏆 가상거래 경쟁` 상단 버튼 그룹(`flex-wrap: nowrap`)에 `[📊 백테스트 검증]` 버튼을 추가하고, 실행 결과를 한국 금융 표준 색상(이익 `#ef4444`, 손실 `#3b82f6`, 보합 회색) 및 SVG 누적 자산 곡선으로 시각화합니다.

## 3. 프로젝트 절대 준수 규칙
- **국소 수정(Surgical Fix)**: 기존 5대 메뉴와 실시간 매매/아레나 루프를 절대 훼손하지 마십시오.
- **격리 매도 & 원장 분리**: 백테스트는 오직 인메모리 및 `backtest_runs` 테이블만 사용하며, `trades`, `bot_positions`, `paper_trades`, `paper_bot_positions`를 절대 오염시키지 마십시오.
- **프론트엔드 안전성**: 모든 `fetch*`, 핸들러, `useCallback`, `useMemo`는 반드시 `useEffect`보다 상단에 선언(React TDZ 방어)하고, 모든 API 호출은 `"/api/..."` 상대 경로만 사용하십시오.
- **DB 동시성**: SQLite `data/auto_coin_trade.db` 단일 경로 및 `WAL` / `NORMAL` / `busy_timeout=5000`을 유지하십시오.
- **버전 규칙**: 커밋 시 프로젝트 버전을 `0.0.X` 규칙에 맞춰 `+1` 증가 동기화하십시오.

## 4. 검증 및 Git 반영 지침
```bash
node --check backend/common/backtest_service.mjs
node --check backend/common/algo_lab_service.mjs
node --check backend/node_server.mjs
python3 -m py_compile *.py agentBot/*.py
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
node tests/verify_backtest_engine.mjs
npm test
python3 tests/qa_python_verification.py
```
- `git status`로 민감 파일 제외 확인 후 커밋 및 푸시하십시오:
```bash
git add .
git commit -m "feat: add historical candle backtesting and walk-forward validation engine"
git push origin main
```
````

---

## 🚀 [과제 3 · P1] 호가창 불균형(OBI) · 멀티 타임프레임(MTF) 필터 · ATR 변동성 역가중 포지션 사이징 & 슬리피지 원장

````markdown
# Task: 호가창 불균형(OBI) · 멀티 타임프레임 필터 · ATR 변동성 역가중 포지션 사이징 및 슬리피지 분석 고도화

당신은 `autoCoinTrade` 프로젝트의 시니어 퀀트 전략 아키텍트입니다.
현재 고정 비율(`order_ratio`)과 단일 타임프레임 위주로 동작하는 주문 사이징 및 진입 필터를 고도화하여, **호가창 매수/매도 잔량 불균형(Orderbook Imbalance) 및 스프레드 가드, 멀티 타임프레임(15m+1h+4h) 추세 정렬 필터, ATR 변동성 역가중 포지션 사이징(Volatility-Targeted Sizing), 그리고 예상 체결가 대비 실체결 슬리피지(Slippage bps) 기록 원장**을 구현하십시오.

## 1. 목표 및 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/execution_quality_service.mjs`: 업비트 호가창(`/v1/orderbook`) 상위 5호가 기반 스프레드(`spread_pct`), 호가 불균형 지수(`obi = (bid_vol - ask_vol) / (bid_vol + ask_vol)`), 주문 금액 대비 예상 시장 충격(Market Impact bps) 산출 및 ATR 기반 변동성 역가중 사이징 계산 모듈
  - `tests/verify_execution_quality_and_sizing.mjs`: OBI/스프레드 차단, 고변동성 코인 비중 자동 축소, 슬리피지 bps 원장 기록 검증 테스트
- **국소 수정(Surgical Edit)**:
  - `backend/common/algo_lab_service.mjs`: `buildIndicators`에 상위 타임프레임(1시간봉 EMA20/60 및 4시간봉 SuperTrend/MA20) 멀티 타임프레임(MTF) 컨플루언스 지표를 추가하여 추세/돌파형 봇(`bot_01`~`bot_04`, `bot_07`, `bot_09`) 진입 시 상위 추세 역행 진입 차단
  - `backend/node_server.mjs`, `init_db.py`, `backend/common/pg_sync.mjs`:
    - `trades` 및 `bot_positions`에 `expected_price REAL`, `slippage_bps REAL`, `atr_sizing_mult REAL` 컬럼 자동 `ALTER TABLE` 마이그레이션 추가
    - `getSafeOrderKrw`에 ATR 변동성 역가중 계수(`target_atr_pct = 1.8%` 대비 현재 코인 `atr_pct`가 높으면 비중을 `0.5x ~ 1.0x`로 자동 축소하되 최소 안전 주문 금액 `5,250원` 보장) 연동
    - 실전 매수(`executeBotBuyOrder`) 직전 스프레드 `> 0.35%` 또는 심각한 매도벽 불균형(`obi < -0.45`) 시 추격 매수 보류 가드 추가
  - `frontend/src/App.jsx`: `📈 통계` 및 `⚡ 실제거래 현황` 체결 테이블에 평균 슬리피지(bps) 및 실행 품질 배지 표출

## 2. 단계별 구체적 구현 명세
1. **호가창 불균형(OBI) 및 스프레드 필터 (`backend/common/execution_quality_service.mjs`)**:
   - 상위 5호가 매수 잔량 합(`bidSize5`)과 매도 잔량 합(`askSize5`), 최우선 매도호가(`ask1`)와 매수호가(`bid1`)를 분석합니다:
     - `spreadPct = ((ask1 - bid1) / bid1) * 100`
     - `obi = (bidSize5 - askSize5) / (bidSize5 + askSize5)` (`-1.0 ~ +1.0`)
   - 돌파형 봇 실전 매수 시 `spreadPct > 0.35%`이거나 `obi < -0.45`(상단 매도벽 과다)이면 진입을 보류합니다.
2. **ATR 변동성 역가중 사이징 (`getSafeOrderKrw`)**:
   - `atrPct = (atr14 / currentPrice) * 100`일 때, `volMult = Math.max(0.5, Math.min(1.0, 1.8 / Math.max(0.5, atrPct)))`를 산출하여 기본 주문 금액에 곱하되, 가용 원화가 충분할 경우 업비트 최소 매도 데드락 방지 하한선(`5,250원`) 이상을 항상 유지합니다.
3. **슬리피지 원장 기록**:
   - 주문 발주 시점의 기준가(`expected_price`)와 실제 체결 정산 단가(`avg_buy_price` / `sell_price`)의 차이인 `slippage_bps = ((executed - expected) / expected) * 10000`을 `trades`에 기록하고 `/api/statistics` 응답에 `avg_slippage_bps`를 포함합니다.

## 3. 프로젝트 절대 준수 규칙
- **국소 수정(Surgical Fix)**: 기존 10대 봇 전략 시그널 구조, 주간 로테이션 & Graceful Drain Zero-Sum, 듀얼 AI 게이트웨이, 설정 마법사를 절대 훼손하지 마십시오.
- **가상 Arena 독립성**: 가상거래(Always-On Arena)는 시황 필터 및 실전 호가 API 지연을 타지 않고 상시 가동되어야 합니다.
- **격리 매도 원칙**: 실전 매도는 반드시 해당 `bot_id` 및 `order_uuid`의 `volume`(8자리 내림)만 매도하십시오.
- **프론트엔드 안전성**: React TDZ 방어(`useEffect` 상단 선언) 및 상대 경로 `"/api/..."` 규칙을 엄수하십시오.
- **버전 규칙**: 커밋 시 버전을 `0.0.X` 규칙에 맞춰 `+1` 증가 동기화하십시오.

## 4. 검증 및 Git 반영 지침
```bash
node --check backend/common/execution_quality_service.mjs
node --check backend/common/algo_lab_service.mjs
node --check backend/node_server.mjs
python3 -m py_compile *.py agentBot/*.py
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
node tests/verify_execution_quality_and_sizing.mjs
npm test
python3 tests/qa_python_verification.py
```
- `git status`로 민감 파일 제외 확인 후 커밋 및 푸시하십시오:
```bash
git add .
git commit -m "feat: add orderbook imbalance guard, MTF filter, ATR volatility sizing, and slippage ledger"
git push origin main
```
````

---

## 🚀 [과제 4 · P1] 텔레그램/디스코드 실시간 체결·리스크 알림 허브 & 캔들 차트 타점(BUY/SELL)·트레이드 저널 UI

````markdown
# Task: 멀티채널 실시간 알림 허브(Telegram · Discord · WebPush) 및 캔들 차트 매매 타점(BUY/SELL)·트레이드 저널 UI 구축

당신은 `autoCoinTrade` 프로젝트의 시니어 풀스택 엔지니어입니다.
현재 브라우저 WebPush에만 국한된 알림 체계를 **Telegram Bot API 및 Discord Webhook 멀티채널 실시간 알림 허브**로 확장하고, 대시보드에 **캔들 차트 위 매수/매도 타점(BUY/SELL 마커) 및 보조지표(VWAP·LRC·BB·20MA) 오버레이 뷰어와 전략별 MFE/MAE 트레이드 저널**을 구현하십시오.

## 1. 목표 및 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/notification_hub.mjs`: Telegram Bot(`sendMessage`)·Discord Webhook·WebPush 통합 발송 큐(Rate Limit 방어, 비동기 논블로킹, 실패 시 2회 재시도, 민감정보 마스킹)
  - `tests/verify_notification_hub_and_journal.mjs`: Mock Telegram/Discord HTTP 서버를 통한 체결/서킷브레이커/로테이션/일일정산 알림 발송 및 타점 API 검증 테스트
- **국소 수정(Surgical Edit)**:
  - `backend/node_server.mjs`, `init_db.py`, `backend/common/pg_sync.mjs`:
    - `system_settings`에 알림 설정 키(`telegram_bot_token`, `telegram_chat_id`, `discord_webhook_url`, `notify_on_trade`, `notify_on_risk`, `notify_daily_report`) 지원(단, JSON Export 시 토큰/웹훅 URL은 민감 키 제외 목록 `EXCLUDED_SECRET_SETTING_KEYS`에 추가하여 유출 차단!)
    - `GET /api/settings/notifications`, `PUT /api/settings/notifications`, `POST /api/settings/notifications/test` 엔드포인트 추가
    - `GET /api/chart/trade-markers?market=KRW-BTC&bot_id=all&mode=live&unit=15`: 해당 종목의 최근 120개 캔들 + VWAP/LRC/20MA 좌표 + 해당 구간 내 매수(`BUY` ▲ `#ef4444`)·매도(`SELL` ▼ `#3b82f6`) 체결 타점 목록 반환
    - 실전 매수/매도 체결, 일일 서킷 브레이커(`-4.0%`) 발동, 잔고 0원 비상 정지, 주간 로테이션 & Graceful Drain 정산 이관, 매일 09:00 KST 일일 손익 리포트 발생 시 `notification_hub` 호출
  - `frontend/src/App.jsx`, `frontend/src/styles.css`:
    - `⚡ 실제거래 현황` 및 `📈 통계`의 체결 행 클릭 시 해당 종목의 **인터랙티브 SVG 캔들스틱 + VWAP/LRC/20MA + BUY/SELL 타점 마커 차트** 드로어 표시
    - `⚙️ 설정` 화면에 **실시간 알림 채널(Telegram / Discord / WebPush) 설정 및 `[🔔 테스트 알림 발송]` 카드** 추가

## 2. 단계별 구체적 구현 명세
1. **멀티채널 알림 허브 (`backend/common/notification_hub.mjs`)**:
   - 모든 알림 호출은 매매 루프를 절대 지연시키지 않도록 `AbortSignal.timeout(4000)` 및 비동기 큐로 처리합니다.
   - 이벤트 유형: `LIVE_BUY`, `LIVE_SELL`, `DRAIN_HANDOFF`, `CIRCUIT_BREAKER`, `ZERO_BALANCE_HALT`, `WEEKLY_ROTATION`, `DAILY_SUMMARY`.
2. **캔들 차트 + 매매 타점 시각화 (`frontend/src/App.jsx`)**:
   - 외부 무거운 차트 라이브러리 추가 없이, 프로젝트의 다크 테마와 한국 금융 색상 표준(양봉/매수타점/이익 `#ef4444` 빨강, 음봉/매도타점/손실 `#3b82f6` 파랑, VWAP `#f59e0b`, LRC 상·하단 `#38bdf8`)을 따르는 고해상도 반응형 SVG 캔들 차트 컴포넌트를 구현합니다.
   - 각 타점 마커 위에 마우스를 올리면 `[봇 별명 | 매수/매도가 | 수량 | 실현손익 | 진입/청산 사유(buy_reason/sell_reason)]` 툴팁을 표시합니다.
3. **보안 처리**:
   - `telegram_bot_token` 및 `discord_webhook_url`은 API 조회 시 마스킹(`••••`) 처리하고, `/api/settings/export` 백업에서 제외하며 `/api/settings/import-json` 복원 시 기존 저장값을 보존합니다.

## 3. 프로젝트 절대 준수 규칙
- **국소 수정(Surgical Fix)**: 기존 5대 메뉴 기능, 10대 봇 Arena, 주간 로테이션, 듀얼 AI 스트리밍을 절대 훼손하지 마십시오.
- **프론트엔드 안전성**: 모든 `fetch*`, 핸들러, `useCallback`, `useMemo`는 반드시 `useEffect`보다 상단에 선언(React TDZ 방어)하고, 모든 API 호출은 `"/api/..."` 상대 경로만 사용하십시오.
- **DB 동시성 및 격리 매도**: SQLite WAL 모드 및 `order_uuid` 기반 격리 매도 원칙을 유지하십시오.
- **버전 규칙**: 커밋 시 버전을 `0.0.X` 규칙에 맞춰 `+1` 증가 동기화하십시오.

## 4. 검증 및 Git 반영 지침
```bash
node --check backend/common/notification_hub.mjs
node --check backend/node_server.mjs
python3 -m py_compile *.py agentBot/*.py
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
node tests/verify_notification_hub_and_journal.mjs
npm test
python3 tests/qa_python_verification.py
```
- `git status`로 민감 파일 제외 확인 후 커밋 및 푸시하십시오:
```bash
git add .
git commit -m "feat: add Telegram/Discord notification hub and candlestick trade-marker chart UI"
git push origin main
```
````

---

## 🚀 [과제 5 · P1] AES-256-GCM API 키 암호화 볼트(Vault) · Docker Compose 배포 · GitHub Actions CI/CD 파이프라인

````markdown
# Task: AES-256-GCM API 키 암호화 볼트(Vault) · Docker Compose 컨테이너화 · GitHub Actions CI/CD 파이프라인 구축

당신은 `autoCoinTrade` 프로젝트의 시니어 DevSecOps 및 보안 아키텍트입니다.
현재 디스크(`config/upbit_config.json`, `system_settings`)에 평문으로 저장되는 업비트/Gemini API 키를 **AES-256-GCM 인증 암호화 볼트(Vault)**로 보호하고, **Docker Compose 원클릭 컨테이너 실행 환경**과 **GitHub Actions 자동 문법·빌드·QA 테스트 CI 파이프라인**을 구축하십시오.

## 1. 목표 및 작업 범위 (대상 파일)
- **신규 생성**:
  - `backend/common/crypto_vault.mjs`: Node.js 내장 `node:crypto` 기반 `AES-256-GCM` 암·복호화(`enc:v1:<iv_hex>:<tag_hex>:<cipher_hex>`), `data/.vault_master_key`(권한 `0600`) 또는 환경변수 `AUTOCOIN_MASTER_KEY` 기반 키 파생(PBKDF2-HMAC-SHA256), 평문 레거시 값 투명 자동 마이그레이션 및 Python 호환 복호화 지원
  - `Dockerfile`, `docker-compose.yml`, `.dockerignore`: Node.js 22 LTS 기반 멀티스테이지 프로덕션 이미지(`backend:8001` + `frontend:9000` 통합 또는 서비스 분리, `data/` 및 `logs/` 볼륨 마운트, 헬스체크 내장)
  - `.github/workflows/ci.yml`: Push 및 Pull Request 시 Node 22 + Python 3.11 환경에서 문법 검사(`node --check`, `py_compile`), 프론트엔드 프로덕션 빌드(`npm run build`), 전체 자동화 QA 스위트(`npm test`, `python3 tests/qa_python_verification.py`) 자동 실행
  - `tests/verify_crypto_vault.mjs`: AES-256-GCM 암·복호화, 변조 감지(Auth Tag 검증), 평문→암호문 무중단 마이그레이션 검증 테스트
- **국소 수정(Surgical Edit)**:
  - `backend/node_server.mjs`, `llm_filter_worker.py`: `config/upbit_config.json`의 `access_key`, `secret_key`, `gemini_api_key` 및 `system_settings`의 `gemini_api_key` 저장 시 `encryptSecret()` 적용, 로드 시 `decryptSecret()` 적용 (이미 `enc:v1:` 접두사가 있으면 복호화, 평문이면 정상 읽은 뒤 암호화 마이그레이션)
  - `.gitignore`: `data/.vault_master_key`, `install/app/data/.vault_master_key` 추가

## 2. 단계별 구체적 구현 명세
1. **AES-256-GCM 암호화 볼트 (`backend/common/crypto_vault.mjs`)**:
   - 마스터 키는 `process.env.AUTOCOIN_MASTER_KEY`를 최우선 참조하고, 미설정 시 `data/.vault_master_key`에 32바이트 난수 hex를 자동 생성(파일 퍼미션 `0o600`)합니다.
   - 암호문 포맷: `enc:v1:<12byte_iv_hex>:<16byte_auth_tag_hex>:<ciphertext_hex>`.
   - `decryptSecret(val)`은 `val`이 `enc:v1:`로 시작하지 않으면 기존 평문으로 간주하여 그대로 반환함으로써 기존 사용자의 무중단 하위 호환성을 100% 보장합니다.
   - Python `llm_filter_worker.py`에서도 동일 포맷을 복호화하거나 평문/환경변수 폴백이 동작하도록 호환 헬퍼를 추가합니다.
2. **Docker Compose & CI/CD (`Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`)**:
   - `docker-compose.yml`은 기본 SQLite WAL 모드(`DB_MODE=sqlite`, `PG_SYNC_ENABLED=false`)로 즉시 기동되며, `./data:/app/data` 및 `./logs:/app/logs` 볼륨을 영속화합니다.
   - `.github/workflows/ci.yml`은 `main` 브랜치 Push/PR마다 실행되어 단 1건의 문법 오류나 QA 회귀도 유입되지 않도록 게이트키핑합니다.

## 3. 프로젝트 절대 준수 규칙
- **국소 수정(Surgical Fix)**: 기존 API 키 입력 UI(설정 마법사 및 상단 API 키 모달)와 실계좌/AI 브리핑 동작이 사용자 관점에서 100% 동일하게 작동해야 합니다.
- **보안 절대 원칙**: `.env`, `config/upbit_config.json`, `data/*.db`, `data/.session_secret`, `data/.vault_master_key`가 절대 Git에 추적되지 않도록 `.gitignore`에 명시하십시오.
- **프론트엔드 안전성**: React TDZ 방어 및 상대 경로 `"/api/..."` 규칙을 유지하십시오.
- **버전 규칙**: 커밋 시 버전을 `0.0.X` 규칙에 맞춰 `+1` 증가 동기화하십시오.

## 4. 검증 및 Git 반영 지침
```bash
node --check backend/common/crypto_vault.mjs
node --check backend/node_server.mjs
python3 -m py_compile *.py agentBot/*.py
cd frontend && npm run build && cd ..
./scripts/build_install_package.sh
node tests/verify_crypto_vault.mjs
npm test
python3 tests/qa_python_verification.py
```
- `git status`로 민감 파일 제외 확인 후 커밋 및 푸시하십시오:
```bash
git add .
git commit -m "feat: add AES-256-GCM API key vault, Docker Compose support, and GitHub Actions CI"
git push origin main
```
````
