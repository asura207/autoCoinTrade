# Upbit 다중 전략 코인 자동매매 시스템 사용자 가이드 (`howtorun.md`)

본 문서는 `prompt.md` 및 `initRule.md` 요구사항을 기반으로 구현된 **업비트(Upbit) Open API 코인 자동매매 프로그램**의 설치, 설정, 실행 방법, 종료 방법 및 화면별 사용 방법을 안내합니다.

---

## 1. 프로젝트 디렉토리 구조

```text
autoCoinTrade/
├── agentBot/                        # [Python 전략 모듈] 확장 전략 봇 패키지
│   ├── __init__.py
│   └── bot_10_jack_kellogg.py       # [Bot 10] Jack Kellogg VWAP + 선형 회귀 채널 프라이스 액션
├── backend/
│   ├── common/
│   │   ├── algo_lab_service.mjs     # 10대 알고리즘 상시 가상 경쟁(Arena) · 주간 전략군 TOP 1 로테이션 엔진
│   │   ├── backtest_service.mjs     # Zero Look-Ahead 과거 캔들 백테스팅 & Walk-Forward(70/30) 검증기
│   │   ├── crypto_vault.mjs         # Node.js ↔ Python 상호 호환 AES-256-GCM API 키 암호화 볼트
│   │   ├── execution_quality_service.mjs # 호가창 OBI · 스프레드 가드 · MTF 추세 필터 · ATR 역가중 사이징
│   │   ├── live_order_guardrail.mjs # 5중 실전 중복 주문 원천 차단 하드 가드레일 (리스 락 · 2PC · 뮤텍스 · 하드 캡)
│   │   ├── log_rotator.mjs          # KST 일일 로그 로테이션 및 7일 보존 정책
│   │   ├── news_service.mjs         # Google News & TokenPost RSS 30분 주기 수집 및 감성 분석
│   │   ├── notification_hub.mjs     # Telegram / Discord / WebPush 멀티채널 알림 디스패처
│   │   ├── pg_db.mjs                # PostgreSQL 16 비동기 커넥션 풀 어댑터
│   │   ├── pg_sync.mjs              # SQLite → PostgreSQL 16 실시간 양방향 동기화 및 자동 마이그레이션
│   │   ├── sqlite_db.mjs            # Node.js 내장 node:sqlite (WAL 모드) 래퍼
│   │   └── upbit_ws_hub.mjs         # [메인] 업비트 WebSocket 실시간 스트림 허브 & REST 자동 폴백
│   └── node_server.mjs              # Node.js >= 22.5.0 통합 REST API · SSE · 실전/가상 봇 엔진 (Port 8001)
├── frontend/                        # React 18 + Vite 8 프로덕션 정적 웹 대시보드 (Port 9000)
│   ├── src/
│   │   ├── App.jsx                  # 입장코드, 5대 메뉴, 가드레일/백테스트/타점 차트 모달 메인 UI
│   │   ├── main.jsx
│   │   └── styles.css               # 다크 모드 및 한국식 손익 색상(이익:빨강, 손해:파랑) 스타일
│   ├── server.mjs                   # 프로덕션 정적 번들 서빙 + /api SSE 리버스 프록시 서버
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── install/                         # Windows / Linux 비개발자용 원클릭 독립 배포 패키지
├── scripts/                         # 운영·DB 마이그레이션·Windows 시작프로그램(install/uninstall_startup.bat)·패키징 도구
├── tests/                           # Node 11종 + Python QA 자동화 검증 스위트 (5중 가드레일 스트레스 테스트 포함)
├── docs/                            # 전수 QA 체크리스트(QA_CHECKLIST.md) 및 고도화 명세서
├── .github/workflows/ci.yml         # GitHub Actions CI 자동 검증 파이프라인
├── Dockerfile / docker-compose.yml  # 비루트 멀티스테이지 Docker 컨테이너 배포 구성
├── bots.py                          # Python 독립 봇 실행기 (LIVE_EXECUTOR_OWNER 규칙 준수, Graceful Drain 지원)
├── llm_filter_worker.py             # 로컬 Ollama(qwen3-news) + Gemini Dual AI 10대 봇 개별 제어 워커
├── market_hub.py                    # [Python 독립 전용] 중앙 REST 시세 캐시 및 120ms Rate Limit 방어 (Node upbit_ws_hub.mjs와 분리)
├── main_orchestrator.py             # Python 멀티프로세싱 오케스트레이터 (Node 실행 및 LIVE_EXECUTOR_OWNER 충돌 시 자동 Yield)
├── init_db.py                       # SQLite 초기화 및 전체 스키마 자동 마이그레이션
├── config/
│   ├── upbit_config.example.json    # 업비트·Ollama·Gemini·가드레일 설정 템플릿 (Git 추적용)
│   └── upbit_config.json            # 실제 설정 파일 (AES-256-GCM 암호화 저장, .gitignore 제외)
├── data/
│   └── auto_coin_trade.db           # SQLite WAL 데이터베이스 파일 (최초 실행 시 자동 생성)
├── setup.sh / setup.bat             # 원클릭 환경 구축 스크립트 (Node >= 22.5.0, 루트/프론트 의존성, .venv)
├── start_services.sh / .bat         # 공식 원클릭 백그라운드 실행 스크립트 (Backend 8001 + Frontend 9000)
├── stop_services.sh / .bat          # 공식 원클릭 안전 종료 스크립트 (PID·포트·프로젝트 CWD 기준 좀비 정리)
├── run_orchestrator.sh / .bat       # Python 오케스트레이터 실행 스크립트 (LIVE_EXECUTOR_OWNER 가드 안내 포함)
├── start_tunnel.sh / stop_tunnel.sh # Cloudflare Quick Tunnel HTTPS 외부 원격 접속 스크립트
├── package.json                     # 루트 Node 의존성 (pg, web-push, better-sqlite3), 테스트 스크립트 및 0.0.X 버전 메타데이터
└── requirements.txt                 # Python 의존성 패키지 목록 (cryptography 포함)
```

---

## 2. 최초 1회 사전 설치 방법

### 방법 1: 원클릭 환경 구축 (권장)
- **Linux / macOS**:
  ```bash
  chmod +x setup.sh && ./setup.sh
  ```
- **Windows**:
  ```cmd
  .\setup.bat
  ```
Node.js 버전(`>= 22.5.0`) 확인, 디렉토리 생성, 설정 템플릿 복사, 루트 및 프론트엔드 패키지 설치, Python `.venv` 구성이 자동으로 진행됩니다.

### 방법 2: 수동 설치
1. **Node.js 22 LTS (v22.5.0 이상)** 확인:
   백엔드가 내장 SQLite 모듈(`node:sqlite`)을 사용하므로 Node.js v22.5.0 이상이 필요합니다.
   ```bash
   node -v
   ```
2. **루트 및 프론트엔드 패키지 설치 & 프로덕션 번들 빌드**:
   ```bash
   npm install
   cd frontend
   npm install
   npm run build
   cd ..
   ```
   *(루트 `package.json`의 `pg`, `web-push`, `better-sqlite3` 등과 `frontend` React/Vite 8 패키지를 함께 설치하며, 프로덕션 정적 서버 `frontend/server.mjs`는 빌드된 `frontend/dist`를 서빙합니다.)*

### 방법 3: Docker Compose 원클릭 컨테이너 실행
Docker 환경이 준비된 경우 별도 Node/Python 설치 없이 바로 기동할 수 있습니다.
```bash
cp .env.example .env
cp config/upbit_config.example.json config/upbit_config.json
docker compose up -d --build
# 종료: docker compose down
```

---

## 3. 업비트 Open API · AI · 5중 가드레일 설정 (`config/upbit_config.json` & `.env`)

1. `config/upbit_config.json` 파일을 엽니다. (파일이 없다면 `config/upbit_config.example.json`을 복사하여 생성합니다.)
2. 업비트 Open API 키, Google Gemini 키, 로컬 Ollama(`qwen3-news`) 주소 및 실전 실행 주체(`live_executor_owner`)를 확인합니다.

```json
{
  "access_key": "YOUR_UPBIT_ACCESS_KEY",
  "secret_key": "YOUR_UPBIT_SECRET_KEY",
  "trade_mode": "paper",
  "request_timeout_sec": 5.0,
  "delay_threshold_ms": 800,
  "gemini_api_key": "YOUR_GEMINI_API_KEY_HERE",
  "gate_code": "stock",
  "use_local_ollama_news": true,
  "ollama_base_url": "http://192.168.0.100:11434",
  "ollama_news_model": "qwen3-news",
  "ollama_timeout_ms": 120000,
  "live_executor_owner": "node",
  "live_lease_ttl_sec": 30,
  "live_reentry_cooldown_sec": 900,
  "live_min_buy_interval_sec": 60,
  "live_max_buys_per_bot_hour": 3,
  "live_max_buys_per_bot_day": 12,
  "live_max_total_buys_day": 30
}
```

- **`trade_mode` 옵션 안내**:
  - `"paper"` (*기본값*): 로컬 시뮬레이션(모의) 안전 모드로 동작합니다. 실제 업비트 계좌의 자금을 쓰지 않고 실시간 시세 기반으로 가상 매수/매도 및 DB 검증을 안전하게 수행합니다.
  - `"live"`: 입력된 업비트 Open API Key를 사용하여 **실제 업비트 시장가 매수/매도 주문**을 실행합니다.
- **`live_executor_owner` / `.env`의 `LIVE_EXECUTOR_OWNER`**:
  - 기본값은 `"node"`이며, **단일 실전 주문 실행 주체**를 강제합니다. 일치하지 않는 엔진(예: Node 운영 중 Python 오케스트레이터 동시 실행)이 실전 주문 API(`POST /v1/orders`)에 진입하면 즉시 하드 차단됩니다.
- **로컬 Ollama & Gemini Dual AI**:
  - 30분 단기 뉴스·시황(`FLASH_30M`)은 **1순위 로컬 Ollama (`qwen3-news`, `120s` 타임아웃) → 2순위 Gemini Flash → 3순위 BTC 20MA·4h 60MA 기계적 안전 모드** 3중 무중단 Fallback으로 동작합니다.
  - 1시간 정각 심층 검증(`PRO_60M`)은 Gemini Pro로 보수적 교차 검증을 수행합니다. 웹 UI `[⚙️ 설정]`에서도 바로 등록/테스트할 수 있습니다.
- **AES-256-GCM 암호화 볼트 & Git 제외 보안 규칙**:
  - 저장된 `access_key`, `secret_key`, `gemini_api_key`, Telegram/Discord 시크릿은 `backend/common/crypto_vault.mjs`를 통해 `enc:v1:...` 형식으로 자동 암호화(`chmod 600`)되며, `.gitignore`에 의해 `.env`, `config/upbit_config.json`, `data/*.db`, `data/.vault_master_key`는 Git Push에서 원천 제외됩니다.

---

## 4. 프로그램 실행 방법 (How to Run)

### 방법 A: 공식 무음 백그라운드 서비스 실행 (권장)
- **Linux / macOS**:
  ```bash
  ./start_services.sh
  ```
- **Windows**:
  `start_services.bat`을 더블클릭하거나 터미널에서 실행합니다.
  ```cmd
  .\start_services.bat
  ```
- 백엔드 서버(`http://127.0.0.1:8001`)와 프로덕션 프론트엔드 정적 서버(`http://127.0.0.1:9000`, `frontend/server.mjs`)가 백그라운드에서 실행되며, 프론트엔드 번들(`frontend/dist`)이 없으면 자동 빌드합니다.
- 웹 브라우저에서 **`http://localhost:9000`** 접속 (기본 입장 코드: `stock`, 한글 자판 오타 `ㄴ새차` 자동 변환은 기본 코드 상태에서만 지원, `⚙️ 설정` 화면 또는 `.env`에서 변경 가능).
- **스마트폰/태블릿 동일 Wi-Fi 접속**: `.env`에서 `FRONTEND_HOST=0.0.0.0` 설정 시 `http://<서버LAN_IP>:9000`
- **집 밖/모바일 데이터 외부 인터넷 접속 (권장)**:
  ```bash
  ./start_tunnel.sh
  # 출력되는 HTTPS 링크로 어디서나 접속 가능 (종료: ./stop_tunnel.sh)
  ```

### 방법 B: 비개발자용 `/install` 원클릭 독립 배포 패키지
- **Windows**: `install/AutoCoinTrade_Windows_Start.bat` 더블클릭 (종료: `install/AutoCoinTrade_Windows_Stop.bat`)
- **Linux**: `cd install && ./AutoCoinTrade_Linux_Start.sh` (종료: `./AutoCoinTrade_Linux_Stop.sh`)

### 방법 C: 터미널에서 수동으로 각각 실행 (개발 / 실시간 디버깅용)
1. **터미널 1 (Backend 실행)**:
   ```bash
   node backend/node_server.mjs
   ```
2. **터미널 2 (Frontend 실행)**:
   ```bash
   # 프로덕션 정적 서버 모드
   node frontend/server.mjs
   # 또는 개발 핫리로드(HMR) 모드
   cd frontend && npm run dev
   ```

---

## 5. 프로그램 종료 방법 (How to Stop)

### 방법 A: 공식 원클릭 종료 스크립트 실행 (권장)
- **Linux / macOS**:
  ```bash
  ./stop_services.sh
  # Cloudflare 터널까지 함께 종료할 경우:
  ./stop_services.sh --with-tunnel
  ```
- **Windows**:
  ```cmd
  .\stop_services.bat
  ```
- PID 파일(`logs/*.pid`), 포트(`8001` / `9000`), 및 본 프로젝트 작업 경로(`/proc/<pid>/cwd`)를 기준으로 Node/Python 좀비 프로세스를 안전하게 종료합니다(다른 프로젝트 프로세스는 건드리지 않음).

### 방법 B: 외부 터널 단독 종료
```bash
./stop_tunnel.sh
```

## 6. 웹 화면 사용 가이드

### 6.1 입장 코드 입력 화면
- 웹 브라우저에서 `http://localhost:9000` 접속 시 입장 코드 입력 화면이 나타납니다.
- 기본 입장 코드: **`stock`** (한글 자판 오타 `ㄴ새차` 자동 변환 및 대소문자 무관)
  - `⚙️ 설정` 화면 또는 `.env` 파일(`GATE_CODE=...`)에서 원하는 사용자 지정 코드로 언제든 변경할 수 있습니다.
- 코드가 일치하면 좌측 메뉴(`20%`)와 우측 상세 화면(`80%`)으로 구성된 다크 테마 메인 화면으로 진입합니다.

### 6.2 좌측 상단 업비트 통신 · WebSocket · 5중 가드레일 상태 표시기
- **업비트 API 통신 상태**: **정상통신 (`초록색`, `<800ms`)** / **통신지연 (`노란색`)** / **통신불가 (`빨간색`)** — 마우스 Hover 시 응답 속도(ms), 모드, 오류 원인을 툴팁으로 표시합니다.
- **실시간 시세 허브 배지 (`WS 실시간` / `REST 폴백`)**: `wss://api.upbit.com/websocket/v1` 실시간 스트림 수신 여부와 틱 반응형 즉시 청산 가동 상태를 표시합니다.
- **🛡️ 5중 가드레일 보호 배지 (클릭 시 상세 모달)**: `LIVE_EXECUTOR_OWNER` 단일 실행 주체, 리스 락 만료 시각, 24시간/1시간 매수 캡 잔여 횟수, `UNKNOWN_TIMEOUT` 미정산 주문 건수, 최근 차단 로그 및 이상 감지 비상 정지(Emergency Halt) 수동 해제 버튼을 제공합니다.

### 6.3 [메뉴 1] ⚡ 실제거래 현황
- **업비트 실계좌 자산 요약**: 원화 잔고, 총 평가금액, 총 평가손익(수익률 %), 보유 코인 목록 실시간 표시.
- **듀얼 AI 시황 브리핑 & 10대 봇 개별 제어**:
  - 30분 단기(`FLASH_30M`): **로컬 Ollama (`qwen3-news`) → Gemini Flash → BTC 20MA 기계적 안전 모드** 3중 Fallback으로 동작하며, 헤더 및 카드에 실제 실행 모델명을 투명하게 표출합니다.
  - 1시간 심층(`PRO_60M`): Gemini Pro 교차 검증 및 `bot_01`~`bot_10` 개별 `ALLOW`/`BLOCK` 제어(보유 포지션 청산 매도 루프는 절대 비차단).
- **사용자 선택 및 주간 자동 로테이션 실전 봇(1~3개) 제어**:
  - `⚙️ 설정`에서 수동 선택하거나 주간 전략군 TOP 1 자동 로테이션으로 선출된 봇(Jack Kellogg 프라이스 액션 `bot_10` 포함)만 동적으로 노출되며 개별 `▶ 거래시작` / `■ 거래중단` 제어 가능. 교체 시 오픈 포지션이 있는 봇은 **청산 대기(Graceful Drain)** 배지로 안전 관리됩니다.
- **잔고 0원 이하 자동 전체 중지 알림**:
  - 설정된 잔고가 `0`원 이하로 떨어지면 모든 봇이 자동으로 거래 중지되며, 진입 시 **Modal Popup**으로 즉시 안내.
- **1줄(Row) 통합 실전 체결 게시판 & 인터랙티브 타점 차트**:
  - `매수`, `매도`, `매수일`, `매도일`, `차익`, 슬리피지(`bps`)가 한 줄로 표시되며, 각 행의 **`[📈 타점]`** 버튼으로 캔들스틱 + VWAP/LRC/20MA + BUY(▲)/SELL(▼) 타점 마커 차트 모달을 확인할 수 있습니다.

### 6.4 [메뉴 2] 🏆 가상거래 경쟁 (Always-On Arena) & 백테스트 검증
- **10대 알고리즘 봇(`bot_01` ~ `bot_10`) 상시 가상 시뮬레이션**:
  - LLM 필터 및 실전 비상 정지와 무관하게 순수 알고리즘 경쟁을 펼치는 무중단 가상 아레나 (초기 자본 100만 원).
- **TOP 3 랭킹 포디움 & 리더보드**:
  - 🥇 1위, 🥈 2위, 🥉 3위 봇의 실시간 수익률, 총 평가자산, 승률, MDD 하이라이트 및 개별 봇 가상 체결 로그 필터링.
- **제어 기능**: `[🔄 실시간 검증 실행]`, `[📊 백테스트 검증]` (Zero Look-Ahead 과거 캔들 시뮬레이션 · Walk-Forward 70/30 검증 · SVG 자산 곡선 · 원클릭 파라미터 반영), `[초기화 (100만원 리셋)]`.

### 6.5 [메뉴 3] 📈 통계
- **실제거래 ↔ 가상거래 통계 탭 전환**: 실계좌와 모의투자 통계를 분리 조회하고, 월별 보유 자산 증감 차트 및 체결 평균 슬리피지(`bps`) 지표를 제공합니다.
- **일간 / 주간 / 월간 탭**: `2026.10.01`을 시작 기준으로 각 기간별 누적 손익 곡선(선 그래프) 시각화.
- **다빈도 거래 코인 순위 게시판**:
  - 가장 많이 거래된 코인 순으로 정렬되어 한국식 손익 색상으로 구분 표시:
    - **이익 (`> 0`)**: **빨간색** (`#ef4444`)
    - **손해 (`< 0`)**: **파란색** (`#3b82f6`)
    - **그 외 (`= 0`)**: **회색/검은색 뱃지**

### 6.6 [메뉴 4] 📰 뉴스 (실시간 뉴스 피드 & AI 종합 분석)
- **Google News & TokenPost RSS 실시간 수집**:
  - 30분 주기 백그라운드 자동 수집 + `[🔄 최신 뉴스 즉시 수집]` 버튼 제공.
  - 호재/악재 감성 분석(`▲ 호재`, `▼ 악재`, `● 중립`) 및 자동 태그 추출.
- **50건 목록 뷰 & 48px 고정 행 높이**:
  - 행 높이 48px 및 1줄 말줄임표 처리, 마우스 호버 시 툴팁 제공.
- **AI 종합 분석**: 로컬 Ollama(`qwen3-news`) / Gemini AI로 최신 뉴스를 종합 분석하여 실시간 SSE 타이프라이터 스트리밍 제공.

### 6.7 [메뉴 5] ⚙️ 설정 (시스템·보안 · 로테이션 · Ollama · 멀티채널 알림 통합 관리)
- **실전 담당 봇 선택 · 주간 전략군 TOP 1 자동 로테이션 및 동적 투자금 배분 패널**:
  - 10대 봇(`bot_01`~`bot_10`) 중 실전 투입 봇 1~3개 수동 선택 또는 **주간 전략군 TOP 1 자동 로테이션** 활성화, Graceful Drain 자동 이관, 비율 합계 100% 검증 및 `Math.floor` 내림 적용.
- **로컬 Ollama AI 설정 (3-1)**: `use_local_ollama_news`, `ollama_base_url`, `ollama_news_model`, `ollama_timeout_ms` 설정 및 실시간 연결 테스트.
- **멀티채널 알림 허브 (5-1)**: Telegram Bot Token/Chat ID, Discord Webhook URL, WebPush 브라우저 구독 설정(AES-256-GCM 암호화 저장), 이벤트별 발송 토글 및 테스트 발송.
- **거래 모드 · 보안 입장 코드 · API 키 암호화 저장**:
  - 모의투자 ↔ 실거래 전환, `HttpOnly` 서명 세션 쿠키 기반 입장 코드 변경, 업비트/Gemini API 키 AES-256-GCM 암호화 저장.
- **데이터 마이그레이션 (JSON)**: SQLite 전체 DB(`schema_version: 1.2`) 백업 내보내기(민감 API 키·입장 코드 제외) 및 트랜잭션 복원(Import).

---

## 7. 확장 전략 봇 · 5중 실전 가드레일 및 검증 테스트 가이드

파이썬 전략 엔진 및 Jack Kellogg 프라이스 액션 모듈은 루트 및 `agentBot/`에서 관리됩니다:
- **Bot 1~9 핵심 전략**: `bots.py` 및 `backend/common/algo_lab_service.mjs`
- **Bot 10 (Jack Kellogg VWAP · 선형 회귀 채널)**: `agentBot/bot_10_jack_kellogg.py` & `backend/common/algo_lab_service.mjs`
- **시세 허브 역할 분리**:
  - **Node.js 메인 백엔드**: `backend/common/upbit_ws_hub.mjs` (WebSocket 실시간 스트림 + 틱 반응형 청산 + REST 폴백)
  - **Python 독립 오케스트레이터 전용**: `market_hub.py` (Python 단독 기동 시에만 사용하는 중앙 REST 시세 캐시, `120ms` Rate Limit 방어)
- **오케스트레이터 (`main_orchestrator.py`)**: Node 백엔드(Port `8001`) 동시 가동 또는 `LIVE_EXECUTOR_OWNER=node` 설정 시 실전 매매 중복 집행을 원천 차단합니다.

> **5중 실전 중복 주문 차단 하드 가드레일 (`backend/common/live_order_guardrail.mjs`, v0.0.30+)**:
> 1. **Layer 1 (단일 실행 주체 & 리스 락)**: `LIVE_EXECUTOR_OWNER` 일치 검증 + SQLite `live_executor_lease`(TTL 30초, `BEGIN IMMEDIATE`) 원자적 점유.
> 2. **Layer 2 (2단계 커밋 & 업비트 `identifier` 멱등성)**: API 호출 전 `live_order_intents`에 `PENDING` 원장 선점 + `virtual_krw` 원자적 선차감, 업비트 주문 `identifier = intent_id` 전송, 타임아웃 시 `GET /v1/order?identifier=...` 정산(확정 미생성 시에만 1회 환불).
> 3. **Layer 3 (프로세스 내 Async Mutex)**: 동일 `(bot_id, market)` 주문의 비동기 루프 중첩 및 틱 청산 경합을 단일 슬롯으로 직렬화.
> 4. **Layer 4 (쿨다운 & 빈도 하드 캡)**: 종목 재매수 `900초` 쿨다운, 봇 매수 최소 `60초` 간격, 봇별 시간당 `3회`/일 `12회`, 전체 일 `30회` 하드 캡.
> 5. **Layer 5 (이상 감지 비상 정지 & 대시보드 제어)**: 5분 내 가드레일 차단 5회 이상 또는 타임아웃 2회 이상 시 실전 신규 매수 자동 비상 정지(보유 포지션 청산 및 가상 Arena는 정상 유지), `/api/guardrail/status` 및 헤더 모달에서 확인/해제.

### 자동화 검증 테스트 실행
```bash
# 5중 실전 중복 주문 가드레일 7대 장애 스트레스 테스트
npm run test:guardrail

# 전체 자동화 검증 스위트 (Node 11종 + Python QA)
npm run test:all
```

