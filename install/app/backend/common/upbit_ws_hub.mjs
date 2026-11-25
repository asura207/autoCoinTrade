/**
 * [Antigravity-Doc]
 * 파일 역할: 업비트 공식 WebSocket(`wss://api.upbit.com/websocket/v1`) 실시간 시세·호가·체결 스트림 멀티플렉서 허브
 * 아키텍처:
 * - `EventEmitter`를 상속한 `UpbitWsHub` 클래스가 단일 WebSocket 연결로 `ticker`, `orderbook`, `trade` 스트림을 동시 구독하고 최신 스냅샷을 인메모리 `Map`에 유지합니다.
 * - `DEFAULT_STALE_THRESHOLD_MS`(5초) 이상 메시지가 수신되지 않거나 연결이 끊어지면 `isStale() === true`가 되며, 캐시 조회 메서드는 `null`을 반환해 상위 엔진이 REST API 폴백으로 자동 전환하도록 유도합니다.
 * - 지수 백오프 재연결(1s~30s)과 60초 `PING` 하트비트를 타이머 `unref()`와 함께 운영해 프로세스 종료를 방해하지 않습니다.
 * 주요 의존성: `node:events`, Node.js 전역 `globalThis.WebSocket`
 * 수정 시 주의사항:
 * - 업비트 WebSocket 구독 종목 수는 안전상 최대 45개(`slice(0, 45)`)로 제한됩니다.
 * - 테스트/라이브러리 모드(`AUTOCOIN_LIBRARY_MODE === "1"`)에서는 `allowInLibraryMode: true`가 없는 한 외부 소켓 연결을 열지 않습니다.
 */
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

// [Antigravity-Doc] 기본 업비트 WS 엔드포인트, 스테일 판정 임계값(5초), 하트비트 주기(60초), 지수 백오프 재연결 스케줄(ms)
export const DEFAULT_UPBIT_WS_URL = "wss://api.upbit.com/websocket/v1";
export const DEFAULT_STALE_THRESHOLD_MS = 5000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
export const DEFAULT_BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * [Antigravity-Doc]
 * 역할: 업비트 실시간 WebSocket 연결, 구독 갱신, 스냅샷 캐싱, 헬스체크 및 틱 이벤트 브로드캐스트를 총괄하는 허브 클래스
 * 발행 이벤트: `"open"`, `"close"`, `"ws_error"`, `"orderbook"`, `"tick"`
 */
export class UpbitWsHub extends EventEmitter {
  /**
   * [Antigravity-Doc]
   * 역할: WebSocket 허브 설정, 연결 상태 변수, 초기 구독 마켓 목록 및 인메모리 스냅샷 맵을 초기화합니다.
   * 매개변수:
   * - options {object} [{}]: `{ wsUrl, staleThresholdMs, heartbeatIntervalMs, backoffDelaysMs, backoffScheduleMs, allowInLibraryMode, initialMarkets }`
   */
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || process.env.UPBIT_WS_URL || DEFAULT_UPBIT_WS_URL;
    this.staleThresholdMs = Number(options.staleThresholdMs || DEFAULT_STALE_THRESHOLD_MS);
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
    // [Antigravity-Doc] backoffDelaysMs / backoffScheduleMs 두 옵션명을 모두 수용해 커스텀 재연결 지연 스케줄 설정
    const customBackoff = Array.isArray(options.backoffDelaysMs) && options.backoffDelaysMs.length > 0
      ? options.backoffDelaysMs
      : Array.isArray(options.backoffScheduleMs) && options.backoffScheduleMs.length > 0
      ? options.backoffScheduleMs
      : null;
    this.backoffDelaysMs = customBackoff || DEFAULT_BACKOFF_DELAYS_MS;
    this.allowInLibraryMode = Boolean(options.allowInLibraryMode);

    // [Antigravity-Doc] 소켓 생명주기 및 재연결/하트비트 타이머 상태 변수
    this.ws = null;
    this.connected = false;
    this.stopped = true;
    this.reconnectAttempt = 0;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;

    // [Antigravity-Doc] 연결 지연/헬스 모니터링 지표
    this.lastConnectedAtMs = 0;
    this.lastMessageAtMs = 0;
    this.lastLatencyMs = 0;
    this.lastError = "";

    // [Antigravity-Doc] 기본 구독 대상 KRW 마켓 10종 (대문자 정규화 및 KRW- 접두사 필터링)
    this.subscribedMarkets = new Set(
      (options.initialMarkets || [
        "KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE",
        "KRW-SUI", "KRW-AVAX", "KRW-SHIB", "KRW-ADA", "KRW-NEAR",
      ])
        .map((m) => String(m || "").trim().toUpperCase())
        .filter((m) => m.startsWith("KRW-"))
    );

    // [Antigravity-Doc] 마켓별 최신 시세·호가·체결 스냅샷 및 직전 통지 가격/틱 콜백 레지스트리
    this.tickerMap = new Map();
    this.orderbookMap = new Map();
    this.tradeMap = new Map();
    this.lastNotifiedPriceMap = new Map();
    this.tickHandlers = new Set();
  }

  /**
   * [Antigravity-Doc]
   * 역할: WebSocket 허브를 기동하고 업비트 서버로의 연결을 시작합니다.
   * 매개변수:
   * - firstArg {string[]|object} [{}]: 초기 구독 마켓 배열 또는 옵션 객체
   * - secondArg {object} [{}]: `firstArg`가 배열일 때 추가 옵션 객체 (`{ wsUrl, allowInLibraryMode }`)
   * 반환값: {boolean} 실제 연결 시도를 시작했으면 `true`, 라이브러리 모드 가드로 스킵되었으면 `false`
   */
  start(firstArg = {}, secondArg = {}) {
    let options = firstArg && !Array.isArray(firstArg) && typeof firstArg === "object" ? firstArg : secondArg || {};
    // [Antigravity-Doc] 첫 인자로 마켓 배열이 전달된 경우 최대 45개까지 구독 목록 덮어쓰기
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
    // [Antigravity-Doc] 단위 테스트/라이브러리 임포트 시 실네트워크 연결을 방지하는 안전 가드
    if (process.env.AUTOCOIN_LIBRARY_MODE === "1" && !this.allowInLibraryMode) {
      return false;
    }
    this.stopped = false;
    this._connect();
    return true;
  }

  /**
   * [Antigravity-Doc]
   * 역할: 재연결·하트비트 타이머를 모두 해제하고 활성 WebSocket 연결을 정상 종료합니다.
   * 매개변수: 없음
   * 반환값: 없음 (void)
   */
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

  /**
   * [Antigravity-Doc]
   * 역할: 구독 마켓 목록을 갱신하고, 변경 사항이 있으며 소켓이 열려 있는 경우 즉시 업비트에 구독 페이로드를 재전송합니다.
   * 매개변수:
   * - markets {string[]} [[]]: 신규 구독할 마켓 코드 배열 (최대 45개, `KRW-`만 허용)
   * 반환값: {boolean} 구독 목록이 실제로 변경되었으면 `true`, 아니면 `false`
   */
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
    // [Antigravity-Doc] 신규 마켓 추가 또는 전체 개수 변동이 있을 때만 구독 집합 갱신 및 페이로드 송신
    if (changed || normalized.length !== this.subscribedMarkets.size) {
      this.subscribedMarkets = new Set(normalized.slice(0, 45));
      if (this.connected && this.ws) {
        this._sendSubscriptionPayload();
      }
      return true;
    }
    return false;
  }

  /**
   * [Antigravity-Doc]
   * 역할: 실시간 시세/체결 틱 수신 시 호출될 콜백 핸들러를 등록하고, 해제(unsubscribe) 함수를 반환합니다.
   * 매개변수:
   * - handler {Function}: `(tickEvent) => void` 콜백
   * 반환값: {Function} 등록된 핸들러를 제거하는 cleanup 함수
   */
  onTickerTick(handler) {
    if (typeof handler === "function") {
      this.tickHandlers.add(handler);
    }
    return () => this.tickHandlers.delete(handler);
  }

  /**
   * [Antigravity-Doc]
   * 역할: WebSocket 스트림이 끊겼거나 마지막 메시지 수신 후 `staleThresholdMs`를 초과해 신선도를 잃었는지 판정합니다.
   * 매개변수:
   * - nowMs {number} [Date.now()]: 기준 시각(밀리초)
   * 반환값: {boolean} 스트림이 스테일(REST 폴백 필요) 상태이면 `true`
   */
  isStale(nowMs = Date.now()) {
    if (!this.connected || this.lastMessageAtMs <= 0) return true;
    return nowMs - this.lastMessageAtMs > this.staleThresholdMs;
  }

  /**
   * [Antigravity-Doc]
   * 역할: 특정 마켓의 최신 티커 스냅샷을 반환합니다. 스트림이 스테일 상태이면 `null`을 반환해 REST 폴백을 유도합니다.
   * 매개변수:
   * - market {string}: 조회할 마켓 코드 (예: `"KRW-BTC"`)
   * 반환값: {object|null} 정규화된 티커 객체 또는 `null`
   */
  getLatestTicker(market) {
    const m = String(market || "").trim().toUpperCase();
    if (this.isStale()) return null;
    return this.tickerMap.get(m) || null;
  }

  /**
   * [Antigravity-Doc]
   * 역할: 요청된 마켓 목록(또는 전체 구독 마켓)의 최신 티커 맵 복사본을 반환합니다.
   * 매개변수:
   * - markets {string[]} [[]]: 필터링할 마켓 코드 배열 (비어 있으면 전체 `tickerMap` 복사본 반환)
   * 반환값: {Map<string, object>|null} 티커 맵 또는 스테일/조회 결과 없음 시 `null`
   */
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

  /**
   * [Antigravity-Doc]
   * 역할: 특정 마켓의 최신 호가창 스냅샷을 반환합니다. 스트림이 스테일 상태이면 `null`을 반환합니다.
   * 매개변수:
   * - market {string}: 조회할 마켓 코드
   * 반환값: {object|null} 정규화된 호가 객체 또는 `null`
   */
  getLatestOrderbook(market) {
    const m = String(market || "").trim().toUpperCase();
    if (this.isStale()) return null;
    return this.orderbookMap.get(m) || null;
  }

  /**
   * [Antigravity-Doc]
   * 역할: 현재 소켓의 물리적 열림(`connected`) 상태를 반환합니다.
   * 매개변수: 없음
   * 반환값: {boolean}
   */
  isConnected() {
    return Boolean(this.connected);
  }

  /**
   * [Antigravity-Doc]
   * 역할: 대시보드 모니터링 및 REST 폴백 판단에 사용하는 WebSocket 헬스 진단 스냅샷을 생성합니다.
   * 매개변수:
   * - nowMs {number} [Date.now()]: 기준 시각(밀리초)
   * 반환값: {object} 연결 상태, 스테일 여부, 전송 모드(`WS`|`REST`), 지연시간(ms), 캐시 건수, 재연결 횟수 등
   */
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

  /**
   * [Antigravity-Doc]
   * 역할: 새 WebSocket 인스턴스를 생성하고 `open`, `message`, `error`, `close` 이벤트 리스너를 바인딩합니다.
   * 매개변수: 없음
   * 반환값: 없음 (void)
   * 부수효과/예외 처리: 생성 실패 또는 예기치 않은 `close` 시 `stopped === false`이면 지수 백오프 재연결을 예약합니다.
   */
  _connect() {
    if (this.stopped) return;
    // [Antigravity-Doc] 기존 소켓이 남아 있으면 정리 후 새 연결 수립
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

    // [Antigravity-Doc] 연결 성공 시 백오프 카운터 초기화, 구독 요청 전송 및 60초 하트비트 가동
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

    // [Antigravity-Doc] 바이너리/텍스트 프레임 디코딩 후 PONG/UP 응답은 시각만 갱신하고 JSON 시세 페이로드 처리
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

    // [Antigravity-Doc] 소켓 오류 기록 및 ws_error 이벤트 전파
    socket.addEventListener("error", (event) => {
      this.lastError = event?.message || event?.error?.message || "WebSocket connection error";
      this.emit("ws_error", this.lastError);
    });

    // [Antigravity-Doc] 연결 종료 시 하트비트 정지 및 의도적 stop()이 아닌 경우 자동 재연결 스케줄링
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

  /**
   * [Antigravity-Doc]
   * 역할: 업비트 WebSocket이 전송하는 다양한 프레임 데이터 타입(string, Buffer, ArrayBuffer, TypedArray, Blob)을 UTF-8 문자열로 디코딩합니다.
   * 매개변수:
   * - data {any}: `MessageEvent.data` 원시 프레임 데이터
   * 반환값: {Promise<string>} UTF-8 문자열
   */
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

  /**
   * [Antigravity-Doc]
   * 역할: 현재 `subscribedMarkets` 집합에 대해 `ticker`, `orderbook`, `trade` 구독 JSON 페이로드를 업비트로 전송합니다.
   * 매개변수: 없음
   * 반환값: 없음 (void)
   */
  _sendSubscriptionPayload() {
    if (!this.ws || !this.connected) return;
    const codes = Array.from(this.subscribedMarkets);
    if (codes.length === 0) return;
    // [Antigravity-Doc] ticker/orderbook은 초기 스냅샷 포함(isOnlyRealtime: false), trade는 실시간 체결만 구독
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

  /**
   * [Antigravity-Doc]
   * 역할: 업비트 120초 유휴 연결 종료 정책에 대응하기 위해 주기적(기본 60초)으로 `"PING"` 프레임을 송신합니다.
   * 매개변수: 없음
   * 반환값: 없음 (void)
   */
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
    // [Antigravity-Doc] 프로세스 자연 종료를 막지 않도록 타이머 unref 적용
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * [Antigravity-Doc]
   * 역할: `backoffDelaysMs` 스케줄에 따라 다음 재연결 시도를 예약합니다.
   * 매개변수: 없음
   * 반환값: 없음 (void)
   */
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

  /**
   * [Antigravity-Doc]
   * 역할: 업비트 WebSocket JSON 페이로드(일반 포맷 및 SIMPLE 축약 키 `ty/cd/tp` 모두 호환)를 파싱해 내부 스냅샷 맵을 갱신하고 이벤트를 전파합니다.
   * 매개변수:
   * - msg {object}: 파싱된 JSON 메시지 객체
   * 반환값: 없음 (void)
   */
  _handleIncomingPayload(msg) {
    if (!msg || typeof msg !== "object") return;
    const nowMs = Date.now();
    this.lastMessageAtMs = nowMs;

    const msgType = String(msg.type || msg.ty || "").toLowerCase();
    const market = String(msg.code || msg.cd || msg.market || "").trim().toUpperCase();
    if (!market.startsWith("KRW-")) return;

    // [Antigravity-Doc] 거래소 타임스탬프와 로컬 시각 차이로 네트워크 지연(ms) 추정 (시계 오차 방어를 위해 1~5000ms 클램핑)
    const exchangeTs = Number(msg.timestamp || msg.tms || msg.trade_timestamp || 0);
    if (exchangeTs > 0 && exchangeTs <= nowMs + 5000) {
      this.lastLatencyMs = Math.max(1, Math.min(5000, nowMs - exchangeTs));
    } else if (this.lastLatencyMs <= 0) {
      this.lastLatencyMs = 8;
    }

    if (msgType === "ticker") {
      // [Antigravity-Doc] ticker 메시지 정규화 및 tickerMap 갱신 후 틱 리스너 브로드캐스트
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
        is_partial_trade_only: false,
        timestamp: exchangeTs || nowMs,
        updated_at_ms: nowMs,
      };
      this.tickerMap.set(market, normalized);
      this._notifyTickListeners(market, price, normalized);
    } else if (msgType === "orderbook") {
      // [Antigravity-Doc] orderbook 메시지 정규화 (유효 호가만 필터링) 및 orderbook 이벤트 발행
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
      // [Antigravity-Doc] 실시간 trade 체결 틱 반영: 기존 ticker의 현재가/고가/저가를 즉시 업데이트하거나 부분 스냅샷 생성
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
          is_partial_trade_only: true,
          timestamp: exchangeTs || nowMs,
          updated_at_ms: nowMs,
        });
      }
      this._notifyTickListeners(market, price, this.tickerMap.get(market));
    }
  }

  /**
   * [Antigravity-Doc]
   * 역할: 직전 통지가 대비 변동률(`move_pct`) 및 급변 여부(`is_rapid_move`, ±0.8% 이상)를 계산해 `tick` 이벤트와 등록된 핸들러들에 전파합니다.
   * 매개변수:
   * - market {string}: 마켓 코드
   * - price {number}: 최신 체결가
   * - tickerObj {object}: 최신 티커 스냅샷 객체
   * 반환값: 없음 (void)
   * 부수효과/예외 처리: 개별 `tickHandlers` 실행 중 발생한 예외는 격리·로깅하여 다른 리스너 및 스트림 처리를 보호합니다.
   */
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
      } catch (tickHandlerErr) {
        this.lastError = `Tick handler error: ${tickHandlerErr?.message || tickHandlerErr}`;
        console.warn("[UpbitWsHub] Tick handler error:", tickHandlerErr?.message || tickHandlerErr);
      }
    }
  }
}

// [Antigravity-Doc] 백엔드 전역에서 공유하는 업비트 WebSocket 허브 싱글톤 인스턴스
export const upbitWsHub = new UpbitWsHub();