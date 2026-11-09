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

> **백엔드 npm install이 필요 없는 이유**:
> `backend/node_server.mjs`는 순수 Node.js 표준 내장 라이브러리(`node:http`, `node:fs`, `node:path`, `node:crypto`, `node:url`, `node:sqlite`)만을 사용하여 구현되어 있어, 백엔드에는 별도의 외부 npm 패키지 의존성이 전혀 없습니다 (Zero Dependency).

---

## 3. 설정 파일 안내 (`config/upbit_config.json`)

`.gitignore`에 등록되어 있어 Git 추적에서 제외되므로, 신규 PC에서는 `config/upbit_config.example.json`을 복사하여 생성합니다.

```json
{
  "access_key": "YOUR_UPBIT_ACCESS_KEY",
  "secret_key": "YOUR_UPBIT_SECRET_KEY",
  "trade_mode": "paper",
  "request_timeout_sec": 5.0,
  "delay_threshold_ms": 800,
  "gemini_api_key": "YOUR_GEMINI_API_KEY_HERE"
}
```

### 주요 항목 설명
- **`trade_mode`**:
  - `"paper"` (*기본값*): 모의투자 시뮬레이션 안전 모드. 실제 자금을 쓰지 않고 실시간 호가/시세 기반 가상 매매 및 SQLite DB 검증.
  - `"live"`: 실제 업비트 시장가 매수/매도 주문 실행.
- **`access_key` / `secret_key`**:
  - 업비트 Open API 키. 모의투자(`paper`) 상태에서도 시세 조회, 캔들 조회, 잔고 조회가 가능하며, 미입력 시에도 기본 모의 봇 로직은 fallback 모드로 안전하게 작동합니다.
- **`gemini_api_key`**:
  - Google Gemini API Key. 시장 상황 브리핑 및 봇 전략 진단(Gemini 3.5 Flash SSE 스트리밍)에 사용됩니다.
  - 이 파일에 직접 입력해도 되고, **웹 화면(`http://localhost:9000`) 우측 상단의 `[⚙️ API 키 등록]` 팝업**을 통해 브라우저에서 바로 입력/저장할 수도 있습니다.

---

## 4. 서비스 실행 방법 (How to Run)

### 모드 1: 백그라운드 원클릭 실행 (일반 운영용)

#### Linux / macOS:
```bash
./start_services.sh
# 또는 ./start.sh
```

#### Windows:
```cmd
.\start_services.bat
```
- 백엔드(포트 `8001`)와 프론트엔드(포트 `9000`)가 백그라운드 데몬으로 자동 시작됩니다.
- 브라우저에서 **`http://localhost:9000`** 접속
- **외부/모바일 접속 (동일 Wi-Fi LAN)**: `http://<서버LAN_IP>:9000` (예: `http://192.168.x.x:9000`)
- **외부 인터넷 보안 터널 (LTE/외부망 원클릭)**:
  ```bash
  ./start_tunnel.sh
  # 생성된 https://xxxx.trycloudflare.com 주소로 외부 어디서나 접속 가능
  # 터널 종료: ./stop_tunnel.sh
  ```
- 기본 입장 코드: **`stock`**

---

### 모드 2: 콘솔 포그라운드 실행 (개발 / 디버깅 / AI Agent 실시간 점검용)

실시간 로그 출력이나 디버깅이 필요한 경우 별도의 터미널 2개에서 각각 실행합니다.

#### 터미널 1 (Backend - Port 8001):
```bash
node backend/node_server.mjs
```
*출력 예시:*
```text
[NodeServer] Server running on http://localhost:8001 (SQLite WAL session ready, Date: 2026-10-30)
```

#### 터미널 2 (Frontend - Port 9000):
```bash
cd frontend
npm run dev
```
*출력 예시:*
```text
  VITE v5.4.6  ready in 250 ms

  ➜  Local:   http://localhost:9000/
  ➜  Network: http://192.168.x.x:9000/
```

---

## 5. 서비스 중지 방법 (How to Stop)

#### Linux / macOS:
```bash
./stop_services.sh
# 또는 ./stop.sh
```

#### Windows:
```cmd
.\stop_services.bat
```
- 포트 `8001`(백엔드) 및 포트 `9000`(프론트엔드)을 점유한 프로세스를 찾아 안전하게 종료합니다.

### CLI 수동 중지 (PowerShell)
```powershell
Get-NetTCPConnection -LocalPort 8001,9000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 6. 윈도우 부팅 시 자동 시작 등록 / 해제 (선택)

- **시작프로그램 자동 등록**: `install_startup.bat` 실행
  - 윈도우 시작프로그램 폴더(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`)에 바로가기가 생성되어 PC 재부팅 시 백그라운드로 자동 실행됩니다.
- **자동 시작 해제**: `uninstall_startup.bat` 실행

---

## 7. 서비스 정상 동작 확인 (Health Check for AI Agents)

AI Agent가 서비스 구동 후 정상 여부를 검증할 때 사용하는 엔드포인트 목록입니다:

```bash
# 1. 백엔드 상태 및 등록 봇 3개 목록 조회 (HTTP 200)
curl -s http://localhost:8001/api/bots

# 2. 거래 현황 내역 조회 (HTTP 200)
curl -s "http://localhost:8001/api/trades?bot_id=bot_volatility"

# 3. AI 시황 브리핑 최근 기록 확인 (HTTP 200)
curl -s http://localhost:8001/api/ai/briefing

# 4. 프론트엔드 웹 서버 응답 확인 (HTTP 200)
curl -s -I http://localhost:9000
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

## 9. 파이썬 멀티프로세싱 오케스트레이터 및 LLM 장세 필터 실행 가이드

독립된 Python 멀티프로세싱 아키텍처 기반으로 3개 전략 봇(`bot_vb`, `bot_momentum`, `bot_bb`)과 4번째 워커(`bot_llm_filter`)를 실행할 때 사용합니다:

### 파일 구성
- **`init_db.py`**: SQLite(`trading_ledger.db`, WAL 모드) 가상 원장 및 단일 행(`id=1`) `market_regime_filter` 테이블 초기화
- **`llm_filter_worker.py`**: 1~4시간 주기 시장 지표/뉴스 수집, LLM 분석, 룰베이스 폴백 및 DB 갱신 워커
- **`bots.py`**: 공통 매수 게이트웨이(`can_enter_position`), 슬리피지 방어형 주문 래퍼, 3개 봇 전략(슈퍼트렌드 변동성 돌파, BB 스퀴즈 VCP 돌파, 다단계 분할 매수 DCA)
- **`main_orchestrator.py`**: 4개 워커 프로세스 상시 헬스체크, 크래시 시 자동 재기동(Auto-Restart), Graceful Shutdown 관리
- **`run_orchestrator.bat`**: Windows 원클릭 실행 스크립트

### 실행 방법

#### Linux / macOS:
```bash
./run_orchestrator.sh
```

#### Windows:
```powershell
# 1. 패키지 설치
pip install -r requirements.txt

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


