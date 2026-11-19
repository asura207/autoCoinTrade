/**
 * tests/verify_upbit_ws_hub.mjs
 *
 * [Prompt 1 Verification Suite]
 * 1. Local Mock RFC-6455 WebSocket Server (zero external deps) -> UpbitWsHub live ticker & orderbook streaming
 * 2. Disconnect -> Exponential backoff automatic reconnect & re-subscription
 * 3. Stale (>5,000ms) -> transport_mode transitions WS -> REST fallback
 * 4. Tick-reactive smart exit (triggerTickReactiveSmartExit): immediate live stop-loss sell + 1,500ms debounce
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-ws-test-"));
const TMP_DB = path.join(TMP_DIR, "ws_test.db");

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_FORCE_LIVE_MODE = "1";
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DB_PATH = TMP_DB;

function createWsServerFrame(payloadText) {
  const payload = Buffer.from(payloadText, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseClientFrames(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    offset += 2;
    if (payloadLen === 126) {
      if (offset + 2 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (offset + 8 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (offset + payloadLen > buf.length) break;
    const raw = Buffer.from(buf.subarray(offset, offset + payloadLen));
    if (masked && maskKey) {
      for (let i = 0; i < raw.length; i++) {
        raw[i] ^= maskKey[i % 4];
      }
    }
    offset += payloadLen;
    if (opcode === 0x1 || opcode === 0x2) {
      messages.push(raw.toString("utf8"));
    }
  }
  return messages;
}

function createMockUpbitWsServer() {
  const clients = new Set();
  const receivedSubs = [];
  let connectionCount = 0;

  const server = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end("Upgrade Required");
  });

  server.on("upgrade", (req, socket) => {
    connectionCount += 1;
    const wsKey = req.headers["sec-websocket-key"];
    const acceptKey = crypto
      .createHash("sha1")
      .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        "",
      ].join("\r\n")
    );

    clients.add(socket);
    socket.on("data", (chunk) => {
      const msgs = parseClientFrames(chunk);
      for (const m of msgs) {
        if (m === "PING") {
          socket.write(createWsServerFrame('{"status":"UP"}'));
        } else {
          receivedSubs.push(m);
        }
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  return {
    server,
    clients,
    receivedSubs,
    getConnectionCount: () => connectionCount,
    broadcastJson(obj) {
      const frame = createWsServerFrame(JSON.stringify(obj));
      for (const sock of clients) {
        try {
          sock.write(frame);
        } catch {}
      }
    },
    dropAllClients() {
      for (const sock of clients) {
        try {
          sock.destroy();
        } catch {}
      }
      clients.clear();
    },
  };
}

async function waitFor(condFn, timeoutMs = 4000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condFn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

const results = [];
const mockWs = createMockUpbitWsServer();

try {
  await new Promise((resolve) => mockWs.server.listen(0, "127.0.0.1", resolve));
  const port = mockWs.server.address().port;
  const mockUrl = `ws://127.0.0.1:${port}/websocket/v1`;

  const { UpbitWsHub } = await import("../backend/common/upbit_ws_hub.mjs");
  const {
    initializeDatabase,
    getDb,
    triggerTickReactiveSmartExit,
    upbitWsHub,
    fetchUpbitTickersMap,
  } = await import("../backend/node_server.mjs");

  await initializeDatabase();
  const db = getDb();

  // 1. Live Ticker & Orderbook Streaming via Mock WS
  const hub = new UpbitWsHub({
    wsUrl: mockUrl,
    staleThresholdMs: 5000,
    heartbeatIntervalMs: 60000,
    backoffScheduleMs: [150, 300, 600],
  });

  let tickCallbackEvents = [];
  hub.onTickerTick((ev) => tickCallbackEvents.push(ev));
  hub.start(["KRW-BTC", "KRW-ETH"], { allowInLibraryMode: true });

  const opened = await waitFor(() => hub.isConnected() && mockWs.receivedSubs.length > 0, 3000);
  assert.equal(opened, true, "UpbitWsHub must connect and send subscription payload");

  const parsedSub = JSON.parse(mockWs.receivedSubs[0]);
  assert.ok(Array.isArray(parsedSub), "Subscription payload must be an array");
  assert.ok(parsedSub.some((x) => x.type === "ticker" && x.codes.includes("KRW-BTC")), "Must subscribe ticker KRW-BTC");
  assert.ok(parsedSub.some((x) => x.type === "orderbook" && x.codes.includes("KRW-BTC")), "Must subscribe orderbook KRW-BTC");

  mockWs.broadcastJson({
    type: "ticker",
    code: "KRW-BTC",
    trade_price: 100500000,
    opening_price: 100000000,
    high_price: 101000000,
    low_price: 99500000,
    acc_trade_price_24h: 350000000000,
    timestamp: Date.now(),
  });
  mockWs.broadcastJson({
    type: "orderbook",
    code: "KRW-BTC",
    total_ask_size: 10.5,
    total_bid_size: 18.2,
    orderbook_units: [{ ask_price: 100510000, bid_price: 100500000, ask_size: 2.1, bid_size: 3.4 }],
    timestamp: Date.now(),
  });

  const gotData = await waitFor(() => Boolean(hub.getLatestTicker("KRW-BTC") && hub.getLatestOrderbook("KRW-BTC")), 2000);
  assert.equal(gotData, true, "Hub must ingest real-time ticker & orderbook frames");
  assert.equal(hub.getLatestTicker("KRW-BTC").trade_price, 100500000);
  assert.equal(hub.getLatestOrderbook("KRW-BTC").orderbook_units[0].bid_price, 100500000);
  assert.equal(hub.getWsHealth().transport_mode, "WS");
  assert.equal(hub.isStale(), false);
  assert.ok(tickCallbackEvents.length >= 1, "onTickerTick listener must receive tick event");
  results.push({ check: "Mock WS Stream & Cache", status: "PASS", detail: "ticker=100,500,000 / bid=100,500,000 / WS mode" });

  // 2. Disconnect -> Exponential Backoff Automatic Reconnect
  mockWs.dropAllClients();
  const reconnected = await waitFor(() => mockWs.getConnectionCount() >= 2 && hub.isConnected(), 3000);
  assert.equal(reconnected, true, "Hub must automatically reconnect after socket drop");
  assert.ok(hub.getWsHealth().reconnect_count >= 1, "reconnect_count must increment");
  results.push({
    check: "Exponential Backoff Reconnect",
    status: "PASS",
    detail: `connections=${mockWs.getConnectionCount()}, reconnect_count=${hub.getWsHealth().reconnect_count}`,
  });

  // 3. Stale (> 5,000ms) -> REST Fallback Health Status
  const futureHealth = hub.getWsHealth(Date.now() + 6500);
  assert.equal(futureHealth.is_stale, true, "Health must mark stale when > 5000ms elapsed");
  assert.equal(futureHealth.transport_mode, "REST", "Stale WS must switch transport_mode to REST");
  assert.equal(futureHealth.fallback_mode, "REST");
  hub.stop();
  results.push({ check: "Stale >5s REST Fallback", status: "PASS", detail: "transport_mode=REST, fallback_mode=REST" });

  // 4. Shared upbitWsHub cache integration with fetchUpbitTickersMap (zero REST call needed when fresh)
  upbitWsHub.connected = true;
  upbitWsHub.lastMessageAtMs = Date.now();
  upbitWsHub._handleIncomingPayload({
    type: "ticker",
    code: "KRW-ETH",
    trade_price: 4200000,
    acc_trade_price_24h: 120000000000,
    timestamp: Date.now(),
  });
  const mapFromWs = await fetchUpbitTickersMap(["KRW-ETH"]);
  assert.equal(mapFromWs.get("KRW-ETH")?.trade_price, 4200000, "fetchUpbitTickersMap must serve fresh WS cache without REST");
  upbitWsHub.stop();
  results.push({ check: "WS-to-TickersCache Integration", status: "PASS", detail: "KRW-ETH served directly from WS cache" });

  // 5. Tick-Reactive Smart Exit (Immediate Stop-Loss & 1,500ms Debounce)
  const nowStr = new Date(Date.now() + 9 * 3600000).toISOString().replace("T", " ").slice(0, 19);
  await db
    .prepare(
      "UPDATE bots SET is_selected_for_live = 1, is_running = 1, allocation_ratio = 100, allocated_capital = 100000, virtual_krw = 50000, stop_loss_pct = 2.5, take_profit_pct = 5.0 WHERE bot_id = 'bot_01'"
    )
    .run();
  const trInfo = await db
    .prepare(
      `INSERT INTO trades (bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status)
       VALUES ('bot_01', 'KRW-BTC', 'ws-tick-uuid-1', 100000000, '0.0005', 50000, ?, 'HOLDING')`
    )
    .run(nowStr);
  await db
    .prepare(
      `INSERT INTO bot_positions (bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at)
       VALUES ('bot_01', 'KRW-BTC', 'KRW-BTC', 'ws-tick-uuid-1', '0.0005', 100000000, 50000, 25, ?, 'OPEN', ?)`
    )
    .run(trInfo.lastInsertRowid, nowStr);

  // Normal tick (+0.2%): should NOT sell, but arms debounce timer
  const holdRes = await triggerTickReactiveSmartExit({
    market: "KRW-BTC",
    price: 100200000,
    skipUpbitApi: true,
    bypassDebounce: true,
  });
  assert.equal(holdRes.triggered, false, "Normal +0.2% tick must not sell");

  // Immediate follow-up tick within 1,500ms WITHOUT bypassDebounce -> must be debounced
  const debouncedRes = await triggerTickReactiveSmartExit({
    market: "KRW-BTC",
    price: 94000000,
    skipUpbitApi: true,
  });
  assert.equal(debouncedRes.reason, "DEBOUNCED", "Rapid duplicate tick inside 1,500ms must be debounced");

  // Crash tick (-5.0% below -2.5% stop loss) after debounce -> immediate smart exit!
  const exitRes = await triggerTickReactiveSmartExit({
    market: "KRW-BTC",
    price: 95000000,
    skipUpbitApi: true,
    bypassDebounce: true,
  });
  assert.equal(exitRes.triggered, true, "Crash tick (-5.0%) must trigger immediate stop-loss sell");
  assert.equal(exitRes.sold_count, 1);

  const posAfter = await db.prepare("SELECT status FROM bot_positions WHERE order_uuid = 'ws-tick-uuid-1'").get();
  const trAfter = await db.prepare("SELECT status, sell_price FROM trades WHERE buy_order_uuid = 'ws-tick-uuid-1'").get();
  assert.equal(posAfter.status, "CLOSED", "Position must be CLOSED immediately after tick exit");
  assert.equal(trAfter.status, "COMPLETED", "Trade must be COMPLETED immediately after tick exit");
  assert.equal(trAfter.sell_price, 95000000);
  results.push({
    check: "Tick-Reactive Smart Exit & 1.5s Debounce",
    status: "PASS",
    detail: `Debounced inside 1.5s, closed immediately on -5% crash tick at 95,000,000`,
  });

  console.log("\n=== [Prompt 1] Upbit WebSocket Hub & Tick-Reactive Smart Exit Verification ===");
  console.table(results);
} finally {
  mockWs.dropAllClients();
  await new Promise((r) => mockWs.server.close(r));
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}
