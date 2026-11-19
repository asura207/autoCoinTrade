# 업비트(Upbit) Open API 기반 다중 전략 코인 자동매매 & 실시간 AI 퀀트 시스템 종합 구축 및 검수 명세서 (prompt.md)

> **작성 목적**: 본 문서는 업비트 Open API, Google Gemini AI, 고성능 경량 Node.js 22(Native SQLite WAL + PostgreSQL 16 Dual DB) 및 React 18 프리미엄 다크 테마 UI를 결합하여 현재까지 완성된 **10대 봇 아레나(10-Bot Arena), 매주 일요일 09:00 기점 LLM 주간 최적 봇 자동 회전 편성, 초강력 하락장 방어 및 더스트 정화(Buy-to-Cleanse), 계좌 10% 안전 버퍼 보존 로직**을 다른 AI Agent 또는 시니어 개발자가 100% 동일하게 재현·구현하고, **독립적으로 소스 코드를 감사 및 검수(Audit & Review)**할 수 있도록 작성된 종합 아키텍처 및 구현 가이드라인입니다.

---

## 1. 시스템 핵심 아키텍처 및 기술 스택

### 1.1 기술 스택 (Tech Stack)
- **Backend Runtime**: Node.js (`v22.5.0+`, Native ES Module `.mjs`, Native `node:http`, Native `node:sqlite` DatabaseSync WAL 모드, Native `node:crypto`, Port `8001`; `LIVE_EXECUTOR_OWNER=node` 기본 단일 실전 실행권 강제)
  - 비동기 봇 매매 루프 (8~10초 주기) + **업비트 WebSocket(`wss://api.upbit.com/websocket/v1`) 실시간 스트림 허브 & 틱 반응형 즉시 스마트 청산(`1,500ms` 디바운스)** (지연/단절 시 REST 자동 폴백)
  - **5중 실전 중복 주문 차단 하드 가드레일 (`backend/common/live_order_guardrail.mjs`)**: 단일 실행 주체 + SQLite `live_executor_lease` 리스 락, `live_order_intents` 2PC `PENDING` 선차감 + 업비트 `identifier` 멱등성·타임아웃 정산, `(bot_id, market)` Async Mutex, 쿨다운·시간/일일 하드 캡, 이상 감지 비상 정지
  - **로컬 Ollama (`qwen3-news`, `120s` 타임아웃) 1순위 + Gemini Dual AI(Flash 30분 / Pro 1시간) + BTC 20MA 기계적 안전 모드 3중 Fallback** 및 SSE 실시간 스트리밍
  - 구글 뉴스 & 토큰포스트 RSS 실시간 수집 및 감성 분석 백그라운드 워커 (30분 주기)
  - 10대 알고리즘 아레나(10-Bot Arena) 24시간 상시 가상 경쟁 엔진 + **Zero Look-Ahead 과거 캔들 백테스팅·Walk-Forward(70/30) 검증기**
  - 호가창 불균형(OBI)·스프레드 가드·MTF(60m/240m) 역추세 차단·ATR 변동성 역가중 포지션 사이징 및 슬리피지(`slippage_bps`) 원장
  - 주간 전략군 TOP 1 자동 로테이션 & Graceful Drain 자금 이관 스케줄러
  - **멀티채널 알림 허브 (`backend/common/notification_hub.mjs`)**: Telegram Bot API · Discord Webhook · Web Push (VAPID) 통합 실시간 발송
- **Frontend Runtime**: React 18+, Vite 8 빌드 및 프로덕션 정적 서버(`frontend/server.mjs`, Port `9000`, `/api` SSE 리버스 프록시 및 경로 역추적/dotfile 차단)
  - 프리미엄 다크 테마 UI (Pretendard 폰트 기반, `#0b0f19` 배경, 2:8 화면 분할 및 모바일 반응형 1열 전환)
  - 상대 경로(`API_BASE = ""`) 및 `HttpOnly` 서명 세션 쿠키(`autoCoinTrade_session`) 전역 `/api/*` 인증 게이트
  - 5중 가드레일 헤더 배지·상세 모달, `WS 실시간`/`REST 폴백` 배지, `[📊 백테스트 검증]` 모달, 체결 `[📈 타점]` 캔들스틱 차트 모달, 뉴스 50건 페이징(48px 고정 1줄 말줄임)
- **Dual Database Architecture (SQLite WAL + PostgreSQL 16)**:
  - **기본 실시간 DB**: SQLite (`data/auto_coin_trade.db`, WAL 저널 모드, `busy_timeout=5000`)
  - **동기화 및 백업 DB**: PostgreSQL 16 (`coin_trader` 데이터베이스)
  - **환경별 동적 분기 (`.env`)**: `LOCATION=local` (로컬 `127.0.0.1:5432`) 또는 `LOCATION=outer` (외부 접속 주소 및 포트) 설정에 따라 자동 연결
  - **백그라운드 동기화 매니저 (`backend/common/pg_sync.mjs`)**: 전체 21개 핵심 테이블의 스키마 생성 및 변경 내역을 PostgreSQL에 실시간 UPSERT 무결성 동기화
- **배포 · CI 및 외부 접속 지원**:
  - 비루트 멀티스테이지 `Dockerfile` + `docker-compose.yml`, GitHub Actions CI(`.github/workflows/ci.yml`), `/install` 원클릭 독립 배포 패키지
  - Cloudflare Quick Tunnel (`start_tunnel.sh` / `stop_tunnel.sh`) 및 WireGuard VPN (`scripts/setup_wireguard.sh`)
- **암호화 및 시크릿 보안**:
  - 업비트 Access/Secret Key, Gemini API Key, Telegram/Discord 시크릿은 Node.js↔Python 상호 복호화 호환 **AES-256-GCM 암호화 볼트 (`backend/common/crypto_vault.mjs`, `enc:v1:...`, `0600`)** 로 저장하며 `.env` 및 `config/upbit_config.json`은 `.gitignore`로 Git 추적 제외

---

## 2. 디렉토리 및 파일 구조

```text
autoCoinTrade/
├── agentBot/
│   ├── __init__.py
│   └── bot_10_jack_kellogg.py           # [Python] Bot 10 Jack Kellogg VWAP + 선형 회귀 채널
├── backend/
│   ├── node_server.mjs                  # [메인 백엔드] Node.js 22 SQLite + Upbit API + Dual AI(Ollama/Gemini) + REST/SSE + 봇 엔진
│   └── common/
│       ├── algo_lab_service.mjs         # 10대 알고리즘 아레나 시뮬레이션, 지표 계산, 랭킹 및 주간 로테이션 엔진
│       ├── backtest_service.mjs         # Zero Look-Ahead 과거 캔들 백테스팅 & Walk-Forward(70/30) 검증기
│       ├── crypto_vault.mjs             # Node.js ↔ Python 호환 AES-256-GCM 암호화 볼트 (enc:v1:...)
│       ├── execution_quality_service.mjs# 호가창 OBI · 스프레드 가드 · MTF 필터 · ATR 역가중 포지션 사이징
│       ├── live_order_guardrail.mjs     # 5중 실전 중복 주문 차단 하드 가드레일 (리스 락 · 2PC · 뮤텍스 · 하드 캡)
│       ├── log_rotator.mjs              # KST 일일 로그 로테이션 및 7일 보존 정책 유틸리티
│       ├── news_service.mjs             # 구글 뉴스 & 토큰포스트 RSS 파싱, 30분 주기 감성 분석, 태그 추출
│       ├── notification_hub.mjs         # Telegram / Discord / WebPush 통합 멀티채널 알림 디스패처
│       ├── pg_db.mjs                    # PostgreSQL 비동기 풀 및 SQL 변환 어댑터
│       ├── pg_sync.mjs                  # PostgreSQL 16 실시간 테이블 데이터 동기화 매니저
│       ├── sqlite_db.mjs                # Node.js 내장 node:sqlite WAL 연결 관리 및 경로 해석
│       └── upbit_ws_hub.mjs             # [메인] 업비트 WebSocket 실시간 스트림 허브 & REST 자동 폴백
├── config/
│   ├── upbit_config.json                # 업비트·Gemini·Ollama·가드레일 설정 (AES-256-GCM 암호화, Git 제외)
│   └── upbit_config.example.json        # 설정 파일 템플릿
├── data/
│   └── auto_coin_trade.db               # 로컬 SQLite 데이터베이스 (WAL 모드, Git 제외)
├── docs/
│   ├── QA_CHECKLIST.md                  # 전수 QA 체크리스트 및 검증 결과 보고서
│   └── ENHANCEMENT_PROMPTS.md           # 기관급 퀀트 고도화 명세서
├── frontend/
│   ├── src/
│   │   ├── App.jsx                      # 메인 React 컴포넌트 (5대 메뉴, 가드레일/백테스트/타점 차트 모달, SSE)
│   │   ├── main.jsx                     # React 엔트리포인트
│   │   └── styles.css                   # 다크 테마, 2:8 레이아웃, 모바일 반응형, 48px 고정 테이블
│   ├── server.mjs                       # 프로덕션 정적 번들 서버 + /api SSE 리버스 프록시 (Port 9000)
│   ├── index.html
│   ├── package.json
│   └── vite.config.js                   # 개발 서버(127.0.0.1) 및 /api 프록시 설정
├── install/                             # 비개발자용 Windows/Linux 원클릭 독립 배포 패키지
├── scripts/
│   ├── build_install_package.sh         # /install 독립 패키지 동기화 스크립트 (시크릿/DB 제외)
│   ├── install_startup.bat / uninstall_startup.bat # [Windows] 시작프로그램 등록/해제
│   ├── setup_postgresql.sh              # PostgreSQL 16 계정 및 데이터베이스 자동 설정
│   ├── setup_wireguard.sh / harden_ssh.sh # 원격 VPN 및 서버 보안 하드닝
│   ├── migrate_sqlite_to_pg.py          # SQLite -> PostgreSQL 데이터 마이그레이션
│   ├── run_backend.sh / .bat            # 백엔드 단독 구동 스크립트
│   ├── run_frontend.sh / .bat           # 프론트엔드 단독 구동 스크립트
│   └── start_silent.vbs                 # [Windows] 콘솔 창 없는 무음 백그라운드 런처
├── tests/                               # Node 11종 + Python QA 자동화 검증 스위트 (가드레일 스트레스 테스트 포함)
├── .github/workflows/ci.yml             # GitHub Actions CI 자동 검증 파이프라인
├── Dockerfile / docker-compose.yml      # 비루트 멀티스테이지 Docker 배포 구성
├── bots.py / main_orchestrator.py       # Python 독립 봇 엔진 및 멀티프로세싱 오케스트레이터 (LIVE_EXECUTOR_OWNER 준수)
├── llm_filter_worker.py                 # Python 로컬 Ollama + Gemini Dual AI 워커
├── market_hub.py                        # [Python 독립 전용] REST 중앙 시세 캐시 (Node upbit_ws_hub.mjs와 분리)
├── init_db.py                           # SQLite 초기화 및 전체 21개 테이블 자동 마이그레이션
├── setup.sh / setup.bat                 # 원클릭 환경 구축 스크립트 (Linux / Windows)
├── start_services.sh / start_services.bat # 공식 서비스 시작 스크립트 (Backend 8001 + Frontend 9000)
├── stop_services.sh / stop_services.bat # 공식 서비스 안전 종료 스크립트
├── run_orchestrator.sh / .bat           # Python 오케스트레이터 실행 스크립트
├── start_tunnel.sh / stop_tunnel.sh     # Cloudflare HTTPS 보안 터널 시작/종료
├── .env.example                         # 환경 변수 템플릿 (LIVE_EXECUTOR_OWNER, OLLAMA_*, PG 등)
├── README.md / howtorun.md / SETUP_GUIDE.md / history.md / initRule.md / prompt.md
```

---

## 3. 데이터베이스 21개 테이블 스키마 명세 (SQLite & PostgreSQL 16)

`PRAGMA journal_mode = WAL;`, `PRAGMA busy_timeout = 5000;`을 필수로 적용하며, 아래 21개 테이블(핵심 운영 11종 + 자산/로테이션/계정 5종 + 백테스트 2종 + 5중 실전 가드레일 3종)을 구성해야 합니다:

### 3.1 시스템 설정 및 봇 마스터
1. **`system_settings`**:
   * `key` (TEXT PRIMARY KEY) - 예: `total_capital`, `entry_code`, `llm_weekly_bot_selection_last_slot`, `llm_weekly_bot_selection_last_run`, `llm_weekly_bot_selection_result`
   * `value` (TEXT NOT NULL)
   * `updated_at` (TEXT NOT NULL)

2. **`bots` (10대 봇 마스터 & 실전/모의 겸용 테이블)**:
   * `bot_id` (TEXT PRIMARY KEY) - `bot_01` ~ `bot_10`
   * `name` (TEXT NOT NULL) - 공식 전략 명칭
   * `nickname` (TEXT NOT NULL) - 사용자 및 AI 식별 별명 (예: `돌파봇-알파`, `눌림목봇-에타`)
   * `strategy_type` (TEXT NOT NULL) - 예: `VOLATILITY_BREAKOUT`, `MA20_PULLBACK`, `RSI_VWAP_SCALPER` 등
   * `description` (TEXT NOT NULL)
   * `allocation_ratio` (REAL NOT NULL DEFAULT 0) - 실전 자금 배분 비율 (0.0 ~ 1.0, 1~3위 합계 1.0)
   * `allocated_capital` (INTEGER NOT NULL DEFAULT 0) - 실전 할당 총 원금 (KRW, 업비트 자산 90% 기준)
   * `virtual_krw` (INTEGER NOT NULL DEFAULT 0) - 실전 가용 잔액 (KRW)
   * `is_running` (INTEGER NOT NULL DEFAULT 0) - 실전 매매 가동 여부 (1~3위 봇만 1, 나머지 0)
   * `is_selected_for_live` (INTEGER NOT NULL DEFAULT 0) - 주간 선발 여부 (1: 실전 담당, 0: 모의 전용)
   * `min_volume_krw` (INTEGER NOT NULL DEFAULT 5000) - 최소 1회 주문 금액
   * `stop_loss_pct` (REAL NOT NULL DEFAULT 0) - 손절 기준율 (%)
   * `take_profit_pct` (REAL NOT NULL DEFAULT 0) - 익절 기준율 (%)
   * `config_json` (TEXT NOT NULL DEFAULT '{}') - 세부 전략 파라미터
   * `last_status_msg` (TEXT NOT NULL DEFAULT '대기 중')
   * `paper_initial_capital` (INTEGER NOT NULL DEFAULT 1000000) - 모의투자 초기 원금 (1,000,000원)
   * `paper_virtual_krw` (INTEGER NOT NULL DEFAULT 1000000) - 모의투자 가용 잔액
   * `paper_is_running` (INTEGER NOT NULL DEFAULT 1) - 모의투자 24시간 연속 가동 여부 (상시 1)
   * `paper_peak_equity` (INTEGER NOT NULL DEFAULT 1000000) - 모의투자 최고 평가자산 (MDD 계산용)
   * `paper_mdd_pct` (REAL NOT NULL DEFAULT 0.0) - 모의투자 누적 최대 낙폭 (MDD %)
   * `paper_status_msg` (TEXT NOT NULL DEFAULT '감시 중')
   * `updated_at` (TEXT NOT NULL)

### 3.2 실거래 전용 원장 테이블 (Live Trading)
3. **`trades` (실제 체결 내역)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `bot_id` (TEXT NOT NULL), `market` (TEXT NOT NULL)
   * `buy_order_uuid` (TEXT NOT NULL), `sell_order_uuid` (TEXT)
   * `buy_price` (REAL NOT NULL), `buy_volume` (TEXT NOT NULL), `buy_amount` (INTEGER NOT NULL), `buy_date` (TEXT NOT NULL)
   * `sell_price` (REAL), `sell_volume` (TEXT), `sell_amount` (INTEGER), `sell_date` (TEXT)
   * `profit_krw` (INTEGER), `profit_pct` (REAL)
   * `status` (TEXT NOT NULL DEFAULT 'HOLDING') - `HOLDING` 또는 `CLOSED`

4. **`bot_positions` (실제 보유 포지션)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `bot_id` (TEXT NOT NULL), `market` (TEXT NOT NULL), `order_uuid` (TEXT NOT NULL UNIQUE)
   * `volume` (TEXT NOT NULL), `avg_buy_price` (REAL NOT NULL), `buy_amount` (INTEGER NOT NULL), `buy_fee` (REAL NOT NULL DEFAULT 0)
   * `trade_id` (INTEGER NOT NULL), `status` (TEXT NOT NULL DEFAULT 'OPEN'), `created_at` (TEXT NOT NULL), `closed_at` (TEXT)

### 3.3 가상거래(Paper Trading) 전용 분리 원장 테이블 (절대 격리)
5. **`paper_trades` (가상 체결 내역)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * 컬럼 구조는 `trades`와 100% 동일하되 실제 업비트 주문 없이 실시간 호가 기반 가상 체결 기록 저장 (`paper-bid-*`, `paper-ask-*` UUID, 수수료 0.05% 차감)

6. **`paper_bot_positions` (가상 보유 포지션)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * 컬럼 구조는 `bot_positions`와 100% 동일하되 가상거래 시에만 오픈/클로즈 포지션 저장

### 3.4 AI 시황, 뉴스, 알림 및 시장 체제 테이블
7. **`ai_market_briefings`**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `provider` (TEXT NOT NULL DEFAULT 'gemini'), `model` (TEXT NOT NULL DEFAULT 'gemini-3.8-flash')
   * `btc_price` (REAL), `btc_daily_20ma` (REAL), `btc_4h_60ma` (REAL), `regime_status` (TEXT)
   * `briefing_text` (TEXT NOT NULL), `created_at` (TEXT NOT NULL)

8. **`crypto_news`**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `title` (TEXT NOT NULL), `link` (TEXT NOT NULL UNIQUE), `source` (TEXT NOT NULL), `published_at` (TEXT NOT NULL)
   * `summary` (TEXT), `sentiment` (TEXT NOT NULL DEFAULT 'NEUTRAL'), `keywords` (TEXT), `created_at` (TEXT NOT NULL)
   * 인덱스: `idx_crypto_news_pubdate ON crypto_news (published_at DESC)`

9. **`ai_news_briefings`**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `provider` (TEXT NOT NULL DEFAULT 'gemini'), `model` (TEXT NOT NULL DEFAULT 'gemini-3.8-flash')
   * `news_count` (INTEGER), `bullish_count` (INTEGER), `bearish_count` (INTEGER), `neutral_count` (INTEGER)
   * `briefing_text` (TEXT NOT NULL), `created_at` (TEXT NOT NULL)

10. **`push_subscriptions` (WebPush)**:
    * `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `endpoint` (TEXT NOT NULL UNIQUE), `p256dh` (TEXT NOT NULL), `auth` (TEXT NOT NULL), `created_at` (TEXT NOT NULL)

11. **`market_regime_filter` (비트코인 거시 시장 체제)**:
    * `id` (INTEGER PRIMARY KEY DEFAULT 1), `regime_status` (TEXT NOT NULL DEFAULT 'NORMAL') - `NORMAL` 또는 `HOLD_CASH`
    * `btc_price` (REAL), `btc_daily_20ma` (REAL), `btc_4h_60ma` (REAL)
    * `flash_sentiment_score` (REAL), `flash_recommended_action` (TEXT), `flash_updated_at` (TEXT)
    * `pro_sentiment_score` (REAL), `pro_recommended_action` (TEXT), `pro_updated_at` (TEXT)
    * `final_risk_alert` (INTEGER DEFAULT 0), `final_position_multiplier` (REAL DEFAULT 1.0), `final_bot_overrides_json` (TEXT)
    * `reason` (TEXT), `updated_at` (TEXT NOT NULL)

### 3.5 자산 스냅샷 · 주간 로테이션 · 백테스트 · 5중 가드레일 테이블
12. **`monthly_asset_snapshots`**: 월별 1일 기준 평가자산 스냅샷 및 증감률 추적.
13. **`auto_rotation_config`**, 14. **`auto_rotation_history`**, 15. **`drain_handoff_logs`**: 주간 전략군 TOP 1 자동 로테이션 설정, 실행 이력 및 Graceful Drain 잔여 원화 Zero-Sum 이관 감사 원장.
16. **`bot_accounts`**: 봇별 계정/원장 보조 테이블.
17. **`historical_candles`**, 18. **`backtest_runs`**: Zero Look-Ahead 과거 캔들 캐시 및 Walk-Forward(70/30) 백테스트 성과·파라미터 결과 저장.
19. **`live_executor_lease`**: 단일 행(`id = 1`) SQLite 원자적 프로세스 리스 락(`owner_id`, `pid`, `host`, `acquired_at`, `heartbeat_at`, `expires_at`, TTL `30초`).
20. **`live_order_intents`**: 2단계 커밋 실전 주문 의도 원장(`intent_id` = 업비트 `identifier` UUID, `bot_id`, `market`, `side`, `intent_bucket`, `requested_krw`, `requested_volume`, `target_position_uuid`, `upbit_order_uuid`, `status`, `refunded`, `UNIQUE(bot_id, market, side, intent_bucket)`).
21. **`live_guardrail_events`**: 5중 가드레일 차단·타임아웃·정산·비상 정지 감사 로그 원장.

---

## 4. 10대 퀀트 알고리즘 봇 (10-Bot Arena) 전략 상세 명세

모든 10개 봇은 가상 자본 1,000,000 KRW로 24시간 실시간 모의투자 아레나에서 지속 가동되며 실적(수익률, MDD, 승률, 전적)을 축적합니다:

| 봇 ID | 닉네임 | 전략 유형 (strategy_type) | 진입 (BUY) 조건 | 청산 (SELL) 조건 | 기본 손절/익절 |
| :---: | :---: | :---: | :--- | :--- | :---: |
| **`bot_01`** | **돌파봇-알파** | `VOLATILITY_BREAKOUT` | 변동성 돌파(K=0.4) + 20일 이평선 상회 + 거래량 1.2배 | 당일 종가 또는 익일 09:00 시가 청산 | -2.5% / +4.5% |
| **`bot_02`** | **슈퍼트렌드-ATR** | `SUPERTREND_ATR` | SuperTrend(10,3) 상승 전환 & 20봉 거래량 1.5배 돌파 | 고점 대비 2.5×ATR(14) 하락 시 트레일링 스탑 | -4.0% / +15.0% |
| **`bot_03`** | **모멘텀봇-베타** | `DUAL_MOMENTUM` | 7일 상대 모멘텀 상위 2종목 + 절대 모멘텀 > +1.5% | 7일 모멘텀 순위 이탈 또는 음수 전환 시 | -3.5% / +7.0% |
| **`bot_04`** | **스퀴즈봇-델타** | `BB_SQUEEZE_VCP` | 볼린저(20,2) 밴드폭 20봉 최저 수축 후 거래량 2배 상단 돌파 | 볼린저 중심선 이탈 시 청산 | -2.5% / +5.0% |
| **`bot_05`** | **볼린저봇-감마** | `BOLLINGER_REVERSAL` | 고변동성 코인 15분봉 볼린저 하단(-2.0σ) 터치 & RSI <= 30 | 중심선 복귀 또는 +3.5% 도달 시 분할 익절 | -2.0% / +3.5% |
| **`bot_06`** | **그리드봇-엡실론** | `DYNAMIC_GRID` | RSI <= 35 과매도 진입 후 -2.5% / -5.0% 추가 하락 시 최대 3분할 매수 | 각 분할 포지션별 +1.8% 도달 시 개별 익절 | -9.0% / +1.8% |
| **`bot_07`** | **MACD봇-제타** | `MACD_TREND` | 15분/60분 EMA(20>60) 정배열 & MACD 골든크로스 & RSI 45~65 | MACD 데드크로스 또는 RSI 70 초과 시 | -2.5% / +5.0% |
| **`bot_08`** | **눌림목봇-에타** | `MA20_PULLBACK` | 일봉/4시간봉 정배열(5>20>60) 상승 추세 + 20MA(±1.5%) 눌림목 지지 | 직전 고점 부근 도달 시 익절 | -3.0% / +6.0% |
| **`bot_09`** | **스파이크봇-세타** | `VOLUME_SPIKE_BREAKOUT` | 15분봉 거래량이 20봉 평균 대비 300% 이상 폭발하며 양봉 마감 | 고점 대비 -1.5% 트레일링 스탑 | -2.0% / +8.0% |
| **`bot_10`** | **잭 켈로그 프라이스액션** | `JACK_KELLOGG_PRICE_ACTION` | 4대 핵심 지표(VWAP, 20봉 선형회귀 채널 LRC ±2σ, 상대거래량 폭발 RVOL, 당일시가/전일고저) 돌파 & 과매도 2분할 반등 | 선형회귀 상단(+2σ) 전량 익절, 회귀 익절, 윗꼬리 음봉 클라이맥스 청산, -1.5% 트레일링 스탑, 기준선 손절 | -2.5% / +5.0% |

---

## 5. AI 주간 봇 최적 선발 및 일요일 09:00 정기 회전 엔진

### 5.1 업비트 주봉 기준 일요일 09:00 고정 슬롯 (`getWeeklySundaySlotInfo`)
- **기점**: **매주 일요일 오전 09:00:00 KST** (업비트 공식 주간 캔들 마감 시각).
- **슬롯 키 형식**: `YYYY-MM-DD_09:00` (예: `2026-11-08_09:00`).
- **계산 원칙**:
  - 오늘이 일요일인데 09:00 이전이면 직전 주 일요일 09:00이 현재 슬롯.
  - 월~토요일이면 이번 주 지난 일요일 09:00이 현재 슬롯.
  - 차기 슬롯: 현재 슬롯 + 7일 (`nextSundaySlot`).
  - D-Day 카운트다운: 차기 일요일 09:00까지의 잔여 일수(`daysRemaining`).

### 5.2 듀얼 LLM 10대 봇 제어 · 주간 전략군 TOP 1 자동 로테이션 & 폴백 아키텍처
1. **Gemini Dual AI 모델 호출 체인**:
   - Flash(30분) / Pro(1시간 정각) 교차 검증으로 `gemini-3.8-flash` -> `gemini-3.1-pro-preview` -> `gemini-flash-latest` / `gemini-2.5-*` 폴백 체인 및 `bot_01`~`bot_10` 개별 `ALLOW`/`BLOCK` 제어(`final_bot_overrides_json`, 청산 루프는 비차단).
   - 각 호출 시 `AbortSignal.timeout(12000)` (12초 타임아웃) 강제 적용.
   - `generationConfig`: `temperature: 0.2`, `maxOutputTokens: 4096`, `responseMimeType: "application/json"` 필수 적용으로 마크다운 없는 순수 JSON 보장.
2. **평가 입력 데이터**:
   - 비트코인 일봉 20MA, 4시간 60MA, 현재가 및 시장 체제(`NORMAL` vs `HOLD_CASH`).
   - 10대 봇 아레나 모의투자 실시간 순위표 (누적 손익률, MDD, 승률, 전적, 최근 상태).
3. **평가 기준**:
   - **하락/약세장**: 공격적 돌파봇(돌파봇, 스파이크봇 등) 차단, 손실 방어력 최상위 봇(MDD 0%대 눌림목봇, 슈퍼트렌드-ATR, 과매도 VWAP봇 등) 우선 배치.
   - **상승장**: 추세 추종 및 모멘텀 전략 봇 우선 배치.
4. **퀀트 룰베이스 알고리즘 폴백 및 주간 자동 로테이션 · Graceful Drain**:
   - Gemini 호출이 전원 실패할 경우 시스템이 멈추지 않고 BTC 20MA 기계적 필터 및 모의투자 아레나의 **전략군(추세·스윙 / 변동성·돌파 / 역추세·그리드)별 1위 봇 자동 선발 + Graceful Drain(미매도 오픈 포지션 보유 구 봇은 신규 매수만 차단하고 전량 익절/손절 완료 후 잔여 원화를 신규 봇으로 이관)** 을 통해 무중단 운용.
   - `bot_10`은 Jack Kellogg VWAP + 선형 회귀 채널 프라이스 액션 전략으로 가상/실전 양측 모두 지원.

---

## 6. 계좌 유지 로직 및 초강력 하락장 방어 메커니즘

### 6.1 계좌 유지 원칙 (90% 운용, 10% 현금 안전 버퍼 영구 보존)
- **실전 총 자본 산출**: 업비트 실계좌 총 자산(보유 원화 + 보유 코인 평가금액)의 **90%만 실전 봇 총 원금(`total_capital`)으로 책정**.
- **10% 현금 안전 버퍼**: 남은 **10%는 절대 봇에 배분하지 않고 업비트 계좌 현금 버퍼로 영구 보존**.
- **1~3위 봇 자금 분배**:
  - 기본 배분 비율: 1위 40%, 2위 35%, 3위 25% (합계 100%).
  - 계산 시 반드시 `Math.floor` 내림을 적용하여 정수 원화로 계산.
- **가상 KRW 격리**: 각 봇은 DB에 배분된 `virtual_krw` 범위 내에서만 매수 가능하며 타 봇의 잔고를 침범하지 못함.
- **미선정 7개 봇 조치**:
  - 실전 매매는 즉시 중지(`is_running = 0`, `is_selected_for_live = 0`).
  - 모의투자 아레나에서는 상시 가동(`paper_is_running = 1`)을 유지하여 24시간 실적 축적 지속.

### 6.2 최소 주문금액 안전 버퍼 (`SAFE_MIN_ORDER_KRW = 6,500원`)
- 업비트 최소 주문 금액은 5,000원임.
- 5,000원 직전 금액으로 매수 시 -1%만 떨어져도 평가액이 4,950원이 되어 **업비트 매도 주문이 거부(`under_min_total_ask`)되어 손절/익절이 불가능한 교착(Deadlock) 상태 발생**.
- 이를 방지하기 위해 **최소 매수 금액을 6,500원으로 강제**:
  - -20% 극단적 급락 손절 시에도 평가액이 5,200원 유지 $\rightarrow$ 100% 시장가 매도 체결 성공 보장.

### 6.3 5,000원 미만 잔여 코인 정화 매도 (Buy-to-Cleanse Logic)
- 시장 폭락으로 코인 평가액이 5,000원 미만이 된 경우:
  1. 업비트에 **5,500원어치 시장가 추가 매수(Buy)** 주문 전송.
  2. 체결 직후 새로 매수한 수량과 기존 보유 수량을 합친 **전체 보유량(100%)을 즉시 시장가 일괄 매도(Sell)**.
  3. 묶여 있던 잔여 더스트 코인을 100% 전량 원화 현금으로 회수하고 포지션을 정상 `CLOSED` 처리.

### 6.4 비트코인 시장 체제 필터 (Market Regime Filter)
- BTC 현재가가 일봉 20MA 및 4시간 60MA를 하회하면 `HOLD_CASH` (현금 보유) 모드 발동.
- 모든 실전 봇의 신규 진입 매수 주문을 즉시 차단하고 기존 보유 포지션의 손절/익절 감시만 유지.

---

## 7. 프론트엔드 UI/UX 상세 요구사항

1. **다크 테마 & 2:8 레이아웃**:
   - 좌측 20% 메뉴 영역 + 우측 80% 상세 콘텐츠 영역.
   - 모바일(<= 900px) 접속 시 상단 고정 네비게이션 헤더 + 1열 전체 너비로 자동 전환.
2. **AI 주간 봇 카드 (매주 일요일 09:00)**:
   - 상단 타이틀 및 뱃지에 `차기 갱신 D-X일` 표시.
   - `[⚡ 지금 AI 평가 실행]` 수동 실행 버튼 제공.
   - 1위(금색), 2위(은색), 3위(동색) 카드에 배분 비중(%), 전략명, 선정 사유 표기.
   - 하단에 최근 편성 일시 및 차기 자동 갱신 일시 표기.
3. **5대 메뉴 구성**:
   - `📊 거래현황`: 실계좌 요약, 주간 자동 로테이션/Graceful Drain 봇 카드, 듀얼 AI(Flash/Pro) 마켓 브리핑, 실전 담당 봇(1~3개) 제어 탭, 1줄 통합 체결 게시판.
   - `📈 통계`: 일별/주별/월별 누적 손익 곡선 (이익: 빨강 `#ef4444`, 손실: 파랑 `#3b82f6`).
   - `🧪 검증소`: 10대 알고리즘 아레나 실시간 랭킹 보드, TOP 3 포디움, 가상 매매 체결 이력.
   - `📰 뉴스`: 30분 주기 뉴스 50건 페이징, 48px 고정 행 높이 1줄 말줄임, AI 종합 분석 SSE 타이핑.
   - `⚙️ 설정`: 거래 모드 전환, 자금 배분, 입장 코드 확인 및 변경(기본: `stock`, 한글 자판 오타 `ㄴ새차` 자동 변환, `⚙️ 설정` 화면 또는 `.env`에서 사용자 지정 코드로 변경 가능), API 키 등록, JSON 백업/복원.
4. **React TDZ(Temporal Dead Zone) 원천 방어**:
   - `App.jsx`에서 모든 `useCallback`, `useMemo` 및 데이터 조회 함수는 반드시 `useEffect`보다 코드 상단에 먼저 선언.
5. **상대 경로 API 호출**:
   - API 호출 시 `""` 또는 `"/api/..."`를 사용하여 사내 LAN, 로컬, Cloudflare HTTPS 터널에서 무설정 작동.

---

## 8. 백엔드 주요 REST 및 SSE API 명세

| Method | Endpoint | 설명 |
|---|---|---|
| `GET` | `/api/health`, `/api/version`, `/api/version/history` | 헬스체크(WS/Ollama 포함), 현재 버전(`0.0.X`), `history.md` 조회 |
| `GET/POST` | `/api/auth/session`, `/api/auth/verify`, `/api/auth/logout` | `HttpOnly` 서명 세션 쿠키 발급·검증·로그아웃 |
| `GET` | `/api/guardrail/status` | 5중 가드레일 상태(실행 주체·리스 락·매수 캡 카운트·미정산 타임아웃·최근 차단 로그·비상 정지 여부) |
| `POST` | `/api/guardrail/reset-emergency` | 이상 감지 비상 정지 수동 해제(미정산 `UNKNOWN_TIMEOUT` 잔존 시 해제 거부) |
| `GET` | `/api/upbit/status`, `/api/upbit/account` | 업비트 API·WebSocket 허브(`ws_status`) 상태, 실계좌 자산 조회 및 90% 동적 자본 동기화 |
| `GET/POST` | `/api/rotation/status`, `/api/rotation/config`, `/api/rotation/execute-now` | 주간 전략군 TOP 1 자동 로테이션 상태·설정·즉시 실행 및 Graceful Drain 현황 |
| `GET/POST` | `/api/ai/weekly-bot-selection`, `/api/ai/weekly-bot-selection/run` | AI 주간 봇 최적 선발 현황 및 수동 강제 실행 |
| `GET/PUT` | `/api/settings/ollama`, `/api/settings/notifications`, `/api/settings/notifications/test` | 로컬 Ollama(`qwen3-news`) 설정 및 Telegram/Discord/WebPush 멀티채널 알림 설정·테스트 |
| `GET` | `/api/bots` | 10대 봇 전체 목록, 실전/모의 상태, 할당자금, 가용잔고, 미매도 포지션 |
| `POST` | `/api/bots/:id/start`, `/api/bots/:id/stop` | 특정 봇 실전 매매 가동 / 중지 |
| `PUT` | `/api/bots/:id` | 봇 파라미터, 별명, 손절/익절 설정 수정 |
| `GET` | `/api/trades`, `/api/statistics`, `/api/monthly-assets` | 체결 내역(슬리피지 bps 포함), 기간별 통계, 월별 보유 자산 증감 |
| `GET` | `/api/chart/trade-markers` | 인터랙티브 캔들스틱 + VWAP/LRC/20MA + BUY/SELL 타점 마커 데이터 |
| `GET/POST` | `/api/backtest/run`, `/api/backtest/history`, `/api/backtest/apply-params` | Zero Look-Ahead 과거 캔들 백테스팅·Walk-Forward(70/30)·원클릭 파라미터 반영 |
| `GET/POST` | `/api/arena/leaderboard`, `/api/algo-lab/models`, `/api/algo-lab/reset` | 10대 알고리즘 아레나 실시간 성과·랭킹 조회 및 100만원 클린 리셋 |
| `GET/POST` | `/api/news`, `/api/news/refresh` | 수집된 뉴스 50건 페이징 목록, 검색, 태그 필터링 및 즉시 수집 |
| `GET/POST`| `/api/ai/stream-news-analyze`, `/api/ai/stream-analyze` | 로컬 Ollama / Gemini SSE 실시간 뉴스·시장 시황 분석 스트리밍 |
| `GET/POST` | `/api/settings/export`, `/api/settings/import-json` | 전체 SQLite DB JSON 백업 다운로드(시크릿 제외) 및 트랜잭션 복원 |

---

## 9. 🚨 AI Agent 소스 코드 정밀 검수 및 감사 가이드라인 (Audit & Review Guide)

다른 AI Agent가 본 코드베이스를 검수할 때는 다음 **11가지 핵심 감사 체크리스트**를 반드시 순서대로 검증해야 합니다.

### [체크리스트 1] 업비트 주문 최소 금액 및 방어 로직 검수
- [ ] [`backend/node_server.mjs`](file:///home/asura/dev/sourceCode/autoCoinTrade/backend/node_server.mjs)의 `getSafeOrderKrw` 함수에서 `SAFE_MIN_ORDER_KRW >= 6500`이 보장되어 있는가?
- [ ] 주문 금액 계산 시 매수 수수료(0.05%) 반영 및 `Math.floor` 내림 처리가 정확한가?
- [ ] 매도 주문 실행 시 잔여 평가금액이 5,000원 미만인 경우 `under_min_total_ask`를 사전에 감지하거나, 해당 에러 발생 시 **5,500원 시장가 추가 매수 후 100% 전량 일괄 매도(Buy-to-Cleanse)** 로직이 구현되어 있는가?
- [ ] 업비트 실제 계좌에 보유 수량이 0인 유령 포지션이 발생했을 때 이를 감지하여 DB 상태를 `CLOSED`로 자동 정화하는가?
- [ ] 매도 수량 지정 시 8자리 절삭(`Math.floor(volume * 1e8) / 1e8`)을 통해 부동소수점 오차를 방어하고 있는가?

### [체크리스트 2] 계좌 유지 로직 및 자금 격리 원칙 검수
- [ ] 업비트 실계좌 총 자산 중 **정확히 90%만 실전 봇 자본금(`total_capital`)으로 배분**되고 있는가?
- [ ] **10% 현금 안전 버퍼**가 봇에게 분배되지 않고 원화 현금으로 온전히 남아있는가?
- [ ] 봇별 원금 배분 시 `Math.floor`를 적용하여 소수점 이하 원화가 발생하지 않는가?
- [ ] 전량 조회 함수(`get_balance`)를 이용한 직접 일괄 매도를 금지하고, 반드시 본인 `bot_id`의 `bot_positions`에 기록된 `volume`만 매도하도록 격리되어 있는가?
- [ ] 실계좌 가용 잔고가 0 이하가 될 경우 전체 봇 가동을 즉시 중지하고 사용자에게 모달 알림을 제공하는가?

### [체크리스트 3] 주간 일요일 09:00 회전 슬롯 엔진 검수
- [ ] `getWeeklySundaySlotInfo()`가 서버의 타임존에 구애받지 않고 **한국 표준시(KST) 기준 매주 일요일 09:00:00**을 정확히 계산하는가?
- [ ] 슬롯 키가 `YYYY-MM-DD_09:00` 형식으로 관리되며 `system_settings`의 `llm_weekly_bot_selection_last_slot`과 일치 여부를 대조하는가?
- [ ] 1분 주기 스케줄러(`checkAndRunScheduledLlmWeeklyBotSelection`)가 중복 호출되지 않도록 `isWeeklyBotSelectionRunning` 락(Lock) 플래그가 적용되어 있는가?
- [ ] 차기 슬롯까지의 D-Day(`daysRemaining`)가 정확히 계산되어 프론트엔드에 전달되는가?

### [체크리스트 4] 10대 봇 아레나 모의투자 격리 검수
- [ ] 실거래 테이블(`trades`, `bot_positions`)과 모의투자 테이블(`paper_trades`, `paper_bot_positions`)이 철저히 분리되어 있는가?
- [ ] 실전 매매에서 미선정된 7개 봇은 `is_running = 0`으로 실거래가 정지되되, `paper_is_running = 1`로 모의투자는 24시간 계속 진행되는가?
- [ ] 모의투자의 MDD(`paper_mdd_pct`)와 수익률이 실시간 최고 평가자산(`paper_peak_equity`) 대비 정확히 갱신되는가?

### [체크리스트 5] Gemini LLM 연동 및 안정성 검수
- [ ] Gemini API 호출 시 `AbortSignal.timeout(12000)` 또는 `setTimeout` 기반 타임아웃 처리가 되어 있어 API 응답 지연 시 프로세스가 블로킹되지 않는가?
- [ ] 주간 봇 선발 프롬프트에 `responseMimeType: "application/json"`이 설정되어 있어 파싱 에러 없는 순수 JSON 출력이 보장되는가?
- [ ] `gemini-3.8-flash` -> `gemini-3.1-pro-preview` -> `gemini-flash-latest` / `gemini-2.5-*` 폴백 체인과 Dual AI(30분 Flash / 1시간 Pro) `bot_01`~`bot_10` 개별 제어, 그리고 최종 실패 시 모의투자 아레나·BTC 20MA 기반 **퀀트 룰베이스 알고리즘 폴백**이 완벽히 작동하는가?
- [ ] 무료 API 호출 한도(Quota 429) 발생 시 이를 감지하고 사용자에게 안내하는가?

### [체크리스트 6] 비트코인 거시 체제 필터 (Regime Filter) 검수
- [ ] BTC 캔들 데이터를 바탕으로 일봉 20MA 및 4시간 60MA를 정확히 산출하는가?
- [ ] BTC 현재가가 20MA 및 60MA 하단에 위치할 때 `HOLD_CASH` 상태로 전환되어 실전 봇의 신규 매수를 전면 차단하는가?
- [ ] 매수만 차단하고 기존 보유 포지션의 손절/익절 감시는 정상 작동하는가?

### [체크리스트 7] 프론트엔드 코드 품질 및 반응형 UI 검수
- [ ] `frontend/src/App.jsx`에서 모든 함수와 훅이 선언 순서 규칙을 준수하여 TDZ ReferenceError가 발생하지 않는가?
- [ ] API 호출이 하드코딩된 포트 없이 상대 경로(`""` 또는 `"/api/..."`)로 처리되어 도메인/IP 변경 시에도 작동하는가?
- [ ] 뉴스 테이블의 모든 행(`tr`, `td`)에 48px 고정 높이와 1줄 말줄임(`text-overflow: ellipsis`)이 적용되어 레이아웃 깨짐이 없는가?

### [체크리스트 8] 이중 데이터베이스 (SQLite WAL + PostgreSQL 16) 동기화 검수
- [ ] `backend/common/pg_sync.mjs`가 전체 21개 테이블(가드레일·백테스트·로테이션 포함)의 생성 및 변경 사항을 빠짐없이 PostgreSQL에 UPSERT하는가?
- [ ] `.env`의 `LOCATION` 분기(`local` vs `outer`)에 따라 알맞은 PostgreSQL 호스트로 안전하게 접속하는가?
- [ ] SQLite의 WAL 모드와 5초 busy_timeout이 설정되어 락 충돌 없이 고속 트랜잭션을 처리하는가?

### [체크리스트 9] 프로젝트 버전 관리 및 변경 이력(history.md) 동기화 검수
- [ ] 사용자의 별다른 언급이 없는 한, 버전은 `0.0.1`부터 시작하여 Git 커밋 1건당 1씩 증가하는 `0.0.숫자` (`0.0.X`) 체계를 영구히 유지하는가?
- [ ] 모든 커밋 및 변경 내역이 `history.md`에 버전별로 상세하게 기록되고 최신 버전이 반영되어 있는가?
- [ ] `package.json`, `frontend/package.json`, 프론트엔드 대시보드(게이트 배지, 사이드바 로고/푸터, 설정 화면 등), 그리고 백엔드 API (`/api/version`, `/api/version/history`)에서 버전을 실시간으로 확인할 수 있는가?

### [체크리스트 10] 5중 실전 중복 주문 차단 하드 가드레일 검수 (`backend/common/live_order_guardrail.mjs`, `bots.py`)
- [ ] `LIVE_EXECUTOR_OWNER`(기본 `"node"`) 불일치 엔진의 실전 주문 API(`POST /v1/orders`) 진입이 즉시 하드 차단되고, SQLite `live_executor_lease`(TTL 30초, `BEGIN IMMEDIATE`) 소유자 검증이 강제되는가?
- [ ] 매수 시 `live_order_intents`에 `PENDING` 선점 및 `virtual_krw` 원자적 선차감 후 업비트 `identifier = intent_id`로 멱등 주문하며, 타임아웃(`UNKNOWN_TIMEOUT`) 시 `GET /v1/order?identifier=...` 정산으로 확정 미생성(`FAILED_NOT_CREATED`)일 때만 1회(`refunded = 1`) 환불되는가?
- [ ] 매도 시 동일 `order_uuid`에 대해 `inFlightLiveOrderMutex` 및 DB `intent_bucket = sell:<order_uuid>` 유니크 가드로 중복 매도가 물리적으로 차단되는가?
- [ ] 재진입 `900초` 쿨다운·봇 매수 간격 `60초`·봇별 시간당 `3회`/일 `12회`·전체 일 `30회` 하드 캡과 이상 패턴(5분 차단 5회 또는 타임아웃 2회) 자동 비상 정지(청산 매도·가상 Arena는 정상 유지)가 `tests/verify_duplicate_order_guard.mjs` 7대 시나리오에서 모두 통과하는가?

### [체크리스트 11] WebSocket 허브 · 실행 품질 · 암호화 볼트 · Docker/CI 검수
- [ ] `backend/common/upbit_ws_hub.mjs`가 실시간 WebSocket 스트림과 틱 반응형 청산(`1,500ms` 디바운스) 및 REST 폴백을 수행하며, Python 전용 `market_hub.py`와 충돌 없이 역할이 분리되어 있는가?
- [ ] API 키와 알림 시크릿이 `backend/common/crypto_vault.mjs` AES-256-GCM(`enc:v1:...`, `0600`)으로 암호화 저장되고 Node.js↔Python 상호 복호화가 통과하는가?
- [ ] `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` 및 `/install` 패키지에 실제 `.env`, `config/upbit_config.json`, `data/*.db*`, 비밀 키가 절대 포함되지 않는가?

---

## 10. 서비스 실행 · 테스트 및 운영 명령어 요약

```bash
# 1. 초기 환경 구축 및 패키지 설치
./setup.sh

# 2. 백엔드(8001) 및 프론트엔드(9000) 백그라운드 서비스 시작
./start_services.sh

# 3. Docker Compose 컨테이너 시작 / 종료 (선택)
docker compose up -d --build
# docker compose down

# 4. 서비스 정상 기동 및 포트 점유 확인
ss -lptn 'sport = :8001 or sport = :9000'
curl -s http://127.0.0.1:8001/api/health
curl -s http://127.0.0.1:8001/api/version

# 5. 실시간 로그 확인
tail -f logs/backend.log logs/frontend.log

# 6. 외부 접속용 Cloudflare HTTPS 보안 터널 시작 / 종료
./start_tunnel.sh
# ./stop_tunnel.sh

# 7. 5중 가드레일 스트레스 테스트 및 전체 자동화 검증 스위트 실행
npm run test:guardrail
npm run test:all

# 8. 서비스 안전 종료
./stop_services.sh
```
