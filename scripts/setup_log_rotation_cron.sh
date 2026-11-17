#!/usr/bin/env bash
# ============================================================================
# setup_log_rotation_cron.sh
# 매일 00:00(KST) logs/*.log 분할(*.log_yyyymmdd) 및 7일 경과 파일 삭제용 crontab 등록
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] node 실행 파일을 찾을 수 없습니다." >&2
    exit 1
fi

if ! command -v crontab >/dev/null 2>&1; then
    echo "[ERROR] crontab 명령어를 찾을 수 없습니다." >&2
    exit 1
fi

ROTATE_SCRIPT="$PROJECT_ROOT/scripts/rotate_logs.mjs"
CRON_TAG="# autoCoinTrade-daily-log-rotation"
CRON_LINE="0 0 * * * TZ=Asia/Seoul ${NODE_BIN} ${ROTATE_SCRIPT} --midnight >/dev/null 2>&1 ${CRON_TAG}"

# 초기 상태 기록 (오늘 날짜로 마킹하여 당일 활성 로그는 유지)
"$NODE_BIN" "$ROTATE_SCRIPT" --init

EXISTING_CRON="$(crontab -l 2>/dev/null || true)"
FILTERED_CRON="$(printf "%s\n" "$EXISTING_CRON" | grep -vF "$CRON_TAG" || true)"

if [ -n "$FILTERED_CRON" ]; then
    printf "%s\n%s\n" "$FILTERED_CRON" "$CRON_LINE" | crontab -
else
    printf "%s\n" "$CRON_LINE" | crontab -
fi

echo "[OK] 매일 00:00 KST 로그 분할 crontab 등록 완료:"
echo "     $CRON_LINE"
