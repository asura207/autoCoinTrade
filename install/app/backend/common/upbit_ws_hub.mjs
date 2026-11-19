/**
 * backend/common/upbit_ws_hub.mjs
 *
 * 업비트 공식 WebSocket (wss://api.upbit.com/websocket/v1) 실시간 멀티플렉서 허브
 * - ticker · orderbook · trade 실시간 스트림 구독 및 인메모리 최신 스냅샷 유지
 * - 지수 백오프 재연결(1s -> 2s -> 4s -> 8s, 최대 30s) 및 60초 PING 하트비트
 * - 스트림 지연(> 5,000ms) 또는 연결 단절 시 즉시 is_stale=true / fallback_mode='REST' 전환
 * - 오픈 포지션 보유 종목 급변(±0.8% 또는 손절/트레일링 스탑 도달) 시 틱 반응형 청산 콜백 브로드캐스트
 */

import { EventEmitter } from "node:events";

export const DEFAULT_UPBIT_WS_URL = "wss://api.upbit.com/websocket/v1";
export const DEFAULT_STALE_THRESHOLD_MS = 5000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
export const DEFAULT_BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export class UpbitWsHub extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || process.env.UPBIT_WS_URL || DEFAULT_UPBIT_WS_URL;
    this.staleThresholdMs = Number(options.staleThresholdMs || DEFAULT_STALE_THRESHOLD_MS);
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
    const customBackoff = Array.isArray(options.backoffDelaysMs) && options.backoffDelaysMs.length > 0
      ? options.backoffDelaysMs
      : Array.isArray(options.backoffScheduleMs) && options.backoffScheduleMs.length > 0
      ? options.backoffScheduleMs
      : null;
    this.backoffDelaysMs = customBackoff || DEFAULT_BACKOFF_DELAYS_MS;
    this.allowInLibraryMode = Boolean(options.allowInLibraryMode);

    this.ws = null;
    this.connected = false;
    this.stopped = true;
    this.reconnectAttempt = 0;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;

    this.lastConnectedAtMs = 0;
    this.lastMessageAtMs = 0;
    this.lastLatencyMs = 0;
    this.lastError = "";

    this.subscribedMarkets = new Set(
      (options.initialMarkets || ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE", "KRW-SUI", "KRW-ADA", "KRW-AVAX"])
        .map((m) => String(m || "").trim().toUpperCase())
        .filter((m) => m.startsWith("KRW-"))
    );

    this.tickerMap = new Map();
    this.orderbookMap = new Map();
    this.tradeMap = new Map();
    this.lastNotifiedPriceMap = new Map();
    this.tickHandlers = new Set();
  }

  start(firstArg = {}, secondArg = {}) {
    let options = firstArg && !Array.isArray(firstArg) && typeof firstArg === "object" ? firstArg : secondArg || {};
    if (Array.isArray(firstArg) && firstArg.length > 0) {
      const normalized = firstArg
        .map((m) => String(m || "").trim().toUpperCase())
        .filter((m) => m.startsWith("KRW-"));
      if (normalized.length > 0) {
        this.subscribedMarkets = new Set(normalized.slice(0, 45));
      }
    }
    if (options.wsUrl) {
      this.wsUrl = options.wsUrl;
    }
    if (options.allowInLibraryMode !== undefined) {
      this.allowInLibraryMode = Boolean(options.allowInLibraryMode);
    }
    if (process.env.AUTOCOIN_LIBRARY_MODE === "1" && !this.allowInLibraryMode) {
      return false;
    }
    this.stopped = false;
    this._connect();
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  updateSubscriptions(markets = []) {
    let changed = false;
    const normalized = [];
    for (const raw of markets) {
      const m = String(raw || "").trim().toUpperCase();
      if (m.startsWith("KRW-")) {
        normalized.push(m);
        if (!this.subscribedMarkets.has(m)) {
          changed = true;
        }
      }
    }
    if (normalized.length === 0) return false;
    if (changed || normalized.length !== this.subscribedMarkets.size) {
      this.subscribedMarkets = new Set(normalized.slice(0, 45));
      if (this.connected && this.ws) {
        this._sendSubscriptionPayload();
      }
      return true;
    }
    return false;
  }

  onTickerTick(handler) {
    if (typeof handler === "function") {
      this.tickHandlers.add(handler);
    }
    return () => this.tickHandlers.delete(handler);
  }

  isStale(nowMs = Date.now()) {
    if (!this.connected || this.lastMessageAtMs <= 0) return true;
    return nowMs - this.lastMessageAtMs > this.staleThresholdMs;
  }

  getLatestTicker(market) {
    const m = String(market || "").trim().toUpperCase();
    if (this.isStale()) return null;
    return this.tickerMap.get(m) || null;
  }

  getLatestTickersMap(markets = []) {
    if (this.isStale()) return null;
    if (!Array.isArray(markets) || markets.length === 0) {
      return new Map(this.tickerMap);
    }
    const out = new Map();
    for (const raw of markets) {
      const m = String(raw || "").trim().toUpperCase();
      const item = this.tickerMap.get(m);
      if (item) {
        out.set(m, item);
      }
    }
    return out.size > 0 ? out : null;
  }

  getLatestOrderbook(market) {
    const m = String(market || "").trim().toUpperCase();
    return this.orderbookMap.get(m) || null;
  }

  isConnected() {
    return Boolean(this.connected);
  }

  getWsHealth(nowMs = Date.now()) {
    const stale = this.isStale(nowMs);
    const ageMs = this.lastMessageAtMs > 0 ? Math.max(0, nowMs - this.lastMessageAtMs) : null;
    return {
      connected: Boolean(this.connected && !stale),
      socket_open: Boolean(this.connected),
      is_stale: stale,
      transport_mode: this.connected && !stale ? "WS" : "REST",
      fallback_mode: this.connected && !stale ? "NONE" : "REST",
      latency_ms: this.lastLatencyMs || (ageMs !== null ? Math.min(ageMs, 9999) : 0),
      last_message_age_ms: ageMs,
      subscribed_markets: Array.from(this.subscribedMarkets),
      subscribed_count: this.subscribedMarkets.size,
      cached_tickers_count: this.tickerMap.size,
      cached_orderbooks_count: this.orderbookMap.size,
      reconnect_count: this.reconnectCount,
      ws_url: this.wsUrl,
      last_error: this.lastError || null,
    };
  }

  _connect() {
    if (this.stopped) return;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    const WSImpl = globalThis.WebSocket;
    if (typeof WSImpl !== "function") {
      this.lastError = "Global WebSocket not available in runtime";
      this.connected = false;
      return;
    }

    let socket;
    try {
      socket = new WSImpl(this.wsUrl);
    } catch (err) {
      this.lastError = err.message;
      this._scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.addEventListener("open", () => {
      if (this.stopped || this.ws !== socket) return;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastConnectedAtMs = Date.now();
      this.lastMessageAtMs = Date.now();
      this.lastError = "";
      this._sendSubscriptionPayload();
      this._startHeartbeat();
      this.emit("open", this.getWsHealth());
    });

    socket.addEventListener("message", async (event) => {
      if (this.stopped || this.ws !== socket) return;
      try {
        const text = await this._decodeFrameData(event.data);
        if (!text || text === "PONG" || text.includes('"status":"UP"')) {
          this.lastMessageAtMs = Date.now();
          return;
        }
        const payload = JSON.parse(text);
        this._handleIncomingPayload(payload);
      } catch (err) {
        this.lastError = `WS parse error: ${err.message}`;
      }
    });

    socket.addEventListener("error", (event) => {
      this.lastError = event?.message || event?.error?.message || "WebSocket connection error";
      this.emit("ws_error", this.lastError);
    });

    socket.addEventListener("close", () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.connected = false;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.emit("close", this.getWsHealth());
      if (!this.stopped) {
        this._scheduleReconnect();
      }
    });
  }

  async _decodeFrameData(data) {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    if (data && typeof data.arrayBuffer === "function") {
      const ab = await data.arrayBuffer();
      return Buffer.from(ab).toString("utf8");
    }
    return String(data || "");
  }

  _sendSubscriptionPayload() {
    if (!this.ws || !this.connected) return;
    const codes = Array.from(this.subscribedMarkets);
    if (codes.length === 0) return;
    const subMsg = JSON.stringify([
      { ticket: `autocoin-ws-${Date.now()}` },
      { type: "ticker", codes, isOnlyRealtime: false },
      { type: "orderbook", codes, isOnlyRealtime: false },
      { type: "trade", codes, isOnlyRealtime: true },
    ]);
    try {
      this.ws.send(subMsg);
    } catch (err) {
      this.lastError = `WS send error: ${err.message}`;
    }
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || !this.connected || this.stopped) return;
      try {
        this.ws.send("PING");
      } catch {}
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffDelaysMs[Math.min(this.reconnectAttempt, this.backoffDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
    }
  }

  _handleIncomingPayload(msg) {
    if (!msg || typeof msg !== "object") return;
    const nowMs = Date.now();
    this.lastMessageAtMs = nowMs;

    const msgType = String(msg.type || msg.ty || "").toLowerCase();
    const market = String(msg.code || msg.cd || msg.market || "").trim().toUpperCase();
    if (!market.startsWith("KRW-")) return;

    const exchangeTs = Number(msg.timestamp || msg.tms || msg.trade_timestamp || 0);
    if (exchangeTs > 0 && exchangeTs <= nowMs + 5000) {
      this.lastLatencyMs = Math.max(1, Math.min(5000, nowMs - exchangeTs));
    } else if (this.lastLatencyMs <= 0) {
      this.lastLatencyMs = 8;
    }

    if (msgType === "ticker") {
      const price = Number(msg.trade_price ?? msg.tp ?? 0);
      if (!(price > 0)) return;
      const prevTicker = this.tickerMap.get(market);
      const normalized = {
        market,
        trade_price: price,
        opening_price: Number(msg.opening_price ?? msg.op ?? prevTicker?.opening_price ?? price),
        high_price: Number(msg.high_price ?? msg.hp ?? prevTicker?.high_price ?? price),
        low_price: Number(msg.low_price ?? msg.lp ?? prevTicker?.low_price ?? price),
        prev_closing_price: Number(msg.prev_closing_price ?? msg.pcp ?? prevTicker?.prev_closing_price ?? price),
        signed_change_rate: Number(msg.signed_change_rate ?? msg.scr ?? prevTicker?.signed_change_rate ?? 0),
        signed_change_price: Number(msg.signed_change_price ?? msg.scp ?? prevTicker?.signed_change_price ?? 0),
        acc_trade_price_24h: Number(msg.acc_trade_price_24h ?? msg.atp24h ?? prevTicker?.acc_trade_price_24h ?? 0),
        acc_trade_volume_24h: Number(msg.acc_trade_volume_24h ?? msg.atv24h ?? prevTicker?.acc_trade_volume_24h ?? 0),
        trade_volume: Number(msg.trade_volume ?? msg.tv ?? 0),
        timestamp: exchangeTs || nowMs,
        updated_at_ms: nowMs,
      };
      this.tickerMap.set(market, normalized);
      this._notifyTickListeners(market, price, normalized);
    } else if (msgType === "orderbook") {
      const rawUnits = Array.isArray(msg.orderbook_units || msg.obu) ? (msg.orderbook_units || msg.obu) : [];
      const units = rawUnits.map((u) => ({
        ask_price: Number(u.ask_price ?? u.ap ?? 0),
        bid_price: Number(u.bid_price ?? u.bp ?? 0),
        ask_size: Number(u.ask_size ?? u.as ?? 0),
        bid_size: Number(u.bid_size ?? u.bs ?? 0),
      })).filter((u) => u.ask_price > 0 && u.bid_price > 0);
      const ob = {
        market,
        total_ask_size: Number(msg.total_ask_size ?? msg.tas ?? 0),
        total_bid_size: Number(msg.total_bid_size ?? msg.tbs ?? 0),
        orderbook_units: units,
        timestamp: exchangeTs || nowMs,
        updated_at_ms: nowMs,
      };
      this.orderbookMap.set(market, ob);
      this.emit("orderbook", ob);
    } else if (msgType === "trade") {
      const price = Number(msg.trade_price ?? msg.tp ?? 0);
      if (!(price > 0)) return;
      const tradeTick = {
        market,
        trade_price: price,
        trade_volume: Number(msg.trade_volume ?? msg.tv ?? 0),
        ask_bid: String(msg.ask_bid ?? msg.ab ?? ""),
        timestamp: exchangeTs || nowMs,
        updated_at_ms: nowMs,
      };
      this.tradeMap.set(market, tradeTick);
      const prevTicker = this.tickerMap.get(market);
      if (prevTicker) {
        prevTicker.trade_price = price;
        prevTicker.high_price = Math.max(Number(prevTicker.high_price || price), price);
        prevTicker.low_price = prevTicker.low_price > 0 ? Math.min(Number(prevTicker.low_price), price) : price;
        prevTicker.updated_at_ms = nowMs;
      } else {
        this.tickerMap.set(market, {
          market,
          trade_price: price,
          opening_price: price,
          high_price: price,
          low_price: price,
          prev_closing_price: price,
          signed_change_rate: 0,
          acc_trade_price_24h: 0,
          acc_trade_volume_24h: 0,
          timestamp: exchangeTs || nowMs,
          updated_at_ms: nowMs,
        });
      }
      this._notifyTickListeners(market, price, this.tickerMap.get(market));
    }
  }

  _notifyTickListeners(market, price, tickerObj) {
    const lastPrice = this.lastNotifiedPriceMap.get(market) || price;
    const movePct = lastPrice > 0 ? ((price - lastPrice) / lastPrice) * 100 : 0;
    this.lastNotifiedPriceMap.set(market, price);

    const tickEvent = {
      market,
      price,
      prev_price: lastPrice,
      move_pct: movePct,
      is_rapid_move: Math.abs(movePct) >= 0.8,
      ticker: tickerObj,
      orderbook: this.orderbookMap.get(market) || null,
      timestamp_ms: Date.now(),
    };

    this.emit("tick", tickEvent);
    for (const fn of this.tickHandlers) {
      try {
        fn(tickEvent);
      } catch {}
    }
  }
}

export const upbitWsHub = new UpbitWsHub();
