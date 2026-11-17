#!/usr/bin/env bash
# ==============================================================================
# Rocky Linux SSH 보안 강화 스크립트 (Option 2: Fail2ban + Root 차단 + 안전한 키 인증)
# 실행 방법: sudo ./scripts/harden_ssh.sh [변경할_SSH_포트(선택)]
# ==============================================================================
set -e

TARGET_USER="${SUDO_USER:-asura}"
TARGET_HOME="$(eval echo "~${TARGET_USER}")"
NEW_SSH_PORT="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
    echo "[오류] 시스템 설정 변경을 위해 sudo 권한이 필요합니다."
    echo "실행 방법: sudo $0 [변경할_SSH_포트(선택, 기본 유지 시 생략)]"
    exit 1
fi

echo "==================================================="
echo "[1/4] 사용자(${TARGET_USER}) SSH 디렉터리 권한 점검..."
echo "==================================================="
mkdir -p "${TARGET_HOME}/.ssh"
touch "${TARGET_HOME}/.ssh/authorized_keys"
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.ssh"
chmod 700 "${TARGET_HOME}/.ssh"
chmod 600 "${TARGET_HOME}/.ssh/authorized_keys"
echo "  -> ${TARGET_HOME}/.ssh (700) 및 authorized_keys (600) 설정 완료"

echo ""
echo "==================================================="
echo "[2/4] Fail2ban 설치 및 SSH 무차별 대입(Brute-force) 자동 차단 설정..."
echo "==================================================="
if ! command -v fail2ban-client >/dev/null 2>&1; then
    dnf install -y epel-release >/dev/null 2>&1 || true
    dnf install -y fail2ban fail2ban-firewalld
fi

SSH_PORT_FOR_F2B="${NEW_SSH_PORT:-ssh}"
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 192.168.0.0/24 10.88.0.0/24 218.234.55.78 211.192.251.14
bantime = 1h
findtime = 10m
maxretry = 5
banaction = firewallcmd-rich-rules[actiontype=<multiport>]

[sshd]
enabled = true
port = ${SSH_PORT_FOR_F2B}
EOF

systemctl enable --now fail2ban
echo "  -> Fail2ban 활성화 완료 (10분 내 5회 실패 시 1시간 IP 차단)"

echo ""
echo "==================================================="
echo "[3/4] SSH 데몬(/etc/ssh/sshd_config.d/99-hardening.conf) 보안 강화..."
echo "==================================================="
HAS_PUBKEY=0
if [ -s "${TARGET_HOME}/.ssh/authorized_keys" ] && grep -qE "ssh-(rsa|ed25519|ecdsa)" "${TARGET_HOME}/.ssh/authorized_keys"; then
    HAS_PUBKEY=1
fi

if [ "${HAS_PUBKEY}" -eq 1 ]; then
    PASS_AUTH="no"
    echo "  -> [확인] 등록된 SSH 공개키가 확인되어 비밀번호 로그인(PasswordAuthentication)을 비활성화합니다."
else
    PASS_AUTH="yes"
    echo "  -> [잠김 방지 보호] 아직 ${TARGET_HOME}/.ssh/authorized_keys 에 공개키가 없습니다."
    echo "     원격 접속이 끊기는 것을 막기 위해 비밀번호 로그인은 유지(yes)하고,"
    echo "     Root 직접 로그인 차단 및 인증 시도 횟수 제한(4회)만 먼저 적용합니다."
fi

cat > /etc/ssh/sshd_config.d/99-hardening.conf <<EOF
# AutoCoinTrade SSH Security Hardening
PermitRootLogin no
MaxAuthTries 4
LoginGraceTime 30
PubkeyAuthentication yes
PasswordAuthentication ${PASS_AUTH}
PermitEmptyPasswords no
EOF

if [ -n "${NEW_SSH_PORT}" ]; then
    echo "Port ${NEW_SSH_PORT}" >> /etc/ssh/sshd_config.d/99-hardening.conf
    if command -v semanage >/dev/null 2>&1; then
        semanage port -a -t ssh_port_t -p tcp "${NEW_SSH_PORT}" 2>/dev/null || semanage port -m -t ssh_port_t -p tcp "${NEW_SSH_PORT}" 2>/dev/null || true
    fi
    if systemctl is-active --quiet firewalld; then
        firewall-cmd --permanent --add-port="${NEW_SSH_PORT}/tcp"
        firewall-cmd --reload
    fi
    echo "  -> SSH 포트 ${NEW_SSH_PORT}/tcp 추가 및 방화벽 허용 완료"
fi

echo ""
echo "==================================================="
echo "[4/4] SSH 설정 문법 검증 및 재시작..."
echo "==================================================="
sshd -t
systemctl reload sshd
fail2ban-client status sshd || true

echo ""
echo "[완료] SSH 보안 강화 설정이 정상적으로 적용되었습니다."
