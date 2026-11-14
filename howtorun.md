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
│   │   ├── algo_lab_service.mjs     # 10대 알고리즘 상시 모의투자 아레나 · 주간 전략군 TOP 1 로테이션 엔진
│   │   ├── pg_sync.mjs              # PostgreSQL 16 양방향 실시간 동기화 및 자동 마이그레이션
│   │   └── sqlite_db.mjs            # SQLite 3 (WAL 모드) 래퍼
│   └── node_server.mjs              # Node.js >= 22.5.0 내장 http/sqlite 통합 API · SSE · 실전 봇 엔진 (Port 8001)
├── frontend/                        # React 18 + Vite 5 웹 대시보드 (Port 9000)
├── install/                         # Windows / Linux 배포형 원클릭 실행 패키지
├── bots.py                          # Python 독립 봇 실행기 (Node 미실행 시 가동, Graceful Drain 지원)
├── llm_filter_worker.py             # Gemini Dual AI (30분 Flash / 1시간 Pro) 10대 봇 개별 제어 워커
├── market_hub.py                    # 중앙 시세 캐시 및 업비트 API 120ms Rate Limit 방어
├── main_orchestrator.py             # Python 멀티프로세싱 오케스트레이터 (Node 실행 시 자동 Yield)
├── init_db.py                       # SQLite 초기화 및 자동 스키마 마이그레이션
├── run_orchestrator.sh / .bat       # Python 오케스트레이터 원클릭 실행 스크립트
├── package.json                     # 루트 Node 의존성 (pg, web-push 등) 및 버전 메타데이터
├── requirements.txt                 # Python 의존성 패키지 목록
├── config/
│   ├── upbit_config.example.json    # 업비트 API Key 설정 템플릿 파일 (Git 추적용)
│   └── upbit_config.json            # 실제 업비트 API Key 설정 파일 (.gitignore에 의해 Git Push 제외)
├── data/
│   └── auto_coin_trade.db           # SQLite 데이터베이스 파일 (최초 실행 시 자동 생성 및 초기화)
├── frontend/                        # React 로컬 웹 프론트엔드 (Dark 테마, 2:8 레이아웃)
│   ├── src/
│   │   ├── App.jsx                  # 입장코드, 거래현황, 통계, 설정 메인 UI 컴포넌트
│   │   ├── main.jsx
│   │   └── styles.css               # 다크 모드 및 손익 색상(이익:빨강, 손해:파랑, 그외:검정) 스타일
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── start.sh / start.bat             # 원클릭 실행 스크립트 (Backend 8001 + Frontend 9000)
└── stop.sh / stop.bat               # 원클릭 종료 스크립트 (PID 및 프로세스 안전 종료)
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
Node.js 버전 확인, 디렉토리 생성, 설정 템플릿 복사, 프론트엔드 패키지 설치가 자동으로 진행됩니다.

### 방법 2: 수동 설치
1. **Node.js 22 LTS (v22.5.0 이상)** 확인:
   백엔드가 내장 SQLite 모듈(`node:sqlite`)을 사용하므로 Node.js v22.5.0 이상이 필요합니다.
   ```powershell
   node -v
   ```
2. **프론트엔드 패키지 설치**:
   ```powershell
   cd frontend
   npm install
   cd ..
   ```
   *(루트 `package.json`의 `pg`, `web-push` 등과 `frontend` 패키지를 함께 설치하며, 백엔드 런타임은 **Node.js v22.5.0 이상**의 내장 `node:sqlite`가 필요합니다.)*

---

## 3. 업비트 Open API 및 Gemini Key 설정 방법 (`config/upbit_config.json`)

1. `config/upbit_config.json` 파일을 엽니다. (파일이 없다면 `config/upbit_config.example.json`을 복사하여 생성합니다.)
2. 본인의 업비트 Open API `access_key`와 `secret_key`, Google `gemini_api_key`를 입력합니다.

```json
{
  "access_key": "여기에_업비트_ACCESS_KEY_입력",
  "secret_key": "여기에_업비트_SECRET_KEY_입력",
  "trade_mode": "paper",
  "request_timeout_sec": 5.0,
  "delay_threshold_ms": 800,
  "gemini_api_key": "여기에_GOOGLE_GEMINI_API_KEY_입력"
}
```

- **`trade_mode` 옵션 안내**:
  - `"paper"`: 로컬 시뮬레이션(모의) 안전 모드로 동작합니다. 실제 업비트 계좌의 돈을 쓰지 않고 실시간 시세 기반으로 가상 매수/매도 및 DB 검증을 안전하게 수행합니다.
  - `"live"`: 입력된 업비트 Open API Key를 사용하여 **실제 업비트 시장가 매수/매도 주문**을 실행합니다.
- **`gemini_api_key`**:
  - Google Gemini Dual AI(Flash 30분 / Pro 1시간 SSE 스트리밍 및 10대 봇 개별 진입 제어)에 사용됩니다. 웹 UI 상단의 `[⚙️ API 키 등록]` 버튼을 통해서도 바로 등록/저장할 수 있습니다.
- **Git Push 제외 보안 규칙**:
  - `.gitignore`에 `config/upbit_config.json`이 등록되어 있어 커밋/푸시 시 개인 API Key가 외부로 유출되지 않습니다.

---

## 4. 프로그램 실행 방법 (How to Run)

### 방법 A: 무음 백그라운드 서비스 실행 (권장)
- **Linux / macOS**:
  ```bash
  ./start_services.sh
  # 또는 ./start.sh
  ```
- **Windows**:
  `start_services.bat` (또는 `start.bat`)을 더블클릭하거나 터미널에서 실행합니다.
  ```powershell
  .\start_services.bat
  ```
- 백엔드 서버(`http://127.0.0.1:8001`)와 프론트엔드 개발 서버(`http://localhost:9000`)가 백그라운드에서 실행됩니다.
- 웹 브라우저에서 **`http://localhost:9000`** 접속 (기본 입장 코드: `stock`, 한글 자판 오타 `ㄴ새차` 자동 변환 지원, `⚙️ 설정` 화면 또는 `.env`에서 사용자 지정 코드로 변경 가능).
- **스마트폰/태블릿 동일 Wi-Fi 접속**: `http://<서버LAN_IP>:9000` (예: `http://192.168.x.x:9000`)
- **집 밖/모바일 데이터 외부 인터넷 접속**:
  ```bash
  ./start_tunnel.sh
  # 출력되는 HTTPS 링크로 어디서나 접속 가능 (종료: ./stop_tunnel.sh)
  ```

### 방법 B: 터미널에서 수동으로 각각 실행 (디버깅 / 실시간 로그 확인용)
1. **터미널 1 (Backend 실행)**:
   ```powershell
   node backend/node_server.mjs
   ```
2. **터미널 2 (Frontend 실행)**:
   ```powershell
   cd frontend
   npm run dev
   ```

---

## 5. 프로그램 종료 방법 (How to Stop)

### 방법 A: 원클릭 종료 스크립트 실행 (권장)
- **Linux / macOS**:
  ```bash
  ./stop_services.sh
  # 또는 ./stop.sh
  ```
- **Windows**:
  ```powershell
  .\stop_services.bat
  # 또는 .\stop.bat
  ```
- 포트 `8001`과 `9000`을 점유 중인 프로세스를 안전하게 종료합니다.

## 6. 웹 화면 사용 가이드

### 6.1 입장 코드 입력 화면
- 웹 브라우저에서 `http://localhost:9000` 접속 시 입장 코드 입력 화면이 나타납니다.
- 기본 입장 코드: **`stock`** (한글 자판 오타 `ㄴ새차` 자동 변환 및 대소문자 무관)
  - `⚙️ 설정` 화면 또는 `.env` 파일(`GATE_CODE=...`)에서 원하는 사용자 지정 코드로 언제든 변경할 수 있습니다.
- 코드가 일치하면 좌측 메뉴(`20%`)와 우측 상세 화면(`80%`)으로 구성된 다크 테마 메인 화면으로 진입합니다.

### 6.2 좌측 상단 업비트 통신 상태 표시기
- **정상통신 (`초록색`)**: 업비트 Open API 서버 응답이 정상 범위(`800ms` 미만)일 때 표시됩니다.
- **통신지연 (`노란색`)**: 응답 속도가 지연 임계값(`800ms`)을 초과하거나 Rate Limit 대기 중일 때 표시됩니다.
- **통신불가 (`빨간색`)**: API 서버 오류 또는 네트워크 연결이 끊어졌을 때 표시됩니다.
- **상세 사유 확인**: 해당 영역에 **마우스를 올리면(Hover)** 응답 속도(ms), 현재 모드, 오류 원인 등이 툴팁으로 표시됩니다.

### 6.3 [메뉴 1] ⚡ 실제거래 현황
- **업비트 실계좌 자산 요약**: 원화 잔고, 총 평가금액, 총 평가손익(수익률 %), 보유 코인 목록 실시간 표시.
- **듀얼 Gemini AI 시황 브리핑 & 10대 봇 개별 제어**: Flash(30분) / Pro(1시간) 교차 검증 시장 체제 분석, `bot_01`~`bot_10` 개별 `ALLOW`/`BLOCK` 게이트(청산 매도 루프는 상시 유지), SSE 실시간 타자기 스트리밍.
- **사용자 선택 및 주간 자동 로테이션 실전 봇(1~3개) 제어**:
  - `⚙️ 설정`에서 수동 선택하거나 주간 전략군 TOP 1 자동 로테이션으로 선출된 봇(Jack Kellogg 프라이스 액션 `bot_10` 포함)만 동적으로 노출되며 개별 `▶ 거래시작` / `■ 거래중단` / `테스트` 제어 가능. 교체 시 오픈 포지션이 있는 봇은 **청산 대기(Graceful Drain)** 배지로 안전 관리됩니다.
- **잔고 0원 이하 자동 전체 중지 알림**:
  - 설정된 잔고가 `0`원 이하로 떨어지면 모든 봇이 자동으로 거래 중지되며, 진입 시 **Modal Popup**으로 즉시 안내.
- **1줄(Row) 통합 실전 체결 게시판**:
  - `매수`, `매도`, `매수일`, `매도일`, `차익`이 한 줄로 표시되며, 미체결 보유 포지션은 매도 영역 공란 유지 후 청산 시 동일 행에 업데이트.

### 6.4 [메뉴 2] 🏆 가상거래 경쟁 (Always-On Arena)
- **10대 알고리즘 봇(`bot_01` ~ `bot_10`) 상시 가상 시뮬레이션**:
  - LLM 필터를 우회하여 순수 알고리즘 경쟁을 펼치는 무중단 가상 아레나 (초기 자본 100만 원).
- **TOP 3 랭킹 포디움**:
  - 🥇 1위, 🥈 2위, 🥉 3위 봇의 실시간 수익률, 총 평가자산, 승률 하이라이트.
- **실시간 리더보드 & 체결 이력**:
  - 10대 봇의 수익률, 승률, MDD 리더보드 및 개별 봇 가상 체결 로그 필터링.
- **제어 기능**: `[🔄 실시간 검증 실행]`(즉시 1사이클 실행), `[초기화 (100만원 리셋)]`(10대 봇 전적 및 자본 초기화).

### 6.5 [메뉴 3] 📈 통계
- **실제거래 ↔ 가상거래 통계 탭 전환**: 실계좌와 모의투자 통계를 분리하여 조회.
- **일간 / 주간 / 월간 탭**: `2026.10.01`을 시작 기준으로 하여 각 기간별 누적 손익 곡선(선 그래프) 시각화.
- **다빈도 거래 코인 순위 게시판**:
  - 가장 많이 거래된 코인 순으로 정렬되어 누적 손익 색상 구분 표시:
    - **이익 (`> 0`)**: **빨간색** (`#ef4444`)
    - **손해 (`< 0`)**: **파란색** (`#3b82f6`)
    - **그 외 (`= 0`)**: **회색/검은색 뱃지**

### 6.6 [메뉴 4] 📰 뉴스 (실시간 뉴스 피드 & AI 종합 분석)
- **Google News & TokenPost RSS 실시간 수집**:
  - 30분 주기 백그라운드 자동 수집 + `[🔄 최신 뉴스 즉시 수집]` 버튼 제공.
  - 호재/악재 감성 분석(`▲ 호재`, `▼ 악재`, `● 중립`) 및 자동 태그 추출.
- **50건 목록 뷰 & 48px 고정 행 높이**:
  - 행 높이 48px 및 1줄 말줄임표 처리, 마우스 호버 시 툴팁 제공.
- **Gemini AI 종합 분석**: 수집된 최신 뉴스를 종합하여 시장 영향 분석 SSE 스트리밍 제공.

### 6.7 [메뉴 5] ⚙️ 설정 (시스템·보안 · 주간 자동 로테이션 · 동적 투자금 통합 관리)
- **실전 담당 봇 선택 · 주간 전략군 TOP 1 자동 로테이션 및 동적 투자금 배분 패널**:
  - 10대 봇(`bot_01`~`bot_10`, Jack Kellogg VWAP 포함) 중 실전 투입 봇 1~3개를 직접 선택하거나 **주간 전략군 TOP 1 자동 로테이션(매주 월요일 00:05 KST / 즉시 로테이션)** 을 활성화할 수 있습니다.
  - 교체 대상 봇이 오픈 포지션을 보유 중이면 **청산 대기(Graceful Drain)** 상태로 신규 매수만 차단하고, 전량 익절/손절 후 잔여 원화를 신규 TOP 1 봇으로 자동 이관합니다.
  - 비율 합계 100% 검증 및 소수점 버림(`Math.floor`) 내림 계산 적용.
- **거래 모드 설정**: 가상거래(모의투자) ↔ 실거래 원클릭 전환.
- **보안 입장 코드(Gate Code) 관리**:
  - 기본 입장 코드: **`stock`** (한글 자판 오타 `ㄴ새차` 자동 변환 지원)
  - 웹 화면 또는 `.env`(`GATE_CODE=...`)에서 사용자 지정 코드로 언제든 변경 및 SQLite/PostgreSQL 양방향 동기화.
- **API 키 관리**: 업비트 Open API 및 Google Gemini API 키 마스킹 저장.
- **데이터 마이그레이션 (JSON)**: SQLite 전체 DB(실거래, 가상 아레나 전적, 듀얼 AI 필터 상태 포함 `schema_version: 1.2`) 백업 내보내기(Export) 및 복원(Import).

---

## 7. 확장 전략 봇 및 오케스트레이터 가이드 (`agentBot` & `bots.py`)

파이썬 전략 엔진 및 Jack Kellogg 프라이스 액션 모듈은 루트 및 `agentBot/`에서 관리됩니다:
- **Bot 1~9 핵심 전략**: `bots.py` 및 `backend/common/algo_lab_service.mjs`
- **Bot 10 (Jack Kellogg VWAP · 선형 회귀 채널)**: `agentBot/bot_10_jack_kellogg.py` & `backend/common/algo_lab_service.mjs`
- **오케스트레이터**: `main_orchestrator.py` (Node 백엔드Port `8001` 동시 가동 시 중복 주문 방지를 위해 자동 대기)

> **주의 (봇 간 상호 간섭 및 주문 사고 방지 필수 규칙)**:
> 1. 매도 시 절대 `get_balance()`로 코인 전량을 조회하여 매도하지 마세요. 반드시 `bot_positions` 테이블에 해당 `bot_id` 및 `order_uuid`로 기록된 `volume`(소수점 8자리 버림 `floorTo8DecimalsStr` / `round_down_volume_8`)만 분할 매도해야 합니다.
> 2. 매수 시 반드시 `virtual_krw` 잔고 체크 및 수수료 완충(`Math.floor((예산 * 비중) / 1.0005)`, 업비트 최소 주문 5,000원 보정)과 미체결 타임아웃 취소/체결 확인(`done`, `executed_volume`, `paid_fee`)을 거쳐야 합니다.
> 3. 캔들/시세 조회 시 `market_hub.py` 및 `fetchUpbitPublicWithBackoff` 캐시(API `120ms` 간격 및 `429/503` 1s→2s→4s 지수 백오프)를 유지하세요.

