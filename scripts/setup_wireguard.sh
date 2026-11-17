#!/usr/bin/env bash
# AutoCoinTrade - WireGuard VPN + Firewall Hardening Setup Script
# Usage: sudo bash scripts/setup_wireguard.sh [--reset]
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "======================================================================"
  echo "[ERROR] WireGuard 패키지 설치·커널 인터페이스 생성·방화벽 설정은 root 권한이 필요합니다."
  echo "아래 명령으로 실행해주세요:"
  echo "  sudo bash \"$0\" $*"
  echo "======================================================================"
  exit 1
fi

RESET_KEYS=0
if [ "${1:-}" = "--reset" ]; then
  RESET_KEYS=1
fi

WG_DIR="/etc/wireguard"
CLIENTS_DIR="${WG_DIR}/clients"
WG_IFACE="wg0"
WG_PORT="${WG_PORT:-51820}"
WG_SERVER_CIDR="10.88.0.1/24"
WG_SERVER_IP="10.88.0.1"
WG_SUBNET_CIDR="10.88.0.0/24"
PEER1_IP="10.88.0.2/32"
PEER2_IP="10.88.0.3/32"
APP_PORT="${FRONTEND_PORT:-9000}"

echo "======================================================================"
echo "[1/5] WireGuard 패키지 설치 확인..."
echo "======================================================================"
if command -v dnf >/dev/null 2>&1; then
  dnf install -y wireguard-tools >/dev/null 2>&1 || dnf install -y wireguard-tools
  dnf install -y qrencode >/dev/null 2>&1 || true
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard wireguard-tools qrencode || true
else
  echo "[ERROR] 지원되지 않는 패키지 관리자입니다 (dnf 또는 apt-get 필요)."
  exit 1
fi

if ! command -v wg >/dev/null 2>&1 || ! command -v wg-quick >/dev/null 2>&1; then
  echo "[ERROR] wg / wg-quick 명령어를 찾을 수 없습니다."
  exit 1
fi

echo "======================================================================"
echo "[2/5] WireGuard 키 생성 (${WG_DIR}, 권한 0700/0600)..."
echo "======================================================================"
umask 077
mkdir -p "${CLIENTS_DIR}"
chmod 700 "${WG_DIR}" "${CLIENTS_DIR}"

gen_keypair() {
  local prefix="$1"
  local priv="${WG_DIR}/${prefix}_private.key"
  local pub="${WG_DIR}/${prefix}_public.key"
  if [ "${RESET_KEYS}" -eq 1 ] || [ ! -f "${priv}" ] || [ ! -f "${pub}" ]; then
    wg genkey | tee "${priv}" | wg pubkey > "${pub}"
    chmod 600 "${priv}" "${pub}"
  fi
}

gen_keypair "server"
gen_keypair "peer1"
gen_keypair "peer2"

if [ "${RESET_KEYS}" -eq 1 ] || [ ! -f "${WG_DIR}/peer1.psk" ]; then
  wg genpsk > "${WG_DIR}/peer1.psk"
  chmod 600 "${WG_DIR}/peer1.psk"
fi
if [ "${RESET_KEYS}" -eq 1 ] || [ ! -f "${WG_DIR}/peer2.psk" ]; then
  wg genpsk > "${WG_DIR}/peer2.psk"
  chmod 600 "${WG_DIR}/peer2.psk"
fi

SERVER_PRIV="$(cat "${WG_DIR}/server_private.key")"
SERVER_PUB="$(cat "${WG_DIR}/server_public.key")"
PEER1_PRIV="$(cat "${WG_DIR}/peer1_private.key")"
PEER1_PUB="$(cat "${WG_DIR}/peer1_public.key")"
PEER1_PSK="$(cat "${WG_DIR}/peer1.psk")"
PEER2_PRIV="$(cat "${WG_DIR}/peer2_private.key")"
PEER2_PUB="$(cat "${WG_DIR}/peer2_public.key")"
PEER2_PSK="$(cat "${WG_DIR}/peer2.psk")"

DEFAULT_IFACE="$(ip -4 route show default | awk '{print $5; exit}' || true)"
LAN_CIDR="$(ip -4 route show dev "${DEFAULT_IFACE:-wlp1s0}" proto kernel scope link | awk '{print $1; exit}' || echo '192.168.0.0/24')"
LAN_IP="$(ip -4 -o addr show dev "${DEFAULT_IFACE:-wlp1s0}" | awk '{print $4}' | cut -d/ -f1 | head -n1 || echo '192.168.0.217')"
PUBLIC_IP="$(curl -sS --max-time 4 https://api.ipify.org 2>/dev/null || curl -sS --max-time 4 https://ifconfig.me 2>/dev/null || echo '<서버_공인IP>')"
if [[ ! "${PUBLIC_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  PUBLIC_IP="<서버_공인IP>"
fi

echo "======================================================================"
echo "[3/5] ${WG_DIR}/${WG_IFACE}.conf 및 클라이언트 설정 파일 생성..."
echo "======================================================================"
cat > "${WG_DIR}/${WG_IFACE}.conf" <<EOF
[Interface]
Address = ${WG_SERVER_CIDR}
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIV}

# Peer 1: 외부 PC / 노트북 (${PEER1_IP})
[Peer]
PublicKey = ${PEER1_PUB}
PresharedKey = ${PEER1_PSK}
AllowedIPs = ${PEER1_IP}

# Peer 2: 스마트폰 / 태블릿 (${PEER2_IP})
[Peer]
PublicKey = ${PEER2_PUB}
PresharedKey = ${PEER2_PSK}
AllowedIPs = ${PEER2_IP}
EOF
chmod 600 "${WG_DIR}/${WG_IFACE}.conf"

cat > "${CLIENTS_DIR}/peer1-pc.conf" <<EOF
[Interface]
PrivateKey = ${PEER1_PRIV}
Address = ${PEER1_IP}

[Peer]
PublicKey = ${SERVER_PUB}
PresharedKey = ${PEER1_PSK}
Endpoint = ${PUBLIC_IP}:${WG_PORT}
AllowedIPs = ${WG_SUBNET_CIDR}
PersistentKeepalive = 25
EOF

cat > "${CLIENTS_DIR}/peer2-mobile.conf" <<EOF
[Interface]
PrivateKey = ${PEER2_PRIV}
Address = ${PEER2_IP}

[Peer]
PublicKey = ${SERVER_PUB}
PresharedKey = ${PEER2_PSK}
Endpoint = ${PUBLIC_IP}:${WG_PORT}
AllowedIPs = ${WG_SUBNET_CIDR}
PersistentKeepalive = 25
EOF
chmod 600 "${CLIENTS_DIR}/peer1-pc.conf" "${CLIENTS_DIR}/peer2-mobile.conf"

echo "======================================================================"
echo "[4/5] 방화벽(firewalld/ufw) 설정: UDP ${WG_PORT} 허용 & ${APP_PORT} 대역 제한..."
echo "======================================================================"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${WG_PORT}/udp" >/dev/null
  firewall-cmd --permanent --remove-port="${APP_PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --permanent --remove-port="8001/tcp" >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-rich-rule="rule family=\"ipv4\" source address=\"${LAN_CIDR}\" port protocol=\"tcp\" port=\"${APP_PORT}\" accept" >/dev/null
  firewall-cmd --permanent --add-rich-rule="rule family=\"ipv4\" source address=\"${WG_SUBNET_CIDR}\" port protocol=\"tcp\" port=\"${APP_PORT}\" accept" >/dev/null
  firewall-cmd --reload >/dev/null
  echo "  [OK] firewalld: UDP ${WG_PORT} 허용, TCP ${APP_PORT}은 LAN(${LAN_CIDR}) 및 WireGuard(${WG_SUBNET_CIDR})만 허용"
elif command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${WG_PORT}/udp" >/dev/null
  ufw deny "${APP_PORT}/tcp" >/dev/null || true
  ufw allow from "${LAN_CIDR}" to any port "${APP_PORT}" proto tcp >/dev/null
  ufw allow from "${WG_SUBNET_CIDR}" to any port "${APP_PORT}" proto tcp >/dev/null
  echo "  [OK] ufw: UDP ${WG_PORT} 허용, TCP ${APP_PORT}은 LAN 및 WireGuard 대역만 허용"
else
  echo "  [WARN] 활성화된 firewalld/ufw가 감지되지 않았습니다. 수동으로 ${APP_PORT}/tcp 외부 차단 및 ${WG_PORT}/udp 허용을 확인하세요."
fi

echo "======================================================================"
echo "[5/5] WireGuard 서비스(wg-quick@${WG_IFACE}) 기동 및 상태 확인..."
echo "======================================================================"
systemctl enable "wg-quick@${WG_IFACE}" >/dev/null
systemctl restart "wg-quick@${WG_IFACE}"
wg show "${WG_IFACE}"

echo ""
echo "======================================================================"
echo "[완료] WireGuard VPN 설정이 완료되었습니다!"
echo "======================================================================"
echo "1) 공유기 포트포워딩 필수 변경:"
echo "   - 추가(ON): 외부 UDP ${WG_PORT}  -->  내부 IP ${LAN_IP}:${WG_PORT}"
echo "   - 삭제(OFF): 기존 TCP ${APP_PORT}, TCP 8001, TCP 9900 포트포워딩 모두 제거!"
echo ""
echo "2) 외부 PC/노트북 설정 파일 (${CLIENTS_DIR}/peer1-pc.conf):"
echo "   - WireGuard 공식 클라이언트 설치 후 위 .conf 파일 가져오기"
echo "   - VPN 연결 후 브라우저 접속 주소: http://${WG_SERVER_IP}:${APP_PORT}"
echo "   - (같은 공유기 내부망에서는 기존처럼 http://${LAN_IP}:${APP_PORT} 사용 가능)"
echo ""
echo "3) 스마트폰용 WireGuard 설정 (${CLIENTS_DIR}/peer2-mobile.conf):"
if command -v qrencode >/dev/null 2>&1; then
  echo "   [모바일 앱에서 아래 QR 코드를 스캔하세요]"
  qrencode -t ansiutf8 < "${CLIENTS_DIR}/peer2-mobile.conf"
else
  echo "   cat ${CLIENTS_DIR}/peer2-mobile.conf 명령으로 내용을 복사해 WireGuard 앱에 추가하세요."
fi
echo "======================================================================"
