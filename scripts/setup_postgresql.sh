#!/usr/bin/env bash
# ========================================================
# PostgreSQL 16 - coin_trader DB 및 외부 접속 자동 설정 스크립트
# ========================================================
set -e

if [ "$EUID" -ne 0 ]; then
    echo "[ERROR] 이 스크립트는 root 권한(sudo)으로 실행해야 합니다." >&2
    echo "실행 방법: sudo ./scripts/setup_postgresql.sh" >&2
    exit 1
fi

echo "========================================================"
echo "[1/4] PostgreSQL 16 설정 파일(pg_hba.conf, postgresql.conf) 위치 탐색..."
echo "========================================================"

PG_DATA="/var/lib/pgsql/data"
if [ ! -d "$PG_DATA" ]; then
    PG_DATA=$(find /var/lib/pgsql -name "pg_hba.conf" -exec dirname {} \; | head -n 1)
fi

if [ -z "$PG_DATA" ] || [ ! -f "$PG_DATA/pg_hba.conf" ]; then
    echo "[ERROR] PostgreSQL 데이터 디렉터리를 찾을 수 없습니다." >&2
    exit 1
fi

echo "  -> PG DATA 경로: $PG_DATA"

# 1. postgresql.conf listen_addresses = '*' 설정
echo ""
echo "[2/4] 외부/원격 접속 허용 설정 (listen_addresses = '*')..."
PG_CONF="$PG_DATA/postgresql.conf"
if [ -f "$PG_CONF" ]; then
    cp "$PG_CONF" "${PG_CONF}.bak_$(date +%Y%m%d%H%M%S)"
    if grep -qE "^\s*listen_addresses\s*=" "$PG_CONF"; then
        sed -i "s/^\s*listen_addresses\s*=.*/listen_addresses = '*'/" "$PG_CONF"
    else
        echo "listen_addresses = '*'" >> "$PG_CONF"
    fi
    echo "  [OK] listen_addresses = '*' 설정 완료"
fi

# 2. pg_hba.conf 비밀번호(scram-sha-256) 인증 및 외부 대역 허용
echo ""
echo "[3/4] pg_hba.conf 인증 방식 scram-sha-256 적용 및 외부 허용..."
HBA_CONF="$PG_DATA/pg_hba.conf"
cp "$HBA_CONF" "${HBA_CONF}.bak_$(date +%Y%m%d%H%M%S)"

# 기존 127.0.0.1 및 ::1의 ident를 scram-sha-256으로 변경
sed -i -E 's/(host\s+all\s+all\s+127\.0\.0\.1\/32\s+)ident/\1scram-sha-256/g' "$HBA_CONF"
sed -i -E 's/(host\s+all\s+all\s+::1\/128\s+)ident/\1scram-sha-256/g' "$HBA_CONF"

# 0.0.0.0/0 (외부 모든 IP) 접속 허용 행 추가 (없을 경우)
if ! grep -q "0.0.0.0/0" "$HBA_CONF"; then
    echo "# Allow external password authentication for coin_trader" >> "$HBA_CONF"
    echo "host    all             all             0.0.0.0/0               scram-sha-256" >> "$HBA_CONF"
    echo "host    all             all             ::/0                    scram-sha-256" >> "$HBA_CONF"
    echo "  [OK] 외부 접속(0.0.0.0/0, ::/0) scram-sha-256 규칙 추가 완료"
fi

# 서비스 재시작
systemctl restart postgresql
echo "  [OK] PostgreSQL 서비스 재기동 완료"

# 3. coin_trader 계정 및 DB 생성
echo ""
echo "[4/4] PostgreSQL 'coin_trader' 유저 및 'coin_trader' 데이터베이스 생성..."
sudo -u postgres psql << 'EOSQL'
DO
$do$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'coin_trader') THEN
      CREATE ROLE coin_trader WITH LOGIN ENCRYPTED PASSWORD 'coin123$%^';
   ELSE
      ALTER ROLE coin_trader WITH ENCRYPTED PASSWORD 'coin123$%^';
   END IF;
END
$do$;

SELECT 'CREATE DATABASE coin_trader OWNER coin_trader'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'coin_trader')\gexec

GRANT ALL PRIVILEGES ON DATABASE coin_trader TO coin_trader;
ALTER DATABASE coin_trader OWNER TO coin_trader;
\c coin_trader
GRANT ALL ON SCHEMA public TO coin_trader;
ALTER SCHEMA public OWNER TO coin_trader;
EOSQL

echo ""
echo "========================================================"
echo "[SUCCESS] PostgreSQL coin_trader 계정 및 DB 구성 완료!"
echo "========================================================"
echo "• Database : coin_trader"
echo "• User     : coin_trader"
echo "• Password : coin123$%^"
echo "• Port     : 5432"
echo "• Host     : 127.0.0.1 (로컬) / <서버 사내 LAN IP> / <외부 공인 IP>"
echo "========================================================"

