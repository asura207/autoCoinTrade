# Upbit AutoCoinTrade (업비트 다중 전략 자동매매 & 실시간 AI 퀀트 시스템)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> 업비트(Upbit) Open API를 기반으로 3대 퀀트 전략 봇을 동시에 운용하고, 10대 알고리즘 가상 경쟁(Always-On Arena)과 실시간 뉴스 인텔리전스, 그리고 Google Gemini AI 스트리밍 시황 분석(Flash 30분 / Pro 1시간 교차 검증)을 결합한 통합 가상자산 퀀트 트레이딩 플랫폼입니다.

---

## 🚀 빠른 시작 (Quick Start for Developers & AI Agents)

새로운 환경이나 다른 PC에서 프로젝트를 처음 실행할 때는 **[SETUP_GUIDE.md](SETUP_GUIDE.md)** 를 참조하세요.

### 1단계: 초기 환경 설정 (원클릭)
- **Linux / macOS**:
  ```bash
  ./setup.sh
  ```
- **Windows**:
  ```cmd
  .\setup.bat
  ```
*(Node.js >= 22.5.0 및 Python 가상환경 검증, logs/data 생성, config 파일 생성, frontend npm install을 자동으로 수행합니다.)*

### 2단계: 서비스 시작
- **Linux / macOS**:
  ```bash
  ./start_services.sh
  # 또는 ./start.sh
  ```
- **Windows**:
  ```cmd
  .\start_services.bat
  ```
- **웹 대시보드 로컬 접속**: [http://localhost:9000](http://localhost:9000)
- **모바일/사내 LAN 접속**: `http://<서버내부IP>:9000` (예: `http://192.168.x.x:9000`)
- **외부 인터넷 원클릭 HTTPS 터널 (LTE/외부망)**:
  ```bash
  ./start_tunnel.sh
  ```
  *(안전한 Cloudflare HTTPS 공개 주소가 터미널에 자동 발급됩니다.)*
- **기본 입장 코드**: **`stock`** *(설정 메뉴에서 언제든 원하는 코드로 변경 가능)*
- **백엔드 API**: `http://localhost:8001`

### 3단계: 서비스 중지
- **Linux / macOS**:
  ```bash
  ./stop_services.sh
  # 또는 ./stop.sh
  # 터널 종료: ./stop_tunnel.sh
  ```
- **Windows**:
  ```cmd
  .\stop_services.bat
  ```

---

## 📌 주요 5대 핵심 메뉴 및 기능

### 1. `📊 거래현황` (실시간 자산 & 봇 매매 제어)
- **업비트 실계좌 자산 요약 카드**:
  - 실제 보유 원화, 주문 가능 금액, 총 매수금액, 총 평가금액, 총 평가손익(원화 및 수익률 %), 보유 코인 목록(수량, 매수평균가, 현재가, 평가손익)을 실시간 갱신.
- **실시간 거래 실행 모드 전환 배너**:
  - `🧪 가상거래(모의투자)` ↔ `⚡ 실거래(업비트 계좌)` 모드를 원클릭으로 전환.
  - 가상거래 모드 시 **`[🔄 가상거래 이력 초기화]`** 버튼을 통해 언제든 모의투자 기록을 0원부터 클린 리셋 가능.
- **Google Gemini 3.5 Flash 실시간 AI 마켓 브리핑**:
  - 비트코인(BTC) 시세, 일봉 20MA, 4시간봉 60MA 이격도를 종합하여 시장 체제(`🔴 신규매수차단 (현금보유)` vs `🟢 정상거래 허용`) 및 봇 행동을 명쾌하게 해설.
  - 접이식(Collapsible) 아코디언 UI 적용 및 **Server-Sent Events(SSE) 기반 18ms 타자기 애니메이션 스트리밍**.
- **3대 퀀트 매매 봇 제어 카드**:
  - **[Bot 1] 돌파봇-알파 (변동성 돌파)**: 일봉 변동폭 K=0.4 돌파 + 20일 이동평균선 필터 결합 장중 단타 전략.
  - **[Bot 2] 모멘텀봇-베타 (듀얼 모멘텀)**: 업비트 거래대금 상위 코인 중 상대 모멘텀 상위 2종목 및 7일 절대 모멘텀(> +1.5%) 필터 스윙 전략.
  - **[Bot 3] 볼린저봇-감마 (볼린저 밴드 역추세)**: 15분봉 볼린저 밴드 하단 터치(-2σ) 및 RSI <= 30 과매도 반등 단기 역추세 전략 (+3.5% 익절 / -2.0% 손절).
  - 봇별 `거래 시작`, `거래 중지`, `매수 테스트`, `매도 테스트` 제어 버튼 제공.
- **1줄(Row) 통합 체결 게시판**:
  - 매수 정보와 매도 정보, 실현손익을 단일 행에서 직관적으로 추적 (미체결 보유 포지션은 매도 영역 공란 유지).

---

### 2. `📈 통계` (실현 손익 분석 & 랭킹)
- **기간별 탭**: `일별 통계` / `주별 통계` / `월별 통계` 지원 (새로고침 시 선택 탭 유지).
- **통계 시작 기준일**: `2026.10.01`부터 누적 집계.
- **누적 수익률 선 그래프**: 기간별 실현 손익 추이 시각화.
- **명확한 손익 색상 표준**:
  - **이익 (> 0)**: 빨간색 (`#ef4444`)
  - **손해 (< 0)**: 파란색 (`#3b82f6`)
  - **0원 (= 0)**: 회색/검정 뱃지
- **코인별 수익 기여도 순위 테이블**: 누적 실현 손익 및 거래 횟수, 승률 순위 표기.

---

### 3. `🧪 검증소` (알고리즘 검증소 / 6대 모델 실시간 가상 경쟁)
- **6대 퀀트 알고리즘 모델 상시 가상 시뮬레이션 (각 초기 자본 1,000,000 KRW)**:
  1. **변동성 돌파 (Larry Williams)**: 변동폭 K=0.4 돌파 + 20MA 상회 매수
  2. **듀얼 모멘텀 (Dual Momentum)**: 상대 모멘텀 상위 + 절대 모멘텀 > +1.5% 스윙 매수
  3. **볼린저 밴드 역추세 (BB Reversal)**: 15분봉 볼린저 밴드 하단(-2σ) & RSI <= 30 극단 과매도 반등 매수
  4. **MACD + RSI 골든크로스 (MACD Trend)**: MACD 시그널 상향 돌파 & RSI 45~65 추세 확장 매수
  5. **RSI 과매도 스캘핑 (RSI Scalper)**: RSI <= 25 패닉셀 진입, RSI 50 또는 +1.5% 도달 시 즉시 청산
  6. **슈퍼트렌드 & ATR 동적 스탑 (SuperTrend ATR)**: 14일 ATR 1.8배 트레일링 스탑 추세추종
- **TOP 3 랭킹 포디움 (Podium)**:
  - 🥇 1위(Gold), 🥈 2위(Silver), 🥉 3위(Bronze) 모델을 상단에 3단 카드 형태로 하이라이트 표시 (실시간 수익률, 총 평가자산, 승률, 최근 시그널).
- **실시간 랭킹 보드 & 가상 매매 체결 일지**:
  - 전체 6개 모델의 실시간 수익률, 평가자산, 가용현금, 전적 및 승률 표시.
  - 행 클릭 시 해당 모델의 체결 내역만 즉시 필터링.
- **제어 버튼**:
  - **[🔄 실시간 검증 실행]**: 10초 대기 없이 즉시 시뮬레이션 1사이클 강제 실행.
  - **[초기화 (100만원 리셋)]**: 6대 모델을 초기 자본 100만 원, 0% 수익률, 0건 체결로 클린 리셋.

---

### 4. `📰 뉴스` (실시간 뉴스 피드 & AI 종합 분석)
- **Google News & TokenPost 실시간 RSS 수집 엔진**:
  - 중복 링크 방어 및 30분 주기 백그라운드 자동 수집 + **[🔄 최신 뉴스 즉시 수집]** 버튼 제공.
  - 호재/악재 감성 분석(`▲ 호재`, `▼ 악재`, `● 중립`) 및 자동 해시태그 태깅(`#비트코인`, `#이더리움`, `#ETF` 등).
- **50건 단위 목록 뷰 & 행(Row) 높이 동일화 (48px)**:
  - 모든 행의 높이를 48px로 고정하고, 긴 제목은 줄바꿈 없이 1줄 말줄임표(`...`)로 처리.
  - 마우스 호버 시 기사 전체 제목과 요약문 툴팁(`title`) 제공, 클릭 시 새 탭에서 원문 링크 오픈.
- **통합 검색 및 필터링**:
  - 날짜 범위(시작일/종료일) 캘린더 검색, 키워드 검색, 인기 태그 원클릭 필터 지원.
- **Gemini AI 뉴스 종합 분석 (SSE 스트리밍)**:
  - 수집된 250+ 건의 뉴스와 시장 흐름을 종합 진단하여 한 글자씩 부드러운 타자기 애니메이션으로 스트리밍 출력.

---

### 5. `⚙️ 설정` (시스템 및 보안 통합 관리)
- **거래 실행 모드 설정**: 가상거래(모의투자) ↔ 업비트 실거래 모드 원클릭 전환.
- **전체 운용 원금 및 봇별 자금 배분 비율**: 소수점 버림(`Math.floor`) 및 자금 락 기능 적용.
- **봇별 별명(Nickname) 및 파라미터 수정**: 손절율, 익절율, 최소 거래대금, 전략별 계수 실시간 반영.
- **🔐 보안 및 입장 코드(Gate Code) 설정**:
  - 기본 입장 코드: **`stock`**
  - 설정 화면에서 현재 적용된 코드를 확인(보기/숨기기)하고, 원하는 새 코드로 언제든 변경 저장 가능.
  - 변경 시 로컬 SQLite 및 원격 PostgreSQL에 실시간 양방향 동기화.
- **API 키 관리**: 업비트 Open API 키 및 Google Gemini API 키 웹 UI 등록 및 마스킹 저장.
- **데이터 마이그레이션 (JSON)**: SQLite 전체 DB 백업 내보내기(Export) 및 무결성 복원(Import).

---

## 🛡️ 가상거래 vs 실거래 원장 분리 및 퀀트 안전 설계

| 구분 | 실거래 (Live Trading) | 가상거래 (Paper Trading) |
|---|---|---|
| **실행 방식** | 업비트 실제 주문 API 호출 | 업비트 실시간 호가 기반 가상 체결 (`paper-bid-*`) |
| **자금 소진** | 실제 업비트 계좌 원화 소진 | **실제 자금 소진 0원 (100% 안전)** |
| **체결 원장 테이블** | `trades` | `paper_trades` |
| **보유 포지션 테이블** | `bot_positions` | `paper_bot_positions` |
| **이력 초기화** | 불가 (실거래 내역 보존) | **[🔄 가상거래 이력 초기화] 지원** |

- **자금 격리 및 트랜잭션 락**: 봇별 할당 자금 범위 내에서만 주문 발행, 타 봇 포지션 침범 금지.
- **전량 매도(`get_balance`) 직접 호출 금지**: 본인 봇의 포지션 수량(`volume`)만 지정하여 분할 매도.
- **BTC 시장 체제 필터 (Regime Filter)**: 비트코인이 20MA(일봉) 및 60MA(4시간봉) 하회 시 신규 매수 전면 차단 (`HOLD_CASH`).
- **잔고 0원 이하 비상 정지**: 잔고 소진 시 모든 봇을 즉시 정지하고 대시보드 경고 모달 팝업 노출.
- **API Rate Limit 방어**: 120ms 최소 호출 간격 유지 및 중앙 시세 캐싱.

---

## 📂 프로젝트 구조

```text
autoCoinTrade/
├── backend/
│   ├── node_server.mjs          # [메인 백엔드] Node.js + PostgreSQL/SQLite + Upbit API + Gemini AI + REST API + SSE
│   └── common/
│       ├── algo_lab_service.mjs # 10대 알고리즘 가상 경쟁(Arena) 시뮬레이션 및 실시간 랭킹 엔진
│       ├── news_service.mjs     # 구글 뉴스 & 토큰포스트 RSS 파싱, 감성 분석, 태그 추출
│       ├── pg_db.mjs            # PostgreSQL 비동기 풀 및 SQL 변환 레이어
│       └── pg_sync.mjs          # PostgreSQL 16 실시간 데이터 동기화 매니저
├── bots.py                      # [Python CLI] 3대 실전 트레이딩 봇 전략 (슈퍼트렌드, 볼린저 스퀴즈, DCA)
├── llm_filter_worker.py         # [Python CLI] 듀얼 AI (Flash 30분 / Pro 1시간) 시장 분석 워커
├── main_orchestrator.py         # [Python CLI] 멀티프로세싱 슈퍼바이저 오케스트레이터
├── init_db.py                   # DB 스키마 및 마켓 체제 필터 테이블 초기화
├── config/
│   ├── upbit_config.json        # 업비트 및 Gemini API 키 설정 파일 (Git 추적 제외)
│   └── upbit_config.example.json# 설정 파일 템플릿
├── data/
│   └── auto_coin_trade.db       # 로컬 SQLite 데이터베이스 (WAL 모드)
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # 프론트엔드 메인 React 컴포넌트 (5대 메뉴, AI 스트리밍, 페이지네이션)
│   │   ├── main.jsx             # React 엔트리포인트
│   │   └── styles.css           # 다크 테마, 2:8 레이아웃, 모바일 반응형, 48px 고정 테이블 스타일
│   ├── index.html
│   ├── package.json
│   └── vite.config.js           # 0.0.0.0 바인딩, allowedHosts, /api 프록시 설정
├── scripts/
│   ├── setup_postgresql.sh      # PostgreSQL 16 계정 및 데이터베이스 자동 설치/설정 스크립트
│   ├── migrate_sqlite_to_pg.py  # SQLite -> PostgreSQL 전체 데이터 마이그레이션 스크립트
│   ├── run_backend.sh           # [Linux] 백엔드 단독 구동 스크립트
│   ├── run_frontend.sh          # [Linux] 프론트엔드 단독 구동 스크립트
│   ├── run_backend.bat          # [Windows] 백엔드 백그라운드 구동 스크립트
│   ├── run_frontend.bat         # [Windows] 프론트엔드 백그라운드 구동 스크립트
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
├── README.md                    # 프로젝트 종합 안내서 (본 파일)
├── SETUP_GUIDE.md               # [환경 세팅] 다른 PC 및 AI Agent 전용 실행 가이드
├── howtorun.md                  # 상세 사용자 가이드
└── prompt.md                    # 시스템 복원 및 타 Agent 구현용 마스터 프롬프트
```

---

## ⚙️ 설정 파일 (`config/upbit_config.json`)

```json
{
  "access_key": "업비트_OPEN_API_ACCESS_KEY",
  "secret_key": "업비트_OPEN_API_SECRET_KEY",
  "trade_mode": "paper",
  "request_timeout_sec": 5.0,
  "delay_threshold_ms": 800,
  "gemini_api_key": "GOOGLE_GEMINI_API_KEY"
}
```

- **`trade_mode`**: `"paper"` (가상거래 모의투자 모드) 또는 `"live"` (업비트 실거래 모드)
- **`gemini_api_key`**: Google AI Studio에서 발급받은 Gemini API 키 (웹 화면에서도 등록/수정 가능)

---

## 📱 모바일 최적화 및 외부 접속 환경

- **반응형 웹 UI (Mobile Responsive)**:
  - 데스크톱: 좌측 20% 메뉴 + 우측 80% 상세 콘텐츠 (2:8 레이아웃)
  - 스마트폰 / 태블릿 (너비 <= 900px): 상단 스티키(Sticky) 네비게이션 헤더로 자동 전환, 1열 전체 너비 레이아웃 적용
  - 모든 테이블에 가로 스크롤(`overflow-x: auto`)을 적용하여 좁은 화면에서도 데이터 컬럼 손상 없음
- **보안 입장 게이트**:
  - 개인 전용 입장 코드: **`stock`** (한글 자판 오타 `ㄴ새차` 자동 변환 및 대소문자 무관)
  - `sessionStorage`를 통해 새로고침 시에도 로그인 세션 자동 유지
- **Cloudflare HTTPS 원클릭 터널**:
  - 공유기 포트포워딩이나 방화벽 설정 없이 `./start_tunnel.sh` 실행만으로 외부 스마트폰 LTE 환경에서 접속 가능한 임의의 `https://*.trycloudflare.com` 도메인 자동 발급

---

## 🛠️ 기술 스택 (Tech Stack)

- **Frontend**: React 18, Vite 5, CSS3 Custom Properties (Dark Theme), Responsive Mobile Layout
- **Backend**: Node.js >= 22.5.0 (`node:http`, `node:sqlite` DatabaseSync WAL, `node:crypto`)
- **Dual Database**: SQLite 3 (WAL 모드) + PostgreSQL 16 (`coin_trader` 양방향 실시간 동기화)
- **AI Engine**: Google Gemini API (`gemini-3.5-flash`, `gemini-3.5-flash-lite` SSE 스트리밍)
- **Exchange API**: Upbit Open API v1.0 (JWT SHA-512 비대칭 서명 인증, Rate Limit 방어)
- **Network Tunnel**: Cloudflare Quick Tunnel (`cloudflared --no-autoupdate`)
- **Deployment**: Linux Shell Scripts & Windows Batch / VBScript 무음 백그라운드 자동화
