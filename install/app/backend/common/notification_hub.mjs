/**
 * backend/common/notification_hub.mjs
 *
 * 멀티채널 실시간 알림 허브 (Telegram Bot API · Discord Webhook · WebPush 연동)
 * - 이벤트 유형: LIVE_BUY, LIVE_SELL, DRAIN_HANDOFF, CIRCUIT_BREAKER, ZERO_BALANCE_HALT, WEEKLY_ROTATION, DAILY_SUMMARY, TEST
 * - 매매 루프 지연을 원천 차단하는 비동기 논블로킹 발송 (AbortSignal.timeout(4000) + 최대 2회 지수 백오프 재시도)
 * - 민감 토큰(telegram_bot_token, discord_webhook_url) AES-256-GCM 암호화 저장 및 UI 조회 시 마스킹 처리
 */

import { encryptSecret, safeDecryptSecret } from "./crypto_vault.mjs";

export const NOTIFICATION_EVENT_TYPES = {
  LIVE_BUY: "LIVE_BUY",
  LIVE_SELL: "LIVE_SELL",
  DRAIN_HANDOFF: "DRAIN_HANDOFF",
  CIRCUIT_BREAKER: "CIRCUIT_BREAKER",
  ZERO_BALANCE_HALT: "ZERO_BALANCE_HALT",
  WEEKLY_ROTATION: "WEEKLY_ROTATION",
  DAILY_SUMMARY: "DAILY_SUMMARY",
  TEST: "TEST",
};

const TRADE_EVENTS = new Set(["LIVE_BUY", "LIVE_SELL", "DRAIN_HANDOFF"]);
const RISK_EVENTS = new Set(["CIRCUIT_BREAKER", "ZERO_BALANCE_HALT", "WEEKLY_ROTATION"]);
const REPORT_EVENTS = new Set(["DAILY_SUMMARY"]);

const PLACEHOLDER_NOTIFICATION_VALUES = new Set([
  "your_telegram_bot_token_here",
  "your_telegram_chat_id_here",
  "your_discord_webhook_url_here",
  "YOUR_TELEGRAM_BOT_TOKEN",
  "YOUR_TELEGRAM_CHAT_ID",
  "YOUR_DISCORD_WEBHOOK_URL",
]);

function sanitizeNotificationValue(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  if (PLACEHOLDER_NOTIFICATION_VALUES.has(s) || /^your_.*_here$/i.test(s)) return "";
  return s;
}

export function maskSecretValue(val) {
  const plain = sanitizeNotificationValue(safeDecryptSecret(val || ""));
  if (!plain) return "";
  if (plain.length <= 8) return "••••••••";
  return `${plain.slice(0, 4)}••••••••${plain.slice(-4)}`;
}

function parseBoolSetting(val, defaultVal = true) {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return defaultVal;
}

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

  const rawTgToken = map.telegram_bot_token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const rawTgChatId = map.telegram_chat_id ?? process.env.TELEGRAM_CHAT_ID ?? "";
  const rawDiscordUrl = map.discord_webhook_url ?? process.env.DISCORD_WEBHOOK_URL ?? "";

  const telegramBotToken = sanitizeNotificationValue(safeDecryptSecret(rawTgToken));
  const telegramChatId = sanitizeNotificationValue(rawTgChatId);
  const discordWebhookUrl = sanitizeNotificationValue(safeDecryptSecret(rawDiscordUrl));
  const telegramConfigured = Boolean(telegramBotToken && telegramChatId);
  const discordConfigured = Boolean(discordWebhookUrl);

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

export async function saveNotificationSettings(db, payload = {}, nowStr = "") {
  const now = nowStr || new Date(Date.now() + 9 * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const current = await loadNotificationSettings(db, { maskSecrets: false });

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

  let nextDiscordUrl = current.discord_webhook_url;
  if (payload.discord_webhook_url !== undefined) {
    const input = String(payload.discord_webhook_url || "").trim();
    if (!input) {
      nextDiscordUrl = "";
    } else if (!input.includes("••••")) {
      nextDiscordUrl = input;
    }
  }

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

  const stmt = await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)");
  for (const [k, v] of entries) {
    await stmt.run(k, v, now);
  }

  return await loadNotificationSettings(db, { maskSecrets: true });
}

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
      if (resp.status !== 429 && resp.status < 500) {
        break;
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 150 * Math.pow(2, attempt)));
    }
  }
  return { ok: false, error: lastErr?.message || "Unknown notification error" };
}

export function formatNotificationMessage(eventType, data = {}) {
  const type = String(eventType || "TEST").toUpperCase();
  const title = data.title || `[autoCoinTrade] ${type}`;
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
    default:
      return {
        title,
        text: `${title}\n${data.text || "실시간 멀티채널 알림 연동이 정상적으로 작동하고 있습니다."}`,
      };
  }
}

export async function dispatchMultiChannelNotification(db, eventTypeOrPayload, dataOrOptions = {}, maybeOptions = {}) {
  let rawEventType = eventTypeOrPayload;
  let rawData = dataOrOptions;
  let options = maybeOptions;

  if (eventTypeOrPayload && typeof eventTypeOrPayload === "object") {
    rawEventType = eventTypeOrPayload.eventType || eventTypeOrPayload.event_type || "TEST";
    rawData = eventTypeOrPayload;
    options = dataOrOptions && typeof dataOrOptions === "object" ? dataOrOptions : {};
  }

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

  await Promise.allSettled(tasks);
  results.channels = {
    telegram: results.telegram,
    discord: results.discord,
    webpush: results.webpush,
  };
  return results;
}
