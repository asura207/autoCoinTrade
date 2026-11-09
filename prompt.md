# 업비트(Upbit) Open API 기반 다중 전략 코인 자동매매 & 실시간 AI 퀀트 시스템 종합 구축 프롬프트

> **작성 목적**: 본 프롬프트는 업비트 Open API와 Google Gemini AI, 고성능 경량 Node.js 및 React 다크 UI를 결합하여 현재까지 완성된 코인 자동매매 및 실시간 AI 인텔리전스 시스템을 다른 AI Agent 또는 개발자가 100% 동일하게 재현 및 구현할 수 있도록 작성된 종합 아키텍처 및 구현 명세서입니다.

당신은 가상자산 퀀트 트레이딩 시스템 아키텍트이자 시니어 풀스택 개발자입니다. 아래의 기술 스택, 시스템 아키텍처, 데이터베이스 스키마, 봇 매매 로직, 프론트엔드 UI/UX, 네트워크 및 배포 요구사항을 **하나도 빠짐없이 완벽하게** 반영하여 동일한 시스템을 설계하고 구현해주세요.

---

## 1. 시스템 핵심 아키텍처 및 기술 스택

### 1.1 기술 스택 (Tech Stack)
- **Backend**: Node.js (v20+ 또는 v22.5.0+, ES Module `.mjs`, Native `node:http`, Native `node:sqlite` DatabaseSync WAL 모드, Native `node:crypto`, Port `8001`)
  - 비동기 백그라운드 봇 전략 스케줄러 (8~10초 주기)
  - Gemini AI 실시간 스트리밍 (Server-Sent Events: SSE) 엔진
  - 뉴스 실시간 RSS 수집 및 감성 분석 백그라운드 워커 (30분 주기)
  - 알고리즘 검증소(Algo Lab) 6대 모델 병렬 시뮬레이션 엔진
- **Frontend**: React 18+, Vite 5 (Port `9000`)
  - 프리미엄 다크 테마 UI (Pretendard 폰트 기반, `#0b0f19` 배경, 2:8 화면 분할 및 모바일 반응형 1열 전환)
  - 상대 경로(`API_BASE = ""`) 및 Vite 프록시(`vite.config.js`)를 통한 로컬, 사내 LAN, 외부 도메인 무설정 동시 지원
- **Dual Database Architecture (SQLite WAL + PostgreSQL 16)**:
  - **기본 실시간 DB**: SQLite (`data/auto_coin_trade.db`, WAL 저널 모드, busy_timeout=5000, 자동 재접속 지원)
  - **동기화 및 백업 DB**: PostgreSQL 16 (`coin_trader` 데이터베이스)
  - **환경별 동적 분기 (`.env`)**: `LOCATION=local` (로컬 `127.0.0.1:5432`) 또는 `LOCATION=outer` (외부 접속 주소 및 포트) 설정에 따라 자동 연결
  - **백그라운드 동기화 매니저 (`pg_sync.mjs`)**: SQLite에 저장되는 모든 테이블의 변경 내역을 PostgreSQL에 실시간 양방향/UPSERT 동기화
- **외부 접속 지원 (Cloudflare Tunnel & 사내 LAN)**:
  - 사내 LAN (`http://<내부IP>:9000`) 및 Cloudflare Quick Tunnel (`https://*.trycloudflare.com`)을 통한 안전한 외부 HTTPS 접속 지원
  - IPv4 충돌 방지 및 돌발 자동 업데이트 방지를 위해 `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9000` 바인딩
  - Vite `server.allowedHosts: true`, `host: "0.0.0.0"` 적용
- **형상 관리 및 보안**:
  - 업비트 Access Key, Secret Key 및 Gemini API Key 등 민감 정보는 `.env` 및 `config/upbit_config.json`으로 분리하여 Git 추적에서 제외(`upbit_config.example.json` 템플릿 제공)
  - 커밋 메시지에 개인정보나 계정 정보가 일절 포함되지 않도록 작성

---

## 2. 디렉토리 및 파일 구조

```text
autoCoinTrade/
├── backend/
│   ├── node_server.mjs          # [메인 백엔드] Node.js 22 SQLite + Upbit API + Gemini AI + REST API + SSE
│   ├── main.py                  # (선택) FastAPI 백엔드
│   └── common/
│       ├── algo_lab_service.mjs # 6대 알고리즘 검증소(Algo Lab) 시뮬레이션 및 실시간 랭킹 엔진
│       ├── news_service.mjs     # 구글 뉴스 & 토큰포스트 RSS 파싱, 감성 분석, 태그 추출
│       ├── pg_sync.mjs          # PostgreSQL 16 실시간 데이터 동기화 매니저
│       ├── database.py          # Python DB 어댑터
│       └── upbit_client.py      # Python 업비트 연동 클라이언트
├── config/
│   ├── upbit_config.json        # 업비트 및 Gemini API 키 설정 파일 (Git 추적 제외)
│   └── upbit_config.example.json# 설정 파일 템플릿
├── data/
│   └── auto_coin_trade.db       # 로컬 SQLite 데이터베이스 (WAL 모드)
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # 프론트엔드 메인 React 컴포넌트 (5대 메뉴, AI 스트리밍, 페이지네이션)
│   │   ├── main.jsx             # React 엔트리포인트
│   │   └── styles.css           # 다크 테마, 2:8 레이아웃, 모바일 반응형, 48px 고정 테이블, 모달 스타일
│   ├── index.html
│   ├── package.json
│   └── vite.config.js           # 0.0.0.0 바인딩, allowedHosts, /api 프록시 설정
├── scripts/
│   ├── setup_postgresql.sh      # PostgreSQL 16 계정 및 데이터베이스 자동 설치/설정 스크립트
│   ├── migrate_sqlite_to_pg.py  # SQLite -> PostgreSQL 전체 데이터 마이그레이션 스크립트
│   ├── run_backend.sh           # [Linux] 백엔드 단독 구동
│   ├── run_frontend.sh          # [Linux] 프론트엔드 단독 구동
│   ├── run_backend.bat          # [Windows] 백엔드 단독 구동
│   ├── run_frontend.bat         # [Windows] 프론트엔드 단독 구동
│   └── start_silent.vbs         # [Windows] 콘솔 창 없는 무음 백그라운드 런처
├── setup.sh                     # [초기 설정 - Linux] 원클릭 환경 검증 및 패키지 설치
├── setup.bat                    # [초기 설정 - Windows]
├── start_services.sh            # [서비스 시작 - Linux] 백엔드(8001) 및 프론트엔드(9000) 백그라운드 실행
├── start_services.bat           # [서비스 시작 - Windows]
├── stop_services.sh             # [서비스 중지 - Linux] 포트 8001 & 9000 안전 프로세스 종료
├── stop_services.bat            # [서비스 중지 - Windows]
├── start_tunnel.sh              # [외부 접속 터널 - Linux] Cloudflare HTTPS 보안 주소 자동 발급
├── stop_tunnel.sh               # [외부 접속 터널 종료 - Linux]
├── .env                         # LOCATION=local|outer, PostgreSQL 접속 정보, Gemini API 키
├── README.md                    # 프로젝트 종합 안내서
├── SETUP_GUIDE.md               # 다중 PC 및 신규 배포 가이드
└── prompt.md                    # 시스템 복원 및 구현 프롬프트 (본 파일)
```

---

## 3. 데이터베이스 스키마 명세 (SQLite & PostgreSQL 16 공통)

`PRAGMA journal_mode = WAL;`, `PRAGMA busy_timeout = 5000;`을 필수로 적용하며, 다음 9개 테이블을 구성해야 합니다:

### 3.1 시스템 설정 및 봇 마스터
1. **`system_settings`**:
   * `key` (TEXT PRIMARY KEY)
   * `value` (TEXT NOT NULL)
   * `updated_at` (TEXT NOT NULL)

2. **`bots`**:
   * `bot_id` (TEXT PRIMARY KEY) - 예: `bot_volatility`, `bot_dual_momentum`, `bot_bollinger_reversal`
   * `name` (TEXT NOT NULL) - 공식 명칭
   * `nickname` (TEXT NOT NULL) - 사용자 설정 별명
   * `strategy_type` (TEXT NOT NULL)
   * `description` (TEXT NOT NULL)
   * `allocation_ratio` (REAL NOT NULL DEFAULT 0) - 자금 배분 비율 (0.0 ~ 1.0)
   * `allocated_capital` (INTEGER NOT NULL DEFAULT 0) - 할당된 총 원금 (KRW)
   * `virtual_krw` (INTEGER NOT NULL DEFAULT 0) - 주문 가능한 가용 잔액 (KRW)
   * `is_running` (INTEGER NOT NULL DEFAULT 0) - 가동 상태 (1: 가동, 0: 중지)
   * `min_volume_krw` (INTEGER NOT NULL DEFAULT 0) - 최소 1회 주문 금액 (최소 5,000원)
   * `stop_loss_pct` (REAL NOT NULL DEFAULT 0) - 손절 기준율 (%)
   * `take_profit_pct` (REAL NOT NULL DEFAULT 0) - 익절 기준율 (%)
   * `config_json` (TEXT NOT NULL DEFAULT '{}') - 전략별 세부 파라미터
   * `last_status_msg` (TEXT NOT NULL DEFAULT '대기 중')
   * `updated_at` (TEXT NOT NULL)

### 3.2 실거래 전용 원장 테이블
3. **`trades` (실제 체결 내역)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `bot_id` (TEXT NOT NULL)
   * `market` (TEXT NOT NULL) - 예: `KRW-BTC`
   * `buy_order_uuid` (TEXT NOT NULL)
   * `sell_order_uuid` (TEXT)
   * `buy_price` (REAL NOT NULL)
   * `buy_volume` (TEXT NOT NULL)
   * `buy_amount` (INTEGER NOT NULL)
   * `buy_date` (TEXT NOT NULL)
   * `sell_price` (REAL)
   * `sell_volume` (TEXT)
   * `sell_amount` (INTEGER)
   * `sell_date` (TEXT)
   * `profit_krw` (INTEGER)
   * `profit_pct` (REAL)
   * `status` (TEXT NOT NULL DEFAULT 'HOLDING') - `HOLDING` 또는 `CLOSED`

4. **`bot_positions` (실제 보유 포지션)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `bot_id` (TEXT NOT NULL)
   * `market` (TEXT NOT NULL)
   * `order_uuid` (TEXT NOT NULL UNIQUE)
   * `volume` (TEXT NOT NULL)
   * `avg_buy_price` (REAL NOT NULL)
   * `buy_amount` (INTEGER NOT NULL)
   * `buy_fee` (REAL NOT NULL DEFAULT 0)
   * `trade_id` (INTEGER NOT NULL)
   * `status` (TEXT NOT NULL DEFAULT 'OPEN')
   * `created_at` (TEXT NOT NULL)
   * `closed_at` (TEXT)

### 3.3 가상거래(Paper Trading) 전용 분리 원장 테이블 (절대 격리)
5. **`paper_trades` (가상 체결 내역)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * 컬럼 구조는 `trades`와 100% 동일하되 실제 업비트 주문 없이 실시간 호가 기반 가상 체결 기록 저장 (`paper-bid-*`, `paper-ask-*` UUID 부여, 수수료 0.05% 차감)

6. **`paper_bot_positions` (가상 보유 포지션)**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * 컬럼 구조는 `bot_positions`와 100% 동일하되 가상거래 시에만 오픈/클로즈 포지션 저장

### 3.4 AI 시황 및 뉴스 테이블
7. **`ai_market_briefings`**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `provider` (TEXT NOT NULL DEFAULT 'gemini')
   * `model` (TEXT NOT NULL DEFAULT 'gemini-1.5-flash')
   * `btc_price` (REAL), `btc_daily_20ma` (REAL), `btc_4h_60ma` (REAL)
   * `regime_status` (TEXT) - `NORMAL` 또는 `HOLD_CASH`
   * `briefing_text` (TEXT NOT NULL)
   * `created_at` (TEXT NOT NULL)

8. **`crypto_news`**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `title` (TEXT NOT NULL), `link` (TEXT NOT NULL UNIQUE), `source` (TEXT NOT NULL), `published_at` (TEXT NOT NULL)
   * `summary` (TEXT), `sentiment` (TEXT NOT NULL DEFAULT 'NEUTRAL'), `keywords` (TEXT), `created_at` (TEXT NOT NULL)
   * 인덱스: `CREATE INDEX IF NOT EXISTS idx_crypto_news_pubdate ON crypto_news (published_at DESC);`

9. **`ai_news_briefings`**:
   * `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
   * `provider` (TEXT NOT NULL DEFAULT 'gemini'), `model` (TEXT NOT NULL DEFAULT 'gemini-3.5-flash-lite')
   * `news_count` (INTEGER), `bullish_count` (INTEGER), `bearish_count` (INTEGER), `neutral_count` (INTEGER)
   * `briefing_text` (TEXT NOT NULL), `created_at` (TEXT NOT NULL)

---

## 4. 봇 매매 전략 및 퀀트 안전 격리 아키텍처

### 4.1 3가지 독립 매매 전략 봇
1. **변동성 돌파 봇 (`bot_volatility`)**: 전일 변동폭(High - Low) * K(0.5) 돌파 시 매수, 당일 종가 또는 익일 시가 매도 (장중 단타/1일 보유)
2. **듀얼 모멘텀 봇 (`bot_dual_momentum`)**: 업비트 거래대금 상위 코인 중 최근 7일 상대 모멘텀 상위 2종목 및 절대 모멘텀(수익률 > +1.5%) 필터를 결합한 스윙 전략
3. **볼린저 밴드 역추세 봇 (`bot_bollinger_reversal`)**: 고변동성 코인 대상 15분봉 볼린저 밴드 하단 터치(-2σ) 및 RSI <= 30 과매도 반등 시 분할 매수 (+3.5% 익절 / -2.0% 손절)

### 4.2 상호 간섭 방지 및 자금 격리 규칙 (절대 준수)
- **전량 조회 함수(`get_balance`) 직접 매도 금지**:
  - 매도 시 반드시 본인 `bot_id`의 `bot_positions` (가상거래는 `paper_bot_positions`)에 기록된 `volume` 수량만 지정하여 매도.
- **동일 종목 동시 진입 격리**:
  - 복수 봇이 동일 코인(예: KRW-BTC)을 매수하더라도 개별 `order_uuid`로 지분을 분리하여 관리.
- **가상 잔고(`virtual_krw`) 트랜잭션 락**:
  - 각 봇은 DB에 할당된 `virtual_krw` 예산 범위 내에서만 주문을 발행.
- **자금 분배 시 소수점 버림 처리**:
  - 총 원금에 배분 비율(%)을 곱할 때 발생하는 소수점은 무조건 내림(`Math.floor`)하여 정수 원화로 계산.
- **잔고 0 이하 시 전체 봇 자동 중지 및 모달 알림**:
  - 잔고가 0 이하가 되면 모든 봇을 즉시 비활성화(`is_running = 0`)하고, 사용자가 거래현황 화면 진입 시 안내 Modal Popup 표기.
- **비트코인 시장 체제 필터 (Regime Filter)**:
  - 비트코인 현재가가 일봉 20일 이동평균선(20 MA) 및 4시간봉 60선(60 MA) 아래에 있을 경우 신규 매수를 전면 차단하고 현금 보유(`HOLD_CASH`) 모드로 전환.
- **업비트 API 안정성 규칙**:
  - 초당 요청 제한 방어를 위한 `120ms` 호출 간격 방어.
  - 최소 주문 금액(5,000원) 및 매수 수수료(0.05%) 사전 반영(`floor(예산 / 1.0005)`).
  - 수량 계산 시 8자리 절삭을 통한 부동소수점 오차 방지.

---

## 5. 프론트엔드 (React) UI/UX 상세 요구사항

### 5.1 공통 레이아웃 및 보안 게이트
- **다크 테마 & 2:8 레이아웃**:
  - 데스크톱: 좌측 20% 메뉴 영역 + 우측 80% 상세 콘텐츠 영역.
  - 모바일 (화면 너비 <= 900px): 좌측 사이드바가 상단 고정(Sticky) 네비게이션 헤더로 자동 전환되며, 본문 콘텐츠는 1열 전체 너비로 확장. 모든 테이블은 `overflow-x: auto`로 가로 스크롤을 제공하여 셀 찌그러짐을 완벽 방지.
- **입장 코드(Gate) 화면**:
  - 별도 회원가입 없이 개인용 입장 코드 `stock`(설정에서 사용자 변경 가능) 입력 시 메인 화면 진입 (새로고침 시 `sessionStorage`로 세션 유지).
- **업비트 통신 상태 인디케이터**:
  - 좌측 메뉴 상단에 초록(정상) / 노랑(지연) / 빨강(통신불가) 실시간 표시. 마우스 오버 시 툴팁으로 응답 속도(ms) 및 최근 확인 시각 표시.
- **실시간 거래 실행 모드 토글 (가상거래 모의투자 ↔ 업비트 실거래)**:
  - 좌측 사이드바 상단 칩, 거래현황 안내 배너, 설정 화면에서 원클릭으로 모드 전환.
  - **가상거래(Paper Trading) 모드**: 실제 업비트 실시간 호가/시세 및 캔들 지표를 그대로 조회하여 매수/매도 조건을 평가하되, 실제 업비트 주문 API를 호출하지 않고 가상 체결(`paper-bid-*`, `paper-ask-*`, 수수료 0.05% 반영)로 안전하게 모의투자 실행. 실제 계좌 자금은 1원도 소진되지 않음.
  - **실거래(Live Trading) 모드**: 실제 업비트 API 키로 실제 원화/코인 주문을 거래소에 직접 전송하여 체결.
  - **실제 거래와 가상거래의 원장 테이블 완전 분리**:
    - 실거래는 `trades` / `bot_positions`에 기록.
    - 가상거래는 `paper_trades` / `paper_bot_positions`에 기록.
    - 거래현황 및 통계 화면은 현재 모드에 맞추어 해당 테이블만 조회.
  - **가상거래 이력 초기화 (Reset Paper Trades) 기능**:
    - 가상거래 모드 시 거래현황 상단 배너, 설정 화면, 검증소 화면에 **`[🔄 가상거래 이력 초기화]`** 버튼 제공.
    - 실행 시 `paper_trades`와 `paper_bot_positions`를 완전 삭제하고, 봇 상태 및 알고리즘 검증소 6대 모델을 초기 자본(1,000,000 KRW), 0% 수익률, 0건 체결로 클린 리셋.
- **5대 네비게이션 메뉴 구성**:
  1. `📊 거래현황`
  2. `📈 통계`
  3. `🧪 검증소` (알고리즘 검증소 / 가상 모델 실시간 랭킹 보드)
  4. `📰 뉴스` (실시간 뉴스 피드 & AI 종합 분석)
  5. `⚙️ 설정`

---

### 5.2 [메뉴 1] 거래현황 화면
- **업비트 실계좌 자산 요약 카드**:
  - 주문 가능 원화(KRW), 총 매수금액, 총 평가금액, 총 보유자산, 평가손익(원화 및 수익률 %), 보유 코인 목록(코인명, 수량, 매수평균가, 현재가, 수익률) 실시간 출력.
- **거래 모드 안내 배너**: 현재 운용 중인 모드(가상거래 모의투자 vs 업비트 실거래) 및 모드 원클릭 전환 버튼, 가상거래 시 `[🔄 가상거래 이력 초기화]` 버튼 표기.
- **상단 AI 실시간 마켓 브리핑 (Gemini AI 스트리밍)**:
  - 접이식 아코디언 카드 (기본 접힘, 클릭 시 펼침).
  - `[⚡ AI 시황 분석 요청]` 클릭 시 Server-Sent Events(SSE)로 청크를 수신하여 한 글자씩 부드러운 타이프라이터 효과로 실시간 출력.
- **3대 봇 제어 카드 및 탭**:
  - 봇별 별명, 상태(가동중/중지), 할당원금, 가용잔고, 손절/익절 설정 표기.
  - `거래 시작`, `거래 중지`, `매수 테스트`, `매도 테스트` 버튼 제공 및 Modal Popup 피드백.
- **1줄(Row) 통합 체결 게시판**:
  - 매수 정보(단가, 수량, 금액, 일시)와 매도 정보(단가, 수량, 금액, 일시, 실현손익)를 한 행에서 추적. 미체결 보유 포지션은 매도 영역 공란 유지.

---

### 5.3 [메뉴 2] 통계 화면
- **기간별 탭**: `일별 통계` / `주별 통계` / `월별 통계` (새로고침 시 선택 탭 유지).
- **통계 시작 기준일**: `2026.10.01`부터 누적 집계.
- **누적 수익률 선 그래프**: 기간별 누적 실현 손익 곡선 시각화.
- **손익 색상 구분 규칙 (필수)**:
  - **이익(> 0)**: 빨간색 (`#ef4444`)
  - **손해(< 0)**: 파란색 (`#3b82f6`)
  - **0원(= 0)**: 검은색/회색 뱃지
- **코인별 수익 기여도 순위 테이블**: 누적 실현 손익 및 승률 순위 표기.

---

### 5.4 [메뉴 3] 알고리즘 검증소 (Algorithm Validation Lab / Testbed)

#### ① 6대 퀀트 알고리즘 모델 병렬 구동 (각 초기 가상 자본 1,000,000 KRW)
1. **변동성 돌파 (Larry Williams)**: 전일 변동폭 K=0.4 돌파 + 20일 이동평균선 상회 시 매수.
2. **듀얼 모멘텀 (Dual Momentum)**: 상대 모멘텀 상위 + 7일 절대 모멘텀 > +1.5% 돌파 시 스윙 매수.
3. **볼린저 밴드 역추세 (BB Reversal)**: 15분봉 볼린저 밴드 하단선 터치(-2σ) & RSI <= 30 극단 과매도 반등 매수.
4. **MACD + RSI 골든크로스 (MACD Trend)**: 15분봉 MACD 시그널선 상향 돌파 & RSI 45~65 추세 확장 시 매수.
5. **RSI 극단 과매도 스캘핑 (RSI Scalper)**: 15분봉 RSI <= 25 패닉셀 구간 진입 매수, RSI 50 도달 또는 +1.5% 시 즉시 청산.
6. **슈퍼트렌드 & ATR 동적 스탑 (SuperTrend ATR)**: 14일 ATR 1.8배 동적 트레일링 스탑 적용 추세추종.

#### ② 실시간 지표 기반 평가 및 랭킹 산출
- 실제 업비트 실시간 호가/시세(`fetchUpbitTickersMap`) 및 캔들 지표를 10초 주기로 수신하여 신호 평가 및 가상 체결(수수료 0.05% 차감/반영).
- 실시간 수익률(`profit_rate_pct = ((eval_assets_krw - initial_capital) / initial_capital) * 100`)을 기준으로 1위부터 6위까지 실시간 랭킹 자동 재계산.

#### ③ TOP 3 랭킹 포디움 (Podium) & 랭킹 보드
- **상단 TOP 3 포디움**: 🥇 1위(챔피언, Gold), 🥈 2위(Silver), 🥉 3위(Bronze) 카드 3단 강조 뷰 (수익률, 평가자산, 승률, 최근 시그널).
- **실시간 랭킹 테이블**: 전체 6개 모델 순위, 모델명, 분류, 실시간 수익률, 총 평가자산, 가용 현금, 승률(전적), 보유 포지션 표시. 행 클릭 시 해당 모델의 매매 이력만 필터링.
- **가상 매매 체결 이력 (Paper Trade History)**: 모델별 가상 체결 내역(체결가, 체결수량, 체결금액, 실현손익, 진입/청산 사유) 실시간 출력.
- **제어 버튼**:
  - **[🔄 실시간 검증 실행]**: 10초 대기 없이 즉시 전체 모델 시뮬레이션 및 랭킹 갱신 트리거.
  - **[초기화 (100만원 리셋)]**: 모든 모델의 가상 자본을 1,000,000 KRW, 보유 포지션 0, 매매 이력을 초기화.

---

### 5.5 [메뉴 4] 뉴스 화면

#### ① 뉴스 수집 및 감성 분석 엔진 (`news_service.mjs`)
- Google News(국내/글로벌) 및 TokenPost RSS를 실시간 파싱하여 주요 가상자산 뉴스 수집 (중복 링크 방어).
- 제목 및 본문 기반 감성 분석: `▲ 호재(BULLISH)`, `▼ 악재(BEARISH)`, `● 중립(NEUTRAL)`.
- 키워드 자동 태깅: `#비트코인`, `#이더리움`, `#업비트`, `#바이낸스`, `#리플`, `#솔라나`, `#ETF`, `#규제/정책`, `#시황/전망`, `#해킹/보안`.
- 서버 기동 시 최초 수집 및 **30분 주기 백그라운드 자동 갱신**. 상단 **[🔄 최신 뉴스 즉시 수집]** 버튼 제공.

#### ② 검색 및 필터링 기능
- **날짜 범위 검색**: 시작일(`startDate`) 및 종료일(`endDate`) 캘린더 입력.
- **통합 키워드 검색**: 기사 제목, 요약, 언론사, 해시태그 대상 실시간 검색.
- **인기 태그 뱃지**: 원클릭으로 검색어에 태그 자동 입력 및 즉시 조회.

#### ③ 50건 단위 목록 뷰 및 행(Row) 높이 동일화 (필수 준수)
- **한 화면 50건 노출**: `limit=50`, 전체 페이지네이션(`« 처음`, `‹ 이전`, 페이지 번호 7개, `다음 ›`, `마지막 »`).
- **Row 높이 동일화 (`.news-board-table`)**:
  - 테이블에 `table-layout: fixed; width: 100%;` 적용.
  - 모든 행(`tr`) 및 셀(`td`)에 고정 높이(`height: 48px; max-height: 48px; line-height: 48px; vertical-align: middle;`) 적용.
  - 제목이 길어도 줄바꿈되지 않고 1줄 말줄임표(`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`)로 표시되어 **모든 행의 높이가 완벽히 동일**해야 함.
  - 마우스 호버 시 기사 전체 제목과 요약문이 툴팁(`title`)으로 노출되어 언제든 원문 확인 가능.
  - 기사 제목 클릭 시 새 탭(`target="_blank"`)에서 원문 기사 오픈.

#### ④ 뉴스 기반 AI 종합 판단 및 시황 분석 (Gemini SSE 스트리밍)
- **접을 수 있는 아코디언 영역 (Collapsible Box)**: 상단 **[▲ 접기] / [▼ 펼치기]** 토글 버튼 및 카드 헤더 클릭으로 영역 개폐 가능.
- **'AI 분석하기' 버튼 클릭 시 실시간 스트리밍 한 글자씩 타이핑**:
  - **[🤖 AI 분석하기]** 클릭 시 백엔드 `/api/ai/stream-news-analyze` 엔드포인트(SSE) 호출.
  - 수집된 250+ 뉴스와 호재/악재 비율을 Gemini AI(`gemini-3.5-flash-lite`)가 분석.
  - 청크 토큰을 큐에 담아 **18ms 간격으로 한 글자씩 부드럽게 화면에 타이핑(Typewriter Effect)** 출력.

---

### 5.6 [메뉴 5] 설정 화면
- **거래 실행 모드 설정**: 가상거래(모의투자) 모드 ↔ 업비트 실거래 모드 전환 및 현재 상태 설명.
- **업비트 실계좌 자산 확인**: 읽기 전용으로 실제 보유 원화, 매수금액, 총 평가금액, 평가손익률 표시.
- **자금 분배 비율 및 원금 설정**: 전체 운용 원금 및 봇별 배분 비율(%) 설정 시 소수점 버림(`Math.floor`) 처리.
- **봇 파라미터 및 별명 수정**: 손절율, 익절율, 최소 거래대금, 전략별 계수(K값, 표준편차 배수) 저장.
- **보안 및 입장 코드(Gate Code) 설정**: 기본값 `stock`을 원하는 코드로 즉시 변경 및 현재 코드 조회/확인.
- **Gemini & Upbit API 키 등록/수정**: 웹 UI에서 API 키 직접 입력 및 저장 (마스킹 처리).
- **JSON 데이터 마이그레이션(백업) 및 복원**:
  - SQLite의 전체 데이터(봇, 거래내역, 포지션, 설정)를 단일 JSON 파일로 Export.
  - JSON 파일을 업로드하여 기존 DB를 무결성 검증과 함께 완벽 복원 (UNIQUE 충돌 방어 처리 포함).
- **가상거래 이력 초기화**: 원클릭으로 가상 거래 이력 및 검증소 모델 클린 리셋.

---

## 6. 백엔드 주요 REST 및 SSE API 명세

| Method | Endpoint | 설명 및 반환 형태 |
|---|---|---|
| `POST` | `/api/auth/verify` | 게이트 입장 코드(`stock` 또는 변경된 코드) 검증 및 인증 결과 반환 |
| `GET` | `/api/settings/entry-code` | 현재 적용된 보안 입장 코드 조회 |
| `POST` | `/api/settings/entry-code` | 새 보안 입장 코드 설정 및 SQLite/PostgreSQL 동기화 |
| `GET` | `/api/upbit/status` | 업비트 API 통신 상태(`green`/`yellow`/`red`) 및 응답 지연시간(`latency_ms`) |
| `GET` | `/api/upbit/account` | 업비트 실계좌 보유 원화, 매수금액, 평가금액, 평가손익, 보유 코인 목록 |
| `GET` | `/api/system/overview` | 시스템 가동 상태, 총 원금, 운용 원금, 봇 수, 전체 미실현/실현 손익 요약 |
| `GET` | `/api/bots` | 3대 봇 목록, 현재 상태, 할당자금, 가용잔고, 미매도 오픈 포지션 |
| `POST` | `/api/bots/:id/start` | 특정 봇 자동매매 가동 시작 |
| `POST` | `/api/bots/:id/stop` | 특정 봇 자동매매 중지 |
| `POST` | `/api/bots/:id/manual-trade` | 매수/매도 테스트 (실제 매수/매도 없이 유효성만 검증) |
| `PUT` | `/api/bots/:id` | 봇 별명, 최소 주문금액, 손절율, 익절율, 세부 전략 파라미터 갱신 |
| `GET` | `/api/trades` | 거래 체결 내역 조회 (현재 모드에 따라 `trades` 또는 `paper_trades` 자동 분기) |
| `GET` | `/api/statistics` | 기간별(일/주/월) 누적 실현손익 곡선 및 코인별 손익 기여도 랭킹 |
| `GET` | `/api/trade-mode` | 현재 거래 모드(`paper` 또는 `live`) 조회 |
| `POST` | `/api/trade-mode` | 거래 모드 변경 (`mode: "paper"` 또는 `"live"`) |
| `POST` | `/api/paper-trades/reset` | 가상거래 내역(`paper_trades`, `paper_bot_positions`) 완전 삭제 및 초기화 |
| `GET` | `/api/algo-lab/models` | 알고리즘 검증소 6대 모델 현황 및 실시간 랭킹 순위 |
| `GET` | `/api/algo-lab/trades` | 알고리즘 검증소 모델별 가상 매매 체결 이력 |
| `POST` | `/api/algo-lab/run-cycle` | 10초 대기 없이 즉시 6대 모델 시뮬레이션 1사이클 강제 실행 |
| `POST` | `/api/algo-lab/reset` | 검증소 6대 모델 가상 자본(1,000,000 KRW) 및 매매 기록 클린 리셋 |
| `GET` | `/api/news` | 수집된 뉴스 50건 페이징 목록, 검색, 태그 필터링, 전체 통계 반환 |
| `POST` | `/api/news/refresh` | 최신 뉴스 즉시 수집 트리거 (Google News + TokenPost) |
| `GET/POST`| `/api/ai/stream-analyze` | Server-Sent Events(SSE) 실시간 Gemini AI 마켓 시황 스트리밍 |
| `GET/POST`| `/api/ai/stream-news-analyze` | Server-Sent Events(SSE) 실시간 Gemini AI 뉴스 종합 분석 스트리밍 |
| `PUT` | `/api/settings/allocation` | 총 운용 원금 및 봇별 자금 배분 비율(%) 저장 (`Math.floor` 내림 적용) |
| `GET` | `/api/settings/export` | 전체 SQLite DB 테이블 데이터 JSON 백업 다운로드 |
| `POST` | `/api/settings/import-json` | JSON 백업 파일을 업로드하여 DB 무결성 복원 |

---

## 7. 외부 네트워크, 터널 및 운영 스크립트 명세

### 7.1 Vite 프록시 (`frontend/vite.config.js`)
```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 9000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
});
```

### 7.2 서비스 실행 및 종료 스크립트
- **Linux (`start_services.sh` / `stop_services.sh`)**:
  - `start_services.sh`: 백엔드(`backend/node_server.mjs`, 포트 8001) 및 프론트엔드(`frontend`, 포트 9000)를 백그라운드 구동(`nohup`)하고 HTTP 헬스체크 수행.
  - `stop_services.sh`: 포트 8001과 9000을 점유하는 프로세스를 `fuser -k` 또는 `kill`로 안전 종료.
- **Windows (`start_services.bat` / `stop_services.bat` / `start_silent.vbs`)**:
  - 무음 백그라운드 실행을 위한 VBScript 런처 제공.
- **Cloudflare 터널 스크립트 (`start_tunnel.sh` / `stop_tunnel.sh`)**:
  - `start_tunnel.sh`: IPv4 명시 바인딩 및 자동 업데이트 종료 방지 옵션(`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9000`)으로 안정적인 외부 HTTPS 접속 도메인 발급.
  - `stop_tunnel.sh`: 9000 포트 전용 터널만 선별 종료하여 다른 포트의 터널을 보호.

---

## 8. 코드 구현 시 품질 및 안정성 지침 (절대 준수)

1. **국소 수정 및 기존 기능 보존 원칙**:
   - 신규 기능 추가 또는 수정 시 기존 정상 가동 중인 실계좌 요약 카드, 봇 매매 로직, 통계 차트, 뉴스 피드, AI 브리핑 기능을 훼손하거나 삭제하지 마십시오.
2. **React TDZ(Temporal Dead Zone) 방어**:
   - `App.jsx`에서 모든 `useCallback`, `useMemo` 및 데이터 조회 함수(`fetchUpbitAccount`, `fetchNews`, `fetchBots` 등)는 반드시 `useEffect`보다 코드 상단에 먼저 선언하여 TDZ ReferenceError를 원천 차단하십시오.
3. **상대 경로 API 호출**:
   - 프론트엔드에서 API 호출 시 하드코딩된 `http://localhost:8001`을 절대 사용하지 않고 상대 경로(`""` 또는 `"/api/..."`)를 사용하여 사내 LAN, 로컬, 외부 Cloudflare HTTPS 터널에서 모두 무설정으로 작동하도록 구현하십시오.
4. **민감 정보 보호 및 커밋 규칙**:
   - API 키, 시크릿 키는 절대 소스코드에 하드코딩하지 말고 `config/upbit_config.json` 또는 `.env`로 격리하십시오.
   - 작업 완료 후 기능 단위로 명확한 커밋 메시지(`feat`, `fix`, `refactor`)를 작성하여 git commit을 완료하십시오.
