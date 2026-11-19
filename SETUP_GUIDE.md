# Upbit AutoCoinTrade - 다른 PC 및 AI Agent를 위한 환경 세팅 및 실행 가이드

> **대상**: 다른 PC에서 저장소를 `git clone` 또는 `git pull` 받은 후 즉시 빌드 및 실행하려는 **개발자** 및 **AI Agent (LLM, Autonomous Coding Agent)**

---

## 1. 시스템 필수 요구사항 (Prerequisites)

| 구분 | 요구 버전 | 필수 여부 | 설명 |
| :--- | :--- | :---: | :--- |
| **Node.js** | **v22.5.0 이상** (권장: **v22.18+ / Node 22 LTS**) | **필수** | 백엔드(`backend/node_server.mjs`)가 Node 내장 SQLite 모듈인 `node:sqlite`(`DatabaseSync`)를 사용합니다. **v22.5.0 미만(Node 18/20)에서는 동작하지 않습니다.** |
| **npm** | Node.js 동봉 버전 | **필수** | 프론트엔드(`frontend/`) React/Vite 의존성 설치용 |
| **OS** | Windows 10/11 (스크립트 기본 제공) / Linux / macOS | 권장 | Windows 환경에 최적화된 백그라운드 구동 스크립트(`.bat`, `.vbs`, `.ps1`) 제공 |
| **Git** | 최신 버전 | **필수** | 소스코드 형상관리 |
| **Python** | 3.10 이상 | *선택 사항* | `agentBot/` 전략 알고리즘 연구 또는 레거시 FastAPI 테스트 시에만 필요. **메인 서비스는 Python 없이 Node.js 단독으로 100% 자립 구동됩니다.** |

---

## 2. 초고속 원클릭 초기 설정 (Quick Start)

### 방법 A: 원클릭 초기 설정 스크립트

#### Linux / macOS:
```bash
chmod +x setup.sh && ./setup.sh
```

#### Windows:
```cmd
.\setup.bat
```

> **설정 스크립트가 자동으로 수행하는 작업**:
> 1. `Node.js` 설치 여부 및 버전 `>= 22.5.0` 자동 검증
> 2. `logs/` 및 `data/` 디렉터리 자동 생성
> 3. `config/upbit_config.json` 부재 시 `config/upbit_config.example.json`에서 자동 복사 생성 (기본: 모의투자 `paper` 모드)
> 4. `frontend/` 디렉터리로 이동하여 `npm install` 실행
> 5. Python 가상환경(`.venv`) 준비 및 패키지 설치 (오케스트레이터 및 봇 모듈용)

---

### 방법 B: CLI 명령어로 수동 설정 (AI Agent 또는 Linux/macOS)

AI Agent나 터미널에서 직접 세팅할 때는 아래 명령어를 순서대로 실행합니다:

```bash
# 1. Node.js 버전 확인 (>= 22.5.0 필수)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error('Node.js >= 22.5.0 required'); process.exit(1); } else { console.log('Node version OK: ' + process.version); }"

# 2. 필수 디렉터리 생성
mkdir logs data

# 3. 설정 파일 템플릿 복사 (config/upbit_config.json 생성)
# Windows (CMD / PowerShell):
copy config\upbit_config.example.json config\upbit_config.json
# Linux / macOS:
# cp config/upbit_config.example.json config/upbit_config.json

# 4. 프론트엔드 패키지 의존성 설치
cd frontend
npm install
cd ..
```

> **Node.js 의존성 설치 안내**:
> `backend/node_server.mjs`는 Node.js `>= 22.5.0`의 내장 `node:sqlite`를 사용함과 동시에 루트 `package.json`의 `pg`, `web-push` 등을 사용하므로, `setup.sh` / `setup.bat` 실행 시 **프로젝트 루트와 `frontend` 폴더 모두에서 `npm install`이 수행됩니다**.

---

## 3. 설정 파일 안내 (`config/upbit_config.json` & `.env`)

`.gitignore`에 등록되어 있어 Git 추적에서 제외되므로, 신규 PC에서는 `config/upbit_config.example.json`과 `.env.example`을 복사하여 생성합니다.

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

### 주요 항목 설명
- **`trade_mode`**:
  - `"paper"` (*기본값*): 모의투자 시뮬레이션 안전 모드. 실제 자금을 쓰지 않고 실시간 호가/시세 기반 가상 매매 및 SQLite DB 검증.
  - `"live"`: 실제 업비트 시장가 매수/매도 주문 실행.
- **`live_executor_owner` / `.env`의 `LIVE_EXECUTOR_OWNER`**:
  - 기본값 `"node"`. 단일 실전 주문 실행 주체를 강제하며, 불일치하는 엔진(예: Python 워커)이 실전 주문 API에 진입하면 즉시 하드 차단됩니다.
  - `LIVE_REENTRY_COOLDOWN_SEC`(900초), `LIVE_MIN_BUY_INTERVAL_SEC`(60초), `LIVE_MAX_BUYS_PER_BOT_HOUR`(3회), `LIVE_MAX_BUYS_PER_BOT_DAY`(12회), `LIVE_MAX_TOTAL_BUYS_DAY`(30회)로 연속 결제 사고를 원천 차단합니다.
- **`access_key` / `secret_key` & AES-256-GCM 볼트**:
  - 업비트 Open API 키 및 알림 웹훅 시크릿은 저장 시 `backend/common/crypto_vault.mjs`에 의해 자동으로 `enc:v1:...` AES-256-GCM 암호화(`chmod 600`)됩니다. 선택적으로 `.env`에 `AUTOCOIN_VAULT_KEY`를 지정하거나 자동 생성되는 `data/.vault_master_key`를 사용할 수 있습니다.
- **로컬 Ollama (`qwen3-news`) & `gemini_api_key`**:
  - 30분 단기 뉴스·시황 분석은 `USE_LOCAL_OLLAMA_NEWS=true` 기준 **로컬 Ollama (`qwen3-news`, `120s` 타임아웃) → Gemini Flash → BTC 20MA 기계적 안전 모드** 3중 무중단 Fallback으로 동작합니다.
  - 1시간 정각 심층 검증(`PRO_60M`) 및 Gemini Fallback에 `gemini_api_key`가 사용되며, 웹 화면(`http://localhost:9000`) `[⚙️ 설정]`에서도 바로 등록/테스트할 수 있습니다.

---

## 4. 서비스 실행 방법 (How to Run)

### 모드 1: 백그라운드 원클릭 실행 (일반 운영용 — 권장)

#### Linux / macOS:
```bash
./start_services.sh
```

#### Windows:
```cmd
.\start_services.bat
```
- 백엔드(포트 `8001`)와 프로덕션 프론트엔드 정적 서버(`frontend/server.mjs`, 포트 `9000`)가 백그라운드 데몬으로 자동 시작됩니다(`frontend/dist` 부재 시 자동 빌드).
- 브라우저에서 **`http://localhost:9000`** 접속
- **외부/모바일 접속 (동일 Wi-Fi LAN)**: `.env`에서 `FRONTEND_HOST=0.0.0.0` 설정 시 `http://<서버LAN_IP>:9000`
- **외부 인터넷 보안 터널 (LTE/외부망 원클릭)**:
  ```bash
  ./start_tunnel.sh
  # 생성된 https://xxxx.trycloudflare.com 주소로 외부 어디서나 접속 가능
  # 터널 종료: ./stop_tunnel.sh
  ```
- 기본 입장 코드: **`stock`** (`HttpOnly` 서명 세션 쿠키 인증 적용, 기본 코드 상태에서만 한글 자판 오타 `ㄴ새차` 자동 변환 지원, `⚙️ 설정` 화면 또는 `.env`에서 변경 가능)

---

### 모드 2: Docker Compose 컨테이너 실행 (신규 서버/클라우드 권장)

Node.js나 Python 로컬 설치 없이 멀티스테이지 비루트 컨테이너로 백엔드(`8001`) + 프론트엔드(`9000`)를 일괄 구동합니다.

```bash
cp .env.example .env
cp config/upbit_config.example.json config/upbit_config.json
docker compose up -d --build

# 상태 및 헬스체크 확인
docker compose ps
docker compose logs -f

# 컨테이너 안전 종료
docker compose down
```

---

### 모드 3: 콘솔 포그라운드 실행 (개발 / 디버깅 / AI Agent 실시간 점검용)

실시간 로그 출력이나 디버깅이 필요한 경우 별도의 터미널 2개에서 각각 실행합니다.

#### 터미널 1 (Backend - Port 8001):
```bash
node backend/node_server.mjs
```
*출력 예시:*
```text
[NodeServer] Server running on http://127.0.0.1:8001 (SQLite WAL session ready)
```

#### 터미널 2 (Frontend - Port 9000):
```bash
# 프로덕션 정적 서버(권장)
node frontend/server.mjs

# 또는 Vite 개발 핫리로드 서버
cd frontend && npm run dev
```

---

## 5. 서비스 중지 방법 (How to Stop)

#### Linux / macOS:
```bash
./stop_services.sh
# 외부 터널까지 함께 종료 시:
./stop_services.sh --with-tunnel
```

#### Windows:
```cmd
.\stop_services.bat
```
- PID 파일(`logs/*.pid`), 포트(`8001` / `9000`), 및 본 프로젝트 작업 경로(`/proc/<pid>/cwd`)를 점검하여 잔존 Node/Python 좀비 프로세스까지 안전하게 종료합니다.

### CLI 수동 중지 (PowerShell)
```powershell
Get-NetTCPConnection -LocalPort 8001,9000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 6. 윈도우 부팅 시 자동 시작 등록 / 해제 (선택)

- **시작프로그램 자동 등록**: `scripts\install_startup.bat` 실행
  - 윈도우 시작프로그램 폴더(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`)에 바로가기가 생성되어 PC 재부팅 시 `start_services.bat`이 백그라운드로 자동 실행됩니다.
- **자동 시작 해제**: `scripts\uninstall_startup.bat` 실행

---

## 7. 서비스 정상 동작 확인 및 자동화 QA 검증 (Health Check for AI Agents)

AI Agent가 서비스 구동 후 정상 여부를 검증할 때 사용하는 엔드포인트 및 테스트 명령입니다:

```bash
# 1. 백엔드 헬스체크 & 버전 확인 (인증 불필요, HTTP 200)
curl -s http://127.0.0.1:8001/api/health
curl -s http://127.0.0.1:8001/api/version

# 2. 세션 쿠키 발급 (기본 입장 코드: stock)
curl -s -c /tmp/act_cookie.txt -X POST -H "Content-Type: application/json" \
  -d '{"code":"stock"}' http://127.0.0.1:8001/api/auth/verify

# 3. 10대 봇 · WebSocket 허브 · 5중 가드레일 상태 조회 (HTTP 200)
curl -s -b /tmp/act_cookie.txt http://127.0.0.1:8001/api/bots
curl -s -b /tmp/act_cookie.txt http://127.0.0.1:8001/api/upbit/status
curl -s -b /tmp/act_cookie.txt http://127.0.0.1:8001/api/guardrail/status

# 4. 프론트엔드 프로덕션 정적 서버 응답 확인 (HTTP 200)
curl -s -I http://127.0.0.1:9000

# 5. 5중 가드레일 스트레스 테스트 및 전수 자동화 검증 스위트
npm run test:guardrail
npm run test:all
```

---

## 8. 문제 해결 가이드 (Troubleshooting)

### Q1. `TypeError: Cannot find module 'node:sqlite'` 오류 발생
- **원인**: 시스템에 설치된 Node.js 버전이 `v22.5.0` 미만(예: Node 18, 20)입니다.
- **해결**: [Node.js 공식 홈페이지](https://nodejs.org/)에서 **Node.js 22 LTS 이상** 버전을 다운로드하여 설치하고 터미널을 다시 열어주세요.

### Q2. 포트 충돌 오류 (Port 8001 or 9000 already in use)
- **원인**: 이전에 실행된 백엔드 또는 Vite 프로세스가 여전히 백그라운드에서 동작 중입니다.
- **해결**: `stop_services.bat`을 실행하거나 PowerShell에서 포트를 점유한 프로세스를 강제 종료합니다.

### Q3. 프론트엔드 실행 시 `vite not found` 오류
- **원인**: `frontend/node_modules`가 설치되지 않았습니다.
- **해결**: `cd frontend && npm install` 실행 후 다시 시작하세요.

### Q4. AI 마켓 브리핑 요청 시 `NO_API_KEY` 오류
- **원인**: Gemini API 키가 아직 설정되지 않았습니다.
- **해결**: 웹 브라우저(`http://localhost:9000`)의 상단 AI 분석 카드에서 `[⚙️ API 키 등록]` 버튼을 클릭하고 Gemini API 키를 입력하거나, `config/upbit_config.json` 파일의 `gemini_api_key` 항목에 입력하세요.

---

## 9. 파이썬 멀티프로세싱 오케스트레이터 및 듀얼 LLM 장세 필터 실행 가이드

독립된 Python 멀티프로세싱 아키텍처 기반으로 10대 전략 봇(`bot_01`~`bot_10`, `agentBot/bot_10_jack_kellogg.py` 포함), Python 전용 시세 캐시 허브(`market_hub.py`) 및 듀얼 LLM 워커(`llm_filter_worker.py`)를 실행할 때 사용합니다.
> **단일 실전 실행권(Single Live Executor) & 중복 실행 원천 차단**:
> - 기본값 **`LIVE_EXECUTOR_OWNER=node`** 환경에서는 Node.js 백엔드(`backend/node_server.mjs`)만 실전 주문(`POST /v1/orders`)을 실행할 수 있습니다.
> - Python 오케스트레이터(`main_orchestrator.py` / `bots.py`)는 Node 백엔드(Port `8001`)가 가동 중이거나 `LIVE_EXECUTOR_OWNER != python`인 경우 실전 주문을 즉시 하드 차단(Yield)하며, Python 단독 실전 실행 시에도 SQLite `live_executor_lease` 리스 락과 `live_order_intents` 2단계 커밋 가드레일이 적용됩니다.

### 파일 구성
- **`init_db.py`**: SQLite(`data/auto_coin_trade.db`, WAL 모드) 전체 원장(가드레일 `live_executor_lease`·`live_order_intents`·`live_guardrail_events` 및 백테스트/로테이션/듀얼 AI 테이블 포함) 자동 초기화 및 마이그레이션
- **`market_hub.py`**: **[Python 독립 실행 전용]** 중앙 REST 시세 캐시 및 업비트 API `120ms` Rate Limit 방어 모듈 *(Node.js 메인 백엔드의 WebSocket 스트림 허브 `backend/common/upbit_ws_hub.mjs`와는 별개이며 충돌하지 않음)*
- **`llm_filter_worker.py`**: 로컬 Ollama(`qwen3-news`, `120s` 타임아웃) 1순위 + Gemini Dual AI(30분 Flash / 1시간 Pro) 시장/뉴스 분석, `bot_01`~`bot_10` 개별 진입 제어(`ALLOW`/`BLOCK`), BTC 20MA 기계적 안전 모드 폴백 워커
- **`bots.py` & `agentBot/bot_10_jack_kellogg.py`**: 공통 매수 게이트웨이(`can_enter_position`), `Decimal(ROUND_DOWN)` 8자리 내림 주문, 5중 실전 가드레일(리스 락·2PC·`identifier` 정산), Graceful Drain 청산 대기 및 잔여 원화 자동 이관, `bot_10` Jack Kellogg VWAP·선형 회귀 채널 전략
- **`main_orchestrator.py`**: 봇/LLM 워커 상시 헬스체크, 크래시 자동 재기동, `LIVE_EXECUTOR_OWNER` 안내 및 `logs/.orchestrator.pid` 기반 중복 실행 차단
- **`run_orchestrator.bat` / `run_orchestrator.sh`**: Windows / Linux 원클릭 실행 스크립트 (`LIVE_EXECUTOR_OWNER=node` 기본 적용 및 충돌 경고 출력)

### 실행 방법

#### Linux / macOS:
```bash
chmod +x run_orchestrator.sh
./run_orchestrator.sh
```

#### Windows:
```powershell
# 1. Node 루트/프론트엔드 및 Python 패키지 설치
.\setup.bat

# 2. .env 설정 복사 및 편집 (.env.example 참조, 기본: DRY_RUN=True 모의투자)
copy .env.example .env

# 3. 오케스트레이터 실행 (원클릭 또는 CLI)
.\run_orchestrator.bat
# 또는
python main_orchestrator.py
```

---

## 10. PostgreSQL 16 마이그레이션 및 외부 접속 가이드

SQLite 데이터를 PostgreSQL 16 데이터베이스로 이전하고 외부에서 접속할 때 사용합니다:

### 1단계: PostgreSQL 설정 및 계정 생성
```bash
sudo ./scripts/setup_postgresql.sh
```
- `listen_addresses = '*'` 및 외부 IP scram-sha-256 비밀번호 인증 활성화
- 데이터베이스 `coin_trader`, 사용자 `coin_trader` (비밀번호: `coin123$%^`) 자동 구성

### 2단계: SQLite ➡️ PostgreSQL 마이그레이션 실행
```bash
python3 scripts/migrate_sqlite_to_pg.py
```
- SQLite(`data/auto_coin_trade.db`)의 `system_settings`, `bots`, `trades`, `bot_positions`, `ai_market_briefings` 테이블 및 데이터를 PostgreSQL로 이관

### 3단계: .env 위치(LOCATION) 모드 설정 및 외부 접속 정보
`.env` 파일의 `LOCATION` 값을 변경하여 로컬 접속과 외부 접속을 원클릭으로 전환할 수 있습니다:
- **`LOCATION=local`**: 로컬 내부 IP (`127.0.0.1:5432`)로 접속 (기본값)
- **`LOCATION=outer`**: 외부 접속 공인 IP (`<공인IP>:5432`)로 접속

```ini
# .env 설정 예시
LOCATION=local  # 또는 outer

# [Local] 로컬 접속
LOCAL_PG_HOST=127.0.0.1
LOCAL_PG_PORT=5432
LOCAL_PG_DATABASE=coin_trader
LOCAL_PG_USER=coin_trader
LOCAL_PG_PASSWORD=your_pg_password_here

# [Outer] 외부 접속
OUTER_PG_HOST=your_remote_server_ip
OUTER_PG_PORT=5432
OUTER_PG_DATABASE=coin_trader
OUTER_PG_USER=coin_trader
OUTER_PG_PASSWORD=your_pg_password_here
```

- **로컬 접속**: `127.0.0.1:5432` / DB: `coin_trader`
- **동일 Wi-Fi LAN 접속**: `<서버LAN_IP>:5432`
- **외부 인터넷 공인 IP 접속**: `<외부공인IP>:5432` (공유기 5432 포트포워딩 필요)


