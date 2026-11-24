# 🐳 AutoCoinTrade Docker 통합 배포 패키지 (DB 포함)

> **현재 개발/운영 환경(Node.js 22 + Python 3 + SQLite WAL + PostgreSQL 16)과 100% 동일한 Docker 이미지를 빌드하고, DB까지 한 번에 구동하는 독립 배포 패키지입니다.**

본 `/install` 폴더만 복사하면 Windows / Linux / macOS 어디서든 Docker 한 번으로 백엔드(8001), 보안 프론트엔드(9000), 내장 PostgreSQL 16 DB(5432), SQLite WAL, Python 퀀트 가상환경(`.venv`)이 모두 동일하게 구성됩니다.

---

## 1. 포함 구성 (Container Stack)

| 서비스 | 이미지 | 포트 | 역할 |
| :--- | :--- | :---: | :--- |
| **`postgres`** | `postgres:16-alpine` | `5432` | **기본 포함 PostgreSQL 16 DB** (볼륨 `autocoin_pgdata` 영구 저장) |
| **`autocoin-backend`** | `autocoin-trade:latest` (로컬 빌드) | `8001` | Node.js 22 백엔드 엔진 · 10대 퀀트 봇 · 5중 실전 가드레일 · WebSocket · SQLite WAL + PG 하이브리드 동기화 |
| **`autocoin-frontend`** | `autocoin-trade:latest` (동일 이미지) | `9000` | Vite 프로덕션 번들 정적 서빙 + `/api/*` 리버스 프록시 보안 웹 서버 |
| **`llm-filter-worker`** *(선택)* | `autocoin-trade:latest` (동일 이미지) | - | Python 3(`.venv`) LLM 시황/뉴스 필터 워커 (`--profile workers`로 활성화) |

---

## 2. 사전 준비

- **Windows / macOS**: [Docker Desktop](https://www.docker.com/products/docker-desktop/) 설치 및 실행
- **Linux**: Docker Engine + Docker Compose 플러그인 (`docker compose`) 설치

*(별도의 Node.js, Python, PostgreSQL 설치가 전혀 필요 없습니다.)*

---

## 3. 원클릭 빌드 및 실행

### Linux / macOS
```bash
cd install
chmod +x *.sh
./AutoCoinTrade_Linux_Start.sh
```
- 종료 (DB 데이터 보존):
  ```bash
  ./AutoCoinTrade_Linux_Stop.sh
  ```
- 완전 초기화 (DB 볼륨까지 삭제):
  ```bash
  ./AutoCoinTrade_Linux_Stop.sh --clean
  ```

### Windows
- **시작**: `AutoCoinTrade_Windows_Start.bat` 더블 클릭
- **종료**: `AutoCoinTrade_Windows_Stop.bat` 더블 클릭

### 수동 Docker Compose 명령
```bash
# 기본 실행 (App 이미지 빌드 + PostgreSQL 16 + Backend + Frontend)
docker compose up -d --build

# Python LLM 필터 워커까지 함께 실행
docker compose --profile workers up -d --build

# 상태 및 로그 확인
docker compose ps
docker compose logs -f
```

---

## 4. Docker 이미지 단독 빌드 및 오프라인 내보내기 (`.tar`)

폐쇄망/별도 서버로 Docker 이미지(앱 + PostgreSQL 16 DB)를 그대로 옮기고 싶을 때:

```bash
# 앱 이미지만 빌드 (autocoin-trade:latest)
./AutoCoinTrade_Linux_Build_Image.sh

# 앱 이미지 + postgres:16-alpine 이미지를 하나의 tar 파일로 저장
./AutoCoinTrade_Linux_Build_Image.sh --save
```
대상 서버에서 로드:
```bash
docker load -i autocoin-docker-images.tar
docker compose up -d --no-build
```

---

## 5. 접속 및 초기 설정

- **웹 대시보드**: `http://localhost:9000`
- **백엔드 API**: `http://localhost:8001`
- **기본 입장 코드**: `stock` (`.env`의 `GATE_CODE` 또는 웹 대시보드 `⚙️ 설정`에서 변경 가능)
- **PostgreSQL 16 접속**: `localhost:5432` / DB: `coin_trader` / User: `coin_trader` (비밀번호는 `.env`의 `PGPASSWORD`)

> 💡 최초 실행 시 `.env.example`이 `.env`로 자동 복사됩니다. 실전 거래 API 키, Gemini API 키, DB 비밀번호 변경이 필요하면 `.env`를 수정한 뒤 `docker compose up -d`로 재적용하거나 웹 대시보드의 초기 설정 마법사를 이용하세요.

---

## 6. 데이터 영구 보존 경로

- `./data`: SQLite WAL DB(`auto_coin_trade.db`), 세션/암호화 볼트 키
- `./config`: `upbit_config.json` (API 키 AES-256-GCM 암호화 저장)
- `./logs`: 일자별 로테이션 로그 (`backend.log`, `frontend.log`)
- Docker Volume `autocoin_pgdata`: PostgreSQL 16 데이터베이스 영구 스토리지
