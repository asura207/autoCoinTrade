/**
 * tests/verify_notification_hub_and_journal.mjs
 *
 * [Prompt 4 Verification Suite]
 * 1. Notification settings encryption (AES-256-GCM in system_settings) & API secret masking
 * 2. Local Mock Telegram + Mock Discord HTTP server delivery across LIVE_BUY, LIVE_SELL, CIRCUIT_BREAKER, TEST
 * 3. Event filter toggle enforcement (notify_on_trade = false skips LIVE_BUY while allowing CIRCUIT_BREAKER)
 * 4. buildChartTradeMarkers: OHLC + VWAP + LRC(upper/mid/lower) + 20MA + BUY(#ef4444)/SELL(#3b82f6) marker alignment
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-notif-test-"));
const TMP_DB = path.join(TMP_DIR, "notif_test.db");

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_MASTER_KEY = "unit-test-master-key-for-notification-hub-32bytes!";
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DB_PATH = TMP_DB;

const receivedTelegram = [];
const receivedDiscord = [];

const mockServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c.toString("utf8")));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    if (req.url?.includes("/sendMessage")) {
      receivedTelegram.push({ url: req.url, body: parsed });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: receivedTelegram.length } }));
      return;
    }
    if (req.url?.includes("/discord-webhook")) {
      receivedDiscord.push({ url: req.url, body: parsed });
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

const results = [];

try {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${port}`;

  const {
    initializeDatabase,
    getDb,
    saveNotificationSettings,
    loadNotificationSettings,
    dispatchMultiChannelNotification,
    buildChartTradeMarkers,
    isEncryptedVaultValue,
  } = await import("../backend/node_server.mjs");

  await initializeDatabase();
  const db = getDb();

  // 0. Placeholder values from .env.example must be treated as unconfigured
  const prevTgTok = process.env.TELEGRAM_BOT_TOKEN;
  const prevTgChat = process.env.TELEGRAM_CHAT_ID;
  const prevDcUrl = process.env.DISCORD_WEBHOOK_URL;
  process.env.TELEGRAM_BOT_TOKEN = "your_telegram_bot_token_here";
  process.env.TELEGRAM_CHAT_ID = "your_telegram_chat_id_here";
  process.env.DISCORD_WEBHOOK_URL = "your_discord_webhook_url_here";
  const placeholderLoaded = await loadNotificationSettings(db, { maskSecrets: false });
  assert.equal(placeholderLoaded.telegram_configured, false, "Placeholder Telegram env must not be treated as configured");
  assert.equal(placeholderLoaded.telegram_enabled, false, "Placeholder Telegram env must not auto-enable");
  assert.equal(placeholderLoaded.discord_configured, false, "Placeholder Discord env must not be treated as configured");
  if (prevTgTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevTgTok;
  if (prevTgChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevTgChat;
  if (prevDcUrl === undefined) delete process.env.DISCORD_WEBHOOK_URL; else process.env.DISCORD_WEBHOOK_URL = prevDcUrl;
  results.push({
    check: "Example Placeholder Sanitization",
    status: "PASS",
    detail: "your_telegram_bot_token_here / your_telegram_chat_id_here treated as unconfigured",
  });

  // 1. Encrypted storage & masked loading
  const fakeTgToken = "987654321:AAFakeTelegramBotTokenSecret12345";
  const fakeDiscordUrl = `${mockBase}/discord-webhook/test-secret-hook`;
  const savedMasked = await saveNotificationSettings(db, {
    telegram_enabled: true,
    telegram_bot_token: fakeTgToken,
    telegram_chat_id: "555001122",
    discord_enabled: true,
    discord_webhook_url: fakeDiscordUrl,
    webpush_enabled: true,
    notify_on_trade: true,
    notify_on_risk: true,
    notify_on_daily_report: true,
  });

  assert.equal(savedMasked.telegram_bot_token, "", "Masked save response must not leak raw telegram_bot_token");
  assert.ok(savedMasked.telegram_bot_token_masked.includes("••••"), "Masked token must contain bullet mask");
  assert.equal(savedMasked.discord_webhook_url, "", "Masked save response must not leak raw discord_webhook_url");

  const rawDbTg = await db.prepare("SELECT value FROM system_settings WHERE key = 'telegram_bot_token'").get();
  const rawDbDc = await db.prepare("SELECT value FROM system_settings WHERE key = 'discord_webhook_url'").get();
  assert.equal(isEncryptedVaultValue(rawDbTg.value), true, "telegram_bot_token must be AES-256-GCM encrypted in DB");
  assert.equal(isEncryptedVaultValue(rawDbDc.value), true, "discord_webhook_url must be AES-256-GCM encrypted in DB");
  assert.ok(!rawDbTg.value.includes("AAFakeTelegramBotToken"), "Plaintext token must never appear in DB");

  const loadedUnmasked = await loadNotificationSettings(db, { maskSecrets: false });
  assert.equal(loadedUnmasked.telegram_bot_token, fakeTgToken);
  assert.equal(loadedUnmasked.discord_webhook_url, fakeDiscordUrl);
  results.push({
    check: "Encrypted Storage & Masking",
    status: "PASS",
    detail: `DB stored as enc:v1:..., UI masked=${savedMasked.telegram_bot_token_masked}`,
  });

  // 2. Multi-channel dispatch (Telegram + Discord + WebPush)
  let webPushCalls = 0;
  const wpMock = async () => {
    webPushCalls += 1;
    return { success: true, count: 1 };
  };

  const buyRes = await dispatchMultiChannelNotification(
    db,
    {
      eventType: "LIVE_BUY",
      botId: "bot_10",
      botName: "잭 켈로그 올라운더봇",
      market: "KRW-BTC",
      price: 100000000,
      volume: "0.001",
      amountKrw: 100000,
      reason: "Setup B VWAP 반등",
    },
    { telegramApiBaseUrl: mockBase, webPushBroadcastFn: wpMock }
  );
  assert.equal(buyRes.telegram.sent, true, "Telegram LIVE_BUY must deliver");
  assert.equal(buyRes.discord.sent, true, "Discord LIVE_BUY must deliver");
  assert.equal(buyRes.webpush.sent, true, "WebPush LIVE_BUY must deliver");
  assert.equal(receivedTelegram.length, 1);
  assert.equal(receivedDiscord.length, 1);
  assert.ok(receivedTelegram[0].body.text.includes("KRW-BTC"));
  assert.ok(receivedDiscord[0].body.content.includes("실전 매수 체결"));

  const sellRes = await dispatchMultiChannelNotification(
    db,
    {
      eventType: "LIVE_SELL",
      botId: "bot_10",
      botName: "잭 켈로그 올라운더봇",
      market: "KRW-BTC",
      price: 103500000,
      profitKrw: 3400,
      profitPct: 3.4,
      reason: "LRC 상단 익절",
    },
    { telegramApiBaseUrl: mockBase, webPushBroadcastFn: wpMock }
  );
  assert.equal(sellRes.telegram.sent, true);
  assert.equal(sellRes.discord.sent, true);
  assert.equal(webPushCalls, 2);
  results.push({
    check: "Telegram + Discord + WebPush Dispatch",
    status: "PASS",
    detail: `Telegram=${receivedTelegram.length}, Discord=${receivedDiscord.length}, WebPush=${webPushCalls}`,
  });

  // 3. Event filter toggle enforcement
  await saveNotificationSettings(db, { notify_on_trade: false, notify_on_risk: true });
  const skippedBuy = await dispatchMultiChannelNotification(
    db,
    { eventType: "LIVE_BUY", market: "KRW-ETH", amountKrw: 50000 },
    { telegramApiBaseUrl: mockBase }
  );
  assert.equal(skippedBuy.skipped, true, "LIVE_BUY must be skipped when notify_on_trade=false");

  const riskSent = await dispatchMultiChannelNotification(
    db,
    { eventType: "CIRCUIT_BREAKER", botId: "bot_01", profitKrw: -42000, reason: "일일 손실 -4% 도달" },
    { telegramApiBaseUrl: mockBase }
  );
  assert.equal(riskSent.telegram.sent, true, "CIRCUIT_BREAKER must still send when notify_on_risk=true");
  results.push({
    check: "Event Filter Toggles",
    status: "PASS",
    detail: "notify_on_trade=false skipped LIVE_BUY; CIRCUIT_BREAKER delivered",
  });

  // 4. Candlestick + VWAP/LRC/20MA + BUY/SELL Trade-Marker Chart Builder
  const customCandles = [];
  const baseMs = Date.UTC(2026, 10, 1, 0, 0, 0);
  for (let i = 0; i < 40; i++) {
    const tStr = new Date(baseMs + i * 15 * 60000 + 9 * 3600000).toISOString().replace("T", " ").slice(0, 19);
    const c = 100000 + Math.sin(i / 4) * 1500 + i * 50;
    customCandles.push({
      candle_date_time_kst: tStr,
      opening_price: c - 100,
      high_price: c + 250,
      low_price: c - 250,
      trade_price: c,
      candle_acc_trade_volume: 1200 + i * 15,
    });
  }

  await db
    .prepare(
      `INSERT INTO trades (bot_id, market, buy_order_uuid, sell_order_uuid, buy_price, buy_volume, buy_amount, buy_date, sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, status)
       VALUES ('bot_10', 'KRW-BTC', 'mk-buy-1', 'mk-sell-1', ?, '0.5', 50000, ?, ?, '0.5', 52000, ?, 2000, 4.0, 'COMPLETED')`
    )
    .run(
      customCandles[22].trade_price,
      customCandles[22].candle_date_time_kst,
      customCandles[31].trade_price,
      customCandles[31].candle_date_time_kst
    );

  const chart = await buildChartTradeMarkers(db, {
    market: "KRW-BTC",
    botId: "bot_10",
    mode: "live",
    unit: "15",
    count: 40,
    customCandles,
  });

  assert.equal(chart.candles.length, 40, "Must return 40 enriched candles");
  assert.ok(chart.candles[35].vwap > 0, "VWAP must be computed");
  assert.ok(chart.candles[35].ma20 > 0, "20MA must be computed");
  assert.ok(chart.candles[35].lrc_upper > chart.candles[35].lrc_lower, "LRC upper > lower");
  const buyMarker = chart.markers.find((m) => m.type === "BUY");
  const sellMarker = chart.markers.find((m) => m.type === "SELL");
  assert.ok(buyMarker && buyMarker.color === "#ef4444" && buyMarker.candle_index === 22, "BUY marker must align to bar 22");
  assert.ok(sellMarker && sellMarker.color === "#3b82f6" && sellMarker.candle_index === 31, "SELL marker must align to bar 31");
  results.push({
    check: "Trade-Marker Chart Builder",
    status: "PASS",
    detail: `candles=40, VWAP/LRC/20MA populated, BUY@idx=${buyMarker.candle_index}, SELL@idx=${sellMarker.candle_index}`,
  });

  console.log("\n=== [Prompt 4] Multi-Channel Notification Hub & Trade-Marker Chart Verification ===");
  console.table(results);
} finally {
  await new Promise((r) => mockServer.close(r));
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}
