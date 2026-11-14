# 📜 autoCoinTrade 프로젝트 버전 변경 이력 (History)

> **버전 관리 정책 (Versioning Rule)**:  
> 별도의 명시적 언급이 없는 한, 본 프로젝트의 버전은 **`0.0.1`부터 시작하여 Git Commit 1건당 1씩 증가하는 `0.0.숫자` (`0.0.X`) 형태를 엄격하게 유지**합니다.  
> 모든 릴리즈 및 수정 사항은 본 문서(`history.md`)와 프로젝트 설정(`package.json`), 그리고 웹 대시보드 UI/API에 동기화되어 표출됩니다.

---

## 📌 버전 요약표 (Version Summary)

| 버전 (Version) | 릴리즈 일시 | 커밋 해시 | 주요 수정 내용 요약 |
| :--- | :--- | :--- | :--- |
| **v0.0.23** | 2026-11-14 | - | 전수 코드 감사 5대 영역 수정: 루트·`/install` 실행/종료 스크립트 동기화 및 Node-Python 이중 실행 차단, Graceful Drain 잔고 이관·DB/PG 자동 마이그레이션·JSON Export/Import v1.2, 업비트 시세 캐시·지수 백오프·8자리 내림 주문 정합성, 프론트엔드 SSE 클린업, 문서·패키지 현행화 |
| **v0.0.22** | 2026-11-14 | `b8bd374` | 주간 3대 전략군(추세·스윙/변동성·돌파/역추세·그리드)별 1위 봇 자동 선출(Auto-Rotation), 동적 자금 배분, 무손실 포지션 청산 대기(Graceful Drain) 및 정산금 자동 귀속 시스템 구축 |
| **v0.0.21** | 2026-11-13 | `688eca6` | 설정 화면 내 봇별 손절/익절 기준 입력 필드 박스 영역 초과(Overflow) 현상 수정 및 반응형 그리드·인풋 너비 최적화 |
| **v0.0.20** | 2026-11-13 | `37623f4` | 10대 알고리즘 매매 로직 정밀 고도화: 3단계 스마트 청산(시간/본절/동적 ATR), 윗꼬리·과열 방어 필터, Jack Kellogg 튜닝, 일일 손실 방어 서킷 브레이커(-4.0%) |
| **v0.0.19** | 2026-11-13 | `cf8bbe7` | 오케스트레이터(10대 봇·시세 허브) 동기화, 이중 주문 방어(Double Execution Guard), DB 경로 통일, pg_sync 예외 방어 및 저장소 URL(asura207) 일괄 갱신 |
| **v0.0.18** | 2026-11-13 | `608a63c` | 잭 켈로그(Jack Kellogg) 프라이스 액션 & VWAP/선형회귀 알고리즘(bot_10) 탑재, 2대 진입(돌파/반등 2분할) 및 가상·실전 매매 엔진 연동 |
| **v0.0.17** | 2026-11-13 | `871e2ec` | 초반 실전 및 가상 거래 내역 SQLite 동기화 복구, /api/trades SQLite 쿼리 호환성 수정, 통계 내역 탭 연동 |
| **v0.0.16** | 2026-11-13 | `3632a14` | 통계 차트 막대 상단 텍스트 및 수익 표기 뱃지 영역 겹침 현상 해소, 레이아웃 및 여백 최적화 |
| **v0.0.15** | 2026-11-13 | `ca74d8a` | 실전 수익 통계 상단 이번달 1일 시점 및 현재 평가자산 표기, 금액 증감 상태 표출, 매달 기록 및 월별 보유 자산 증감 차트 구현 |
| **v0.0.14** | 2026-11-12 | `4e2954c` | 프로젝트 버전 관리 체계 수립, `history.md` 신설, 웹 UI 및 백엔드 API 버전 표시 기능 구현 |
| **v0.0.13** | 2026-11-12 | `c3d8202` | README 10-봇 아레나 동기화, 기본 게이트 코드 `stock` 통일, 레포지토리 메타데이터 최신화 |
| **v0.0.12** | 2026-11-12 | `0e4ab7f` | 아레나 거래 활성도 강화, 지정가 체결 지원, 듀얼 AI Fallback 안전 메커니즘, 원클릭 설치기(`install/`) 구현 |
| **v0.0.11** | 2026-11-11 | `460ff90` | 코드 리뷰 지적 사항 반영 및 마크다운 사양서와 DB/봇 동기화 정합성 개선 |
| **v0.0.10** | 2026-11-11 | `e65be17` | `prompt.md` 사양서 개정 (10-봇 아레나, 일요 09:00 로테이션, 5,000원 방어 매매, 독립 감사 가이드) |
| **v0.0.9** | 2026-11-11 | `b6560c1` | 주간 봇 최적 로테이션 스케줄을 매주 일요일 오전 09:00 KST로 고정 앵커링 |
| **v0.0.8** | 2026-11-11 | `f6ab013` | 업비트 5,000 KRW 최소 주문 교착 방어 로직 및 LLM 주간 상위 3개 봇 자동 선별 기능 구현 |
| **v0.0.7** | 2026-11-11 | `c727915` | 대시보드 UTC 타임존 표기 오류 보정(KST 통일) 및 Node 스케줄러 듀얼 AI 호출 안정화 |
| **v0.0.6** | 2026-11-11 | `77de543` | README에 Apache 2.0 라이선스 배지 추가 및 최신 디렉토리 구조도 문서화 |
| **v0.0.5** | 2026-11-11 | `2a299da` | 미사용 구버전 레거시 파일 정리(`backend/main.py`, `agentBot/` 등) 및 소스 참조 경로 일원화 |
| **v0.0.4** | 2026-11-11 | `ee8279f` | UI 상 AI 뉴스 및 시황 분석 배치 실행 스케줄 타이머를 30분/1시간 주기에 일치하도록 수정 |
| **v0.0.3** | 2026-11-11 | `0a7491e` | Gemini 듀얼 AI 엔진(30분 Flash 속보 / 1시간 Pro 심층) 교차 검증 트레이딩 의사결정 시스템 구현 |
| **v0.0.2** | 2026-11-10 | `3e1f25d` | 오픈소스 Apache License 2.0 정식 채택 및 라이선스 파일 추가 |
| **v0.0.1** | 2026-11-09 | `720f8de` | 프로젝트 초기화 및 Upbit Open API 코인 자동매매 시스템 코어 아키텍처 구축 |

---

## 📝 상세 버전별 변경 내역 (Detailed Changelog)

### [v0.0.23] - 2026-11-14
**전수 코드 감사(b8bd374 기준), 구버전 스크립트/모듈 동기화 및 런타임 안전성 보강**
- **실행·종료 스크립트 & `/install` 번들 동기화 (Area 1)**:
  - `setup.sh`/`setup.bat` 루트 `npm install` 누락 보완 및 `.env` 포트 파싱 추가, `run_orchestrator.sh`/`run_orchestrator.bat` 환경변수(`PYTHONUTF8`, `.env`) 및 `logs/.orchestrator.pid` 락 통합.
  - `stop_services.sh`/`stop_services.bat`/`stop.bat` 및 `/install/AutoCoinTrade_*` 스크립트에서 Node.js `>= 22.5.0` 검증, Grace Period 종료 및 repo-scoped 워커 안전 종료 구현.
  - Node.js(`backend/node_server.mjs`) 실행 시 `main_orchestrator.py`·`bots.py`·`llm_filter_worker.py`·`agentBot/bot_10_jack_kellogg.py` 자동 Yield로 이중 매매/분석 루프(Double Execution) 원천 차단.
- **주간 TOP 1 로테이션 & 듀얼 AI·DB 동기화 (Area 2)**:
  - `init_db.py`, `backend/node_server.mjs`, `backend/common/pg_sync.mjs`에 신규 컬럼 자동 `ALTER TABLE` 마이그레이션 및 `market`/`ticker` 양방향 백필 보강, `llm_filter_worker.py`의 `used_capital` SQL 오류 수정 및 Graceful Drain 봇 context 포함.
  - `bots.py` Graceful Drain 이관 시 체결 정산금 + 잔여 현금 합산(`virtual_krw`), `is_selected_for_live = 0` 해제 및 8자리 버림(`round_down_volume_8`) 적용, `bot_01`~`bot_10` 차단 시에도 보유 포지션 매도 루프 무차단 검증.
  - `/api/settings/export` · `/api/settings/import-json` (`schema_version: 1.2`)에 `paper_trades`, `paper_bot_positions`, `market_regime_filter` 백업/복원 포함 및 라이브 호환 Gemini 모델 체인(`gemini-3.8-flash` / `gemini-3.1-pro-preview` 우선, 404 비재시도) 정렬.
- **주문 정합성·시세 캐시 & 프론트엔드/문서 안정화 (Area 3~5)**:
  - `backend/node_server.mjs` `checkAndHaltIfZeroBalance` SQLite 비동기/객체 추출 버그 수정, `upbitTickersCache`/`upbitCandlesCache` 및 `fetchUpbitPublicWithBackoff`(120ms 간격 + 429/503 1s/2s/4s 지수 백오프) 도입, `floorTo8DecimalsStr` 8자리 내림 정합성 강화.
  - `backend/common/algo_lab_service.mjs` Zero-Division/NaN 방어 및 2개 미만 전략군 챔피언 시 동적 비율 합계 100% 보정.
  - `frontend/src/App.jsx` SSE `AbortError` 처리·탭 전환 시 스트림 정리·`tradeMode.mode` 폴링 의존성 동기화 및 전 프로젝트 문서/버전(`0.0.23`)·`/install` 패키지 현행화.

### [v0.0.22] - 2026-11-14
- **변경 분류**: `feat` (주간 전략군별 1위 봇 자동 선출 엔진 & Graceful Drain 무손실 자금 이관)
- **주요 변경 사항**:
  - **10대 알고리즘 봇 3대 전략군 표준 분류 체계 도입 (`algo_lab_service.mjs`, `init_db.py`, `pg_sync.mjs`, `App.jsx`)**:
    - **그룹 A (`TREND_SWING` · 추세·스윙형)**: `bot_02`(슈퍼트렌드-ATR), `bot_03`(듀얼 모멘텀), `bot_07`(MACD+RSI 골든크로스), `bot_08`(20일선 눌림목)
    - **그룹 B (`VOLATILITY_BREAKOUT` · 변동성·돌파형)**: `bot_01`(변동성 돌파), `bot_04`(BB 스퀴즈 VCP), `bot_09`(거래량 스캘퍼)
    - **그룹 C (`REVERSAL_GRID` · 역추세·그리드·올라운더형)**: `bot_05`(볼린저 역추세), `bot_06`(다단계 분할 그리드), `bot_10`(잭 켈로그 VWAP/LRC)
  - **주간 7일 롤링 평가 및 종합 점수(`rotation_score`) 산출 (`evaluateWeeklyStrategyChampions`)**:
    - 최근 7일 가상 실현 손익 + 보유 포지션 미실현 손익 기반 `weekly_return_pct`, 승률, MDD 계산 (그룹 내 7일 체결 0회 시 Arena 누적 수익률 안전 Fallback).
    - `rotation_score = return_pct - (|mdd_pct| * 0.5) + (win_rate_pct * 0.05) + (7일 체결 >= 최소 기준 ? 1.0 : 0.0)` 산식으로 각 전략군 1위 봇(총 3개) 자동 선출.
  - **동적 자금 배분 모드 & 주간 스케줄러 (`node_server.mjs`, `auto_rotation_config`, `auto_rotation_history`)**:
    - `RANK_WEIGHTED_40_35_25`(기본 40:35:25), `RANK_WEIGHTED_40_40_20`(40:40:20), `EQUAL_34_33_33`(34:33:33) 지원 및 전 원화 예산 `Math.floor` 버림 처리.
    - 매 1분 KST 스케줄러가 설정 요일·시각 도달 시 `executeWeeklyBotRotation` 실행 및 `GET /api/rotation/status`, `POST /api/rotation/config`, `POST /api/rotation/execute-now` 제공 (JSON Export/Import 포함).
  - **탈락 봇 미매도 포지션 보호(Graceful Drain) & 정산금 자동 귀속 (`node_server.mjs`, `bots.py`)**:
    - 교체 시 기존 보유 물량 강제 시장가 투매 금지, 신규 매수만 차단하고 고유 전략 익절/손절/트레일링 스탑 감시 유지.
    - 미사용 가용 원화 즉시 이관 및 탈락 봇 청산 정산 완료 시 회수 원화(실현손익 포함)를 현재 활성 실전 봇의 `allocation_ratio` 비율대로 `Math.floor` 자동 충전.
  - **프론트엔드 UI 고도화 (`App.jsx`)**:
    - Arena·설정·실전 탭 전반에 3대 전략군 배지, 최근 7일 수익률, `[👑 전략군 1위 (차기 실전 후보)]` 배지, 주간 로테이션 제어 패널 및 즉시 배치 버튼, Graceful Drain 안전 감시 배너 반영.

### [v0.0.21] - 2026-11-13
- **커밋 해시**: `688eca6`
- **변경 분류**: `fix` (설정 탭 봇별 파라미터 폼 레이아웃 및 손절/익절 입력 필드 박스 오버플로우 수정)
- **주요 변경 사항**:
  - **설정 내 익절/손절 기준 입력 필드 오버플로우(Overflow) 해소**:
    - `frontend/src/styles.css`: `.form-row`에 `min-width: 0; width: 100%; box-sizing: border-box;` 적용, `.form-input`에 `width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box;`를 적용하여 브라우저 기본 `<input>` 너비로 인한 그리드 초과 현상 원천 차단.
    - `frontend/src/App.jsx`: 봇 카드 컨테이너에 `overflow: hidden`, `box-sizing: border-box` 추가 및 손절/익절 기준 입력 그리드를 `repeat(auto-fit, minmax(110px, 1fr))`로 개선하여 좁은 화면 및 카드 폭에서도 박스 밖으로 튀어나가지 않고 완벽히 내부에 수용되도록 개선.

### [v0.0.20] - 2026-11-13
- **커밋 해시**: `37623f4`
- **변경 분류**: `feat` / `refactor` (10대 알고리즘 트레이딩 엔진 고도화, 스마트 청산, 윗꼬리 필터, Jack Kellogg 전략 최적화 및 일일 서킷 브레이커)
- **주요 변경 사항**:
  - **'횡보장 자금 잠김(Position Lock)' 해소를 위한 3단계 스마트 청산(Smart Exit) 엔진 탑재 (전 봇 공통)**:
    - **시간 제한 청산 (Time-Stop)**: 단타/스캘핑 봇(`bot_01`, `bot_04`, `bot_05`, `bot_09`, `bot_10`) 대상, 실전 6시간(가상 2시간) 경과 시점에 수익률이 `-0.6% ~ +0.8%` 박스권에 갇히고 거래량 모멘텀(`RVOL < 1.0`) 침체 시 즉시 시간 청산하여 현금 유동성 확보.
    - **본절 스탑 (Breakeven Stop)**: 보유 포지션의 최고 수익률이 `+1.2%` 이상 도달 후 반락 시 `+0.25%`(왕복 수수료 0.1% + 최소 마진 0.15%) 구간에서 즉시 본절 익절 청산하여 수익 반납 방지.
    - **동적 ATR 트레일링 스탑 (Dynamic ATR Trailing Stop)**: 코인별 변동성을 반영한 15분봉/1시간봉 `ATR(14)` 기반 하드 손절(`진입가 - 2.2 * ATR`) 및 트레일링 스탑(`최고가 - 1.8 * ATR`) 적용 (ATR 미산출 시 기존 퍼센트 손절로 자동 Fallback).
  - **돌파형 봇(`bot_01`, `bot_03`, `bot_04`, `bot_09`) 윗꼬리 및 이격도 과열 필터 추가**:
    - **캔들 윗꼬리 비율 필터 (Upper-Wick Bull Trap Filter)**: 윗꼬리 길이(`High - Close`)가 전체 봉 길이(`High - Low`)의 45%를 초과하거나 종가가 상위 35% 이내에 안착하지 못한 캔들은 설거지/휩쏘 패턴으로 판별하여 진입 차단.
    - **단기 이격도 과열 캡 (Overextension Cap)**: 15분봉 종가가 20이동평균선(MA20) 또는 VWAP 대비 `+6.0%` 이상 급등/과열된 상태에서는 추격 매수 금지.
  - **`bot_10` 잭 켈로그(Jack Kellogg) VWAP & 선형회귀 알고리즘 최적화**:
    - Setup A (Breakout): `price > today_open` AND `price > vwap` AND `lrc_slope > 0` AND `rvol >= 1.8` (가상 1.4). `today_open`과 `vwap` 동시 이탈 시 즉시 기계적 손절.
    - Setup B (Dip Reversion): `vwap_disparity <= -2.8%` (가상 -2.0%) AND 저가 `lrc_lower(-2σ)` 터치/이탈 AND 양봉 반등(`close > open`) 시 2분할 매수. `prev_low` 이탈 시 즉시 손절.
  - **가상거래(Arena) vs 실전매매(Live) 파라미터 분기 및 안전장치 격리**:
    - 가상거래: LLM/BTC 매크로 필터 100% 완전 우회(Bypass), 상시 가동(Always-On) 및 완화된 지표 문턱값(`RSI <= 38`, `RVOL >= 1.4`, `K = 0.35`)으로 시뮬레이션 회전율 극대화.
    - 실전매매: 듀얼 AI 필터 및 BTC 20MA 안전장치 엄격 적용, 보수적 문턱값(`RSI <= 30`, `RVOL >= 2.0`, `K = 0.45`), 지정가 체결(Limit Order) 및 주문 취소 폴링.
  - **일일 누적 손실 방어 서킷 브레이커 (Daily Circuit Breaker / Kill-Switch)**:
    - 실전 매매 봇 대상, 당일(00:00 KST 기준) 누적 실현 손실이 할당 원금(`allocated_capital`)의 `-4.0%` 도달 시 자정까지 신규 매수 전면 차단.
    - 웹 UI 대시보드(봇 탭, 헤더 배지, 메타 그리드)에 `⚡ 서킷차단` 및 `⚡ 일일 서킷 브레이커 발동 (신규 매수 차단)` 경고 배지와 일일 손익/한도 표시 연동.
  - **Node.js(`backend/common/algo_lab_service.mjs`, `backend/node_server.mjs`) 및 Python(`bots.py`, `agentBot/bot_10_jack_kellogg.py`) 양방향 엔진 동기화 검증 완료**.

### [v0.0.19] - 2026-11-13
- **커밋 해시**: `cf8bbe7`
- **변경 분류**: `fix` (오케스트레이터 및 실행 스크립트 최신 아키텍처 동기화, 이중 주문 방어, DB 경로 통일, 레포지토리 URL 현행화)
- **주요 변경 사항**:
  - **오케스트레이터(`main_orchestrator.py`) 및 봇 모듈(`bots.py`) 전면 현행화**:
    - 레거시 3개 봇(`bot_vb`, `bot_momentum`, `bot_bb`) 하드코딩에서 최신 10대 알고리즘(`bot_01` ~ `bot_10`, `bot_10` 잭 켈로그 포함) 및 듀얼 AI 필터 워커(`bot_llm_filter`) 완벽 등록 (`BOT_RUNNERS`, `BOT_CONFIGS`).
    - 중앙 시세 허브(`market_hub.py`) 초기 캐시 웜업 연동 및 표준 DB 경로(`data/auto_coin_trade.db`) 적용.
    - Node.js 백엔드와 Python 오케스트레이터 간 상호 조율(Coordinated Execution Mode) 및 이중 체결 방어(Double Execution Shield) 구현: 백엔드가 8001 포트에서 가동 중일 경우 Python 실전 주문 실행을 디퍼(`DEFERRED_TO_NODEJS_BACKEND`)하여 중복 매매 완전 차단.
    - `normalize_bot_id` 정규화 함수 탑재: 레거시 봇 ID와 최신 `bot_01` ~ `bot_10` 간의 SQLite `bot_accounts` 및 `bots` 테이블 쿼리 불일치 결함 해소.
  - **실행 스크립트(`run_orchestrator.bat`) 가상환경 우선순위 개선**:
    - LibreOffice 파이썬 하드코딩 대신 `.venv\Scripts\python.exe` 및 `venv` 우선 탐색으로 패키지 누락 런타임 오류 방지.
  - **PostgreSQL 동기화(`pg_sync.mjs`) 예외 방어 및 로그 스팸 차단**:
    - `DB_MODE=sqlite` 또는 `PG_SYNC_ENABLED=false` 환경에서 `startAutoSync` 즉시 반환 처리로 불필요한 타이머 및 로그 스팸 차단.
    - 연결 해제 감지 시 `isConnected = false` 안전 처리.
  - **문서 및 설정 DB 경로 통일 (`SETUP_GUIDE.md`)**:
    - 잔존 구버전 DB명(`trading_ledger.db`)을 표준 SQLite 파일(`data/auto_coin_trade.db`)로 전면 통일.
  - **원격 Git 저장소 주소 현행화 (`package.json`, `frontend/package.json`, `initRule.md`)**:
    - `github.com/wonsubshin/autoCoinTrade.git`에서 `github.com/asura207/autoCoinTrade.git`로 100% 일괄 갱신.
  - **독립 배포 패키지(`/install/app`) 최신 동기화**:
    - 최신 소스 및 번들 빌드 반영.

### [v0.0.18] - 2026-11-13
- **커밋 해시**: `197ba2b`
- **변경 분류**: `feat` (신규 알고리즘 탑재 및 엔진 고도화)
- **주요 변경 사항**:
  - **잭 켈로그(Jack Kellogg) 4대 핵심 지표 순수 수식 엔진 구현 (`algo_lab_service.mjs`, `agentBot/bot_10_jack_kellogg.py`)**:
    - **① 당일/롤링 VWAP**: 당일 09:00 KST(또는 최근 24시간 롤링 15분봉 96개) 중심가격 $TP = \frac{High + Low + Close}{3}$ 기반 거래량 가중 평균가 및 이격도 % 산출.
    - **② 20봉 선형 회귀 채널(Linear Regression Channel, LRC ±2σ)**: 최소자승법(OLS)으로 기울기 $m$, 절편 $b$, 현재 시점 중심값 $\hat{y}_{19} = 19m + b$, 잔차 표준편차 $\sigma$, 상단(+2σ)/하단(-2σ) 채널 계산 (Zero-Division 방어 완비).
    - **③ 상대 거래량 폭발 배수(RVOL)**: 직전 20개 완료 분봉 평균 거래량 대비 현재 봉 거래량 폭발 배수 계산.
    - **④ 3대 핵심 가격 기준선**: 업비트 09시 일봉 기준 `today_open`(당일 시가), `prev_close`(전일 종가), `prev_high`(전일 고가), `prev_low`(전일 저가) 추출.
  - **업비트 24시간 현물 맞춤 2대 진입 셋업 & 2분할 매수(Scaling-In)**:
    - **Setup A [Breakout Long - 추세 돌파 진입]**: 당일 시가 & VWAP 상단 지지 + LRC 우상향($m > 0$) + 전고점 돌파 + RVOL 거래량 폭발(가상 $\ge 1.5$배, 실전 $\ge 2.0$배) 시 진입.
    - **Setup B [Dip Reversion Long - 과매도 이격 반등 및 분할 매수]**: 주도 코인이 단기 투매로 VWAP 대비 -2.2%~-3.0% 이하 이격 및 LRC 하단(-2σ) 터치 후 양봉/반등 전환 + 거래량 유입(RVOL $\ge 1.3$) 시 1차 매수(50% 예산), 1차 진입가 대비 추가 하락(-2.5%) 시 2차 분할 매수.
  - **기계적 손절 & 수익 극대화 청산 로직 (Exit Logic)**:
    - **기준선 기계적 손절**: Setup A 시가 및 VWAP 동시 이탈 또는 -2.0% 하드 손절, Setup B 전일 저가 이탈 또는 2차 분할 후 평단가 대비 -2.5% 손절.
    - **선형 회귀 상단 익절**: 수익률 +1.5% 이상 구간에서 LRC +2σ 상단 도달 시 전량 익절, Setup B 반등 포지션은 LRC 중심선(회귀) 도달 시 익절.
    - **거래량 클라이맥스 & 트레일링 스탑**: RVOL 2.5배 대량 거래 윗꼬리 음봉 출현 시 즉시 수익 확정 청산, 고점 대비 -1.5% 반락 트레일링 스탑 청산.
  - **가상거래(Arena) 상시 가동 & 실전거래(Live) 듀얼 AI/Regime 필터 보존**:
    - 가상 아레나에서는 듀얼 AI 및 BTC MA 필터를 완전 우회하여 24시간 상시 순수 알고리즘 검증 지속.
    - 실전 거래 시에는 기존의 듀얼 AI 교차 검증 필터, BTC 20/60MA Regime 필터, 최유리 지정가 주문(`limit_order`) 및 미체결 40초 취소, 격리 포지션 수량 매도 규칙을 100% 엄격 준수.
  - **DB 메타데이터 및 프론트엔드 UI 대시보드 연동**:
    - `bot_10` 명칭을 `잭 켈로그 프라이스액션 (Jack Kellogg Price Action)`으로 업데이트 및 마이그레이션 적용.
    - 아레나 리더보드 및 설정 화면 실전 봇 선택 카드에 `VWAP & LRC` 배지 및 상세 전략 설명 표출.

### [v0.0.17] - 2026-11-13
- **커밋 해시**: `871e2ec`
- **변경 분류**: `fix` (버그 수정 및 데이터 복구)
- **주요 변경 사항**:
  - **초반 실전 거래(15건) 및 가상 아레나 거래(234건) SQLite 원장 복구 동기화**:
    - SQLite 단독 구동 모드 전환 과정에서 누락되었던 10~11월 초반 실전 거래 15건(`trades`) 및 가상 아레나 거래 234건(`paper_trades`, 총 270건), 봇 포지션 이력 14건(`bot_positions`), 알고리즘 랩 모델 6건(`algo_lab_models`), 랩 거래 12건(`algo_lab_trades`)을 active SQLite DB(`data/auto_coin_trade.db`)에 완전 복구 적재.
    - 이에 따라 통계 화면의 다빈도 코인 순위, 봇별 손익 순위, 일간/주간/월간 차익 그래프에 초반 거래 내역이 정상적으로 복원 반영됨.
  - **백엔드 `/api/trades` 엔드포인트 SQLite 호환성 버그 해결**:
    - PostgreSQL 전용 타입 캐스팅(`::numeric`, `NULL::text`, `to_char`)으로 인해 SQLite 환경에서 발생하던 `unrecognized token: ":"` (500 에러)를 제거하고 표준 SQL 분기 처리 구현.
    - `backend/common/sqlite_db.mjs`의 `translateSqlite` 변환기에 `::type` 및 `to_char()` 자동 정제 규칙 추가.
  - **웹 대시보드 통계 거래내역 게시판 모드 자동 연동 개선**:
    - 상단 통계 모드 탭(`⚡ 실제거래 통계` ↔ `🏆 가상거래 10대 봇 통계`) 클릭 시 하단 거래내역 게시판도 해당 원장(`trades` vs `paper_trades`)으로 자동 동기화 조회되도록 개선.

### [v0.0.16] - 2026-11-13
- **커밋 해시**: `3632a14`
- **변경 분류**: `fix` (버그 수정 및 UI/UX 개선)
- **주요 변경 사항**:
  - **월별 보유 자산 증감 차트(`MonthlyAssetGrowthChart`) 글자 및 수익 뱃지 겹침 해소**:
    - **수직 여백 및 높이 확장**: 차트 높이를 280px에서 320px로 확장하고, 상단 여백(`padTop`)을 45px에서 75px로 대폭 확보.
    - **최대치 스케일링 완화**: Y축 상한선 배율을 `rawMax * 1.15`에서 `rawMax * 1.35`로 상향하여 데이터 막대가 상단 경계선에 닿지 않도록 개선.
    - **수익 표기 뱃지 위치 자동 동적 계산**: 뱃지 Y 좌표를 더 높은 막대 기준 최소 40px 위(`Math.max(28, topBarY - 40)`)로 배치하여, 막대 상단 금액 글자(`barY - 8`)와 수익 뱃지 사이에 최소 12px 이상의 깨끗한 간격을 확보.
    - **텍스트 정렬 및 뱃지 중앙 정렬 정밀화**: 뱃지 내 텍스트의 `dominantBaseline="central"` 및 `y="0"` 적용으로 브라우저별 오프셋 왜곡 방지.
    - **막대 간격 최적화**: `barGap`을 8px에서 12px로 넓혀 1일 시작 자산과 말일 자산 금액 글자가 서로 맞닿지 않도록 개선.
  - **일간/주간/월간 차익 선 그래프(`ProfitLineChart`) 상단 레이아웃 개선**:
    - 상단 여백(`padTop`) 45px 및 높이 285px 확보, 데이터 포인트 라벨 최소 Y 좌표 제한(`Math.max(18, pt.y - 10)`)으로 차트 상단 글자 잘림 방지.
  - **통계 대시보드 상단 요약 카드와 그래프 간 간격 보강**:
    - 상단 3대 자산 요약 카드와 월별 추이 차트 타이틀 간 `paddingTop: 20px`, `marginBottom: 12px`를 적용하여 시각적 독립성 강화.
  - **프로젝트 버전 및 패키지 동기화**:
    - `package.json`, `frontend/package.json`, `backend/node_server.mjs`, `frontend/src/App.jsx` 버전을 `0.0.16`으로 판올림.
    - 프로덕션 번들 재빌드 및 `/install` 독립 배포 패키지 동기화.

### [v0.0.15] - 2026-11-13
- **커밋 해시**: `ca74d8a`
- **변경 분류**: `feat` (기능 추가) & `refactor` (기능 개선)
- **주요 변경 사항**:
  - **실전 수익 통계 상단 자산 현황 요약 카드 구현**:
    - **이번달 1일 시점 평가자산**: 매월 1일 00:00 KST 기준 총 평가자산(원화+코인)을 명확하게 표기.
    - **현재 시점 평가자산**: 업비트 실계좌(원화 잔고 + 코인 평가금액) 연동을 통해 실시간 자산 표기.
    - **금액 증감 상태 표출**:
      - `▲ 금액 증가 (수익)` / `▼ 금액 감소 (손실)` / `- 변동 없음 (보합)` 직관적인 시각 배지 적용.
      - 1일 대비 순증감액(KRW) 및 증감률(%)을 컬러 코딩과 함께 명시.
  - **월별 평가자산 영구 기록 파이프라인 구축**:
    - `monthly_asset_snapshots` 테이블 신설 (SQLite 및 PostgreSQL 실시간 동기화 지원).
    - 매달 1일 시점 평가자산 고정 보존 및 현재 시점 평가자산 실시간 갱신 로직 구현.
    - 매달 변경 이력 영구 누적 저장 및 과거 월(2026-10부터) 자산 연계 지원.
  - **월별 보유 자산의 증감 그래프 (Interactive Monthly Asset Growth Chart) 구현**:
    - 매달 1일 시작 자산 막대(Bar) vs 현재/말일 자산 막대(Bar) 듀얼 비교 그래프 제공.
    - 각 월별 막대 상단에 순증감률 뱃지(`▲ +0.13%` 등) 및 마우스 인터랙티브 툴팁 지원.
    - 그래프 하단에 월별 변동 내역 상세 테이블(연월, 1일 자산, 말일 자산, 원화/코인 비중, 증감액, 증감률, 상태) 완비.
  - **백엔드 REST API 신설 및 확장**:
    - `GET /api/monthly-assets`: 월별 자산 스냅샷 이력 및 현재 월 증감 정보 제공.
    - `GET /api/statistics`: `monthly_assets` 필드 기본 포함하여 통계 화면 단일 호출 최적화.
  - **프로젝트 버전 및 패키지 번들 동기화**:
    - `package.json`, `frontend/package.json`, `backend/node_server.mjs`, `frontend/src/App.jsx` 버전을 `0.0.15`로 판올림.
    - 프로덕션 번들 재빌드 및 `/install` 독립 배포 패키지 동기화.

---

### [v0.0.14] - 2026-11-12
- **커밋 해시**: `4e2954c`
- **변경 분류**: `feat` (기능 추가) & `docs` (문서화)
- **주요 변경 사항**:
  - **프로젝트 버전 관리 정책 공식 수립**:
    - 특별한 추가 지침이 없을 경우 `0.0.1`부터 시작하여 Git 커밋 1건당 1씩 올라가는 `0.0.X` 형태를 유지하도록 규칙 정립.
    - `initRule.md`, `prompt.md`, `README.md`에 버전 관리 규칙 영구 명시.
  - **`history.md` 변경 이력 문서 신설**:
    - 프로젝트 시작(`v0.0.1`)부터 현재까지의 모든 커밋 내역과 기능을 빠짐없이 체계적으로 정리 및 기록.
  - **웹 대시보드 버전 확인 UI 구현**:
    - **좌측 상단 브랜드 로고**: `Upbit AutoTrade` 옆에 감각적인 버전 뱃지(`v0.0.14`) 추가. 뱃지 클릭 시 즉시 버전 변경 이력 모달 팝업 오픈.
    - **좌측 사이드바 푸터**: 현재 시스템 버전(`버전: v0.0.14`) 및 `[📜 변경이력]` 버튼 추가.
    - **게이트(보안 입장) 화면**: 헤더 배지에 현재 버전 태그 표출.
    - **설정(Settings) 탭**: '시스템 & 프로젝트 정보' 섹션을 강화하여 현재 버전 표기 및 전체 변경 이력 조회 모달 연동.
    - **버전 변경 이력 모달 (Version History Modal)**: 웹 화면 내에서 `0.0.1`부터 최신 버전까지의 수정 내역을 한눈에 열람할 수 있는 반응형 팝업 구현.
  - **백엔드 API 확장**:
    - `GET /api/version`: 현재 애플리케이션 버전(`0.0.14`), 빌드 정보, 커밋 카운트 반환.
    - `GET /api/version/history`: `history.md` 파일 내용을 웹 클라이언트에 실시간 제공.
    - `GET /api/setup/status`: 환경 정보에 `version` 필드 추가.
  - **패키지 및 배포 번들 동기화**:
    - 루트 및 프론트엔드 `package.json` 버전을 `0.0.14`로 동기화.
    - `frontend/dist` 프로덕션 번들 재빌드 및 `/install` 독립 패키지 동기화.

---

### [v0.0.13] - 2026-11-12
- **커밋 해시**: `c3d8202`
- **변경 분류**: `docs` (문서화) & `chore` (환경 정리)
- **주요 변경 사항**:
  - `README.md` 및 각종 가이드 문서를 최신 10대 아레나 구조(10-Bot Arena) 및 일요 로테이션에 맞추어 전면 개정.
  - 초기 게이트 진입 코드 기본값을 `stock`으로 통일하고 한글 키보드 자판 오타 자동 변환 지원 명시.
  - 루트 및 프론트엔드 `package.json` 내 프로젝트 설명(description), 키워드, GitHub 레포지토리 메타데이터 최신화.
  - `.env.example`, `SETUP_GUIDE.md`, `howtorun.md`의 설정 예시 및 설명 텍스트 동기화.

---

### [v0.0.12] - 2026-11-12
- **커밋 해시**: `0e4ab7f`
- **변경 분류**: `refactor` (리팩토링) & `feat` (기능 추가)
- **주요 변경 사항**:
  - **10대 가상 아레나 거래 활성도 개선**:
    - 모의투자 시뮬레이션 거래 체결 빈도를 대폭 활성화하여 10개 봇의 전략별 수익률 검증 속도 가속화.
    - 실시간 호가 기반 지정가(Limit Order) 체결 지원 및 슬리피지/수수료 정밀 반영.
  - **Gemini AI Fallback 안전 메커니즘**:
    - 구글 Gemini API 응답 지연, 할당량 초과, 일시 통신 장애 발생 시 거래가 중단되지 않고 안전 모드로 전환되는 다단계 Fallback 로직 구현.
  - **원클릭 독립 배포 패키지 (`/install`) 제공**:
    - 개발 도구 없이도 비개발자가 바로 사용할 수 있는 원클릭 시작/종료 스크립트 작성 (`AutoCoinTrade_Windows_Start.bat`, `AutoCoinTrade_Linux_Start.sh`).
    - 배포 번들링 자동화 스크립트(`scripts/build_install_package.sh`) 작성 및 `install/README.md` 가이드 제공.

---

### [v0.0.11] - 2026-11-11
- **커밋 해시**: `460ff90`
- **변경 분류**: `fix` (버그 수정) & `refactor` (코드 개선)
- **주요 변경 사항**:
  - 심층 코드 리뷰 지적 사항 반영 및 마크다운 사양서와의 정합성 검증 완료.
  - SQLite WAL 저널 모드와 PostgreSQL 동기화 간 발생할 수 있는 경합(Race Condition) 방어 로직 강화.
  - 아레나 봇 시뮬레이션 상태 갱신 주기 및 프론트엔드 차트 데이터 매핑 오류 수정.

---

### [v0.0.10] - 2026-11-11
- **커밋 해시**: `e65be17`
- **변경 분류**: `docs` (문서화)
- **주요 변경 사항**:
  - `prompt.md` 사양서 전면 개정.
  - 10대 봇 아레나 상시 가상 경쟁 체계, 매주 일요일 09:00 KST LLM 주간 최적 봇 자동 교체(로테이션) 메커니즘 상세화.
  - 5,000 KRW 최소 주문 데드락 방어 매매, 계좌 10% 안전 버퍼 보존, 독립 AI 에이전트 코드 감사 가이드라인 수록.

---

### [v0.0.9] - 2026-11-11
- **커밋 해시**: `b6560c1`
- **변경 분류**: `feat` (기능 추가)
- **주요 변경 사항**:
  - 주간 실전 봇 회전(Rotation) 스케줄을 업비트 주간 봉 갱신 시점인 **매주 일요일 오전 09:00:00 KST**로 앵커링.
  - 1분 단위 백그라운드 스케줄러를 통해 일요일 09:00 정각에 10대 아레나 성과를 평가하고 최적 봇을 교체하도록 이벤트 바인딩.

---

### [v0.0.8] - 2026-11-11
- **커밋 해시**: `f6ab013`
- **변경 분류**: `feat` (기능 추가)
- **주요 변경 사항**:
  - **5,000 KRW 최소 주문 교착상태(Deadlock) 방어**:
    - 업비트 최소 주문 금액 미달 잔고(더스트 코인) 발생 시 추가 소액 매수 후 전량 일괄 매도하여 현금화하는 `Buy-to-Cleanse` 로직 구현.
  - **LLM 주간 상위 3개 봇 자동 선별 및 비율 배분**:
    - Gemini LLM이 10대 봇의 수익률, MDD, 승률을 종합 분석하여 실전 투입 대상 봇 상위 1~3개를 선정하고 100% 한도 내 최적 투자 비율을 자동 제안.

---

### [v0.0.7] - 2026-11-11
- **커밋 해시**: `c727915`
- **변경 분류**: `fix` (버그 수정)
- **주요 변경 사항**:
  - 프론트엔드 대시보드 내 시간 표기가 UTC 기준이던 문제를 한국 표준시(KST, UTC+9)로 변환되도록 보정.
  - Node.js 백엔드 스케줄러와 듀얼 AI 파이프라인 연동 간 주기적 비동기 호출 안정화.

---

### [v0.0.6] - 2026-11-11
- **커밋 해시**: `77de543`
- **변경 분류**: `docs` (문서화)
- **주요 변경 사항**:
  - `README.md` 상단에 오픈소스 Apache 2.0 라이선스 배지 부착.
  - 리팩토링된 프로젝트 최신 디렉토리 구조 및 각 모듈별 상세 역할 설명 업데이트.

---

### [v0.0.5] - 2026-11-11
- **커밋 해시**: `2a299da`
- **변경 분류**: `chore` (코드 정리)
- **주요 변경 사항**:
  - 미사용 구버전 레거시 파일 정리: `backend/main.py`, `agentBot/` 폴더 내 개별 봇 파일, 오래된 캐시 정리.
  - 파이썬 트레이딩 코어를 `bots.py`, `llm_filter_worker.py` 등으로 일원화하고 소스 참조 경로 단순화.

---

### [v0.0.4] - 2026-11-11
- **커밋 해시**: `ee8279f`
- **변경 분류**: `fix` (UI 수정)
- **주요 변경 사항**:
  - UI 상 AI 뉴스 및 시장 분석 배치 스케줄 표시를 실제 동작 주기(30분 Flash 속보 / 1시간 Pro 심층)와 일치하도록 동기화.
  - 대시보드 상 스케줄 안내 타이머 텍스트 및 간격 갱신.

---

### [v0.0.3] - 2026-11-11
- **커밋 해시**: `0a7491e`
- **변경 분류**: `feat` (기능 추가)
- **주요 변경 사항**:
  - **Gemini 듀얼 AI 엔진 구축**:
    - Gemini 1.5 Flash: 30분 주기 실시간 속보 및 단기 모멘텀 분석.
    - Gemini 1.5 Pro: 1시간 주기 거시 경제 지표 및 온체인 심층 분석.
    - 양측 AI 엔진의 교차 검증(Cross-Validation)을 통해 고신뢰성 트레이딩 시그널 도출.
  - `llm_filter_worker.py` 멀티스레드 AI 분석 파이프라인 및 SSE 스트리밍 시황 서빙 구현.
  - 프론트엔드 대시보드에 실시간 AI 분석 카드 및 뉴스 감성 분석 타임라인 구현.
  - `init_db.py` 듀얼 AI 리포트 및 히스토리 저장을 위한 스키마 확장.

---

### [v0.0.2] - 2026-11-10
- **커밋 해시**: `3e1f25d`
- **변경 분류**: `chore` (라이선스 추가)
- **주요 변경 사항**:
  - 오픈소스 라이선스를 Apache License 2.0으로 정식 결정하고 프로젝트 루트에 `LICENSE` 파일 추가.

---

### [v0.0.1] - 2026-11-09
- **커밋 해시**: `720f8de`
- **변경 분류**: `feat` (초기 릴리즈)
- **주요 변경 사항**:
  - **프로젝트 베이스라인 초기화 및 아키텍처 구축**:
    - Upbit Open API 기반 가상자산 퀀트 자동매매 플랫폼 코어 구현.
    - 3대 핵심 퀀트 전략 봇 구현: 필터 결합형 변동성 돌파, 듀얼 모멘텀 스윙, 볼린저 밴드 역추세.
    - 백엔드: Native Node.js `node_server.mjs`, SQLite WAL 저널 모드 지원 및 PostgreSQL 16 이중 동기화 엔진.
    - 프론트엔드: React 18 + Vite 기반 단일 페이지 다크 테마 대시보드 (2:8 화면 분할 레이아웃).
    - 보안: 입장 코드(Gate) 잠금 화면(기본값 `stock`), API 키 외부 분리(`.env`, `config/upbit_config.json`).
    - API Rate Limit (0.12s 딜레이) 방어 및 자동 재접속 안전장치 탑재.
    - 서비스 시작/종료 배치 및 셸 스크립트 일체 제공.
