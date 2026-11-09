# Upbit 다중 전략 코인 자동매매 시스템 사용자 가이드 (`howtorun.md`)

본 문서는 `prompt.md` 및 `initRule.md` 요구사항을 기반으로 구현된 **업비트(Upbit) Open API 코인 자동매매 프로그램**의 설치, 설정, 실행 방법, 종료 방법 및 화면별 사용 방법을 안내합니다.

---

## 1. 프로젝트 디렉토리 구조

```text
autoCoindTrade/
├── agentBot/                        # [봇 패키지] 각 봇의 매매 전략이 독립된 소스 파일로 분리된 패키지
│   ├── __init__.py
│   ├── base_bot.py                  # 공통 규칙 (Rate Limit 0.12s, 유동성 필터, count=8/iloc[-8], 가상잔고 락, 분할매도)
│   ├── volatility_breakout_bot.py   # [Bot 1] 필터 결합형 변동성 돌파 (장중 단타 / 1일 보유)
│   ├── dual_momentum_bot.py         # [Bot 2] 상대 모멘텀 + 절대 모멘텀 (듀얼 모멘텀 스윙)
│   ├── bollinger_reversal_bot.py    # [Bot 3] 고변동성 코인 볼린저 밴드 역추세 (분봉 단기 반등 매매)
│   └── bot_manager.py               # 백그라운드 워커 및 봇별 장애 격리 오케스트레이터
├── backend/
│   ├── common/
│   │   ├── database.py              # SQLite 매니저 (세션 단절/자정 날짜 변경 시 자동 재접속, WAL 모드, 트랜잭션 락)
│   │   └── upbit_client.py          # 공용 업비트 Open API 통신 모듈 (통신 상태 진단, 매수/매도/시세 조회)
│   ├── main.py                      # FastAPI 백엔드 서버 엔드포인트
│   └── requirements.txt             # Python 의존성 패키지 목록
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
├── start.bat                        # 원클릭 실행 스크립트 (Backend + Frontend 동시 시작)
└── stop.bat                         # 원클릭 종료 스크립트 (Backend + Frontend 안전 종료)
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
   *(백엔드는 Node.js 내장 표준 라이브러리만 사용하므로 별도의 npm install이 필요 없습니다.)*

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
  - Google Gemini 3.5 Flash 실시간 AI 마켓 브리핑 기능에 사용됩니다. 웹 UI 상단의 `[⚙️ API 키 등록]` 버튼을 통해서도 바로 등록/저장할 수 있습니다.
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
- 웹 브라우저에서 **`http://localhost:9000`** 접속 (기본 입장 코드: `stock`).
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
- 기본 입장 코드: **`stock`**
- 코드가 일치하면 좌측 메뉴(`20%`)와 우측 상세 화면(`80%`)으로 구성된 다크 테마 메인 화면으로 진입합니다.

### 6.2 좌측 상단 업비트 통신 상태 표시기
- **정상통신 (`초록색`)**: 업비트 Open API 서버 응답이 정상 범위(`800ms` 미만)일 때 표시됩니다.
- **통신지연 (`노란색`)**: 응답 속도가 지연 임계값(`800ms`)을 초과하거나 Rate Limit 대기 중일 때 표시됩니다.
- **통신불가 (`빨간색`)**: API 서버 오류 또는 네트워크 연결이 끊어졌을 때 표시됩니다.
- **상세 사유 확인**: 해당 영역에 **마우스를 올리면(Hover)** 응답 속도(ms), 현재 모드, 오류 원인 등이 툴팁으로 표시됩니다.

### 6.3 [메뉴 1] 거래현황
- **봇별 탭 구분**: 상단 탭에서 3가지 봇(설정한 별명으로 표시)을 전환하며 조회할 수 있습니다.
- **수동 거래시작 / 거래중단 제어**:
  - `▶ 거래시작` 버튼을 누르면 해당 봇이 자동매매를 시작하며, 정상 동작 여부를 알리는 **Modal Popup**이 표시됩니다.
  - `■ 거래중단` 버튼을 누르면 해당 봇이 즉시 중지되며, **Modal Popup**으로 결과를 알려줍니다.
- **잔고 0원 이하 자동 전체 중지 알림**:
  - 설정된 잔고가 `0`원 이하로 떨어지면 모든 봇이 자동으로 거래 중지되며, 거래현황 화면 진입 시 **Modal Popup**으로 중지 사실을 즉시 알려줍니다.
- **1줄(Row) 통합 거래 게시판**:
  - `매수`, `매도`, `매수일`, `매도일`, `차익`이 한 줄로 표시됩니다.
  - 아직 매도하지 않은 보유 포지션은 `매도`, `매도일`, `차익` 칸이 **빈칸**으로 표시되며, 매도가 이루어지면 **동일한 줄(Row)에 매도 정보와 차익이 업데이트**됩니다.
  - 우측의 `+ 매수 테스트` 및 `✓ 보유지분 매도 업데이트` 버튼으로 언제든지 미매도 빈칸 Row 생성과 매도 시 동일 Row 업데이트 동작을 즉시 테스트할 수 있습니다.

### 6.4 [메뉴 2] 통계
- **일간 / 주간 / 월간 탭**: `2026.10.01`을 시작 기준으로 하여 각 기간별 누적 차익 이력을 **선 그래프(Line Chart)**로 보여줍니다.
- **다빈도 거래 코인 순위 게시판**:
  - 그래프 하단에 가장 많이 거래된 코인 순으로 정렬되어 표시됩니다.
  - 각 코인의 **주간 누적 손익**, **월간 누적 손익**, **연간 누적 손익**이 색상으로 구분되어 표시됩니다:
    - **이익 (`> 0`)**: **빨간색**
    - **손해 (`< 0`)**: **파란색**
    - **그 외 (`= 0`)**: **검은색**

### 6.5 [메뉴 3] 설정
- **운용 원금 및 봇별 자금 분배 비율 설정**:
  - 전체 원금과 각 봇의 자금 분배 비율(`%`)을 설정합니다.
  - 비율 계산 시 소수점이 발생하면 **무조건 버림(`floor`)** 처리하여 각 봇의 `virtual_krw`에 반영합니다.
- **봇 수정 및 별명(Nickname) 설정**:
  - 각 봇의 별명, 최소 거래대금 필터(`min_volume_krw`), 손절/익절 기준(`%`), 전략별 고유 파라미터(`K값`, `모멘텀 기준`, `볼린저 표준편차`)를 언제든 수정할 수 있습니다.
- **데이터 마이그레이션 및 복원 (JSON)**:
  - `JSON 마이그레이션 파일 내보내기`: 현재 SQLite DB의 모든 데이터를 `.json` 파일로 다운로드합니다.
  - `JSON 파일 읽어서 데이터 복원`: 백업해둔 `.json` 파일을 선택하면 즉시 DB에 복원됩니다.

---

## 7. 봇 매매기법 소스 수정 가이드 (`agentBot` 패키지)

각 봇의 매매 알고리즘을 직접 수정하고 싶을 때는 `agentBot/` 폴더 내의 개별 파이썬 파일만 수정하면 됩니다:
- **Bot 1 (변동성 돌파)**: `agentBot/volatility_breakout_bot.py` 의 `execute_strategy_step()`
- **Bot 2 (듀얼 모멘텀)**: `agentBot/dual_momentum_bot.py` 의 `execute_strategy_step()`
- **Bot 3 (볼린저 역추세)**: `agentBot/bollinger_reversal_bot.py` 의 `execute_strategy_step()`

> **주의 (봇 간 상호 간섭 방지 필수 규칙)**:
> 1. 매도 시 절대 `get_balance()`로 코인 전량을 조회하여 매도하지 마세요. 반드시 `self.sell_position_isolated(position_id)`를 호출하여 `bot_positions` 테이블에 본인 `bot_id`로 기록된 `volume`만 분할 매도해야 합니다.
> 2. 매수 시 반드시 `self.buy_market_with_lock(market, order_krw)`를 호출하여 사전 `virtual_krw` 예산 체크 및 트랜잭션 락을 통과하도록 유지하세요.
> 3. 캔들 조회 시 `self.fetch_indexed_candles(market, unit, count=8)` 및 `self.get_base_reference_candle(df)`(`df.iloc[-8]`) 규칙과 `self.sleep_rate_limit()`(`time.sleep(0.12)`)을 유지하세요.

