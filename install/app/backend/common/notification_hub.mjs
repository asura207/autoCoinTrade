/**
 * [Antigravity-Doc]
 * 파일 역할: Telegram Bot API, Discord Webhook, WebPush 3개 채널을 통합 관리·발송하는 멀티채널 실시간 알림 허브
 * 아키텍처:
 * - 알림 설정은 `system_settings` 테이블(DB)에서 우선 로드하며, 미설정 항목은 환경 변수(`TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL` 등)로 폴백합니다.
 * - 민감 시크릿(텔레그램 봇 토큰, 디스코드 웹훅 URL)은 `crypto_vault.mjs`를 통해 AES-256-GCM 암호화 저장 및 UI 노출용 마스킹(`••••`)을 수행합니다.
 * - `dispatchMultiChannelNotification`은 이벤트 카테고리별 수신 토글(`notify_on_trade`, `notify_on_risk`, `notify_daily_report`)을 검사한 뒤, 활성화된 모든 채널에 `Promise.allSettled`로 병렬 비동기 발송합니다.
 * 주요 의존성: `./crypto_vault.mjs` (`encryptSecret`, `safeDecryptSecret`), 전역 `fetch` 및 `AbortSignal.timeout`
 * 수정 시 주의사항:
 * - 새 이벤트 유형을 추가할 때는 `NOTIFICATION_EVENT_TYPES`, 카테고리 Set(`TRADE_EVENTS`/`RISK_EVENTS`/`REPORT_EVENTS`), `formatNotificationMessage`의 `switch` 분기를 모두 함께 갱신해야 합니다.
 * - `saveNotificationSettings`는 마스킹 문자열(`••••`)이 그대로 재전송될 경우 기존 저장된 실제 토큰을 유지하도록 설계되어 있습니다.
 */
/**
 * backend/common/notification_hub.mjs
 *
 * 멀티채널 실시간 알림 허브 (Telegram Bot API · Discord Webhook · WebPush 연동)
 * - 이벤트 유형: LIVE_BUY, LIVE_SELL, DRAIN_HANDOFF, CIRCUIT_BREAKER, ZERO_BALANCE_HALT, WEEKLY_ROTATION, DAILY_SUMMARY, GEMINI_QUOTA_EXCEEDED, TEST
 * - 매매 루프 지연을 원천 차단하는 비동기 논블로킹 발송 (AbortSignal.timeout(4000) + 최대 2회 지수 백오프 재시도)
 * - 민감 토큰(telegram_bot_token, discord_webhook_url) AES-256-GCM 암호화 저장 및 UI 조회 시 마스킹 처리
 */

import { encryptSecret, safeDecryptSecret } from "./crypto_vault.mjs";

// [Antigravity-Doc] 시스템 전역에서 사용하는 표준 알림 이벤트 유형 열거 상수
export const NOTIFICATION_EVENT_TYPES = {
  LIVE_BUY: "LIVE_BUY",
  LIVE_SELL: "LIVE_SELL",
  DRAIN_HANDOFF: "DRAIN_HANDOFF",
  CIRCUIT_BREAKER: "CIRCUIT_BREAKER",
  ZERO_BALANCE_HALT: "ZERO_BALANCE_HALT",
  WEEKLY_ROTATION: "WEEKLY_ROTATION",
  DAILY_SUMMARY: "DAILY_SUMMARY",
  GEMINI_QUOTA_EXCEEDED: "GEMINI_QUOTA_EXCEEDED",
  TEST: "TEST",
};

// [Antigravity-Doc] 사용자 알림 필터 토글(매매 / 리스크 / 일일리포트)에 매핑되는 이벤트 집합
const TRADE_EVENTS = new Set(["LIVE_BUY", "LIVE_SELL", "DRAIN_HANDOFF"]);
const RISK_EVENTS = new Set(["CIRCUIT_BREAKER", "ZERO_BALANCE_HALT", "WEEKLY_ROTATION", "GEMINI_QUOTA_EXCEEDED"]);
const REPORT_EVENTS = new Set(["DAILY_SUMMARY"]);

// [Antigravity-Doc] .env 예시 등에 남아 있을 수 있는 미설정 플레이스홀더 값 목록
const PLACEHOLDER_NOTIFICATION_VALUES = new Set([
  "your_telegram_bot_token_here",
  "your_telegram_chat_id_here",
  "your_discord_webhook_url_here",
  "YOUR_TELEGRAM_BOT_TOKEN",
  "YOUR_TELEGRAM_CHAT_ID",
  "YOUR_DISCORD_WEBHOOK_URL",
]);

/**
 * [Antigravity-Doc]
 * 역할: 알림 설정 문자열에서 공백과 미설정 플레이스홀더(`your_*_here` 등)를 걸러내 빈 문자열로 정규화합니다.
 * 매개변수:
 * - val {any}: 원시 설정값
 * 반환값: {string} 유효한 설정 문자열 또는 `""`
 */
function sanitizeNotificationValue(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  if (PLACEHOLDER_NOTIFICATION_VALUES.has(s) || /^your_.*_here$/i.test(s)) return "";
  return s;
}

/**
 * [Antigravity-Doc]
 * 역할: 암호화되었거나 평문인 민감 토큰을 UI 표시용 마스킹 문자열(앞 4자 + `••••••••` + 뒤 4자)로 변환합니다.
 * 매개변수:
 * - val {string}: 암호문 또는 평문 토큰
 * 반환값: {string} 마스킹된 문자열 (값이 비어 있으면 `""`, 8자 이하면 `"••••••••"`)
 */
export function maskSecretValue(val) {
  const plain = sanitizeNotificationValue(safeDecryptSecret(val || ""));
  if (!plain) return "";
  if (plain.length <= 8) return "••••••••";
  return `${plain.slice(0, 4)}••••••••${plain.slice(-4)}`;
}

/**
 * [Antigravity-Doc]
 * 역할: DB 문자열(`"true"`, `"1"`, `"yes"`, `"on"` 등) 또는 불리언 설정값을 boolean으로 파싱합니다.
 * 매개변수:
 * - val {any}: 파싱할 원본 값
 * - defaultVal {boolean} [true]: 값이 없거나 판별 불가할 때 사용할 기본값
 * 반환값: {boolean}
 */
function parseBoolSetting(val, defaultVal = true) {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return defaultVal;
}

/**
 * [Antigravity-Doc]
 * 역할: `system_settings` 테이블과 환경 변수에서 멀티채널 알림 설정을 로드하고 시크릿을 복호화/마스킹해 반환합니다.
 * 매개변수:
 * - db {object|null}: DB 래퍼 인스턴스 (`null`이면 환경 변수만 참조)
 * - options {object} [{}]: `{ maskSecrets: boolean }` (`true`일 경우 API 응답용으로 원문 토큰을 빈 문자열로 숨김)
 * 반환값: {Promise<object>} 채널별 활성화 플래그, 설정 완료 여부, 원문/마스킹 토큰, 이벤트 필터 토글을 포함한 설정 객체
 * 부수효과/예외 처리: DB 조회 실패 시 예외를 삼키고 환경 변수 및 기본값으로 안전 폴백합니다.
 */
export async function loadNotificationSettings(db, options = {}) {
  const keys = [
    "telegram_enabled",
    "telegram_bot_token",
    "telegram_chat_id",
    "discord_enabled",
    "discord_webhook_url",
    "webpush_enabled",
    "notify_on_trade",
    "notify_on_risk",
    "notify_daily_report",
  ];
  const map = {};
  // [Antigravity-Doc] system_settings에서 알림 관련 키 일괄 조회
  if (db) {
    try {
      const rows = await db
        .prepare(
          `SELECT key, value FROM system_settings WHERE key IN (${keys.map(() => "?").join(",")})`
        )
        .all(...keys);
      for (const r of rows || []) {
        map[r.key] = r.value;
      }
    } catch {}
  }

  // [Antigravity-Doc] DB 값 우선 적용, 미존재 시 프로세스 환경 변수 폴백 후 안전 복호화 및 플레이스홀더 제거
  const rawTgToken = map.telegram_bot_token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const rawTgChatId = map.telegram_chat_id ?? process.env.TELEGRAM_CHAT_ID ?? "";
  const rawDiscordUrl = map.discord_webhook_url ?? process.env.DISCORD_WEBHOOK_URL ?? "";

  const telegramBotToken = sanitizeNotificationValue(safeDecryptSecret(rawTgToken));
  const telegramChatId = sanitizeNotificationValue(rawTgChatId);
  const discordWebhookUrl = sanitizeNotificationValue(safeDecryptSecret(rawDiscordUrl));
  const telegramConfigured = Boolean(telegramBotToken && telegramChatId);
  const discordConfigured = Boolean(discordWebhookUrl);

  // [Antigravity-Doc] 채널별/카테고리별 활성화 불리언 플래그 정규화
  const telegramEnabled = parseBoolSetting(map.telegram_enabled, telegramConfigured);
  const discordEnabled = parseBoolSetting(map.discord_enabled, discordConfigured);
  const webpushEnabled = parseBoolSetting(map.webpush_enabled, true);
  const notifyOnTrade = parseBoolSetting(map.notify_on_trade, true);
  const notifyOnRisk = parseBoolSetting(map.notify_on_risk, true);
  const notifyDailyReport = parseBoolSetting(map.notify_daily_report, true);
  const maskSecrets = Boolean(options?.maskSecrets);

  return {
    telegram_enabled: telegramEnabled,
    telegram_bot_token: maskSecrets ? "" : telegramBotToken,
    telegram_bot_token_masked: maskSecretValue(telegramBotToken),
    telegram_configured: telegramConfigured,
    telegram_chat_id: telegramChatId,
    discord_enabled: discordEnabled,
    discord_webhook_url: maskSecrets ? "" : discordWebhookUrl,
    discord_webhook_url_masked: maskSecretValue(discordWebhookUrl),
    discord_configured: discordConfigured,
    webpush_enabled: webpushEnabled,
    notify_on_trade: notifyOnTrade,
    notify_on_risk: notifyOnRisk,
    notify_daily_report: notifyDailyReport,
    notify_on_daily_report: notifyDailyReport,
  };
}

/**
 * [Antigravity-Doc]
 * 역할: 사용자가 수정한 알림 설정을 검증·병합하여 `system_settings` 테이블에 암호화 저장하고, 마스킹된 최신 설정을 반환합니다.
 * 매개변수:
 * - db {object}: DB 래퍼 인스턴스
 * - payload {object} [{}]: 클라이언트에서 전달된 부분/전체 알림 설정 객체
 * - nowStr {string} [""]: `updated_at`에 기록할 타임스탬프 (미지정 시 KST 현재 시각 자동 생성)
 * 반환값: {Promise<object>} `maskSecrets: true`로 다시 로드한 최신 알림 설정 객체
 * 부수효과/예외 처리: `telegram_bot_token`과 `discord_webhook_url`은 `••••`가 포함된 마스킹 값이면 기존 값을 유지하고, 새 값이면 AES-256-GCM 암호화 후 저장합니다.
 */
export async function saveNotificationSettings(db, payload = {}, nowStr = "") {
  const now = nowStr || new Date(Date.now() + 9 * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const current = await loadNotificationSettings(db, { maskSecrets: false });

  // [Antigravity-Doc] 텔레그램 토큰 갱신: 빈 문자열이면 삭제, 마스킹 문자 미포함 시에만 신규 토큰으로 교체
  let nextTgToken = current.telegram_bot_token;
  if (payload.telegram_bot_token !== undefined) {
    const input = String(payload.telegram_bot_token || "").trim();
    if (!input) {
      nextTgToken = "";
    } else if (!input.includes("••••")) {
      nextTgToken = input;
    }
  }

  const nextTgChatId =
    payload.telegram_chat_id !== undefined
      ? String(payload.telegram_chat_id || "").trim()
      : current.telegram_chat_id;

  // [Antigravity-Doc] 디스코드 웹훅 URL 갱신: 텔레그램 토큰과 동일한 마스킹 보호 규칙 적용
  let nextDiscordUrl = current.discord_webhook_url;
  if (payload.discord_webhook_url !== undefined) {
    const input = String(payload.discord_webhook_url || "").trim();
    if (!input) {
      nextDiscordUrl = "";
    } else if (!input.includes("••••")) {
      nextDiscordUrl = input;
    }
  }

  // [Antigravity-Doc] 채널 및 이벤트 카테고리 토글 값 병합 (일일 리포트는 구/신 필드명 모두 호환)
  const telegramEnabled =
    payload.telegram_enabled !== undefined
      ? parseBoolSetting(payload.telegram_enabled, Boolean(nextTgToken && nextTgChatId))
      : Boolean(nextTgToken && nextTgChatId);
  const discordEnabled =
    payload.discord_enabled !== undefined
      ? parseBoolSetting(payload.discord_enabled, Boolean(nextDiscordUrl))
      : Boolean(nextDiscordUrl);
  const webpushEnabled =
    payload.webpush_enabled !== undefined
      ? parseBoolSetting(payload.webpush_enabled, true)
      : current.webpush_enabled;
  const notifyOnTrade =
    payload.notify_on_trade !== undefined
      ? parseBoolSetting(payload.notify_on_trade, true)
      : current.notify_on_trade;
  const notifyOnRisk =
    payload.notify_on_risk !== undefined
      ? parseBoolSetting(payload.notify_on_risk, true)
      : current.notify_on_risk;
  const rawDailyFlag =
    payload.notify_daily_report !== undefined
      ? payload.notify_daily_report
      : payload.notify_on_daily_report;
  const notifyDailyReport =
    rawDailyFlag !== undefined
      ? parseBoolSetting(rawDailyFlag, true)
      : current.notify_daily_report;

  // [Antigravity-Doc] 민감 필드(bot_token, webhook_url)는 저장 직전 AES-256-GCM 암호화
  const entries = [
    ["telegram_enabled", telegramEnabled ? "true" : "false"],
    ["telegram_bot_token", nextTgToken ? encryptSecret(nextTgToken) : ""],
    ["telegram_chat_id", nextTgChatId],
    ["discord_enabled", discordEnabled ? "true" : "false"],
    ["discord_webhook_url", nextDiscordUrl ? encryptSecret(nextDiscordUrl) : ""],
    ["webpush_enabled", webpushEnabled ? "true" : "false"],
    ["notify_on_trade", notifyOnTrade ? "true" : "false"],
    ["notify_on_risk", notifyOnRisk ? "true" : "false"],
    ["notify_daily_report", notifyDailyReport ? "true" : "false"],
  ];

  // [Antigravity-Doc] system_settings 테이블에 UPSERT 일괄 반영
  const stmt = await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)");
  for (const [k, v] of entries) {
    await stmt.run(k, v, now);
  }

  return await loadNotificationSettings(db, { maskSecrets: true });
}

/**
 * [Antigravity-Doc]
 * 역할: JSON POST 요청을 타임아웃 및 지수 백오프 재시도(429/5xx/네트워크 오류 대상)와 함께 전송합니다.
 * 매개변수:
 * - url {string}: 대상 웹훅/API 엔드포인트
 * - bodyObj {object}: JSON 직렬화할 요청 본문
 * - options {object} [{}]: `{ timeoutMs = 4000, maxRetries = 2 }`
 * 반환값: {Promise<{ok: boolean, status?: number, error?: string}>} 전송 성공 여부 및 오류 메시지
 * 부수효과/예외 처리: 4xx(429 제외) 클라이언트 오류는 재시도해도 성공 가능성이 없으므로 즉시 중단합니다.
 */
async function postWithRetry(url, bodyObj, { timeoutMs = 4000, maxRetries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        return { ok: true, status: resp.status };
      }
      const errText = await resp.text().catch(() => "");
      lastErr = new Error(`HTTP ${resp.status}: ${errText.slice(0, 140)}`);
      // [Antigravity-Doc] 레이트 리밋(429)이나 서버 오류(5xx)가 아닌 4xx 오류는 재시도 없이 즉시 탈출
      if (resp.status !== 429 && resp.status < 500) {
        break;
      }
    } catch (err) {
      lastErr = err;
    }
    // [Antigravity-Doc] 지수 백오프 대기 (150ms -> 300ms)
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 150 * Math.pow(2, attempt)));
    }
  }
  return { ok: false, error: lastErr?.message || "Unknown notification error" };
}

/**
 * [Antigravity-Doc]
 * 역할: 이벤트 유형과 페이로드 데이터를 사람이 읽기 쉬운 한국어 제목(`title`)과 본문(`text`) 메시지로 포맷팅합니다.
 * 매개변수:
 * - eventType {string}: 알림 이벤트 유형 (`LIVE_BUY`, `LIVE_SELL`, `CIRCUIT_BREAKER` 등)
 * - data {object} [{}]: 이벤트 상세 수치 및 메타데이터
 * 반환값: {{title: string, text: string}} 포맷된 알림 제목과 본문
 */
export function formatNotificationMessage(eventType, data = {}) {
  const type = String(eventType || "TEST").toUpperCase();
  const title = data.title || `[autoCoinTrade] ${type}`;
  // [Antigravity-Doc] 호출부가 커스텀 message 문자열을 직접 지정한 경우 기본 템플릿 대신 우선 사용
  if (data.message && typeof data.message === "string") {
    return { title, text: `${title}\n${data.message}` };
  }

  switch (type) {
    case "LIVE_BUY":
      return {
        title: `🔴 [실전 매수 체결] ${data.market || ""}`,
        text: [
          `🔴 [실전 매수 체결] ${data.market || ""} (${data.bot_nickname || data.bot_id || ""})`,
          `• 체결단가: ${Number(data.price || 0).toLocaleString("ko-KR")}원`,
          `• 주문금액: ${Math.floor(Number(data.amount_krw || 0)).toLocaleString("ko-KR")}원 (수량: ${data.volume || 0})`,
          data.slippage_bps !== undefined ? `• 슬리피지: ${Number(data.slippage_bps).toFixed(2)} bps` : null,
          data.reason ? `• 사유: ${data.reason}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    case "LIVE_SELL": {
      const pnl = Math.trunc(Number(data.profit_krw || 0));
      const icon = pnl >= 0 ? "🎯" : "🛡️";
      return {
        title: `${icon} [실전 매도 정산] ${data.market || ""}`,
        text: [
          `${icon} [실전 매도 정산] ${data.market || ""} (${data.bot_nickname || data.bot_id || ""})`,
          `• 매도단가: ${Number(data.price || 0).toLocaleString("ko-KR")}원`,
          `• 실현손익: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString("ko-KR")}원 (${Number(data.profit_pct || 0) >= 0 ? "+" : ""}${Number(data.profit_pct || 0).toFixed(2)}%)`,
          data.reason ? `• 청산사유: ${data.reason}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "DRAIN_HANDOFF":
      return {
        title: `🔄 [Graceful Drain 자금 이관] ${data.from_bot_id || ""}`,
        text: [
          `🔄 [Graceful Drain 청산 완료 및 원화 이관]`,
          `• 탈락 봇: ${data.from_bot_id || ""} (${data.market || ""})`,
          `• 이관 원화: ${Math.floor(Number(data.net_proceeds_krw || 0)).toLocaleString("ko-KR")}원 (잔여 포지션 ${data.remaining_positions_count ?? 0}건)`,
          data.allocations_summary ? `• 배분 내역: ${data.allocations_summary}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    case "CIRCUIT_BREAKER":
      return {
        title: `🚨 [일일 서킷 브레이커 발동] ${data.bot_id || ""}`,
        text: [
          `🚨 [일일 손실 한도(-4.0%) 서킷 브레이커 발동]`,
          `• 대상 봇: ${data.bot_nickname || data.bot_id || ""}`,
          `• 당일 누적 손익: ${Math.trunc(Number(data.daily_loss_krw || 0)).toLocaleString("ko-KR")}원 (한도: ${Math.trunc(Number(data.loss_limit_krw || 0)).toLocaleString("ko-KR")}원)`,
          `• 조치: 금일 자정(KST)까지 신규 매수 차단 (보유 포지션 청산 감시는 정상 유지)`,
        ].join("\n"),
      };
    case "ZERO_BALANCE_HALT":
      return {
        title: `⛔ [긴급 정지] 실전 잔고 0원 이하 도달`,
        text: `⛔ [긴급 정지] ${data.reason || "실전 운용 잔고가 0원 이하로 떨어져 전체 봇이 자동 중지되었습니다."}`,
      };
    case "WEEKLY_ROTATION":
      return {
        title: `🏆 [주간 TOP 1 전략 로테이션 완료]`,
        text: `🏆 [주간 TOP 1 로테이션]\n${data.summary_text || "전략군별 챔피언 봇 선출 및 자금 재배분이 완료되었습니다."}`,
      };
    case "DAILY_SUMMARY":
      return {
        title: `📊 [일일 퀀트 운용 리포트] ${data.date_str || ""}`,
        text: [
          `📊 [09:00 KST 일일 퀀트 정산 리포트 (${data.date_str || ""})]`,
          `• 전일 실현손익: ${Number(data.daily_profit_krw || 0) >= 0 ? "+" : ""}${Math.trunc(Number(data.daily_profit_krw || 0)).toLocaleString("ko-KR")}원 (체결 ${data.trade_count ?? 0}건)`,
          `• 현재 오픈 포지션: ${data.open_positions_count ?? 0}건`,
        ].join("\n"),
      };
    case "GEMINI_QUOTA_EXCEEDED":
      return {
        title: `⚠️ [Gemini API 호출 한도 초과]`,
        text: [
          `⚠️ [Gemini API 호출 한도 초과 (429 / Quota Exceeded)]`,
          data.source ? `• 발생 위치: ${data.source}` : null,
          data.trigger_type ? `• 실행 유형: ${data.trigger_type}` : null,
          data.fallback_tier ? `• 폴백 조치: ${data.fallback_tier}` : null,
          data.reason ? `• 상세: ${data.reason}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    default:
      return {
        title,
        text: `${title}\n${data.text || "실시간 멀티채널 알림 연동이 정상적으로 작동하고 있습니다."}`,
      };
  }
}

/**
 * [Antigravity-Doc]
 * 역할: 설정된 알림 정책을 평가하고 활성화된 모든 채널(Telegram, Discord, WebPush)에 이벤트를 병렬 발송합니다.
 * 매개변수:
 * - db {object|null}: 알림 설정 조회용 DB 래퍼
 * - eventTypeOrPayload {string|object}: 이벤트 유형 문자열 또는 `{ eventType, ...data }` 통합 페이로드 객체
 * - dataOrOptions {object} [{}]: 이벤트 데이터(2번째 인자가 문자열일 때) 또는 옵션(2번째 인자가 객체일 때)
 * - maybeOptions {object} [{}]: `{ settingsOverride, forceSend, telegramApiBaseUrl, webPushBroadcastFn, timeoutMs, maxRetries }`
 * 반환값: {Promise<object>} 채널별 발송 결과(`{ event_type, telegram, discord, webpush, channels }`) 또는 정책 스킵 결과(`{ skipped: true, reason, channels }`)
 * 부수효과/예외 처리: `Promise.allSettled`로 채널 간 장애를 격리하므로 한 채널이 실패해도 다른 채널 발송과 매매 루프에 영향을 주지 않습니다.
 */
export async function dispatchMultiChannelNotification(db, eventTypeOrPayload, dataOrOptions = {}, maybeOptions = {}) {
  let rawEventType = eventTypeOrPayload;
  let rawData = dataOrOptions;
  let options = maybeOptions;

  // [Antigravity-Doc] 오버로드 인자 정규화: (db, payloadObj, options) 호출 방식과 (db, eventType, data, options) 모두 지원
  if (eventTypeOrPayload && typeof eventTypeOrPayload === "object") {
    rawEventType = eventTypeOrPayload.eventType || eventTypeOrPayload.event_type || "TEST";
    rawData = eventTypeOrPayload;
    options = dataOrOptions && typeof dataOrOptions === "object" ? dataOrOptions : {};
  }

  // [Antigravity-Doc] camelCase / snake_case 혼재 호출을 모두 수용하도록 표준 필드 정규화
  const type = String(rawEventType || "TEST").toUpperCase();
  const extra = rawData?.extra && typeof rawData.extra === "object" ? rawData.extra : {};
  const data = {
    ...rawData,
    bot_id: rawData?.bot_id ?? rawData?.botId ?? "",
    bot_nickname: rawData?.bot_nickname ?? rawData?.botName ?? rawData?.bot_name ?? rawData?.botId ?? "",
    from_bot_id: rawData?.from_bot_id ?? rawData?.botId ?? rawData?.bot_id ?? "",
    amount_krw: rawData?.amount_krw ?? rawData?.amountKrw ?? 0,
    profit_krw: rawData?.profit_krw ?? rawData?.profitKrw ?? 0,
    profit_pct: rawData?.profit_pct ?? rawData?.profitPct ?? 0,
    daily_loss_krw: rawData?.daily_loss_krw ?? rawData?.profitKrw ?? rawData?.profit_krw ?? 0,
    net_proceeds_krw: rawData?.net_proceeds_krw ?? extra.netProceedsKrw ?? rawData?.amount_krw ?? 0,
    remaining_positions_count:
      rawData?.remaining_positions_count ?? extra.remainingPositionsCount ?? 0,
    summary_text: rawData?.summary_text ?? rawData?.reason ?? "",
    text: rawData?.text ?? rawData?.reason ?? "",
  };

  const cfg = options.settingsOverride || (await loadNotificationSettings(db, { maskSecrets: false }));

  // [Antigravity-Doc] TEST 이벤트나 forceSend가 아닌 경우, 사용자 카테고리별 알림 수신 거부 설정 확인
  if (type !== "TEST" && !options.forceSend) {
    if (TRADE_EVENTS.has(type) && !cfg.notify_on_trade) {
      return { skipped: true, reason: "notify_on_trade disabled", channels: {} };
    }
    if (RISK_EVENTS.has(type) && !cfg.notify_on_risk) {
      return { skipped: true, reason: "notify_on_risk disabled", channels: {} };
    }
    if (REPORT_EVENTS.has(type) && !cfg.notify_daily_report) {
      return { skipped: true, reason: "notify_daily_report disabled", channels: {} };
    }
  }

  const formatted = formatNotificationMessage(type, data);
  const results = {
    event_type: type,
    telegram: { sent: false, skipped: true, reason: "disabled_or_unconfigured" },
    discord: { sent: false, skipped: true, reason: "disabled_or_unconfigured" },
    webpush: { sent: false, skipped: true, reason: "disabled_or_unconfigured" },
  };

  const tasks = [];

  // [Antigravity-Doc] 1) Telegram Bot API sendMessage 비동기 발송 태스크 등록
  if (cfg.telegram_enabled !== false && cfg.telegram_bot_token && cfg.telegram_chat_id) {
    const tgBase = String(
      options.telegramApiBaseUrl || process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org"
    ).replace(/\/+$/, "");
    const tgUrl = `${tgBase}/bot${cfg.telegram_bot_token}/sendMessage`;
    tasks.push(
      postWithRetry(
        tgUrl,
        {
          chat_id: cfg.telegram_chat_id,
          text: formatted.text,
          disable_web_page_preview: true,
        },
        options
      ).then((r) => {
        results.telegram = { sent: r.ok, skipped: false, error: r.error || null, reason: r.ok ? "ok" : r.error };
      })
    );
  }

  // [Antigravity-Doc] 2) Discord Webhook 비동기 발송 태스크 등록
  if (cfg.discord_enabled !== false && cfg.discord_webhook_url) {
    tasks.push(
      postWithRetry(
        cfg.discord_webhook_url,
        {
          username: "autoCoinTrade Quant Bot",
          content: formatted.text,
        },
        options
      ).then((r) => {
        results.discord = { sent: r.ok, skipped: false, error: r.error || null, reason: r.ok ? "ok" : r.error };
      })
    );
  }

  // [Antigravity-Doc] 3) WebPush 브로드캐스트 콜백(주입된 경우) 비동기 실행 태스크 등록
  if (cfg.webpush_enabled !== false && typeof options.webPushBroadcastFn === "function") {
    tasks.push(
      Promise.resolve()
        .then(() =>
          options.webPushBroadcastFn({
            title: formatted.title,
            body: formatted.text.replace(`${formatted.title}\n`, ""),
            tag: `autocoin-${type.toLowerCase()}-${Date.now()}`,
            url: "/",
          })
        )
        .then((wpRes) => {
          results.webpush = {
            sent: Boolean(wpRes?.success !== false),
            skipped: false,
            count: Number(wpRes?.count || 0),
          };
        })
        .catch((err) => {
          results.webpush = { sent: false, skipped: false, error: err?.message || "webpush failed" };
        })
    );
  }

  // [Antigravity-Doc] 모든 활성 채널 발송을 병렬 대기한 뒤 하위 호환용 channels 필드를 포함해 결과 반환
  await Promise.allSettled(tasks);
  results.channels = {
    telegram: results.telegram,
    discord: results.discord,
    webpush: results.webpush,
  };
  return results;
}