/**
 * [Antigravity-Doc] backend/node_server.mjs — autoCoinTrade 메인 백엔드 서버
 *
 * ■ 전체 아키텍처 개요
 *   Node.js 내장 `node:http` 기반 단일 진입점 백엔드 서버로, 업비트(Upbit) 현물 실전 자동매매,
 *   10대 전략 상시 가상 아레나(Paper Arena), 듀얼 AI(Flash/Pro + 로컬 Ollama) 장세·뉴스 분석,
 *   주간 자동 봇 로테이션 및 자본 90% 상한(Global 90% Cap) 관리, 백테스트, Web Push/알림,
 *   그리고 React SPA 정적 서빙과 REST/SSE API 라우팅을 모두 총괄한다.
 *
 * ■ 주요 섹션 목차
 *   1. 환경·경로·버전 초기화 및 KST 시간/DB 어댑터(SQLite/PostgreSQL) 유틸리티
 *   2. 10대 봇 메타데이터, 정밀도(8자리 절삭/호가 단위) 및 듀얼 AI 장세 판단 정규화·교차검증 엔진
 *   3. DB 스키마 초기화·마이그레이션(`initializeDatabase`) 및 Web Push(VAPID) 브로드캐스트
 *   4. 봇 자본 배분(`recalculateAndApplyBotAllocations`), 업비트 계좌·주문 API, 동적 자본/월별 스냅샷 동기화
 *   5. 세션 인증(HMAC 쿠키 + IP Rate Limit), CORS/JSON 헬퍼, 런타임 설정 및 Ollama/Gemini 설정 관리
 *   6. 듀얼 AI 게이트웨이(할당량 관리, 3-Tier 폴백, 시황/뉴스 분석 및 SSE 스트리밍)
 *   7. DB 쓰기 뮤텍스(`withDbWriteLock`), 실전 봇 선택(`applyLiveBotsSelection`), 주간 LLM 봇 선정 및 자동 로테이션·드레인(Drain) 정산
 *   8. HTTP 서버 및 전체 REST/SSE API 라우터(`/api/*`, `/sw.js`, SPA 정적 파일)
 *   9. 업비트 시세/캔들/호가 조회, 장세 필터(`checkMarketRegimeFilter`), 실전 매수(`executeBotBuyOrder`)·정산(`settleLiveSellOrderInDb`)·매도(`executeBotSellOrder`) 엔진
 *  10. 실전 매매 루프(`runLiveTradingBotsCycle`), 실시간 틱 반응형 스마트 청산(`triggerTickReactiveSmartExit`),
 *      상시 아레나/포지션 대사/정기 AI 스케줄러 및 워커 기동·그레이스풀 셧다운
 *
 * ■ 동시성 · 보안 · 주문 안전 핵심 규칙
 *   - DB 쓰기 직렬화: 자본 배분·로테이션·봇 교체 등 복합 쓰기는 `withDbWriteLock` 직렬 큐 + 트랜잭션(`BEGIN IMMEDIATE` / `BEGIN`)으로 보호한다.
 *   - 실전 주문 가드레일: 프로세스 리스(`acquireLiveExecutorLease`), 멱등 주문 의도(Intent) 선점·확정·환불,
 *     미확정 타임아웃 대사(`reconcileLiveOrderIntents`), 일/시간당 주문 속도 제한으로 중복·폭주 매수를 차단한다.
 *   - 90% 자본 상한 불변식: 실전 총자산 대비 최대 투입 비율(기본 90%)을 초과하지 않도록 배분·로테이션·드레인 환원 전 구간에서 검증한다.
 *   - 인증/보안: 입장 코드(Entry Code) 기반 HMAC-SHA256 서명 HttpOnly 쿠키, 타이밍 세이프 비교, IP별 실패 잠금(Rate Limit),
 *     API 키 암호화 볼트(`crypto_vault.mjs`)를 적용한다.
 *   - 라이브러리 모드: `AUTOCOIN_LIBRARY_MODE=1` 설정 시 테스트/스크립트에서 HTTP 서버·워커 자동 기동 없이 핵심 함수만 import 가능하다.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgDb } from "./common/pg_db.mjs";
import { sqliteDb } from "./common/sqlite_db.mjs";
import { pgSyncManager } from "./common/pg_sync.mjs";
import {
  syncNewsToDatabase,
  queryNewsList,
  getRecentNewsForAiAnalysis,
  getNewsSentimentStats,
} from "./common/news_service.mjs";
import { startLogRotationScheduler } from "./common/log_rotator.mjs";
import * as webpush from "web-push";
import {
  STRATEGY_GROUP_ORDER,
  STRATEGY_GROUP_META,
  ALLOCATION_MODE_WEIGHTS,
  MIN_LIVE_ORDER_SAFE_KRW,
  DEFAULT_CAPITAL_TIER_1_MAX,
  DEFAULT_CAPITAL_TIER_2_MAX,
  DEFAULT_MAX_DEPLOY_RATIO,
  isEquityTierAllocationMode,
  resolveTotalEquityAndSingle90Cap,
  getTargetBotCountByTotalEquity,
  getTargetBotCountByPrincipal,
  getCapitalTierSummary,
  assertGlobal90CapInvariant,
  selectTieredEqualChampions,
  computeRotationAllocationsWith90Cap,
  reconcileAutoSyncedBudgetsWith90Cap,
  computeDrainSellCapitalRestoration,
  ARENA_BOT_DEFS,
  ARENA_BOT_IDS,
  normalizeBotId,
  getBotStrategyMeta,
  ensureArenaSchema,
  seedArenaBots,
  evaluateStrategy,
  evaluateSmartExit,
  evaluateWeeklyStrategyChampions,
  formatKstDateTime,
  buildMarketData,
  updatePeakPrice,
  runArenaCycle,
  getArenaLeaderboard,
  getArenaTrades,
  getArenaStatus,
  resetArena,
} from "./common/algo_lab_service.mjs";
import {
  isEncryptedVaultValue,
  encryptSecret,
  decryptSecret,
  safeDecryptSecret,
  migrateConfigSecrets,
  VAULT_SECRET_FIELDS,
} from "./common/crypto_vault.mjs";
import {
  UpbitWsHub,
  upbitWsHub,
} from "./common/upbit_ws_hub.mjs";
import {
  analyzeOrderbookQuality,
  computeAtrVolatilityMultiplier,
  computeSlippageBps,
} from "./common/execution_quality_service.mjs";
import {
  loadNotificationSettings,
  saveNotificationSettings,
  maskSecretValue,
  formatNotificationMessage,
  dispatchMultiChannelNotification,
} from "./common/notification_hub.mjs";
import {
  ensureBacktestTables,
  fetchAndCacheHistoricalCandles,
  simulateBarByBarBacktest,
  runHistoricalBacktest,
  getBacktestHistory,
  buildChartTradeMarkers,
} from "./common/backtest_service.mjs";
import {
  LIVE_CYCLE_STALE_WARN_MS,
  getLiveExecutorOwner,
  getGuardrailConfig,
  ensureLiveGuardrailTables,
  acquireOrRenewLiveExecutorLease,
  releaseLiveExecutorLease,
  precheckLiveBuyPaceLimits,
  claimLiveBuyIntentAtomic,
  markLiveIntentSubmitted,
  markLiveIntentUnknownTimeout,
  refundFailedOrCanceledBuyIntentAtomic,
  confirmBuyIntentAndRecordPositionAtomic,
  claimLiveSellIntentAtomic,
  releaseFailedSellIntentAtomic,
  confirmSellIntentAtomic,
  reconcileUnknownTimeoutIntents,
  resetGuardrailEmergencyState,
  getGuardrailStatus,
  buildBuyIntentBucket,
  buildSellIntentBucket,
} from "./common/live_order_guardrail.mjs";

// [Antigravity-Doc] 경로 및 환경 변수(.env) 설정 상수
// - BASE_DIR: 프로젝트 루트 디렉터리
// - DATA_DIR / DB_PATH: SQLite DB, 세션 시크릿 등 런타임 데이터 저장 경로
// - CONFIG_PATH / ENV_PATH: 업비트 API 키·모드 설정 JSON 및 .env 파일 경로 (환경변수로 오버라이드 가능)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(BASE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "auto_coin_trade.db");
const CONFIG_PATH = process.env.AUTOCOIN_CONFIG_PATH || path.join(BASE_DIR, "config", "upbit_config.json");
const EXAMPLE_CONFIG_PATH = path.join(BASE_DIR, "config", "upbit_config.example.json");
const ENV_PATH = process.env.AUTOCOIN_ENV_PATH || path.join(BASE_DIR, ".env");
// [Antigravity-Doc] 외부 dotenv 패키지 없이 .env 파일을 직접 파싱해 미설정 process.env 항목만 채움
if (fs.existsSync(ENV_PATH)) {
  const raw = fs.readFileSync(ENV_PATH, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && (process.env[key] === undefined || process.env[key] === "")) {
        process.env[key] = val;
      }
    }
  }
}
// [Antigravity-Doc] HTTP 바인딩 호스트/포트 (기본 127.0.0.1:8001) 및 package.json 기반 앱 버전 로드
const HOST = process.env.BACKEND_HOST || "127.0.0.1";
const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 8001);

let APP_VERSION = "0.0.33";
try {
  const pkgJsonPath = path.join(BASE_DIR, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    if (pkg.version) APP_VERSION = pkg.version;
  }
} catch {}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * [Antigravity-Doc] 현재 시각을 KST(UTC+9) 'YYYY-MM-DD HH:mm:ss' 문자열로 반환한다.
 * @returns {string} KST 포맷 타임스탬프
 */
function nowKSTString() {
  return formatKstDateTime(new Date());
}

/**
 * [Antigravity-Doc] 주어진 시각을 KST(UTC+9) 기준 연/월/일/요일/시/분/초 및 날짜·타임스탬프 문자열로 분해한다.
 * @param {Date|string|number} [dateInput=new Date()] 기준 시각
 * @returns {{year:number, month:number, day:number, dayOfWeek:number, hour:number, minute:number, second:number, dateStr:string, timestampStr:string}}
 */
function getKstCalendarParts(dateInput = new Date()) {
  const ref = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const kstEpoch = new Date(ref.getTime() + 9 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const year = kstEpoch.getUTCFullYear();
  const month = kstEpoch.getUTCMonth() + 1;
  const day = kstEpoch.getUTCDate();
  const dayOfWeek = kstEpoch.getUTCDay(); // 0: Sun .. 6: Sat
  const hour = kstEpoch.getUTCHours();
  const minute = kstEpoch.getUTCMinutes();
  const second = kstEpoch.getUTCSeconds();
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const timestampStr = `${dateStr} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return { year, month, day, dayOfWeek, hour, minute, second, dateStr, timestampStr };
}

/**
 * [Antigravity-Doc] 주간 자동 로테이션의 다음 예정 실행 시각(KST 정시)을 계산한다.
 * 현재 시각이 이번 주 목표 시각을 이미 지났거나 같으면 다음 주(+7일)로 이월한다.
 * @param {number} [dayOfWeek=1] 목표 요일 (0=일 ~ 6=토, 기본 1=월요일)
 * @param {number} [hourKst=9] 목표 시각(KST 0~23시, 기본 9시)
 * @param {Date} [refDate=new Date()] 기준 시각
 * @returns {string} 'YYYY-MM-DD HH:00:00' KST 문자열
 */
function computeNextRotationKstString(dayOfWeek = 1, hourKst = 9, refDate = new Date()) {
  const targetDow = Math.max(0, Math.min(6, Math.floor(Number(dayOfWeek ?? 1))));
  const targetHour = Math.max(0, Math.min(23, Math.floor(Number(hourKst ?? 9))));
  const kstMs = refDate.getTime() + 9 * 3600 * 1000;
  const kstNow = new Date(kstMs);
  const deltaDays = (targetDow - kstNow.getUTCDay() + 7) % 7;
  const candidateMs = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate() + deltaDays,
    targetHour,
    0,
    0,
    0
  );
  const finalMs = candidateMs <= kstMs ? candidateMs + 7 * 24 * 3600 * 1000 : candidateMs;
  const c = new Date(finalMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())} ${pad(c.getUTCHours())}:00:00`;
}

/**
 * [Antigravity-Doc] `bots` 테이블의 자본·배분·선정 상태를 레거시/호환용 `bot_accounts` 테이블로 단방향 동기화한다.
 * @param {object} db 활성 DB 인스턴스
 * @returns {Promise<void>} 부수효과: `bot_accounts` UPSERT/UPDATE (테이블 미존재 시 무시)
 */
async function syncBotAccountsFromBots(db) {
  try {
    const bots = await db
      .prepare(
        "SELECT bot_id, nickname, name, allocation_ratio, allocated_capital, virtual_krw, is_selected_for_live, updated_at FROM bots"
      )
      .all();
    for (const b of bots) {
      const updAt = b.updated_at || nowKSTString();
      await db
        .prepare(
          `INSERT INTO bot_accounts (bot_id, name, allocation_ratio, allocated_capital, virtual_krw, total_realized_pnl, is_selected_for_live, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (bot_id) DO NOTHING`
        )
        .run(
          b.bot_id,
          b.nickname || b.name || b.bot_id,
          Number(b.allocation_ratio || 0),
          Math.floor(Number(b.allocated_capital || 0)),
          Math.floor(Number(b.virtual_krw || 0)),
          Number(b.is_selected_for_live || 0),
          updAt
        );
      await db
        .prepare(
          `UPDATE bot_accounts
           SET name = ?, allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, is_selected_for_live = ?, updated_at = ?
           WHERE bot_id = ?`
        )
        .run(
          b.nickname || b.name || b.bot_id,
          Number(b.allocation_ratio || 0),
          Math.floor(Number(b.allocated_capital || 0)),
          Math.floor(Number(b.virtual_krw || 0)),
          Number(b.is_selected_for_live || 0),
          updAt,
          b.bot_id
        );
    }
  } catch {
    // bot_accounts 테이블이 없는 경우 무시
  }
}

/**
 * [Antigravity-Doc] 현재 KST 날짜를 'YYYY-MM-DD' 형식으로 반환한다.
 * @returns {string}
 */
function todayDateString() {
  return nowKSTString().slice(0, 10);
}

/**
 * [Antigravity-Doc] 초기 셋업 마법사 완료 여부를 환경변수 및 `upbit_config.json` 기준으로 판별한다.
 * 미완료 시 프론트엔드가 셋업 마법사로 유도되며 일부 API만 허용된다.
 * @returns {boolean}
 */
function checkSetupCompleted() {
  if (process.env.SETUP_COMPLETED === "true") return true;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      if (cfg.setup_completed === true) return true;
      if (cfg.access_key && cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY" && cfg.access_key !== "") return true;
      if (cfg.gemini_api_key && cfg.gemini_api_key !== "YOUR_GEMINI_API_KEY_HERE" && cfg.gemini_api_key !== "") return true;
    } catch {}
  }
  if (process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_ACCESS_KEY !== "your_upbit_access_key_here" && process.env.UPBIT_ACCESS_KEY !== "") return true;
  if (process.env.ENTRY_CODE) return true;
  if (process.env.LOCATION || process.env.PGHOST || process.env.DATABASE_URL) return true;
  return false;
}

// [Antigravity-Doc] 현재 프로세스의 초기 설정 완료 상태 캐시 (셋업 완료 API 호출 시 true로 전환)
let isConfigured = checkSetupCompleted();

/**
 * [Antigravity-Doc] 환경변수(`DB_MODE`, `PG_SYNC_ENABLED`)에 따라 활성 DB 어댑터(`sqliteDb` 또는 `pgDb`)를 반환한다.
 * 기본값은 `sqliteDb`이며, `DB_MODE`가 sqlite가 아니고 `PG_SYNC_ENABLED !== 'false'`일 때 `pgDb`를 사용한다.
 * @returns {object} prepared statement 호환 DB 래퍼
 */
// 데이터베이스 인스턴스 (SQLite / PostgreSQL 동적 분기)
export function getDb() {
  const mode = (process.env.DB_MODE || "sqlite").trim().toLowerCase();
  const syncEnabled = process.env.PG_SYNC_ENABLED !== "false";
  if (mode === "sqlite" || !syncEnabled) {
    return sqliteDb;
  }
  return pgDb;
}

// [Antigravity-Doc] 10대 표준 봇 식별자 및 전략군 분류 상수
// - ALL_BOT_IDS: bot_01 ~ bot_10 전체 목록
// - TREND_BREAKOUT_BOT_IDS: 추세/돌파 전략군 (횡보·약세 방어 시 우선 BLOCK 대상)
// - MEAN_REVERSION_GRID_BOT_IDS: 역추세/그리드/눌림목 전략군 (약세·횡보 시 0.5x 방어 허용 대상)
// - LEGACY_BOT_OVERRIDE_ALIAS: 구 3봇 키(bot_vb 등)를 10봇 표준 키로 자동 마이그레이션하기 위한 매핑
const ALL_BOT_IDS = Array.from({ length: 10 }, (_, idx) => `bot_${String(idx + 1).padStart(2, "0")}`);
const TREND_BREAKOUT_BOT_IDS = new Set(["bot_01", "bot_02", "bot_03", "bot_04", "bot_07", "bot_09"]);
const MEAN_REVERSION_GRID_BOT_IDS = new Set(["bot_05", "bot_06", "bot_08", "bot_10"]);
// 실전 매매 루프 · 가상 아레나 · WebSocket 허브가 공통 감시하는 표준 10종목 유니버스
const DEFAULT_MONITORED_KRW_MARKETS = [
  "KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE",
  "KRW-SUI", "KRW-AVAX", "KRW-SHIB", "KRW-ADA", "KRW-NEAR",
];
const LEGACY_BOT_OVERRIDE_ALIAS = {
  bot_vb: "bot_01",
  bot_momentum: "bot_03",
  bot_bb: "bot_05",
};
const DEFAULT_BOT_OVERRIDES = Object.fromEntries(ALL_BOT_IDS.map((id) => [id, "ALLOW"]));
const DEFAULT_BOT_OVERRIDES_JSON = JSON.stringify(DEFAULT_BOT_OVERRIDES);

// [Antigravity-Doc] AI 프롬프트에 주입하는 10대 봇별 전략 특성 및 장세별 ALLOW/BLOCK 가이드
const BOT_STRATEGY_GUIDE = {
  bot_01: { name: "변동성 돌파봇", group: "추세·돌파", rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK" },
  bot_02: { name: "슈퍼트렌드+ATR봇", group: "추세·돌파", rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK" },
  bot_03: { name: "듀얼 모멘텀봇", group: "추세·돌파", rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK" },
  bot_04: { name: "볼린저 스퀴즈 돌파봇", group: "추세·돌파", rule: "BULL ALLOW, 스퀴즈 응축 시 조건부 허용" },
  bot_05: { name: "볼린저 역추세봇", group: "역추세·그리드·눌림목", rule: "SIDEWAYS/과매도 반등 ALLOW, 패닉 폭락 BLOCK" },
  bot_06: { name: "다단계 분할 그리드봇", group: "역추세·그리드·눌림목", rule: "SIDEWAYS 박스권 ALLOW, 급락 쇼크 BLOCK" },
  bot_07: { name: "MACD+RSI 추세봇", group: "추세·돌파", rule: "BULL ALLOW, SIDEWAYS/휩소 BLOCK" },
  bot_08: { name: "정배열 20일선 눌림목봇", group: "역추세·그리드·눌림목", rule: "상승 눌림/횡보 반등 ALLOW, 급락 쇼크 BLOCK" },
  bot_09: { name: "거래량 폭발 스캘퍼봇", group: "추세·돌파", rule: "BULL ALLOW, 거래량 폭발 시 조건부 허용" },
  bot_10: { name: "잭 켈로그 올라운더봇", group: "역추세·그리드·눌림목", rule: "VWAP/회귀 채널 멀티 레짐 ALLOW, 패닉 쇼크 BLOCK" },
};

/**
 * [Antigravity-Doc] 코인 수량(volume)을 소수점 8자리 이하로 안전 절삭(ROUND_DOWN)한 10진 문자열로 변환한다.
 * 업비트 매도 API에서 잔고 초과 오류(`insufficient_funds_ask`)를 막기 위해 반올림이 아닌 문자열 절삭을 사용한다.
 * @param {number|string} val 원본 수량
 * @returns {string} 소수점 최대 8자리 양수 문자열 (유효하지 않으면 "0")
 */
function floorTo8DecimalsStr(val) {
  if (val === null || val === undefined || val === "") return "0";
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return "0";
  // IEEE-754 부동소수점 곱셈 오차(0.29 * 1e8 = 28999999.999999996) 방지: 10진 문자열 직접 절삭(ROUND_DOWN)
  let str = typeof val === "string" && /^\s*\d+(\.\d+)?\s*$/.test(val) ? val.trim() : num.toFixed(12);
  if (/[eE]/.test(str)) {
    str = num.toFixed(12);
  }
  const [intPartRaw, fracPartRaw = ""] = str.split(".");
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "") || "0";
  const fracPart = fracPartRaw.slice(0, 8).replace(/0+$/, "");
  if (intPart === "0" && !fracPart) return "0";
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * [Antigravity-Doc] 체결가(실행 가격)를 정규화한다. 1,000원 이상은 정수 절삭, 1,000원 미만 저가 코인은 소수점 8자리 유지.
 * @param {number|string} rawPrice 원본 체결가
 * @param {number} [fallbackPrice=0] rawPrice가 0 이하/비정상일 때 대체가
 * @returns {number}
 */
function normalizeExecPrice(rawPrice, fallbackPrice = 0) {
  const num = Number(rawPrice);
  if (!Number.isFinite(num) || num <= 0) {
    const fb = Number(fallbackPrice);
    return Number.isFinite(fb) && fb > 0 ? fb : 0;
  }
  // 1,000원 이상은 원 단위 절삭, 1,000원 미만(특히 KRW-SHIB 등 1원 미만 코인)은 소수점 8자리 정밀도 보존
  return num >= 1000 ? Math.floor(num) : Number(num.toFixed(8));
}

/**
 * [Antigravity-Doc] AI 또는 DB에서 읽은 `bot_overrides`(JSON 문자열 또는 객체)를 10대 표준 봇(`bot_01`~`bot_10`) 기준
 * `{ bot_id: "ALLOW" | "BLOCK" }` 맵으로 정규화한다. 레거시 키(`bot_vb` 등)도 자동 승계한다.
 * @param {string|object} rawOverrides 원본 오버라이드
 * @returns {Record<string, "ALLOW"|"BLOCK">}
 */
function normalizeBotOverrides(rawOverrides) {
  let parsed = {};
  if (typeof rawOverrides === "string" && rawOverrides.trim()) {
    try {
      const candidate = JSON.parse(rawOverrides);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate;
      }
    } catch {
      parsed = {};
    }
  } else if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
    parsed = rawOverrides;
  }

  const out = { ...DEFAULT_BOT_OVERRIDES };
  for (const [legacyKey, modernKey] of Object.entries(LEGACY_BOT_OVERRIDE_ALIAS)) {
    const val = String(parsed[legacyKey] || "").trim().toUpperCase();
    if ((val === "ALLOW" || val === "BLOCK") && parsed[modernKey] === undefined) {
      out[modernKey] = val;
    }
  }
  for (const botId of ALL_BOT_IDS) {
    const val = String(parsed[botId] || "").trim().toUpperCase();
    if (val === "ALLOW" || val === "BLOCK") {
      out[botId] = val;
    }
  }
  return out;
}

/**
 * [Antigravity-Doc] DB에 저장된 `bot_overrides`가 레거시 키를 포함하거나 10대 봇 키가 누락되어 마이그레이션이 필요한지 검사한다.
 * @param {string|object} rawOverrides
 * @returns {boolean}
 */
function needsBotOverridesMigration(rawOverrides) {
  let parsed = null;
  if (typeof rawOverrides === "string") {
    try {
      parsed = JSON.parse(rawOverrides);
    } catch {
      return true;
    }
  } else if (rawOverrides && typeof rawOverrides === "object") {
    parsed = rawOverrides;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  if (Object.keys(LEGACY_BOT_OVERRIDE_ALIAS).some((k) => k in parsed)) return true;
  return ALL_BOT_IDS.some((id) => parsed[id] !== "ALLOW" && parsed[id] !== "BLOCK");
}

// [Antigravity-Doc] LLM이 예시/플레이스홀더로 출력할 수 있는 가짜 티커 차단 목록
const BLACKLIST_PLACEHOLDER_TICKERS = new Set([
  "KRW-TICKER",
  "KRW-COIN",
  "KRW-SYMBOL",
  "KRW-TOKEN",
  "KRW-NONE",
  "KRW-NULL",
  "KRW-NA",
  "KRW-EXAMPLE",
  "KRW-TEST",
]);

/**
 * [Antigravity-Doc] LLM이 반환한 블랙리스트 티커 배열을 정규화(`KRW-XXX`)하고 플레이스홀더 및 미상장 종목을 걸러낸다.
 * @param {string|string[]} rawList 원본 블랙리스트 (JSON 문자열 또는 배열)
 * @param {Set<string>|null} [validMarketsSet=null] 유효 KRW 마켓 화이트리스트 (미지정 시 캐시 사용)
 * @returns {string[]} 정렬된 고유 KRW 마켓 코드 배열
 */
function normalizeBlacklistTickers(rawList, validMarketsSet = null) {
  let arr = [];
  if (typeof rawList === "string") {
    try {
      arr = JSON.parse(rawList);
    } catch {
      arr = [];
    }
  } else if (Array.isArray(rawList)) {
    arr = rawList;
  }
  if (!Array.isArray(arr)) return [];
  const marketFilter =
    validMarketsSet instanceof Set
      ? validMarketsSet
      : typeof cachedValidKrwMarkets !== "undefined" && cachedValidKrwMarkets instanceof Set && cachedValidKrwMarkets.size > 0
      ? cachedValidKrwMarkets
      : null;
  const dedup = new Set();
  for (const item of arr) {
    const clean = String(item || "").trim().toUpperCase();
    if (!clean) continue;
    let candidate = "";
    if (clean.startsWith("KRW-")) candidate = clean;
    else if (clean.includes("-")) candidate = `KRW-${clean.split("-").pop()}`;
    else candidate = `KRW-${clean}`;
    if (!/^KRW-[A-Z0-9]{2,10}$/.test(candidate)) continue;
    if (BLACKLIST_PLACEHOLDER_TICKERS.has(candidate)) continue;
    if (marketFilter && marketFilter.size > 0 && !marketFilter.has(candidate)) continue;
    dedup.add(candidate);
  }
  return Array.from(dedup).sort();
}

/**
 * [Antigravity-Doc] 불리언/숫자/문자열("true","1","yes","on" 등) 플래그를 안전하게 boolean으로 변환한다.
 * @param {*} val 입력값
 * @param {boolean} [defaultVal=false] 판별 불가 시 기본값
 * @returns {boolean}
 */
function parseBoolFlag(val, defaultVal = false) {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0 && !Number.isNaN(val);
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(s)) return false;
  }
  return defaultVal;
}

/**
 * [Antigravity-Doc] 단일 LLM(Flash/Pro/Ollama)이 출력한 장세 제어 JSON을 검증·정규화한다.
 * 주요 방어 로직:
 *  - 유효하지 않은 `market_regime`, `recommended_action`, `sentiment_score`(-1~+1) 클램핑
 *  - `risk_alert=true`와 `REDUCE_SIZE`/부분 ALLOW 간 모순 해소 (진성 HALT 조건에서만 0% 전면 차단)
 *  - 약세/패닉 방어 액션인데 감성 점수가 양수(+)인 경량 모델 오류를 음수(-)로 부호 보정
 * @param {object} parsedDecision LLM 파싱 결과 객체
 * @param {string} [defaultReason] reason 누락 시 기본 설명
 * @returns {object} 정규화된 장세 판단 객체
 */
function normalizeLlmRegimeDecision(parsedDecision, defaultReason = "듀얼 AI 장세 및 봇 스위치 판단") {
  const regime = String(parsedDecision?.market_regime || "SIDEWAYS").trim().toUpperCase();
  const validRegime = ["BULL", "BEAR", "SIDEWAYS", "HIGH_VOLATILITY_SHOCK"].includes(regime) ? regime : "SIDEWAYS";

  const rawAction = String(parsedDecision?.recommended_action || "NORMAL").trim().toUpperCase();
  let validAction = ["NORMAL", "REDUCE_SIZE", "HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"].includes(rawAction)
    ? rawAction
    : "NORMAL";

  const rawScore = Number(parsedDecision?.sentiment_score ?? 0.0);
  let sentimentScore = Number.isFinite(rawScore)
    ? Math.max(-1.0, Math.min(1.0, Number(rawScore.toFixed(2))))
    : 0.0;

  const rawRiskAlert = parseBoolFlag(parsedDecision?.risk_alert, false);
  const hasMultField =
    parsedDecision?.position_size_multiplier !== undefined &&
    parsedDecision?.position_size_multiplier !== null &&
    parsedDecision?.position_size_multiplier !== "";
  const rawMultNum = Number(
    hasMultField ? parsedDecision.position_size_multiplier : validAction === "REDUCE_SIZE" ? 0.5 : 1.0
  );
  const safeRawMult = Number.isFinite(rawMultNum) ? rawMultNum : validAction === "REDUCE_SIZE" ? 0.5 : 1.0;

  const hasExplicitOverrides =
    Boolean(parsedDecision?.bot_overrides) &&
    typeof parsedDecision.bot_overrides === "object" &&
    !Array.isArray(parsedDecision.bot_overrides) &&
    Object.keys(parsedDecision.bot_overrides).length > 0;
  const rawOverrides = normalizeBotOverrides(parsedDecision?.bot_overrides);
  const hasAnyAllowBot = ALL_BOT_IDS.some((id) => rawOverrides[id] === "ALLOW");

  // 모순 정규화:
  // - HALT_NEW_BUYS / EMERGENCY_CLOSE_ALL, HIGH_VOLATILITY_SHOCK + risk_alert=true,
  //   또는 (risk_alert=true + 전체 봇 명시적 BLOCK + 비중 0)일 때만 전면 차단(HALT) 적용
  // - 단순 BEAR/SIDEWAYS에서 LLM이 REDUCE_SIZE + 역추세 봇 ALLOW를 의도하면서 습관적으로 risk_alert=true를 반환한 경우
  //   전면 차단(0%)으로 강제 승격하지 않고 REDUCE_SIZE(0.5x)와 개별 봇 스위치를 보존
  const isHardHalt =
    validAction === "HALT_NEW_BUYS" ||
    validAction === "EMERGENCY_CLOSE_ALL" ||
    (rawRiskAlert && validRegime === "HIGH_VOLATILITY_SHOCK") ||
    (rawRiskAlert && hasExplicitOverrides && !hasAnyAllowBot && safeRawMult <= 0);

  let riskAlert = false;
  let validMult = 1.0;
  let normalizedOverrides = rawOverrides;

  if (isHardHalt) {
    riskAlert = true;
    if (validAction !== "EMERGENCY_CLOSE_ALL") {
      validAction = "HALT_NEW_BUYS";
    }
    validMult = 0.0;
    normalizedOverrides = Object.fromEntries(ALL_BOT_IDS.map((id) => [id, "BLOCK"]));
  } else {
    riskAlert = false;
    if (rawRiskAlert && validAction === "NORMAL") {
      validAction = "REDUCE_SIZE";
    }
    if (validAction === "REDUCE_SIZE") {
      if (hasAnyAllowBot) {
        validMult = safeRawMult <= 0 ? 0.5 : Math.min(0.5, safeRawMult < 0.75 ? 0.5 : 1.0);
      } else {
        // risk_alert=false인 REDUCE_SIZE에서 경량 모델이 실수로 0 이하 비중 + 전봇 BLOCK을 출력한 경우
        // HALT_NEW_BUYS로 강제 승격하지 않고 역추세·그리드·눌림목 봇 0.5x 허용으로 보호
        if (safeRawMult <= 0) {
          for (const id of MEAN_REVERSION_GRID_BOT_IDS) {
            rawOverrides[id] = "ALLOW";
          }
          validMult = 0.5;
        } else {
          validMult = Math.min(0.5, safeRawMult < 0.75 ? 0.5 : 1.0);
        }
      }
    } else {
      // NORMAL 액션(비차단)에서 경량 모델이 실수로 0 이하 배수를 출력해도 전면 차단(0%)으로 전락하지 않도록 1.0으로 보정
      validMult = safeRawMult <= 0 ? 1.0 : safeRawMult < 0.75 ? 0.5 : 1.0;
    }
    normalizedOverrides = rawOverrides;
  }

  // 부호 일관성 가드: 약세(BEAR)/패닉(HIGH_VOLATILITY_SHOCK)에서 비정상(REDUCE_SIZE/HALT 등) 방어 액션을
  // 판정했음에도 경량/로컬 LLM(qwen3-news 등)이 감성 점수를 양수(+)로 출력한 경우 음수(-)로 정규화
  if (
    (validRegime === "BEAR" || validRegime === "HIGH_VOLATILITY_SHOCK") &&
    validAction !== "NORMAL" &&
    sentimentScore > 0
  ) {
    sentimentScore = Number((-Math.abs(sentimentScore)).toFixed(2));
  }

  return {
    sentiment_score: sentimentScore,
    market_regime: validRegime,
    risk_alert: riskAlert,
    recommended_action: validAction,
    position_size_multiplier: validMult,
    bot_overrides: normalizedOverrides,
    blacklist_tickers: normalizeBlacklistTickers(parsedDecision?.blacklist_tickers),
    reason: String(parsedDecision?.reason || defaultReason).trim(),
  };
}

/**
 * [Antigravity-Doc] Tier-3 기계적 폴백 장세 판단기.
 * Gemini/Ollama 등 모든 AI 호출이 실패했을 때 BTC 현재가 vs 일봉 20MA / 4시간봉 60MA 위치로 보수적 장세를 산출한다.
 * 시세 조회조차 실패한 경우 Fail-Open(BULL/1.0x)을 금지하고 SIDEWAYS/0.5x 안전 모드로 동작한다.
 * @param {{btcPrice?:number, btcDaily20Ma?:number, btc4h60Ma?:number, label?:string}} [params]
 * @returns {object} 정규화된 장세 판단 객체
 */
function buildMechanicalFallbackRegime({ btcPrice = 0, btcDaily20Ma = 0, btc4h60Ma = 0, label = "Fallback" } = {}) {
  const hasDailyMa = btcPrice > 0 && btcDaily20Ma > 0;
  const has4hMa = btcPrice > 0 && btc4h60Ma > 0;
  // BTC 시세/이평선 조회가 전면 실패한 경우 Fail-Open(BULL/1.0x) 금지 -> 방어적 SIDEWAYS/0.5x 안전 모드 적용
  if (!hasDailyMa && !has4hMa) {
    const safeOverrides = {};
    for (const id of ALL_BOT_IDS) {
      safeOverrides[id] = TREND_BREAKOUT_BOT_IDS.has(id) ? "BLOCK" : "ALLOW";
    }
    return {
      sentiment_score: -0.2,
      market_regime: "SIDEWAYS",
      risk_alert: false,
      recommended_action: "REDUCE_SIZE",
      position_size_multiplier: 0.5,
      bot_overrides: safeOverrides,
      blacklist_tickers: [],
      reason: `[${label}] BTC 지표 조회 불가(네트워크/API 지연) -> 보수적 안전 모드(돌파형 BLOCK · 역추세·그리드 0.5x)`,
    };
  }
  const isBelowDailyMa20 = hasDailyMa && btcPrice < btcDaily20Ma;
  const isBelow4hMa60 = has4hMa && btcPrice < btc4h60Ma;
  const isBelowDefenseMa = isBelowDailyMa20 || isBelow4hMa60;
  const disparityDaily = hasDailyMa ? (((btcPrice - btcDaily20Ma) / btcDaily20Ma) * 100).toFixed(2) : "0.00";
  const disparity4h = has4hMa ? (((btcPrice - btc4h60Ma) / btc4h60Ma) * 100).toFixed(2) : "0.00";
  const overrides = {};
  for (const id of ALL_BOT_IDS) {
    overrides[id] = isBelowDefenseMa && TREND_BREAKOUT_BOT_IDS.has(id) ? "BLOCK" : "ALLOW";
  }
  return {
    sentiment_score: isBelowDefenseMa ? -0.3 : 0.2,
    market_regime: isBelowDailyMa20 ? "BEAR" : isBelow4hMa60 ? "SIDEWAYS" : "BULL",
    risk_alert: false,
    recommended_action: isBelowDefenseMa ? "REDUCE_SIZE" : "NORMAL",
    position_size_multiplier: isBelowDefenseMa ? 0.5 : 1.0,
    bot_overrides: overrides,
    blacklist_tickers: [],
    reason: isBelowDefenseMa
      ? `[${label}] BTC 지표 방어(일봉 20MA ${disparityDaily}% / 4시간 60MA ${disparity4h}%) 하단 -> 돌파형 봇 BLOCK & 역추세·그리드·눌림목 ALLOW(0.5x)`
      : `[${label}] BTC 지표 상단(일봉 20MA ${disparityDaily}% / 4시간 60MA ${disparity4h}%) -> 10대 봇 전체 ALLOW(1.0x)`,
  };
}

/**
 * [Antigravity-Doc] 듀얼 AI(단기 Flash 30분 트랙 + 거시 Pro 1시간 트랙) 판단을 교차 검증하여 최종 장세 제어값을 합성한다.
 * 핵심 합성 규칙:
 *  1. Pro가 진성 HALT/EMERGENCY_CLOSE_ALL을 요청하면 최우선으로 전봇 BLOCK 및 비중 0% 적용.
 *  2. 로컬 소형 Ollama(Flash) 단독 HALT 요청은 블랙스완 키워드(해킹/디페깅/상폐 등)가 없고 Pro가 정상일 때 `REDUCE_SIZE(0.5x)`로 완화.
 *  3. 평시 비중 축소(`REDUCE_SIZE`) 시 전략군 스위치는 거시 전략가(Pro)를 우선하되, 경량 폴백 과잉 차단 시 역추세·그리드 봇을 보호.
 *  4. 감성 점수는 둘 중 하나가 -0.5 이하면 최솟값 채택, 그 외에는 Flash 40% + Pro 60% 가중 평균.
 *  5. 블랙리스트 티커는 두 모델의 합집합으로 병합.
 * @param {object} flashDecision 단기 트랙 판단
 * @param {object} proDecision 거시 트랙 판단
 * @returns {object} `market_regime_filter` 갱신용 최종 합성 결과
 */
function synthesizeDualAiDecision(flashDecision, proDecision) {
  const flashAction = String(flashDecision?.recommended_action || "NORMAL").trim().toUpperCase();
  const proAction = String(proDecision?.recommended_action || "NORMAL").trim().toUpperCase();
  const flashRegime = String(flashDecision?.market_regime || "SIDEWAYS").trim().toUpperCase();
  const proRegime = String(proDecision?.market_regime || "SIDEWAYS").trim().toUpperCase();
  const flashAlert = parseBoolFlag(flashDecision?.risk_alert, false);
  const proAlert = parseBoolFlag(proDecision?.risk_alert, false);
  const rawFlashMult = Number(flashDecision?.position_size_multiplier ?? 1.0);
  const rawProMult = Number(proDecision?.position_size_multiplier ?? 1.0);
  const rawFlashScore = Number(flashDecision?.sentiment_score ?? 0.0);
  const rawProScore = Number(proDecision?.sentiment_score ?? 0.0);
  const flashMult = Math.max(0, Math.min(1, Number.isFinite(rawFlashMult) ? rawFlashMult : 1.0));
  const proMult = Math.max(0, Math.min(1, Number.isFinite(rawProMult) ? rawProMult : 1.0));
  let flashScore = Math.max(-1, Math.min(1, Number.isFinite(rawFlashScore) ? rawFlashScore : 0.0));
  if ((flashRegime === "BEAR" || flashRegime === "HIGH_VOLATILITY_SHOCK") && flashAction !== "NORMAL" && flashScore > 0) {
    flashScore = Number((-Math.abs(flashScore)).toFixed(2));
  }
  let proScore = Math.max(-1, Math.min(1, Number.isFinite(rawProScore) ? rawProScore : 0.0));
  if ((proRegime === "BEAR" || proRegime === "HIGH_VOLATILITY_SHOCK") && proAction !== "NORMAL" && proScore > 0) {
    proScore = Number((-Math.abs(proScore)).toFixed(2));
  }

  const flashOverrides = normalizeBotOverrides(flashDecision?.bot_overrides);
  const proOverrides = normalizeBotOverrides(proDecision?.bot_overrides);
  const hasActivePro = Boolean(proDecision && !proDecision._isNeutralPassThrough);
  const finalOverrides = {};

  const proModelStr = String(proDecision?.model || "").toLowerCase();
  const flashModelStr = String(flashDecision?.model || "").toLowerCase();
  const flashProviderStr = String(flashDecision?.provider || "").toLowerCase();
  // Pro 슬롯 경량/기계적 폴백(lite/mechanical)과 일반 Flash(gemini-3.5/3.8-flash) 모델 구분
  const isProLiteFallback =
    proModelStr.includes("lite") ||
    proModelStr.includes("mechanical");
  const isProFlashModel = !isProLiteFallback && proModelStr.includes("flash");
  const isLocalOllamaFlash =
    flashProviderStr === "ollama" || flashModelStr.includes("qwen");
  const hasBlackSwanKeywordInText = (text) => {
    const t = String(text || "");
    const negated =
      /(?:해킹|해커|익스플로잇|디페깅|디페그|상장폐지|상폐|유의종목|거래정지|출금정지|파산)[^.,\n]{0,25}(?:없|아니|않|미발생|무관|포착되지|감지되지|확인되지|징역|구속|체포|기소|재판|보안센터|출범|예방|방지)|(?:과거|옛)[^.,\n]{0,12}(?:해킹|해커|파산|디페깅)/i.test(
        t
      );
    if (negated) return false;
    return /(?:거래소|바이낸스|업비트|빗썸|코인베이스|프로토콜|브릿지|네트워크)[^.,\n]{0,12}(?:해킹|공격|탈취|파산|뱅크런)|(?:해킹|익스플로잇)[^.,\n]{0,10}(?:발생|피해|유출|쇼크|중단)|디페깅|디페그|상장폐지|상폐|유의종목|거래정지|출금정지|입출금\s*중단|긴급\s*점검|뱅크런|exploit|depeg|delist|insolvenc/i.test(
      t
    );
  };
  const flashReasonText = String(flashDecision?.reason || "");
  const proReasonText = String(proDecision?.reason || "");
  const flashRegimeUpper = String(flashDecision?.market_regime || "").trim().toUpperCase();
  const hasHardBlackSwanKeyword =
    flashRegimeUpper === "HIGH_VOLATILITY_SHOCK" || hasBlackSwanKeywordInText(flashReasonText);
  const proHasHardBlackSwanKeyword = hasBlackSwanKeywordInText(proReasonText);
  const flashRequestsHalt = flashAlert || flashAction === "HALT_NEW_BUYS" || flashAction === "EMERGENCY_CLOSE_ALL";
  const proRequestsEmergencyClose = proAction === "EMERGENCY_CLOSE_ALL";
  const proRequestsHalt = proAlert || proAction === "HALT_NEW_BUYS" || proRequestsEmergencyClose;
  const isSoftenedOllamaHalt =
    flashRequestsHalt &&
    isLocalOllamaFlash &&
    hasActivePro &&
    !proRequestsHalt &&
    flashAction !== "EMERGENCY_CLOSE_ALL" &&
    !hasHardBlackSwanKeyword;

  let finalRiskAlert = false;
  let finalAction = "NORMAL";
  let finalMult = 1.0;
  let synthMode = "DUAL_NORMAL_ALLOW";

  // Pro 슬롯 단독 HALT 허용 조건:
  // - 실제 Pro 모델(non-lite/non-flash), 또는 Flash(gemini-3.5/3.8-flash)에서 진성 블랙스완 키워드 감지,
  // - 또는 EMERGENCY_CLOSE_ALL, 또는 Flash와 동시 HALT 합의 시
  const proCanUnilaterallyHalt =
    (!isProLiteFallback && (!isProFlashModel || proHasHardBlackSwanKeyword)) ||
    proRequestsEmergencyClose ||
    flashRequestsHalt;

  if (proRequestsHalt && proCanUnilaterallyHalt) {
    finalRiskAlert = true;
    finalAction = flashAction === "EMERGENCY_CLOSE_ALL" || proRequestsEmergencyClose ? "EMERGENCY_CLOSE_ALL" : "HALT_NEW_BUYS";
    finalMult = 0.0;
    for (const id of ALL_BOT_IDS) finalOverrides[id] = "BLOCK";
    synthMode = "PRO_RISK_PRIORITY (심층 리스크 최우선 신규 매수 전면 차단)";
  } else if (flashRequestsHalt && !isSoftenedOllamaHalt) {
    finalRiskAlert = true;
    finalAction = flashAction === "EMERGENCY_CLOSE_ALL" ? "EMERGENCY_CLOSE_ALL" : "HALT_NEW_BUYS";
    finalMult = 0.0;
    for (const id of ALL_BOT_IDS) finalOverrides[id] = "BLOCK";
    synthMode = "FLASH_SHOCK_DEFENSE (단기 돌발 악재 감지로 신규 매수 전면 차단)";
  } else if (
    isSoftenedOllamaHalt ||
    proRequestsHalt ||
    flashAction === "REDUCE_SIZE" ||
    proAction === "REDUCE_SIZE" ||
    flashMult <= 0.5 ||
    proMult <= 0.5 ||
    flashScore <= -0.3 ||
    proScore <= -0.3
  ) {
    finalRiskAlert = false;
    finalAction = "REDUCE_SIZE";
    const safeFlashMult = isSoftenedOllamaHalt ? 0.5 : flashMult;
    const safeProMult = proRequestsHalt ? 0.5 : proMult;
    finalMult = Number(Math.max(0, Math.min(safeFlashMult, safeProMult, 0.5)).toFixed(2));
    // 권한 분리: Flash는 돌발 쇼크(HALT/블랙리스트) 방어에 집중, 평시(BEAR/SIDEWAYS/REDUCE_SIZE) 10대 봇 전략군 스위치는 거시 전략가(Pro) 판정 우선
    // 단, Pro가 Flash/경량/기계적 폴백 모델로 동작하며 전체 봇/HALT 또는 역추세·그리드 봇을 과잉 BLOCK했으나 Flash가 허용 봇을 유지한 경우 Flash 스위치로 폴백 보호
    const proAllBlocked = ALL_BOT_IDS.every((id) => proOverrides[id] === "BLOCK");
    const proBlockedMeanReversion = Array.from(MEAN_REVERSION_GRID_BOT_IDS).some(
      (id) => proOverrides[id] === "BLOCK"
    );
    const flashHasAllow = ALL_BOT_IDS.some((id) => flashOverrides[id] === "ALLOW");
    const flashAllowsMeanReversion = Array.from(MEAN_REVERSION_GRID_BOT_IDS).some(
      (id) => flashOverrides[id] === "ALLOW"
    );
    const shouldProtectFlashSwitches =
      !isSoftenedOllamaHalt &&
      (isProLiteFallback || isProFlashModel) &&
      (proRequestsHalt ||
        (proAllBlocked && flashHasAllow) ||
        (proBlockedMeanReversion && flashAllowsMeanReversion));
    const sourceOverrides =
      hasActivePro && !shouldProtectFlashSwitches
        ? proOverrides
        : flashOverrides;
    for (const id of ALL_BOT_IDS) {
      finalOverrides[id] = sourceOverrides[id];
    }
    if (ALL_BOT_IDS.every((id) => finalOverrides[id] === "BLOCK")) {
      // Flash/Pro 모두 HALT_NEW_BUYS/risk_alert를 발령하지 않고 REDUCE_SIZE를 의도했으나
      // 경량/폴백 모델이 bot_overrides 10개를 전부 BLOCK으로 출력한 경우, 전면 중단 대신 역추세·그리드·눌림목 봇은 0.5x 허용으로 보호
      for (const id of MEAN_REVERSION_GRID_BOT_IDS) {
        finalOverrides[id] = "ALLOW";
      }
      if (finalMult <= 0) finalMult = 0.5;
      synthMode = "CONSERVATIVE_REDUCE_GUARD (전봇 BLOCK 보정 · 역추세·그리드 0.5x 허용)";
    } else {
      if (finalMult <= 0) finalMult = 0.5;
      synthMode = isSoftenedOllamaHalt
        ? "FLASH_OLLAMA_HALT_GUARD (로컬 소형 모델 단독 HALT 완화 · Pro 교차검증 우선)"
        : proRequestsHalt
        ? "PRO_LITE_HALT_GUARD (경량 폴백 HALT 완화 · 역추세·그리드 0.5x 허용)"
        : "CONSERVATIVE_REDUCE (보수적 비중 축소 · Pro 전략군 스위치 우선)";
    }
  } else {
    finalRiskAlert = false;
    finalAction = "NORMAL";
    finalMult = Number(Math.max(0, Math.min(flashMult, proMult, 1.0)).toFixed(2));
    const sourceOverrides = hasActivePro ? proOverrides : flashOverrides;
    for (const id of ALL_BOT_IDS) {
      finalOverrides[id] = sourceOverrides[id];
    }
    if (ALL_BOT_IDS.every((id) => finalOverrides[id] === "BLOCK")) {
      finalRiskAlert = true;
      finalAction = "HALT_NEW_BUYS";
      finalMult = 0.0;
      synthMode = "DUAL_ALL_BOTS_BLOCKED";
    } else {
      synthMode = "DUAL_NORMAL_ALLOW (양 모델 교차 검증 통과)";
    }
  }

  let finalScore =
    Math.min(flashScore, proScore) <= -0.5
      ? Number(Math.min(flashScore, proScore).toFixed(2))
      : Number((0.4 * flashScore + 0.6 * proScore).toFixed(2));

  let finalRegime = "SIDEWAYS";
  if (flashRegime === "HIGH_VOLATILITY_SHOCK" || proRegime === "HIGH_VOLATILITY_SHOCK") {
    finalRegime = "HIGH_VOLATILITY_SHOCK";
  } else if (flashRegime === "BEAR" || proRegime === "BEAR") {
    finalRegime = "BEAR";
  } else if (proRegime === "BULL" && (flashRegime === "BULL" || flashRegime === "SIDEWAYS")) {
    finalRegime = "BULL";
  }
  if ((finalRegime === "BEAR" || finalRegime === "HIGH_VOLATILITY_SHOCK") && finalAction !== "NORMAL" && finalScore > 0) {
    finalScore = Number((-Math.abs(finalScore)).toFixed(2));
  }

  const combinedBlacklist = Array.from(
    new Set([
      ...normalizeBlacklistTickers(flashDecision?.blacklist_tickers),
      ...normalizeBlacklistTickers(proDecision?.blacklist_tickers),
    ])
  ).sort();

  const flashReason = String(flashDecision?.reason || "").trim();
  const proReason = String(proDecision?.reason || "").trim();
  const reasonStr =
    `[듀얼 AI 교차검증: ${synthMode}] ` +
    `Flash(30분): ${flashAction}(점수 ${flashScore >= 0 ? "+" : ""}${flashScore.toFixed(2)}${flashReason ? `, '${flashReason}'` : ""}) | ` +
    `Pro(1시간): ${proAction}(점수 ${proScore >= 0 ? "+" : ""}${proScore.toFixed(2)}${proReason ? `, '${proReason}'` : ""}) => ` +
    `최종 ${finalAction} (투자 비중 ${Math.round(finalMult * 100)}%)`;

  return {
    sentiment_score: finalScore,
    market_regime: finalRegime,
    risk_alert: finalRiskAlert ? 1 : 0,
    recommended_action: finalAction,
    position_size_multiplier: finalMult,
    bot_overrides: finalOverrides,
    blacklist_tickers: combinedBlacklist,
    reason: reasonStr,
    flash_sentiment_score: flashScore,
    flash_recommended_action: flashAction,
    pro_sentiment_score: proScore,
    pro_recommended_action: proAction,
    final_risk_alert: finalRiskAlert ? 1 : 0,
    final_position_multiplier: finalMult,
    final_bot_overrides: finalOverrides,
    synthesis_mode: synthMode,
  };
}

/**
 * [Antigravity-Doc] 문자열이 AI 장세 제어 JSON 조각인지 휴리스틱으로 판별한다.
 * @param {string} text 검사할 텍스트
 * @returns {boolean}
 */
function isRegimeControlJsonFragment(text) {
  if (!text || typeof text !== "string") return false;
  const hasBotOverrides = text.includes('"bot_overrides"') || text.includes("bot_overrides");
  const hasRegime = text.includes('"market_regime"');
  const hasAction = text.includes('"recommended_action"');
  const hasSentiment = text.includes('"sentiment_score"');
  const hasMult = text.includes('"position_size_multiplier"');
  const hasRisk = text.includes('"risk_alert"');
  const hitCount = [hasBotOverrides, hasRegime, hasAction, hasSentiment, hasMult, hasRisk].filter(Boolean).length;
  return hasBotOverrides || hitCount >= 2;
}

/**
 * [Antigravity-Doc] 토큰 절단 등으로 닫히지 않은(불완전한) LLM 제어 JSON 문자열에서 정규식으로 핵심 필드를 복구한다.
 * @param {string} rawJsonText 잘린 JSON 후보 문자열
 * @returns {object|null} 핵심 필드(regime/action/bot_overrides) 중 하나 이상 복구되면 객체 반환, 아니면 null
 */
function parsePartialRegimeJson(rawJsonText) {
  if (!rawJsonText || typeof rawJsonText !== "string") return null;
  if (!isRegimeControlJsonFragment(rawJsonText)) return null;

  const out = {};
  const sentimentMatch = rawJsonText.match(/"sentiment_score"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (sentimentMatch) out.sentiment_score = Number(sentimentMatch[1]);

  const regimeMatch = rawJsonText.match(/"market_regime"\s*:\s*"(BULL|BEAR|SIDEWAYS|HIGH_VOLATILITY_SHOCK)"/i);
  if (regimeMatch) out.market_regime = regimeMatch[1].toUpperCase();

  const riskMatch = rawJsonText.match(/"risk_alert"\s*:\s*(true|false)/i);
  if (riskMatch) out.risk_alert = riskMatch[1].toLowerCase() === "true";

  const actionMatch = rawJsonText.match(
    /"recommended_action"\s*:\s*"(NORMAL|REDUCE_SIZE|HALT_NEW_BUYS|EMERGENCY_CLOSE_ALL)"/i
  );
  if (actionMatch) out.recommended_action = actionMatch[1].toUpperCase();

  const multMatch = rawJsonText.match(/"position_size_multiplier"\s*:\s*(\d+(?:\.\d+)?)/);
  if (multMatch) out.position_size_multiplier = Number(multMatch[1]);

  const botOverrides = {};
  const botRegex = /"(bot_(?:0[1-9]|10))"\s*:\s*"(ALLOW|BLOCK)"/gi;
  let bm;
  while ((bm = botRegex.exec(rawJsonText)) !== null) {
    botOverrides[bm[1].toLowerCase()] = bm[2].toUpperCase();
  }
  if (Object.keys(botOverrides).length > 0) {
    out.bot_overrides = botOverrides;
  }

  const blacklistMatch = rawJsonText.match(/"blacklist_tickers"\s*:\s*\[([^\]]*)\]/);
  if (blacklistMatch) {
    const items = [];
    const itemRegex = /"([^"]+)"/g;
    let im;
    while ((im = itemRegex.exec(blacklistMatch[1])) !== null) {
      items.push(im[1]);
    }
    out.blacklist_tickers = items;
  }

  const closedReasonMatch = rawJsonText.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (closedReasonMatch) {
    out.reason = closedReasonMatch[1].replace(/\\"/g, '"').trim();
  } else {
    const partialReasonMatch = rawJsonText.match(/"reason"\s*:\s*"([^\n"]+)/);
    if (partialReasonMatch) {
      out.reason = partialReasonMatch[1].trim();
    }
  }

  const hasEnoughFields =
    Boolean(out.market_regime) ||
    Boolean(out.recommended_action) ||
    (out.bot_overrides && Object.keys(out.bot_overrides).length > 0);
  return hasEnoughFields ? out : null;
}

/**
 * [Antigravity-Doc] 사용자에게 노출되는 AI 브리핑 마크다운 본문에서 기계 제어용 JSON 블록(닫힌/열린 펜스, 말미 원시 JSON)을 제거한다.
 * @param {string} rawText LLM 원문 응답
 * @returns {string} 제어 JSON이 제거된 마크다운 텍스트
 */
function stripControlJsonFromBriefingText(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  let cleaned = rawText;

  // 1) 닫힌 코드 펜스 중 제어 JSON 블록 제거
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (full, body) => {
    return isRegimeControlJsonFragment(body) ? "" : full;
  });

  // 2) 스트림/토큰 한도 등으로 닫히지 않은 제어 JSON 코드 펜스 제거
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*)$/i, (full, body) => {
    const trimmedBody = String(body || "").trim();
    if (!trimmedBody || trimmedBody.startsWith("{") || isRegimeControlJsonFragment(trimmedBody)) {
      return "";
    }
    return full;
  });

  // 3) 코드 펜스 없이 본문 끝에 붙은 원시 제어 JSON 객체(완전/미완성 모두) 제거
  const trailingRawJsonMatch = cleaned.match(/\n\s*(\{\s*"(?:sentiment_score|market_regime|risk_alert|recommended_action|bot_overrides)"[\s\S]*)$/);
  if (trailingRawJsonMatch && isRegimeControlJsonFragment(trailingRawJsonMatch[1])) {
    cleaned = cleaned.slice(0, trailingRawJsonMatch.index);
  }

  // 4) 제어 JSON 블록 바로 앞에 남은 안내 헤더 및 끝 구분선 정리
  cleaned = cleaned
    .replace(/###\s*\[?(?:구조화|JSON\s*제어).*$/gim, "")
    .replace(/(?:\r?\n\s*---\s*)+$/g, "")
    .trim();

  return cleaned;
}

/**
 * [Antigravity-Doc] LLM 마크다운 응답에서 브리핑 본문(`cleanText`)과 구조화된 장세 제어 객체(`structured`)를 분리 추출한다.
 * 코드 펜스 JSON -> 말미 원시 JSON -> 잘린 부분 JSON 순으로 3단계 복구를 시도한 뒤 `normalizeLlmRegimeDecision`으로 정규화한다.
 * @param {string} rawText LLM 원문 응답
 * @returns {{cleanText:string, structured:object|null}}
 */
function extractStructuredRegimeFromLlmText(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { cleanText: "", structured: null };
  }
  const cleanFencedBlocks = [];
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencedRegex.exec(rawText)) !== null) {
    cleanFencedBlocks.push({ full: match[0], body: match[1].trim(), index: match.index });
  }

  let parsedDecision = null;
  let blockToStrip = null;

  for (let i = cleanFencedBlocks.length - 1; i >= 0; i -= 1) {
    const blk = cleanFencedBlocks[i];
    if (blk.body.includes("{") && blk.body.includes("bot_overrides")) {
      try {
        const obj = JSON.parse(blk.body);
        if (obj && typeof obj === "object" && obj.bot_overrides) {
          parsedDecision = obj;
          blockToStrip = blk.full;
          break;
        }
      } catch {}
    }
  }

  if (!parsedDecision) {
    const rawTrim = rawText.trim();
    const lastOpen = rawTrim.lastIndexOf('{"');
    const candidateIdx = lastOpen !== -1 ? lastOpen : rawTrim.lastIndexOf("{");
    const lastClose = rawTrim.lastIndexOf("}");
    if (candidateIdx !== -1 && lastClose > candidateIdx) {
      const slice = rawTrim.slice(candidateIdx, lastClose + 1);
      if (slice.includes("bot_overrides")) {
        try {
          const obj = JSON.parse(slice);
          if (obj && typeof obj === "object" && obj.bot_overrides) {
            parsedDecision = obj;
            blockToStrip = slice;
          }
        } catch {}
      }
    }
  }

  // 닫히지 않거나 중간에 잘린 제어 JSON 블록(토큰 절단 등)에서도 핵심 제어값 복구
  if (!parsedDecision) {
    const unclosedFenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (unclosedFenceMatch && isRegimeControlJsonFragment(unclosedFenceMatch[1])) {
      parsedDecision = parsePartialRegimeJson(unclosedFenceMatch[1]);
      blockToStrip = unclosedFenceMatch[0];
    } else {
      const trailingRawMatch = rawText.match(
        /\{\s*"(?:sentiment_score|market_regime|risk_alert|recommended_action|bot_overrides)"[\s\S]*$/
      );
      if (trailingRawMatch && isRegimeControlJsonFragment(trailingRawMatch[0])) {
        parsedDecision = parsePartialRegimeJson(trailingRawMatch[0]);
        blockToStrip = trailingRawMatch[0];
      }
    }
  }

  let cleanText = rawText;
  if (blockToStrip) {
    cleanText = cleanText.replace(blockToStrip, "");
  }
  cleanText = stripControlJsonFromBriefingText(cleanText);

  if (!parsedDecision) {
    return { cleanText, structured: null };
  }

  const structured = normalizeLlmRegimeDecision(parsedDecision, "듀얼 AI 장세 및 봇 스위치 판단");
  return { cleanText, structured };
}

/**
 * [Antigravity-Doc] `market_regime_filter` DB 행에 파싱된 `bot_overrides`, `final_bot_overrides`, `blacklist_tickers`와
 * 활성 Flash/Pro 모델 메타정보를 덧붙여 API 응답 형식으로 확장한다.
 * @param {object|null} row DB 행
 * @param {object} [modelMeta={}] `loadDualAiModelMeta` 결과
 * @returns {object|null}
 */
function enrichRegimeFilterRow(row, modelMeta = {}) {
  if (!row) return null;
  const botOverrides = normalizeBotOverrides(row.final_bot_overrides_json || row.bot_overrides_json);
  const blacklistTickers = normalizeBlacklistTickers(row.blacklist_tickers_json);
  return {
    ...row,
    bot_overrides: normalizeBotOverrides(row.bot_overrides_json || botOverrides),
    final_bot_overrides: botOverrides,
    blacklist_tickers: blacklistTickers,
    flash_provider: modelMeta.flash_provider || row.flash_provider || "",
    flash_model: modelMeta.flash_model || row.flash_model || "",
    pro_provider: modelMeta.pro_provider || row.pro_provider || "",
    pro_model: modelMeta.pro_model || row.pro_model || "",
  };
}

/**
 * [Antigravity-Doc] 현재 사용 중인 듀얼 AI(Flash/Pro) 제공자·모델명을 `system_settings` 및 최신 브리핑 이력에서 조회한다.
 * @param {object} db 활성 DB 인스턴스
 * @returns {Promise<{flash_provider:string, flash_model:string, pro_provider:string, pro_model:string}>}
 */
async function loadDualAiModelMeta(db) {
  const out = { flash_provider: "", flash_model: "", pro_provider: "", pro_model: "" };
  try {
    out.flash_provider = await getSetting("dual_ai_flash_provider", "");
    out.flash_model = await getSetting("dual_ai_flash_model", "");
    out.pro_provider = await getSetting("dual_ai_pro_provider", "");
    out.pro_model = await getSetting("dual_ai_pro_model", "");
    if (!out.flash_model) {
      const flashRaw = await getSetting("dual_ai_flash_state_json", "");
      if (flashRaw) {
        const parsed = JSON.parse(flashRaw);
        out.flash_provider = out.flash_provider || String(parsed?.provider || "");
        out.flash_model = String(parsed?.model || "");
      }
    }
    if (!out.pro_model) {
      const proRaw = await getSetting("dual_ai_pro_state_json", "");
      if (proRaw) {
        const parsed = JSON.parse(proRaw);
        out.pro_provider = out.pro_provider || String(parsed?.provider || "");
        out.pro_model = String(parsed?.model || "");
      }
    }
    if (!out.flash_model && db) {
      const latestFlashRow =
        (await db
          .prepare("SELECT provider, model FROM ai_market_briefings WHERE model NOT LIKE '%pro%' ORDER BY id DESC LIMIT 1")
          .get()
          .catch(() => null)) ||
        (await db
          .prepare("SELECT provider, model FROM ai_news_briefings ORDER BY id DESC LIMIT 1")
          .get()
          .catch(() => null));
      if (latestFlashRow) {
        out.flash_provider = out.flash_provider || String(latestFlashRow.provider || "");
        out.flash_model = String(latestFlashRow.model || "");
      }
    }
    if (!out.pro_model && db) {
      const latestProRow = await db
        .prepare("SELECT provider, model FROM ai_market_briefings WHERE provider = 'gemini' ORDER BY id DESC LIMIT 1")
        .get()
        .catch(() => null);
      if (latestProRow) {
        out.pro_provider = out.pro_provider || String(latestProRow.provider || "");
        out.pro_model = String(latestProRow.model || "");
      }
    }
  } catch {}
  return out;
}

/**
 * [Antigravity-Doc] 데이터베이스 전체 스키마 생성, 무중단 컬럼 마이그레이션, 기본 시드(10대 봇/로테이션/시스템 설정) 및
 * 레거시·테스트 이력 정리를 수행한다.
 * 부수효과:
 *  - SQLite/PostgreSQL 호환 테이블(`system_settings`, `bots`, `trades`, `bot_positions`, `paper_*`, `market_regime_filter`,
 *    `auto_rotation_*`, `drain_handoff_logs`, `capital_restoration_logs`, `ai_*`, `crypto_news`, `push_subscriptions` 등) 생성 및 `ALTER TABLE`
 *  - 백테스트·실전 주문 가드레일 테이블 보장 (`ensureBacktestTables`, `ensureLiveGuardrailTables`)
 *  - 10대 아레나 봇 시드 및 `virtual_krw = allocated_capital - OPEN 포지션 합계` 정합성 동기화
 * @returns {Promise<void>}
 */
export async function initializeDatabase() {
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      description TEXT NOT NULL,
      allocation_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
      allocated_capital BIGINT NOT NULL DEFAULT 0,
      virtual_krw BIGINT NOT NULL DEFAULT 0,
      is_running INTEGER NOT NULL DEFAULT 0,
      min_volume_krw BIGINT NOT NULL DEFAULT 0,
      stop_loss_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      take_profit_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_status_msg TEXT NOT NULL DEFAULT '대기 중',
      updated_at TEXT NOT NULL,
      is_selected_for_live INTEGER NOT NULL DEFAULT 0,
      paper_initial_capital BIGINT NOT NULL DEFAULT 1000000,
      paper_virtual_krw BIGINT NOT NULL DEFAULT 1000000,
      paper_is_running INTEGER NOT NULL DEFAULT 1,
      paper_peak_equity BIGINT NOT NULL DEFAULT 1000000,
      paper_mdd_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
      paper_status_msg TEXT NOT NULL DEFAULT '시그널 대기 중'
    );
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      buy_order_uuid TEXT NOT NULL,
      sell_order_uuid TEXT,
      buy_price DOUBLE PRECISION NOT NULL,
      buy_volume TEXT NOT NULL,
      buy_amount BIGINT NOT NULL,
      buy_date TEXT NOT NULL,
      sell_price DOUBLE PRECISION,
      sell_volume TEXT,
      sell_amount BIGINT,
      sell_date TEXT,
      profit_krw BIGINT,
      profit_pct DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'HOLDING'
    );
    CREATE TABLE IF NOT EXISTS bot_positions (
      id BIGSERIAL PRIMARY KEY,
      bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      order_uuid TEXT NOT NULL UNIQUE,
      volume TEXT NOT NULL,
      avg_buy_price DOUBLE PRECISION NOT NULL,
      buy_amount BIGINT NOT NULL,
      buy_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
      trade_id BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      closed_at TEXT,
      sell_order_uuid TEXT,
      sell_price DOUBLE PRECISION,
      sell_amount DOUBLE PRECISION,
      sell_fee DOUBLE PRECISION,
      realized_pnl DOUBLE PRECISION,
      pnl_pct DOUBLE PRECISION
    );
    CREATE TABLE IF NOT EXISTS ai_market_briefings (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT 'gemini-1.5-flash',
      btc_price DOUBLE PRECISION,
      btc_daily_20ma DOUBLE PRECISION,
      btc_4h_60ma DOUBLE PRECISION,
      regime_status TEXT,
      briefing_text TEXT NOT NULL,
      decision_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_news (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      link TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      published_at TEXT NOT NULL,
      summary TEXT,
      sentiment TEXT NOT NULL DEFAULT 'NEUTRAL',
      keywords TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_news_pubdate ON crypto_news (published_at DESC);
    CREATE TABLE IF NOT EXISTS ai_news_briefings (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT 'gemini-3.5-flash-lite',
      news_count INTEGER NOT NULL DEFAULT 0,
      bullish_count INTEGER NOT NULL DEFAULT 0,
      bearish_count INTEGER NOT NULL DEFAULT 0,
      neutral_count INTEGER NOT NULL DEFAULT 0,
      briefing_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id BIGSERIAL PRIMARY KEY,
      bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      buy_order_uuid TEXT NOT NULL,
      sell_order_uuid TEXT,
      buy_price DOUBLE PRECISION NOT NULL,
      buy_volume TEXT NOT NULL,
      buy_amount BIGINT NOT NULL,
      buy_date TEXT NOT NULL,
      sell_price DOUBLE PRECISION,
      sell_volume TEXT,
      sell_amount BIGINT,
      sell_date TEXT,
      profit_krw BIGINT,
      profit_pct DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'HOLDING',
      buy_reason TEXT,
      sell_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_bot_positions (
      id BIGSERIAL PRIMARY KEY,
      bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      order_uuid TEXT NOT NULL UNIQUE,
      volume TEXT NOT NULL,
      avg_buy_price DOUBLE PRECISION NOT NULL,
      buy_amount BIGINT NOT NULL,
      buy_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
      trade_id BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS market_regime_filter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sentiment_score DOUBLE PRECISION DEFAULT 0.0,
      market_regime TEXT DEFAULT 'SIDEWAYS',
      risk_alert INTEGER DEFAULT 0,
      recommended_action TEXT DEFAULT 'NORMAL',
      position_size_multiplier DOUBLE PRECISION DEFAULT 1.0,
      bot_overrides_json TEXT DEFAULT '${DEFAULT_BOT_OVERRIDES_JSON}',
      blacklist_tickers_json TEXT DEFAULT '[]',
      reason TEXT DEFAULT 'Initial default state',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      flash_sentiment_score DOUBLE PRECISION DEFAULT 0.0,
      flash_recommended_action TEXT DEFAULT 'NORMAL',
      flash_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      pro_sentiment_score DOUBLE PRECISION DEFAULT 0.0,
      pro_recommended_action TEXT DEFAULT 'NORMAL',
      pro_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      final_risk_alert INTEGER DEFAULT 0,
      final_position_multiplier DOUBLE PRECISION DEFAULT 1.0,
      final_bot_overrides_json TEXT DEFAULT '${DEFAULT_BOT_OVERRIDES_JSON}'
    );
    CREATE TABLE IF NOT EXISTS monthly_asset_snapshots (
      year_month TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'live',
      month_start_balance DOUBLE PRECISION NOT NULL,
      current_balance DOUBLE PRECISION NOT NULL,
      krw_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      coin_eval_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      diff_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      diff_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      snapshot_date TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (year_month, mode)
    );
    CREATE TABLE IF NOT EXISTS auto_rotation_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_enabled INTEGER DEFAULT 1,
      rotation_day_of_week INTEGER DEFAULT 1,
      rotation_hour_kst INTEGER DEFAULT 9,
      allocation_mode TEXT DEFAULT 'EQUAL_BY_EQUITY_TIER',
      min_weekly_trades INTEGER DEFAULT 2,
      capital_tier_1_max DOUBLE PRECISION DEFAULT 400000,
      capital_tier_2_max DOUBLE PRECISION DEFAULT 700000,
      max_deploy_ratio DOUBLE PRECISION DEFAULT 0.90,
      last_rotated_at TEXT,
      next_rotation_at TEXT,
      updated_at TEXT
    );
    ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS capital_tier_1_max DOUBLE PRECISION DEFAULT 400000;
    ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS capital_tier_2_max DOUBLE PRECISION DEFAULT 700000;
    ALTER TABLE auto_rotation_config ADD COLUMN IF NOT EXISTS max_deploy_ratio DOUBLE PRECISION DEFAULT 0.90;
    CREATE TABLE IF NOT EXISTS auto_rotation_history (
      id BIGSERIAL PRIMARY KEY,
      trigger_type TEXT,
      previous_bots_json TEXT,
      elected_bots_json TEXT,
      draining_positions_count INTEGER DEFAULT 0,
      transferred_krw DOUBLE PRECISION DEFAULT 0,
      summary_text TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS drain_handoff_logs (
      id BIGSERIAL PRIMARY KEY,
      from_bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      position_id BIGINT DEFAULT 0,
      trade_id BIGINT DEFAULT 0,
      reason TEXT,
      sell_amount DOUBLE PRECISION DEFAULT 0,
      sell_fee DOUBLE PRECISION DEFAULT 0,
      net_proceeds_krw DOUBLE PRECISION DEFAULT 0,
      realized_pnl_krw DOUBLE PRECISION DEFAULT 0,
      allocations_json TEXT,
      remaining_positions_count INTEGER DEFAULT 0,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS capital_restoration_logs (
      id BIGSERIAL PRIMARY KEY,
      source_bot_id TEXT NOT NULL,
      target_bot_id TEXT,
      order_uuid TEXT,
      settled_net_krw DOUBLE PRECISION NOT NULL,
      restored_krw DOUBLE PRECISION NOT NULL,
      surplus_reserve_krw DOUBLE PRECISION DEFAULT 0,
      total_used_after_krw DOUBLE PRECISION NOT NULL,
      global_cap_krw DOUBLE PRECISION NOT NULL,
      total_equity_snapshot_krw DOUBLE PRECISION DEFAULT 0,
      created_at TEXT NOT NULL
    );
    ALTER TABLE capital_restoration_logs ADD COLUMN IF NOT EXISTS total_equity_snapshot_krw DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS strategy_group TEXT DEFAULT 'TREND_SWING';
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS is_selected_for_live INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_initial_capital BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_virtual_krw BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_is_running INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_peak_equity BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_mdd_pct NUMERIC(8,2) NOT NULL DEFAULT 0;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_status_msg TEXT NOT NULL DEFAULT '시그널 대기 중';
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS target_capital_krw DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS drain_status TEXT DEFAULT 'NONE';
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS replaced_by_bot_id TEXT DEFAULT NULL;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS drain_started_at TEXT DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS bot_accounts (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      allocation_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
      allocated_capital DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      virtual_krw DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      total_realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_selected_for_live INTEGER NOT NULL DEFAULT 0
    );
    ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS is_selected_for_live INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'KRW-BTC';
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS ticker TEXT;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS trade_id BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS highest_price DOUBLE PRECISION DEFAULT 0.0;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS step_level INTEGER DEFAULT 1;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_order_uuid TEXT;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_price DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_amount DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS sell_fee DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS realized_pnl DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS pnl_pct DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS buy_reason TEXT;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS expected_price DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS slippage_bps DOUBLE PRECISION;
    ALTER TABLE bot_positions ADD COLUMN IF NOT EXISTS atr_sizing_mult DOUBLE PRECISION DEFAULT 1.0;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS expected_price DOUBLE PRECISION;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS slippage_bps DOUBLE PRECISION;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS atr_sizing_mult DOUBLE PRECISION DEFAULT 1.0;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS buy_reason TEXT;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS sell_reason TEXT;
    ALTER TABLE paper_bot_positions ADD COLUMN IF NOT EXISTS buy_reason TEXT;
    UPDATE bot_positions SET market = ticker WHERE (market IS NULL OR market = '') AND ticker IS NOT NULL AND ticker != '';
    UPDATE bot_positions SET ticker = market WHERE (ticker IS NULL OR ticker = '') AND market IS NOT NULL AND market != '';
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS flash_sentiment_score DOUBLE PRECISION DEFAULT 0.0;
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS flash_recommended_action TEXT DEFAULT 'NORMAL';
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS flash_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS pro_sentiment_score DOUBLE PRECISION DEFAULT 0.0;
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS pro_recommended_action TEXT DEFAULT 'NORMAL';
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS pro_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS final_risk_alert INTEGER DEFAULT 0;
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS final_position_multiplier DOUBLE PRECISION DEFAULT 1.0;
    ALTER TABLE market_regime_filter ADD COLUMN IF NOT EXISTS final_bot_overrides_json TEXT DEFAULT '${DEFAULT_BOT_OVERRIDES_JSON}';
    ALTER TABLE ai_market_briefings ADD COLUMN IF NOT EXISTS decision_json TEXT;
  `);

  await ensureBacktestTables(db);
  await ensureLiveGuardrailTables(db);

  // market_regime_filter id=1 행 보장 및 레거시 3봇 키(bot_vb 등) -> 표준 10대 봇(bot_01~bot_10) 안전 마이그레이션
  try {
    await db
      .prepare(
        "INSERT INTO market_regime_filter (id, bot_overrides_json, final_bot_overrides_json) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING"
      )
      .run(DEFAULT_BOT_OVERRIDES_JSON, DEFAULT_BOT_OVERRIDES_JSON);
    const existingRegime = await db
      .prepare("SELECT bot_overrides_json, final_bot_overrides_json FROM market_regime_filter WHERE id = 1")
      .get();
    if (
      existingRegime &&
      (needsBotOverridesMigration(existingRegime.bot_overrides_json) ||
        needsBotOverridesMigration(existingRegime.final_bot_overrides_json))
    ) {
      const migratedBase = JSON.stringify(normalizeBotOverrides(existingRegime.bot_overrides_json));
      const migratedFinal = JSON.stringify(
        normalizeBotOverrides(existingRegime.final_bot_overrides_json || migratedBase)
      );
      await db
        .prepare("UPDATE market_regime_filter SET bot_overrides_json = ?, final_bot_overrides_json = ? WHERE id = 1")
        .run(migratedBase, migratedFinal);
      console.log("[DB Migration] Upgraded market_regime_filter bot_overrides to 10-bot standard keys (bot_01~bot_10).");
    }
    const curRegimeRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    if (
      curRegimeRow &&
      (curRegimeRow.market_regime === "BEAR" || curRegimeRow.market_regime === "HIGH_VOLATILITY_SHOCK") &&
      curRegimeRow.recommended_action !== "NORMAL" &&
      (Number(curRegimeRow.sentiment_score) > 0 || Number(curRegimeRow.flash_sentiment_score) > 0)
    ) {
      const fixedFlashScore =
        Number(curRegimeRow.flash_sentiment_score) > 0
          ? -Math.abs(Number(curRegimeRow.flash_sentiment_score))
          : Number(curRegimeRow.flash_sentiment_score || 0);
      const fixedProScore =
        Number(curRegimeRow.pro_sentiment_score) > 0
          ? -Math.abs(Number(curRegimeRow.pro_sentiment_score))
          : Number(curRegimeRow.pro_sentiment_score || 0);
      const fixedFinalScore =
        Math.min(fixedFlashScore, fixedProScore) <= -0.5
          ? Number(Math.min(fixedFlashScore, fixedProScore).toFixed(2))
          : Number((0.4 * fixedFlashScore + 0.6 * fixedProScore).toFixed(2));
      const negFinalScore = fixedFinalScore > 0 ? -Math.abs(fixedFinalScore) : fixedFinalScore;
      await db
        .prepare(
          "UPDATE market_regime_filter SET sentiment_score = ?, flash_sentiment_score = ?, pro_sentiment_score = ? WHERE id = 1"
        )
        .run(negFinalScore, fixedFlashScore, fixedProScore);
    }
  } catch (migErr) {
    console.warn("[DB Migration] market_regime_filter migration warning:", migErr.message);
  }

  // 10대 알고리즘 Arena: bots 테이블 스키마 보강 및 봇 시드
  const arenaSchemaInfo = await ensureArenaSchema(db);
  await seedArenaBots(db, { hadSelectionColumn: arenaSchemaInfo.hadSelectionColumn });

  // 주간 자동 로테이션 기본 설정 보장 (id = 1)
  try {
    const nowInit = nowKSTString();
    const defaultNextRot = computeNextRotationKstString(1, 9);
    await db
      .prepare(
        `INSERT INTO auto_rotation_config (
           id, is_enabled, rotation_day_of_week, rotation_hour_kst,
           allocation_mode, min_weekly_trades, capital_tier_1_max, capital_tier_2_max, max_deploy_ratio,
           last_rotated_at, next_rotation_at, updated_at
         ) VALUES (1, 1, 1, 9, 'EQUAL_BY_EQUITY_TIER', 2, 400000, 700000, 0.90, NULL, ?, ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .run(defaultNextRot, nowInit);
    await db
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('capital_basis_mode', 'LIVE_TOTAL_EQUITY_90CAP', ?)
         ON CONFLICT (key) DO NOTHING`
      )
      .run(nowInit);
  } catch (rotSeedErr) {
    console.warn("[DB Migration] auto_rotation_config seed warning:", rotSeedErr.message);
  }

  // 기존에 들어가 있던 샘플(seed) 데이터 및 매수 테스트(order-bid-* / auto-bid-*) 가상 이력 제거
  await db.exec("DELETE FROM bot_positions WHERE order_uuid LIKE 'seed-%' OR order_uuid LIKE 'order-bid-%' OR order_uuid LIKE 'auto-bid-%';");
  await db.exec("DELETE FROM trades WHERE buy_order_uuid LIKE 'seed-%' OR buy_order_uuid LIKE 'order-bid-%' OR buy_order_uuid LIKE 'auto-bid-%';");

  // 실제 매도되지 않고 테스트 버튼(order-ask-*)으로 잘못 매도 완료 처리된 내역을 미매도(HOLDING / OPEN) 상태로 복구
  await db.exec(`
    UPDATE bot_positions
    SET status = 'OPEN', closed_at = NULL
    WHERE trade_id IN (SELECT id FROM trades WHERE sell_order_uuid LIKE 'order-ask-%');
  `);
  await db.exec(`
    UPDATE trades
    SET sell_order_uuid = NULL,
        sell_price = NULL,
        sell_volume = NULL,
        sell_amount = NULL,
        sell_date = NULL,
        profit_krw = NULL,
        profit_pct = NULL,
        status = 'HOLDING'
    WHERE sell_order_uuid LIKE 'order-ask-%';
  `);

  // 테스트 이력 정리 및 복구 후 각 봇의 virtual_krw를 (allocated_capital - 실제 OPEN 포지션 투자금액)으로 동기화
  const allBotsForSync = await db.prepare("SELECT bot_id, allocated_capital FROM bots").all();
  for (const b of allBotsForSync) {
    const inv = await db
      .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
      .get(b.bot_id);
    const syncVirtual = Math.max(0, Math.floor(Number(b.allocated_capital || 0) - Number(inv?.invested || 0)));
    await db.prepare("UPDATE bots SET virtual_krw = ? WHERE bot_id = ?").run(syncVirtual, b.bot_id);
  }

  // 시스템 기본 설정 (기존 값이 없는 경우에만 초기화)
  const now = nowKSTString();
  const setDefault = await db.prepare(
    "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)"
  );
  await setDefault.run("total_capital", "0", now);
  await setDefault.run("capital_configured", "0", now);
  await setDefault.run("zero_balance_halted", "0", now);
  await setDefault.run("zero_balance_reason", "", now);
  await setDefault.run("stats_start_date", "2026-10-01", now);
  await setDefault.run("entry_code", "stock", now);
  await setDefault.run("use_local_ollama_news", String(process.env.USE_LOCAL_OLLAMA_NEWS ?? "true"), now);
  await setDefault.run("ollama_base_url", String(process.env.OLLAMA_BASE_URL || "http://192.168.0.100:11434"), now);
  await setDefault.run("ollama_news_model", String(process.env.OLLAMA_NEWS_MODEL || "qwen3-news"), now);
  await setDefault.run("ollama_timeout_ms", String(process.env.OLLAMA_TIMEOUT_MS || "180000"), now);
}

// [Antigravity-Doc] 라이브러리 모드가 아닐 때 프로세스 기동 직후 DB 스키마 초기화 자동 실행
if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
  try {
    await initializeDatabase();
  } catch (err) {
    if (!isConfigured) {
      console.log("[Setup Mode] DB not yet initialized. Setup wizard will handle configuration.");
    } else {
      console.warn("[Init] Warning initializing database:", err.message);
    }
  }
}

// [Antigravity-Doc] Web Push(VAPID) 공개키/비밀키 메모리 캐시
let vapidPublicKey = "";
let vapidPrivateKey = "";

/**
 * [Antigravity-Doc] `system_settings`에서 VAPID 키 쌍을 로드하거나 없으면 신규 생성·저장한 뒤 `webpush`에 등록한다.
 * @returns {Promise<void>} 부수효과: DB `system_settings` 쓰기 및 `webpush.setVapidDetails` 호출
 */
async function initVapidKeys() {
  try {
    const db = getDb();
    const pubRow = await db.prepare("SELECT value FROM system_settings WHERE key = 'vapid_public_key'").get();
    const privRow = await db.prepare("SELECT value FROM system_settings WHERE key = 'vapid_private_key'").get();

    if (pubRow?.value && privRow?.value) {
      vapidPublicKey = pubRow.value;
      vapidPrivateKey = privRow.value;
    } else {
      const keys = webpush.generateVAPIDKeys();
      vapidPublicKey = keys.publicKey;
      vapidPrivateKey = keys.privateKey;
      const nowStr = nowKSTString();
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('vapid_public_key', ?, ?)").run(vapidPublicKey, nowStr);
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('vapid_private_key', ?, ?)").run(vapidPrivateKey, nowStr);
      console.log("[WebPush] New VAPID keys generated and stored in system_settings.");
    }

    webpush.setVapidDetails(
      "mailto:admin@autocointrade.com",
      vapidPublicKey,
      vapidPrivateKey
    );
    console.log("[WebPush] VAPID details configured successfully.");
  } catch (err) {
    console.warn("[WebPush] Failed to initialize VAPID keys:", err.message);
  }
}

// [Antigravity-Doc] 라이브러리 모드가 아닐 때 프로세스 기동 직후 Web Push VAPID 키 자동 초기화
if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
  try {
    await initVapidKeys();
  } catch (err) {
    // silent in setup mode
  }
}

/**
 * [Antigravity-Doc] `push_subscriptions` 테이블에 등록된 모든 브라우저 구독자에게 Web Push 알림을 병렬 발송한다.
 * 404/410(만료된 구독) 응답을 받은 구독은 DB에서 자동 정리한다.
 * @param {{title?:string, body?:string, data?:object}} params 알림 제목/본문/부가 데이터
 * @returns {Promise<{success:boolean, count:number, total?:number, error?:string}>}
 */
async function broadcastWebPushNotification({ title, body, data = {} }) {
  try {
    const db = getDb();
    const subs = await db.prepare("SELECT * FROM push_subscriptions").all();
    if (!subs || subs.length === 0) {
      console.log(`[WebPush] No push subscribers to notify for: "${body}"`);
      return { success: true, count: 0, total: 0 };
    }

    const payload = JSON.stringify({
      title: title || "AI 뉴스 분석 완료",
      body: body || "ai 분석이 완료되었습니다",
      data: {
        url: "/?menu=news",
        timestamp: Date.now(),
        ...data,
      },
    });

    console.log(`[WebPush] Broadcasting push notification to ${subs.length} subscribers: "${body}"`);

    const expiredIds = [];
    let successCount = 0;

    await Promise.allSettled(
      subs.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };
        try {
          await webpush.sendNotification(pushSubscription, payload, {
            TTL: 3600,
          });
          successCount++;
        } catch (err) {
          console.warn(`[WebPush] Send error to ${sub.endpoint.slice(0, 35)}... :`, err.statusCode || err.message);
          if (err.statusCode === 404 || err.statusCode === 410) {
            expiredIds.push(sub.id);
          }
        }
      })
    );

    if (expiredIds.length > 0) {
      for (const id of expiredIds) {
        await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
      }
      console.log(`[WebPush] Cleaned up ${expiredIds.length} expired subscriptions.`);
    }

    return { success: true, count: successCount, total: subs.length };
  } catch (err) {
    console.warn("[WebPush] Broadcast exception:", err.message);
    return { success: false, count: 0, error: err.message };
  }
}

/**
 * [Antigravity-Doc] `system_settings` 테이블에서 단일 설정 키 값을 조회한다.
 * @param {string} key 설정 키
 * @param {string} [defaultVal=""] 미존재 시 기본값
 * @returns {Promise<string>}
 */
async function getSetting(key, defaultVal = "") {
  const db = getDb();
  const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").get(key);
  return row ? row.value : defaultVal;
}

/**
 * [Antigravity-Doc] 현재 런타임 설정이 실전 매매(live) 모드이고 유효한 업비트 API 키가 설정되었는지 판별한다.
 * 테스트/라이브러리 모드에서는 `AUTOCOIN_FORCE_LIVE_MODE=1`로 강제 활성화할 수 있다.
 * @returns {boolean}
 */
function isLiveMode() {
  if (process.env.AUTOCOIN_FORCE_LIVE_MODE === "1" && process.env.AUTOCOIN_LIBRARY_MODE === "1") {
    return true;
  }
  const cfg = getRuntimeConfig();
  return (
    String(cfg.trade_mode || "").toLowerCase() === "live" &&
    cfg.access_key &&
    cfg.secret_key &&
    cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY" &&
    String(cfg.access_key).trim() !== ""
  );
}

/**
 * [Antigravity-Doc] 매매 모드("live"|"paper")에 대응하는 포지션 테이블명을 반환한다.
 * @param {"live"|"paper"|null} [mode=null] 미지정 시 "live"
 * @returns {"bot_positions"|"paper_bot_positions"}
 */
function getPositionsTableName(mode = null) {
  const m = mode || "live";
  return m === "live" ? "bot_positions" : "paper_bot_positions";
}

/**
 * [Antigravity-Doc] 매매 모드("live"|"paper")에 대응하는 체결 이력 테이블명을 반환한다.
 * @param {"live"|"paper"|null} [mode=null] 미지정 시 "live"
 * @returns {"trades"|"paper_trades"}
 */
function getTradesTableName(mode = null) {
  const m = mode || "live";
  return m === "live" ? "trades" : "paper_trades";
}

/**
 * [Antigravity-Doc] 현재 활성 DB 엔진이 SQLite인지 판별한다 (트랜잭션 구문 `BEGIN IMMEDIATE` vs `BEGIN` 분기용).
 * @returns {boolean}
 */
function isSqliteEngineActive() {
  const mode = (process.env.DB_MODE || "sqlite").trim().toLowerCase();
  const syncEnabled = process.env.PG_SYNC_ENABLED !== "false";
  return mode === "sqlite" || !syncEnabled;
}

/**
 * [Antigravity-Doc] 쓰기 트랜잭션을 시작한다. SQLite에서는 쓰기 경합/데드락 방지를 위해 `BEGIN IMMEDIATE`를 사용한다.
 * @param {object} db 활성 DB 인스턴스
 */
async function beginWriteTx(db) {
  await db.exec(isSqliteEngineActive() ? "BEGIN IMMEDIATE" : "BEGIN");
}

/**
 * [Antigravity-Doc] 진행 중인 쓰기 트랜잭션을 커밋한다.
 * @param {object} db 활성 DB 인스턴스
 */
async function commitWriteTx(db) {
  await db.exec("COMMIT");
}

/**
 * [Antigravity-Doc] 예외 발생 시 진행 중인 쓰기 트랜잭션을 안전하게 롤백한다(이미 종료된 경우 무시).
 * @param {object} db 활성 DB 인스턴스
 */
async function rollbackWriteTx(db) {
  try {
    await db.exec("ROLLBACK");
  } catch {}
}

/**
 * [Antigravity-Doc] 전체 10대 봇 목록과 실시간 평가손익, 가용 원화(`virtual_krw`), 일일 손익 및 서킷브레이커(-4%) 상태를 조합해 반환한다.
 * 실전("live") 조회 시 인플라이트 매수 의도(`live_order_intents` PENDING/SUBMITTED/UNKNOWN_TIMEOUT) 금액을 선차감해 중복 매수를 방지하며,
 * 가상("paper") 조회 시 실전 원장과 완전히 분리된 `paper_*` 컬럼/테이블만 사용한다.
 * @param {"live"|"paper"|null} [mode=null] 조회 모드 (미지정 시 `isLiveMode()` 기준 자동 결정)
 * @returns {Promise<Array<object>>}
 */
export async function getBots(mode = null) {
  const db = getDb();
  if (!db) return [];
  const rows = await db.prepare("SELECT * FROM bots ORDER BY bot_id ASC").all();
  const effectiveMode = mode || (isLiveMode() ? "live" : "paper");
  const isPaperQuery = effectiveMode === "paper";
  const posTable = getPositionsTableName(effectiveMode);
  const tradesTable = getTradesTableName(effectiveMode);
  const todayStartKst = `${nowKSTString().split(" ")[0]} 00:00:00`;
  const result = [];
  for (const r of rows) {
    let config = {};
    try {
      config = JSON.parse(r.config_json || "{}");
    } catch {}
    const openPositionsRaw = await db
      .prepare(`SELECT * FROM ${posTable} WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC`)
      .all(r.bot_id);
    const openPositions = openPositionsRaw.map((p) => {
      const mkt = p.market || p.ticker || "";
      const avgBuy = Number(p.avg_buy_price || 0);
      const vol = Number(p.volume || 0);
      const buyAmt = Math.floor(Number(p.buy_amount || 0));
      let curPrice = avgBuy;
      try {
        const wsTk = typeof upbitWsHub?.getLatestTicker === "function" ? upbitWsHub.getLatestTicker(mkt) : null;
        const cachedTk = typeof upbitTickersCache !== "undefined" ? upbitTickersCache.get(mkt)?.data : null;
        const rawCur = Number(wsTk?.trade_price || cachedTk?.trade_price || 0);
        if (rawCur > 0) curPrice = rawCur;
      } catch {}
      const evalAmt = curPrice > 0 && vol > 0 ? Math.floor(curPrice * vol) : buyAmt;
      const unrealizedPnlKrw = Math.floor(evalAmt - buyAmt);
      const unrealizedPnlPct =
        avgBuy > 0 && curPrice > 0 ? Number((((curPrice - avgBuy) / avgBuy) * 100).toFixed(2)) : 0;
      return {
        ...p,
        market: mkt,
        current_price: curPrice,
        eval_amount: evalAmt,
        unrealized_pnl_krw: unrealizedPnlKrw,
        unrealized_pnl_pct: unrealizedPnlPct,
      };
    });
    const usedCapital = Math.floor(
      openPositions.reduce((acc, p) => acc + Number(p.buy_amount || 0), 0)
    );
    const evalCapital = Math.floor(
      openPositions.reduce((acc, p) => acc + Number(p.eval_amount ?? p.buy_amount ?? 0), 0)
    );
    const unrealizedPnlKrw = Math.floor(evalCapital - usedCapital);
    const unrealizedPnlPct =
      usedCapital > 0 ? Number((((evalCapital - usedCapital) / usedCapital) * 100).toFixed(2)) : 0;
    const isSelected = Number(r.is_selected_for_live || 0) === 1;
    // 가상(paper) 모드 조회 시 실전 원장 컬럼(allocated_capital/virtual_krw)과 완전 분리
    let virtualKrw = 0;
    let allocatedCap = 0;
    if (isPaperQuery) {
      allocatedCap = Math.max(0, Math.floor(Number(r.paper_initial_capital || 1000000)));
      virtualKrw = Math.max(0, Math.floor(Number(r.paper_virtual_krw ?? Math.max(0, allocatedCap - usedCapital))));
    } else {
      // 탈락(비선택/Draining) 봇의 가용 원화는 항상 0으로 고정
      // 활성 봇은 (allocated - used - 인플라이트 선차감액) 기준 산출하되, DB virtual_krw < 0 이상치는 클램핑하지 않고 그대로 노출해 가드레일 Kill-Switch 감지를 보장
      allocatedCap = Number(r.allocated_capital || 0);
      let pendingReserved = 0;
      try {
        const pr = await db
          .prepare(
            `SELECT COALESCE(SUM(requested_krw), 0) AS pending_krw
             FROM live_order_intents
             WHERE bot_id = ? AND side = 'BUY' AND refunded = 0
               AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT')`
          )
          .get(r.bot_id);
        pendingReserved = Math.max(0, Math.floor(Number(pr?.pending_krw || 0)));
      } catch {}
      const rawDbVirtual = Math.floor(Number(r.virtual_krw || 0));
      const allocMinusUsed = Math.max(0, Math.floor(allocatedCap - usedCapital - pendingReserved));
      if (!isSelected) {
        virtualKrw = 0;
      } else if (rawDbVirtual < 0) {
        virtualKrw = rawDbVirtual;
      } else if (allocatedCap === 0 && usedCapital === 0 && rawDbVirtual > 0) {
        virtualKrw = rawDbVirtual;
      } else {
        virtualKrw = allocMinusUsed;
      }
    }

    let dailyProfit = 0;
    try {
      const dailyRow = await db
        .prepare(`SELECT COALESCE(SUM(profit_krw), 0) AS daily_profit FROM ${tradesTable} WHERE bot_id = ? AND status = 'COMPLETED' AND sell_date >= ?`)
        .get(r.bot_id, todayStartKst);
      dailyProfit = Number(dailyRow?.daily_profit || 0);
    } catch {}

    const dailyLossLimit = allocatedCap > 0 ? -Math.floor(allocatedCap * 0.04) : -40000;
    const isCircuitBreaker = !isPaperQuery && isSelected && allocatedCap > 0 && dailyProfit <= dailyLossLimit;

    const meta = getBotStrategyMeta(r.bot_id);

    result.push({
      ...r,
      ...meta,
      allocated_capital: isPaperQuery ? allocatedCap : r.allocated_capital,
      virtual_krw: virtualKrw,
      config,
      open_positions: openPositions,
      used_capital: usedCapital,
      eval_capital: evalCapital,
      unrealized_pnl_krw: unrealizedPnlKrw,
      unrealized_pnl_pct: unrealizedPnlPct,
      daily_profit_krw: dailyProfit,
      daily_loss_limit_krw: dailyLossLimit,
      circuit_breaker_active: isCircuitBreaker,
    });
  }
  return result;
}

/**
 * [Antigravity-Doc] 총 운용 원금(`flooredTotal`)과 봇별 배분 비율(`ratiosMap`)을 바탕으로 각 봇의 `allocated_capital` 및
 * 가용 잔고(`virtual_krw`)를 1원 오차 없이(Zero-Sum Invariant) 재계산하고 DB에 반영한다.
 * 핵심 알고리즘:
 *  - 이미 보유 중인 OPEN 포지션 + 인플라이트 매수 예약금(`used`)이 자신의 비율 배당분보다 큰 봇은 `locked`로 고정(virtual_krw=0).
 *  - 나머지 잔여 풀(`remainingPool`)을 미잠금 활성 봇들에게 비율대로 재분배하며, 소수점 절삭 자투리는 최우선 순위 봇에 귀속.
 * @param {number} flooredTotal 정수 절삭된 총 배분 원금(KRW)
 * @param {Record<string, number>|null} [ratiosMap=null] 봇별 배분 비율(%) 맵 (미지정 시 DB 기존 비율 사용)
 * @param {"live"|"paper"|null} [mode=null] 대상 모드
 * @param {{rankPriorityMap?:Record<string,number>, skipAccountSync?:boolean}} [options={}]
 * @returns {Promise<{totalUsed:number, totalAllocated:number, totalVirtual:number, remainderDustAwarded:number}>}
 */
export async function recalculateAndApplyBotAllocations(flooredTotal, ratiosMap = null, mode = null, options = {}) {
  const db = getDb();
  const now = nowKSTString();
  const bots = await getBots(mode);
  const tradesTable = getTradesTableName(mode);
  const rankPriorityMap = options?.rankPriorityMap || {};
  const items = [];
  for (const b of bots) {
    let pendingReserved = 0;
    if ((mode || (isLiveMode() ? "live" : "paper")) === "live") {
      try {
        const pr = await db
          .prepare(
            `SELECT COALESCE(SUM(requested_krw), 0) AS pending_krw
             FROM live_order_intents
             WHERE bot_id = ? AND side = 'BUY' AND refunded = 0
               AND status IN ('PENDING', 'SUBMITTED', 'UNKNOWN_TIMEOUT')`
          )
          .get(b.bot_id);
        pendingReserved = Math.max(0, Math.floor(Number(pr?.pending_krw || 0)));
      } catch {}
    }
    const used = Math.floor(Number(b.used_capital || 0)) + pendingReserved;
    const isSelected = Number(b.is_selected_for_live || 0) === 1;
    const ratio = !isSelected
      ? 0
      : Math.max(
          0,
          Number(ratiosMap && ratiosMap[b.bot_id] !== undefined ? ratiosMap[b.bot_id] : b.allocation_ratio || 0)
        );
    const pnlRow = await db
      .prepare(`SELECT COALESCE(SUM(profit_krw), 0) AS total_pnl FROM ${tradesTable} WHERE bot_id = ? AND status = 'COMPLETED'`)
      .get(b.bot_id);
    const realizedPnl = Math.floor(Number(pnlRow?.total_pnl || 0));
    const rankOrder = Number.isFinite(Number(rankPriorityMap[b.bot_id])) ? Number(rankPriorityMap[b.bot_id]) : 999;
    items.push({
      bot_id: b.bot_id,
      isSelected,
      used,
      ratio,
      rankOrder,
      realizedPnl,
      allocated: 0,
      virtual_krw: 0,
      locked: false,
    });
  }

  const totalUsed = items.reduce((acc, it) => acc + it.used, 0);

  if (flooredTotal <= 0) {
    for (const it of items) {
      await db.prepare(
        "UPDATE bots SET allocation_ratio = ?, allocated_capital = ?, virtual_krw = 0, updated_at = ? WHERE bot_id = ?"
      ).run(it.ratio, it.used, now, it.bot_id);
    }
    if (!options?.skipAccountSync) {
      await syncBotAccountsFromBots(db);
    }
    return { totalUsed, totalAllocated: totalUsed, totalVirtual: 0, remainderDustAwarded: 0 };
  }

  const totalRatio = Number(items.reduce((acc, it) => acc + it.ratio, 0).toFixed(4));
  const targetPool =
    totalRatio >= 99.99
      ? flooredTotal
      : Math.max(totalUsed, Math.floor(flooredTotal * (totalRatio / 100.0)));

  // 이미 사용된 투자금(used)을 우선 반영하고, 잔여(신규 투입 포함) 투자금을 비율대로 분배하여
  // 전체 투자금 총액과 각 봇별 배정 원금(이미 사용 + 가용 잔고)의 합계가 1원 오차 없이 일치하도록 계산
  let remainderDustAwarded = 0;
  while (true) {
    const unlocked = items.filter((it) => !it.locked);
    if (unlocked.length === 0) break;

    const lockedAllocatedSum = items
      .filter((it) => it.locked)
      .reduce((acc, it) => acc + it.allocated, 0);
    const remainingPool = Math.max(0, targetPool - lockedAllocatedSum);
    const unlockedRatioSum = unlocked.reduce((acc, it) => acc + it.ratio, 0);

    let anyNewlyLocked = false;
    for (const it of unlocked) {
      const share =
        unlockedRatioSum > 0
          ? Math.floor((remainingPool * it.ratio) / unlockedRatioSum)
          : Math.floor(remainingPool / unlocked.length);
      if (it.used > share) {
        it.allocated = it.used;
        it.virtual_krw = 0;
        it.locked = true;
        anyNewlyLocked = true;
      }
    }

    if (!anyNewlyLocked) {
      let distributed = 0;
      for (const it of unlocked) {
        const share =
          unlockedRatioSum > 0
            ? Math.floor((remainingPool * it.ratio) / unlockedRatioSum)
            : 0;
        it.allocated = share;
        distributed += share;
      }
      const remainder = remainingPool - distributed;
      if (remainder > 0 && unlockedRatioSum > 0) {
        const candidates = [...unlocked]
          .filter((it) => it.ratio > 0)
          .sort((a, b) => b.ratio - a.ratio || a.rankOrder - b.rankOrder || a.bot_id.localeCompare(b.bot_id));
        if (candidates.length > 0) {
          candidates[0].allocated += remainder;
          remainderDustAwarded += remainder;
        }
      }
      for (const it of unlocked) {
        it.virtual_krw = it.isSelected ? Math.max(0, it.allocated - it.used) : 0;
        it.locked = true;
      }
      break;
    }
  }

  // 극단적 포지션 잠김 후 자투리 원화가 남는 경우 1위 활성 봇에 최종 보정 (Zero-Sum Invariant)
  const allocatedSumAfterLoop = items.reduce((acc, it) => acc + it.allocated, 0);
  const residualDust = Math.max(0, targetPool - allocatedSumAfterLoop);
  if (residualDust > 0) {
    const activeTop = items
      .filter((it) => it.isSelected && it.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio || a.rankOrder - b.rankOrder || a.bot_id.localeCompare(b.bot_id))[0];
    if (activeTop) {
      activeTop.allocated += residualDust;
      activeTop.virtual_krw = Math.max(0, activeTop.allocated - activeTop.used);
      remainderDustAwarded += residualDust;
    }
  }

  for (const it of items) {
    await db.prepare(
      "UPDATE bots SET allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, updated_at = ? WHERE bot_id = ?"
    ).run(it.ratio, it.allocated, it.isSelected ? it.virtual_krw : 0, now, it.bot_id);
  }
  if (!options?.skipAccountSync) {
    await syncBotAccountsFromBots(db);
  }

  return {
    totalUsed,
    totalAllocated: items.reduce((acc, it) => acc + it.allocated, 0),
    totalVirtual: items.reduce((acc, it) => acc + (it.isSelected ? it.virtual_krw : 0), 0),
    remainderDustAwarded,
  };
}

/**
 * [Antigravity-Doc] 실전 운용 원금 또는 활성 봇 가용 잔고(보유 포지션 0건 기준)가 0원 이하로 떨어졌는지 검사하고,
 * 해당 시 전체 봇을 즉시 중지(`is_running=0`)하며 `zero_balance_halted=1` 플래그와 다채널 긴급 알림을 발송한다.
 * @param {"live"|"paper"|null} [mode=null] paper 모드에서는 항상 중단하지 않고 통과
 * @returns {Promise<{halted:boolean, reason:string}>}
 */
async function checkAndHaltIfZeroBalance(mode = null) {
  const db = getDb();
  if (mode === "paper") {
    return { halted: false, reason: "" };
  }
  const configured = await getSetting("capital_configured", "0") === "1";
  if (!configured) {
    return { halted: false, reason: "" };
  }
  const totalCapital = Math.floor(Number(await getSetting("total_capital", "0")));
  const bots = (await getBots("live")).filter((b) => Number(b.is_selected_for_live) === 1);
  const totalVirtual = bots.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
  const posTable = getPositionsTableName(mode || "live");
  const openPosRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM ${posTable} WHERE status = 'OPEN'`).get();
  const openPosCnt = Number(openPosRow?.cnt || 0);

  let shouldHalt = false;
  let reason = "";
  if (totalCapital <= 0) {
    shouldHalt = true;
    reason = `설정된 운용 원금(${totalCapital.toLocaleString()}원)이 0원 이하이므로 모든 봇이 자동 거래 중지되었습니다.`;
  } else if (totalVirtual <= 0 && openPosCnt === 0) {
    shouldHalt = true;
    reason = `가용 가상 잔고(${totalVirtual.toLocaleString()}원)가 0원 이하로 떨어져 모든 봇이 자동 거래 중지되었습니다.`;
  }

  if (shouldHalt) {
    const prevHalted = (await getSetting("zero_balance_halted", "0")) === "1";
    const now = nowKSTString();
    await db.prepare("UPDATE bots SET is_running = 0, last_status_msg = ?, updated_at = ?").run(
      "잔고 0 이하 도달로 긴급 자동 중지됨",
      now
    );
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '1', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', ?, ?)").run(reason, now);
    if (!prevHalted) {
      dispatchMultiChannelNotification(
        db,
        {
          eventType: "ZERO_BALANCE_HALT",
          reason,
        },
        { webPushBroadcastFn: broadcastWebPushNotification }
      ).catch(() => {});
    }
    return { halted: true, reason };
  }
  return {
    halted: await getSetting("zero_balance_halted", "0") === "1",
    reason: await getSetting("zero_balance_reason", ""),
  };
}

/**
 * [Antigravity-Doc] 업비트 Open API Private 요청용 HS256 JWT 인증 토큰을 생성한다.
 * 쿼리/바디 파라미터가 있으면 SHA-512 `query_hash`를 페이로드에 포함한다.
 * @param {string} accessKey 업비트 Access Key
 * @param {string} secretKey 업비트 Secret Key
 * @param {Record<string, string>|null} [queryParams=null] 서명할 쿼리/요청 파라미터
 * @returns {string} `header.payload.signature` JWT 문자열
 */
function createUpbitJwt(accessKey, secretKey, queryParams = null) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payloadObj = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  if (queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(queryParams).toString();
    payloadObj.query_hash = crypto.createHash("sha512").update(qs, "utf-8").digest("hex");
    payloadObj.query_hash_alg = "SHA512";
  }
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// [Antigravity-Doc] 업비트 상장 KRW 마켓 코드 캐시 (프로세스 수명 동안 유지)
let cachedValidKrwMarkets = new Set();

/**
 * [Antigravity-Doc] 업비트 전체 상장 KRW 마켓 목록(`KRW-*`)을 조회해 메모리에 캐싱한다.
 * @param {number} [timeoutMs=5000] 요청 타임아웃(ms)
 * @returns {Promise<Set<string>>}
 */
async function getValidKrwMarkets(timeoutMs = 5000) {
  if (cachedValidKrwMarkets.size > 0) {
    return cachedValidKrwMarkets;
  }
  try {
    await new Promise((r) => setTimeout(r, 120));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://api.upbit.com/v1/market/all?isDetails=false", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 200) {
      const list = await resp.json();
      if (Array.isArray(list)) {
        cachedValidKrwMarkets = new Set(
          list.map((m) => m.market).filter((m) => typeof m === "string" && m.startsWith("KRW-"))
        );
      }
    }
  } catch {}
  return cachedValidKrwMarkets;
}

/**
 * [Antigravity-Doc] 업비트 실계좌(`/v1/accounts`)와 보유 코인 현재가(`/v1/ticker`)를 조회하여
 * 주문 가능 원화(`orderable_krw`), 총 매수금액, 총 평가금액, 총 평가자산(`total_asset_krw`), 평가손익을 계산한다.
 * 부수효과: 업비트 Private/Public REST API 호출 (0.12s 레이트 리밋 슬립 포함)
 * @returns {Promise<object>} 계좌 잔고 및 평가자산 요약 객체
 */
async function fetchUpbitAccountBalance() {
  const cfg = getRuntimeConfig();

  const accessKey = String(cfg.access_key || "").trim();
  const secretKey = String(cfg.secret_key || "").trim();
  const timeoutMs = Number(cfg.request_timeout_sec || 5) * 1000;
  const checkedAt = nowKSTString();

  if (
    !accessKey ||
    !secretKey ||
    accessKey === "YOUR_UPBIT_ACCESS_KEY" ||
    secretKey === "YOUR_UPBIT_SECRET_KEY"
  ) {
    return {
      success: false,
      krw_balance: null,
      orderable_krw: null,
      total_buy_krw: null,
      total_eval_krw: null,
      eval_profit_krw: null,
      eval_profit_pct: null,
      krw_locked: null,
      krw_total: null,
      message: "업비트 Open API Key가 설정되지 않았습니다 (config/upbit_config.json 확인 필요)",
      checked_at: checkedAt,
    };
  }

  try {
    await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
    const token = createUpbitJwt(accessKey, secretKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://api.upbit.com/v1/accounts", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (resp.status === 200) {
      const accounts = await resp.json();
      const accList = Array.isArray(accounts) ? accounts : [];
      const krwAcc = accList.find((a) => a.currency === "KRW") || null;
      const available = Math.floor(Number(krwAcc?.balance || 0));
      const locked = Math.floor(Number(krwAcc?.locked || 0));
      const total = Math.floor(Number(krwAcc?.balance || 0) + Number(krwAcc?.locked || 0));

      const coinHoldings = accList.filter(
        (a) =>
          a.currency !== "KRW" &&
          Number(a.balance || 0) + Number(a.locked || 0) > 0
      );

      let totalBuySum = 0;
      let totalEvalSum = 0;

      if (coinHoldings.length > 0) {
        const validMarkets = await getValidKrwMarkets(timeoutMs);
        const targetMarkets = coinHoldings
          .map((a) => `KRW-${a.currency}`)
          .filter((m) => validMarkets.size === 0 || validMarkets.has(m));

        const priceMap = new Map();
        if (targetMarkets.length > 0) {
          try {
            await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
            const tCtrl = new AbortController();
            const tTimer = setTimeout(() => tCtrl.abort(), timeoutMs);
            const tResp = await fetch(
              `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(targetMarkets.join(","))}`,
              { signal: tCtrl.signal }
            );
            clearTimeout(tTimer);
            if (tResp.status === 200) {
              const tickers = await tResp.json();
              if (Array.isArray(tickers)) {
                for (const tk of tickers) {
                  priceMap.set(tk.market, Number(tk.trade_price || 0));
                }
              }
            }
          } catch {}
        }

        for (const c of coinHoldings) {
          const qty = Number(c.balance || 0) + Number(c.locked || 0);
          const avgBuyPrice = Number(c.avg_buy_price || 0);
          const buyAmt = qty * avgBuyPrice;
          const mkt = `KRW-${c.currency}`;
          const curPrice = priceMap.has(mkt) ? priceMap.get(mkt) : avgBuyPrice;
          const evalAmt = qty * curPrice;

          totalBuySum += buyAmt;
          totalEvalSum += evalAmt;
        }
      }

      const totalBuyKrw = Math.floor(totalBuySum);
      const totalEvalKrw = Math.floor(totalEvalSum);
      const totalAssetKrw = Math.floor(total + totalEvalSum);
      const evalProfitKrw = totalEvalKrw - totalBuyKrw;
      const evalProfitPct =
        totalBuyKrw > 0 ? Number(((evalProfitKrw / totalBuyKrw) * 100).toFixed(2)) : 0;

      return {
        success: true,
        krw_balance: available,
        orderable_krw: available,
        total_buy_krw: totalBuyKrw,
        total_eval_krw: totalEvalKrw,
        total_asset_krw: totalAssetKrw,
        eval_profit_krw: evalProfitKrw,
        eval_profit_pct: evalProfitPct,
        krw_locked: locked,
        krw_total: total,
        message: "업비트 실계좌 자산 및 잔고 조회 완료",
        checked_at: checkedAt,
      };
    } else {
      const errBody = await resp.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || errBody?.error?.name || `HTTP ${resp.status}`;
      return {
        success: false,
        krw_balance: null,
        orderable_krw: null,
        total_buy_krw: null,
        total_eval_krw: null,
        total_asset_krw: null,
        eval_profit_krw: null,
        eval_profit_pct: null,
        krw_locked: null,
        krw_total: null,
        message: `업비트 계좌 잔고 조회 실패: ${errMsg}`,
        checked_at: checkedAt,
      };
    }
  } catch (err) {
    return {
      success: false,
      krw_balance: null,
      orderable_krw: null,
      total_buy_krw: null,
      total_eval_krw: null,
      total_asset_krw: null,
      eval_profit_krw: null,
      eval_profit_pct: null,
      krw_locked: null,
      krw_total: null,
      message: `업비트 계좌 잔고 조회 통신 오류: ${err.message}`,
      checked_at: checkedAt,
    };
  }
}

// ============================================================================
// [방식 A 통합] 업비트 실시간 총 평가자산(E_total) 기반 단일 90% 상한(C_max) 자동 동기화
// - 90% 이중 차감(0.9 * 0.9 = 81%) 원천 금지: E_total과 C_max를 분리 저장
// - 주중 자동 동기화는 선출 봇 개수(1~3개)를 임의 변경하지 않으며,
//   reconcileAutoSyncedBudgetsWith90Cap()을 통해 Draining 차감액을 절대 덮어쓰지 않음
// ============================================================================
// [Antigravity-Doc] 동적 자본 동기화 스로틀링 타임스탬프 (3초 이내 중복 호출 시 캐시 반환)
let lastDynamicSyncMs = 0;
/**
 * [Antigravity-Doc] 업비트 실시간 총 평가자산(`E_total`)을 조회해 단일 90% 상한(`C_max`)을 산출하고,
 * `withDbWriteLock` + 쓰기 트랜잭션 안에서 `system_settings` 및 활성/드레인 봇 예산을 원자적으로 동기화한다.
 * 커밋 직전 `assertGlobal90CapInvariant`로 전체 사용 자본이 90% 상한을 넘지 않음을 검증한다.
 * @param {boolean} [force=false] true 시 3초 스로틀 무시
 * @param {object|null} [preloadedAccount=null] 이미 조회된 업비트 계좌 객체 재사용
 * @returns {Promise<object>} 동기화 결과 (`total_equity_krw`, `global_cap_krw`, `allocResult` 등)
 */
export async function syncDynamicLiveCapitalFromUpbit(force = false, preloadedAccount = null) {
  const nowMs = Date.now();
  if (!force && !preloadedAccount && nowMs - lastDynamicSyncMs < 3000) {
    const currentCap = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));
    const cachedEquity = Math.floor(Number(await getSetting("last_synced_total_equity_krw", "0")));
    return { success: true, total_asset_krw: cachedEquity, total_capital: currentCap, cached: true };
  }
  if (isCapitalRebalancing) {
    const currentCap = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));
    const cachedEquity = Math.floor(Number(await getSetting("last_synced_total_equity_krw", "0")));
    return { success: true, total_asset_krw: cachedEquity, total_capital: currentCap, skipped_rebalancing: true };
  }
  lastDynamicSyncMs = nowMs;

  try {
    const accountInfo = preloadedAccount || (await fetchUpbitAccountBalance());
    if (!accountInfo || !accountInfo.success) {
      const currentCap = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));
      const cachedEquity = Math.floor(Number(await getSetting("last_synced_total_equity_krw", "0")));
      return {
        success: false,
        total_asset_krw: cachedEquity,
        total_capital: currentCap,
        reason: accountInfo?.message || "업비트 계좌 조회 실패 (직전 정상 총 평가자산 Fallback 유지)",
      };
    }

    const rawAsset = Number(accountInfo.total_asset_krw ?? accountInfo.krw_total ?? accountInfo.krw_balance ?? 0);
    const totalAsset = Math.floor(rawAsset);
    const actualOrderableKrw =
      accountInfo.orderable_krw !== null && accountInfo.orderable_krw !== undefined && Number.isFinite(Number(accountInfo.orderable_krw))
        ? Math.max(0, Math.floor(Number(accountInfo.orderable_krw)))
        : null;

    const now = nowKSTString();
    const db = getDb();

    if (totalAsset <= 0) {
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', '0', ?)").run(now);
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('deployable_capital_cap_krw', '0', ?)").run(now);
      await checkAndHaltIfZeroBalance("live");
      return { success: false, total_asset_krw: 0, total_capital: 0, reason: "업비트 잔고가 0원 이하입니다." };
    }

    const rotCfg = await getAutoRotationConfig(db);
    const { totalEquityKrw, globalCapKrw: dynamicTotalCapital, maxDeployRatio } = resolveTotalEquityAndSingle90Cap({
      liveTotalEquityKrw: totalAsset,
      maxDeployRatio: rotCfg.max_deploy_ratio,
    });

    const allocResult = await withDbWriteLock(async () => {
      if (isCapitalRebalancing) {
        return { skipped_rebalancing: true };
      }
      isCapitalRebalancing = true;
      try {
        await beginWriteTx(db);
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('last_synced_total_equity_krw', ?, ?)").run(
          String(totalEquityKrw),
          now
        );
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('deployable_capital_cap_krw', ?, ?)").run(
          String(dynamicTotalCapital),
          now
        );
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(
          String(dynamicTotalCapital),
          now
        );
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_basis_mode', 'LIVE_TOTAL_EQUITY_90CAP', ?)").run(now);
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(now);
        if (dynamicTotalCapital >= 5253 && (await getSetting("zero_balance_halted", "0")) === "1") {
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)").run(now);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)").run(now);
        }

        let resObj = null;
        if (isEquityTierAllocationMode(rotCfg.allocation_mode)) {
          const liveBotsAll = await getBots("live");
          const botsInput = liveBotsAll.map((b) => ({
            bot_id: b.bot_id,
            strategy_group: b.strategy_group_code || b.strategy_group || getBotStrategyMeta(b.bot_id).strategy_group_code,
            is_selected_for_live: Number(b.is_selected_for_live || 0),
            open_locked_krw: Math.max(0, Math.floor(Number(b.used_capital || 0))),
            replaced_by_bot_id: b.replaced_by_bot_id || null,
          }));
          const reconciled = reconcileAutoSyncedBudgetsWith90Cap({
            totalEquityKrw,
            allBots: botsInput,
            actualAvailableKrw: actualOrderableKrw,
            maxDeployRatio,
          });
          for (const ea of reconciled.electedAllocations) {
            const nextAllocCap = ea.own_locked_krw + ea.virtual_krw;
            const ratioPct =
              reconciled.electedAllocations.length === 1
                ? 100
                : reconciled.electedAllocations.length === 2
                ? 50
                : Number((100 / reconciled.electedAllocations.length).toFixed(2));
            await db
              .prepare(
                `UPDATE bots
                 SET allocation_ratio = ?, target_capital_krw = ?, allocated_capital = ?, virtual_krw = ?, updated_at = ?
                 WHERE bot_id = ?`
              )
              .run(ratioPct, ea.target_capital_krw, nextAllocCap, ea.virtual_krw, now, ea.bot_id);
          }
          for (const da of reconciled.drainingAssignments) {
            await db
              .prepare(
                `UPDATE bots
                 SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0,
                     target_capital_krw = 0, allocated_capital = ?, virtual_krw = 0,
                     drain_status = 'DRAINING', replaced_by_bot_id = ?, updated_at = ?
                 WHERE bot_id = ?`
              )
              .run(da.open_locked_krw, da.replaced_by_bot_id, now, da.bot_id);
          }
          // 커밋 전 DB 단일 90% 불변식 검증
          const vBots = await db.prepare("SELECT virtual_krw FROM bots").all();
          const vOpen = await db.prepare("SELECT COALESCE(SUM(buy_amount), 0) AS total_locked FROM bot_positions WHERE status = 'OPEN'").get();
          const vUsed =
            Math.max(0, Math.floor(Number(vOpen?.total_locked || 0))) +
            vBots.reduce((acc, row) => acc + Math.max(0, Math.floor(Number(row.virtual_krw || 0))), 0);
          assertGlobal90CapInvariant({
            totalEquityKrw,
            totalUsedCapital: vUsed,
            maxDeployRatio,
            context: "syncDynamicLiveCapitalFromUpbit:DB_COMMIT",
          });
          await syncBotAccountsFromBots(db);
          resObj = reconciled;
        } else {
          resObj = await recalculateAndApplyBotAllocations(dynamicTotalCapital, null, "live", { skipAccountSync: true });
          await syncBotAccountsFromBots(db);
        }

        await commitWriteTx(db);
        return resObj;
      } catch (txErr) {
        await rollbackWriteTx(db);
        throw txErr;
      } finally {
        isCapitalRebalancing = false;
      }
    });

    // 실전 자산 월별 스냅샷 실시간 동기화
    syncMonthlyAssetSnapshot("live", accountInfo).catch(() => {});

    return {
      success: true,
      total_asset_krw: totalEquityKrw,
      total_equity_krw: totalEquityKrw,
      global_cap_krw: dynamicTotalCapital,
      total_capital: dynamicTotalCapital,
      allocResult,
    };
  } catch (err) {
    console.error("[syncDynamicLiveCapitalFromUpbit] Error:", err.message);
    const currentCap = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));
    return { success: false, total_capital: currentCap, error: err.message };
  }
}

// ============================================================================
// 월별 보유 자산 스냅샷 자동 동기화 및 기록 함수
// - 이번달 1일 시점 평가자산과 현재 시점 평가자산, 증감액/증감률 기록
// - 매달 영구 보존 및 월별 자산 증감 그래프 데이터 제공
// ============================================================================
/**
 * [Antigravity-Doc] 월별 보유 자산 스냅샷(`monthly_asset_snapshots`)을 현재 평가자산 기준으로 갱신/생성하고,
 * 누적 월별 이력(`history`)과 당월 증감액/증감률(`current_month`)을 반환한다.
 * @param {"live"|"paper"} [targetMode="live"] 대상 모드
 * @param {object|null} [forcedAccountInfo=null] 실전 모드에서 사전 조회된 업비트 계좌 정보
 * @returns {Promise<{success:boolean, mode:string, current_month:object|null, history:Array<object>, updated_at:string}>}
 */
async function syncMonthlyAssetSnapshot(targetMode = "live", forcedAccountInfo = null) {
  const db = getDb();
  const kstNow = nowKSTString();
  const curDateStr = kstNow.slice(0, 10); // YYYY-MM-DD
  const curYearMonth = curDateStr.slice(0, 7); // YYYY-MM
  const curFirstDayStr = `${curYearMonth}-01`;

  let totalAsset = 0;
  let krwBal = 0;
  let coinEval = 0;

  if (targetMode === "live") {
    let acc = forcedAccountInfo;
    if (!acc) {
      try {
        acc = await fetchUpbitAccountBalance();
      } catch {}
    }
    if (acc?.success && acc.total_asset_krw !== null) {
      totalAsset = Math.floor(Number(acc.total_asset_krw));
      krwBal = Math.floor(Number(acc.krw_total ?? acc.krw_balance ?? 0));
      coinEval = Math.floor(Number(acc.total_eval_krw ?? 0));
    } else {
      const lastSnap = await db
        .prepare("SELECT * FROM monthly_asset_snapshots WHERE mode = 'live' ORDER BY year_month DESC LIMIT 1")
        .get();
      if (lastSnap) {
        totalAsset = lastSnap.current_balance;
        krwBal = lastSnap.krw_balance;
        coinEval = lastSnap.coin_eval_balance;
      } else {
        totalAsset = Number(process.env.INITIAL_TOTAL_CAPITAL || 10000000);
        krwBal = totalAsset;
        coinEval = 0;
      }
    }
  } else {
    // paper 모드: 10대 봇 자산 및 포지션 평가액 합산
    try {
      const bots = await db.prepare("SELECT paper_virtual_krw FROM bots").all();
      const pos = await db.prepare("SELECT buy_amount FROM paper_bot_positions WHERE status = 'OPEN'").all();
      let paperKrw = 0;
      for (const b of bots) paperKrw += Number(b.paper_virtual_krw || 0);
      let paperCoin = 0;
      for (const p of pos) paperCoin += Number(p.buy_amount || 0);
      totalAsset = Math.floor(paperKrw + paperCoin);
      krwBal = Math.floor(paperKrw);
      coinEval = Math.floor(paperCoin);
    } catch {
      totalAsset = 10000000;
      krwBal = 10000000;
      coinEval = 0;
    }
  }

  // 1. 현재 월 레코드 조회
  const existing = await db
    .prepare("SELECT * FROM monthly_asset_snapshots WHERE year_month = ? AND mode = ?")
    .get(curYearMonth, targetMode);

  if (existing) {
    const startBal = Number(existing.month_start_balance || totalAsset);
    const diffAmt = Math.floor(totalAsset - startBal);
    const diffRate = startBal > 0 ? Number(((diffAmt / startBal) * 100).toFixed(2)) : 0;

    await db.prepare(`
      UPDATE monthly_asset_snapshots
      SET current_balance = ?,
          krw_balance = ?,
          coin_eval_balance = ?,
          diff_amount = ?,
          diff_rate = ?,
          updated_at = ?
      WHERE year_month = ? AND mode = ?
    `).run(totalAsset, krwBal, coinEval, diffAmt, diffRate, kstNow, curYearMonth, targetMode);
  } else {
    // 이전 달 레코드 확인
    const prevList = await db
      .prepare("SELECT * FROM monthly_asset_snapshots WHERE year_month < ? AND mode = ? ORDER BY year_month DESC LIMIT 1")
      .all(curYearMonth, targetMode);

    let startBal = totalAsset;
    if (prevList && prevList.length > 0) {
      startBal = Number(prevList[0].current_balance);
    } else {
      // 2026-10 (통계 시작월) 초기 시드 생성
      if (curYearMonth > "2026-10") {
        const octStart = targetMode === "live" ? 60000 : 10000000;
        const octEnd = targetMode === "live" ? 68000 : totalAsset;
        const octDiff = octEnd - octStart;
        const octRate = octStart > 0 ? Number(((octDiff / octStart) * 100).toFixed(2)) : 0;
        try {
          await db.prepare(`
            INSERT INTO monthly_asset_snapshots
            (year_month, mode, month_start_balance, current_balance, krw_balance, coin_eval_balance, diff_amount, diff_rate, snapshot_date, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run("2026-10", targetMode, octStart, octEnd, octEnd, 0, octDiff, octRate, "2026-10-01", "2026-10-31 23:59:59");
        } catch {}
        startBal = octEnd;
      }
    }

    const diffAmt = Math.floor(totalAsset - startBal);
    const diffRate = startBal > 0 ? Number(((diffAmt / startBal) * 100).toFixed(2)) : 0;

    await db.prepare(`
      INSERT INTO monthly_asset_snapshots
      (year_month, mode, month_start_balance, current_balance, krw_balance, coin_eval_balance, diff_amount, diff_rate, snapshot_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(curYearMonth, targetMode, startBal, totalAsset, krwBal, coinEval, diffAmt, diffRate, curFirstDayStr, kstNow);
  }

  const history = await db
    .prepare("SELECT * FROM monthly_asset_snapshots WHERE mode = ? ORDER BY year_month ASC")
    .all(targetMode);

  const curSnap = await db
    .prepare("SELECT * FROM monthly_asset_snapshots WHERE year_month = ? AND mode = ?")
    .get(curYearMonth, targetMode);

  const formatSnapshot = (s) => {
    if (!s) return null;
    const diff = Number(s.diff_amount || 0);
    return {
      year_month: s.year_month,
      mode: s.mode,
      month_start_balance: Number(s.month_start_balance || 0),
      current_balance: Number(s.current_balance || 0),
      krw_balance: Number(s.krw_balance || 0),
      coin_eval_balance: Number(s.coin_eval_balance || 0),
      diff_amount: diff,
      diff_rate: Number(s.diff_rate || 0),
      diff_status: diff > 0 ? "increase" : diff < 0 ? "decrease" : "flat",
      snapshot_date: s.snapshot_date,
      updated_at: s.updated_at,
    };
  };

  return {
    success: true,
    mode: targetMode,
    current_month: formatSnapshot(curSnap),
    history: (history || []).map(formatSnapshot),
    updated_at: kstNow,
  };
}

/**
 * [Antigravity-Doc] 업비트 최근 체결 완료 주문 목록(`/v1/orders?state=done`)을 조회한다.
 * @param {number} [limit=20] 조회 건수 상한
 * @returns {Promise<{success:boolean, orders:Array<object>, count?:number, message?:string, checked_at:string}>}
 */
async function fetchUpbitRecentOrders(limit = 20) {
  const cfg = getRuntimeConfig();

  const accessKey = String(cfg.access_key || "").trim();
  const secretKey = String(cfg.secret_key || "").trim();
  const timeoutMs = Number(cfg.request_timeout_sec || 5) * 1000;
  const checkedAt = nowKSTString();

  if (
    !accessKey ||
    !secretKey ||
    accessKey === "YOUR_UPBIT_ACCESS_KEY" ||
    secretKey === "YOUR_UPBIT_SECRET_KEY"
  ) {
    return {
      success: false,
      orders: [],
      message: "업비트 API 키가 설정되지 않았습니다.",
      checked_at: checkedAt,
    };
  }

  try {
    await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
    const queryParams = { state: "done", limit: String(limit) };
    const token = createUpbitJwt(accessKey, secretKey, queryParams);
    const qs = new URLSearchParams(queryParams).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`https://api.upbit.com/v1/orders?${qs}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (resp.status === 200) {
      const orders = await resp.json();
      return {
        success: true,
        orders: Array.isArray(orders) ? orders : [],
        count: Array.isArray(orders) ? orders.length : 0,
        checked_at: checkedAt,
      };
    } else {
      const err = await resp.json().catch(() => ({}));
      return {
        success: false,
        orders: [],
        message: err?.error?.message || `업비트 주문 내역 조회 실패 (HTTP ${resp.status})`,
        checked_at: checkedAt,
      };
    }
  } catch (err) {
    return {
      success: false,
      orders: [],
      message: `업비트 API 호출 오류: ${err.message}`,
      checked_at: checkedAt,
    };
  }
}

/**
 * [Antigravity-Doc] 업비트 Open API 통신 지연(ms) 및 WebSocket 허브 연결 상태를 점검하여
 * 신호등 상태(`green` 정상 / `yellow` 지연 / `red` 불가)를 반환한다.
 * @returns {Promise<object>}
 */
async function checkUpbitStatus() {
  const cfg = getRuntimeConfig();
  const delayThreshold = Number(cfg.delay_threshold_ms || 800);
  const timeoutMs = Number(cfg.request_timeout_sec || 5) * 1000;
  const start = Date.now();
  const checkedAt = nowKSTString();
  const wsStatus = upbitWsHub.getWsHealth();

  try {
    await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://api.upbit.com/v1/market/all?isDetails=false", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;

    if (resp.status === 200) {
      if (elapsed >= delayThreshold) {
        return {
          status: "yellow",
          color: "yellow",
          label: "통신지연",
          latency_ms: elapsed,
          reason: `업비트 API 응답 지연 감지 (${elapsed}ms / 기준 ${delayThreshold}ms 초과)`,
          checked_at: checkedAt,
          ws_status: wsStatus,
          ws_connected: wsStatus.connected,
          transport_mode: wsStatus.transport_mode,
        };
      }
      return {
        status: "green",
        color: "green",
        label: "정상통신",
        latency_ms: elapsed,
        reason: `업비트 Open API 서버 정상 응답 (${elapsed}ms)`,
        checked_at: checkedAt,
        ws_status: wsStatus,
        ws_connected: wsStatus.connected,
        transport_mode: wsStatus.transport_mode,
      };
    }
    return {
      status: "red",
      color: "red",
      label: "통신불가",
      latency_ms: elapsed,
      reason: `업비트 Open API 서버 오류 응답 (HTTP ${resp.status})`,
      checked_at: checkedAt,
      ws_status: wsStatus,
      ws_connected: wsStatus.connected,
      transport_mode: wsStatus.transport_mode,
    };
  } catch (err) {
    return {
      status: "red",
      color: "red",
      label: "통신불가",
      latency_ms: Date.now() - start,
      reason: `업비트 Open API 서버 연결 실패: ${err.message}`,
      checked_at: checkedAt,
      ws_status: wsStatus,
      ws_connected: wsStatus.connected,
      transport_mode: wsStatus.transport_mode,
    };
  }
}

// [Antigravity-Doc] 대시보드 세션 인증 및 브루트포스 방어(IP Rate Limit) 설정 상수
// - SESSION_COOKIE_NAME: HttpOnly 세션 쿠키 이름
// - SESSION_SECRET_PATH: HMAC 서명 키 영속화 경로 (권한 0600, 환경변수 SESSION_SECRET 우선)
// - SESSION_TTL_MS: 세션 유효기간 (24시간; 단 KST 날짜 변경 시에도 재인증 요구)
// - AUTH_RATE_LIMIT_*: 10분 윈도우 내 5회 연속 실패 시 해당 IP를 15분간 잠금
const SESSION_COOKIE_NAME = "autoCoinTrade_session";
const SESSION_SECRET_PATH = path.join(DATA_DIR, ".session_secret");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 5;
const AUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const AUTH_RATE_LIMIT_LOCK_MS = 15 * 60 * 1000;
const authFailedAttemptsByIp = new Map();
let cachedSessionSecret = null;

/**
 * [Antigravity-Doc] 세션 쿠키 HMAC-SHA256 서명용 비밀키를 로드하거나 최초 실행 시 32바이트 랜덤 키를 생성·저장한다.
 * @returns {string}
 */
function getSessionSecret() {
  if (cachedSessionSecret) return cachedSessionSecret;
  const envSecret = String(process.env.SESSION_SECRET || "").trim();
  if (envSecret.length >= 16) {
    cachedSessionSecret = envSecret;
    return cachedSessionSecret;
  }
  if (process.env.AUTOCOIN_LIBRARY_MODE === "1") {
    cachedSessionSecret = crypto.randomBytes(32).toString("hex");
    return cachedSessionSecret;
  }
  try {
    if (fs.existsSync(SESSION_SECRET_PATH)) {
      const saved = fs.readFileSync(SESSION_SECRET_PATH, "utf-8").trim();
      if (saved.length >= 32) {
        cachedSessionSecret = saved;
        return cachedSessionSecret;
      }
    }
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SESSION_SECRET_PATH, generated + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(SESSION_SECRET_PATH, 0o600);
    cachedSessionSecret = generated;
    return cachedSessionSecret;
  } catch {
    cachedSessionSecret = crypto.randomBytes(32).toString("hex");
    return cachedSessionSecret;
  }
}

/**
 * [Antigravity-Doc] 두 문자열을 SHA-256 해시 후 상수 시간(`crypto.timingSafeEqual`)으로 비교해 타이밍 공격을 방지한다.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualText(a, b) {
  const da = crypto.createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const db = crypto.createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * [Antigravity-Doc] 입장 코드 변경 시 기존 발급된 세션 쿠키를 즉시 무효화하기 위한 16자리 해시 버전 태그를 생성한다.
 * @param {string} entryCode
 * @returns {string}
 */
function entryCodeVersionTag(entryCode) {
  return crypto.createHash("sha256").update(String(entryCode ?? ""), "utf8").digest("hex").slice(0, 16);
}

/**
 * [Antigravity-Doc] 현재 유효한 대시보드 입장 코드를 조회한다 (DB `entry_code`/`gate_code` -> 환경변수 -> 기본값 "stock").
 * @returns {Promise<string>}
 */
async function getEffectiveEntryCode() {
  const defaultEntry = String(process.env.GATE_CODE || process.env.ENTRY_CODE || "stock").trim() || "stock";
  try {
    const eCode = await getSetting("entry_code", "");
    if (eCode && String(eCode).trim()) return String(eCode).trim();
    const gCode = await getSetting("gate_code", "");
    if (gCode && String(gCode).trim()) return String(gCode).trim();
  } catch {}
  return defaultEntry;
}

/**
 * [Antigravity-Doc] HTTP 요청 헤더의 `Cookie` 문자열을 key-value 맵으로 파싱한다.
 * @param {http.IncomingMessage} req
 * @returns {Record<string, string>}
 */
function parseRequestCookies(req) {
  const raw = String(req.headers?.cookie || "");
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * [Antigravity-Doc] 입장 코드 버전 태그와 KST 날짜, 만료시각이 포함된 HMAC-SHA256 서명 세션 토큰을 발급한다.
 * @param {string} entryCode
 * @returns {string}
 */
function createSignedSessionToken(entryCode) {
  const nowMs = Date.now();
  const payload = {
    iat: nowMs,
    exp: nowMs + SESSION_TTL_MS,
    kst_date: todayDateString(),
    v: entryCodeVersionTag(entryCode),
    nonce: crypto.randomBytes(8).toString("hex"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", getSessionSecret()).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

/**
 * [Antigravity-Doc] 세션 토큰의 HMAC 서명, 만료시각(`exp`), 당일 KST 날짜(`kst_date`), 입장 코드 버전을 모두 검증한다.
 * @param {string} token
 * @param {string} entryCode
 * @returns {boolean}
 */
function verifySignedSessionToken(token, entryCode) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return false;
  const expectedSig = crypto.createHmac("sha256", getSessionSecret()).update(encoded).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return false;
    if (Number(payload.exp || 0) <= Date.now()) return false;
    if (String(payload.kst_date || "") !== todayDateString()) return false;
    if (!timingSafeEqualText(payload.v || "", entryCodeVersionTag(entryCode))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * [Antigravity-Doc] `Set-Cookie` 헤더 문자열을 생성한다 (HTTPS/리버스프록시 감지 시 `Secure` 속성 자동 부여).
 * @param {http.IncomingMessage} req
 * @param {string} token
 * @param {number} [maxAgeSec=86400]
 * @returns {string}
 */
function buildSessionCookieHeader(req, token, maxAgeSec = 86400) {
  const xfProto = String(req.headers?.["x-forwarded-proto"] || "").toLowerCase();
  const isHttps = xfProto.split(",")[0]?.trim() === "https" || Boolean(req.socket?.encrypted);
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps ? "; Secure" : ""}`;
}

/**
 * [Antigravity-Doc] 요청 쿠키의 세션 토큰이 현재 유효한 입장 코드로 서명되었는지 비동기 검증한다.
 * @param {http.IncomingMessage} req
 * @returns {Promise<boolean>}
 */
async function isRequestAuthenticated(req) {
  const cookies = parseRequestCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return false;
  const effectiveCode = await getEffectiveEntryCode();
  return verifySignedSessionToken(token, effectiveCode);
}

/**
 * [Antigravity-Doc] 인증 Rate Limit 키로 사용할 클라이언트 IP를 추출한다.
 * 루프백 리버스 프록시(Cloudflare/Nginx) 경유 시에만 `cf-connecting-ip` / `x-forwarded-for` 헤더를 신뢰한다.
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function getClientIpForAuth(req) {
  const rawRemote = String(req.socket?.remoteAddress || "127.0.0.1");
  const isLoopback = rawRemote === "127.0.0.1" || rawRemote === "::1" || rawRemote === "::ffff:127.0.0.1";
  if (isLoopback) {
    const cfIp = String(req.headers?.["cf-connecting-ip"] || "").trim();
    if (cfIp) return cfIp;
    const xff = String(req.headers?.["x-forwarded-for"] || "").split(",")[0]?.trim();
    if (xff) return xff;
  }
  return rawRemote.replace(/^::ffff:/, "");
}

/**
 * [Antigravity-Doc] 지정 IP의 인증 실패 잠금 여부를 확인하고, 메모리 Map이 1,000건을 초과하면 만료 항목을 정리한다.
 * @param {string} ip
 * @returns {{blocked:boolean, retryAfterSec:number}}
 */
function checkAuthRateLimit(ip) {
  const now = Date.now();
  if (authFailedAttemptsByIp.size > 1000) {
    for (const [k, rec] of authFailedAttemptsByIp.entries()) {
      if (rec.lockedUntil <= now && now - rec.firstFailAt > AUTH_RATE_LIMIT_WINDOW_MS) {
        authFailedAttemptsByIp.delete(k);
      }
    }
  }
  const rec = authFailedAttemptsByIp.get(ip);
  if (!rec) return { blocked: false, retryAfterSec: 0 };
  if (rec.lockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)) };
  }
  if (now - rec.firstFailAt > AUTH_RATE_LIMIT_WINDOW_MS) {
    authFailedAttemptsByIp.delete(ip);
    return { blocked: false, retryAfterSec: 0 };
  }
  return { blocked: false, retryAfterSec: 0 };
}

/**
 * [Antigravity-Doc] 인증 실패 횟수를 누적하고 최대 허용 횟수(`AUTH_RATE_LIMIT_MAX_ATTEMPTS`) 도달 시 잠금 시각을 설정한다.
 * @param {string} ip
 * @returns {{count:number, firstFailAt:number, lockedUntil:number}}
 */
function recordAuthFailure(ip) {
  const now = Date.now();
  let rec = authFailedAttemptsByIp.get(ip);
  if (!rec || now - rec.firstFailAt > AUTH_RATE_LIMIT_WINDOW_MS) {
    rec = { count: 1, firstFailAt: now, lockedUntil: 0 };
  } else {
    rec.count += 1;
  }
  if (rec.count >= AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
    rec.lockedUntil = now + AUTH_RATE_LIMIT_LOCK_MS;
  }
  authFailedAttemptsByIp.set(ip, rec);
  return rec;
}

/**
 * [Antigravity-Doc] 동일 출처(Host / X-Forwarded-Host) 또는 `CORS_ALLOWED_ORIGINS` 화이트리스트에 일치하는 Origin에만
 * Credential 허용 CORS 헤더를 생성한다.
 * @param {http.IncomingMessage} req
 * @returns {Record<string, string>}
 */
function getCorsHeaders(req) {
  const origin = String(req?.headers?.origin || "").trim();
  if (!origin) return {};
  const rawRemote = String(req?.socket?.remoteAddress || "");
  const isLoopback = rawRemote === "127.0.0.1" || rawRemote === "::1" || rawRemote === "::ffff:127.0.0.1";
  const host = String(req?.headers?.host || "").trim();
  const forwardedHost = isLoopback ? String(req?.headers?.["x-forwarded-host"] || "").split(",")[0]?.trim() : "";
  const allowedList = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const matchesHost = (h) => Boolean(h && (origin === `http://${h}` || origin === `https://${h}`));
  if (matchesHost(host) || matchesHost(forwardedHost) || allowedList.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

/**
 * [Antigravity-Doc] JSON 응답을 공통 보안 헤더(`X-Content-Type-Options: nosniff`) 및 CORS 헤더와 함께 전송한다.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {*} payload
 * @param {Record<string, string>} [extraHeaders={}]
 */
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...(res.__corsHeaders || {}),
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

/**
 * [Antigravity-Doc] HTTP 요청 스트림을 UTF-8 문자열로 모아 JSON 객체로 파싱한다(빈 본문은 `{}`).
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// [Antigravity-Doc] 로컬 Ollama 서버 기본 접속 정보 상수 (타임아웃 180초)
const DEFAULT_OLLAMA_BASE_URL = "http://192.168.0.100:11434";
const DEFAULT_OLLAMA_NEWS_MODEL = "qwen3-news";
const DEFAULT_OLLAMA_TIMEOUT_MS = 180000;

/**
 * [Antigravity-Doc] Ollama 설정 등 기본값이 `true`인 불리언 플래그를 파싱한다.
 * @param {*} val
 * @param {boolean} [defaultVal=true]
 * @returns {boolean}
 */
function parseBooleanFlag(val, defaultVal = true) {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return defaultVal;
}

/**
 * [Antigravity-Doc] `config/upbit_config.json`을 읽고 암호화 볼트(`VAULT_SECRET_FIELDS`) 항목을 복호화해 반환한다.
 * 평문 키가 감지되면 `migrateConfigSecrets`로 자동 암호화 마이그레이션을 수행한다.
 * @param {{autoMigrate?:boolean}} [options={}]
 * @returns {object}
 */
function getRuntimeConfig(options = {}) {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  try {
    if (cfgPath === CONFIG_PATH && fs.existsSync(CONFIG_PATH) && options?.autoMigrate !== false) {
      migrateConfigSecrets(CONFIG_PATH);
    }
    const rawCfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const out = { ...rawCfg };
    for (const field of VAULT_SECRET_FIELDS) {
      if (typeof out[field] === "string" && out[field].trim()) {
        out[field] = safeDecryptSecret(out[field].trim());
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * [Antigravity-Doc] 런타임 설정 일부(`partial`)를 기존 `upbit_config.json`과 병합한 뒤,
 * 비밀 필드(API 키 등)를 암호화 볼트로 감싸 0600 권한으로 안전 저장한다.
 * @param {object} [partial={}]
 * @returns {object|null} 저장 후 복호화된 런타임 설정 (실패 시 null)
 */
function saveRuntimeConfig(partial = {}) {
  try {
    let cfg = {};
    if (fs.existsSync(CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } else if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, "utf-8"));
    }
    const merged = { ...cfg, ...partial };
    const toStore = { ...merged };
    for (const field of VAULT_SECRET_FIELDS) {
      const val = String(toStore[field] || "").trim();
      if (
        val &&
        val !== "YOUR_UPBIT_ACCESS_KEY" &&
        val !== "YOUR_UPBIT_SECRET_KEY" &&
        val !== "YOUR_GEMINI_API_KEY_HERE" &&
        !isEncryptedVaultValue(val)
      ) {
        toStore[field] = encryptSecret(val);
      }
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toStore, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(CONFIG_PATH, 0o600);
    return getRuntimeConfig({ autoMigrate: false });
  } catch (err) {
    console.error("Failed to write to config/upbit_config.json:", err.message);
    return null;
  }
}

// [Antigravity-Doc] Ollama 연결 상태 헬스체크 결과 캐시 (불필요한 /api/tags 반복 호출 방지)
let cachedOllamaStatus = {
  key: "",
  checkedAtMs: 0,
  value: null,
};

/**
 * [Antigravity-Doc] Ollama 상태 캐시를 무효화한다(설정 저장 시 호출).
 */
function invalidateOllamaStatusCache() {
  cachedOllamaStatus = { key: "", checkedAtMs: 0, value: null };
}

/**
 * [Antigravity-Doc] 로컬 Ollama 런타임 설정(활성 여부, Base URL, 모델명, 타임아웃)을 우선순위에 따라 해석한다.
 * 우선순위: 함수 인자 -> (라이브러리 모드 시 env) -> UI 설정 DB -> upbit_config.json -> env -> DB 기본값 -> 상수.
 * @param {object} [options={}]
 * @returns {Promise<{enabled:boolean, baseUrl:string, model:string, timeoutMs:number}>}
 */
async function getOllamaRuntimeConfig(options = {}) {
  const cfg = fs.existsSync(CONFIG_PATH) ? getRuntimeConfig() : {};
  let uiConfigured = "";
  let dbUseLocal = "";
  let dbBaseUrl = "";
  let dbModel = "";
  let dbTimeout = "";

  if (!options?.skipDb) {
    try {
      uiConfigured = await getSetting("ollama_ui_configured", "");
      dbUseLocal = await getSetting("use_local_ollama_news", "");
      dbBaseUrl = await getSetting("ollama_base_url", "");
      dbModel = await getSetting("ollama_news_model", "");
      dbTimeout = await getSetting("ollama_timeout_ms", "");
    } catch {}
  }

  const envOverride = process.env.AUTOCOIN_LIBRARY_MODE === "1";

  const enabled =
    options?.enabled !== undefined
      ? parseBooleanFlag(options.enabled, true)
      : envOverride && process.env.USE_LOCAL_OLLAMA_NEWS !== undefined
      ? parseBooleanFlag(process.env.USE_LOCAL_OLLAMA_NEWS, true)
      : uiConfigured === "1" && dbUseLocal !== ""
      ? parseBooleanFlag(dbUseLocal, true)
      : cfg.use_local_ollama_news !== undefined
      ? parseBooleanFlag(cfg.use_local_ollama_news, true)
      : process.env.USE_LOCAL_OLLAMA_NEWS !== undefined
      ? parseBooleanFlag(process.env.USE_LOCAL_OLLAMA_NEWS, true)
      : dbUseLocal !== ""
      ? parseBooleanFlag(dbUseLocal, true)
      : true;

  const rawBaseUrl =
    options?.baseUrl ||
    (envOverride ? process.env.OLLAMA_BASE_URL : "") ||
    (uiConfigured === "1" ? dbBaseUrl : "") ||
    cfg.ollama_base_url ||
    process.env.OLLAMA_BASE_URL ||
    dbBaseUrl ||
    DEFAULT_OLLAMA_BASE_URL;

  const baseUrl = String(rawBaseUrl || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, "");

  const model = String(
    options?.model ||
      (envOverride ? process.env.OLLAMA_NEWS_MODEL : "") ||
      (uiConfigured === "1" ? dbModel : "") ||
      cfg.ollama_news_model ||
      process.env.OLLAMA_NEWS_MODEL ||
      dbModel ||
      DEFAULT_OLLAMA_NEWS_MODEL
  ).trim() || DEFAULT_OLLAMA_NEWS_MODEL;

  const rawTimeout =
    options?.timeoutMs ||
    (envOverride ? process.env.OLLAMA_TIMEOUT_MS : "") ||
    (uiConfigured === "1" ? dbTimeout : "") ||
    cfg.ollama_timeout_ms ||
    process.env.OLLAMA_TIMEOUT_MS ||
    dbTimeout ||
    DEFAULT_OLLAMA_TIMEOUT_MS;

  const parsedTimeout = Number(rawTimeout);
  const timeoutMs = Number.isFinite(parsedTimeout)
    ? Math.min(300000, Math.max(3000, Math.floor(parsedTimeout)))
    : DEFAULT_OLLAMA_TIMEOUT_MS;

  return {
    enabled,
    baseUrl,
    model,
    timeoutMs,
  };
}

/**
 * [Antigravity-Doc] 로컬 Ollama 설정(사용 여부, URL, 모델명, 타임아웃)을 유효성 검증 후 `upbit_config.json`과 DB `system_settings`에 저장하고,
 * 즉시 연결 테스트(`checkOllamaStatus`)를 수행해 결과를 반환한다.
 * @param {object} [payload={}]
 * @returns {Promise<object>}
 */
async function saveOllamaSettings(payload = {}) {
  const current = await getOllamaRuntimeConfig();
  const enabled =
    payload.use_local_ollama_news !== undefined
      ? parseBooleanFlag(payload.use_local_ollama_news, current.enabled)
      : current.enabled;

  const rawUrl = String(payload.ollama_base_url ?? current.baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(rawUrl)) {
    throw new Error("유효한 Ollama 서버 URL을 입력해주세요 (예: http://192.168.0.100:11434)");
  }

  const model = String(payload.ollama_news_model ?? current.model).trim();
  if (!model) {
    throw new Error("Ollama 모델명을 입력해주세요 (예: qwen3-news)");
  }

  const rawTimeout = Number(payload.ollama_timeout_ms ?? current.timeoutMs);
  if (!Number.isFinite(rawTimeout) || rawTimeout < 3000 || rawTimeout > 300000) {
    throw new Error("Ollama 타임아웃은 3,000ms ~ 300,000ms 사이여야 합니다.");
  }
  const timeoutMs = Math.floor(rawTimeout);

  if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
    saveRuntimeConfig({
      use_local_ollama_news: enabled,
      ollama_base_url: rawUrl,
      ollama_news_model: model,
      ollama_timeout_ms: timeoutMs,
    });
  }

  const db = getDb();
  const now = nowKSTString();
  const upsert = await db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)"
  );
  await upsert.run("use_local_ollama_news", String(enabled), now);
  await upsert.run("ollama_base_url", rawUrl, now);
  await upsert.run("ollama_news_model", model, now);
  await upsert.run("ollama_timeout_ms", String(timeoutMs), now);
  await upsert.run("ollama_ui_configured", "1", now);

  invalidateOllamaStatusCache();
  const ollama = await checkOllamaStatus({ forceRefresh: true });
  return {
    use_local_ollama_news: enabled,
    ollama_base_url: rawUrl,
    ollama_news_model: model,
    ollama_timeout_ms: timeoutMs,
    ollama,
  };
}

/**
 * [Antigravity-Doc] 로컬 Ollama 서버(`/api/tags`, 1.5초 타임아웃) 도달 가능 여부와 응답 지연(ms)을 점검한다.
 * 10초 캐시(`cachedOllamaStatus`)를 사용하여 대시보드 폴링 부하를 줄인다.
 * @param {{forceRefresh?:boolean}} [options={}]
 * @returns {Promise<{enabled:boolean, url:string, reachable:boolean, model:string, latency_ms:number}>}
 */
async function checkOllamaStatus(options = {}) {
  const cfg = await getOllamaRuntimeConfig(options);
  const cacheKey = `${cfg.enabled}|${cfg.baseUrl}|${cfg.model}`;
  const nowMs = Date.now();
  if (
    !options?.forceRefresh &&
    cachedOllamaStatus.value &&
    cachedOllamaStatus.key === cacheKey &&
    nowMs - cachedOllamaStatus.checkedAtMs < 10000
  ) {
    return cachedOllamaStatus.value;
  }

  if (!cfg.enabled) {
    const disabledState = {
      enabled: false,
      url: cfg.baseUrl,
      reachable: false,
      model: cfg.model,
      latency_ms: 0,
    };
    cachedOllamaStatus = { key: cacheKey, checkedAtMs: nowMs, value: disabledState };
    return disabledState;
  }

  const startMs = Date.now();
  let reachable = false;
  try {
    const resp = await fetch(`${cfg.baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });
    if (resp.ok) {
      reachable = true;
    }
  } catch {
    reachable = false;
  }

  const statusObj = {
    enabled: true,
    url: cfg.baseUrl,
    reachable,
    model: cfg.model,
    latency_ms: Date.now() - startMs,
  };
  cachedOllamaStatus = { key: cacheKey, checkedAtMs: nowMs, value: statusObj };
  return statusObj;
}

/**
 * [Antigravity-Doc] Gemini API 키를 `upbit_config.json` -> DB `system_settings` -> `process.env.GEMINI_API_KEY` 순으로 조회·복호화한다.
 * @returns {Promise<string>}
 */
async function getGeminiApiKey() {
  const cfg = getRuntimeConfig();
  if (cfg.gemini_api_key && cfg.gemini_api_key !== "YOUR_GEMINI_API_KEY_HERE" && cfg.gemini_api_key.trim().length > 0) {
    return safeDecryptSecret(cfg.gemini_api_key.trim());
  }
  const dbKey = await getSetting("gemini_api_key", "");
  if (dbKey && dbKey.trim().length > 0) {
    return safeDecryptSecret(dbKey.trim());
  }
  return safeDecryptSecret((process.env.GEMINI_API_KEY || "").trim());
}

/**
 * [Antigravity-Doc] Gemini API 키를 암호화하여 `upbit_config.json`과 DB `system_settings` 양쪽에 저장한다.
 * @param {string} key
 * @returns {Promise<string>} 공백 제거된 원본 키
 */
async function saveGeminiApiKey(key) {
  const cleanKey = (key || "").trim();
  saveRuntimeConfig({ gemini_api_key: cleanKey });
  const now = nowKSTString();
  const db = getDb();
  const storedKey = cleanKey ? encryptSecret(cleanKey) : "";
  await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)").run(storedKey, now);
  return cleanKey;
}

// ============================================================================
// Gemini 무료 API 일일 쿼터 및 듀얼 AI(Flash 30분 / Pro 1시간) 자동 분석 스케줄 관리
// - Google Gemini Free Tier 일일 무료 호출 한도: 20회/일
// - 30분 단위 Gemini Flash 빠른 분석 및 1시간 단위 Gemini Pro 심층 분석
// - 사용자 수동 호출 가능 무료 API 한도: 20 - 6 = 14회/일 (일일 수동 안전 가이드)
// ============================================================================
// [Antigravity-Doc] Gemini 일일 무료 호출 한도 및 자동/수동 쿼터 배분 상수
// - GEMINI_DAILY_TOTAL_FREE_LIMIT: 일일 총 무료 호출 상한(50회)
// - GEMINI_DAILY_AUTO_RESERVED: 정기 자동 분석 예약분(6회)
// - GEMINI_DAILY_MANUAL_LIMIT: 사용자 수동 분석 일일 허용 상한(30회)
const GEMINI_DAILY_TOTAL_FREE_LIMIT = 50;
const AI_SCHEDULE_HOURS = Array.from({ length: 24 }, (_, i) => i);
const GEMINI_DAILY_AUTO_RESERVED = 6;
const GEMINI_DAILY_MANUAL_LIMIT = 30;

/**
 * [Antigravity-Doc] 다음 30분 정시/반시 정기 AI 분석 예정 시각 문자열을 계산한다.
 * @returns {string} 'YYYY-MM-DD HH:mm:00'
 */
function getNextScheduledAiAnalysisAt() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const target = new Date(now);
  const curMinutes = now.getMinutes();
  if (curMinutes < 30) {
    target.setMinutes(30, 0, 0);
  } else {
    target.setHours(target.getHours() + 1, 0, 0, 0);
  }
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${pad(target.getHours())}:${pad(target.getMinutes())}:00`;
}

/**
 * [Antigravity-Doc] 당일(KST) Gemini API 자동/수동 사용량과 잔여 쿼터를 조회한다. 날짜가 바뀌면 자동 0으로 리셋한다.
 * @returns {Promise<object>}
 */
async function getGeminiQuotaStatus() {
  const db = getDb();
  const today = todayDateString();
  const now = nowKSTString();
  const storedDate = await getSetting("gemini_usage_date", "");

  if (storedDate !== today) {
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_usage_date', ?, ?)").run(today, now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_manual_used', '0', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_auto_used', '0', ?)").run(now);
  }

  const manualUsed = Math.max(0, Math.floor(Number(await getSetting("gemini_manual_used", "0")) || 0));
  const autoUsed = Math.max(0, Math.floor(Number(await getSetting("gemini_auto_used", "0")) || 0));
  const remainingCalls = Math.max(0, GEMINI_DAILY_MANUAL_LIMIT - manualUsed);

  return {
    date: today,
    daily_total_limit: GEMINI_DAILY_TOTAL_FREE_LIMIT,
    auto_reserved_count: GEMINI_DAILY_AUTO_RESERVED,
    manual_limit: GEMINI_DAILY_MANUAL_LIMIT,
    manual_used: manualUsed,
    auto_used: autoUsed,
    remaining_calls: remainingCalls,
    schedule_interval: "Flash 30분 / Pro 1시간",
    schedule_hours: AI_SCHEDULE_HOURS,
    next_scheduled_at: getNextScheduledAiAnalysisAt(),
    last_auto_slot: await getSetting("ai_briefing_last_auto_slot", ""),
    last_trigger_type: await getSetting("ai_briefing_last_trigger_type", "MANUAL"),
    last_news_auto_slot: await getSetting("ai_news_briefing_last_auto_slot", ""),
    last_news_trigger_type: await getSetting("ai_news_briefing_last_trigger_type", "MANUAL"),
  };
}

/**
 * [Antigravity-Doc] Gemini API 호출 성공 시 자동(`AUTO`) 또는 수동(`MANUAL`) 일일 사용량 카운터를 1 증가시킨다.
 * @param {"AUTO"|"MANUAL"} [triggerType="MANUAL"]
 * @returns {Promise<object>} 갱신된 쿼터 상태
 */
async function consumeGeminiQuota(triggerType = "MANUAL") {
  const db = getDb();
  const status = await getGeminiQuotaStatus();
  const now = nowKSTString();

  if (triggerType === "AUTO") {
    const nextAuto = status.auto_used + 1;
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_auto_used', ?, ?)").run(
      String(nextAuto),
      now
    );
  } else {
    const nextManual = Math.min(GEMINI_DAILY_MANUAL_LIMIT, status.manual_used + 1);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_manual_used', ?, ?)").run(
      String(nextManual),
      now
    );
  }
  return await getGeminiQuotaStatus();
}

/**
 * [Antigravity-Doc] Gemini 429 전 모델 소진 시 당일 수동 사용량을 상한까지 채워 불필요한 재호출을 차단한다.
 * @returns {Promise<object>}
 */
async function markGeminiManualQuotaExhausted() {
  const db = getDb();
  await getGeminiQuotaStatus();
  const now = nowKSTString();
  await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_manual_used', ?, ?)").run(
    String(GEMINI_DAILY_MANUAL_LIMIT),
    now
  );
  return await getGeminiQuotaStatus();
}

/**
 * [Antigravity-Doc] 최신 AI 시황 브리핑(`ai_market_briefings`), 장세 필터(`market_regime_filter`), 쿼터, Ollama 상태를 통합 조회한다.
 * @returns {Promise<object>}
 */
async function getLatestAiBriefing() {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM ai_market_briefings ORDER BY id DESC LIMIT 1").get();
  let regimeRow = null;
  try {
    regimeRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
  } catch (err) {
    console.warn("[getLatestAiBriefing] Failed to fetch market_regime_filter:", err.message);
  }
  const apiKey = await getGeminiApiKey();
  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "";
  const quota = await getGeminiQuotaStatus();
  const ollama = await checkOllamaStatus();
  const modelMeta = await loadDualAiModelMeta(db);
  const enrichedRegime = enrichRegimeFilterRow(regimeRow, modelMeta);
  const cleanedLatest = row
    ? {
        ...row,
        briefing_text: stripControlJsonFromBriefingText(row.briefing_text),
      }
    : null;
  return {
    has_key: !!apiKey,
    masked_key: maskedKey,
    latest: cleanedLatest,
    last_trigger_type: quota.last_trigger_type,
    regime_filter: enrichedRegime,
    quota,
    ollama,
  };
}

/**
 * [Antigravity-Doc] 최신 AI 뉴스 브리핑(`ai_news_briefings`)과 키 보유 여부·쿼터·Ollama 상태를 조회한다.
 * @returns {Promise<object>}
 */
async function getLatestAiNewsBriefing() {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM ai_news_briefings ORDER BY id DESC LIMIT 1").get();
  const apiKey = await getGeminiApiKey();
  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "";
  const quota = await getGeminiQuotaStatus();
  const ollama = await checkOllamaStatus();
  return {
    has_key: !!apiKey,
    masked_key: maskedKey,
    latest: row || null,
    last_trigger_type: await getSetting("ai_news_briefing_last_trigger_type", "MANUAL"),
    last_auto_slot: await getSetting("ai_news_briefing_last_auto_slot", ""),
    quota,
    ollama,
  };
}

/**
 * [Antigravity-Doc] AI 시황/뉴스 분석 결과(Flash 또는 Pro 트랙)를 `system_settings`에 저장한 뒤,
 * 유효 TTL(Flash 90분 / Pro 180분) 내의 상대 트랙 상태와 `synthesizeDualAiDecision`으로 교차 합성하여
 * `market_regime_filter(id=1)` 테이블과 메모리 장세 캐시(`cachedRegimeState`)를 갱신한다.
 * 부수효과: DB `system_settings`, `market_regime_filter` UPDATE 및 장세 캐시 무효화
 * @param {object} params 분석 트랙(`isPro`), 모델 정보, BTC 지표, LLM 텍스트/결정 객체
 * @returns {Promise<object|null>} 갱신된 `market_regime_filter` 확장 행
 */
async function updateMarketRegimeFilterFromAnalysis({
  isPro = false,
  provider = "",
  model = "",
  btcPrice = 0,
  btcDaily20Ma = 0,
  btc4h60Ma = 0,
  isHoldCash = false,
  regimeReason = "",
  analysisText = "",
  decision = null,
  isFallback = false,
}) {
  const db = getDb();
  const now = nowKSTString();
  try {
    let curRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    if (!curRow) {
      await db
        .prepare(
          "INSERT INTO market_regime_filter (id, bot_overrides_json, final_bot_overrides_json) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING"
        )
        .run(DEFAULT_BOT_OVERRIDES_JSON, DEFAULT_BOT_OVERRIDES_JSON);
      curRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    }

    const fallbackBase = buildMechanicalFallbackRegime({
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: isFallback ? "Mechanical Fallback" : "Technical Baseline",
    });

    const DUAL_AI_FLASH_TTL_MS = 90 * 60 * 1000;
    const DUAL_AI_PRO_TTL_MS = 180 * 60 * 1000;
    const loadSideState = async (settingKey, maxAgeMs) => {
      try {
        const row = await db
          .prepare("SELECT value, updated_at FROM system_settings WHERE key = ?")
          .get(settingKey);
        const raw = row?.value || "";
        if (raw) {
          if (maxAgeMs > 0 && row?.updated_at) {
            const updMs = parseKstDateTimeMsLocal(row.updated_at);
            if (Number.isFinite(updMs) && Date.now() - updMs > maxAgeMs) {
              console.warn(
                `[DualAI] Expired side state ignored (${settingKey}, updated_at=${row.updated_at}, ttlMin=${Math.round(maxAgeMs / 60000)})`
              );
              return null;
            }
          }
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed.bot_overrides) {
            const normalized = normalizeLlmRegimeDecision(parsed, String(parsed.reason || ""));
            return {
              ...parsed,
              ...normalized,
              provider: parsed.provider || "",
              model: parsed.model || "",
              model_tier: parsed.model_tier || "",
            };
          }
        }
      } catch {}
      return null;
    };

    let incomingDecision = decision;
    if (!incomingDecision && analysisText) {
      const extracted = extractStructuredRegimeFromLlmText(analysisText);
      if (extracted.structured) {
        incomingDecision = extracted.structured;
      }
    }

    if (!incomingDecision) {
      const disparity = btcDaily20Ma > 0 ? ((btcPrice - btcDaily20Ma) / btcDaily20Ma) * 100 : 0;
      const derivedMult = fallbackBase.position_size_multiplier;
      incomingDecision = {
        ...fallbackBase,
        sentiment_score: Math.max(-0.95, Math.min(0.95, Number((disparity / 10).toFixed(2)))),
        position_size_multiplier: isHoldCash && isFallback ? derivedMult : fallbackBase.position_size_multiplier,
        reason: regimeReason || fallbackBase.reason,
      };
    } else {
      const normalizedIncoming = normalizeLlmRegimeDecision(
        incomingDecision,
        regimeReason || String(incomingDecision.reason || "듀얼 AI 장세 및 봇 스위치 판단")
      );
      incomingDecision = {
        ...incomingDecision,
        ...normalizedIncoming,
      };
    }

    let flashState = await loadSideState("dual_ai_flash_state_json", DUAL_AI_FLASH_TTL_MS);
    let proState = await loadSideState("dual_ai_pro_state_json", DUAL_AI_PRO_TTL_MS);
    let flashUpdated = curRow?.flash_updated_at || now;
    let proUpdated = curRow?.pro_updated_at || now;
    const resolvedProvider = String(provider || incomingDecision?.provider || (isFallback ? "fallback" : "")).trim();
    const resolvedModel = String(model || incomingDecision?.model || (isFallback ? "mechanical-btc-20ma" : "")).trim();

    if (isPro) {
      proState = {
        ...incomingDecision,
        provider: resolvedProvider || proState?.provider || "",
        model: resolvedModel || proState?.model || "",
      };
      proUpdated = now;
      await db
        .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_pro_state_json', ?, ?)")
        .run(JSON.stringify(proState), now);
      if (proState.provider) {
        await db
          .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_pro_provider', ?, ?)")
          .run(proState.provider, now);
      }
      if (proState.model) {
        await db
          .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_pro_model', ?, ?)")
          .run(proState.model, now);
      }
    } else {
      flashState = {
        ...incomingDecision,
        provider: resolvedProvider || flashState?.provider || "",
        model: resolvedModel || flashState?.model || "",
      };
      flashUpdated = now;
      await db
        .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_flash_state_json', ?, ?)")
        .run(JSON.stringify(flashState), now);
      if (flashState.provider) {
        await db
          .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_flash_provider', ?, ?)")
          .run(flashState.provider, now);
      }
      if (flashState.model) {
        await db
          .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_flash_model', ?, ?)")
          .run(flashState.model, now);
      }
    }

    // 한쪽 모델(예: Ollama 단독 운용 시 Pro 미실행)이 아직 저장된 이력이 없을 때 직전 curRow의 BLOCK/risk_alert를 복사해 영구 잠금(Sticky Latch)되는 버그 방지
    const neutralPassThrough = (refState) => ({
      sentiment_score: Number(refState?.sentiment_score ?? 0.0),
      market_regime: String(refState?.market_regime || "SIDEWAYS").toUpperCase(),
      risk_alert: false,
      recommended_action: "NORMAL",
      position_size_multiplier: 1.0,
      bot_overrides: { ...DEFAULT_BOT_OVERRIDES },
      blacklist_tickers: [],
      reason: "미실행(단독 엔진 우선 반영)",
      _isNeutralPassThrough: true,
    });
    const effectiveFlashState = flashState || neutralPassThrough(proState || fallbackBase);
    const effectiveProState = proState || neutralPassThrough(flashState || fallbackBase);
    const synthesized = synthesizeDualAiDecision(effectiveFlashState, effectiveProState);
    const botOverridesJson = JSON.stringify(synthesized.bot_overrides);
    const finalBotOverridesJson = JSON.stringify(synthesized.final_bot_overrides);
    const blacklistJson = JSON.stringify(synthesized.blacklist_tickers);

    await db.prepare(`
      UPDATE market_regime_filter
      SET sentiment_score = ?,
          market_regime = ?,
          risk_alert = ?,
          recommended_action = ?,
          position_size_multiplier = ?,
          bot_overrides_json = ?,
          blacklist_tickers_json = ?,
          reason = ?,
          updated_at = ?,
          flash_sentiment_score = ?,
          flash_recommended_action = ?,
          flash_updated_at = ?,
          pro_sentiment_score = ?,
          pro_recommended_action = ?,
          pro_updated_at = ?,
          final_risk_alert = ?,
          final_position_multiplier = ?,
          final_bot_overrides_json = ?
      WHERE id = 1
    `).run(
      synthesized.sentiment_score,
      synthesized.market_regime,
      synthesized.risk_alert,
      synthesized.recommended_action,
      synthesized.position_size_multiplier,
      botOverridesJson,
      blacklistJson,
      synthesized.reason,
      now,
      synthesized.flash_sentiment_score,
      synthesized.flash_recommended_action,
      flashUpdated,
      synthesized.pro_sentiment_score,
      synthesized.pro_recommended_action,
      proUpdated,
      synthesized.final_risk_alert,
      synthesized.final_position_multiplier,
      finalBotOverridesJson
    );

    cachedRegimeState.checkedAtMs = 0;
    const modelMeta = {
      flash_provider: flashState?.provider || (await getSetting("dual_ai_flash_provider", "")),
      flash_model: flashState?.model || (await getSetting("dual_ai_flash_model", "")),
      pro_provider: proState?.provider || (await getSetting("dual_ai_pro_provider", "")),
      pro_model: proState?.model || (await getSetting("dual_ai_pro_model", "")),
    };
    console.log(
      `[Dual AI Update] Regime=${synthesized.market_regime}, Action=${synthesized.recommended_action}, Mult=${synthesized.final_position_multiplier}, Flash=${synthesized.flash_recommended_action}(${modelMeta.flash_model || "-"}), Pro=${synthesized.pro_recommended_action}(${modelMeta.pro_model || "-"})`
    );
    const updatedRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    return enrichRegimeFilterRow(updatedRow, modelMeta);
  } catch (err) {
    console.error("[updateMarketRegimeFilterFromAnalysis] Error:", err.message);
    return null;
  }
}

/**
 * [Antigravity-Doc] 듀얼 AI(Flash/Pro) 시황 분석용 실시간 팩트 컨텍스트와 한국어 프롬프트를 조립한다.
 * BTC 이동평균선, 주요 5대 코인 시세, 최신 뉴스 12건, 업비트 실계좌 현황, 실전 선택/드레인 봇 포지션을 포함한다.
 * @param {{isProTarget?:boolean}} [params]
 * @returns {Promise<{regimeFilter:object, btcPrice:number, btcDaily20Ma:number, btc4h60Ma:number, isHoldCash:boolean, regimeReason:string, nowStr:string, prompt:string}>}
 */
async function buildDualAiMarketPromptContext({ isProTarget = false } = {}) {
  const regimeFilter = await checkMarketRegimeFilter();
  const btcPrice = Number(regimeFilter.btcPrice || 0);
  const btcDaily20Ma = Number(regimeFilter.ma20Day || 0);
  const btc4h60Ma = Number(regimeFilter.ma60_4h || 0);
  const isHoldCash = regimeFilter.allowBuy === false;
  const regimeReason = regimeFilter.reason || "";

  const accInfo = await fetchUpbitAccountBalance();
  const totalBuyKrw = Number(accInfo.total_buy_krw || 0);
  const totalEvalKrw = Number(accInfo.total_eval_krw || 0);
  const evalProfitPct = accInfo.eval_profit_pct !== null ? accInfo.eval_profit_pct : 0;
  const orderableKrw = Number(accInfo.orderable_krw || 0);

  const allBots = await getBots("live");
  const db = getDb();
  const liveBotsData = [];
  const drainingBotsData = [];

  for (const b of allBots) {
    const openPositions = await db
      .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC")
      .all(b.bot_id);
    const entry = {
      id: b.bot_id,
      name: b.name,
      nickname: b.nickname,
      group: BOT_STRATEGY_GUIDE[b.bot_id]?.group || "",
      strategy_type: b.strategy_type,
      allocated_capital: b.allocated_capital,
      virtual_krw: b.virtual_krw,
      used_capital: b.used_capital,
      is_selected_for_live: Number(b.is_selected_for_live || 0) === 1,
      is_running: Number(b.is_running || 0) === 1,
      open_positions: openPositions.map((p) => ({
        market: p.market,
        buy_amount: p.buy_amount,
        avg_buy_price: p.avg_buy_price,
        volume: p.volume,
        created_at: p.created_at,
      })),
    };
    if (entry.is_selected_for_live) {
      liveBotsData.push(entry);
    } else if (entry.open_positions.length > 0) {
      drainingBotsData.push(entry);
    }
  }

  let tickerInfo = "";
  try {
    const targetMarkets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-DOGE", "KRW-XRP"];
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${targetMarkets.join(",")}`);
    if (tResp.ok) {
      const tickers = await tResp.json();
      tickerInfo = tickers
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%, 24시간 거래대금 ${Math.floor(Number(t.acc_trade_price_24h) / 100000000).toLocaleString(
              "ko-KR"
            )}억원)`
        )
        .join("\n");
    }
  } catch {
    tickerInfo = "- 주요 종목 시세 수신 일시 지연";
  }

  let newsLines = "";
  try {
    const newsRows = await db
      .prepare("SELECT title, source, sentiment, published_at FROM crypto_news ORDER BY id DESC LIMIT 12")
      .all();
    if (newsRows.length > 0) {
      newsLines = newsRows
        .map((n, i) => `${i + 1}. [${n.sentiment || "NEUTRAL"}][${n.source || "NEWS"}] ${n.title} (${n.published_at || ""})`)
        .join("\n");
    }
  } catch (newsErr) {
    console.warn("[AI Prompt] Recent crypto_news query failed:", newsErr?.message || newsErr);
  }

  const allOpenPosSummary = [...liveBotsData, ...drainingBotsData]
    .flatMap((b) =>
      b.open_positions.map(
        (p) => `${p.market} (${b.id} ${b.nickname}, ${Number(p.buy_amount || 0).toLocaleString("ko-KR")}원)`
      )
    )
    .join(", ");

  const allBotProfilesText = ALL_BOT_IDS.map((id) => {
    const g = BOT_STRATEGY_GUIDE[id];
    return `- ${id} (${g.name} | ${g.group}): ${g.rule}`;
  }).join("\n");

  const nowStr = nowKSTString();
  const engineRole = isProTarget
    ? "1시간 주기 심층 거시 장세 판별 & 10대 봇 스위치 조정(Gemini Pro)"
    : "30분 주기 단기 뉴스 속보 & 돌발 악재 방패(Gemini Flash)";

  const prompt = `당신은 대한민국 최고 수준의 가상자산 퀀트 트레이딩 시스템 'Upbit AutoCoinTrade'의 수석 AI 퀀트 전략가입니다.
현재 분석 엔진 역할: **${engineRole}**
아래는 ${nowStr} 기준, 시스템이 업비트 실거래소·실전 선택 봇·미청산 오픈 포지션·최근 뉴스에서 수집한 실시간 팩트 데이터입니다.

### [절대 준수 제어 원칙 - 동적 매수 게이트웨이 & 포지션 보호]
1. 봇 강제 교체 및 보유 포지션 강제 청산 절대 금지: 사용자가 [설정]에서 선택한 실전 담당 봇(is_selected_for_live=1) 구성을 해제하거나 보유 포지션을 시장가로 강제 청산하라고 지시하지 마십시오.
2. 'BLOCK' 판정은 오직 해당 봇의 [신규 매수 진입]만 일시 차단하며, 기존 보유 물량은 해당 봇의 고유 청산 알고리즘(트레일링 스탑/익절/손절)에 따라 끝까지 감시·청산됩니다.
3. 10대 알고리즘 전략 그룹별 매핑:
   - 추세·돌파·모멘텀 그룹(bot_01, bot_02, bot_03, bot_04, bot_07, bot_09): 상승 추세장(BULL)에서 'ALLOW', 박스권 횡보장(SIDEWAYS)/윗꼬리 휩소 장세에서 'BLOCK' (단 bot_04 스퀴즈 돌파, bot_09 거래량 폭발은 조건부 허용 가능).
   - 역추세·그리드·눌림목 그룹(bot_05, bot_06, bot_08, bot_10): 박스권 횡보장(SIDEWAYS) 및 과매도 반등 구간에서 'ALLOW' 유지, 해킹·상폐·패닉셀(HIGH_VOLATILITY_SHOCK/BEAR 급락) 시에만 전체 봇 'BLOCK' 및 HALT_NEW_BUYS 선언.

### [실시간 수집 팩트 데이터]
1. 비트코인 시장 체제 지표:
- 비트코인(KRW-BTC) 현재가: ${btcPrice ? btcPrice.toLocaleString("ko-KR") + "원" : "데이터 수신 중"}
- 일봉 20일 이동평균선(20 MA): ${btcDaily20Ma ? Math.floor(btcDaily20Ma).toLocaleString("ko-KR") + "원" : "-"} (이격도: ${
    btcPrice && btcDaily20Ma ? (((btcPrice - btcDaily20Ma) / btcDaily20Ma) * 100).toFixed(2) + "%" : "-"
  }, ${btcPrice >= btcDaily20Ma ? "상회" : "하회"})
- 4시간봉 60선(60 MA): ${btc4h60Ma ? Math.floor(btc4h60Ma).toLocaleString("ko-KR") + "원" : "-"} (이격도: ${
    btcPrice && btc4h60Ma ? (((btcPrice - btc4h60Ma) / btc4h60Ma) * 100).toFixed(2) + "%" : "-"
  }, ${btcPrice >= btc4h60Ma ? "상회" : "하회"})
- 분석 원칙: 직전 주기의 차단 상태나 이전 판단에 편향되지 말고, 아래 실시간 가격·이동평균·뉴스 팩트만 독립적으로 재평가하십시오.

2. 주요 코인 시세 현황:
${tickerInfo}

3. 최근 암호화폐 뉴스·공지 (최대 12건):
${newsLines || "- 최근 특이 뉴스 없음"}

4. 업비트 실계좌 현황:
- 총 매수금액: ${totalBuyKrw.toLocaleString("ko-KR")}원 | 총 평가금액: ${totalEvalKrw.toLocaleString("ko-KR")}원 (${evalProfitPct}%)
- 주문가능 현금: ${orderableKrw.toLocaleString("ko-KR")}원
- 전체 실전 미청산 보유 포지션: ${allOpenPosSummary || "보유 포지션 없음"}

5. 현재 사용자 선택 실전 담당 봇 (is_selected_for_live = 1, ${liveBotsData.length}개):
${
  liveBotsData.length > 0
    ? liveBotsData
        .map(
          (b) => `[${b.id} | ${b.nickname} (${b.name}) - ${b.group}]
- 전략: ${b.strategy_type}
- 상태: ${b.is_running ? "가동중" : "중지"}
- 배정: ${b.allocated_capital.toLocaleString("ko-KR")}원 / 투자중: ${b.used_capital.toLocaleString("ko-KR")}원 / 가용: ${b.virtual_krw.toLocaleString("ko-KR")}원
- 오픈 포지션(${b.open_positions.length}건): ${
            b.open_positions.length > 0
              ? b.open_positions.map((p) => `${p.market}(${Number(p.buy_amount).toLocaleString("ko-KR")}원)`).join(", ")
              : "없음"
          }`
        )
        .join("\n\n")
    : "- 현재 선택된 실전 봇 없음"
}
${
  drainingBotsData.length > 0
    ? `\n6. 포지션 보호 청산 대기(Graceful Drain) 봇 (${drainingBotsData.length}개 · 신규 진입 중단, 기존 물량만 청산 감시중):\n` +
      drainingBotsData
        .map(
          (b) =>
            `- ${b.id} (${b.nickname}): 보유 ${b.open_positions
              .map((p) => `${p.market} ${Number(p.buy_amount).toLocaleString("ko-KR")}원`)
              .join(", ")}`
        )
        .join("\n")
    : ""
}

7. 전체 10대 알고리즘 봇(bot_01 ~ bot_10) 게이트웨이 매핑 기준:
${allBotProfilesText}

---

### [작성 요청 가이드라인 및 필수 출력 형식]
아래 한국어 마크다운 브리핑을 작성한 뒤, **반드시 응답 맨 마지막에 표준 10대 봇 JSON 제어 블록(\`\`\`json ... \`\`\`)을 정확히 1개 포함**하십시오.

## ⚡ Flash 단기 진단 (30분 뉴스·공지 & 돌발 리스크 방패)
- 최근 30분~1시간 단기 뉴스/공지(해킹, 디페깅, 유의종목·상장폐지, 급락 투매) 이상 유무
- 돌발 악재 시 블랙리스트 지정 또는 돌파형 봇 즉시 차단 사유

## 🧠 Pro 심층 진단 (1시간 거시 장세 & 실전 선택 봇별 게이트웨이)
- 비트코인 일봉 20MA(${btcDaily20Ma ? Math.floor(btcDaily20Ma).toLocaleString("ko-KR") + "원" : "-"}) 및 4시간 60MA 기준 거시 장세(BULL / SIDEWAYS / BEAR / HIGH_VOLATILITY_SHOCK) 판별
- 선택된 실전 담당 봇(${liveBotsData.map((b) => b.id).join(", ") || "bot_01~bot_10"}) 및 10대 봇 각각의 신규 매수 허용(ALLOW) / 보류(BLOCK) 판단 (보유 포지션은 고유 로직으로 정상 감시함을 명시)

## 💡 향후 체크포인트 & 운용 가이드
- 주요 BTC 지지/저항 가격선 및 실전 투입 비중(${orderableKrw.toLocaleString("ko-KR")}원 기준) 운용 조언

### [JSON 제어 필드 필수 규칙 - 엄수]
1. \`risk_alert\`: **오직 거래소 해킹, 스테이블코인 디페깅, 대규모 상장폐지, 단일일 패닉 폭락(\`HIGH_VOLATILITY_SHOCK\`) 등 모든 봇의 신규 매수를 즉시 0%로 중단해야 하는 돌발 위기 시에만 \`true\`**로 설정하십시오.
2. 단순 약세장(\`BEAR\`)이나 횡보장(\`SIDEWAYS\`)에서 추세·돌파 봇(\`bot_01~04, 07, 09\`)은 \`BLOCK\`하고 역추세·그리드·눌림목 봇(\`bot_05, 06, 08, 10\`)을 \`ALLOW\`로 방어 운용할 때는 **반드시 \`"risk_alert": false\`, \`"recommended_action": "REDUCE_SIZE"\`, \`"position_size_multiplier": 0.5\`**로 출력하십시오. (\`risk_alert: true\`는 10대 봇 전체를 강제 \`BLOCK\`하고 비중을 \`0%\`로 잠그는 비상 스위치입니다.)
3. \`HALT_NEW_BUYS\` 또는 \`EMERGENCY_CLOSE_ALL\` 선언 시에만 \`"risk_alert": true\`, \`"position_size_multiplier": 0.0\`, 전체 봇 \`BLOCK\`으로 일치시키십시오.

\`\`\`json
{
  "sentiment_score": 0.0,
  "market_regime": "SIDEWAYS",
  "risk_alert": false,
  "recommended_action": "NORMAL",
  "position_size_multiplier": 1.0,
  "bot_overrides": {
    "bot_01": "BLOCK",
    "bot_02": "ALLOW",
    "bot_03": "BLOCK",
    "bot_04": "ALLOW",
    "bot_05": "ALLOW",
    "bot_06": "ALLOW",
    "bot_07": "BLOCK",
    "bot_08": "ALLOW",
    "bot_09": "BLOCK",
    "bot_10": "ALLOW"
  },
  "blacklist_tickers": [],
  "reason": "장세 요약 및 추세·돌파 vs 역추세·그리드 봇 스위칭 사유"
}
\`\`\``;

  return {
    regimeFilter,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    isHoldCash,
    regimeReason,
    nowStr,
    prompt,
  };
}

// [Antigravity-Doc] Gemini Flash/Pro 후보 모델 우선순위 목록 및 HTTP 429(30분)/503(10분) 쿨다운 관리
const GEMINI_FLASH_WORKING_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
];
const GEMINI_FLASH_CANDIDATE_MODELS = [...GEMINI_FLASH_WORKING_MODELS];
const GEMINI_PRO_PREVIEW_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-pro-latest",
];
// 무료 티어에서 상시 HTTP 429가 발생하는 Pro 프리뷰 모델은 GEMINI_ENABLE_PRO_PREVIEW=true 설정 시에만 최우선 배치
const GEMINI_PRO_CANDIDATE_MODELS =
  String(process.env.GEMINI_ENABLE_PRO_PREVIEW || "").trim().toLowerCase() === "true"
    ? [...GEMINI_PRO_PREVIEW_MODELS, ...GEMINI_FLASH_WORKING_MODELS]
    : [...GEMINI_FLASH_WORKING_MODELS, ...GEMINI_PRO_PREVIEW_MODELS];
// HTTP 429(할당량 소진) 모델 30분 쿨다운 · HTTP 503(과부하) 모델 10분 쿨다운 캐시
const GEMINI_429_COOLDOWN_MS = 30 * 60 * 1000;
const GEMINI_503_COOLDOWN_MS = 10 * 60 * 1000;
const geminiModelQuotaCooldownMap = new Map();

/**
 * [Antigravity-Doc] 현재 429/503 쿨다운 중인 Gemini 모델을 후보 목록에서 제외한다.
 * @param {string[]} [candidateModels=[]]
 * @returns {string[]}
 */
function filterGeminiModelsByCooldown(candidateModels = []) {
  const nowMs = Date.now();
  return candidateModels.filter((m) => (geminiModelQuotaCooldownMap.get(m) || 0) <= nowMs);
}

/**
 * [Antigravity-Doc] Pro/Flash 분석 슬롯별 우선순위 + 무료 티어 Fallback 후보 모델 목록을 반환한다.
 * @param {boolean} [isProTarget=false]
 * @param {string} [preferredModel=""] 최우선 지정 모델명
 * @returns {string[]}
 */
function getDualAiCandidateModels(isProTarget = false, preferredModel = "") {
  const pref = String(preferredModel || "").trim();
  const baseList = isProTarget ? [...GEMINI_PRO_CANDIDATE_MODELS] : [...GEMINI_FLASH_CANDIDATE_MODELS];
  if (pref && !baseList.includes(pref)) {
    return [pref, ...baseList];
  }
  return baseList;
}

// [Antigravity-Doc] Alternative.me 공포·탐욕 지수 5분 메모리 캐시
let cachedFngData = { checkedAtMs: 0, value: "N/A", classification: "N/A" };

/**
 * [Antigravity-Doc] 암호화폐 공포·탐욕 지수(Fear & Greed Index)를 5분 캐시와 함께 조회한다.
 * @param {{skipExternalApi?:boolean}} [options={}]
 * @returns {Promise<{value:string, classification:string}>}
 */
async function fetchQuickFearAndGreedIndex(options = {}) {
  if (options?.skipExternalApi) {
    return { value: "N/A", classification: "N/A" };
  }
  const nowMs = Date.now();
  if (nowMs - cachedFngData.checkedAtMs < 5 * 60 * 1000 && cachedFngData.value !== "N/A") {
    return { value: cachedFngData.value, classification: cachedFngData.classification };
  }
  try {
    const resp = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(4000),
    });
    if (resp.ok) {
      const json = await resp.json();
      const entry = json?.data?.[0];
      if (entry) {
        cachedFngData = {
          checkedAtMs: nowMs,
          value: String(entry.value ?? "N/A"),
          classification: String(entry.value_classification ?? "N/A"),
        };
        return { value: cachedFngData.value, classification: cachedFngData.classification };
      }
    }
  } catch {}
  return { value: cachedFngData.value || "N/A", classification: cachedFngData.classification || "N/A" };
}

/**
 * [Antigravity-Doc] 지정 마켓 목록의 업비트 현재가 및 전일대비 등락률을 요약 문자열로 조회한다(Ollama 프롬프트 주입용).
 * @param {string[]} [markets]
 * @param {{skipUpbitApi?:boolean}} [options={}]
 * @returns {Promise<{btcPrice:number|null, btcChangePct:number|null, tickerLines:string}>}
 */
async function fetchUpbitTickersSummary(markets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"], options = {}) {
  if (options?.skipUpbitApi) {
    return { btcPrice: null, btcChangePct: null, tickerLines: "" };
  }
  try {
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${markets.join(",")}`, {
      signal: AbortSignal.timeout(4500),
    });
    if (tResp.ok) {
      const tickers = await tResp.json();
      const btcItem = Array.isArray(tickers) ? tickers.find((t) => t.market === "KRW-BTC") : null;
      const btcPrice = btcItem ? Number(btcItem.trade_price || 0) : null;
      const btcChangePct = btcItem ? Number((Number(btcItem.signed_change_rate || 0) * 100).toFixed(2)) : null;
      const tickerLines = (Array.isArray(tickers) ? tickers : [])
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%)`
        )
        .join("\n");
      return { btcPrice, btcChangePct, tickerLines };
    }
  } catch {}
  return { btcPrice: null, btcChangePct: null, tickerLines: "" };
}

/**
 * [Antigravity-Doc] 로컬 Ollama 분석기에 주입할 실시간 시장 컨텍스트(BTC 이평선, 주요 시세, 공포탐욕지수, 오픈 포지션 종목, 활성 봇)를 병렬 수집한다.
 * @param {object} db
 * @param {object|null} [regimeCtx=null]
 * @param {object} [options={}]
 * @returns {Promise<{regimeFilter:object, marketContext:object, activeBots:Array<object>}>}
 */
async function fetchLiveMarketContextForOllama(db, regimeCtx = null, options = {}) {
  const regimeFilter = regimeCtx || (await checkMarketRegimeFilter(null, options));
  const [tickerSummary, fng, allBots, posRows, tradeRows] = await Promise.all([
    fetchUpbitTickersSummary(["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"], options),
    fetchQuickFearAndGreedIndex(options),
    getBots("live").catch(() => []),
    db.prepare("SELECT DISTINCT market FROM bot_positions WHERE status = 'OPEN'").all().catch(() => []),
    db.prepare("SELECT DISTINCT market FROM trades WHERE status = 'HOLDING'").all().catch(() => []),
  ]);

  const btcPrice = Number(regimeFilter?.btcPrice || tickerSummary.btcPrice || 0);
  const btcDaily20Ma = Number(regimeFilter?.ma20Day || 0);
  const btc4h60Ma = Number(regimeFilter?.ma60_4h || 0);
  const openTickers = Array.from(
    new Set([
      ...(posRows || []).map((r) => String(r.market || "").trim()).filter(Boolean),
      ...(tradeRows || []).map((r) => String(r.market || "").trim()).filter(Boolean),
    ])
  );
  const selectedBots = (allBots || []).filter((b) => Number(b.is_selected_for_live) === 1);
  const activeBots = selectedBots.length > 0 ? selectedBots : allBots || [];

  return {
    regimeFilter,
    marketContext: {
      btcPrice: btcPrice || null,
      btcChangePct: tickerSummary.btcChangePct,
      btcDaily20Ma: btcDaily20Ma || null,
      btc4h60Ma: btc4h60Ma || null,
      fngValue: fng.value,
      fngClass: fng.classification,
      openTickers,
      tickerLines: tickerSummary.tickerLines,
    },
    activeBots,
  };
}

/**
 * [Antigravity-Doc] 로컬 Ollama(`qwen3-news` 등) `/api/chat`을 호출하여 최근 암호화폐 뉴스·시황 기반 10대 봇 제어 JSON을 생성한다.
 * CPU 추론 최적화(`think: false`, `format: "json"`, `keep_alive: "35m"`, 뉴스 최대 6건 90자 압축)를 적용하고
 * 응답을 `normalizeLlmRegimeDecision`으로 검증·정규화한다.
 * @param {Array} [newsList=[]]
 * @param {object} [marketContext={}]
 * @param {Array} [activeBots=[]]
 * @param {object} [options={}]
 * @returns {Promise<object>} provider="ollama" 정규화 결정 객체
 */
async function callLocalOllamaCoinNewsAnalyzer(newsList = [], marketContext = {}, activeBots = [], options = {}) {
  const config = typeof getRuntimeConfig === "function" ? getRuntimeConfig() : {};
  const envOverride = process.env.AUTOCOIN_LIBRARY_MODE === "1";
  const baseUrl = String(
    options?.baseUrl ||
      (envOverride ? process.env.OLLAMA_BASE_URL : "") ||
      config.ollama_base_url ||
      process.env.OLLAMA_BASE_URL ||
      "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
  const modelName = String(
    options?.model ||
      (envOverride ? process.env.OLLAMA_NEWS_MODEL : "") ||
      config.ollama_news_model ||
      process.env.OLLAMA_NEWS_MODEL ||
      "qwen3-news"
  ).trim() || "qwen3-news";
  const timeoutMs = Number(
    options?.timeoutMs ||
      (envOverride ? process.env.OLLAMA_TIMEOUT_MS : "") ||
      config.ollama_timeout_ms ||
      process.env.OLLAMA_TIMEOUT_MS ||
      DEFAULT_OLLAMA_TIMEOUT_MS
  ) || DEFAULT_OLLAMA_TIMEOUT_MS;

  // CPU 추론 최적화: 최신 코인 뉴스 최대 6건, 제목 90자 이내로 압축
  const compactNewsText = (Array.isArray(newsList) ? newsList : [])
    .slice(0, 6)
    .map((n, idx) => {
      if (typeof n === "string") {
        return `${idx + 1}.${n.replace(/\s+/g, " ").trim().slice(0, 90)}`;
      }
      const sentimentTag = n?.sentiment === "BULLISH" ? "호재" : n?.sentiment === "BEARISH" ? "악재" : "중립";
      const title = String(n?.title || "").replace(/\s+/g, " ").trim().slice(0, 90);
      return `${idx + 1}.[${sentimentTag}]${title}`;
    })
    .join("\n");

  const userPrompt = `업비트 30분 시황·뉴스 JSON 분석:
[시황] KRW-BTC=${marketContext.btcPrice ?? "N/A"}원(24h ${marketContext.btcChangePct ?? "N/A"}%) | 일봉20MA=${marketContext.btcDaily20Ma ?? "N/A"} | 4h60MA=${marketContext.btc4h60Ma ?? "N/A"} | 공포탐욕=${marketContext.fngValue ?? "N/A"}(${marketContext.fngClass ?? "N/A"}) | 전략군=돌파형(bot_01,02,03,04,07,09)/역추세·그리드(bot_05,06,08,10) | 보유=${(marketContext.openTickers || []).join(",") || "없음"}
[뉴스]
${compactNewsText || "특이 속보 없음"}
[판단 규칙]
- risk_alert=true 및 HALT_NEW_BUYS는 해킹·디페깅·상폐·패닉폭락(HIGH_VOLATILITY_SHOCK) 때만 사용(전체 BLOCK, mult=0.0).
- 단순 약세(BEAR)·횡보(SIDEWAYS)는 risk_alert=false, recommended_action="REDUCE_SIZE", position_size_multiplier=0.5, 돌파형(bot_01,02,03,04,07,09)="BLOCK", 역추세·그리드(bot_05,06,08,10)="ALLOW".
- blacklist_tickers는 뉴스에 특정 코인의 해킹·상폐·유의종목 악재가 직접 명시된 경우에만 영문 티커(예: "KRW-XRP")를 넣고, 무관하거나 불확실하면 반드시 빈 배열 []로 출력.
[JSON 스키마]
{"sentiment_score":-1.0~1.0,"market_regime":"BULL|SIDEWAYS|BEAR|HIGH_VOLATILITY_SHOCK","risk_alert":false,"recommended_action":"NORMAL|REDUCE_SIZE|HALT_NEW_BUYS|EMERGENCY_CLOSE_ALL","position_size_multiplier":1.0,"bot_overrides":{"bot_01":"ALLOW|BLOCK","bot_02":"ALLOW|BLOCK","bot_03":"ALLOW|BLOCK","bot_04":"ALLOW|BLOCK","bot_05":"ALLOW|BLOCK","bot_06":"ALLOW|BLOCK","bot_07":"ALLOW|BLOCK","bot_08":"ALLOW|BLOCK","bot_09":"ALLOW|BLOCK","bot_10":"ALLOW|BLOCK"},"blacklist_tickers":[],"reason":"한국어 1~2문장(70자이내) 요약"}`;

  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: modelName,
      stream: false,
      think: false, // 필수: Qwen3 내부 추론 비활성화 (인텔 맥북 CPU 응답 속도 단축)
      format: "json", // 필수: 엄격한 JSON 출력 강제
      keep_alive: "35m", // 30분 슬롯 간 모델 메모리 상주 유지 (콜드로드 타임아웃 방지)
      messages: [
        { role: "system", content: "업비트 암호화폐 30분 단기 시황·뉴스 JSON 분석기. 지정 JSON 스키마만 간결히 출력." },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawContent = String(data?.message?.content || data?.response || "").trim();
  if (!rawContent) {
    throw new Error("Ollama returned empty message content");
  }
  let cleanedJsonStr = rawContent.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const firstBrace = cleanedJsonStr.indexOf("{");
  const lastBrace = cleanedJsonStr.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleanedJsonStr = cleanedJsonStr.slice(firstBrace, lastBrace + 1);
  }
  const parsed = JSON.parse(cleanedJsonStr);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama response JSON is not an object");
  }
  const hasCoreField =
    "sentiment_score" in parsed ||
    "market_regime" in parsed ||
    "recommended_action" in parsed ||
    "bot_overrides" in parsed;
  if (!hasCoreField) {
    throw new Error("Ollama response JSON missing required decision fields");
  }

  // 스키마 정규화 및 risk_alert/REDUCE_SIZE 모순 방어 검증 (Gemini 파서와 동일 규칙 적용)
  const normalized = normalizeLlmRegimeDecision(parsed, "로컬 Ollama(qwen3-news) 30분 암호화폐 뉴스·시황 분석 완료");

  return {
    provider: "ollama",
    model: modelName,
    model_tier: "OLLAMA_QWEN3_30M",
    latencyMs: Date.now() - startedAt,
    ...normalized,
  };
}

/**
 * [Antigravity-Doc] 로컬 Ollama JSON 분석 결과를 대시보드 시황 브리핑 마크다운 문서로 포맷팅한다.
 * @param {object} ollamaRes
 * @param {object} [marketContext={}]
 * @param {Array} [activeBots=[]]
 * @returns {string}
 */
function buildOllamaMarketBriefingMarkdown(ollamaRes, marketContext = {}, activeBots = []) {
  const score = Number(ollamaRes?.sentiment_score || 0);
  const scoreStr = `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
  const multPct = Math.round(Number(ollamaRes?.position_size_multiplier ?? 1) * 100);
  const overrides = normalizeBotOverrides(ollamaRes?.bot_overrides);
  const allowBots = ALL_BOT_IDS.filter((id) => overrides[id] === "ALLOW").map(
    (id) => `${id}(${BOT_STRATEGY_GUIDE[id]?.name || id})`
  );
  const blockBots = ALL_BOT_IDS.filter((id) => overrides[id] === "BLOCK").map(
    (id) => `${id}(${BOT_STRATEGY_GUIDE[id]?.name || id})`
  );
  const btcPriceTxt = marketContext.btcPrice ? `${Number(marketContext.btcPrice).toLocaleString("ko-KR")}원` : "수신 중";
  const ma20Txt = marketContext.btcDaily20Ma ? `${Math.floor(Number(marketContext.btcDaily20Ma)).toLocaleString("ko-KR")}원` : "-";
  const ma4hTxt = marketContext.btc4h60Ma ? `${Math.floor(Number(marketContext.btc4h60Ma)).toLocaleString("ko-KR")}원` : "-";
  const liveNames =
    Array.isArray(activeBots) && activeBots.length > 0
      ? activeBots.map((b) => `${b.bot_id}(${b.nickname || b.name || b.bot_id})`).join(", ")
      : "전체 10대 봇";

  return [
    `## ⚡ Flash 단기 진단 (로컬 Ollama \`${ollamaRes.model}\` · ${ollamaRes.latencyMs}ms)`,
    `- **시장 체제**: \`${ollamaRes.market_regime}\` | **권고 액션**: \`${ollamaRes.recommended_action}\` | **투입 비중**: **${multPct}%**`,
    `- **단기 뉴스 감성 점수**: **${scoreStr}** | **돌발 리스크 경보**: ${ollamaRes.risk_alert ? "🔴 경보 발령 (신규 매수 전면 차단)" : "🟢 정상 (특이 돌발 쇼크 없음)"}`,
    `- **블랙리스트 진입 제한 종목**: ${ollamaRes.blacklist_tickers?.length ? ollamaRes.blacklist_tickers.join(", ") : "없음"}`,
    ``,
    `## 🧠 단기 시황 · 뉴스 감성 판단 근거`,
    `${ollamaRes.reason}`,
    ``,
    `## 🤖 10대 봇 신규 진입 게이트웨이 (ALLOW / BLOCK)`,
    `- **실전 가동 대상**: ${liveNames}`,
    `- **신규 매수 허용(ALLOW · ${allowBots.length}개)**: ${allowBots.length ? allowBots.join(", ") : "없음"}`,
    `- **신규 매수 보류(BLOCK · ${blockBots.length}개)**: ${blockBots.length ? blockBots.join(", ") : "없음"}`,
    `- **포지션 보호 원칙**: \`BLOCK\`은 신규 매수만 보류하며, 기존 보유 코인은 각 봇의 익절/손절/트레일링 스탑 로직으로 끝까지 감시·청산됩니다.`,
    ``,
    `## 💡 실시간 기술 지표 참고 (KRW-BTC)`,
    `- **KRW-BTC 현재가**: ${btcPriceTxt}${marketContext.btcChangePct !== null && marketContext.btcChangePct !== undefined ? ` (24h ${marketContext.btcChangePct >= 0 ? "+" : ""}${marketContext.btcChangePct}%)` : ""}`,
    `- **일봉 20MA**: ${ma20Txt} | **4시간봉 60MA**: ${ma4hTxt}`,
    `- **공포·탐욕 지수**: ${marketContext.fngValue ?? "N/A"} (${marketContext.fngClass ?? "N/A"})`,
  ].join("\n");
}

/**
 * [Antigravity-Doc] 로컬 Ollama JSON 분석 결과와 뉴스 통계를 대시보드 뉴스 브리핑 마크다운 문서로 포맷팅한다.
 * @param {object} ollamaRes
 * @param {object} [statsContext={}]
 * @returns {string}
 */
function buildOllamaNewsBriefingMarkdown(ollamaRes, statsContext = {}) {
  const { totalNews = 0, bullCount = 0, bearCount = 0, neutCount = 0, topNews = [], marketContext = {} } = statsContext;
  const score = Number(ollamaRes?.sentiment_score || 0);
  const scoreStr = `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
  const multPct = Math.round(Number(ollamaRes?.position_size_multiplier ?? 1) * 100);
  const overrides = normalizeBotOverrides(ollamaRes?.bot_overrides);
  const allowBots = ALL_BOT_IDS.filter((id) => overrides[id] === "ALLOW");
  const blockBots = ALL_BOT_IDS.filter((id) => overrides[id] === "BLOCK");
  const headlinesPreview = (topNews || [])
    .slice(0, 5)
    .map((n, idx) => `${idx + 1}. [${n.sentiment || "NEUTRAL"}] ${n.title} (${n.source || "NEWS"})`)
    .join("\n");

  return [
    `## 1. 📰 실시간 뉴스 핵심 쟁점 및 센티먼트 종합 진단 (로컬 Ollama \`${ollamaRes.model}\`)`,
    `- **분석 엔진**: 맥북 프로 로컬 Ollama (\`${ollamaRes.model}\`, 응답시간 ${ollamaRes.latencyMs}ms, API 비용 0원)`,
    `- **수집 통계**: 총 ${totalNews}건 (호재 ${bullCount}건 · 악재 ${bearCount}건 · 중립 ${neutCount}건)`,
    `- **단기 감성 점수**: **${scoreStr}** | **판단 체제**: \`${ollamaRes.market_regime}\` | **리스크 경보**: ${ollamaRes.risk_alert ? "🔴 ON" : "🟢 OFF"}`,
    `- **핵심 요약**: ${ollamaRes.reason}`,
    ``,
    `## 2. ⚖️ 시장 충격도 & 단기 시황 전망`,
    `- **BTC 현재가**: ${marketContext.btcPrice ? Number(marketContext.btcPrice).toLocaleString("ko-KR") + "원" : "수신 중"} (일봉 20MA: ${marketContext.btcDaily20Ma ? Math.floor(Number(marketContext.btcDaily20Ma)).toLocaleString("ko-KR") + "원" : "-"} / 4시간 60MA: ${marketContext.btc4h60Ma ? Math.floor(Number(marketContext.btc4h60Ma)).toLocaleString("ko-KR") + "원" : "-"})`,
    `- **블랙리스트 지정 종목**: ${ollamaRes.blacklist_tickers?.length ? ollamaRes.blacklist_tickers.join(", ") : "특이 악재 종목 없음"}`,
    headlinesPreview ? `\n**최근 반영 주요 헤드라인 (상위 5건)**:\n${headlinesPreview}` : "",
    ``,
    `## 3. 🎯 퀀트 트레이딩 봇 운용 및 리스크 관리 전략`,
    `- **권고 액션**: \`${ollamaRes.recommended_action}\` (**권장 투입 비중: ${multPct}%**)`,
    `- **ALLOW 봇 (${allowBots.length}개)**: ${allowBots.length ? allowBots.join(", ") : "없음"}`,
    `- **BLOCK 봇 (${blockBots.length}개)**: ${blockBots.length ? blockBots.join(", ") : "없음"}`,
    `- **리스크 가드**: 돌발 악재 미감지 시에도 급등 추격 매수를 지양하고, 기존 보유 포지션은 각 봇의 고유 청산 알고리즘으로 안전 관리합니다.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * [Antigravity-Doc] 완성된 마크다운 텍스트(예: Ollama/폴백 결과)를 SSE `chunk` 이벤트로 분할 전송하여 스트리밍 UX를 제공한다.
 * @param {http.ServerResponse} res
 * @param {http.IncomingMessage} req
 * @param {string} fullText
 * @param {number} [chunkSize=12]
 * @param {number} [delayMs=4]
 */
async function streamTextAsSseChunks(res, req, fullText, chunkSize = 12, delayMs = 4) {
  const text = String(fullText || "");
  for (let i = 0; i < text.length; i += chunkSize) {
    if (res.writableEnded || req?.destroyed) break;
    const piece = text.slice(i, i + chunkSize);
    res.write(`data: ${JSON.stringify({ type: "chunk", text: piece })}\n\n`);
    if (delayMs > 0 && i + chunkSize < text.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// [Antigravity-Doc] Gemini 429 할당량 초과 멀티채널 알림 30분 중복 방지 쿨다운
const GEMINI_QUOTA_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
let lastGeminiQuotaNotifyMs = 0;

/**
 * [Antigravity-Doc] Gemini API 호출 한도 초과(HTTP 429 / 일일 무료 한도 소진) 발생 시 30분 쿨다운으로 텔레그램 등 멀티채널 알림을 발송한다.
 * @param {{source?:string, triggerType?:string, fallbackTier?:string, reason?:string}} [params]
 * @returns {boolean} 알림 발송 여부 (쿨다운 중이면 false)
 */
function notifyGeminiQuotaExceeded({
  source = "Gemini API",
  triggerType = "AUTO",
  fallbackTier = "MECHANICAL_20MA",
  reason = "Gemini API 호출 한도 초과(HTTP 429)",
} = {}) {
  const now = Date.now();
  if (now - lastGeminiQuotaNotifyMs < GEMINI_QUOTA_NOTIFY_COOLDOWN_MS) {
    return false;
  }
  lastGeminiQuotaNotifyMs = now;
  try {
    dispatchMultiChannelNotification(
      getDb(),
      {
        eventType: "GEMINI_QUOTA_EXCEEDED",
        source,
        trigger_type: triggerType,
        fallback_tier: fallbackTier,
        reason,
      },
      { webPushBroadcastFn: broadcastWebPushNotification }
    ).catch(() => {});
  } catch {}
  return true;
}

/**
 * [Antigravity-Doc] Gemini `generateContent` API를 후보 모델 순회 + 지수 백오프(1s/2s/4s) + 429/503 쿨다운 캐시와 함께 호출한다.
 * Flash 모델에서 `thinkingConfig` 400 오류가 나면 자동으로 해당 옵션을 제거해 재시도한다.
 * @param {object} params apiKey, candidateModels, prompt, temperature, timeoutMs, backoffDelaysMs, logTag
 * @returns {Promise<{chosenModel:string, analysisText:string, lastErrorMsg:string, quota429Count:number, allQuota429:boolean}>}
 */
async function callGeminiGenerateWithBackoff({
  apiKey,
  candidateModels,
  prompt,
  temperature = 0.25,
  timeoutMs = 55000,
  backoffDelaysMs = [1000, 2000, 4000],
  logTag = "Gemini API",
}) {
  const initialActiveModels = filterGeminiModelsByCooldown(candidateModels);
  const allInCooldown = candidateModels.length > 0 && initialActiveModels.length === 0;
  let chosenModel = initialActiveModels[0] || candidateModels[0];
  let analysisText = "";
  let lastErrorMsg = allInCooldown ? "All candidate models are in 429 quota cooldown" : "";
  let quota429Count = 0;
  let lastAttemptModelCount = candidateModels.length;
  const unavailable404Models = new Set();
  const attemptQuota429Models = new Set();

  if (allInCooldown) {
    console.warn(`[${logTag}] All ${candidateModels.length} candidate models are in 429 cooldown; skipping API calls for immediate fallback.`);
  }

  for (let attempt = 0; attempt < backoffDelaysMs.length + 1 && !analysisText; attempt += 1) {
    // 매 시도마다 429 쿨다운 모델과 이번 호출에서 이미 429가 발생한 모델을 제외
    const cooledModels = filterGeminiModelsByCooldown(candidateModels).filter(
      (m) => !unavailable404Models.has(m) && !attemptQuota429Models.has(m)
    );
    if (cooledModels.length === 0) break;
    lastAttemptModelCount = cooledModels.length;
    quota429Count = 0;
    for (const model of cooledModels) {
      if (unavailable404Models.has(model) || attemptQuota429Models.has(model)) continue;
      let timeoutTimer = null;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          apiKey
        )}`;
        const useNoThinking = model.toLowerCase().includes("flash") && !model.toLowerCase().includes("lite");
        const doPost = async (includeThinkingCfg) => {
          const controller = new AbortController();
          timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
          const generationConfig = {
            temperature,
            maxOutputTokens: 8192,
            ...(includeThinkingCfg ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          };
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
            }),
          });
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
          return resp;
        };

        let response = await doPost(useNoThinking);
        if (response.status === 400 && useNoThinking) {
          const probeErr = await response.text();
          if (probeErr.toLowerCase().includes("thinking")) {
            response = await doPost(false);
          } else {
            unavailable404Models.add(model);
            console.warn(`[${logTag}] Model ${model} failed (HTTP 400, attempt ${attempt + 1}):`, probeErr.slice(0, 200));
            try {
              const errJson = JSON.parse(probeErr);
              lastErrorMsg = errJson?.error?.message || "HTTP 400";
            } catch {
              lastErrorMsg = `HTTP 400: ${probeErr.slice(0, 120)}`;
            }
            continue;
          }
        }

        if (response.ok) {
          const resJson = await response.json();
          const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            geminiModelQuotaCooldownMap.delete(model);
            chosenModel = model;
            analysisText = text;
            break;
          }
        } else {
          const errText = await response.text();
          if (response.status === 429) {
            quota429Count += 1;
            attemptQuota429Models.add(model);
            geminiModelQuotaCooldownMap.set(model, Date.now() + GEMINI_429_COOLDOWN_MS);
          } else if (response.status === 503) {
            geminiModelQuotaCooldownMap.set(model, Date.now() + GEMINI_503_COOLDOWN_MS);
          }
          if (response.status === 404 || response.status === 400) unavailable404Models.add(model);
          console.warn(`[${logTag}] Model ${model} failed (HTTP ${response.status}, attempt ${attempt + 1}):`, errText.slice(0, 200));
          try {
            const errJson = JSON.parse(errText);
            lastErrorMsg = errJson?.error?.message || `HTTP ${response.status}`;
          } catch {
            lastErrorMsg = `HTTP ${response.status}: ${errText.slice(0, 120)}`;
          }
        }
      } catch (reqErr) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const errMsg = String(reqErr?.message || reqErr || "");
        if (reqErr?.name === "AbortError" || errMsg.toLowerCase().includes("abort") || errMsg.toLowerCase().includes("timeout")) {
          geminiModelQuotaCooldownMap.set(model, Date.now() + GEMINI_503_COOLDOWN_MS);
        }
        console.warn(`[${logTag}] Request exception for model ${model} (attempt ${attempt + 1}):`, errMsg);
        lastErrorMsg = errMsg;
      }
    }

    const remainingModels = filterGeminiModelsByCooldown(candidateModels).filter(
      (m) => !unavailable404Models.has(m) && !attemptQuota429Models.has(m)
    );
    if (!analysisText && remainingModels.length > 0 && attempt < backoffDelaysMs.length) {
      const waitMs = backoffDelaysMs[attempt];
      console.log(`[${logTag}] Waiting ${waitMs / 1000}s exponential backoff before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return {
    chosenModel,
    analysisText,
    lastErrorMsg,
    quota429Count: allInCooldown ? candidateModels.length : attemptQuota429Models.size || quota429Count,
    allQuota429:
      allInCooldown ||
      (attemptQuota429Models.size > 0 &&
        attemptQuota429Models.size >= Math.max(1, lastAttemptModelCount - unavailable404Models.size)),
  };
}

/**
 * [Antigravity-Doc] Gemini `streamGenerateContent?alt=sse` 스트리밍 API를 후보 모델 순회 + 지수 백오프 + 쿨다운 캐시와 함께 호출한다.
 * @param {object} params
 * @returns {Promise<{geminiResp:Response|null, chosenModel:string, quota429Count:number, allQuota429:boolean}>}
 */
async function callGeminiStreamWithBackoff({
  apiKey,
  candidateModels,
  prompt,
  temperature = 0.25,
  timeoutMs = 55000,
  backoffDelaysMs = [1000, 2000, 4000],
  logTag = "Gemini Stream",
}) {
  const initialActiveModels = filterGeminiModelsByCooldown(candidateModels);
  const allInCooldown = candidateModels.length > 0 && initialActiveModels.length === 0;
  let geminiResp = null;
  let chosenModel = initialActiveModels[0] || candidateModels[0];
  let quota429Count = 0;
  let lastAttemptModelCount = candidateModels.length;
  const unavailable404Models = new Set();
  const attemptQuota429Models = new Set();

  if (allInCooldown) {
    console.warn(`[${logTag}] All ${candidateModels.length} candidate models are in 429 cooldown; skipping stream API calls.`);
  }

  for (let attempt = 0; attempt < backoffDelaysMs.length + 1 && !geminiResp; attempt += 1) {
    const cooledModels = filterGeminiModelsByCooldown(candidateModels).filter(
      (m) => !unavailable404Models.has(m) && !attemptQuota429Models.has(m)
    );
    if (cooledModels.length === 0) break;
    lastAttemptModelCount = cooledModels.length;
    quota429Count = 0;
    for (const model of cooledModels) {
      if (unavailable404Models.has(model) || attemptQuota429Models.has(model)) continue;
      let timeoutTimer = null;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
          apiKey
        )}`;
        const useNoThinking = model.toLowerCase().includes("flash") && !model.toLowerCase().includes("lite");
        const doPost = async (includeThinkingCfg) => {
          const controller = new AbortController();
          timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
          const generationConfig = {
            temperature,
            maxOutputTokens: 8192,
            ...(includeThinkingCfg ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          };
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
            }),
          });
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
          return r;
        };

        let resp = await doPost(useNoThinking);
        if (resp.status === 400 && useNoThinking) {
          const probeErr = await resp.text();
          if (probeErr.toLowerCase().includes("thinking")) {
            resp = await doPost(false);
          } else {
            unavailable404Models.add(model);
            console.warn(`[${logTag}] Model ${model} failed (HTTP 400, attempt ${attempt + 1}):`, probeErr.slice(0, 200));
            continue;
          }
        }
        if (resp.ok) {
          geminiModelQuotaCooldownMap.delete(model);
          geminiResp = resp;
          chosenModel = model;
          break;
        } else {
          const errTxt = await resp.text();
          if (resp.status === 429) {
            quota429Count += 1;
            attemptQuota429Models.add(model);
            geminiModelQuotaCooldownMap.set(model, Date.now() + GEMINI_429_COOLDOWN_MS);
          } else if (resp.status === 503) {
            geminiModelQuotaCooldownMap.set(model, Date.now() + GEMINI_503_COOLDOWN_MS);
          }
          if (resp.status === 404 || resp.status === 400) unavailable404Models.add(model);
          console.warn(`[${logTag}] Model ${model} failed (HTTP ${resp.status}, attempt ${attempt + 1}):`, errTxt.slice(0, 200));
        }
      } catch (e) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const errMsg = String(e?.message || e || "");
        if (e?.name === "AbortError" || errMsg.toLowerCase().includes("abort") || errMsg.toLowerCase().includes("timeout")) {
          geminiModelQuotaCooldownMap.set(model, Date.now() + GEMINI_503_COOLDOWN_MS);
        }
        console.warn(`[${logTag}] Exception with model ${model} (attempt ${attempt + 1}):`, errMsg);
      }
    }
    const remainingModels = filterGeminiModelsByCooldown(candidateModels).filter(
      (m) => !unavailable404Models.has(m) && !attemptQuota429Models.has(m)
    );
    if (!geminiResp && remainingModels.length > 0 && attempt < backoffDelaysMs.length) {
      await new Promise((r) => setTimeout(r, backoffDelaysMs[attempt]));
    }
  }

  return {
    geminiResp,
    chosenModel,
    quota429Count: allInCooldown ? candidateModels.length : attemptQuota429Models.size || quota429Count,
    allQuota429:
      allInCooldown ||
      (attemptQuota429Models.size > 0 &&
        attemptQuota429Models.size >= Math.max(1, lastAttemptModelCount - unavailable404Models.size)),
  };
}

/**
 * [Antigravity-Doc] Tier-3 기계적 폴백(BTC 일봉 20MA / 4시간 60MA 기반)을 실행해 `market_regime_filter`에 즉시 반영한다.
 * @param {{isPro?:boolean, btcPrice?:number, btcDaily20Ma?:number, btc4h60Ma?:number, label?:string}} [params]
 * @returns {Promise<object|null>}
 */
async function applyTier3MechanicalFallback({ isPro = false, btcPrice = 0, btcDaily20Ma = 0, btc4h60Ma = 0, label = "Mechanical Fallback" } = {}) {
  try {
    const fbDecision = buildMechanicalFallbackRegime({ btcPrice, btcDaily20Ma, btc4h60Ma, label });
    return await updateMarketRegimeFilterFromAnalysis({
      isPro,
      provider: "fallback",
      model: "mechanical-btc-20ma",
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      isHoldCash: fbDecision.recommended_action === "HALT_NEW_BUYS",
      regimeReason: fbDecision.reason,
      decision: fbDecision,
      isFallback: true,
    });
  } catch (fbErr) {
    console.warn("[Tier3 Mechanical Fallback] updateMarketRegimeFilter error:", fbErr.message);
    return null;
  }
}

/**
 * [Antigravity-Doc] Gemini SSE 응답 스트림을 청크 단위로 읽어 클라이언트에 실시간 중계(`chunk` 이벤트)하고 전체 텍스트를 누적 반환한다.
 * @param {Response} geminiResp
 * @param {http.ServerResponse} res
 * @returns {Promise<string>}
 */
async function consumeGeminiSseBody(geminiResp, res) {
  const reader = geminiResp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`);
          }
        } catch {}
      }
    }
  }

  if (sseBuffer.trim().startsWith("data:")) {
    const jsonStr = sseBuffer.trim().slice(5).trim();
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
      if (delta) {
        fullText += delta;
        res.write(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`);
      }
    } catch {}
  }

  return fullText;
}

/**
 * [Antigravity-Doc] 시황 분석 결과를 `market_regime_filter`에 반영하고 `ai_market_briefings` 테이블에 영속화한다.
 * 필요 시 자동 슬롯 키(`ai_briefing_last_auto_slot`)와 Gemini 일일 쿼터(`consumeQuota`)를 함께 갱신한다.
 * @param {object} params
 * @returns {Promise<{updatedRegime:object|null, regimeStatus:string, briefingId:number, updatedQuota:object}>}
 */
async function persistMarketBriefingAndUpdateRegime({
  db,
  provider,
  model,
  isProTarget,
  btcPrice,
  btcDaily20Ma,
  btc4h60Ma,
  isHoldCash,
  regimeReason,
  analysisText,
  briefingMarkdown,
  decision,
  nowStr,
  triggerType,
  slotKey,
  consumeQuota = false,
}) {
  const updatedRegime = await updateMarketRegimeFilterFromAnalysis({
    isPro: isProTarget,
    provider,
    model,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    isHoldCash,
    regimeReason,
    analysisText,
    decision,
  });

  const hasOwnDecision = Boolean(decision && typeof decision === "object");
  const ownAction = String(
    (hasOwnDecision ? decision.recommended_action : null) || updatedRegime?.recommended_action || "NORMAL"
  ).toUpperCase();
  const ownRegime = String(
    (hasOwnDecision ? decision.market_regime : null) || updatedRegime?.market_regime || "NORMAL"
  ).toUpperCase();
  const regimeStatus = !hasOwnDecision
    ? "PARSE_FALLBACK"
    : ownAction === "HALT_NEW_BUYS" || ownAction === "EMERGENCY_CLOSE_ALL"
    ? "HOLD_CASH"
    : ownRegime;

  const decisionSnapshot = hasOwnDecision
    ? normalizeLlmRegimeDecision(decision, regimeReason || String(decision.reason || ""))
    : updatedRegime
    ? {
        sentiment_score: updatedRegime.sentiment_score,
        market_regime: updatedRegime.market_regime,
        risk_alert: Boolean(Number(updatedRegime.final_risk_alert ?? updatedRegime.risk_alert ?? 0)),
        recommended_action: updatedRegime.recommended_action,
        position_size_multiplier: updatedRegime.final_position_multiplier ?? updatedRegime.position_size_multiplier,
        bot_overrides: updatedRegime.final_bot_overrides || updatedRegime.bot_overrides,
        blacklist_tickers: updatedRegime.blacklist_tickers || [],
        reason: updatedRegime.reason || regimeReason || "",
      }
    : null;
  const decisionJsonStr = decisionSnapshot ? JSON.stringify(decisionSnapshot) : null;

  const insertStmt = await db.prepare(`
    INSERT INTO ai_market_briefings (
      provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, decision_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = await insertStmt.run(
    provider,
    model,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    regimeStatus,
    briefingMarkdown,
    decisionJsonStr,
    nowStr
  );

  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_briefing_last_trigger_type', ?, ?)")
    .run(triggerType, nowStr);
  if (triggerType === "AUTO" && slotKey && !isProTarget) {
    await db
      .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_briefing_last_auto_slot', ?, ?)")
      .run(slotKey, nowStr);
  }
  const updatedQuota = consumeQuota ? await consumeGeminiQuota(triggerType) : await getGeminiQuotaStatus();

  return {
    updatedRegime,
    regimeStatus,
    briefingId: info.lastInsertRowid,
    updatedQuota,
  };
}

/**
 * [Antigravity-Doc] 3-Tier 폴백 구조의 AI 시황 분석 메인 오케스트레이터(비스트리밍).
 *  - Tier 1 (Flash 트랙 한정): 로컬 Ollama(`qwen3-news`) 호출 (API 비용 0원)
 *  - Tier 2: Google Gemini API (후보 모델 순회 + 지수 백오프 + 429/503 쿨다운)
 *  - Tier 3: BTC 일봉 20MA / 4시간 60MA 기반 기계적 폴백(`applyTier3MechanicalFallback`)
 * 부수효과: DB `ai_market_briefings`, `market_regime_filter`, `system_settings` 갱신 및 429 초과 시 멀티채널 알림
 * @param {{triggerType?:"AUTO"|"MANUAL", slotKey?:string, modelType?:"flash"|"pro", preferredModel?:string}} [options={}]
 * @returns {Promise<object>}
 */
async function generateAiMarketAnalysis(options = {}) {
  const triggerType = options?.triggerType === "AUTO" ? "AUTO" : "MANUAL";
  const slotKey = options?.slotKey || null;
  const isProTarget = options?.modelType === "pro" || String(options?.preferredModel || "").includes("pro");
  const db = getDb();
  const nowStr = nowKSTString();

  const ollamaCfg = await getOllamaRuntimeConfig(options);
  const useLocalOllama =
    !isProTarget &&
    (options?.useLocalOllama !== undefined ? Boolean(options.useLocalOllama) : ollamaCfg.enabled);

  // 1순위: 30분 단기 시황·뉴스 분석(FLASH_30M) -> 맥북 프로 로컬 Ollama(qwen3-news) 호출
  let ollamaAttempted = false;
  let ollamaFallbackReason = "";
  let cachedOllamaContext = null;

  if (useLocalOllama) {
    ollamaAttempted = true;
    try {
      const [recentNews, ollamaCtxPack] = await Promise.all([
        getRecentNewsForAiAnalysis(db, 12),
        fetchLiveMarketContextForOllama(db, null, options),
      ]);
      cachedOllamaContext = ollamaCtxPack;

      const ollamaRes = await callLocalOllamaCoinNewsAnalyzer(
        recentNews,
        ollamaCtxPack.marketContext,
        ollamaCtxPack.activeBots,
        {
          baseUrl: options?.ollamaBaseUrl || ollamaCfg.baseUrl,
          model: options?.ollamaModel || ollamaCfg.model,
          timeoutMs: options?.ollamaTimeoutMs || ollamaCfg.timeoutMs,
        }
      );

      const btcPrice = Number(ollamaCtxPack.marketContext.btcPrice || 0);
      const btcDaily20Ma = Number(ollamaCtxPack.marketContext.btcDaily20Ma || 0);
      const btc4h60Ma = Number(ollamaCtxPack.marketContext.btc4h60Ma || 0);
      const briefingMarkdown = buildOllamaMarketBriefingMarkdown(
        ollamaRes,
        ollamaCtxPack.marketContext,
        ollamaCtxPack.activeBots
      );

      const saved = await persistMarketBriefingAndUpdateRegime({
        db,
        provider: "ollama",
        model: ollamaRes.model,
        isProTarget: false,
        btcPrice,
        btcDaily20Ma,
        btc4h60Ma,
        isHoldCash: ollamaRes.recommended_action === "HALT_NEW_BUYS" || ollamaRes.recommended_action === "EMERGENCY_CLOSE_ALL",
        regimeReason: ollamaRes.reason,
        analysisText: briefingMarkdown,
        briefingMarkdown,
        decision: ollamaRes,
        nowStr,
        triggerType,
        slotKey,
        consumeQuota: false,
      });

      return {
        success: true,
        provider: "ollama",
        fallback_used: false,
        trigger_type: triggerType,
        quota: saved.updatedQuota,
        ollama: await checkOllamaStatus(options),
        regime_filter: saved.updatedRegime,
        ollamaResult: ollamaRes,
        ollamaMarketContext: ollamaCtxPack.marketContext,
        briefing: {
          id: saved.briefingId,
          provider: "ollama",
          model: ollamaRes.model,
          btc_price: btcPrice,
          btc_daily_20ma: btcDaily20Ma,
          btc_4h_60ma: btc4h60Ma,
          regime_status: saved.regimeStatus,
          briefing_text: briefingMarkdown,
          created_at: nowStr,
          trigger_type: triggerType,
        },
      };
    } catch (ollamaErr) {
      ollamaFallbackReason = ollamaErr.message;
      console.warn(`[OllamaFallback] 로컬 맥북 Ollama 연결 실패 (${ollamaErr.message}) -> Gemini Flash 백업 엔진 전환`);
    }
  }

  // 2순위: Gemini API (지수 백오프 1초, 2초, 4초 포함)
  const ctx = await buildDualAiMarketPromptContext({ isProTarget });
  const { btcPrice, btcDaily20Ma, btc4h60Ma, isHoldCash, regimeReason, prompt } = ctx;
  const apiKey = await getGeminiApiKey();

  if (!apiKey) {
    const fbRegime = await applyTier3MechanicalFallback({
      isPro: isProTarget,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: isProTarget ? "Pro Fallback" : "Flash Fallback",
    });
    return {
      success: false,
      error: "NO_API_KEY",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: ollamaAttempted
        ? `로컬 Ollama 연결 실패(${ollamaFallbackReason}) 및 Gemini API 키 미등록으로 BTC 20MA/60MA 기계적 Fallback이 적용되었습니다.`
        : "Gemini API 키가 등록되지 않았습니다. config/upbit_config.json 파일의 gemini_api_key 항목에 키를 입력하시거나 웹 화면에서 등록해주세요.",
      quota: await getGeminiQuotaStatus(),
    };
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (triggerType === "MANUAL" && quotaBefore.remaining_calls <= 0) {
    const fbRegime = await applyTier3MechanicalFallback({
      isPro: isProTarget,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: isProTarget ? "Pro Quota Fallback" : "Flash Quota Fallback",
    });
    notifyGeminiQuotaExceeded({
      source: isProTarget ? "AI 시장 분석 (Pro)" : "AI 시장 분석 (Flash)",
      triggerType,
      fallbackTier: "MECHANICAL_20MA",
      reason: "일일 무료 API 호출 한도 소진 (DAILY_QUOTA_EXCEEDED)",
    });
    return {
      success: false,
      error: "DAILY_QUOTA_EXCEEDED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
      quota: quotaBefore,
    };
  }

  const candidateModels = getDualAiCandidateModels(isProTarget, options?.preferredModel);
  const geminiRes = await callGeminiGenerateWithBackoff({
    apiKey,
    candidateModels,
    prompt,
    temperature: 0.25,
    timeoutMs: 55000,
    backoffDelaysMs: options?.backoffDelaysMs || [1000, 2000, 4000],
    logTag: "Gemini API",
  });

  if (!geminiRes.analysisText) {
    // 3순위: BTC 일봉 20MA / 4시간 60MA 기반 기계적 Fallback 적용
    const fbRegime = await applyTier3MechanicalFallback({
      isPro: isProTarget,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: isProTarget ? "Pro Fallback" : "Flash Fallback",
    });

    if (geminiRes.quota429Count > 0) {
      notifyGeminiQuotaExceeded({
        source: isProTarget ? "AI 시장 분석 (Pro)" : "AI 시장 분석 (Flash)",
        triggerType,
        fallbackTier: "MECHANICAL_20MA",
        reason: geminiRes.lastErrorMsg || "Gemini API 429 Quota Exceeded",
      });
    }

    if (geminiRes.allQuota429 && triggerType === "MANUAL") {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      return {
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        fallback_tier: "MECHANICAL_20MA",
        regime_filter: fbRegime,
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: exhaustedQuota,
      };
    }
    return {
      success: false,
      error: "API_CALL_FAILED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: `Gemini API 호출 실패 (BTC 20MA 기계적 Fallback 적용): ${geminiRes.lastErrorMsg || "응답 텍스트를 생성하지 못했습니다."}`,
      quota: await getGeminiQuotaStatus(),
    };
  }

  const { cleanText, structured } = extractStructuredRegimeFromLlmText(geminiRes.analysisText);
  const briefingMarkdown = cleanText || geminiRes.analysisText;

  const saved = await persistMarketBriefingAndUpdateRegime({
    db,
    provider: "gemini",
    model: geminiRes.chosenModel,
    isProTarget,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    isHoldCash,
    regimeReason,
    analysisText: geminiRes.analysisText,
    briefingMarkdown,
    decision: structured,
    nowStr,
    triggerType,
    slotKey,
    consumeQuota: true,
  });

  return {
    success: true,
    provider: "gemini",
    fallback_used: ollamaAttempted,
    trigger_type: triggerType,
    quota: saved.updatedQuota,
    regime_filter: saved.updatedRegime,
    briefing: {
      id: saved.briefingId,
      provider: "gemini",
      model: geminiRes.chosenModel,
      btc_price: btcPrice,
      btc_daily_20ma: btcDaily20Ma,
      btc_4h_60ma: btc4h60Ma,
      regime_status: saved.regimeStatus,
      briefing_text: briefingMarkdown,
      created_at: nowStr,
      trigger_type: triggerType,
    },
  };
}

/**
 * [Antigravity-Doc] 대시보드 수동 AI 시황 분석용 SSE(Server-Sent Events) 스트리밍 핸들러.
 * 1순위로 로컬 Ollama 결과를 타이프라이터 청크로 스트리밍하고, 실패 시 2순위 Gemini SSE 스트림으로 전환한다.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function generateAiMarketAnalysisStream(req, res) {
  const db = getDb();
  const nowStr = nowKSTString();
  const ollamaCfg = await getOllamaRuntimeConfig();

  // 1순위: 로컬 Ollama(qwen3-news) 호출 후 SSE 타이프라이터 청크 스트리밍
  let ollamaAttempted = false;
  let ollamaFallbackReason = "";
  if (ollamaCfg.enabled) {
    ollamaAttempted = true;
    try {
      const [recentNews, ollamaCtxPack] = await Promise.all([
        getRecentNewsForAiAnalysis(db, 12),
        fetchLiveMarketContextForOllama(db),
      ]);

      const ollamaRes = await callLocalOllamaCoinNewsAnalyzer(
        recentNews,
        ollamaCtxPack.marketContext,
        ollamaCtxPack.activeBots,
        {
          baseUrl: ollamaCfg.baseUrl,
          model: ollamaCfg.model,
          timeoutMs: ollamaCfg.timeoutMs,
        }
      );

      const btcPrice = Number(ollamaCtxPack.marketContext.btcPrice || 0);
      const btcDaily20Ma = Number(ollamaCtxPack.marketContext.btcDaily20Ma || 0);
      const btc4h60Ma = Number(ollamaCtxPack.marketContext.btc4h60Ma || 0);
      const briefingMarkdown = buildOllamaMarketBriefingMarkdown(
        ollamaRes,
        ollamaCtxPack.marketContext,
        ollamaCtxPack.activeBots
      );

      const saved = await persistMarketBriefingAndUpdateRegime({
        db,
        provider: "ollama",
        model: ollamaRes.model,
        isProTarget: false,
        btcPrice,
        btcDaily20Ma,
        btc4h60Ma,
        isHoldCash: ollamaRes.recommended_action === "HALT_NEW_BUYS" || ollamaRes.recommended_action === "EMERGENCY_CLOSE_ALL",
        regimeReason: ollamaRes.reason,
        analysisText: briefingMarkdown,
        briefingMarkdown,
        decision: ollamaRes,
        nowStr,
        triggerType: "MANUAL",
        slotKey: null,
        consumeQuota: false,
      });

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...(res.__corsHeaders || {}),
      });

      res.write(
        `data: ${JSON.stringify({
          type: "meta",
          btc_price: btcPrice,
          btc_daily_20ma: btcDaily20Ma,
          btc_4h_60ma: btc4h60Ma,
          regime_status: saved.regimeStatus,
          provider: "ollama",
          model: ollamaRes.model,
          engine: "ollama",
          created_at: nowStr,
          trigger_type: "MANUAL",
          regime_filter: saved.updatedRegime,
          quota: saved.updatedQuota,
        })}\n\n`
      );

      await streamTextAsSseChunks(res, req, briefingMarkdown, 12, 4);

      res.write(
        `data: ${JSON.stringify({
          type: "done",
          id: saved.briefingId,
          provider: "ollama",
          model: ollamaRes.model,
          engine: "ollama",
          full_text: briefingMarkdown,
          created_at: nowStr,
          trigger_type: "MANUAL",
          regime_filter: saved.updatedRegime,
          quota: saved.updatedQuota,
        })}\n\n`
      );
      res.end();
      return;
    } catch (ollamaErr) {
      ollamaFallbackReason = ollamaErr.message;
      console.warn(`[OllamaFallback] 로컬 맥북 Ollama 연결 실패 (${ollamaErr.message}) -> Gemini Flash 백업 엔진 전환`);
    }
  }

  // 2순위: Gemini Flash 스트리밍 백업 엔진
  const ctx = await buildDualAiMarketPromptContext({ isProTarget: false });
  const { btcPrice, btcDaily20Ma, btc4h60Ma, isHoldCash, regimeReason, prompt } = ctx;
  const apiKey = await getGeminiApiKey();

  if (!apiKey) {
    const fbRegime = await applyTier3MechanicalFallback({
      isPro: false,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: "Stream Fallback",
    });
    return sendJson(res, 400, {
      success: false,
      error: "NO_API_KEY",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: ollamaAttempted
        ? `로컬 Ollama 연결 실패(${ollamaFallbackReason}) 및 Gemini API 키 미등록으로 BTC 20MA 기계적 Fallback이 적용되었습니다.`
        : "Gemini API 키가 등록되지 않았습니다. config/upbit_config.json 파일의 gemini_api_key 항목에 키를 입력하시거나 웹 화면에서 등록해주세요.",
      quota: await getGeminiQuotaStatus(),
    });
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (quotaBefore.remaining_calls <= 0) {
    const fbRegime = await applyTier3MechanicalFallback({
      isPro: false,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: "Stream Quota Fallback",
    });
    notifyGeminiQuotaExceeded({
      source: "AI 시장 분석 스트리밍",
      triggerType: "MANUAL",
      fallbackTier: "MECHANICAL_20MA",
      reason: "일일 무료 API 호출 한도 소진 (DAILY_QUOTA_EXCEEDED)",
    });
    return sendJson(res, 429, {
      success: false,
      error: "DAILY_QUOTA_EXCEEDED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
      quota: quotaBefore,
    });
  }

  const candidateModels = getDualAiCandidateModels(false);
  const streamRes = await callGeminiStreamWithBackoff({
    apiKey,
    candidateModels,
    prompt,
    temperature: 0.25,
    timeoutMs: 30000,
    logTag: "Gemini Stream",
  });

  if (!streamRes.geminiResp) {
    const fbRegime = await applyTier3MechanicalFallback({
      isPro: false,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      label: "Stream Fallback",
    });

    if (streamRes.quota429Count > 0) {
      notifyGeminiQuotaExceeded({
        source: "AI 시장 분석 스트리밍",
        triggerType: "MANUAL",
        fallbackTier: "MECHANICAL_20MA",
        reason: "Gemini API 429 Quota Exceeded (스트리밍 호출 한도 초과)",
      });
    }

    if (streamRes.allQuota429) {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      return sendJson(res, 429, {
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        fallback_tier: "MECHANICAL_20MA",
        regime_filter: fbRegime,
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: exhaustedQuota,
      });
    }
    return sendJson(res, 502, {
      success: false,
      error: "API_CALL_FAILED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: "사용 가능한 Gemini 스트리밍 모델 연결에 실패하여 BTC 20MA 기계적 Fallback이 적용되었습니다.",
      quota: await getGeminiQuotaStatus(),
    });
  }

  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_briefing_last_trigger_type', 'MANUAL', ?)")
    .run(nowStr);
  const updatedQuota = await consumeGeminiQuota("MANUAL");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...(res.__corsHeaders || {}),
  });

  let regimeRow = null;
  try {
    const rawRegimeRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    regimeRow = enrichRegimeFilterRow(rawRegimeRow, await loadDualAiModelMeta(db));
  } catch {}

  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      btc_price: btcPrice,
      btc_daily_20ma: btcDaily20Ma,
      btc_4h_60ma: btc4h60Ma,
      regime_status: isHoldCash ? "HOLD_CASH" : "NORMAL",
      provider: "gemini",
      model: streamRes.chosenModel,
      engine: "dual",
      fallback_used: ollamaAttempted,
      created_at: nowStr,
      trigger_type: "MANUAL",
      regime_filter: regimeRow,
      quota: updatedQuota,
    })}\n\n`
  );

  try {
    const fullText = await consumeGeminiSseBody(streamRes.geminiResp, res);
    const { cleanText, structured } = extractStructuredRegimeFromLlmText(fullText);
    const briefingMarkdown = cleanText || fullText;

    const saved = await persistMarketBriefingAndUpdateRegime({
      db,
      provider: "gemini",
      model: streamRes.chosenModel,
      isProTarget: false,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      isHoldCash,
      regimeReason,
      analysisText: fullText,
      briefingMarkdown,
      decision: structured,
      nowStr,
      triggerType: "MANUAL",
      slotKey: null,
      consumeQuota: false,
    });

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        id: saved.briefingId,
        provider: "gemini",
        model: streamRes.chosenModel,
        engine: "dual",
        fallback_used: ollamaAttempted,
        full_text: briefingMarkdown,
        created_at: nowStr,
        trigger_type: "MANUAL",
        regime_filter: saved.updatedRegime || regimeRow,
        quota: updatedQuota,
      })}\n\n`
    );
    res.end();
  } catch (streamErr) {
    console.error("Error during streaming Gemini response:", streamErr);
    res.write(`data: ${JSON.stringify({ type: "error", message: streamErr.message, quota: updatedQuota })}\n\n`);
    res.end();
  }
}

/**
 * [Antigravity-Doc] 최근 수집 뉴스 상위 25건, 감성 통계(호재/악재/중립), 주요 코인 시세를 조합해 AI 뉴스 분석 프롬프트를 생성한다.
 * @param {object} db
 * @param {object} [options={}]
 * @returns {Promise<{topNews:Array, totalNews:number, bullCount:number, bearCount:number, neutCount:number, nowStr:string, prompt:string}>}
 */
async function buildNewsAnalysisPromptAndStats(db, options = {}) {
  const [topNews, stats, tickerSummary] = await Promise.all([
    getRecentNewsForAiAnalysis(db, 25),
    getNewsSentimentStats(db),
    fetchUpbitTickersSummary(["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"], options),
  ]);

  const { totalNews, bullCount, bearCount, neutCount } = stats;
  const newsSummaryList = topNews
    .map(
      (n, i) =>
        `${i + 1}. [${n.sentiment}] ${n.title} (출처: ${n.source}, 일시: ${n.published_at})${
          n.keywords ? ` [태그: ${n.keywords}]` : ""
        }`
    )
    .join("\n");

  const nowStr = nowKSTString();
  const prompt = `당신은 대한민국 최고 수준의 가상자산 퀀트 투자 시스템 'Upbit AutoCoinTrade'의 수석 AI 뉴스 & 센티먼트 애널리스트입니다.
아래는 ${nowStr} 기준, 시스템이 국내외 주요 암호화폐 언론사(Google News, TokenPost 등)로부터 실시간 수집한 최신 뉴스 및 시장 통계 데이터입니다.

### [실시간 수집 뉴스 데이터 및 시장 통계]
1. 뉴스 감성 통계:
- 총 수집 뉴스: ${totalNews}건
- 호재(상승) 감성: ${bullCount}건 (${totalNews > 0 ? ((bullCount / totalNews) * 100).toFixed(1) : 0}%)
- 악재(하락) 감성: ${bearCount}건 (${totalNews > 0 ? ((bearCount / totalNews) * 100).toFixed(1) : 0}%)
- 중립(시황) 감성: ${neutCount}건 (${totalNews > 0 ? ((neutCount / totalNews) * 100).toFixed(1) : 0}%)

2. 주요 코인 실시간 시세:
${tickerSummary.tickerLines || "- 시세 수신 중"}

3. 최근 주요 뉴스 헤드라인 (상위 25건):
${newsSummaryList}

---

### [작성 요청 가이드라인]
위 수집된 실시간 뉴스와 감성 데이터를 정밀 분석하여, 투자자가 현재 시장의 핵심 쟁점과 향후 가격 방향성을 한눈에 파악할 수 있도록 마크다운(Markdown) 서식으로 다음 3개 섹션을 명확하고 전문적으로 작성해주세요:

## 1. 📰 실시간 뉴스 핵심 쟁점 및 센티먼트 종합 진단
- 현재 수집된 뉴스에서 가장 지배적인 이슈(예: 특정 거래소 이슈, 규제/정책, ETF 동향 등)를 명확히 짚어주세요.
- 호재와 악재의 비중 및 시장 참여자들의 심리(탐욕 vs 공포) 상태를 분석해주세요.

## 2. ⚖️ 시장 충격도 & 단기 시황 전망
- 수집된 뉴스가 비트코인(BTC) 및 메이저 알트코인에 미치는 실제 파급력(일시적 노이즈 vs 중장기 추세 영향)을 진단해주세요.
- 단기적으로 주목해야 할 지지선 및 변동성 확대 가능성을 제시해주세요.

## 3. 🎯 퀀트 트레이딩 봇 운용 및 리스크 관리 전략
- 현재와 같은 뉴스 환경에서 3개 자동매매 봇(변동성 돌파, 듀얼 모멘텀, 볼린저 역추세)이 어떤 포지션을 취해야 하는지 구체적인 가이드를 제공해주세요.
- 무리한 추격 매수를 자제하고 리스크를 방어해야 하는 이유와 실전 투자 조언을 전달해주세요.

문장은 신뢰감 있고 가독성 높게, 적절한 불릿포인트와 이모지를 활용해주세요.`;

  return {
    topNews,
    totalNews,
    bullCount,
    bearCount,
    neutCount,
    nowStr,
    prompt,
  };
}

/**
 * [Antigravity-Doc] AI 뉴스 브리핑 결과를 `ai_news_briefings` 테이블에 저장하고 Web Push 완료 알림을 비동기 브로드캐스트한다.
 * @param {object} params
 * @returns {Promise<{briefingId:number, updatedQuota:object}>}
 */
async function persistNewsBriefingAndNotify({
  db,
  provider,
  model,
  totalNews,
  bullCount,
  bearCount,
  neutCount,
  analysisText,
  nowStr,
  triggerType,
  slotKey,
  consumeQuota = false,
  pushType = "news_analysis_done",
}) {
  const insertStmt = await db.prepare(`
    INSERT INTO ai_news_briefings (
      provider, model, news_count, bullish_count, bearish_count, neutral_count, briefing_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = await insertStmt.run(
    provider,
    model,
    totalNews,
    bullCount,
    bearCount,
    neutCount,
    analysisText,
    nowStr
  );

  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_news_briefing_last_trigger_type', ?, ?)")
    .run(triggerType, nowStr);
  if (triggerType === "AUTO" && slotKey) {
    await db
      .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_news_briefing_last_auto_slot', ?, ?)")
      .run(slotKey, nowStr);
  }

  const updatedQuota = consumeQuota ? await consumeGeminiQuota(triggerType) : await getGeminiQuotaStatus();

  broadcastWebPushNotification({
    title: "AI 뉴스 분석 완료",
    body: "ai 분석이 완료되었습니다",
    data: {
      type: pushType,
      trigger_type: triggerType,
      briefing_id: info.lastInsertRowid,
      timestamp: Date.now(),
    },
  }).catch((pushErr) => {
    console.warn("[WebPush] Failed to broadcast news briefing push:", pushErr.message);
  });

  return {
    briefingId: info.lastInsertRowid,
    updatedQuota,
  };
}

/**
 * [Antigravity-Doc] 3-Tier 폴백 구조의 AI 뉴스 감성 분석 오케스트레이터(비스트리밍).
 * 동일 30분 슬롯의 시황 분석 Ollama 결과(`precomputedOllamaResult`)가 전달되면 중복 호출 없이 재사용한다.
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
async function generateAiNewsAnalysis(options = {}) {
  const triggerType = options?.triggerType === "AUTO" ? "AUTO" : "MANUAL";
  const slotKey = options?.slotKey || null;
  const db = getDb();

  const { topNews, totalNews, bullCount, bearCount, neutCount, nowStr, prompt } =
    await buildNewsAnalysisPromptAndStats(db, options);

  const ollamaCfg = await getOllamaRuntimeConfig(options);
  const useLocalOllama = options?.useLocalOllama !== undefined ? Boolean(options.useLocalOllama) : ollamaCfg.enabled;

  // 1순위: 맥북 프로 로컬 Ollama(qwen3-news) 뉴스 감성 분석
  let ollamaAttempted = false;
  let ollamaFallbackReason = "";
  let cachedMarketCtx = null;

  if (useLocalOllama) {
    ollamaAttempted = true;
    try {
      const reusedOllamaRes = options?.precomputedOllamaResult || null;
      const ollamaCtxPack = reusedOllamaRes && options?.precomputedMarketContext
        ? { marketContext: options.precomputedMarketContext, activeBots: [] }
        : await fetchLiveMarketContextForOllama(db, null, options);
      cachedMarketCtx = ollamaCtxPack.marketContext;

      const ollamaRes = reusedOllamaRes || (await callLocalOllamaCoinNewsAnalyzer(
        topNews,
        ollamaCtxPack.marketContext,
        ollamaCtxPack.activeBots,
        {
          baseUrl: options?.ollamaBaseUrl || ollamaCfg.baseUrl,
          model: options?.ollamaModel || ollamaCfg.model,
          timeoutMs: options?.ollamaTimeoutMs || ollamaCfg.timeoutMs,
        }
      ));

      const btcPrice = Number(ollamaCtxPack.marketContext.btcPrice || 0);
      const btcDaily20Ma = Number(ollamaCtxPack.marketContext.btcDaily20Ma || 0);
      const btc4h60Ma = Number(ollamaCtxPack.marketContext.btc4h60Ma || 0);

      // 동일 30분 슬롯 시장 분석 결과를 재사용한 경우 직전에 이미 dual_ai_flash_state_json이 갱신되었으므로 중복 덮어쓰기 방지
      const updatedRegime = reusedOllamaRes
        ? (options?.precomputedRegimeFilter || (await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get()))
        : await updateMarketRegimeFilterFromAnalysis({
            isPro: false,
            provider: "ollama",
            model: ollamaRes.model,
            btcPrice,
            btcDaily20Ma,
            btc4h60Ma,
            isHoldCash: ollamaRes.recommended_action === "HALT_NEW_BUYS" || ollamaRes.recommended_action === "EMERGENCY_CLOSE_ALL",
            regimeReason: ollamaRes.reason,
            decision: ollamaRes,
          });

      const newsMarkdown = buildOllamaNewsBriefingMarkdown(ollamaRes, {
        totalNews,
        bullCount,
        bearCount,
        neutCount,
        topNews,
        marketContext: ollamaCtxPack.marketContext,
      });

      const saved = await persistNewsBriefingAndNotify({
        db,
        provider: "ollama",
        model: ollamaRes.model,
        totalNews,
        bullCount,
        bearCount,
        neutCount,
        analysisText: newsMarkdown,
        nowStr,
        triggerType,
        slotKey,
        consumeQuota: false,
        pushType: "news_analysis_done",
      });

      return {
        success: true,
        provider: "ollama",
        fallback_used: false,
        trigger_type: triggerType,
        quota: saved.updatedQuota,
        ollama: await checkOllamaStatus(options),
        regime_filter: updatedRegime,
        briefing: {
          id: saved.briefingId,
          provider: "ollama",
          model: ollamaRes.model,
          news_count: totalNews,
          bullish_count: bullCount,
          bearish_count: bearCount,
          neutral_count: neutCount,
          briefing_text: newsMarkdown,
          created_at: nowStr,
          trigger_type: triggerType,
        },
      };
    } catch (ollamaErr) {
      ollamaFallbackReason = ollamaErr.message;
      console.warn(`[OllamaFallback] 로컬 맥북 Ollama 연결 실패 (${ollamaErr.message}) -> Gemini Flash 백업 엔진 전환`);
    }
  }

  // 2순위: Gemini Flash API 백업 엔진 (지수 백오프 1초, 2초, 4초 포함)
  const applyMechanicalNewsGuard = async (label) => {
    const ctxPack = cachedMarketCtx
      ? { marketContext: cachedMarketCtx }
      : await fetchLiveMarketContextForOllama(db, null, options).catch(() => ({ marketContext: {} }));
    return await applyTier3MechanicalFallback({
      isPro: false,
      btcPrice: Number(ctxPack.marketContext?.btcPrice || 0),
      btcDaily20Ma: Number(ctxPack.marketContext?.btcDaily20Ma || 0),
      btc4h60Ma: Number(ctxPack.marketContext?.btc4h60Ma || 0),
      label,
    });
  };

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const fbRegime = await applyMechanicalNewsGuard("News Flash Fallback");
    return {
      success: false,
      error: "NO_API_KEY",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: ollamaAttempted
        ? `로컬 Ollama 연결 실패(${ollamaFallbackReason}) 및 Gemini API 키 미등록으로 BTC 20MA 기계적 Fallback이 적용되었습니다.`
        : "Gemini API 키가 등록되지 않았습니다. 설정 화면에서 API 키를 등록해주세요.",
      quota: await getGeminiQuotaStatus(),
    };
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (triggerType === "MANUAL" && quotaBefore.remaining_calls <= 0) {
    const fbRegime = await applyMechanicalNewsGuard("News Quota Fallback");
    notifyGeminiQuotaExceeded({
      source: "AI 뉴스 분석",
      triggerType,
      fallbackTier: "MECHANICAL_20MA",
      reason: "일일 무료 API 호출 한도 소진 (DAILY_QUOTA_EXCEEDED)",
    });
    return {
      success: false,
      error: "DAILY_QUOTA_EXCEEDED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
      quota: quotaBefore,
    };
  }

  const candidateModels = getDualAiCandidateModels(false);
  const geminiRes = await callGeminiGenerateWithBackoff({
    apiKey,
    candidateModels,
    prompt,
    temperature: 0.3,
    timeoutMs: 60000,
    backoffDelaysMs: options?.backoffDelaysMs || [1000, 2000, 4000],
    logTag: "Gemini News API",
  });

  if (!geminiRes.analysisText) {
    const fbRegime = await applyMechanicalNewsGuard("News API Fallback");
    if (geminiRes.quota429Count > 0) {
      notifyGeminiQuotaExceeded({
        source: "AI 뉴스 분석",
        triggerType,
        fallbackTier: "MECHANICAL_20MA",
        reason: geminiRes.lastErrorMsg || "Gemini API 429 Quota Exceeded",
      });
    }

    if (geminiRes.allQuota429 && triggerType === "MANUAL") {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      return {
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        fallback_tier: "MECHANICAL_20MA",
        regime_filter: fbRegime,
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: exhaustedQuota,
      };
    }
    return {
      success: false,
      error: "API_CALL_FAILED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: `Gemini 뉴스 AI 분석 실패 (BTC 20MA 기계적 Fallback 적용): ${geminiRes.lastErrorMsg || "응답 텍스트를 생성하지 못했습니다."}`,
      quota: await getGeminiQuotaStatus(),
    };
  }

  const saved = await persistNewsBriefingAndNotify({
    db,
    provider: "gemini",
    model: geminiRes.chosenModel,
    totalNews,
    bullCount,
    bearCount,
    neutCount,
    analysisText: geminiRes.analysisText,
    nowStr,
    triggerType,
    slotKey,
    consumeQuota: true,
    pushType: "news_analysis_done",
  });
  // 주의: Gemini 뉴스 요약은 구조화 JSON 장세 필터(dual_ai_flash_state_json)를 갱신하지 않으므로
  // dual_ai_flash_provider/model 메타만 별도로 덮어써 실제 상태와 표시 모델이 어긋나는 현상을 방지

  return {
    success: true,
    provider: "gemini",
    fallback_used: ollamaAttempted,
    trigger_type: triggerType,
    quota: saved.updatedQuota,
    briefing: {
      id: saved.briefingId,
      provider: "gemini",
      model: geminiRes.chosenModel,
      news_count: totalNews,
      bullish_count: bullCount,
      bearish_count: bearCount,
      neutral_count: neutCount,
      briefing_text: geminiRes.analysisText,
      created_at: nowStr,
      trigger_type: triggerType,
    },
  };
}

/**
 * [Antigravity-Doc] 대시보드 수동 AI 뉴스 분석용 SSE 스트리밍 핸들러(1순위 Ollama 청크 -> 2순위 Gemini SSE -> 3순위 기계적 폴백).
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function generateAiNewsAnalysisStream(req, res) {
  const db = getDb();
  const { topNews, totalNews, bullCount, bearCount, neutCount, nowStr, prompt } =
    await buildNewsAnalysisPromptAndStats(db);

  const ollamaCfg = await getOllamaRuntimeConfig();

  // 1순위: 로컬 Ollama(qwen3-news) 호출 후 SSE 타이프라이터 청크 스트리밍
  let ollamaAttempted = false;
  let ollamaFallbackReason = "";
  let cachedMarketCtx = null;

  if (ollamaCfg.enabled) {
    ollamaAttempted = true;
    try {
      const ollamaCtxPack = await fetchLiveMarketContextForOllama(db);
      cachedMarketCtx = ollamaCtxPack.marketContext;

      const ollamaRes = await callLocalOllamaCoinNewsAnalyzer(
        topNews,
        ollamaCtxPack.marketContext,
        ollamaCtxPack.activeBots,
        {
          baseUrl: ollamaCfg.baseUrl,
          model: ollamaCfg.model,
          timeoutMs: ollamaCfg.timeoutMs,
        }
      );

      const updatedRegime = await updateMarketRegimeFilterFromAnalysis({
        isPro: false,
        provider: "ollama",
        model: ollamaRes.model,
        btcPrice: Number(ollamaCtxPack.marketContext.btcPrice || 0),
        btcDaily20Ma: Number(ollamaCtxPack.marketContext.btcDaily20Ma || 0),
        btc4h60Ma: Number(ollamaCtxPack.marketContext.btc4h60Ma || 0),
        isHoldCash: ollamaRes.recommended_action === "HALT_NEW_BUYS" || ollamaRes.recommended_action === "EMERGENCY_CLOSE_ALL",
        regimeReason: ollamaRes.reason,
        decision: ollamaRes,
      });

      const fullText = buildOllamaNewsBriefingMarkdown(ollamaRes, {
        totalNews,
        bullCount,
        bearCount,
        neutCount,
        topNews,
        marketContext: ollamaCtxPack.marketContext,
      });

      const saved = await persistNewsBriefingAndNotify({
        db,
        provider: "ollama",
        model: ollamaRes.model,
        totalNews,
        bullCount,
        bearCount,
        neutCount,
        analysisText: fullText,
        nowStr,
        triggerType: "MANUAL",
        slotKey: null,
        consumeQuota: false,
        pushType: "news_briefing",
      });

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...(res.__corsHeaders || {}),
      });

      res.write(
        `data: ${JSON.stringify({
          type: "meta",
          provider: "ollama",
          model: ollamaRes.model,
          engine: "ollama",
          news_count: totalNews,
          bullish_count: bullCount,
          bearish_count: bearCount,
          neutral_count: neutCount,
          created_at: nowStr,
          trigger_type: "MANUAL",
          regime_filter: updatedRegime,
          quota: saved.updatedQuota,
        })}\n\n`
      );

      await streamTextAsSseChunks(res, req, fullText, 12, 4);

      res.write(
        `data: ${JSON.stringify({
          type: "done",
          id: saved.briefingId,
          provider: "ollama",
          model: ollamaRes.model,
          engine: "ollama",
          news_count: totalNews,
          bullish_count: bullCount,
          bearish_count: bearCount,
          neutral_count: neutCount,
          full_text: fullText,
          created_at: nowStr,
          trigger_type: "MANUAL",
          regime_filter: updatedRegime,
          quota: saved.updatedQuota,
        })}\n\n`
      );
      res.end();
      return;
    } catch (ollamaErr) {
      ollamaFallbackReason = ollamaErr.message;
      console.warn(`[OllamaFallback] 로컬 맥북 Ollama 연결 실패 (${ollamaErr.message}) -> Gemini Flash 백업 엔진 전환`);
    }
  }

  // 2순위: Gemini Flash 스트리밍 백업 엔진 (지수 백오프 1초, 2초, 4초 포함)
  const applyMechanicalNewsStreamGuard = async (label) => {
    const ctxPack = cachedMarketCtx
      ? { marketContext: cachedMarketCtx }
      : await fetchLiveMarketContextForOllama(db).catch(() => ({ marketContext: {} }));
    return await applyTier3MechanicalFallback({
      isPro: false,
      btcPrice: Number(ctxPack.marketContext?.btcPrice || 0),
      btcDaily20Ma: Number(ctxPack.marketContext?.btcDaily20Ma || 0),
      btc4h60Ma: Number(ctxPack.marketContext?.btc4h60Ma || 0),
      label,
    });
  };

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const fbRegime = await applyMechanicalNewsStreamGuard("News Stream Fallback");
    return sendJson(res, 400, {
      success: false,
      error: "NO_API_KEY",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: ollamaAttempted
        ? `로컬 Ollama 연결 실패(${ollamaFallbackReason}) 및 Gemini API 키 미등록으로 BTC 20MA 기계적 Fallback이 적용되었습니다.`
        : "Gemini API 키가 등록되지 않았습니다. 설정 화면에서 API 키를 등록해주세요.",
      quota: await getGeminiQuotaStatus(),
    });
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (quotaBefore.remaining_calls <= 0) {
    const fbRegime = await applyMechanicalNewsStreamGuard("News Stream Quota Fallback");
    notifyGeminiQuotaExceeded({
      source: "AI 뉴스 분석 스트리밍",
      triggerType: "MANUAL",
      fallbackTier: "MECHANICAL_20MA",
      reason: "일일 무료 API 호출 한도 소진 (DAILY_QUOTA_EXCEEDED)",
    });
    return sendJson(res, 429, {
      success: false,
      error: "DAILY_QUOTA_EXCEEDED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
      quota: quotaBefore,
    });
  }

  const candidateModels = getDualAiCandidateModels(false);
  const streamRes = await callGeminiStreamWithBackoff({
    apiKey,
    candidateModels,
    prompt,
    temperature: 0.3,
    timeoutMs: 60000,
    logTag: "Gemini News Stream",
  });

  if (!streamRes.geminiResp) {
    const fbRegime = await applyMechanicalNewsStreamGuard("News Stream API Fallback");
    if (streamRes.quota429Count > 0) {
      notifyGeminiQuotaExceeded({
        source: "AI 뉴스 분석 스트리밍",
        triggerType: "MANUAL",
        fallbackTier: "MECHANICAL_20MA",
        reason: "Gemini API 429 Quota Exceeded (스트리밍 호출 한도 초과)",
      });
    }

    if (streamRes.allQuota429) {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      return sendJson(res, 429, {
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        fallback_tier: "MECHANICAL_20MA",
        regime_filter: fbRegime,
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: exhaustedQuota,
      });
    }
    return sendJson(res, 502, {
      success: false,
      error: "API_CALL_FAILED",
      fallback_tier: "MECHANICAL_20MA",
      regime_filter: fbRegime,
      message: "사용 가능한 Gemini 스트리밍 모델 연결에 실패하여 BTC 20MA 기계적 Fallback이 적용되었습니다.",
      quota: await getGeminiQuotaStatus(),
    });
  }

  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_news_briefing_last_trigger_type', 'MANUAL', ?)")
    .run(nowStr);
  const updatedQuota = await consumeGeminiQuota("MANUAL");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...(res.__corsHeaders || {}),
  });

  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      provider: "gemini",
      model: streamRes.chosenModel,
      engine: "dual",
      fallback_used: ollamaAttempted,
      news_count: totalNews,
      bullish_count: bullCount,
      bearish_count: bearCount,
      neutral_count: neutCount,
      created_at: nowStr,
      trigger_type: "MANUAL",
      quota: updatedQuota,
    })}\n\n`
  );

  try {
    const fullText = await consumeGeminiSseBody(streamRes.geminiResp, res);
    const saved = await persistNewsBriefingAndNotify({
      db,
      provider: "gemini",
      model: streamRes.chosenModel,
      totalNews,
      bullCount,
      bearCount,
      neutCount,
      analysisText: fullText,
      nowStr,
      triggerType: "MANUAL",
      slotKey: null,
      consumeQuota: false,
      pushType: "news_briefing",
    });
    // 주의: Gemini 스트리밍 뉴스 요약은 장세 필터 상태를 갱신하지 않으므로 dual_ai_flash_provider/model 메타를 임의 덮어쓰지 않음

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        id: saved.briefingId,
        provider: "gemini",
        model: streamRes.chosenModel,
        engine: "dual",
        fallback_used: ollamaAttempted,
        news_count: totalNews,
        bullish_count: bullCount,
        bearish_count: bearCount,
        neutral_count: neutCount,
        full_text: fullText,
        created_at: nowStr,
        trigger_type: "MANUAL",
        quota: updatedQuota,
      })}\n\n`
    );
    res.end();
  } catch (streamErr) {
    console.error("Error during streaming Gemini news response:", streamErr);
    res.write(`data: ${JSON.stringify({ type: "error", message: streamErr.message, quota: updatedQuota })}\n\n`);
    res.end();
  }
}

/**
 * [Antigravity-Doc] 가상거래 아레나 원장(`paper_trades`, `paper_bot_positions`)을 초기화하고(PostgreSQL 연동 시 원격도 동기 삭제),
 * 100ms 후 새 아레나 사이클을 즉시 1회 트리거한다.
 * @param {object} db
 * @returns {Promise<{success:boolean, message:string, leaderboard:Array}>}
 */
async function resetPaperArenaAndNotify(db) {
  await resetArena(db);
  if (pgSyncManager.isConnected && pgSyncManager.pool) {
    try {
      await pgSyncManager.pool.query("DELETE FROM paper_trades; DELETE FROM paper_bot_positions;");
    } catch {}
  }
  setTimeout(async () => {
    try {
      await runAlwaysOnPaperArenaCycle();
    } catch {}
  }, 100);
  return {
    success: true,
    message: "가상거래 전용 원장(paper_trades)과 10대 알고리즘 가상 경쟁이 성공적으로 초기화되었습니다.",
    leaderboard: await getArenaLeaderboard(db),
  };
}

// ============================================================================
// [실전 담당 봇(1~3개) 동적 투자금 배분 및 미매도 포지션 안전 승계 함수]
// ============================================================================
// [Antigravity-Doc] 프로세스 내 DB 복합 쓰기 직렬화 뮤텍스(Promise 체인 기반 FIFO 큐)
// 자본 재계산, 실전 봇 교체, 주간 로테이션, 매도 정산 등 다중 테이블 트랜잭션 간 경쟁 조건을 차단한다.
let dbWriteMutex = Promise.resolve();

/**
 * [Antigravity-Doc] 전달된 비동기 콜백 `fn`을 전역 `dbWriteMutex` 락 안에서 배타적으로 실행한다.
 * 주의: 외부 HTTP(업비트/LLM) 호출은 락 획득 전에 선행 수행해 락 점유 시간을 최소화해야 한다.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withDbWriteLock(fn) {
  const prevLock = dbWriteMutex;
  let releaseLock;
  dbWriteMutex = new Promise((res) => {
    releaseLock = res;
  });
  await prevLock;
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

/**
 * [Antigravity-Doc] 실전 담당 봇(1~3개) 선택 및 비율 배분을 안전하게 적용한다.
 * 업비트 계좌 조회를 락 외부에서 선행 수행한 뒤 `withDbWriteLock` 내에서 `_applyLiveBotsSelectionUnsafe`를 호출한다.
 * @param {Array<{bot_id:string, allocation_ratio:number}>} selected 선택된 실전 봇 및 비율(합계 1.0)
 * @param {Array<{from_bot_id:string, to_bot_id:string}>} [handoverMap=[]] 명시적 포지션 이관 매핑 (미지정 시 Graceful Drain)
 * @param {number|null} [forcedCapital=null] 강제 지정 운용 자본(KRW)
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function applyLiveBotsSelection(selected, handoverMap = [], forcedCapital = null, options = {}) {
  // 외부 네트워크 조회(업비트 실계좌)는 DB 쓰기 락 밖에서 선행 수행하여 TOCTOU 및 락 홀딩 지연 방지
  let preloadedAccountInfo = null;
  if (!(Number(forcedCapital) > 0) && !options?.skipLiveAccountSync) {
    try {
      preloadedAccountInfo = await fetchUpbitAccountBalance();
    } catch {}
  }
  return await withDbWriteLock(() =>
    _applyLiveBotsSelectionUnsafe(selected, handoverMap, forcedCapital, {
      ...options,
      preloadedAccountInfo,
    })
  );
}

/**
 * [Antigravity-Doc] `withDbWriteLock` 내부 전용 실전 봇 선택·배분·드레인(Drain)/이관(Handover) 트랜잭션 구현체.
 * 탈락 봇의 미청산 포지션은 기본 강제 청산 없이 `DRAINING` 상태로 보호하며, 가용 원화만 신규 선출 봇에 재배분한다.
 * @param {Array} selected
 * @param {Array} [handoverMap=[]]
 * @param {number|null} [forcedCapital=null]
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
async function _applyLiveBotsSelectionUnsafe(selected, handoverMap = [], forcedCapital = null, options = {}) {
  const db = getDb();
  const allBots = await getBots("live");
  const ids = (selected || []).map((it) => normalizeBotId(String(it?.bot_id || "")));
  if (ids.length < 1 || ids.length > 3) {
    throw new Error(`실제 거래 담당 봇은 최소 1개 ~ 최대 3개까지 선택할 수 있습니다. (현재 ${ids.length}개)`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("중복 선택된 봇이 있습니다.");
  }
  const unknown = ids.filter((id) => !allBots.some((b) => b.bot_id === id));
  if (unknown.length > 0) {
    throw new Error(`존재하지 않는 봇입니다: ${unknown.join(", ")}`);
  }
  const ratios = selected.map((it) => Number(it?.allocation_ratio));
  if (ratios.some((r) => !Number.isFinite(r) || r < 0 || r > 1)) {
    throw new Error("봇별 투자 비율(allocation_ratio)은 0 ~ 1 사이 값이어야 합니다.");
  }
  const ratioSum = Number(ratios.reduce((a, b) => a + b, 0).toFixed(4));
  if (Math.abs(ratioSum - 1.0) > 0.001) {
    throw new Error(`선택된 봇들의 투자 비율 합계는 정확히 100%(1.0)여야 합니다. (현재 ${(ratioSum * 100).toFixed(2)}%)`);
  }

  const existingTotalCashBefore = allBots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);
  const totalAllUsedBefore = allBots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const poolFromCurrentBots = existingTotalCashBefore + totalAllUsedBefore;

  // 명시적 forcedCapital 우선 적용, 미지정 시 실제 Upbit 실계좌 90% -> 현재 DB 실전 풀 합산액 순으로 안전 산출
  let flooredTotal = 0;
  if (Number(forcedCapital) > 0) {
    flooredTotal = Math.floor(Number(forcedCapital));
  } else if (!options?.skipLiveAccountSync) {
    const accountInfo = options?.preloadedAccountInfo ?? (await fetchUpbitAccountBalance());
    if (accountInfo?.success) {
      const rawAsset = Number(accountInfo.total_asset_krw ?? accountInfo.krw_total ?? accountInfo.krw_balance ?? 0);
      flooredTotal = Math.floor(rawAsset * 0.9);
    }
  }
  if (!(flooredTotal > 0)) {
    const settingCap = Math.floor(Number(await getSetting("total_capital", "0")));
    flooredTotal = poolFromCurrentBots > 0 ? poolFromCurrentBots : settingCap;
  }
  if (!(flooredTotal > 0)) {
    throw new Error("업비트 실계좌 잔고를 확인할 수 없거나 잔고가 0원 이하입니다.");
  }

  const selectedIdSet = new Set(ids);
  const currentLiveBots = allBots.filter((b) => Number(b.is_selected_for_live) === 1);
  const previousBotsSnapshot = currentLiveBots.map((b) => ({
    bot_id: b.bot_id,
    nickname: b.nickname,
    name: b.name,
    ...getBotStrategyMeta(b.bot_id),
    allocation_ratio: Number(b.allocation_ratio || 0),
    allocated_capital: Math.floor(Number(b.allocated_capital || 0)),
    virtual_krw: Math.floor(Number(b.virtual_krw || 0)),
    used_capital: Math.floor(Number(b.used_capital || 0)),
    open_positions_count: (b.open_positions || []).length,
    is_running: Number(b.is_running || 0),
  }));
  const hadAnyPreviousLive = currentLiveBots.length > 0;
  const wasAnyPreviousRunning = currentLiveBots.some((b) => Number(b.is_running) === 1);
  const nextRunningFlag =
    options?.inheritRunningFromPrevious && hadAnyPreviousLive ? (wasAnyPreviousRunning ? 1 : 0) : 1;

  const removedBots = currentLiveBots.filter((b) => !selectedIdSet.has(b.bot_id));
  const addedIds = ids.filter((id) => !currentLiveBots.some((b) => b.bot_id === id));

  // 명시적 handoverMap이 전달된 경우에만 선택적으로 이관하고, 기본 동작은 보유 포지션 강제 청산/이관 없는 Graceful Drain 유지
  const handoverPairs = [];
  const usedFrom = new Set();
  const usedTo = new Set();
  if (Array.isArray(handoverMap) && handoverMap.length > 0) {
    for (const m of handoverMap) {
      const from = normalizeBotId(String(m?.from_bot_id || ""));
      const to = normalizeBotId(String(m?.to_bot_id || ""));
      const fromBot = removedBots.find((b) => b.bot_id === from);
      if (fromBot && addedIds.includes(to) && !usedFrom.has(from) && !usedTo.has(to)) {
        usedFrom.add(from);
        usedTo.add(to);
        handoverPairs.push({ from: fromBot, to });
      }
    }
  }

  const handedFromIds = new Set(handoverPairs.map((h) => h.from.bot_id));
  const inheritedByTo = {};
  for (const h of handoverPairs) inheritedByTo[h.to] = h.from;

  const drainingBots = allBots.filter(
    (b) => !selectedIdSet.has(b.bot_id) && !handedFromIds.has(b.bot_id) && (Number(b.used_capital || 0) > 0 || (b.open_positions || []).length > 0)
  );
  const drainingPositionsCount = drainingBots.reduce((acc, b) => acc + (b.open_positions || []).length, 0);
  const totalDrainingUsed = drainingBots.reduce((acc, b) => acc + Math.floor(Number(b.used_capital || 0)), 0);
  const reclaimedFromDroppedKrw = allBots
    .filter((b) => !selectedIdSet.has(b.bot_id))
    .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);
  const retainedSelectedUsed = allBots
    .filter((b) => selectedIdSet.has(b.bot_id))
    .reduce((acc, b) => acc + Math.floor(Number(b.used_capital || 0)), 0)
    + handoverPairs.reduce((acc, h) => acc + Math.floor(Number(h.from.used_capital || 0)), 0);
  const availableForSelectedTotal = Math.max(0, flooredTotal - totalDrainingUsed);
  const totalTransferableKrw = Math.max(0, availableForSelectedTotal - retainedSelectedUsed);

  const selectedRatiosMap = Object.fromEntries(
    selected.map((it, idx) => [ids[idx], Number((Number(it.allocation_ratio) * 100).toFixed(4))])
  );

  const now = nowKSTString();
  let allocSummary = null;
  try {
    await beginWriteTx(db);
    for (const h of handoverPairs) {
      await db.prepare("UPDATE bot_positions SET bot_id = ? WHERE bot_id = ? AND status = 'OPEN'").run(h.to, h.from.bot_id);
      await db.prepare("UPDATE trades SET bot_id = ? WHERE bot_id = ? AND status = 'HOLDING'").run(h.to, h.from.bot_id);
    }
    // 선택 해제된 봇 중 미청산 오픈 포지션이 있는 봇은 Graceful Drain(신규 매수 차단 + 기존 포지션 고유 전략 청산 대기) 보존
    for (const b of allBots) {
      if (selectedIdSet.has(b.bot_id)) continue;
      const drainUsed = handedFromIds.has(b.bot_id) ? 0 : Math.floor(Number(b.used_capital || 0));
      const openCnt = handedFromIds.has(b.bot_id) ? 0 : (b.open_positions || []).length;
      const statusMsg =
        drainUsed > 0 || openCnt > 0
          ? `[🛡️ Graceful Drain] 실전 교체됨 · 미매도 포지션 ${openCnt}건(${drainUsed.toLocaleString("ko-KR")}원) 매도 감시 및 청산 시 활성 봇 자동 이관 대기`
          : "실전 미선택 대기 중";
      await db.prepare(`
        UPDATE bots
        SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0,
            allocated_capital = ?, virtual_krw = 0, last_status_msg = ?, updated_at = ?
        WHERE bot_id = ?
      `).run(drainUsed, statusMsg, now, b.bot_id);
    }
    for (const it of selected) {
      const botId = normalizeBotId(String(it?.bot_id || ""));
      const botRow = allBots.find((b) => b.bot_id === botId);
      const ratioPct = Number((Number(it.allocation_ratio) * 100).toFixed(2));
      const wasDrainingOrInactive = Number(botRow?.is_selected_for_live || 0) !== 1;
      const prevMsg = String(botRow?.last_status_msg || "");
      const hasDrainNotice = prevMsg.includes("Graceful Drain") || prevMsg.includes("포지션 보호");
      const openCnt = (botRow?.open_positions || []).length;
      const nextStatusMsg =
        wasDrainingOrInactive && (openCnt > 0 || hasDrainNotice)
          ? `[🔄 실전 복귀] 전략군 대표 봇 재선출 · 기존 포지션 ${openCnt}건 유지 및 정상 가동`
          : wasDrainingOrInactive
          ? "신규 실전 배정 완료 · 진입 시그널 대기 중"
          : prevMsg || "신규 실전 배정 완료 · 진입 시그널 대기 중";
      await db.prepare(`
        UPDATE bots
        SET is_selected_for_live = 1, is_running = ?, allocation_ratio = ?, last_status_msg = ?, updated_at = ?
        WHERE bot_id = ?
      `).run(nextRunningFlag, ratioPct, nextStatusMsg, now, botId);
    }

    // 동일 트랜잭션 내에서 워터필링 배분기로 draining 봇 자본 잠금 및 신규 선택 봇 자금 잔액을 1원 오차 없이 정밀 재분배
    allocSummary = await recalculateAndApplyBotAllocations(flooredTotal, selectedRatiosMap, "live", {
      rankPriorityMap: options?.rankPriorityMap,
      skipAccountSync: true,
    });

    const syncedTotalCap = Math.max(flooredTotal, Number(allocSummary?.totalAllocated || flooredTotal));
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(String(syncedTotalCap), now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)").run(now);
    await syncBotAccountsFromBots(db);
    await commitWriteTx(db);
  } catch (err) {
    await rollbackWriteTx(db);
    throw new Error(`실전 봇 설정 저장 실패: ${err.message}`);
  }

  const liveBots = await getBots("live");
  const updatedSelected = liveBots.filter((b) => selectedIdSet.has(b.bot_id));
  const actualDistributedVirtual = updatedSelected.reduce((acc, b) => acc + Math.floor(Number(b.virtual_krw || 0)), 0);
  return {
    success: true,
    total_capital: flooredTotal,
    reclaimed_virtual_krw: reclaimedFromDroppedKrw,
    total_transferable_krw: totalTransferableKrw,
    actual_distributed_virtual_krw: actualDistributedVirtual,
    pooled_cash_before_krw: existingTotalCashBefore,
    remainder_dust_awarded: Number(allocSummary?.remainderDustAwarded || 0),
    total_available_pool_krw: availableForSelectedTotal,
    draining_positions_count: drainingPositionsCount,
    previous_bots: previousBotsSnapshot,
    handover: handoverPairs.map((h) => ({ from_bot_id: h.from.bot_id, to_bot_id: h.to })),
    draining_bots: drainingBots.map((b) => ({
      bot_id: b.bot_id,
      nickname: b.nickname,
      ...getBotStrategyMeta(b.bot_id),
      open_positions_count: (b.open_positions || []).length,
      used_capital: Math.floor(Number(b.used_capital || 0)),
    })),
    selected_bots: updatedSelected.map((b) => ({
      bot_id: b.bot_id,
      nickname: b.nickname,
      ...getBotStrategyMeta(b.bot_id),
      allocation_ratio: Number((Number(b.allocation_ratio || 0) / 100).toFixed(4)),
      allocation_ratio_pct: Number(Number(b.allocation_ratio || 0).toFixed(2)),
      allocated_capital: b.allocated_capital,
      virtual_krw: b.virtual_krw,
      is_running: Number(b.is_running || 0),
    })),
    bots: liveBots,
  };
}

// ============================================================================
// [LLM 1주일 단위 실전 봇 1,2,3위 자동 평가 및 편성 엔진]
// 기점: 매주 일요일 오전 09:00 (KST)
// ============================================================================
/**
 * [Antigravity-Doc] 매주 일요일 오전 09:00 KST 기점의 현재/차기 주간 슬롯 키와 잔여 일수를 계산한다.
 * @param {Date} [targetDate=new Date()]
 * @returns {{lastSundaySlot:string, nextSundaySlot:string, slotKey:string, daysRemaining:number, msRemaining:number}}
 */
function getWeeklySundaySlotInfo(targetDate = new Date()) {
  const d = new Date(targetDate);
  const day = d.getDay(); // 0: Sun, 1: Mon, ..., 6: Sat
  const hour = d.getHours();

  // 매주 일요일 오전 9시(09:00:00)가 기점
  // 오늘이 일요일(day === 0)인데 아직 9시 이전이면, 현재 슬롯은 '지난주 일요일 09:00'임
  // 오늘이 월~토(day > 0)이면, 현재 슬롯은 '이번 주 지난 일요일 09:00'임
  let daysSinceSundaySlot = day;
  if (day === 0 && hour < 9) {
    daysSinceSundaySlot = 7;
  }

  const lastSundaySlot = new Date(d);
  lastSundaySlot.setDate(d.getDate() - daysSinceSundaySlot);
  lastSundaySlot.setHours(9, 0, 0, 0);

  // 차기 일요일 오전 9시 슬롯
  const nextSundaySlot = new Date(lastSundaySlot);
  nextSundaySlot.setDate(lastSundaySlot.getDate() + 7);

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (dt) =>
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const slotKey = `${lastSundaySlot.getFullYear()}-${pad(lastSundaySlot.getMonth() + 1)}-${pad(lastSundaySlot.getDate())}_09:00`;

  const msRemaining = Math.max(0, nextSundaySlot.getTime() - d.getTime());
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 3600 * 1000)));

  return {
    lastSundaySlot: fmt(lastSundaySlot),
    nextSundaySlot: fmt(nextSundaySlot),
    slotKey,
    daysRemaining,
    msRemaining,
  };
}

/**
 * [Antigravity-Doc] 최근 주간 LLM 봇 선정 결과와 차기 예정 실행 시각을 `system_settings`에서 조회한다.
 * @returns {Promise<object>}
 */
async function getLlmWeeklyBotSelectionStatus() {
  const slotInfo = getWeeklySundaySlotInfo();
  const lastSlotKey = await getSetting("llm_weekly_bot_selection_last_slot", "");
  const lastRun = await getSetting("llm_weekly_bot_selection_last_run", "");
  const resultJson = await getSetting("llm_weekly_bot_selection_result", "null");
  let parsedResult = null;
  try {
    parsedResult = JSON.parse(resultJson);
    if (parsedResult) {
      parsedResult.schedule_rule = "매주 일요일 오전 09:00 KST";
      parsedResult.next_scheduled_run = slotInfo.nextSundaySlot;
      parsedResult.days_remaining = slotInfo.daysRemaining;
      parsedResult.slot_key = lastSlotKey || slotInfo.slotKey;
    }
  } catch {}

  return {
    success: true,
    has_selection: !!parsedResult,
    schedule_rule: "매주 일요일 오전 09:00 KST",
    current_slot: slotInfo.slotKey,
    last_slot: lastSlotKey || slotInfo.slotKey,
    last_run: lastRun || null,
    next_scheduled_run: slotInfo.nextSundaySlot,
    days_remaining: slotInfo.daysRemaining,
    selection: parsedResult || null,
  };
}

// [Antigravity-Doc] 주간 LLM 봇 선정 동시 실행 방지 플래그
let isWeeklyBotSelectionRunning = false;
/**
 * [Antigravity-Doc] 10대 아레나 모의투자 성적표와 현재 장세 필터를 바탕으로 Gemini(실패 시 퀀트 룰베이스 폴백)를 통해
 * 차주 실전 담당 봇(단일 100% 또는 상위 3봇)을 선정하고 `applyLiveBotsSelection`으로 자동 편성한다.
 * @param {boolean} [force=false] true 시 동일 주차 슬롯 캐시 무시하고 강제 재평가
 * @returns {Promise<object>}
 */
async function runLlmWeeklyBotSelection(force = false) {
  if (isWeeklyBotSelectionRunning) {
    return { success: false, message: "AI 주간 봇 평가가 이미 실행 중입니다." };
  }
  isWeeklyBotSelectionRunning = true;
  try {
    const db = getDb();
    const nowStr = nowKSTString();
    const slotInfo = getWeeklySundaySlotInfo();

    const lastSlotKey = await getSetting("llm_weekly_bot_selection_last_slot", "");
    // force가 아니고 현재 슬롯(해당 주차 일요일 09:00)의 평가 결과가 이미 존재하면 캐시 반환
    if (!force && lastSlotKey === slotInfo.slotKey) {
      const cachedResultStr = await getSetting("llm_weekly_bot_selection_result", "null");
      try {
        const cached = JSON.parse(cachedResultStr);
        if (cached) return { success: true, cached: true, ...cached };
      } catch {}
    }

    console.log(`[LLM Weekly Bot Selection] 매주 일요일 09:00 기점 주간 봇 평가 시작 (슬롯: ${slotInfo.slotKey})...`);

    const arenaLeaderboard = await getArenaLeaderboard(db);
    const regimeFilter = await checkMarketRegimeFilter();
    const rotConfig = await getAutoRotationConfig(db);
    const isSingleBotMode = rotConfig.allocation_mode === "SINGLE_MARKET_FIT_100";
    const rotEvaluation = await evaluateWeeklyStrategyChampions(db, {
      minWeeklyTrades: rotConfig.min_weekly_trades,
      allocationMode: rotConfig.allocation_mode,
      marketRegime: {
        market_regime: regimeFilter.marketRegime,
        recommended_action: regimeFilter.finalAction,
        final_bot_overrides_json: JSON.stringify(regimeFilter.botOverrides || {}),
      },
    });
    const btcPrice = Number(regimeFilter.btcPrice || 0);
    const btcDaily20Ma = Number(regimeFilter.ma20Day || 0);
    const btc4h60Ma = Number(regimeFilter.ma60_4h || 0);
    const isBearish =
      regimeFilter.allowBuy === false ||
      regimeFilter.belowMa20Day === true ||
      regimeFilter.marketRegime === "BEAR" ||
      regimeFilter.marketRegime === "HIGH_VOLATILITY_SHOCK" ||
      regimeFilter.finalAction === "REDUCE_SIZE";

    const botSummary = arenaLeaderboard
      .map((b, idx) => {
        const evalBot = rotEvaluation?.by_bot_id?.[b.bot_id];
        const aiOverride = regimeFilter.botOverrides?.[b.bot_id] || "ALLOW";
        return (
          `${idx + 1}. [${b.bot_id}] ${b.nickname} (${b.name}) | 전략군: ${b.strategy_group || b.strategy_type} | AI필터: ${aiOverride}\n` +
          `   - 모의투자 누적손익: ${Number(b.cumulative_profit_krw || 0).toLocaleString("ko-KR")}원 (${b.profit_rate_pct}%)` +
          (evalBot ? ` | 최근 7일: ${evalBot.weekly_return_pct}% (${evalBot.weekly_trade_count}건, 평가점수 ${evalBot.rotation_score})\n` : "\n") +
          `   - 최대낙폭(MDD): ${b.mdd_pct}% | 승률: ${b.win_rate_pct}% (총 ${b.total_trades}전 ${b.win_trades}승 ${b.lose_trades}패)\n` +
          `   - 전략 상세: ${b.description}`
        );
      })
      .join("\n\n");

    const prompt = isSingleBotMode
      ? `당신은 대한민국 최고 수준의 암호화폐 퀀트 헤지펀드 수석 AI 포트폴리오 매니저입니다.
현재 코인 시장 체제(비트코인 20일 이평선, 듀얼 AI 레짐, 변동성 등)와 10대 알고리즘 봇의 실시간 모의투자(Arena) 성적표를 심층 분석하여,
1주일간 실전매매(Live Trading)를 100% 집중 운용할 **현재 시장 상황에 가장 적합한 단 1개의 최적 봇**만 엄정하게 선정하십시오.

### [실시간 시장 체제 지표]
- 현재 시장 체제 / 액션: ${regimeFilter.marketRegime} / ${regimeFilter.finalAction}
- 비트코인(BTC) 현재가: ${btcPrice ? btcPrice.toLocaleString("ko-KR") + "원" : "데이터 수신 중"}
- 일봉 20일 이동평균선(20 MA): ${btcDaily20Ma ? Math.floor(btcDaily20Ma).toLocaleString("ko-KR") + "원" : "-"}
- 4시간봉 60선: ${btc4h60Ma ? Math.floor(btc4h60Ma).toLocaleString("ko-KR") + "원" : "-"}
- 시장 상태: ${isBearish ? "하락/약세장 (비트코인 20MA 하회 또는 방어 모드, 돌파형 BLOCK & 역추세·그리드·올라운더 최우선)" : regimeFilter.marketRegime === "BULL" ? "상승/추세장 (모멘텀·추세추종 적극 허용)" : "횡보장 (박스권·눌림목·올라운더 유리)"}

### [10대 알고리즘 봇 Arena 모의투자 실시간 성적표]
${botSummary}

---

### [필수 선정 및 배분 원칙 (단일 봇 100% 집중 모드)]
1. AI필터가 BLOCK인 봇은 원칙적으로 제외하고, ALLOW 봇 중 현재 시장 체제에 가장 적합하며 최근 7일 거래 검증이 완료된 봇 단 1개만 선정하십시오 (약세장에서 거래 0건으로 0%인 추세봇 제외).
2. 하락장/약세장(${isBearish ? "현재 해당" : "해당 없음"}): 역추세·그리드·VWAP 올라운더 전략군 중 손실 방어력(MDD, 7일 수익, 승률)이 가장 뛰어난 1개 봇 선정.
3. 상승장: 추세·스윙 / 변동성 돌파 / 올라운더 중 주간 수익률 및 리스크 대비 성과 1위 봇 1개 선정.
4. selected_bots 배열 길이는 반드시 정확히 1이어야 하며 allocation_ratio는 반드시 1.0 이어야 합니다.
5. 반드시 다른 부가 텍스트 없이 오직 유효한 순수 JSON 형식 하나만 출력하십시오:
{
  "market_assessment": "현재 시장 상황과 거시 체제에 대한 2~3줄 요약 평가",
  "portfolio_strategy": "단일 적합 봇 100% 집중 운용 전략 설명",
  "selected_bots": [
    { "rank": 1, "bot_id": "bot_XX", "allocation_ratio": 1.0, "reason": "현재 시장 적합성 및 1위 선정 사유" }
  ]
}`
      : `당신은 대한민국 최고 수준의 암호화폐 퀀트 헤지펀드 수석 AI 포트폴리오 매니저입니다.
현재 코인 시장 체제(비트코인 20일 이평선, 변동성 등)와 지난 10대 알고리즘 봇의 실시간 모의투자(Arena) 성적표를 심층 분석하여,
매주 일요일 오전 9시부터 1주일간 실전매매(Live Trading)를 전담할 가장 적합한 최적의 봇 1위, 2위, 3위를 엄정하게 선정하십시오.

### [실시간 시장 체제 지표]
- 비트코인(BTC) 현재가: ${btcPrice ? btcPrice.toLocaleString("ko-KR") + "원" : "데이터 수신 중"}
- 일봉 20일 이동평균선(20 MA): ${btcDaily20Ma ? Math.floor(btcDaily20Ma).toLocaleString("ko-KR") + "원" : "-"}
- 4시간봉 60선: ${btc4h60Ma ? Math.floor(btc4h60Ma).toLocaleString("ko-KR") + "원" : "-"}
- 시장 상태: ${isBearish ? "하락/약세장 (비트코인이 일봉 20MA 밑에 위치, 휩쏘 주의 및 자산 보존 최우선)" : "상승/추세장"}

### [10대 알고리즘 봇 Arena 모의투자 실시간 성적표]
${botSummary}

---

### [필수 평가 및 배분 원칙]
1. 하락장/횡보장(BTC 일봉 20MA 하회 시):
   - 휩쏘 손실 위험이 큰 공격적 돌파봇(변동성 돌파, 볼린저 역추세 등)을 피하고,
   - 손실 방어력이 입증된 봇(MDD가 낮고 승률이 높은 봇, 정배열 20일선 눌림목봇, 트레일링 스탑봇, 과매도 반등 스캘퍼 등)을 최우선으로 선정하십시오.
2. 상승장(BTC 일봉 20MA 상회 시):
   - 추세 추종 및 모멘텀 전략 봇을 적극 배치하십시오.
3. 선정된 1위, 2위, 3위 봇의 투자 배분 비율(allocation_ratio)은 합계가 반드시 정확히 1.0 (예: 1위 0.34, 2위 0.33, 3위 0.33)이어야 합니다.
4. 반드시 다른 부가 텍스트 없이 오직 유효한 순수 JSON 형식 하나만 출력하십시오 (마크다운 따옴표 포함 금지):
{
  "market_assessment": "현재 시장 상황과 거시 체제에 대한 2~3줄 요약 평가",
  "portfolio_strategy": "선정된 3개 봇 조합의 자산 배분 운용 전략 설명",
  "selected_bots": [
    { "rank": 1, "bot_id": "bot_XX", "allocation_ratio": 0.34, "reason": "1위 선정 사유" },
    { "rank": 2, "bot_id": "bot_YY", "allocation_ratio": 0.33, "reason": "2위 선정 사유" },
    { "rank": 3, "bot_id": "bot_ZZ", "allocation_ratio": 0.33, "reason": "3위 선정 사유" }
  ]
}`;

    let parsed = null;
    let weeklyQuota429Count = 0;
    const apiKey = await getGeminiApiKey();
    const leaderboardIds = new Set(arenaLeaderboard.map((a) => a.bot_id));
    const hasAllowOverride = Object.values(regimeFilter.botOverrides || {}).some((v) => v === "ALLOW");

    if (apiKey) {
      const candidateModels = getDualAiCandidateModels(false);
      for (const model of candidateModels) {
        let timer = null;
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), 12000);
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4096,
                responseMimeType: "application/json",
              },
            }),
          });
          clearTimeout(timer);
          if (resp.status === 429) {
            weeklyQuota429Count += 1;
          }
          if (resp.ok) {
            const resJson = await resp.json();
            let text = resJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
            text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) text = jsonMatch[0];
            const p = JSON.parse(text);
            if (isSingleBotMode) {
              if (Array.isArray(p.selected_bots) && p.selected_bots.length === 1) {
                const picked = p.selected_bots[0];
                const pickedId = picked?.bot_id;
                const topWinner = rotEvaluation?.champions?.[0];
                const eligibleIds = new Set(rotEvaluation?.single_eligible_bot_ids || []);
                const topScore = Number(topWinner?.rotation_score ?? -Infinity);
                const pickedScore = Number(rotEvaluation?.by_bot_id?.[pickedId]?.rotation_score ?? -Infinity);
                const isAllowed = !hasAllowOverride || regimeFilter.botOverrides?.[pickedId] !== "BLOCK";
                const isEligibleForRegime = eligibleIds.size === 0 || eligibleIds.has(pickedId);
                const isCompetitiveScore = !topWinner || pickedScore >= topScore - 3.0;
                if (leaderboardIds.has(pickedId) && isAllowed && isEligibleForRegime && isCompetitiveScore) {
                  p.selected_bots = [{ ...picked, rank: 1, allocation_ratio: 1.0 }];
                  parsed = p;
                  console.log(`[LLM Weekly Bot Selection] Gemini(${model}) 단일 적합 봇(${pickedId}) 평가 성공!`);
                  break;
                }
              }
            } else if (Array.isArray(p.selected_bots) && p.selected_bots.length === 3) {
              parsed = p;
              console.log(`[LLM Weekly Bot Selection] Gemini(${model}) 봇 평가 성공!`);
              break;
            }
          }
        } catch (err) {
          if (timer) clearTimeout(timer);
          console.warn(`[LLM Weekly Bot Selection] 모델 ${model} 호출 에러:`, err.message);
        }
      }
    }

    if (!parsed) {
      if (weeklyQuota429Count > 0) {
        notifyGeminiQuotaExceeded({
          source: "주간 봇 자동 선별 (Weekly Bot Selection)",
          triggerType: "AUTO",
          fallbackTier: "QUANT_RULE_BASED",
          reason: "Gemini API 429 Quota Exceeded (주간 봇 선별 룰베이스 폴백 적용)",
        });
      }
      console.warn(`[LLM Weekly Bot Selection] Gemini 호출 실패/부적합으로 퀀트 룰베이스 알고리즘 폴백 적용`);
      if (isSingleBotMode && rotEvaluation?.champions?.length > 0) {
        const winner = rotEvaluation.champions[0];
        parsed = {
          market_assessment: `${regimeFilter.reason || "현재 시장 레짐 필터 기준"} · 시장 적합 단일 봇 자동 선별 모드가 적용됩니다.`,
          portfolio_strategy: `[${regimeFilter.marketRegime}/${regimeFilter.finalAction}] 시장 체제에 가장 적합한 '${winner.nickname}' 단일 봇 100% 집중 운용 전략`,
          selected_bots: [
            {
              rank: 1,
              bot_id: winner.bot_id,
              allocation_ratio: 1.0,
              reason:
                rotEvaluation.selection_reason ||
                `시장 적합도 및 주간 평가 1위 (점수 ${winner.rotation_score}, 주간수익 ${winner.weekly_return_pct}%, MDD ${winner.mdd_pct}%)`,
            },
          ],
        };
      } else {
        const sorted = [...arenaLeaderboard].sort((a, b) => {
          if (isBearish) {
            return (Number(a.mdd_pct) - Number(b.mdd_pct)) || (Number(b.profit_rate_pct) - Number(a.profit_rate_pct));
          }
          return (Number(b.profit_rate_pct) - Number(a.profit_rate_pct)) || (Number(a.mdd_pct) - Number(b.mdd_pct));
        });

        const top3 = sorted.slice(0, 3);
        parsed = {
          market_assessment: isBearish
            ? "비트코인이 일봉 20일선 및 4시간 60선을 하회하는 약세장 국면으로, 최대 낙폭(MDD) 방어력이 입증된 봇을 최우선 배치합니다."
            : "비트코인이 추세선 상단에 위치한 정상 국면으로, 수익률 및 모멘텀이 우수한 봇을 선별 배치합니다.",
          portfolio_strategy: "자산 보존 및 리스크 최소화를 위한 상위 3대 봇 분할 자본 배분 전략",
          selected_bots: [
            { rank: 1, bot_id: top3[0].bot_id, allocation_ratio: 0.34, reason: `모의투자 검증상 손실 방어력 1위 (MDD ${top3[0].mdd_pct}%, 누적손익 ${top3[0].profit_rate_pct}%)` },
            { rank: 2, bot_id: top3[1].bot_id, allocation_ratio: 0.33, reason: `트레이딩 안정성 2위 (MDD ${top3[1].mdd_pct}%, 누적손익 ${top3[1].profit_rate_pct}%)` },
            { rank: 3, bot_id: top3[2].bot_id, allocation_ratio: 0.33, reason: `단기 과매도 반등 특화 3위 (MDD ${top3[2].mdd_pct}%, 누적손익 ${top3[2].profit_rate_pct}%)` },
          ],
        };
      }
    }

    // 실전 봇 라인업 자동 적용 (계좌 유지 로직: 90% 원금 배분, 10% 안전 버퍼 엄격 보존)
    const applyRes = await applyLiveBotsSelection(
      parsed.selected_bots.map((b) => ({ bot_id: b.bot_id, allocation_ratio: b.allocation_ratio }))
    );

    const fullResult = {
      evaluated_at: nowStr,
      last_run: nowStr,
      slot_key: slotInfo.slotKey,
      schedule_rule: "매주 일요일 오전 09:00 KST",
      next_scheduled_run: slotInfo.nextSundaySlot,
      days_remaining: slotInfo.daysRemaining,
      market_assessment: parsed.market_assessment,
      portfolio_strategy: parsed.portfolio_strategy,
      selected_bots: parsed.selected_bots.map((b) => {
        const botInfo = arenaLeaderboard.find((a) => a.bot_id === b.bot_id);
        return {
          rank: b.rank,
          bot_id: b.bot_id,
          name: botInfo?.name || b.bot_id,
          nickname: botInfo?.nickname || b.bot_id,
          strategy_type: botInfo?.strategy_type || "",
          ...getBotStrategyMeta(b.bot_id),
          allocation_ratio: b.allocation_ratio,
          reason: b.reason,
        };
      }),
      apply_result: applyRes,
    };

    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('llm_weekly_bot_selection_last_slot', ?, ?)").run(slotInfo.slotKey, nowStr);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('llm_weekly_bot_selection_last_run', ?, ?)").run(nowStr, nowStr);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('llm_weekly_bot_selection_result', ?, ?)").run(JSON.stringify(fullResult), nowStr);

    console.log(`[LLM Weekly Bot Selection] 매주 일요일 09:00 기점 최적 봇 자동 세팅 완료 (슬롯: ${slotInfo.slotKey}): ${fullResult.selected_bots.map((b) => `${b.rank}위 ${b.nickname}(${(b.allocation_ratio * 100).toFixed(0)}%)`).join(", ")}`);
    return { success: true, ...fullResult };
  } catch (err) {
    console.error(`[LLM Weekly Bot Selection] 에러:`, err.message);
    return { success: false, error: err.message };
  } finally {
    isWeeklyBotSelectionRunning = false;
  }
}

/**
 * [Antigravity-Doc] 레거시 일요일 09:00 LLM 주간 봇 선정 스케줄러.
 * `legacy_llm_weekly_rotation_enabled='1'` 명시적 Opt-In 및 신규 자동 로테이션 비활성 상태에서만 동작한다.
 * @returns {Promise<void>}
 */
async function checkAndRunScheduledLlmWeeklyBotSelection() {
  if (isWeeklyBotSelectionRunning) return;
  try {
    // 주간 전략군 TOP 1 자동 로테이션 체계 전환 이후 레거시 일요일 LLM 일괄 덮어쓰기는 명시적 Opt-In 시에만 동작
    const legacyOptIn = await getSetting("legacy_llm_weekly_rotation_enabled", "0");
    if (legacyOptIn !== "1") {
      return;
    }
    try {
      const db = getDb();
      const rotCfg = await db.prepare("SELECT is_enabled FROM auto_rotation_config WHERE id = 1").get();
      if (rotCfg && Number(rotCfg.is_enabled ?? 1) === 1) {
        return;
      }
    } catch {}

    const slotInfo = getWeeklySundaySlotInfo();
    const lastSlotKey = await getSetting("llm_weekly_bot_selection_last_slot", "");
    // 현재 일요일 09:00 슬롯에 대한 자동 선정이 아직 실행되지 않았으면 실행
    if (lastSlotKey !== slotInfo.slotKey) {
      console.log(`[Weekly Bot Scheduler] 일요일 09:00 기점 주간 슬롯(${slotInfo.slotKey}) 도래로 AI 최적 봇 자동 선정을 실행합니다.`);
      await runLlmWeeklyBotSelection(false);
    }
  } catch (err) {
    console.warn("[Weekly Bot Scheduler] 스케줄러 실행 오류:", err.message);
  }
}

// ============================================================================
// [주간 전략별 챔피언(3대 전략군 1위 봇) 자동 로테이션 & Graceful Drain 엔진]
// ============================================================================
// [Antigravity-Doc] 자동 로테이션·자본 리밸런싱 배타 실행 플래그 및 72시간 장기 미매도 Drain 일일 중복 알림 방지 캐시
let isAutoRotationExecuting = false;
let isCapitalRebalancing = false;
const staleDrainAlertSentMap = new Map();

/**
 * [Antigravity-Doc] KST 타임스탬프 문자열('YYYY-MM-DD HH:mm:ss')을 UTC 에포크 밀리초로 파싱한다.
 * @param {string} dateStr
 * @returns {number} 파싱 실패 시 NaN
 */
function parseKstTimestampMs(dateStr) {
  if (!dateStr) return NaN;
  const normalized = String(dateStr).trim().replace("T", " ").slice(0, 19);
  const ms = Date.parse(`${normalized.replace(" ", "T")}+09:00`);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * [Antigravity-Doc] `auto_rotation_config(id=1)` 테이블에서 주간 자동 로테이션 설정(요일/시각/배분모드/자본 티어/90% 상한)을 조회한다.
 * 행이 없으면 기본값(월요일 09:00 KST, `EQUAL_BY_EQUITY_TIER`, 90% 상한)을 자동 시드한다.
 * @param {object} db
 * @returns {Promise<object>}
 */
async function getAutoRotationConfig(db) {
  let row = await db.prepare("SELECT * FROM auto_rotation_config WHERE id = 1").get();
  if (!row) {
    const nowStr = nowKSTString();
    const nextStr = computeNextRotationKstString(1, 9);
    await db
      .prepare(
        `INSERT INTO auto_rotation_config (
           id, is_enabled, rotation_day_of_week, rotation_hour_kst,
           allocation_mode, min_weekly_trades, capital_tier_1_max, capital_tier_2_max, max_deploy_ratio,
           last_rotated_at, next_rotation_at, updated_at
         ) VALUES (1, 1, 1, 9, 'EQUAL_BY_EQUITY_TIER', 2, 400000, 700000, 0.90, NULL, ?, ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .run(nextStr, nowStr);
    row = await db.prepare("SELECT * FROM auto_rotation_config WHERE id = 1").get();
  }
  const dayOfWeek = Math.max(0, Math.min(6, Number(row?.rotation_day_of_week ?? 1)));
  const hourKst = Math.max(0, Math.min(23, Number(row?.rotation_hour_kst ?? 9)));
  const allocMode = ALLOCATION_MODE_WEIGHTS[row?.allocation_mode]
    ? row.allocation_mode
    : "EQUAL_BY_EQUITY_TIER";
  const tier1Max = Math.max(10000, Math.floor(Number(row?.capital_tier_1_max ?? DEFAULT_CAPITAL_TIER_1_MAX)));
  const tier2Max = Math.max(tier1Max + 1, Math.floor(Number(row?.capital_tier_2_max ?? DEFAULT_CAPITAL_TIER_2_MAX)));
  const rawDeployRatio = Number(row?.max_deploy_ratio ?? DEFAULT_MAX_DEPLOY_RATIO);
  const maxDeployRatio =
    Number.isFinite(rawDeployRatio) && rawDeployRatio > 0 && rawDeployRatio <= 1
      ? Number(rawDeployRatio.toFixed(4))
      : DEFAULT_MAX_DEPLOY_RATIO;
  return {
    id: 1,
    is_enabled: Number(row?.is_enabled ?? 1),
    rotation_day_of_week: dayOfWeek,
    rotation_hour_kst: hourKst,
    allocation_mode: allocMode,
    min_weekly_trades: Math.max(0, Number(row?.min_weekly_trades ?? 2)),
    capital_tier_1_max: tier1Max,
    capital_tier_2_max: tier2Max,
    max_deploy_ratio: maxDeployRatio,
    last_rotated_at: row?.last_rotated_at || null,
    next_rotation_at: row?.next_rotation_at || computeNextRotationKstString(dayOfWeek, hourKst),
    updated_at: row?.updated_at || nowKSTString(),
  };
}

/**
 * [Antigravity-Doc] 주간 자동 로테이션 설정(`auto_rotation_config`)을 유효성 클램핑 후 갱신하고 차기 실행 시각을 재계산한다.
 * @param {object} [payload={}]
 * @returns {Promise<object>} 갱신된 설정 객체
 */
async function updateAutoRotationConfig(payload = {}) {
  const db = getDb();
  const current = await getAutoRotationConfig(db);
  const nextEnabled = payload.is_enabled !== undefined ? (Number(payload.is_enabled) ? 1 : 0) : current.is_enabled;
  const nextDow =
    payload.rotation_day_of_week !== undefined
      ? Math.max(0, Math.min(6, Math.floor(Number(payload.rotation_day_of_week))))
      : current.rotation_day_of_week;
  const nextHour =
    payload.rotation_hour_kst !== undefined
      ? Math.max(0, Math.min(23, Math.floor(Number(payload.rotation_hour_kst))))
      : current.rotation_hour_kst;
  const nextMode =
    payload.allocation_mode && ALLOCATION_MODE_WEIGHTS[payload.allocation_mode]
      ? payload.allocation_mode
      : current.allocation_mode;
  const nextMinTrades =
    payload.min_weekly_trades !== undefined
      ? Math.max(0, Math.min(100, Math.floor(Number(payload.min_weekly_trades))))
      : current.min_weekly_trades;
  const nextTier1 =
    payload.capital_tier_1_max !== undefined
      ? Math.max(10000, Math.floor(Number(payload.capital_tier_1_max)))
      : current.capital_tier_1_max;
  const nextTier2 =
    payload.capital_tier_2_max !== undefined
      ? Math.max(nextTier1 + 1, Math.floor(Number(payload.capital_tier_2_max)))
      : Math.max(nextTier1 + 1, current.capital_tier_2_max);
  const nextDeployRatio =
    payload.max_deploy_ratio !== undefined && Number(payload.max_deploy_ratio) > 0 && Number(payload.max_deploy_ratio) <= 1
      ? Number(Number(payload.max_deploy_ratio).toFixed(4))
      : current.max_deploy_ratio;

  const nowStr = nowKSTString();
  const nextRotationAt = computeNextRotationKstString(nextDow, nextHour);

  await db
    .prepare(
      `UPDATE auto_rotation_config
       SET is_enabled = ?, rotation_day_of_week = ?, rotation_hour_kst = ?,
           allocation_mode = ?, min_weekly_trades = ?,
           capital_tier_1_max = ?, capital_tier_2_max = ?, max_deploy_ratio = ?,
           next_rotation_at = ?, updated_at = ?
       WHERE id = 1`
    )
    .run(nextEnabled, nextDow, nextHour, nextMode, nextMinTrades, nextTier1, nextTier2, nextDeployRatio, nextRotationAt, nowStr);

  return await getAutoRotationConfig(db);
}

/**
 * [Antigravity-Doc] 로테이션 대시보드 전체 현황 페이로드를 생성한다.
 * 자본 티어(1~3봇), 90% 상한 사용률, 전략군별 챔피언 평가, Draining 포지션 실시간 평가손익 및 72시간 경과 경고 알림,
 * 후임 봇 자금 복원 대기 상태(`WAITING_CAPITAL_RESTORE`), 로테이션/이관/복원 이력을 모두 포함한다.
 * @param {{liveTotalEquityKrw?:number, skipMarketFetch?:boolean}} [options={}]
 * @returns {Promise<object>}
 */
export async function getRotationStatusPayload(options = {}) {
  const db = getDb();
  const config = await getAutoRotationConfig(db);
  const cachedEquityKrw = Math.floor(Number(await getSetting("last_synced_total_equity_krw", "0")));
  const legacyCapKrw = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));
  const resolvedEq = resolveTotalEquityAndSingle90Cap({
    liveTotalEquityKrw: options?.liveTotalEquityKrw ?? null,
    cachedTotalEquityKrw: cachedEquityKrw > 0 ? cachedEquityKrw : null,
    legacyAuto90PrincipalKrw: legacyCapKrw > 0 ? legacyCapKrw : null,
    maxDeployRatio: config.max_deploy_ratio,
  });
  const totalEquityKrw = resolvedEq.totalEquityKrw;
  const evaluation = await evaluateWeeklyStrategyChampions(db, {
    minWeeklyTrades: config.min_weekly_trades,
    allocationMode: config.allocation_mode,
    totalEquityKrw,
    tier1Max: config.capital_tier_1_max,
    tier2Max: config.capital_tier_2_max,
    maxDeployRatio: config.max_deploy_ratio,
  });
  const liveBots = await getBots("live");
  const drainingRawBots = liveBots.filter(
    (b) => Number(b.is_selected_for_live || 0) !== 1 && (b.open_positions || []).length > 0
  );
  const electedLiveBots = liveBots.filter((b) => Number(b.is_selected_for_live || 0) === 1);

  const tierInfo = getCapitalTierSummary(totalEquityKrw, {
    tier1Max: config.capital_tier_1_max,
    tier2Max: config.capital_tier_2_max,
    maxDeployRatio: config.max_deploy_ratio,
  });

  // Draining 보유 포지션 실시간 현재가 및 미실현 수익률 + 경과 시간(72h 경고) 산출
  const drainingMarkets = [...new Set(drainingRawBots.flatMap((b) => (b.open_positions || []).map((p) => p.market || p.ticker).filter(Boolean)))];
  let livePriceMap = new Map();
  if (drainingMarkets.length > 0) {
    for (const m of drainingMarkets) {
      const cached = upbitTickersCache.get(m);
      const cachedPrice = Number(cached?.data?.trade_price || 0);
      if (cachedPrice > 0) {
        livePriceMap.set(m, cachedPrice);
      }
    }
    if (livePriceMap.size < drainingMarkets.length && !options?.skipMarketFetch && process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
      try {
        const fetched = await fetchUpbitTickersMap(drainingMarkets);
        for (const m of drainingMarkets) {
          const tk = fetched?.get(m);
          if (tk && Number(tk.trade_price) > 0) {
            livePriceMap.set(m, Number(tk.trade_price));
          }
        }
      } catch {}
    }
  }

  const nowMs = Date.now();
  const drainingPositions = [];
  const drainingBots = drainingRawBots.map((b) => {
    const meta = getBotStrategyMeta(b.bot_id);
    const botDrainStartMs = parseKstTimestampMs(b.drain_started_at);
    const enrichedPositions = (b.open_positions || []).map((pos) => {
      const mkt = pos.market || pos.ticker || "";
      const avgBuy = Number(pos.avg_buy_price || 0);
      const vol = Number(pos.volume || 0);
      const buyAmt = Math.floor(Number(pos.buy_amount || 0));
      const curPrice = livePriceMap.has(mkt) && livePriceMap.get(mkt) > 0 ? livePriceMap.get(mkt) : avgBuy;
      const evalAmt = curPrice * vol;
      const unrealizedPnlKrw = Math.floor(evalAmt - buyAmt);
      const unrealizedPnlPct = avgBuy > 0 ? Number((((curPrice - avgBuy) / avgBuy) * 100).toFixed(2)) : 0;
      const posStartMs = Number.isFinite(botDrainStartMs) ? botDrainStartMs : parseKstTimestampMs(pos.created_at);
      const elapsedHours = Number.isFinite(posStartMs) ? Math.max(0, Number(((nowMs - posStartMs) / 3600000).toFixed(1))) : 0;
      const isStaleDrain = elapsedHours >= 72;

      if (isStaleDrain && !options?.skipMarketFetch && process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
        const alertKey = `${b.bot_id}|${pos.id}|${todayDateString()}`;
        if (!staleDrainAlertSentMap.has(alertKey)) {
          staleDrainAlertSentMap.set(alertKey, true);
          dispatchMultiChannelNotification(
            db,
            {
              eventType: "STALE_DRAIN_WARNING",
              botId: b.bot_id,
              botName: b.nickname || b.name,
              market: mkt,
              reason: `[⚠️ 장기 미매도 Drain 경고] ${b.nickname || b.name}(${mkt}) 포지션이 ${elapsedHours}시간(72시간 초과) 미매도 상태입니다. 묶인 원금 ${buyAmt.toLocaleString("ko-KR")}원${b.replaced_by_bot_id ? ` (후임 ${b.replaced_by_bot_id} 예산 차감 중)` : ""}. 필요 시 수동 청산 후 자금 복원을 실행하세요.`,
            },
            { webPushBroadcastFn: broadcastWebPushNotification }
          ).catch(() => {});
        }
      }

      const item = {
        position_id: pos.id,
        bot_id: b.bot_id,
        nickname: b.nickname || b.name,
        name: b.name,
        strategy_group_code: meta.strategy_group_code,
        strategy_group: meta.strategy_group,
        replaced_by_bot_id: b.replaced_by_bot_id || null,
        drain_status: b.drain_status || "DRAINING",
        drain_started_at: b.drain_started_at || pos.created_at || "",
        elapsed_hours: elapsedHours,
        is_stale_drain: isStaleDrain,
        market: mkt,
        ticker: pos.ticker || mkt,
        order_uuid: pos.order_uuid || "",
        volume: vol,
        avg_buy_price: avgBuy,
        buy_amount: buyAmt,
        current_price: curPrice,
        unrealized_pnl_krw: unrealizedPnlKrw,
        unrealized_pnl_pct: unrealizedPnlPct,
        created_at: pos.created_at || "",
      };
      drainingPositions.push(item);
      return item;
    });
    const maxElapsed = enrichedPositions.reduce((mx, p) => Math.max(mx, Number(p.elapsed_hours || 0)), 0);
    return {
      bot_id: b.bot_id,
      nickname: b.nickname,
      ...meta,
      drain_status: b.drain_status || "DRAINING",
      replaced_by_bot_id: b.replaced_by_bot_id || null,
      drain_started_at: b.drain_started_at || null,
      elapsed_hours: maxElapsed,
      is_stale_drain: maxElapsed >= 72,
      used_capital: Math.floor(Number(b.used_capital || 0)),
      open_positions_count: enrichedPositions.length,
      open_positions: enrichedPositions,
      last_status_msg: b.last_status_msg || "",
    };
  });

  const totalDrainingLockedKrw = drainingBots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const totalElectedLockedKrw = electedLiveBots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.used_capital || 0))), 0);
  const totalElectedCashKrw = electedLiveBots.reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);
  const totalUsedKrw = totalDrainingLockedKrw + totalElectedLockedKrw + totalElectedCashKrw;
  const utilizationPct =
    totalEquityKrw > 0 ? Number(((totalUsedKrw / totalEquityKrw) * 100).toFixed(2)) : 0;

  const electedFundingStatus = electedLiveBots.map((eb) => {
    const linkedDrains = drainingBots.filter((d) => d.replaced_by_bot_id === eb.bot_id);
    const linkedDrainLockedKrw = linkedDrains.reduce((acc, d) => acc + Math.max(0, Math.floor(Number(d.used_capital || 0))), 0);
    const ownLockedKrw = Math.max(0, Math.floor(Number(eb.used_capital || 0)));
    const virtualKrw = Math.max(0, Math.floor(Number(eb.virtual_krw || 0)));
    const targetCapitalKrw = Math.max(0, Math.floor(Number(eb.target_capital_krw || tierInfo.perBotTargetKrw || 0)));
    const deficitKrw = Math.max(0, targetCapitalKrw - (ownLockedKrw + virtualKrw));
    const fundingStatus =
      virtualKrw < MIN_LIVE_ORDER_SAFE_KRW && ownLockedKrw === 0 && (linkedDrainLockedKrw > 0 || totalDrainingLockedKrw > 0)
        ? "WAITING_CAPITAL_RESTORE"
        : "READY";
    return {
      bot_id: eb.bot_id,
      nickname: eb.nickname || eb.name,
      target_capital_krw: targetCapitalKrw,
      own_locked_krw: ownLockedKrw,
      virtual_krw: virtualKrw,
      linked_drain_locked_krw: linkedDrainLockedKrw,
      linked_drain_bot_ids: linkedDrains.map((d) => d.bot_id),
      deficit_krw: deficitKrw,
      funding_status: fundingStatus,
    };
  });

  const rawHistory = await db
    .prepare("SELECT * FROM auto_rotation_history ORDER BY id DESC LIMIT 20")
    .all();
  const history = rawHistory.map((h) => {
    let previousBots = [];
    let electedBots = [];
    try {
      previousBots = JSON.parse(h.previous_bots_json || "[]");
    } catch {}
    try {
      electedBots = JSON.parse(h.elected_bots_json || "[]");
    } catch {}
    return {
      id: h.id,
      trigger_type: h.trigger_type,
      previous_bots: previousBots,
      elected_bots: electedBots,
      draining_positions_count: Number(h.draining_positions_count || 0),
      transferred_krw: Math.floor(Number(h.transferred_krw || 0)),
      summary_text: h.summary_text || "",
      created_at: h.created_at,
    };
  });

  let drainHandoffLogs = [];
  let totalDrainTransferredKrw = 0;
  try {
    const rawHandoffs = await db
      .prepare("SELECT * FROM drain_handoff_logs ORDER BY id DESC LIMIT 30")
      .all();
    drainHandoffLogs = rawHandoffs.map((d) => {
      let allocations = [];
      try {
        allocations = JSON.parse(d.allocations_json || "[]");
      } catch {}
      return {
        id: d.id,
        from_bot_id: d.from_bot_id,
        market: d.market,
        position_id: Number(d.position_id || 0),
        trade_id: Number(d.trade_id || 0),
        reason: d.reason || "",
        sell_amount: Math.floor(Number(d.sell_amount || 0)),
        sell_fee: Math.floor(Number(d.sell_fee || 0)),
        net_proceeds_krw: Math.floor(Number(d.net_proceeds_krw || 0)),
        realized_pnl_krw: Math.floor(Number(d.realized_pnl_krw || 0)),
        allocations,
        remaining_positions_count: Number(d.remaining_positions_count || 0),
        created_at: d.created_at,
      };
    });
    const sumRow = await db
      .prepare("SELECT COALESCE(SUM(net_proceeds_krw), 0) AS total_drain_krw FROM drain_handoff_logs")
      .get();
    totalDrainTransferredKrw = Math.floor(Number(sumRow?.total_drain_krw || 0));
  } catch {}

  let recentRestorations = [];
  try {
    const rawRest = await db
      .prepare("SELECT * FROM capital_restoration_logs ORDER BY id DESC LIMIT 20")
      .all();
    recentRestorations = rawRest.map((r) => ({
      id: r.id,
      source_bot_id: r.source_bot_id,
      target_bot_id: r.target_bot_id || "RESERVE",
      order_uuid: r.order_uuid || "",
      settled_net_krw: Math.floor(Number(r.settled_net_krw || 0)),
      restored_krw: Math.floor(Number(r.restored_krw || 0)),
      surplus_reserve_krw: Math.floor(Number(r.surplus_reserve_krw || 0)),
      total_used_after_krw: Math.floor(Number(r.total_used_after_krw || 0)),
      global_cap_krw: Math.floor(Number(r.global_cap_krw || 0)),
      total_equity_snapshot_krw: Math.floor(Number(r.total_equity_snapshot_krw || 0)),
      created_at: r.created_at,
    }));
  } catch {}

  let totalRotationTransferredKrw = 0;
  try {
    const rotSumRow = await db
      .prepare("SELECT COALESCE(SUM(transferred_krw), 0) AS total_rot_krw FROM auto_rotation_history")
      .get();
    totalRotationTransferredKrw = Math.floor(Number(rotSumRow?.total_rot_krw || 0));
  } catch {}

  return {
    success: true,
    config,
    total_equity_krw: tierInfo.totalEquityKrw,
    equity_source: resolvedEq.source,
    principal_krw: tierInfo.totalEquityKrw,
    global_cap_krw: tierInfo.globalCapKrw,
    reserve_min_krw: tierInfo.reserveMinKrw,
    active_tier_bot_count: tierInfo.botCount,
    tier_label: tierInfo.tierLabel,
    per_bot_target_krw: tierInfo.perBotTargetKrw,
    total_used_krw: totalUsedKrw,
    total_draining_locked_krw: totalDrainingLockedKrw,
    total_elected_locked_krw: totalElectedLockedKrw,
    total_elected_cash_krw: totalElectedCashKrw,
    utilization_pct: utilizationPct,
    utilization_pct_of_equity: utilizationPct,
    elected_funding_status: electedFundingStatus,
    strategy_groups: STRATEGY_GROUP_ORDER.map((code) => STRATEGY_GROUP_META[code]),
    allocation_modes: ALLOCATION_MODE_WEIGHTS,
    evaluation,
    champions: evaluation.champions,
    groups: evaluation.groups,
    draining_bots: drainingBots,
    draining_positions: drainingPositions,
    drain_handoff_logs: drainHandoffLogs,
    recent_restorations: recentRestorations,
    total_drain_transferred_krw: totalDrainTransferredKrw,
    total_rotation_transferred_krw: totalRotationTransferredKrw,
    total_transferred_krw: totalRotationTransferredKrw + totalDrainTransferredKrw,
    history,
  };
}

/**
 * [Antigravity-Doc] 주간 전략군 챔피언 자동/수동 로테이션을 실행한다.
 * 핵심 절차:
 *  1. 중복 실행 가드(`isAutoRotationExecuting`, `isCapitalRebalancing`) 설정 및 업비트 총 평가자산 선조회(락 외부).
 *  2. `evaluateWeeklyStrategyChampions`로 전략군별 챔피언 선출.
 *  3. `EQUAL_BY_EQUITY_TIER` 모드 시 `withDbWriteLock` 트랜잭션 안에서 90% 상한 불변식(`assertGlobal90CapInvariant`)을 검증하며
 *     선출 봇 배정 및 탈락 봇 Graceful Drain(`replaced_by_bot_id` 연결) 적용.
 *  4. `auto_rotation_history` 기록, 차기 로테이션 시각 갱신, 멀티채널 알림 발송.
 * @param {{triggerType?:string, forcedCapital?:number|null, skipLiveAccountSync?:boolean, actualAvailableKrwOverride?:number|null}} [params]
 * @returns {Promise<object>}
 */
export async function executeWeeklyBotRotation({
  triggerType = "MANUAL_IMMEDIATE",
  forcedCapital = null,
  skipLiveAccountSync = false,
  actualAvailableKrwOverride = null,
} = {}) {
  if (isAutoRotationExecuting || isCapitalRebalancing) {
    return { success: false, already_running: true, message: "주간 전략별 1위 봇 로테이션 또는 자금 리밸런싱이 이미 실행 중입니다." };
  }
  isAutoRotationExecuting = true;
  isCapitalRebalancing = true;
  try {
    const db = getDb();
    const config = await getAutoRotationConfig(db);

    // 실시간 업비트 총 평가자산(E_total) 및 실계좌 가용 원화(이중 캡용) 선조회 (DB 락 밖)
    let preloadedAccountInfo = null;
    if (!(Number(forcedCapital) > 0) && !skipLiveAccountSync && process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
      try {
        preloadedAccountInfo = await fetchUpbitAccountBalance();
      } catch {}
    }

    const liveUpbitEquity =
      Number(forcedCapital) > 0
        ? Math.floor(Number(forcedCapital))
        : preloadedAccountInfo?.success
        ? Math.floor(Number(preloadedAccountInfo.total_asset_krw ?? preloadedAccountInfo.krw_total ?? preloadedAccountInfo.krw_balance ?? 0))
        : null;
    const cachedEquityKrw = Math.floor(Number(await getSetting("last_synced_total_equity_krw", "0")));
    const legacyCapKrw = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));

    const resolvedEquity = resolveTotalEquityAndSingle90Cap({
      liveTotalEquityKrw: liveUpbitEquity && liveUpbitEquity > 0 ? liveUpbitEquity : null,
      cachedTotalEquityKrw: cachedEquityKrw > 0 ? cachedEquityKrw : null,
      legacyAuto90PrincipalKrw: legacyCapKrw > 0 ? legacyCapKrw : null,
      maxDeployRatio: config.max_deploy_ratio,
    });
    const principalKrw = resolvedEquity.totalEquityKrw;
    const isEquityTierMode = isEquityTierAllocationMode(config.allocation_mode);

    if (isEquityTierMode && principalKrw < 10000) {
      throw new Error(
        `실시간 총 평가자산(${principalKrw.toLocaleString("ko-KR")}원)이 최소 주문 불가 기준(10,000원) 미만이어서 신규 봇 선출을 중단했습니다.`
      );
    }

    const evaluation = await evaluateWeeklyStrategyChampions(db, {
      minWeeklyTrades: config.min_weekly_trades,
      allocationMode: config.allocation_mode,
      totalEquityKrw: principalKrw,
      tier1Max: config.capital_tier_1_max,
      tier2Max: config.capital_tier_2_max,
      maxDeployRatio: config.max_deploy_ratio,
    });

    if (!evaluation.champions || evaluation.champions.length === 0) {
      throw new Error("선출 가능한 전략군별 챔피언 봇이 없습니다.");
    }

    let applyRes = null;
    const nowStr = nowKSTString();
    const nextRotStr = computeNextRotationKstString(config.rotation_day_of_week, config.rotation_hour_kst);

    if (isEquityTierMode) {
      // 실시간 총 평가자산 구간별 1~3개 균등 배분 + 탈락 봇 포지션 차감 + 단일 90% 상한 불변식 적용
      const actualAvailKrw =
        actualAvailableKrwOverride !== null && actualAvailableKrwOverride !== undefined
          ? Number(actualAvailableKrwOverride)
          : preloadedAccountInfo?.success && preloadedAccountInfo.orderable_krw !== null && preloadedAccountInfo.orderable_krw !== undefined
          ? Number(preloadedAccountInfo.orderable_krw)
          : null;

      applyRes = await withDbWriteLock(async () => {
        const allBots = await getBots("live");
        const currentLiveBots = allBots.filter((b) => Number(b.is_selected_for_live) === 1);
        const previousBotsSnapshot = currentLiveBots.map((b) => ({
          bot_id: b.bot_id,
          nickname: b.nickname,
          name: b.name,
          ...getBotStrategyMeta(b.bot_id),
          allocation_ratio: Number(b.allocation_ratio || 0),
          allocated_capital: Math.floor(Number(b.allocated_capital || 0)),
          virtual_krw: Math.floor(Number(b.virtual_krw || 0)),
          used_capital: Math.floor(Number(b.used_capital || 0)),
          open_positions_count: (b.open_positions || []).length,
          is_running: Number(b.is_running || 0),
        }));

        const hadAnyPreviousLive = currentLiveBots.length > 0;
        const wasAnyPreviousRunning = currentLiveBots.some((b) => Number(b.is_running) === 1);
        const nextRunningFlag =
          triggerType === "SCHEDULED_WEEKLY" && hadAnyPreviousLive ? (wasAnyPreviousRunning ? 1 : 0) : 1;

        const botsInput = allBots.map((b) => ({
          bot_id: b.bot_id,
          strategy_group: b.strategy_group_code || b.strategy_group || getBotStrategyMeta(b.bot_id).strategy_group_code,
          is_selected_for_live: Number(b.is_selected_for_live || 0),
          open_locked_krw: Math.max(0, Math.floor(Number(b.used_capital || 0))),
          replaced_by_bot_id: b.replaced_by_bot_id || null,
        }));

        const calc = computeRotationAllocationsWith90Cap({
          totalEquityKrw: principalKrw,
          allBots: botsInput,
          electedBots: evaluation.champions,
          actualAvailableKrw: actualAvailKrw,
          maxDeployRatio: config.max_deploy_ratio,
        });

        const electedMap = new Map(calc.electedAllocations.map((e) => [e.bot_id, e]));
        const drainingMap = new Map(calc.drainingAssignments.map((d) => [d.bot_id, d]));

        const reclaimedFromDroppedKrw = allBots
          .filter((b) => !electedMap.has(b.bot_id))
          .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);

        try {
          await beginWriteTx(db);

          for (const b of allBots) {
            if (electedMap.has(b.bot_id)) {
              const ea = electedMap.get(b.bot_id);
              const ratioPct =
                calc.electedAllocations.length === 1
                  ? 100
                  : calc.electedAllocations.length === 2
                  ? 50
                  : Number((100 / calc.electedAllocations.length).toFixed(2));
              const wasLive = Number(b.is_selected_for_live || 0) === 1;
              const openCnt = (b.open_positions || []).length;
              const nextAllocCap = ea.own_locked_krw + ea.virtual_krw;
              let nextMsg = b.last_status_msg || "신규 실전 배정 완료 · 진입 시그널 대기 중";
              if (ea.funding_status === "WAITING_CAPITAL_RESTORE") {
                nextMsg = `[⏳ 자금 복원 대기 중] 가용 ${ea.virtual_krw.toLocaleString("ko-KR")}원 (< 5,050원) · 기존 탈락 봇 청산 시 자동 복원 및 매수 개시`;
              } else if (!wasLive && openCnt > 0) {
                nextMsg = `[🔄 실전 복귀] 기존 포지션 ${openCnt}건 유지 및 정상 가동 (목표 ${ea.target_capital_krw.toLocaleString("ko-KR")}원)`;
              } else if (!wasLive && ea.linked_drain_locked_krw > 0) {
                nextMsg = `[신규 실전 배정] 목표 ${ea.target_capital_krw.toLocaleString("ko-KR")}원 중 가용 ${ea.virtual_krw.toLocaleString("ko-KR")}원 (기존 봇 매도 시 +${ea.linked_drain_locked_krw.toLocaleString("ko-KR")}원 복원 예정)`;
              } else if (!wasLive) {
                nextMsg = `신규 실전 배정 완료 (목표 한도 ${ea.target_capital_krw.toLocaleString("ko-KR")}원 · 진입 시그널 대기 중)`;
              }
              await db
                .prepare(
                  `UPDATE bots
                   SET is_selected_for_live = 1, is_running = ?, allocation_ratio = ?,
                       target_capital_krw = ?, allocated_capital = ?, virtual_krw = ?,
                       drain_status = 'NONE', replaced_by_bot_id = NULL, drain_started_at = NULL,
                       last_status_msg = ?, updated_at = ?
                   WHERE bot_id = ?`
                )
                .run(nextRunningFlag, ratioPct, ea.target_capital_krw, nextAllocCap, ea.virtual_krw, nextMsg, nowStr, b.bot_id);
            } else if (drainingMap.has(b.bot_id)) {
              const da = drainingMap.get(b.bot_id);
              const openCnt = (b.open_positions || []).length;
              const drainStarted = b.drain_started_at || nowStr;
              const statusMsg = `[🛡️ Graceful Drain] 실전 교체됨 · 미매도 포지션 ${openCnt}건(${da.open_locked_krw.toLocaleString("ko-KR")}원) 매도 감시${da.replaced_by_bot_id ? ` → 청산 시 ${da.replaced_by_bot_id} 자동 복원` : ""}`;
              await db
                .prepare(
                  `UPDATE bots
                   SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0,
                       target_capital_krw = 0, allocated_capital = ?, virtual_krw = 0,
                       drain_status = 'DRAINING', replaced_by_bot_id = ?, drain_started_at = ?,
                       last_status_msg = ?, updated_at = ?
                   WHERE bot_id = ?`
                )
                .run(da.open_locked_krw, da.replaced_by_bot_id, drainStarted, statusMsg, nowStr, b.bot_id);
            } else {
              const nextDrainStatus = b.drain_status === "DRAINING" ? "COMPLETED" : "NONE";
              await db
                .prepare(
                  `UPDATE bots
                   SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0,
                       target_capital_krw = 0, allocated_capital = 0, virtual_krw = 0,
                       drain_status = ?, replaced_by_bot_id = NULL, drain_started_at = NULL,
                       last_status_msg = '실전 미선택 대기 중', updated_at = ?
                   WHERE bot_id = ?`
                )
                .run(nextDrainStatus, nowStr, b.bot_id);
            }
          }

          // 커밋 전 최종 DB 상태 90% 불변식 검증
          const verifyBots = await db.prepare("SELECT bot_id, virtual_krw FROM bots").all();
          const verifyOpenRow = await db.prepare("SELECT COALESCE(SUM(buy_amount), 0) AS total_locked FROM bot_positions WHERE status = 'OPEN'").get();
          const verifyCash = verifyBots.reduce((acc, row) => acc + Math.max(0, Math.floor(Number(row.virtual_krw || 0))), 0);
          const verifyTotalUsed = Math.max(0, Math.floor(Number(verifyOpenRow?.total_locked || 0))) + verifyCash;
          assertGlobal90CapInvariant({
            principalKrw,
            totalUsedCapital: verifyTotalUsed,
            maxDeployRatio: config.max_deploy_ratio,
            context: "executeWeeklyBotRotation:DB_COMMIT",
          });

          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('last_synced_total_equity_krw', ?, ?)").run(String(principalKrw), nowStr);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('deployable_capital_cap_krw', ?, ?)").run(String(calc.globalCapKrw), nowStr);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(String(calc.globalCapKrw), nowStr);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_basis_mode', 'LIVE_TOTAL_EQUITY_90CAP', ?)").run(nowStr);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(nowStr);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)").run(nowStr);
          await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)").run(nowStr);
          await syncBotAccountsFromBots(db);
          await commitWriteTx(db);
        } catch (txErr) {
          await rollbackWriteTx(db);
          throw txErr;
        }

        const drainingPositionsCount = calc.drainingAssignments.reduce(
          (acc, d) => acc + ((allBots.find((x) => x.bot_id === d.bot_id)?.open_positions || []).length),
          0
        );
        return {
          success: true,
          principal_krw: principalKrw,
          global_cap_krw: calc.globalCapKrw,
          per_bot_target_krw: calc.perBotTargetKrw,
          total_capital: principalKrw,
          total_used_capital: calc.totalUsedCapital,
          reserved_cash_krw: calc.reservedCashKrw,
          utilization_pct: principalKrw > 0 ? Number(((calc.totalUsedCapital / principalKrw) * 100).toFixed(2)) : 0,
          reclaimed_virtual_krw: reclaimedFromDroppedKrw,
          total_transferable_krw: calc.totalAllocatedCash,
          actual_distributed_virtual_krw: calc.totalAllocatedCash,
          draining_positions_count: drainingPositionsCount,
          total_draining_locked_krw: calc.totalDrainingLocked,
          previous_bots: previousBotsSnapshot,
          elected_allocations: calc.electedAllocations,
          draining_assignments: calc.drainingAssignments,
        };
      });
    } else {
      const rankPriorityMap = Object.fromEntries(
        evaluation.champions.map((c) => [c.bot_id, Number(c.champion_rank || 999)])
      );
      const selected = evaluation.champions.map((c) => ({
        bot_id: c.bot_id,
        allocation_ratio: Number((Number(c.recommended_ratio || 0) / 100).toFixed(4)),
      }));

      applyRes = await applyLiveBotsSelection(selected, [], forcedCapital, {
        inheritRunningFromPrevious: triggerType === "SCHEDULED_WEEKLY",
        rankPriorityMap,
        skipLiveAccountSync,
      });
    }

    const electedSummaryItems = evaluation.champions.map((c) => ({
      bot_id: c.bot_id,
      nickname: c.nickname,
      name: c.name,
      strategy_group_code: c.strategy_group_code,
      strategy_group: c.strategy_group,
      strategy_group_label: c.strategy_group_label,
      champion_rank: c.champion_rank,
      allocation_ratio_pct: c.recommended_ratio,
      target_capital_krw: c.target_capital_krw || applyRes.per_bot_target_krw || 0,
      weekly_return_pct: c.weekly_return_pct,
      profit_rate_pct: c.profit_rate_pct,
      mdd_pct: c.mdd_pct,
      win_rate_pct: c.eval_win_rate_pct,
      weekly_trade_count: c.weekly_trade_count,
      rotation_score: c.rotation_score,
      evaluation_basis: c.evaluation_basis,
    }));

    const immediateTransferredKrw = Math.floor(
      Number(applyRes.total_transferable_krw ?? applyRes.reclaimed_virtual_krw ?? 0)
    );
    const champText = electedSummaryItems
      .map(
        (c) =>
          `[${c.strategy_group}] ${c.nickname}(${c.allocation_ratio_pct}%, 점수 ${c.rotation_score >= 0 ? "+" : ""}${c.rotation_score})`
      )
      .join(" · ");
    const capMetaText =
      config.allocation_mode === "EQUAL_BY_CAPITAL_TIER"
        ? ` | 원금 ${principalKrw.toLocaleString("ko-KR")}원 → ${electedSummaryItems.length}봇 균등(목표 ${Number(applyRes.per_bot_target_krw || 0).toLocaleString("ko-KR")}원) · 90% 상한(${Number(applyRes.global_cap_krw || 0).toLocaleString("ko-KR")}원) 중 ${Number(applyRes.utilization_pct || 0)}% 사용 · Draining 차감 ${Number(applyRes.total_draining_locked_krw || 0).toLocaleString("ko-KR")}원`
        : "";
    const summaryText = `${triggerType === "SCHEDULED_WEEKLY" ? "주간 자동" : "수동 즉시"} 로테이션 (${config.allocation_mode}): ${champText}${capMetaText}${evaluation.selection_reason ? ` | ${evaluation.selection_reason}` : ""} | 보호 포지션 ${applyRes.draining_positions_count}건 · 가용 원화 풀 ${immediateTransferredKrw.toLocaleString("ko-KR")}원(탈락 회수 ${Number(applyRes.reclaimed_virtual_krw || 0).toLocaleString("ko-KR")}원) 이관`;

    await db
      .prepare(
        `INSERT INTO auto_rotation_history (
           trigger_type, previous_bots_json, elected_bots_json,
           draining_positions_count, transferred_krw, summary_text, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        triggerType,
        JSON.stringify(applyRes.previous_bots || []),
        JSON.stringify(electedSummaryItems),
        Number(applyRes.draining_positions_count || 0),
        immediateTransferredKrw,
        summaryText,
        nowStr
      );

    await db
      .prepare(
        `UPDATE auto_rotation_config
         SET last_rotated_at = ?, next_rotation_at = ?, updated_at = ?
         WHERE id = 1`
      )
      .run(nowStr, nextRotStr, nowStr);

    console.log(`[Auto-Rotation] ${summaryText}`);
    dispatchMultiChannelNotification(
      db,
      {
        eventType: "WEEKLY_ROTATION",
        reason: summaryText,
      },
      { webPushBroadcastFn: broadcastWebPushNotification }
    ).catch(() => {});
    const status = await getRotationStatusPayload({ skipMarketFetch: skipLiveAccountSync });
    return {
      success: true,
      trigger_type: triggerType,
      summary_text: summaryText,
      elected_bots: electedSummaryItems,
      apply_result: applyRes,
      status,
    };
  } finally {
    isAutoRotationExecuting = false;
    isCapitalRebalancing = false;
  }
}

/**
 * [Antigravity-Doc] 탈락(Draining) 상태 봇의 미매도(OPEN) 포지션을 수동으로 즉시 시장가/지정가 청산하고
 * 회수된 원화를 후임 선출 봇 예산으로 자동 복원한다. (실전 담당 중인 활성 봇 포지션은 보호를 위해 거부)
 * @param {{positionId?:number|null, orderUuid?:string|null, botId?:string|null, reason?:string}} [params]
 * @returns {Promise<object>}
 */
export async function forceCloseDrainingPosition({
  positionId = null,
  orderUuid = null,
  botId = null,
  reason = "수동 즉시 청산 후 자금 복원",
} = {}) {
  const db = getDb();
  let pos = null;
  if (positionId) {
    pos = await db.prepare("SELECT * FROM bot_positions WHERE id = ? AND status = 'OPEN'").get(Number(positionId));
  } else if (orderUuid) {
    pos = await db.prepare("SELECT * FROM bot_positions WHERE order_uuid = ? AND status = 'OPEN'").get(String(orderUuid));
  } else if (botId) {
    pos = await db.prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id ASC LIMIT 1").get(normalizeBotId(botId));
  }
  if (!pos) {
    throw new Error("청산 가능한 미매도(OPEN) Draining 포지션을 찾을 수 없습니다.");
  }
  const botRow = await db.prepare("SELECT * FROM bots WHERE bot_id = ?").get(pos.bot_id);
  if (!botRow) {
    throw new Error(`봇(${pos.bot_id}) 정보를 찾을 수 없습니다.`);
  }
  if (Number(botRow.is_selected_for_live || 0) === 1) {
    throw new Error(`봇(${pos.bot_id})은 현재 실전 담당 중이며 Draining 상태가 아닙니다.`);
  }

  // 현재가 조회 (본인 volume 소수점 8자리 내림 정밀 지정 매도만 실행)
  const mkt = pos.market || pos.ticker;
  let curPrice = Number(pos.avg_buy_price || 0);
  try {
    const tkMap = await fetchUpbitTickersMap([mkt]);
    const tk = tkMap?.get(mkt);
    if (tk && Number(tk.trade_price) > 0) curPrice = Number(tk.trade_price);
  } catch {}
  const flooredVol = Math.floor(Number(pos.volume || 0) * 1e8) / 1e8;
  const targetPos = { ...pos, volume: flooredVol.toFixed(8) };

  const sold = await executeBotSellOrder(botRow, targetPos, curPrice, reason, {
    skipMarketFetch: process.env.AUTOCOIN_LIBRARY_MODE === "1",
  });
  if (!sold) {
    throw new Error(`[${botRow.nickname || botRow.bot_id}] ${mkt} 수동 청산 주문이 체결되지 않았습니다.`);
  }
  const status = await getRotationStatusPayload({ skipMarketFetch: process.env.AUTOCOIN_LIBRARY_MODE === "1" });
  return {
    success: true,
    bot_id: botRow.bot_id,
    market: mkt,
    position_id: pos.id,
    message: `[${botRow.nickname || botRow.bot_id}] ${mkt} 수동 청산 및 후임 봇 자금 자동 복원이 완료되었습니다.`,
    status,
  };
}

/**
 * [Antigravity-Doc] 매 분 주기 스케줄러가 호출하며, 설정된 요일/KST 시각 도달 및 당일 미실행 조건 충족 시
 * `executeWeeklyBotRotation({ triggerType: "SCHEDULED_WEEKLY" })`를 자동 트리거한다.
 * @returns {Promise<void>}
 */
async function checkAndRunScheduledAutoRotation() {
  if (isAutoRotationExecuting) return;
  try {
    const db = getDb();
    const config = await getAutoRotationConfig(db);
    if (Number(config.is_enabled) !== 1) return;

    const kst = getKstCalendarParts(new Date());
    if (kst.dayOfWeek !== Number(config.rotation_day_of_week)) return;
    if (kst.hour < Number(config.rotation_hour_kst)) return;

    const lastRotated = String(config.last_rotated_at || "");
    if (lastRotated && lastRotated.slice(0, 10) === kst.dateStr) {
      const lastHour = Number(lastRotated.slice(11, 13));
      if (!Number.isNaN(lastHour) && lastHour >= Number(config.rotation_hour_kst)) {
        return;
      }
    }

    console.log(
      `[Auto-Rotation Scheduler] KST ${kst.timestampStr} 예약 시점 도래 (요일=${config.rotation_day_of_week}, 시=${config.rotation_hour_kst}) -> 주간 전략별 1위 봇 자동 선출 실행`
    );
    await executeWeeklyBotRotation({ triggerType: "SCHEDULED_WEEKLY" });
  } catch (err) {
    console.warn("[Auto-Rotation Scheduler] 스케줄러 오류:", err.message);
  }
}

// [Antigravity-Doc] 백그라운드 워커 기동 함수 참조, 기동 여부 플래그 및 종료 시 정리할 타이머 핸들 목록
let startBackgroundWorkers = null;
let workersStarted = false;
let workerTimers = [];

// [Antigravity-Doc] 정적 파일 서빙용 MIME 타입 매핑 및 프론트엔드 빌드 산출물 디렉터리(`frontend/dist`)
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const DIST_DIR = path.join(BASE_DIR, "frontend", "dist");

/**
 * [Antigravity-Doc] `frontend/dist` 정적 에셋 및 React SPA 폴백(`index.html`)을 서빙한다.
 * Path Traversal 방어를 위해 `filePath.startsWith(DIST_DIR)`을 검증한다.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 * @returns {boolean} 응답 처리 완료 여부
 */
function serveStatic(req, res, pathname) {
  if (!fs.existsSync(DIST_DIR)) return false;
  let target = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  let filePath = path.join(DIST_DIR, target);

  // Security: prevent path traversal
  if (!filePath.startsWith(DIST_DIR)) return false;

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      ...(res.__corsHeaders || {}),
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // SPA fallback for non-API GET requests
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    const indexPath = path.join(DIST_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...(res.__corsHeaders || {}),
      });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
  }

  return false;
}

/**
 * [Antigravity-Doc] 메인 HTTP 서버 및 전체 REST/SSE API 라우터.
 * 라우팅 순서:
 *  1. CORS 프리플라이트(`OPTIONS`) 처리
 *  2. 공개 허용 엔드포인트: `/api/version`, `/api/auth/*`, `/api/setup/status`
 *  3. 전역 인증 미들웨어: `/api/*` 요청은 세션 쿠키 검증 필수 (단, 미설정 초기 온보딩 시 `/api/setup/*` 예외 허용)
 *  4. 인증 보호 API: 셋업/계좌/가드레일/봇/AI·SSE/로테이션/WebPush/거래내역/통계/아레나/설정/백테스트/알림/AlgoLab
 *  5. 정적 파일 및 SPA 폴백(`serveStatic`)
 */
const server = http.createServer(async (req, res) => {
  res.__corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...(res.__corsHeaders || {}),
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;
  const db = getDb();

  try {
    // ============================================================
    // [시스템 버전 API - 헬스체크 공개 허용]
    // ============================================================
    if (pathname === "/api/version" && req.method === "GET") {
      const historyPath = path.join(BASE_DIR, "history.md");
      const hasHistory = fs.existsSync(historyPath);
      return sendJson(res, 200, {
        ok: true,
        version: APP_VERSION,
        name: "auto-coin-trade",
        history_available: hasHistory,
      });
    }

    if (pathname === "/api/version/history" && req.method === "GET") {
      const historyPath = path.join(BASE_DIR, "history.md");
      if (!fs.existsSync(historyPath)) {
        return sendJson(res, 404, { ok: false, error: "history.md 파일이 존재하지 않습니다." });
      }
      try {
        const historyText = fs.readFileSync(historyPath, "utf-8");
        return sendJson(res, 200, {
          ok: true,
          version: APP_VERSION,
          history: historyText,
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `히스토리 읽기 실패: ${err.message}` });
      }
    }

    // ============================================================
    // [인증 상태 조회 / 로그아웃 / 로그인 검증]
    // ============================================================
    if (pathname === "/api/auth/session" && req.method === "GET") {
      const authed = await isRequestAuthenticated(req);
      return sendJson(res, 200, {
        ok: true,
        authenticated: authed,
        kst_date: todayDateString(),
      });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      return sendJson(
        res,
        200,
        { ok: true, authenticated: false, message: "로그아웃되었습니다." },
        { "Set-Cookie": buildSessionCookieHeader(req, "", 0) }
      );
    }

    if (pathname === "/api/auth/verify" && req.method === "POST") {
      const clientIp = getClientIpForAuth(req);
      const rateLimit = checkAuthRateLimit(clientIp);
      if (rateLimit.blocked) {
        const waitMin = Math.ceil(rateLimit.retryAfterSec / 60);
        return sendJson(
          res,
          429,
          {
            authenticated: false,
            message: `로그인 시도 횟수(${AUTH_RATE_LIMIT_MAX_ATTEMPTS}회)를 초과하여 일시 차단되었습니다. 약 ${waitMin}분 후 다시 시도해주세요.`,
            retry_after_sec: rateLimit.retryAfterSec,
          },
          { "Retry-After": String(rateLimit.retryAfterSec) }
        );
      }

      const body = await readJsonBody(req);
      const expected = await getEffectiveEntryCode();
      const rawInputCode = String(body.code || "").trim();
      // 기본 입장 코드('stock') 사용 중일 때만 한글 두벌식 오타('ㄴ새차') 편의 변환 지원 (사용자 지정 코드 설정 시 백도어 차단)
      const normalizedInputCode =
        expected.toLowerCase() === "stock" && rawInputCode === "ㄴ새차"
          ? expected
          : expected.toLowerCase() === "stock" && rawInputCode.toLowerCase() === "stock"
          ? expected
          : rawInputCode;
      if (normalizedInputCode && timingSafeEqualText(normalizedInputCode, expected)) {
        authFailedAttemptsByIp.delete(clientIp);
        const token = createSignedSessionToken(expected);
        return sendJson(
          res,
          200,
          { authenticated: true, message: "인증 성공", kst_date: todayDateString() },
          { "Set-Cookie": buildSessionCookieHeader(req, token, 86400) }
        );
      }

      const failRec = recordAuthFailure(clientIp);
      const remaining = Math.max(0, AUTH_RATE_LIMIT_MAX_ATTEMPTS - failRec.count);
      const failMsg =
        remaining > 0
          ? `입장 코드가 일치하지 않습니다. (남은 시도 ${remaining}회)`
          : `입장 코드 오류 누적(${AUTH_RATE_LIMIT_MAX_ATTEMPTS}회)으로 15분간 접속이 제한됩니다.`;
      return sendJson(res, 401, { authenticated: false, message: failMsg });
    }

    // ============================================================
    // [설치 마법사 상태 조회 - 미설정 여부 확인용]
    // ============================================================
    if (pathname === "/api/setup/status" && req.method === "GET") {
      const configured = checkSetupCompleted();
      const authed = await isRequestAuthenticated(req);
      if (configured && !authed) {
        return sendJson(res, 200, {
          ok: true,
          version: APP_VERSION,
          is_configured: true,
          current_env: null,
        });
      }
      let cfg = {};
      if (fs.existsSync(CONFIG_PATH)) {
        try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch {}
      }
      const dbMode = (process.env.DB_MODE || "sqlite").trim().toLowerCase();
      const isOuter = (process.env.LOCATION || "local").trim().toLowerCase() === "outer";
      let entryCodeConfigured = false;
      try {
        const row = await db.prepare("SELECT value FROM system_settings WHERE key = 'entry_code'").get();
        if (row?.value) entryCodeConfigured = true;
      } catch {}

      return sendJson(res, 200, {
        ok: true,
        version: APP_VERSION,
        is_configured: configured,
        current_env: {
          db_mode: dbMode,
          pg_sync_enabled: process.env.PG_SYNC_ENABLED !== "false",
          trade_mode: isLiveMode() ? "live" : "paper",
          entry_code_configured: entryCodeConfigured,
          upbit_configured: !!(cfg.access_key && cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY"),
          gemini_configured: !!(cfg.gemini_api_key && cfg.gemini_api_key !== "YOUR_GEMINI_API_KEY_HERE"),
          initial_capital: Number(process.env.INITIAL_TOTAL_CAPITAL || 10000000),
          db_config: {
            host: isOuter ? (process.env.OUTER_PG_HOST || process.env.PGHOST || "127.0.0.1") : (process.env.LOCAL_PG_HOST || process.env.PGHOST || "127.0.0.1"),
            port: Number(isOuter ? (process.env.OUTER_PG_PORT || process.env.PGPORT || 5432) : (process.env.LOCAL_PG_PORT || process.env.PGPORT || 5432)),
            database: isOuter ? (process.env.OUTER_PG_DATABASE || process.env.PGDATABASE || "coin_trader") : (process.env.LOCAL_PG_DATABASE || process.env.PGDATABASE || "coin_trader"),
            user: isOuter ? (process.env.OUTER_PG_USER || process.env.PGUSER || "coin_trader") : (process.env.LOCAL_PG_USER || process.env.PGUSER || "coin_trader"),
          }
        }
      });
    }

    // ============================================================
    // [전역 백엔드 API 인증 게이트]
    // 초기 온보딩(/api/setup/test-*, /api/setup/complete)은 미설정(!isConfigured) 상태에서만 무인증 허용
    // ============================================================
    if (pathname.startsWith("/api/")) {
      const authed = await isRequestAuthenticated(req);
      const isOnboardingMutation =
        pathname === "/api/setup/test-db" ||
        pathname === "/api/setup/test-keys" ||
        pathname === "/api/setup/complete";
      const allowOnboardingUnauth = isOnboardingMutation && !isConfigured;
      if (!authed && !allowOnboardingUnauth) {
        return sendJson(res, 401, {
          ok: false,
          authenticated: false,
          error: "인증이 필요합니다. 입장 코드를 입력해주세요.",
        });
      }
    }

    // ============================================================
    // [설치 마법사 실행 API]
    // ============================================================
    // [Antigravity-Doc] POST /api/setup/test-db — PostgreSQL 연결 테스트 (DB 미존재 3D000 오류 시 자동 CREATE DATABASE 시도)
    if (pathname === "/api/setup/test-db" && req.method === "POST") {
      const body = await readJsonBody(req);
      const host = String(body.host || "127.0.0.1").trim();
      const port = Number(body.port || 5432);
      const database = String(body.database || "coin_trader").trim();
      const user = String(body.user || "coin_trader").trim();
      const password = String(body.password || "");

      const startMs = Date.now();
      const client = new pg.Client({
        host,
        port,
        database,
        user,
        password,
        connectionTimeoutMillis: 5000,
      });

      try {
        await client.connect();
        const result = await client.query("SELECT NOW() as now, version() as version;");
        const latencyMs = Date.now() - startMs;
        await client.end();
        return sendJson(res, 200, {
          ok: true,
          latency_ms: latencyMs,
          message: `PostgreSQL 서버 연결 성공 (${latencyMs}ms)`,
          server_time: result.rows[0]?.now,
        });
      } catch (err) {
        try { await client.end(); } catch {}

        if (err.code === "3D000") {
          try {
            const rootClient = new pg.Client({
              host,
              port,
              database: "postgres",
              user,
              password,
              connectionTimeoutMillis: 5000,
            });
            try {
              await rootClient.connect();
              if (/^[a-zA-Z0-9_]+$/.test(database)) {
                await rootClient.query(`CREATE DATABASE ${database};`);
                const latencyMs = Date.now() - startMs;
                return sendJson(res, 200, {
                  ok: true,
                  latency_ms: latencyMs,
                  message: `데이터베이스 '${database}' 자동 생성 및 연결 성공! (${latencyMs}ms)`,
                });
              }
            } finally {
              try { await rootClient.end(); } catch {}
            }
          } catch (createErr) {
            return sendJson(res, 200, {
              ok: false,
              error: `데이터베이스 '${database}'가 존재하지 않으며 자동 생성에 실패했습니다: ${createErr.message}`,
            });
          }
        }

        return sendJson(res, 200, {
          ok: false,
          error: `DB 연결 실패: ${err.message}`,
        });
      }
    }

    // [Antigravity-Doc] POST /api/setup/test-keys — 업비트 Open API(/v1/accounts) 및 Google Gemini API 키 유효성 검증
    if (pathname === "/api/setup/test-keys" && req.method === "POST") {
      const body = await readJsonBody(req);
      const upbitAccess = String(body.upbit_access_key || "").trim();
      const upbitSecret = String(body.upbit_secret_key || "").trim();
      const geminiKey = String(body.gemini_api_key || "").trim();
      const skipUpbit = !!body.skip_upbit;

      let upbitResult = { ok: true, skipped: true, message: "업비트 연동 건너뜀 (가상거래 모드)" };
      if (!skipUpbit && upbitAccess && upbitSecret) {
        try {
          const token = createUpbitJwt(upbitAccess, upbitSecret);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const resp = await fetch("https://api.upbit.com/v1/accounts", {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (resp.status === 200) {
            const accounts = await resp.json();
            upbitResult = {
              ok: true,
              message: `업비트 API 연동 성공 (보유 자산 항목: ${Array.isArray(accounts) ? accounts.length : 0}개)`,
            };
          } else {
            const errJson = await resp.json().catch(() => ({}));
            upbitResult = {
              ok: false,
              error: errJson.error?.message || `HTTP ${resp.status} 인증 실패 (IP 허용 목록 또는 키를 확인하세요)`,
            };
          }
        } catch (err) {
          upbitResult = { ok: false, error: `업비트 연결 오류: ${err.message}` };
        }
      } else if (!skipUpbit && (!upbitAccess || !upbitSecret)) {
        upbitResult = { ok: false, error: "업비트 Access Key와 Secret Key를 모두 입력해주세요." };
      }

      let geminiResult = { ok: true, skipped: true, message: "Gemini API 키 미입력 (기본 모드)" };
      if (geminiKey) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}`, {
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (resp.status === 200) {
            geminiResult = { ok: true, message: "Google Gemini API 키 연동 성공 (AI 시황/뉴스 분석 가동)" };
          } else {
            const errJson = await resp.json().catch(() => ({}));
            geminiResult = {
              ok: false,
              error: errJson.error?.message || `HTTP ${resp.status} API 키가 유효하지 않습니다.`,
            };
          }
        } catch (err) {
          geminiResult = { ok: false, error: `Gemini API 연결 오류: ${err.message}` };
        }
      }

      const overallOk = upbitResult.ok && geminiResult.ok;
      return sendJson(res, 200, {
        ok: overallOk,
        upbit: upbitResult,
        gemini: geminiResult,
      });
    }

    // [Antigravity-Doc] POST /api/setup/complete — 초기 설치 마법사 최종 완료:
    // config/upbit_config.json 암호화 저장 -> .env 기록(0600) -> DB 스키마 초기화·시드 -> PG 동기화 연결 -> 워커 핫스타트 -> 세션 쿠키 발급
    if (pathname === "/api/setup/complete" && req.method === "POST") {
      const body = await readJsonBody(req);
      const entryCode = String(body.entry_code || "stock").trim();
      const tradeMode = body.trade_mode === "live" ? "live" : "paper";
      const initialCapital = Math.max(100000, Number(body.initial_capital || 10000000));
      const dbType = body.db_type === "server" ? "server" : "sqlite";
      const dbConfig = body.db_config || {};
      const upbitAccess = String(body.upbit_access_key || "").trim();
      const upbitSecret = String(body.upbit_secret_key || "").trim();
      const geminiKey = String(body.gemini_api_key || "").trim();
      const skipUpbit = !!body.skip_upbit;

      // 1. config/upbit_config.json 저장 (AES-256-GCM 암호화 볼트 적용)
      let existingConfig = {};
      if (fs.existsSync(CONFIG_PATH)) {
        try { existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch {}
      }
      saveRuntimeConfig({
        ...existingConfig,
        access_key: skipUpbit ? "" : upbitAccess,
        secret_key: skipUpbit ? "" : upbitSecret,
        trade_mode: tradeMode,
        request_timeout_sec: 5.0,
        delay_threshold_ms: 800,
        gemini_api_key: geminiKey,
        use_local_ollama_news: existingConfig.use_local_ollama_news ?? true,
        ollama_base_url: existingConfig.ollama_base_url || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
        ollama_news_model: existingConfig.ollama_news_model || process.env.OLLAMA_NEWS_MODEL || DEFAULT_OLLAMA_NEWS_MODEL,
        ollama_timeout_ms: Number(existingConfig.ollama_timeout_ms || process.env.OLLAMA_TIMEOUT_MS || DEFAULT_OLLAMA_TIMEOUT_MS),
        setup_completed: true,
      });

      // 2. .env 파일 생성/갱신
      let envLines = [];
      if (fs.existsSync(ENV_PATH)) {
        const rawEnv = fs.readFileSync(ENV_PATH, "utf-8");
        envLines = rawEnv.split(/\r?\n/);
      }
      const envMap = new Map();
      for (const line of envLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          envMap.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
        }
      }

      envMap.set("SETUP_COMPLETED", "true");
      envMap.set("DRY_RUN", tradeMode === "paper" ? "True" : "False");
      envMap.set("INITIAL_TOTAL_CAPITAL", String(initialCapital));
      if (!skipUpbit && upbitAccess) envMap.set("UPBIT_ACCESS_KEY", upbitAccess);
      if (!skipUpbit && upbitSecret) envMap.set("UPBIT_SECRET_KEY", upbitSecret);
      if (geminiKey) envMap.set("GEMINI_API_KEY", geminiKey);

      if (dbType === "sqlite") {
        envMap.set("DB_MODE", "sqlite");
        envMap.set("PG_SYNC_ENABLED", "false");
        envMap.set("DB_PATH", "data/auto_coin_trade.db");
      } else {
        envMap.set("DB_MODE", "postgres_hybrid");
        envMap.set("PG_SYNC_ENABLED", "true");
        const host = String(dbConfig.host || "127.0.0.1").trim();
        const port = String(dbConfig.port || "5432").trim();
        const database = String(dbConfig.database || "coin_trader").trim();
        const user = String(dbConfig.user || "coin_trader").trim();
        const password = String(dbConfig.password || "").trim();
        const isLocal = host === "127.0.0.1" || host === "localhost";
        envMap.set("LOCATION", isLocal ? "local" : "outer");
        envMap.set("PGHOST", host);
        envMap.set("PGPORT", port);
        envMap.set("PGDATABASE", database);
        envMap.set("PGUSER", user);
        envMap.set("PGPASSWORD", password);
        envMap.set(isLocal ? "LOCAL_PG_HOST" : "OUTER_PG_HOST", host);
        envMap.set(isLocal ? "LOCAL_PG_PORT" : "OUTER_PG_PORT", port);
        envMap.set(isLocal ? "LOCAL_PG_DATABASE" : "OUTER_PG_DATABASE", database);
        envMap.set(isLocal ? "LOCAL_PG_USER" : "OUTER_PG_USER", user);
        envMap.set(isLocal ? "LOCAL_PG_PASSWORD" : "OUTER_PG_PASSWORD", password);
        envMap.set("DATABASE_URL", `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`);
      }

      // in-memory process.env 동기화
      for (const [k, v] of envMap.entries()) {
        process.env[k] = v;
      }

      // .env 파일 기록
      let newEnvContent = "";
      for (const [k, v] of envMap.entries()) {
        newEnvContent += `${k}=${v}\n`;
      }
      fs.writeFileSync(ENV_PATH, newEnvContent, { encoding: "utf-8", mode: 0o600 });
      fs.chmodSync(ENV_PATH, 0o600);

      // 3. DB 초기화 분기 실행
      const targetDb = getDb();
      await initializeDatabase();
      await ensureArenaSchema(targetDb);
      await seedArenaBots(targetDb);

      // 기본 설정 저장 (entry_code 변경 시 구 gate_code 잔존 충돌 방지)
      const now = nowKSTString();
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('entry_code', ?, ?)").run(entryCode, now);
      await targetDb.prepare("DELETE FROM system_settings WHERE key = 'gate_code'").run();
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('trade_mode', ?, ?)").run(tradeMode, now);
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(String(initialCapital), now);
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(now);
      if (geminiKey) {
        await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)").run(encryptSecret(geminiKey), now);
      }
      if (initialCapital > 0) {
        try {
          await recalculateAndApplyBotAllocations(Math.floor(initialCapital), null, "live");
        } catch (allocErr) {
          console.warn("[SetupComplete] Initial allocation warning:", allocErr.message);
        }
      }

      // 만약 DB 서버 연동 모드이면 pgSyncManager 연결 시도
      if (dbType === "server") {
        try {
          await pgSyncManager.connect();
        } catch (e) {
          console.warn("[PgSync] Setup complete connect warn:", e.message);
        }
      }

      // 4. 백그라운드 워커 핫 스타트
      isConfigured = true;
      if (typeof startBackgroundWorkers === "function") {
        await startBackgroundWorkers();
      }

      const setupToken = createSignedSessionToken(entryCode);
      return sendJson(
        res,
        200,
        {
          ok: true,
          message: "초기 환경 설정 및 데이터베이스 자동 설치가 성공적으로 완료되었습니다.",
        },
        { "Set-Cookie": buildSessionCookieHeader(req, setupToken, 86400) }
      );
    }

    // [Antigravity-Doc] GET /api/upbit/status, /api/health, /api/upbit/account, /api/upbit/orders —
    // 업비트 API·WebSocket·Ollama 헬스체크, 실계좌 잔고 조회(+동적 자본 동기화) 및 최근 체결 주문 조회
    if (pathname === "/api/upbit/status" && req.method === "GET") {
      const [status, ollama] = await Promise.all([checkUpbitStatus(), checkOllamaStatus()]);
      return sendJson(res, 200, { ...status, ollama });
    }

    if (pathname === "/api/health" && req.method === "GET") {
      const [status, ollama] = await Promise.all([checkUpbitStatus(), checkOllamaStatus({ forceRefresh: parsedUrl.searchParams.get("refresh") === "1" })]);
      return sendJson(res, 200, {
        ok: true,
        status: "ok",
        version: APP_VERSION,
        upbit: status,
        ollama,
      });
    }

    if (pathname === "/api/upbit/account" && req.method === "GET") {
      const accountInfo = await fetchUpbitAccountBalance();
      if (accountInfo?.success) {
        await syncDynamicLiveCapitalFromUpbit(false, accountInfo);
      }
      return sendJson(res, 200, accountInfo);
    }

    if (pathname === "/api/upbit/orders" && req.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 20)));
      const ordersInfo = await fetchUpbitRecentOrders(limit);
      return sendJson(res, 200, ordersInfo);
    }

    // [Antigravity-Doc] GET /api/system/overview — 대시보드 메인 통합 현황(자본, 봇, AI 장세 필터, Ollama, WebSocket, 가드레일 상태)
    if (pathname === "/api/system/overview" && req.method === "GET") {
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      if (mode === "live") {
        await syncDynamicLiveCapitalFromUpbit();
      }
      if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
        try {
          const posTable = getPositionsTableName(mode);
          const openMktRows = await db.prepare(`SELECT DISTINCT market FROM ${posTable} WHERE status = 'OPEN'`).all();
          const openMkts = openMktRows.map((r) => r.market).filter(Boolean);
          if (openMkts.length > 0) await fetchUpbitTickersMap(openMkts);
        } catch {}
      }
      const haltInfo = await checkAndHaltIfZeroBalance(mode);
      let regimeFilterRow = null;
      try {
        const rawRegime = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
        regimeFilterRow = enrichRegimeFilterRow(rawRegime, await loadDualAiModelMeta(db));
      } catch {}
      const ollama = await checkOllamaStatus();
      const wsStatus = upbitWsHub.getWsHealth();
      const guardrail = await getLiveGuardrailStatusPayload();
      return sendJson(res, 200, {
        mode,
        total_capital: Math.floor(Number(await getSetting("total_capital", "0"))),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
        stats_start_date: await getSetting("stats_start_date", "2026-10-01"),
        bots: await getBots(mode),
        regime_filter: regimeFilterRow,
        ollama,
        ws_status: wsStatus,
        guardrail,
      });
    }

    // [Antigravity-Doc] GET /api/guardrail/status & POST /api/guardrail/reset-emergency —
    // 실전 주문 가드레일(리스/Kill-Switch/주문 속도 제한) 현황 조회 및 비상 정지 상태 수동 해제
    if (pathname === "/api/guardrail/status" && req.method === "GET") {
      const status = await getLiveGuardrailStatusPayload();
      return sendJson(res, 200, status);
    }

    if (pathname === "/api/guardrail/reset-emergency" && req.method === "POST") {
      const result = await resetGuardrailEmergencyState(db, {
        withDbWriteLock,
        beginWriteTx,
        commitWriteTx,
        rollbackWriteTx,
      });
      const status = await getLiveGuardrailStatusPayload();
      return sendJson(res, 200, { ...result, guardrail: status });
    }

    // [Antigravity-Doc] GET /api/bots — 지정 모드(live|paper) 10대 봇 상태, 실시간 평가손익, 잔고 0원 중단 여부 및 가드레일 조회
    if (pathname === "/api/bots" && req.method === "GET") {
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
        try {
          const posTable = getPositionsTableName(mode);
          const openMktRows = await db.prepare(`SELECT DISTINCT market FROM ${posTable} WHERE status = 'OPEN'`).all();
          const openMkts = openMktRows.map((r) => r.market).filter(Boolean);
          if (openMkts.length > 0) await fetchUpbitTickersMap(openMkts);
        } catch {}
      }
      const haltInfo = await checkAndHaltIfZeroBalance(mode);
      let regimeFilterRow = null;
      try {
        const rawRegime = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
        regimeFilterRow = enrichRegimeFilterRow(rawRegime, await loadDualAiModelMeta(db));
      } catch {}
      return sendJson(res, 200, {
        mode,
        bots: await getBots(mode),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
        regime_filter: regimeFilterRow,
        guardrail: await getLiveGuardrailStatusPayload(),
      });
    }

    // [Antigravity-Doc] /api/ai/* — AI 시황·뉴스 브리핑 조회, Gemini 키/쿼터 관리, 단발 분석 및 SSE 스트리밍 분석 엔드포인트
    if (pathname === "/api/ai/briefing" && req.method === "GET") {
      const data = await getLatestAiBriefing();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/ai/quota" && req.method === "GET") {
      return sendJson(res, 200, {
        success: true,
        quota: await getGeminiQuotaStatus(),
      });
    }

    if (pathname === "/api/ai/save-key" && req.method === "POST") {
      const body = await readJsonBody(req);
      const key = (body?.gemini_api_key || "").trim();
      await saveGeminiApiKey(key);
      return sendJson(res, 200, {
        success: true,
        has_key: !!key,
        masked_key: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "",
        quota: await getGeminiQuotaStatus(),
      });
    }

    if (pathname === "/api/ai/analyze" && req.method === "POST") {
      const result = await generateAiMarketAnalysis({ triggerType: "MANUAL" });
      const statusCode = result.success ? 200 : result.error === "DAILY_QUOTA_EXCEEDED" ? 429 : 400;
      return sendJson(res, statusCode, result);
    }

    if (pathname === "/api/ai/stream-analyze" && (req.method === "POST" || req.method === "GET")) {
      return generateAiMarketAnalysisStream(req, res);
    }

    if (pathname === "/api/ai/news-briefing" && req.method === "GET") {
      const data = await getLatestAiNewsBriefing();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/ai/news-analyze" && req.method === "POST") {
      const result = await generateAiNewsAnalysis({ triggerType: "MANUAL" });
      const statusCode = result.success ? 200 : result.error === "DAILY_QUOTA_EXCEEDED" ? 429 : 400;
      return sendJson(res, statusCode, result);
    }

    if (pathname === "/api/ai/stream-news-analyze" && (req.method === "POST" || req.method === "GET")) {
      return generateAiNewsAnalysisStream(req, res);
    }

    // [AI 1주일 단위 실전 봇 1,2,3위 자동 평가 및 편성 API]
    if (pathname === "/api/ai/weekly-bot-selection" && req.method === "GET") {
      const data = await getLlmWeeklyBotSelectionStatus();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/ai/weekly-bot-selection/run" && req.method === "POST") {
      const result = await runLlmWeeklyBotSelection(true);
      return sendJson(res, result.success ? 200 : 500, result);
    }

    // [Antigravity-Doc] /api/rotation/* — 주간 전략군 챔피언 로테이션 현황 조회, 설정 변경, 즉시 실행 및 Draining 포지션 수동 청산
    // [주간 전략별(3대 그룹) 1위 봇 자동 로테이션 & Graceful Drain API]
    if (pathname === "/api/rotation/status" && req.method === "GET") {
      const data = await getRotationStatusPayload();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/rotation/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      await updateAutoRotationConfig(body || {});
      const data = await getRotationStatusPayload();
      return sendJson(res, 200, { ...data, message: "주간 전략별 자동 로테이션 설정이 저장되었습니다." });
    }

    if (pathname === "/api/rotation/execute-now" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const result = await executeWeeklyBotRotation({
          triggerType: "MANUAL_IMMEDIATE",
          forcedCapital: body?.forced_capital ? Number(body.forced_capital) : null,
        });
        return sendJson(res, result.success ? 200 : 400, result);
      } catch (err) {
        return sendJson(res, 400, { success: false, detail: err.message });
      }
    }

    if (pathname === "/api/rotation/force-drain-close" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const result = await forceCloseDrainingPosition({
          positionId: body?.position_id ? Number(body.position_id) : null,
          orderUuid: body?.order_uuid ? String(body.order_uuid) : null,
          botId: body?.bot_id ? String(body.bot_id) : null,
          reason: body?.reason ? String(body.reason) : "수동 즉시 청산 후 자금 복원",
        });
        return sendJson(res, result.success ? 200 : 400, result);
      } catch (err) {
        return sendJson(res, 400, { success: false, detail: err.message });
      }
    }

    // [Antigravity-Doc] /api/push/* 및 /sw.js — VAPID 공개키 조회, 브라우저 Web Push 구독 등록/해제, 테스트 푸시 발송 및 Service Worker 서빙
    if (pathname === "/api/push/vapid-public-key" && req.method === "GET") {
      return sendJson(res, 200, {
        success: true,
        publicKey: vapidPublicKey,
      });
    }

    if (pathname === "/api/push/status" && req.method === "GET") {
      const row = await db.prepare("SELECT COUNT(*) AS total FROM push_subscriptions").get();
      return sendJson(res, 200, {
        success: true,
        vapid_configured: !!vapidPublicKey,
        publicKey: vapidPublicKey,
        subscribers_count: Number(row?.total || 0),
      });
    }

    if (pathname === "/api/push/subscribe" && req.method === "POST") {
      const body = await readJsonBody(req);
      const sub = body.subscription || body;
      const endpoint = sub?.endpoint;
      const keys = sub?.keys;
      const p256dh = keys?.p256dh;
      const auth = keys?.auth;
      const userAgent = body.userAgent || req.headers["user-agent"] || "";

      if (!endpoint || !p256dh || !auth) {
        return sendJson(res, 400, {
          success: false,
          message: "올바르지 않은 푸시 구독 정보입니다 (endpoint, keys.p256dh, keys.auth 필수)",
        });
      }

      const nowStr = nowKSTString();
      await db.prepare(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          updated_at = EXCLUDED.updated_at
      `).run(endpoint, p256dh, auth, userAgent, nowStr, nowStr);

      console.log(`[WebPush] Subscription registered: ${endpoint.slice(0, 45)}...`);
      return sendJson(res, 200, {
        success: true,
        message: "웹푸시 알림 구독이 등록되었습니다.",
      });
    }

    if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
      const body = await readJsonBody(req);
      const endpoint = body.endpoint;
      if (endpoint) {
        await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
        console.log(`[WebPush] Subscription removed: ${endpoint.slice(0, 45)}...`);
      }
      return sendJson(res, 200, { success: true });
    }

    if (pathname === "/api/push/test" && req.method === "POST") {
      const testResult = await broadcastWebPushNotification({
        title: "AI 뉴스 분석 알림",
        body: "ai 분석이 완료되었습니다 (테스트 발송)",
        data: {
          url: "/?menu=news",
          is_test: true,
        },
      });
      return sendJson(res, 200, {
        success: true,
        message: "웹푸시 테스트 알림이 발송되었습니다.",
        broadcast: testResult,
      });
    }

    if (pathname === "/sw.js" && req.method === "GET") {
      const swPath = path.join(BASE_DIR, "frontend", "public", "sw.js");
      if (fs.existsSync(swPath)) {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Service-Worker-Allowed": "/",
          "Cache-Control": "no-cache",
        });
        return res.end(fs.readFileSync(swPath, "utf-8"));
      }
    }

    // [Antigravity-Doc] POST /api/bots/:botId/(start|stop), POST /manual-trade(드라이런 점검 전용), PUT /api/bots/:botId(봇 파라미터 수정)
    const startStopMatch = pathname.match(/^\/api\/bots\/([^/]+)\/(start|stop)$/);
    if (startStopMatch && req.method === "POST") {
      const botId = startStopMatch[1];
      const isStart = startStopMatch[2] === "start";
      if (isStart) {
        const targetBot = (await getBots()).find((b) => b.bot_id === botId);
        if (targetBot && Number(targetBot.is_selected_for_live || 0) !== 1) {
          return sendJson(res, 200, {
            success: false,
            bot: targetBot,
            message: `[${targetBot.nickname || targetBot.name}] 실제 거래 담당 봇으로 선택되지 않았습니다. 설정 화면에서 실전 봇(1~3개)으로 먼저 선택해주세요.`,
          });
        }
        if (!targetBot || Number(targetBot.allocated_capital || 0) <= 0) {
          return sendJson(res, 200, {
            success: false,
            bot: targetBot,
            message: `[${targetBot?.nickname || targetBot?.name || botId}] 할당 원금이 0원이므로 거래를 시작할 수 없습니다. 설정에서 원금 및 자금 분배 비율을 먼저 설정해주세요.`,
          });
        }
        const haltInfo = await checkAndHaltIfZeroBalance();
        if (haltInfo.halted) {
          return sendJson(res, 200, {
            success: false,
            bot: targetBot,
            message: haltInfo.reason,
          });
        }
      }
      const now = nowKSTString();
      const msg = isStart ? "자동매매 실행 중" : "사용자에 의해 거래 중지됨";
      await db.prepare("UPDATE bots SET is_running = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        isStart ? 1 : 0,
        msg,
        now,
        botId
      );
      const updated = (await getBots()).find((b) => b.bot_id === botId);
      return sendJson(res, 200, {
        success: true,
        bot: updated,
        message: `[${updated?.nickname || botId}] ${isStart ? "거래 시작" : "거래 중지"} 명령이 정상적으로 처리되었습니다.`,
      });
    }

    const manualTradeMatch = pathname.match(/^\/api\/bots\/([^/]+)\/manual-trade$/);
    if (manualTradeMatch && req.method === "POST") {
      const botId = manualTradeMatch[1];
      const body = await readJsonBody(req);
      const action = body.action || "buy";
      const market = body.market || "KRW-BTC";
      const bot = (await getBots()).find((b) => b.bot_id === botId);
      if (!bot) return sendJson(res, 404, { success: false, message: "봇을 찾을 수 없습니다." });

      const now = nowKSTString();
      if (action === "buy") {
        const haltInfo = await checkAndHaltIfZeroBalance();
        if (haltInfo.halted) return sendJson(res, 200, { success: false, message: haltInfo.reason });
        const availableKrw = Number(bot.virtual_krw || 0);
        if (availableKrw < 5000) {
          return sendJson(res, 200, {
            success: false,
            message: `[${bot.nickname || bot.name}] 최소 주문 금액(5,000원) 이상의 가용 가상잔고(현재 ${availableKrw.toLocaleString("ko-KR")}원)가 부족합니다.`,
          });
        }
        let orderKrw = Math.min(Math.floor(availableKrw * 0.25), 500000);
        if (orderKrw < 5000) {
          orderKrw = 5000;
        }
        const price = 98500000;
        const volume = (orderKrw / price).toFixed(8);

        // 매수 테스트는 실주문을 전송하거나 거래 내역(trades/bot_positions) 이력을 남기지 않음
        return sendJson(res, 200, {
          success: true,
          message: `[${bot.nickname || bot.name}] 매수 테스트 정상 확인 (가용 잔고: ${availableKrw.toLocaleString("ko-KR")}원 / 1회 주문 가능 금액: ${orderKrw.toLocaleString("ko-KR")}원 / 실매수 및 이력 저장은 수행하지 않습니다)`,
        });
      } else {
        const pos = bot.open_positions?.[0];
        if (!pos) {
          return sendJson(res, 200, {
            success: false,
            message: `[${bot.nickname || bot.name}] 현재 보유 중인 미매도 포지션이 없습니다.`,
          });
        }
        // 매도 테스트 역시 DB 상태를 변경하거나 가짜 매도 기록을 남기지 않음
        return sendJson(res, 200, {
          success: true,
          message: `[${bot.nickname || bot.name}] 보유 포지션(${pos.market}, 수량 ${pos.volume}) 확인 완료 (실제 매도가 아니므로 매도 완료로 기록하지 않습니다)`,
        });
      }
    }

    const updateBotMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
    if (updateBotMatch && req.method === "PUT") {
      const botId = updateBotMatch[1];
      const body = await readJsonBody(req);
      const now = nowKSTString();
      await db.prepare(`
        UPDATE bots
        SET nickname = ?, min_volume_krw = ?, stop_loss_pct = ?, take_profit_pct = ?, config_json = ?, updated_at = ?
        WHERE bot_id = ?
      `).run(
        String(body.nickname || "").trim(),
        Math.floor(Number(body.min_volume_krw || 0)),
        Number(body.stop_loss_pct || 3.0),
        Number(body.take_profit_pct || 5.0),
        JSON.stringify(body.config || {}),
        now,
        botId
      );
      const updated = (await getBots()).find((b) => b.bot_id === botId);
      return sendJson(res, 200, {
        success: true,
        message: `[${updated?.nickname || botId}] 봇 설정 및 별명이 저장되었습니다.`,
        bot: updated,
      });
    }

    // [Antigravity-Doc] GET /api/trades — 실거래(live), 가상거래(paper), 통합(all, UNION ALL) 체결 내역 조회 (SQLite/PostgreSQL 분기 및 페이지네이션 지원)
    if (pathname === "/api/trades" && req.method === "GET") {
      const botId = parsedUrl.searchParams.get("bot_id");
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      const pageParam = parsedUrl.searchParams.get("page");
      const limitParam = parsedUrl.searchParams.get("limit");
      const statusParam = parsedUrl.searchParams.get("status");

      const isPaged = pageParam !== null || limitParam !== null;
      const page = Math.max(1, parseInt(pageParam || "1", 10));
      const limit = Math.max(1, Math.min(200, parseInt(limitParam || "50", 10)));
      const offset = (page - 1) * limit;

      let haltInfo = { halted: false, reason: "" };
      if (mode !== "all") {
        haltInfo = await checkAndHaltIfZeroBalance(mode);
      }

      let baseFromSql = "";
      const isSqlite = isSqliteEngineActive();

      if (isSqlite) {
        if (mode === "live") {
          baseFromSql = `
            SELECT 
              'live' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price, 
              buy_volume, 
              buy_amount, 
              buy_date, 
              sell_price, 
              sell_volume, 
              sell_amount, 
              sell_date, 
              profit_krw, 
              profit_pct, 
              status, 
              NULL AS buy_reason, 
              NULL AS sell_reason,
              expected_price,
              slippage_bps,
              atr_sizing_mult
            FROM trades
          `;
        } else if (mode === "paper") {
          baseFromSql = `
            SELECT 
              'paper' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price, 
              buy_volume, 
              buy_amount, 
              buy_date, 
              sell_price, 
              sell_volume, 
              sell_amount, 
              sell_date, 
              profit_krw, 
              profit_pct, 
              status, 
              buy_reason, 
              sell_reason,
              NULL AS expected_price,
              NULL AS slippage_bps,
              NULL AS atr_sizing_mult
            FROM paper_trades
          `;
        } else {
          // mode === "all" (실거래 + 가상거래 전체)
          baseFromSql = `
            SELECT 
              'live' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price, 
              buy_volume, 
              buy_amount, 
              buy_date, 
              sell_price, 
              sell_volume, 
              sell_amount, 
              sell_date, 
              profit_krw, 
              profit_pct, 
              status, 
              NULL AS buy_reason, 
              NULL AS sell_reason,
              expected_price,
              slippage_bps,
              atr_sizing_mult
            FROM trades
            UNION ALL
            SELECT 
              'paper' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price, 
              buy_volume, 
              buy_amount, 
              buy_date, 
              sell_price, 
              sell_volume, 
              sell_amount, 
              sell_date, 
              profit_krw, 
              profit_pct, 
              status, 
              buy_reason, 
              sell_reason,
              NULL AS expected_price,
              NULL AS slippage_bps,
              NULL AS atr_sizing_mult
            FROM paper_trades
          `;
        }
      } else {
        if (mode === "live") {
          baseFromSql = `
            SELECT 
              'live' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price::numeric AS buy_price, 
              buy_volume, 
              buy_amount, 
              buy_date, 
              sell_price::numeric AS sell_price, 
              sell_volume, 
              sell_amount, 
              sell_date, 
              profit_krw, 
              profit_pct::numeric AS profit_pct, 
              status, 
              NULL::text AS buy_reason, 
              NULL::text AS sell_reason,
              expected_price::numeric AS expected_price,
              slippage_bps::numeric AS slippage_bps,
              atr_sizing_mult::numeric AS atr_sizing_mult
            FROM trades
          `;
        } else if (mode === "paper") {
          baseFromSql = `
            SELECT 
              'paper' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price::numeric AS buy_price, 
              buy_volume, 
              buy_amount, 
              to_char(buy_date, 'YYYY-MM-DD HH24:MI:SS') AS buy_date, 
              sell_price::numeric AS sell_price, 
              sell_volume, 
              sell_amount, 
              to_char(sell_date, 'YYYY-MM-DD HH24:MI:SS') AS sell_date, 
              profit_krw, 
              profit_pct::numeric AS profit_pct, 
              status, 
              buy_reason, 
              sell_reason,
              NULL::numeric AS expected_price,
              NULL::numeric AS slippage_bps,
              NULL::numeric AS atr_sizing_mult
            FROM paper_trades
          `;
        } else {
          // mode === "all" (실거래 + 가상거래 전체)
          baseFromSql = `
            SELECT 
              'live' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price::numeric AS buy_price, 
              buy_volume, 
              buy_amount, 
              buy_date, 
              sell_price::numeric AS sell_price, 
              sell_volume, 
              sell_amount, 
              sell_date, 
              profit_krw, 
              profit_pct::numeric AS profit_pct, 
              status, 
              NULL::text AS buy_reason, 
              NULL::text AS sell_reason,
              expected_price::numeric AS expected_price,
              slippage_bps::numeric AS slippage_bps,
              atr_sizing_mult::numeric AS atr_sizing_mult
            FROM trades
            UNION ALL
            SELECT 
              'paper' AS trade_mode, 
              id, 
              bot_id, 
              market, 
              buy_order_uuid, 
              sell_order_uuid, 
              buy_price::numeric AS buy_price, 
              buy_volume, 
              buy_amount, 
              to_char(buy_date, 'YYYY-MM-DD HH24:MI:SS') AS buy_date, 
              sell_price::numeric AS sell_price, 
              sell_volume, 
              sell_amount, 
              to_char(sell_date, 'YYYY-MM-DD HH24:MI:SS') AS sell_date, 
              profit_krw, 
              profit_pct::numeric AS profit_pct, 
              status, 
              buy_reason, 
              sell_reason,
              NULL::numeric AS expected_price,
              NULL::numeric AS slippage_bps,
              NULL::numeric AS atr_sizing_mult
            FROM paper_trades
          `;
        }
      }

      const whereClauses = [];
      const queryParams = [];

      if (botId && botId !== "all") {
        whereClauses.push("t.bot_id = ?");
        queryParams.push(botId);
      }
      if (statusParam && statusParam !== "all") {
        whereClauses.push("t.status = ?");
        queryParams.push(statusParam);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

      // Total count 쿼리
      const countSql = `SELECT COUNT(*) AS total_count FROM (${baseFromSql}) t ${whereSql}`;
      const countRow = await db.prepare(countSql).get(...queryParams);
      const total = Number(countRow?.total_count || 0);
      const totalPages = isPaged ? Math.max(1, Math.ceil(total / limit)) : 1;
      const effectivePage = isPaged ? Math.min(page, totalPages) : 1;
      const effectiveOffset = (effectivePage - 1) * limit;

      let trades = [];
      if (isPaged) {
        const dataSql = `
          SELECT 
            t.*, 
            b.name AS bot_name, 
            b.nickname AS bot_nickname 
          FROM (${baseFromSql}) t
          LEFT JOIN bots b ON t.bot_id = b.bot_id
          ${whereSql}
          ORDER BY t.buy_date DESC, t.id DESC
          LIMIT ? OFFSET ?
        `;
        trades = await db.prepare(dataSql).all(...queryParams, limit, effectiveOffset);
      } else {
        const dataSql = `
          SELECT 
            t.*, 
            b.name AS bot_name, 
            b.nickname AS bot_nickname 
          FROM (${baseFromSql}) t
          LEFT JOIN bots b ON t.bot_id = b.bot_id
          ${whereSql}
          ORDER BY t.buy_date DESC, t.id DESC
        `;
        trades = await db.prepare(dataSql).all(...queryParams);
      }

      return sendJson(res, 200, {
        success: true,
        mode,
        bot_id: botId || "all",
        trades,
        total,
        page: isPaged ? effectivePage : 1,
        limit: isPaged ? limit : trades.length,
        total_pages: totalPages,
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
      });
    }

    // ============================================================
    // [월별 자산 스냅샷 및 증감 통계 API]
    // ============================================================
    if (pathname === "/api/monthly-assets" && req.method === "GET") {
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      const result = await syncMonthlyAssetSnapshot(mode);
      return sendJson(res, 200, result);
    }

    // [Antigravity-Doc] GET /api/statistics — 2026-10-01 이후 일간/ISO주간/월간 누적 손익, 코인별/봇별 랭킹, 월별 자산 스냅샷 및 슬리피지 실행 품질 집계
    if (pathname === "/api/statistics" && req.method === "GET") {
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      const tradesTable = mode === "live" ? "trades" : "paper_trades";
      const startDate = "2026-10-01";
      const trades = await db
        .prepare(`SELECT * FROM ${tradesTable} WHERE substr(buy_date, 1, 10) >= ? ORDER BY COALESCE(sell_date, buy_date) ASC`)
        .all(startDate);

      const dailyMap = {};
      const weeklyMap = {};
      const monthlyMap = {};
      const dailyTradedSet = new Set();
      const weeklyTradedSet = new Set();
      const monthlyTradedSet = new Set();

      const startDt = new Date(2026, 9, 1); // 2026-10-01
      const todayStr = todayDateString();
      const [ty, tm, td] = todayStr.split("-").map(Number);
      const endDt = new Date(ty, tm - 1, td);

      const getWeekKey = (dateStr) => {
        const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
        // ISO-8601 주차 산출 (연도 경계 2027-W53+ 오버플로우 방지)
        const utc = new Date(Date.UTC(y || 2026, (m || 1) - 1, d || 1));
        const dayNum = utc.getUTCDay() || 7;
        utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
        const isoYear = utc.getUTCFullYear();
        const yearStart = new Date(Date.UTC(isoYear, 0, 1));
        const weekNo = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
        return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
      };

      const cutoff7dStr = formatKstDateTime(new Date(Date.now() - 7 * 86400 * 1000)).slice(0, 10);
      const cutoff30dStr = formatKstDateTime(new Date(Date.now() - 30 * 86400 * 1000)).slice(0, 10);
      const currentYearPrefix = todayStr.slice(0, 4);

      // 2026-10-01부터 오늘까지 모든 일자/주간/월간 슬롯을 기본 0으로 생성
      for (let d = new Date(startDt); d <= endDt; d.setDate(d.getDate() + 1)) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const dKey = `${y}-${m}-${day}`;
        const mKey = `${y}-${m}`;
        const wKey = getWeekKey(dKey);
        dailyMap[dKey] = 0;
        weeklyMap[wKey] = 0;
        monthlyMap[mKey] = 0;
      }

      const coinStats = {};

      for (const t of trades) {
        if (!coinStats[t.market]) {
          coinStats[t.market] = {
            market: t.market,
            trade_count: 0,
            completed_count: 0,
            holding_count: 0,
            weekly_profit: 0,
            monthly_profit: 0,
            yearly_profit: 0,
            total_profit: 0,
          };
        }
        coinStats[t.market].trade_count += 1;
        if ((t.status === "COMPLETED" || t.status === "CLOSED") && t.profit_krw !== null) {
          coinStats[t.market].completed_count += 1;
          const p = Math.trunc(Number(t.profit_krw));
          const dStr = String(t.sell_date || t.buy_date).slice(0, 10);
          dailyMap[dStr] = (dailyMap[dStr] || 0) + p;
          dailyTradedSet.add(dStr);

          const mKey = dStr.slice(0, 7);
          monthlyMap[mKey] = (monthlyMap[mKey] || 0) + p;
          monthlyTradedSet.add(mKey);

          const wKey = getWeekKey(dStr);
          weeklyMap[wKey] = (weeklyMap[wKey] || 0) + p;
          weeklyTradedSet.add(wKey);

          if (dStr >= cutoff7dStr) coinStats[t.market].weekly_profit += p;
          if (dStr >= cutoff30dStr) coinStats[t.market].monthly_profit += p;
          if (dStr.startsWith(currentYearPrefix)) coinStats[t.market].yearly_profit += p;
          coinStats[t.market].total_profit += p;
        } else {
          coinStats[t.market].holding_count += 1;
        }
      }

      const buildSeries = (mapObj, tradedSet) => {
        let cum = 0;
        return Object.keys(mapObj)
          .sort()
          .map((label) => {
            const periodProfit = mapObj[label] || 0;
            cum += periodProfit;
            const hasTrade = tradedSet ? tradedSet.has(label) : periodProfit !== 0;
            return {
              label,
              profit: periodProfit,
              cumulative_profit: cum,
              has_trade: hasTrade,
            };
          });
      };

      const coinRanking = Object.values(coinStats).sort(
        (a, b) => b.trade_count - a.trade_count || b.yearly_profit - a.yearly_profit
      );

      const botStatsMap = {};
      for (const t of trades) {
        const botKey = normalizeBotId(t.bot_id);
        if (!botStatsMap[botKey]) {
          botStatsMap[botKey] = { bot_id: botKey, trade_count: 0, completed_count: 0, win_count: 0, lose_count: 0, total_profit: 0 };
        }
        botStatsMap[botKey].trade_count += 1;
        if ((t.status === "COMPLETED" || t.status === "CLOSED") && t.profit_krw !== null) {
          const bp = Math.floor(Number(t.profit_krw));
          botStatsMap[botKey].completed_count += 1;
          botStatsMap[botKey].total_profit += bp;
          if (bp > 0) botStatsMap[botKey].win_count += 1;
          else if (bp < 0) botStatsMap[botKey].lose_count += 1;
        }
      }

      const botNameMap = {};
      for (const b of await db.prepare("SELECT bot_id, nickname, name FROM bots").all()) {
        botNameMap[b.bot_id] = b.nickname || b.name;
      }
      const botRanking = Object.values(botStatsMap)
        .map((bs) => {
          const decided = bs.win_count + bs.lose_count;
          return {
            ...bs,
            nickname: botNameMap[bs.bot_id] || bs.bot_id,
            win_rate_pct: decided > 0 ? Number(((bs.win_count / decided) * 100).toFixed(1)) : 0,
          };
        })
        .sort((a, b) => b.total_profit - a.total_profit);

      const monthlyAssets = await syncMonthlyAssetSnapshot(mode);

      const slippageTrades = trades.filter(
        (t) => t.slippage_bps !== null && t.slippage_bps !== undefined && Number.isFinite(Number(t.slippage_bps))
      );
      const avgSlippageBps =
        slippageTrades.length > 0
          ? Number(
              (
                slippageTrades.reduce((acc, t) => acc + Number(t.slippage_bps || 0), 0) / slippageTrades.length
              ).toFixed(2)
            )
          : 0;
      const executionQualitySummary = {
        avg_slippage_bps: avgSlippageBps,
        measured_trades_count: slippageTrades.length,
        favorable_or_zero_count: slippageTrades.filter((t) => Number(t.slippage_bps || 0) <= 0).length,
      };

      return sendJson(res, 200, {
        mode,
        start_date: "2026.10.01",
        monthly_assets: monthlyAssets,
        avg_slippage_bps: avgSlippageBps,
        execution_quality_summary: executionQualitySummary,
        daily: buildSeries(dailyMap, dailyTradedSet),
        weekly: buildSeries(weeklyMap, weeklyTradedSet),
        monthly: buildSeries(monthlyMap, monthlyTradedSet),
        coin_ranking: coinRanking,
        bot_ranking: botRanking,
      });
    }

    // ============================================================
    // [10대 알고리즘 상시 가상 경쟁(Arena) REST API]
    // ============================================================
    // [Antigravity-Doc] /api/arena/* — 10대 알고리즘 상시 가상 경쟁 리더보드, 거래 이력, 수동 1사이클 실행 및 원장 초기화
    if (pathname === "/api/arena/leaderboard" && req.method === "GET") {
      const leaderboard = await getArenaLeaderboard(db);
      return sendJson(res, 200, {
        success: true,
        always_on: true,
        llm_filter_bypassed: true,
        leaderboard,
        status: getArenaStatus(),
        updated_at: nowKSTString(),
      });
    }

    if (pathname === "/api/arena/trades" && req.method === "GET") {
      const botId = parsedUrl.searchParams.get("bot_id");
      const limit = Number(parsedUrl.searchParams.get("limit") || 100);
      return sendJson(res, 200, {
        success: true,
        bot_id: botId || "all",
        trades: await getArenaTrades(db, botId, limit),
      });
    }

    if (pathname === "/api/arena/run-cycle" && req.method === "POST") {
      await runAlwaysOnPaperArenaCycle();
      return sendJson(res, 200, {
        success: true,
        message: "순수 알고리즘 가상 시뮬레이션 1사이클이 실행되었습니다.",
        leaderboard: await getArenaLeaderboard(db),
        status: getArenaStatus(),
      });
    }

    if (pathname === "/api/arena/reset" && req.method === "POST") {
      return sendJson(res, 200, await resetPaperArenaAndNotify(db));
    }

    // ============================================================
    // [실전 담당 봇(1~3개) 선택 및 동적 투자금 배분 API]
    // ============================================================
    // [Antigravity-Doc] /api/settings/* — 실전 봇 선택(live-bots), 자본 배분(allocation), Ollama, 입장 코드 변경, JSON 내보내기/복원
    if (pathname === "/api/settings/live-bots" && req.method === "GET") {
      await syncDynamicLiveCapitalFromUpbit();
      const allLive = await getBots("live");
      const liveBots = allLive.filter((b) => Number(b.is_selected_for_live) === 1);
      const drainingBots = allLive.filter((b) => Number(b.is_selected_for_live) !== 1 && Number(b.used_capital || 0) > 0);
      return sendJson(res, 200, {
        success: true,
        total_capital: Math.floor(Number(await getSetting("total_capital", "0"))),
        draining_bots: drainingBots.map((b) => ({
          bot_id: b.bot_id,
          nickname: b.nickname,
          ...getBotStrategyMeta(b.bot_id),
          used_capital: b.used_capital,
        })),
        selected_bots: liveBots.map((b) => ({
          bot_id: b.bot_id,
          nickname: b.nickname,
          ...getBotStrategyMeta(b.bot_id),
          allocation_ratio: Number((Number(b.allocation_ratio || 0) / 100).toFixed(4)),
          allocated_capital: b.allocated_capital,
          virtual_krw: b.virtual_krw,
        })),
      });
    }

    if (pathname === "/api/settings/live-bots" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const selected = Array.isArray(body.selected_bots) ? body.selected_bots : [];
      try {
        const result = await applyLiveBotsSelection(selected, body.handover_map, body.total_capital);
        return sendJson(res, 200, {
          success: true,
          message:
            `실제 거래 담당 봇 ${result.selected_bots.length}개와 투자금 배분이 저장되었습니다.` +
            (result.draining_bots?.length > 0
              ? `\n[포지션 보호 청산 대기] 해제된 ${result.draining_bots
                  .map((b) => b.nickname)
                  .join(", ")} 봇의 기존 보유 물량은 강제 청산 없이 끝까지 안전 감시·매도됩니다.`
              : "") +
            (result.handover.length > 0
              ? "\n[미매도 포지션 승계] " +
                result.handover.map((h) => `${h.from_bot_id} → ${h.to_bot_id}`).join(", ")
              : ""),
          ...result,
        });
      } catch (err) {
        return sendJson(res, 400, { success: false, detail: err.message });
      }
    }

    if (pathname === "/api/settings/allocation" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const ratios = body.ratios || {};
      const ratioSum = Number(
        Object.values(ratios)
          .reduce((acc, v) => acc + Number(v || 0), 0)
          .toFixed(2)
      );
      if (ratioSum > 100.0) {
        return sendJson(res, 400, {
          success: false,
          detail: `봇별 자금 분배 비율의 합계(${ratioSum}%)는 100%를 초과할 수 없습니다.`,
        });
      }
      // 요구사항: 총 실전 운영 원금은 사용자가 직접 입력하는 것이 아닌 실제 upbit 실계좌 잔고 90%를 자동 설정
      const accountInfo = await fetchUpbitAccountBalance();
      let flooredTotal = 0;
      if (accountInfo?.success) {
        const rawAsset = Number(accountInfo.total_asset_krw ?? accountInfo.krw_total ?? accountInfo.krw_balance ?? 0);
        flooredTotal = Math.floor(rawAsset * 0.9);
      }
      if (!(flooredTotal > 0)) {
        flooredTotal = Math.floor(Number(body.total_capital || (await getSetting("total_capital", "0"))));
      }
      const totalUsed = (await getBots()).reduce((acc, b) => acc + Math.floor(Number(b.used_capital || 0)), 0);
      if (flooredTotal > 0 && flooredTotal < totalUsed) {
        return sendJson(res, 400, {
          success: false,
          detail: `자동 산출된 전체 운용 원금(${flooredTotal.toLocaleString("ko-KR")}원)이 현재 이미 매수에 사용된 투자금(${totalUsed.toLocaleString("ko-KR")}원)보다 적습니다.`,
        });
      }
      const now = nowKSTString();
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(
        String(flooredTotal),
        now
      );
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(
        now
      );

      await recalculateAndApplyBotAllocations(flooredTotal, ratios);

      if (flooredTotal > 0) {
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)").run(now);
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)").run(now);
      }

      const haltInfo = await checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        success: true,
        message: "자금 분배 비율 및 원금 설정이 저장되었습니다 (소수점 이하 버림 적용).",
        total_capital: flooredTotal,
        bots: await getBots(),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
      });
    }

    if (pathname === "/api/settings/ollama" && req.method === "GET") {
      const cfg = await getOllamaRuntimeConfig();
      const ollama = await checkOllamaStatus({ forceRefresh: parsedUrl.searchParams.get("refresh") === "1" });
      return sendJson(res, 200, {
        success: true,
        use_local_ollama_news: cfg.enabled,
        ollama_base_url: cfg.baseUrl,
        ollama_news_model: cfg.model,
        ollama_timeout_ms: cfg.timeoutMs,
        ollama,
      });
    }

    if (pathname === "/api/settings/ollama" && (req.method === "POST" || req.method === "PUT")) {
      try {
        const body = await readJsonBody(req);
        const saved = await saveOllamaSettings(body || {});
        return sendJson(res, 200, {
          success: true,
          message: saved.use_local_ollama_news
            ? saved.ollama?.reachable
              ? `로컬 Ollama(${saved.ollama_news_model}) 연결 확인 및 설정 저장 완료 (${saved.ollama.latency_ms}ms)`
              : `로컬 Ollama 설정이 저장되었습니다. (현재 ${saved.ollama_base_url} 미응답 — 분석 시 Gemini Flash로 자동 전환됩니다)`
            : "로컬 Ollama 비활성화 설정이 저장되었습니다. (Gemini Flash 엔진 직접 사용)",
          ...saved,
        });
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message });
      }
    }

    if (pathname === "/api/settings/entry-code" && req.method === "GET") {
      const currentCode = await getEffectiveEntryCode();
      const maskedLen = currentCode ? Math.min(12, Math.max(6, currentCode.length)) : 6;
      return sendJson(res, 200, {
        success: true,
        configured: Boolean(currentCode),
        masked: "•".repeat(maskedLen),
      });
    }

    if (pathname === "/api/settings/entry-code" && (req.method === "POST" || req.method === "PUT")) {
      const body = await readJsonBody(req);
      const newCode = String(body.entry_code || "").trim();
      if (!newCode) {
        return sendJson(res, 400, {
          success: false,
          message: "새 입장 코드를 입력해주세요.",
        });
      }
      if (newCode.length < 4) {
        return sendJson(res, 400, {
          success: false,
          message: "입장 코드는 보안을 위해 최소 4자 이상이어야 합니다.",
        });
      }
      const now = nowKSTString();
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('entry_code', ?, ?)").run(
        newCode,
        now
      );
      await db.prepare("DELETE FROM system_settings WHERE key = 'gate_code'").run();
      if (pgSyncManager.isConnected && pgSyncManager.pool) {
        try {
          await pgSyncManager.pool.query(
            `INSERT INTO system_settings (key, value, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            ["entry_code", newCode, now]
          );
        } catch (e) {
          console.warn("[pgSync] entry_code 동기화 실패:", e.message);
        }
      }
      const refreshedToken = createSignedSessionToken(newCode);
      return sendJson(
        res,
        200,
        {
          success: true,
          message: "보안 입장 코드가 변경되었으며 기존 다른 세션은 즉시 무효화되었습니다.",
          masked: "•".repeat(Math.min(12, Math.max(6, newCode.length))),
        },
        { "Set-Cookie": buildSessionCookieHeader(req, refreshedToken, 86400) }
      );
    }

    if (pathname === "/api/settings/export" && req.method === "GET") {
      let autoRotationConfig = [];
      let autoRotationHistory = [];
      let capitalRestorationLogs = [];
      let paperTrades = [];
      let paperBotPositions = [];
      let marketRegimeFilter = [];
      try {
        autoRotationConfig = await db.prepare("SELECT * FROM auto_rotation_config").all();
        autoRotationHistory = await db.prepare("SELECT * FROM auto_rotation_history ORDER BY id DESC LIMIT 100").all();
        capitalRestorationLogs = await db.prepare("SELECT * FROM capital_restoration_logs ORDER BY id DESC LIMIT 200").all();
        paperTrades = await db.prepare("SELECT * FROM paper_trades ORDER BY id ASC").all();
        paperBotPositions = await db.prepare("SELECT * FROM paper_bot_positions ORDER BY id ASC").all();
        marketRegimeFilter = await db.prepare("SELECT * FROM market_regime_filter").all();
      } catch {}
      const rawSettings = await db.prepare("SELECT * FROM system_settings").all();
      const excludedExportKeys = new Set([
        "auth_session_secret",
        "entry_code",
        "gate_code",
        "gemini_api_key",
        "vapid_private_key",
        "telegram_bot_token",
        "telegram_chat_id",
        "discord_webhook_url",
      ]);
      const safeSystemSettings = rawSettings.filter((s) => !excludedExportKeys.has(s.key));
      const payload = {
        schema_version: "1.3",
        exported_at: nowKSTString(),
        system_settings: safeSystemSettings,
        bots: await db.prepare("SELECT * FROM bots").all(),
        trades: await db.prepare("SELECT * FROM trades").all(),
        bot_positions: await db.prepare("SELECT * FROM bot_positions").all(),
        paper_trades: paperTrades,
        paper_bot_positions: paperBotPositions,
        market_regime_filter: marketRegimeFilter,
        auto_rotation_config: autoRotationConfig,
        auto_rotation_history: autoRotationHistory,
        capital_restoration_logs: capitalRestorationLogs,
      };
      return sendJson(res, 200, payload);
    }

    if (pathname === "/api/settings/import-json" && req.method === "POST") {
      const payload = await readJsonBody(req);
      if (!payload || !Array.isArray(payload.bots) || !Array.isArray(payload.trades)) {
        return sendJson(res, 400, { detail: "유효하지 않은 마이그레이션 JSON 형식입니다." });
      }
      const now = nowKSTString();
      const preservedSecretKeys = new Set([
        "auth_session_secret",
        "entry_code",
        "gate_code",
        "gemini_api_key",
        "vapid_private_key",
        "vapid_public_key",
        "telegram_bot_token",
        "telegram_chat_id",
        "discord_webhook_url",
      ]);
      await withDbWriteLock(async () => {
        const existingSecretRows = [];
        try {
          const allExisting = await db.prepare("SELECT key, value, updated_at FROM system_settings").all();
          for (const row of allExisting) {
            if (preservedSecretKeys.has(row.key)) existingSecretRows.push(row);
          }
        } catch {}

        try {
          await beginWriteTx(db);
          await db.exec("DELETE FROM bot_positions; DELETE FROM trades; DELETE FROM bots; DELETE FROM system_settings;");
          const importedKeys = new Set();
          for (const s of payload.system_settings || []) {
            if (!s?.key) continue;
            importedKeys.add(s.key);
            await db.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
              s.key,
              String(s.value),
              s.updated_at || now
            );
          }
          // Export 시 보안상 제외된 민감 설정키(entry_code, gemini_api_key, vapid_private_key 등)가 Import에서 소실되지 않도록 보존
          for (const sec of existingSecretRows) {
            if (!importedKeys.has(sec.key)) {
              await db
                .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)")
                .run(sec.key, String(sec.value), sec.updated_at || now);
            }
          }
      for (const b of payload.bots || []) {
        const meta = getBotStrategyMeta(b.bot_id);
        await db.prepare(`
          INSERT INTO bots (
            bot_id, name, nickname, strategy_type, strategy_group, description,
            allocation_ratio, allocated_capital, virtual_krw, is_running,
            min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
            last_status_msg, updated_at,
            is_selected_for_live, paper_initial_capital, paper_virtual_krw,
            paper_is_running, paper_peak_equity, paper_mdd_pct, paper_status_msg,
            target_capital_krw, drain_status, replaced_by_bot_id, drain_started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          b.bot_id,
          b.name,
          b.nickname,
          b.strategy_type,
          b.strategy_group || meta.strategy_group_code,
          b.description || "",
          Number(b.allocation_ratio ?? 0),
          Math.floor(Number(b.allocated_capital || 0)),
          Math.floor(Number(b.virtual_krw || 0)),
          Number(b.is_running || 0),
          Math.floor(Number(b.min_volume_krw || 5000000000)),
          Number(b.stop_loss_pct || 3.0),
          Number(b.take_profit_pct || 5.0),
          b.config_json || "{}",
          b.last_status_msg || "복원 완료",
          b.updated_at || now,
          Number(b.is_selected_for_live ?? (Number(b.allocation_ratio) > 0 && Number(b.is_running) === 1 ? 1 : 0)),
          Math.floor(Number(b.paper_initial_capital || 1000000)),
          Math.floor(Number(b.paper_virtual_krw || 1000000)),
          Number(b.paper_is_running ?? 1),
          Math.floor(Number(b.paper_peak_equity || 1000000)),
          Number(b.paper_mdd_pct || 0),
          b.paper_status_msg || "시그널 대기 중",
          Math.floor(Number(b.target_capital_krw || 0)),
          b.drain_status || "NONE",
          b.replaced_by_bot_id || null,
          b.drain_started_at || null
        );
      }
      for (const t of payload.trades || []) {
        await db.prepare(`
          INSERT INTO trades (
            id, bot_id, market, buy_order_uuid, sell_order_uuid,
            buy_price, buy_volume, buy_amount, buy_date,
            sell_price, sell_volume, sell_amount, sell_date,
            profit_krw, profit_pct, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          t.id,
          t.bot_id,
          t.market,
          t.buy_order_uuid,
          t.sell_order_uuid ?? null,
          Number(t.buy_price),
          String(t.buy_volume),
          Math.floor(Number(t.buy_amount)),
          t.buy_date,
          t.sell_price ?? null,
          t.sell_volume ?? null,
          t.sell_amount !== null && t.sell_amount !== undefined ? Math.floor(Number(t.sell_amount)) : null,
          t.sell_date ?? null,
          t.profit_krw !== null && t.profit_krw !== undefined ? Math.floor(Number(t.profit_krw)) : null,
          t.profit_pct ?? null,
          t.status || "HOLDING"
        );
      }
      const seenPositionOrderUuids = new Set();
      const seenPositionIds = new Set();
      for (let idx = 0; idx < (payload.bot_positions || []).length; idx++) {
        const p = payload.bot_positions[idx];

        // order_uuid 고유성 보장 (null/빈값 처리 및 중복 발생 시 접미사 부여로 UNIQUE constraint 위반 방어)
        let safeOrderUuid = (p.order_uuid !== null && p.order_uuid !== undefined) ? String(p.order_uuid).trim() : "";
        if (!safeOrderUuid) {
          safeOrderUuid = `restored-pos-${p.id || (idx + 1)}-${Date.now()}`;
        }
        if (seenPositionOrderUuids.has(safeOrderUuid)) {
          safeOrderUuid = `${safeOrderUuid}-dup-${p.id || (idx + 1)}`;
        }
        seenPositionOrderUuids.add(safeOrderUuid);

        let posId = p.id !== null && p.id !== undefined ? Number(p.id) : null;
        if (posId !== null && seenPositionIds.has(posId)) {
          posId = null;
        }
        if (posId !== null) {
          seenPositionIds.add(posId);
          await db.prepare(`
            INSERT OR REPLACE INTO bot_positions (
              id, bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            posId,
            p.bot_id,
            p.market,
            safeOrderUuid,
            String(p.volume),
            Number(p.avg_buy_price),
            Math.floor(Number(p.buy_amount)),
            Number(p.buy_fee || 0),
            Number(p.trade_id),
            p.status || "OPEN",
            p.created_at || now,
            p.closed_at ?? null
          );
        } else {
          await db.prepare(`
            INSERT INTO bot_positions (
              bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            p.bot_id,
            p.market,
            safeOrderUuid,
            String(p.volume),
            Number(p.avg_buy_price),
            Math.floor(Number(p.buy_amount)),
            Number(p.buy_fee || 0),
            Number(p.trade_id),
            p.status || "OPEN",
            p.created_at || now,
            p.closed_at ?? null
          );
        }
      }
      if (Array.isArray(payload.auto_rotation_config) && payload.auto_rotation_config.length > 0) {
        await db.exec("DELETE FROM auto_rotation_config;");
        for (const c of payload.auto_rotation_config) {
          await db.prepare(`
            INSERT INTO auto_rotation_config (
              id, is_enabled, rotation_day_of_week, rotation_hour_kst,
              allocation_mode, min_weekly_trades, capital_tier_1_max, capital_tier_2_max, max_deploy_ratio,
              last_rotated_at, next_rotation_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            1,
            Number(c.is_enabled ?? 1),
            Number(c.rotation_day_of_week ?? 1),
            Number(c.rotation_hour_kst ?? 9),
            c.allocation_mode || "EQUAL_BY_CAPITAL_TIER",
            Number(c.min_weekly_trades ?? 2),
            Number(c.capital_tier_1_max ?? 400000),
            Number(c.capital_tier_2_max ?? 700000),
            Number(c.max_deploy_ratio ?? 0.9),
            c.last_rotated_at ?? null,
            c.next_rotation_at ?? computeNextRotationKstString(Number(c.rotation_day_of_week ?? 1), Number(c.rotation_hour_kst ?? 9)),
            c.updated_at || now
          );
        }
      }
      if (Array.isArray(payload.capital_restoration_logs) && payload.capital_restoration_logs.length > 0) {
        await db.exec("DELETE FROM capital_restoration_logs;");
        for (const r of payload.capital_restoration_logs) {
          await db.prepare(`
            INSERT INTO capital_restoration_logs (
              source_bot_id, target_bot_id, order_uuid, settled_net_krw,
              restored_krw, surplus_reserve_krw, total_used_after_krw, global_cap_krw, total_equity_snapshot_krw, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            r.source_bot_id || "",
            r.target_bot_id || null,
            r.order_uuid || null,
            Number(r.settled_net_krw || 0),
            Number(r.restored_krw || 0),
            Number(r.surplus_reserve_krw || 0),
            Number(r.total_used_after_krw || 0),
            Number(r.global_cap_krw || 0),
            Number(r.total_equity_snapshot_krw || 0),
            r.created_at || now
          );
        }
      }
      if (Array.isArray(payload.auto_rotation_history) && payload.auto_rotation_history.length > 0) {
        await db.exec("DELETE FROM auto_rotation_history;");
        for (const h of payload.auto_rotation_history) {
          await db.prepare(`
            INSERT INTO auto_rotation_history (
              trigger_type, previous_bots_json, elected_bots_json,
              draining_positions_count, transferred_krw, summary_text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            h.trigger_type || "MANUAL_IMMEDIATE",
            typeof h.previous_bots_json === "string" ? h.previous_bots_json : JSON.stringify(h.previous_bots || []),
            typeof h.elected_bots_json === "string" ? h.elected_bots_json : JSON.stringify(h.elected_bots || []),
            Number(h.draining_positions_count || 0),
            Math.floor(Number(h.transferred_krw || 0)),
            h.summary_text || "",
            h.created_at || now
          );
        }
      }
      if (Array.isArray(payload.paper_trades) && payload.paper_trades.length > 0) {
        await db.exec("DELETE FROM paper_bot_positions; DELETE FROM paper_trades;");
        for (const pt of payload.paper_trades) {
          await db.prepare(`
            INSERT INTO paper_trades (
              id, bot_id, market, buy_order_uuid, sell_order_uuid,
              buy_price, buy_volume, buy_amount, buy_date,
              sell_price, sell_volume, sell_amount, sell_date,
              profit_krw, profit_pct, status, buy_reason, sell_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            pt.id,
            pt.bot_id,
            pt.market,
            pt.buy_order_uuid,
            pt.sell_order_uuid ?? null,
            Number(pt.buy_price) || 0,
            String(pt.buy_volume ?? "0"),
            Math.floor(Number(pt.buy_amount) || 0),
            pt.buy_date || now,
            pt.sell_price ?? null,
            pt.sell_volume ?? null,
            pt.sell_amount !== null && pt.sell_amount !== undefined ? Math.floor(Number(pt.sell_amount) || 0) : null,
            pt.sell_date ?? null,
            pt.profit_krw !== null && pt.profit_krw !== undefined ? Math.floor(Number(pt.profit_krw) || 0) : null,
            pt.profit_pct ?? null,
            pt.status || "HOLDING",
            pt.buy_reason ?? null,
            pt.sell_reason ?? null
          );
        }
        for (const pp of payload.paper_bot_positions || []) {
          await db.prepare(`
            INSERT OR REPLACE INTO paper_bot_positions (
              id, bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            pp.id,
            pp.bot_id,
            pp.market,
            pp.order_uuid || `restored-paper-${pp.id || Date.now()}`,
            String(pp.volume ?? "0"),
            Number(pp.avg_buy_price) || 0,
            Math.floor(Number(pp.buy_amount) || 0),
            Number(pp.buy_fee || 0) || 0,
            Number(pp.trade_id || 0) || 0,
            pp.status || "OPEN",
            pp.created_at || now,
            pp.closed_at ?? null
          );
        }
      }
      if (Array.isArray(payload.market_regime_filter) && payload.market_regime_filter.length > 0) {
        const mr = payload.market_regime_filter[0];
        if (mr) {
          await db.prepare(`
            INSERT OR REPLACE INTO market_regime_filter (
              id, sentiment_score, market_regime, risk_alert, recommended_action,
              position_size_multiplier, bot_overrides_json, blacklist_tickers_json, reason, updated_at,
              flash_sentiment_score, flash_recommended_action, flash_updated_at,
              pro_sentiment_score, pro_recommended_action, pro_updated_at,
              final_risk_alert, final_position_multiplier, final_bot_overrides_json
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            Number(mr.sentiment_score || 0) || 0,
            mr.market_regime || "SIDEWAYS",
            Number(mr.risk_alert || 0) || 0,
            mr.recommended_action || "NORMAL",
            Number(mr.position_size_multiplier ?? 1.0),
            JSON.stringify(normalizeBotOverrides(mr.bot_overrides_json)),
            mr.blacklist_tickers_json || "[]",
            mr.reason || "Restored regime state",
            mr.updated_at || now,
            Number(mr.flash_sentiment_score || 0) || 0,
            mr.flash_recommended_action || "NORMAL",
            mr.flash_updated_at || now,
            Number(mr.pro_sentiment_score || 0) || 0,
            mr.pro_recommended_action || "NORMAL",
            mr.pro_updated_at || now,
            Number(mr.final_risk_alert ?? mr.risk_alert ?? 0) || 0,
            Number(mr.final_position_multiplier ?? mr.position_size_multiplier ?? 1.0),
            JSON.stringify(normalizeBotOverrides(mr.final_bot_overrides_json || mr.bot_overrides_json))
          );
        }
      }
      await syncBotAccountsFromBots(db);
          await commitWriteTx(db);
        } catch (impErr) {
          await rollbackWriteTx(db);
          throw impErr;
        }
      });
      await checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        success: true,
        message: `데이터 복원이 완료되었습니다 (봇 ${payload.bots.length}개, 거래내역 ${payload.trades.length}건).`,
      });
    }

    // [Antigravity-Doc] GET /api/news & POST /api/news/refresh — 암호화폐 뉴스 목록 검색/페이지네이션 및 즉시 RSS 수집
    if (pathname === "/api/news" && req.method === "GET") {
      const page = Number(parsedUrl.searchParams.get("page") || 1);
      const limit = Number(parsedUrl.searchParams.get("limit") || 50);
      const keyword = parsedUrl.searchParams.get("keyword") || "";
      const startDate = parsedUrl.searchParams.get("start_date") || "";
      const endDate = parsedUrl.searchParams.get("end_date") || "";

      const result = await queryNewsList(db, { page, limit, keyword, startDate, endDate });
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/news/refresh" && req.method === "POST") {
      try {
        const count = await syncNewsToDatabase(db);
        return sendJson(res, 200, { success: true, newly_inserted: count });
      } catch (err) {
        return sendJson(res, 500, { detail: `뉴스 수집 실패: ${err.message}` });
      }
    }

    // ============================================================
    // [가상거래 모드 (Paper Trading) API]
    // ============================================================
    // [Antigravity-Doc] GET/POST /api/trade-mode — 실거래(live) / 가상거래(paper) 모드 조회 및 전환 (`upbit_config.json` + DB 동기화)
    if (pathname === "/api/trade-mode" && req.method === "GET") {
      const cfg = getRuntimeConfig();
      const mode = String(cfg.trade_mode || "paper").toLowerCase();
      const hasKeys = !!(
        cfg.access_key &&
        cfg.secret_key &&
        cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY" &&
        String(cfg.access_key).trim() !== ""
      );
      return sendJson(res, 200, {
        mode,
        is_live: mode === "live" && hasKeys,
        has_keys: hasKeys,
        message: mode === "live" ? "실거래(Live) 모드 운용 중" : "가상거래(Paper) 모의투자 모드 운용 중",
      });
    }

    if (pathname === "/api/trade-mode" && req.method === "POST") {
      const body = await readJsonBody(req);
      const targetMode = String(body.mode || "").toLowerCase() === "live" ? "live" : "paper";
      const savedCfg = saveRuntimeConfig({ trade_mode: targetMode });
      if (!savedCfg) {
        return sendJson(res, 500, { success: false, message: "설정 파일 저장 실패" });
      }
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('trade_mode', ?, ?)").run(
        targetMode,
        nowKSTString()
      );
      return sendJson(res, 200, {
        success: true,
        mode: targetMode,
        message:
          targetMode === "live"
            ? "실거래(Live) 모드로 전환되었습니다. 실제 업비트 주문이 전송됩니다."
            : "가상거래(Paper) 모드로 전환되었습니다. 실제 코인 시세를 기반으로 모의 체결됩니다.",
      });
    }

    // ============================================================
    // [히스토리컬 캔들 백테스팅 & Walk-Forward 검증소 API]
    // ============================================================
    // [Antigravity-Doc] /api/backtest/* — 과거 캔들 기반 Bar-by-Bar/Walk-Forward 백테스트 실행, 이력 조회, 검증 파라미터 봇 적용
    if (pathname === "/api/backtest/run" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const result = await runHistoricalBacktest(db, {
          botId: body.bot_id || "bot_10",
          market: body.market || "KRW-BTC",
          timeframe: body.timeframe || "15m",
          days: Number(body.days || 30),
          initialCapital: Number(body.initial_capital || 1000000),
          slippageBps: Number(body.slippage_bps ?? 5),
          feeRate: Number(body.fee_rate ?? 0.0005),
          walkForward: Boolean(body.walk_forward),
          customParams: body.custom_params || null,
          candlesOverride: Array.isArray(body.candles_override) ? body.candles_override : null,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message });
      }
    }

    if (pathname === "/api/backtest/history" && req.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 20)));
      const history = await getBacktestHistory(db, limit);
      return sendJson(res, 200, { success: true, history });
    }

    if (pathname === "/api/backtest/apply-params" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const botId = normalizeBotId(String(body.bot_id || ""));
        const targetBot = (await getBots()).find((b) => b.bot_id === botId);
        if (!targetBot) {
          return sendJson(res, 404, { success: false, message: `존재하지 않는 봇입니다: ${botId}` });
        }
        const params = body.params || {};
        const nextStopLoss =
          params.stop_loss_pct !== undefined
            ? Math.abs(Number(params.stop_loss_pct))
            : Number(targetBot.stop_loss_pct || 2.5);
        const nextTakeProfit =
          params.take_profit_pct !== undefined
            ? Math.abs(Number(params.take_profit_pct))
            : Number(targetBot.take_profit_pct || 4.5);
        const mergedCfg = { ...(targetBot.config || {}) };
        for (const [k, v] of Object.entries(params)) {
          if (k !== "stop_loss_pct" && k !== "take_profit_pct") {
            mergedCfg[k] = v;
          }
        }
        const now = nowKSTString();
        await db
          .prepare(
            "UPDATE bots SET stop_loss_pct = ?, take_profit_pct = ?, config_json = ?, updated_at = ? WHERE bot_id = ?"
          )
          .run(nextStopLoss, nextTakeProfit, JSON.stringify(mergedCfg), now, botId);
        const updated = (await getBots()).find((b) => b.bot_id === botId);
        return sendJson(res, 200, {
          success: true,
          message: `[${updated?.nickname || botId}] 백테스트 검증 파라미터(손절 -${nextStopLoss}%, 익절 +${nextTakeProfit}%)가 봇 설정에 반영되었습니다.`,
          bot: updated,
        });
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message });
      }
    }

    // ============================================================
    // [캔들스틱 매수/매도 타점 마커 & 지표 오버레이 차트 API]
    // ============================================================
    // [Antigravity-Doc] GET /api/chart/trade-markers — 캔들스틱 차트 위 매수/매도 타점 마커 및 보조지표 오버레이 데이터 생성
    if (pathname === "/api/chart/trade-markers" && req.method === "GET") {
      try {
        const market = parsedUrl.searchParams.get("market") || "KRW-BTC";
        const botId = parsedUrl.searchParams.get("bot_id") || "all";
        const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
        const unit = Number(parsedUrl.searchParams.get("unit") || 15);
        const count = Number(parsedUrl.searchParams.get("count") || 96);
        const payload = await buildChartTradeMarkers(db, { market, botId, mode, unit, count });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message });
      }
    }

    // ============================================================
    // [멀티채널 실시간 알림 허브 (Telegram · Discord · WebPush) API]
    // ============================================================
    // [Antigravity-Doc] /api/settings/notifications/* — Telegram/Discord/WebPush 멀티채널 알림 설정 조회·암호화 저장 및 테스트 발송
    if (pathname === "/api/settings/notifications" && req.method === "GET") {
      const settings = await loadNotificationSettings(db, { maskSecrets: true });
      return sendJson(res, 200, { success: true, settings });
    }

    if (pathname === "/api/settings/notifications" && (req.method === "PUT" || req.method === "POST")) {
      try {
        const body = await readJsonBody(req);
        const settings = await saveNotificationSettings(db, body || {});
        return sendJson(res, 200, {
          success: true,
          message: "멀티채널 실시간 알림 설정(Telegram · Discord · WebPush)이 암호화 저장되었습니다.",
          settings,
        });
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message });
      }
    }

    if (pathname === "/api/settings/notifications/test" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const result = await dispatchMultiChannelNotification(
          db,
          {
            eventType: "TEST",
            botId: body?.bot_id || "bot_10",
            botName: body?.bot_name || "잭 켈로그 올라운더봇",
            market: body?.market || "KRW-BTC",
            reason: body?.message || "멀티채널 실시간 알림(Telegram · Discord · WebPush) 연동 테스트입니다.",
          },
          {
            forceSend: true,
            webPushBroadcastFn: broadcastWebPushNotification,
          }
        );
        return sendJson(res, 200, {
          success: true,
          message: "멀티채널 테스트 알림 발송 요청이 처리되었습니다.",
          result,
        });
      } catch (err) {
        return sendJson(res, 400, { success: false, message: err.message });
      }
    }

    // ============================================================
    // [하위 호환] 기존 알고리즘 검증소 엔드포인트 -> 10대 알고리즘 Arena 로 통합
    // ============================================================
    // [Antigravity-Doc] /api/algo-lab/* & /api/paper-trades/reset — 구 알고리즘 검증소 엔드포인트(10대 아레나로 하위 호환 통합)
    if (pathname === "/api/algo-lab/models" && req.method === "GET") {
      return sendJson(res, 200, {
        success: true,
        models: await getArenaLeaderboard(db),
        updated_at: nowKSTString(),
      });
    }

    if (pathname === "/api/algo-lab/trades" && req.method === "GET") {
      const modelId = parsedUrl.searchParams.get("model_id");
      const limit = Number(parsedUrl.searchParams.get("limit") || 50);
      return sendJson(res, 200, { success: true, trades: await getArenaTrades(db, modelId, limit) });
    }

    if ((pathname === "/api/paper-trades/reset" || pathname === "/api/algo-lab/reset") && req.method === "POST") {
      try {
        return sendJson(res, 200, await resetPaperArenaAndNotify(db));
      } catch (err) {
        return sendJson(res, 500, { success: false, message: `가상거래 초기화 실패: ${err.message}` });
      }
    }

    if (pathname === "/api/algo-lab/run-cycle" && req.method === "POST") {
      await runAlwaysOnPaperArenaCycle();
      return sendJson(res, 200, {
        success: true,
        message: "순수 알고리즘 가상 시뮬레이션 1사이클이 실행되었습니다.",
        models: await getArenaLeaderboard(db),
      });
    }

    if (serveStatic(req, res, pathname)) {
      return;
    }

    return sendJson(res, 404, { detail: "Not Found" });
  } catch (err) {
    return sendJson(res, 500, { detail: err.message });
  }
});

// [Antigravity-Doc] 라이브러리 모드(`AUTOCOIN_LIBRARY_MODE=1`)가 아닐 때만 로그 로테이터·HTTP 서버 바인딩·SIGINT/SIGTERM 그레이스풀 셧다운 등록
if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
  startLogRotationScheduler({
    logsDir: path.join(BASE_DIR, "logs"),
    retentionDays: process.env.LOG_RETENTION_DAYS,
    loggerPrefix: "[Backend LogRotator]",
  });
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[Backend] Port ${HOST}:${PORT} already in use (EADDRINUSE). Exiting duplicate process.`);
      process.exit(1);
    }
    console.error("[Backend] HTTP server error:", err?.message || err);
  });
  server.listen(PORT, HOST, () => {
    console.log(`AutoCoinTrade Backend listening on http://${HOST}:${PORT}`);
  });

  const handleGracefulBackendShutdown = async (sig) => {
    if (isBackendShuttingDown) return;
    isBackendShuttingDown = true;
    console.log(`[Backend] Received ${sig}, stopping workers, releasing live executor lease & shutting down...`);
    const forceExitTimer = setTimeout(() => process.exit(0), 2500);
    if (typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    try {
      for (const timer of workerTimers) {
        clearInterval(timer);
      }
      workerTimers = [];
    } catch {}
    try {
      upbitWsHub.stop();
    } catch {}
    try {
      await releaseLiveExecutorLeaseNow();
    } catch {}
    try {
      server.close(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
    } catch {
      clearTimeout(forceExitTimer);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    handleGracefulBackendShutdown("SIGINT").catch(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    handleGracefulBackendShutdown("SIGTERM").catch(() => process.exit(0));
  });
}

// ============================================================================
// 백그라운드 3종 전략 봇 자동매매 스케줄러 워커 (8초 주기)
// ============================================================================
// [Antigravity-Doc] 전략 사이클 실행 플래그 및 업비트 Public 시세(3초 TTL)·캔들(8초 TTL) 메모리 캐시
let isStrategyCycleRunning = false;
const upbitTickersCache = new Map();
const upbitCandlesCache = new Map();

/**
 * [Antigravity-Doc] 업비트 Public REST API를 0.12s 레이트 리밋 + 429/503/네트워크 오류 시 지수 백오프(1s/2s/4s)로 호출한다.
 * @param {string} url 요청 URL
 * @returns {Promise<any|null>}
 */
async function fetchUpbitPublicWithBackoff(url) {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, 120));
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.status === 200) {
        return await resp.json();
      }
      if ((resp.status === 429 || resp.status === 503) && attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      return null;
    } catch {
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
    }
  }
  return null;
}

/**
 * [Antigravity-Doc] 여러 마켓의 실시간 현재가 맵을 조회한다.
 * 우선순위: 1) WebSocket 허브 최신 틱(stale 아닐 때) -> 2) 3초 메모리 캐시 -> 3) 업비트 `/v1/ticker` 일괄 REST 호출.
 * @param {string[]} markets
 * @returns {Promise<Map<string, object>>}
 */
async function fetchUpbitTickersMap(markets) {
  const map = new Map();
  if (!markets || markets.length === 0) return map;
  const now = Date.now();
  const wsFresh = !upbitWsHub.isStale();
  const missing = [];
  for (const m of markets) {
    if (wsFresh) {
      const wsTk = upbitWsHub.getLatestTicker(m);
      if (wsTk && Number(wsTk.trade_price) > 0 && Number(wsTk.acc_trade_price_24h) > 0) {
        upbitTickersCache.set(m, { ts: now, data: wsTk });
        map.set(m, wsTk);
        continue;
      }
    }
    const cached = upbitTickersCache.get(m);
    if (cached && now - cached.ts < 3000) {
      map.set(m, cached.data);
    } else {
      missing.push(m);
    }
  }
  if (missing.length === 0) return map;

  const data = await fetchUpbitPublicWithBackoff(
    `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(missing.join(","))}`
  );
  if (Array.isArray(data)) {
    const fetchedAt = Date.now();
    for (const item of data) {
      upbitTickersCache.set(item.market, { ts: fetchedAt, data: item });
      map.set(item.market, item);
    }
  }
  for (const m of missing) {
    if (!map.has(m)) {
      const stale = upbitTickersCache.get(m);
      if (stale?.data) map.set(m, stale.data);
    }
  }
  return map;
}

/**
 * [Antigravity-Doc] 업비트 캔들 데이터를 조회해 과거->최신 오름차순으로 정렬하고 8초간 캐싱한다.
 * @param {string} market 예: "KRW-BTC"
 * @param {string} [unit="days"] 업비트 캔들 단위("days", "minutes/15", "minutes/240" 등)
 * @param {number} [count=8] 조회 봉 수 (최소 8)
 * @returns {Promise<Array<object>>}
 */
async function fetchUpbitCandlesSorted(market, unit = "days", count = 8) {
  const safeCount = Math.max(count, 8);
  const cacheKey = `${market}:${unit}:${safeCount}`;
  const cached = upbitCandlesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 8000) {
    return cached.rows;
  }

  const rows = await fetchUpbitPublicWithBackoff(
    `https://api.upbit.com/v1/candles/${unit}?market=${encodeURIComponent(market)}&count=${safeCount}`
  );
  if (Array.isArray(rows) && rows.length >= 8) {
    const sorted = rows.slice().reverse(); // 과거 -> 최신 오름차순 (index 0이 iloc[-8] 기준 시점)
    upbitCandlesCache.set(cacheKey, { ts: Date.now(), rows: sorted });
    return sorted;
  }
  return cached?.rows || [];
}

/**
 * [Antigravity-Doc] 종가 배열(`closes`)로 단순 상대강도지수(RSI)를 계산한다.
 * @param {number[]} closes 과거->최신 종가 배열
 * @param {number} [period=7] 기간
 * @returns {number} 0~100
 */
function computeRsi(closes, period = 7) {
  if (!Array.isArray(closes) || closes.length < 2) return 50.0;
  let gainSum = 0;
  let lossSum = 0;
  const startIdx = Math.max(1, closes.length - period);
  let cnt = 0;
  for (let i = startIdx; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
    cnt++;
  }
  if (cnt === 0 || lossSum === 0) return lossSum === 0 ? 100.0 : 50.0;
  const rs = (gainSum / cnt) / (lossSum / cnt);
  return 100.0 - 100.0 / (1.0 + rs);
}

/**
 * [Antigravity-Doc] 봇의 가용 원화(`virtual_krw`), 배정 비율, AI 장세 비중 배수(`aiMultiplier`), ATR 변동성 배수를 종합해
 * 안전한 1회 실전 매수 주문 금액(KRW)을 산출한다.
 * - 업비트 최소주문(5,000원) 대비 -4.5% 손절 시에도 매도 가능하도록 최소 5,250원(+수수료 0.05%) 버퍼를 보장한다.
 * @param {object} bot
 * @param {number|null} [ratio=null]
 * @param {number} [aiMultiplier=1.0]
 * @param {{atr14?:number, currentPrice?:number, targetAtrPct?:number}} [options={}]
 * @returns {number} 주문 가능 금액(KRW, 불가 시 0)
 */
function getSafeOrderKrw(bot, ratio = null, aiMultiplier = 1.0, options = {}) {
  const rawVirtual = Number(bot.virtual_krw || 0);
  const virtualKrw = Number.isFinite(rawVirtual) ? Math.floor(rawVirtual) : 0;
  const rawMult = Number(aiMultiplier ?? 1.0);
  const mult = Number.isFinite(rawMult) ? Math.max(0.0, Math.min(1.0, rawMult)) : 0.0;
  // 업비트 최소주문(5,000원) 대비 -4.5% 손절 시에도 5,000원 이상으로 매도 가능하도록 최소주문 버퍼(5,250원 + 수수료) 보장
  const MIN_UPBIT_ORDER_KRW = 5000;
  const SAFE_ADJUSTED_MIN_KRW = 5250;
  if (mult <= 0 || virtualKrw < Math.ceil(SAFE_ADJUSTED_MIN_KRW * 1.0005)) return 0;

  const rawCfgOrderKrw = Number(bot.config?.order_krw || 0);
  const cfgOrderKrw = Number.isFinite(rawCfgOrderKrw) ? rawCfgOrderKrw : 0;
  const chosenRatio = ratio !== null && ratio !== undefined ? ratio : bot.config?.order_ratio ?? 0.35;
  const rawRatio = Number(chosenRatio);
  const safeRatio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 0.35;
  const normRatio = Math.min(1.0, Math.max(0.05, safeRatio > 1 ? safeRatio / 100.0 : safeRatio));
  const rawAlloc = Number(bot.allocated_capital || 0);
  const baseCapital = Math.max(virtualKrw, Number.isFinite(rawAlloc) ? Math.floor(rawAlloc) : 0);
  const slotBudgetKrw = cfgOrderKrw >= MIN_UPBIT_ORDER_KRW ? Math.min(cfgOrderKrw, virtualKrw) : Math.min(virtualKrw, Math.floor(baseCapital * normRatio));

  const atrInfo =
    options && Number(options.atr14) > 0 && Number(options.currentPrice) > 0
      ? computeAtrVolatilityMultiplier({
          atr14: options.atr14,
          currentPrice: options.currentPrice,
          targetAtrPct: options.targetAtrPct || 1.8,
        })
      : { atr_sizing_mult: 1.0, atr_pct: 0 };
  const atrMult = Number(atrInfo.atr_sizing_mult || 1.0);

  const maxAffordable = Math.floor(virtualKrw / 1.0005);
  let orderKrw = Math.floor((slotBudgetKrw * mult * atrMult) / 1.0005);

  if (!Number.isFinite(orderKrw) || orderKrw < SAFE_ADJUSTED_MIN_KRW) {
    orderKrw = maxAffordable >= SAFE_ADJUSTED_MIN_KRW ? SAFE_ADJUSTED_MIN_KRW : 0;
  }
  return Math.max(0, Math.min(orderKrw, maxAffordable));
}

// ------------------------------------------------------------------
// [듀얼 AI 동적 매수 게이트웨이 & 시장 체제 상태 조회]
// ------------------------------------------------------------------
// [Antigravity-Doc] 장세 필터(`checkMarketRegimeFilter`) 20초 메모리 캐시 상태 객체
let cachedRegimeState = {
  checkedAtMs: 0,
  allowBuy: true,
  finalRiskAlert: false,
  finalAction: "NORMAL",
  marketRegime: "SIDEWAYS",
  belowMa20Day: false,
  belowMa60_4h: false,
  btcPrice: 0,
  ma20Day: 0,
  ma60_4h: 0,
  reason: "BTC 시장 체제 확인 중",
  multiplier: 1.0,
  botOverrides: { ...DEFAULT_BOT_OVERRIDES },
  blacklistTickers: [],
};

/**
 * [Antigravity-Doc] BTC 일봉 20MA / 4시간 60MA 지표와 DB `market_regime_filter(id=1)` 듀얼 AI 판단을 통합 조회한다.
 * 20초 캐시(`cachedRegimeState`)를 사용하며, AI 분석 갱신 시 `checkedAtMs=0`으로 즉시 무효화된다.
 * @param {Map<string, object>|null} [tickerMap=null]
 * @param {{skipUpbitApi?:boolean}} [options={}]
 * @returns {Promise<object>} `allowBuy`, `multiplier`, `botOverrides`, `blacklistTickers` 등 포함
 */
async function checkMarketRegimeFilter(tickerMap = null, options = {}) {
  const nowMs = Date.now();
  if (!options?.skipUpbitApi && nowMs - cachedRegimeState.checkedAtMs < 20000 && cachedRegimeState.btcPrice > 0) {
    return cachedRegimeState;
  }

  try {
    const dayCandles = options?.skipUpbitApi ? [] : await fetchUpbitCandlesSorted("KRW-BTC", "days", 20);
    const h4Candles = options?.skipUpbitApi ? [] : await fetchUpbitCandlesSorted("KRW-BTC", "minutes/240", 60);

    let btcPrice = cachedRegimeState.btcPrice || 0;
    let ma20Day = cachedRegimeState.ma20Day || 0;
    let ma60_4h = cachedRegimeState.ma60_4h || 0;

    if (dayCandles.length >= 20) {
      const tkBtc = tickerMap ? tickerMap.get("KRW-BTC") : null;
      btcPrice = Number(tkBtc?.trade_price || dayCandles[dayCandles.length - 1].trade_price || 0);
      const dayCloses = dayCandles.slice(-20).map((c) => Number(c.trade_price));
      ma20Day = dayCloses.reduce((a, b) => a + b, 0) / dayCloses.length;
    }
    if (h4Candles.length >= 20) {
      const h4Closes = h4Candles.slice(-60).map((c) => Number(c.trade_price));
      ma60_4h = h4Closes.reduce((a, b) => a + b, 0) / h4Closes.length;
    }

    const belowMa20Day = btcPrice > 0 && ma20Day > 0 && btcPrice < ma20Day;
    const belowMa60_4h = btcPrice > 0 && ma60_4h > 0 && btcPrice < ma60_4h;

    // 듀얼 AI 필터(market_regime_filter) 교차 검증 상태 조회 (bot_01 ~ bot_10 개별 스위치 우선 반영)
    const db = getDb();
    let regimeRow = null;
    try {
      regimeRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    } catch (dbErr) {
      console.warn("[MarketRegime] DB read failed:", dbErr?.message || dbErr);
    }

    const marketRegime = String(regimeRow?.market_regime || (belowMa20Day ? "BEAR" : "SIDEWAYS")).toUpperCase();
    const finalRiskAlert = regimeRow
      ? Number(regimeRow.final_risk_alert ?? regimeRow.risk_alert ?? 0) === 1
      : false;
    const finalAction = String(
      regimeRow?.recommended_action || (belowMa20Day ? "REDUCE_SIZE" : "NORMAL")
    ).toUpperCase();
    const multiplier = regimeRow
      ? Math.max(0.0, Math.min(1.0, Number(regimeRow.final_position_multiplier ?? regimeRow.position_size_multiplier ?? 1.0)))
      : belowMa20Day
      ? 0.5
      : 1.0;

    const botOverrides = normalizeBotOverrides(
      regimeRow?.final_bot_overrides_json || regimeRow?.bot_overrides_json
    );
    const blacklistTickers = normalizeBlacklistTickers(regimeRow?.blacklist_tickers_json);

    const globalBuyBlocked =
      finalRiskAlert ||
      finalAction === "HALT_NEW_BUYS" ||
      finalAction === "EMERGENCY_CLOSE_ALL" ||
      multiplier <= 0.0;

    const techLabel = belowMa20Day
      ? `일봉20MA(${Math.floor(ma20Day).toLocaleString("ko-KR")}원) 하회`
      : belowMa60_4h
      ? `4시간60MA(${Math.floor(ma60_4h).toLocaleString("ko-KR")}원) 하회`
      : `추세선 상회`;

    cachedRegimeState = {
      checkedAtMs: nowMs,
      allowBuy: !globalBuyBlocked,
      finalRiskAlert,
      finalAction,
      marketRegime,
      belowMa20Day,
      belowMa60_4h,
      btcPrice,
      ma20Day,
      ma60_4h,
      reason:
        regimeRow?.reason ||
        `[${marketRegime}] BTC ${techLabel} · 투자 비중 ${Math.round(multiplier * 100)}%`,
      multiplier: globalBuyBlocked ? 0.0 : multiplier,
      botOverrides,
      blacklistTickers,
    };
    return cachedRegimeState;
  } catch (regimeErr) {
    console.warn("[MarketRegime] Filter evaluation error (returning cached state):", regimeErr?.message || regimeErr);
    return cachedRegimeState;
  }
}

// ------------------------------------------------------------------
// [손실 방어 패치 2] 시장가 주문 -> 최유리 지정가 주문(매수 1호가) 전환 및 미체결 취소(cancel_order)
// ------------------------------------------------------------------
/**
 * [Antigravity-Doc] 업비트 KRW 마켓 가격대별 호가 단위(Tick Size)를 반환한다.
 * @param {number} price
 * @returns {number}
 */
function getUpbitKrwTickSize(price) {
  const p = Number(price || 0);
  if (p >= 2000000) return 1000;
  if (p >= 1000000) return 500;
  if (p >= 500000) return 100;
  if (p >= 100000) return 50;
  if (p >= 10000) return 10;
  if (p >= 1000) return 1;
  if (p >= 10) return 0.1;
  if (p >= 1) return 0.001;
  return 0.0001;
}

/**
 * [Antigravity-Doc] 주어진 가격을 업비트 KRW 호가 단위에 맞게 내림(floor) 정규화한다.
 * @param {number} price
 * @returns {number}
 */
function normalizeUpbitKrwTick(price) {
  const p = Number(price || 0);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const tick = getUpbitKrwTickSize(p);
  if (tick >= 1) {
    return Math.floor(p / tick) * tick;
  }
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const factor = Math.pow(10, decimals);
  return Number((Math.floor((p * factor) + 1e-9) / factor).toFixed(decimals));
}

/**
 * [Antigravity-Doc] WebSocket 오더북(우선) 또는 REST `/v1/orderbook`에서 최유리 호가(매수 1호가 `bid` / 매도 1호가 `ask`)를 조회한다.
 * @param {string} market
 * @param {"bid"|"ask"} [side="bid"]
 * @param {number} [fallbackPrice=0]
 * @returns {Promise<number>}
 */
async function fetchUpbitBestPrice(market, side = "bid", fallbackPrice = 0) {
  const priceKey = side === "ask" ? "ask_price" : "bid_price";
  if (!upbitWsHub.isStale()) {
    const wsOb = upbitWsHub.getLatestOrderbook(market);
    const wsPrice = Number(wsOb?.orderbook_units?.[0]?.[priceKey] || 0);
    if (wsPrice > 0) {
      return wsPrice;
    }
  }
  try {
    await new Promise((r) => setTimeout(r, 120));
    const resp = await fetch(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(market)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 200) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        const units = data[0]?.orderbook_units;
        if (Array.isArray(units) && units.length > 0 && Number(units[0]?.[priceKey]) > 0) {
          return Number(units[0][priceKey]);
        }
      }
    }
  } catch (obErr) {
    console.warn(`[Orderbook] Best(${side}) REST fallback failed (${market}):`, obErr?.message || obErr);
  }
  return normalizeUpbitKrwTick(fallbackPrice);
}

/**
 * [Antigravity-Doc] 지정 마켓의 최유리 매수 1호가(Best Bid)를 조회한다.
 */
async function fetchUpbitBestBidPrice(market, fallbackPrice = 0) {
  return fetchUpbitBestPrice(market, "bid", fallbackPrice);
}

/**
 * [Antigravity-Doc] 지정 마켓의 최유리 매도 1호가(Best Ask)를 조회한다.
 */
async function fetchUpbitBestAskPrice(market, fallbackPrice = 0) {
  return fetchUpbitBestPrice(market, "ask", fallbackPrice);
}

/**
 * [Antigravity-Doc] 업비트 미체결 지정가 주문을 `DELETE /v1/order`로 취소한다.
 * @param {string} orderUuid 취소할 업비트 주문 UUID
 * @param {object} cfg 복호화된 런타임 설정(`access_key`, `secret_key`)
 * @returns {Promise<boolean>} 취소 API 수용 여부
 */
async function cancelUpbitOrder(orderUuid, cfg) {
  if (!orderUuid) return false;
  try {
    await new Promise((r) => setTimeout(r, 120));
    const params = { uuid: orderUuid };
    const token = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), params);
    const resp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    return resp.status === 200 || resp.status === 201;
  } catch (cancelErr) {
    console.warn(`[UpbitCancel] Order cancel failed (uuid=${orderUuid}):`, cancelErr?.message || cancelErr);
    return false;
  }
}

/**
 * [Antigravity-Doc] 봇 매수 주문 실행 메인 엔진(가상거래/실거래 통합).
 * 실전(live) 모드 안전 실행 파이프라인(2PC + 5중 가드레일):
 *  1. AI 장세 게이트웨이(`allowBuy`, `botOverrides`, `blacklistTickers`) 및 호가 품질(OBI/스프레드) 사전 검사.
 *  2. Step A (`claimLiveBuyIntentAtomic`): 단일 `BEGIN IMMEDIATE` 트랜잭션에서 5중 가드레일 검증 + `live_order_intents(PENDING)` 선점 + `virtual_krw` 선차감.
 *  3. Step B: 업비트 `POST /v1/orders`에 `identifier: intentId` 포함 최유리 매수 1호가 지정가 주문 전송.
 *     - 4xx 확정 거절 -> 즉시 환불(`refundFailedOrCanceledBuyIntentAtomic`).
 *     - 5xx/네트워크 타임아웃 -> 재시도 금지 및 `UNKNOWN_TIMEOUT` 잠금(추후 `identifier` 대사).
 *  4. 체결 폴링(최대 40초): 약 12초 미체결 시 매도 1호가(+0.35% 상한) 1회 정정 재주문, 최종 미체결 시 취소 후 0체결 확인 시에만 환불.
 *  5. Step C (`confirmBuyIntentAndRecordPositionAtomic`): 실제 체결가/수수료/슬리피지 기록 및 차액 환불, 멀티채널 알림 발송.
 * @param {object} bot 대상 봇 객체
 * @param {string} market 예: "KRW-BTC"
 * @param {number} orderKrw 주문 금액(KRW)
 * @param {number} currentPrice 현재가
 * @param {string|null} [buyReason=null] 매수 사유
 * @param {object} [options={}]
 * @returns {Promise<boolean>} 체결 완료 여부
 */
export async function executeBotBuyOrder(bot, market, orderKrw, currentPrice, buyReason = null, options = {}) {
  const db = getDb();
  const isLive = isLiveMode();

  const latestBot = (await getBots(isLive ? "live" : "paper")).find((b) => b.bot_id === bot.bot_id);
  if (!latestBot) {
    if (isLive) {
      console.warn(`[LiveBuySkip][${bot?.bot_id || "UNKNOWN"}][${market || ""}] 봇 레코드 조회 실패 (latestBot=null)`);
    }
    return false;
  }

  // 실전 모드에서 virtual_krw < 0 이상치는 아래 5중 가드레일(claimLiveBuyIntentAtomic)이 즉시 비상 정지(Auto Kill-Switch)를 발동하도록 통과
  const hasNegativeLiveBalance = isLive && Number(latestBot.virtual_krw || 0) < 0;
  const normMkt = String(market || "").trim().toUpperCase();
  if (
    !hasNegativeLiveBalance &&
    (Number(latestBot.is_selected_for_live) !== 1 ||
      Number(latestBot.is_running) !== 1 ||
      (!isLive && Number(latestBot.virtual_krw || 0) < orderKrw))
  ) {
    if (isLive) {
      console.warn(
        `[LiveBuySkip][${bot.bot_id}][${normMkt}] 봇 비활성 상태 (is_selected=${latestBot.is_selected_for_live}, is_running=${latestBot.is_running})`
      );
    }
    return false;
  }

  // 공통 듀얼 AI / 시장 체제 게이트웨이 재확인 (bot_overrides / blacklist / risk_alert)
  const regimeInfo = await checkMarketRegimeFilter(null, options);
  const isBotBlocked = regimeInfo.botOverrides?.[bot.bot_id] === "BLOCK";
  const isBlacklisted = (regimeInfo.blacklistTickers || []).includes(normMkt);

  if (!hasNegativeLiveBalance && (regimeInfo.finalRiskAlert || !regimeInfo.allowBuy)) {
    if (isLive) {
      console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] AI 전역 매수 차단 (${regimeInfo.finalAction}): ${regimeInfo.reason}`);
    }
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      regimeInfo.reason,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }
  if (!hasNegativeLiveBalance && isBotBlocked) {
    if (isLive) {
      console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] AI 개별 봇 BLOCK 판정 (${regimeInfo.marketRegime}/${regimeInfo.finalAction})`);
    }
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      "AI 장세 필터에 의해 신규 진입 보류(보유 포지션은 정상 감시)",
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }
  if (!hasNegativeLiveBalance && isBlacklisted) {
    if (isLive) {
      console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] AI 블랙리스트 종목 차단`);
    }
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `[블랙리스트 종목 차단] ${normMkt} 신규 진입 보류(보유 포지션은 정상 감시)`,
      nowKSTString(),
      bot.bot_id
    );
    markBotDiagnosticStatus(bot.bot_id);
    return false;
  }

  const posTable = isLive ? "bot_positions" : "paper_bot_positions";

  // 가상거래 모드 원금 한도 검증 (실거래 모드는 claimLiveBuyIntentAtomic BEGIN IMMEDIATE 내부에서 원자적 검증)
  if (!isLive) {
    const invRow = await db
      .prepare(`SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM ${posTable} WHERE bot_id = ? AND status = 'OPEN'`)
      .get(bot.bot_id);
    const currentInvested = Number(invRow?.invested || 0);
    if (currentInvested + orderKrw > Number(latestBot.allocated_capital || 0)) {
      console.warn(
        `[PaperBuySkip][${bot.bot_id}][${normMkt}] 배정 원금 초과 (invested=${currentInvested}, orderKrw=${orderKrw}, allocated=${latestBot.allocated_capital})`
      );
      return false;
    }
  }

  const cfg = getRuntimeConfig();

  // 호가 불균형(OBI) 및 Bid-Ask 스프레드 과열 체결 품질 가드 (WS stale/미연결 시 REST 1회 폴백)
  let candidateOrderbook =
    options?.orderbook || (!options?.skipUpbitApi && !upbitWsHub.isStale() ? upbitWsHub.getLatestOrderbook(market) : null);
  if (!hasNegativeLiveBalance && !candidateOrderbook && !options?.skipUpbitApi) {
    try {
      const obResp = await fetch(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(market)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (obResp.status === 200) {
        const obData = await obResp.json();
        if (Array.isArray(obData) && obData.length > 0 && Array.isArray(obData[0]?.orderbook_units)) {
          candidateOrderbook = obData[0];
        }
      }
    } catch (obFallbackErr) {
      console.warn(`[OrderbookGuard] REST fallback failed (${market}):`, obFallbackErr?.message || obFallbackErr);
    }
  }
  if (!hasNegativeLiveBalance && candidateOrderbook) {
    const obQuality = analyzeOrderbookQuality(candidateOrderbook, orderKrw, {
      botId: bot.bot_id,
      maxSpreadPct: options?.maxSpreadPct,
      minObi: options?.minObi,
    });
    if (obQuality.blocked) {
      if (isLive) {
        console.warn(
          `[LiveBuySkip][${bot.bot_id}][${normMkt}] 호가 품질 가드 차단: ${obQuality.reason} (spread=${obQuality.spread_pct}%, obi=${obQuality.obi})`
        );
      }
      await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `[호가 품질 가드] ${market} 진입 보류: ${obQuality.reason}`,
        nowKSTString(),
        bot.bot_id
      );
      markBotDiagnosticStatus(bot.bot_id);
      return false;
    }
  }

  if (!isLive) {
    // [가상거래 모드 (Paper Trading)]
    // 분리된 전용 가상 원장(paper_trades, paper_bot_positions)에 체결 기록
    const bestBidPrice = options?.skipUpbitApi
      ? normalizeUpbitKrwTick(currentPrice)
      : (await fetchUpbitBestBidPrice(market, currentPrice)) || currentPrice;
    if (!bestBidPrice || bestBidPrice <= 0) {
      console.warn(`[PaperBuySkip][${bot.bot_id}][${normMkt}] 유효한 매수 1호가 조회 실패 (bestBidPrice=${bestBidPrice})`);
      return false;
    }

    const rawVol = Math.floor(orderKrw) / bestBidPrice;
    let limitVolNum = Number(floorTo8DecimalsStr(rawVol));
    if (limitVolNum * bestBidPrice < 5000) {
      const stepped = Number(floorTo8DecimalsStr(limitVolNum + 0.00000001));
      if (Math.ceil(stepped * bestBidPrice * 1.0005) <= Math.floor(Number(latestBot.virtual_krw || orderKrw))) {
        limitVolNum = stepped;
      } else {
        console.warn(`[PaperBuySkip][${bot.bot_id}][${normMkt}] 수량 절삭 후 최소 주문금액(5,000원) 미달`);
        return false;
      }
    }
    const limitVolumeStr = floorTo8DecimalsStr(limitVolNum);
    const actualBuyAmount = Math.floor(limitVolNum * bestBidPrice);
    const fee = Math.floor(actualBuyAmount * 0.0005);
    const orderUuid = `paper-bid-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = nowKSTString();

    const insertTrade = await db.prepare(`
      INSERT INTO paper_trades (
        bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status, buy_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING', ?)
    `);
    const tradeRes = await insertTrade.run(
      bot.bot_id,
      market,
      orderUuid,
      bestBidPrice,
      limitVolumeStr,
      actualBuyAmount,
      now,
      buyReason || null
    );
    const tradeId = Number(tradeRes.lastInsertRowid);

    const insertPos = await db.prepare(`
      INSERT INTO paper_bot_positions (
        bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, buy_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `);
    await insertPos.run(
      bot.bot_id,
      market,
      orderUuid,
      limitVolumeStr,
      bestBidPrice,
      actualBuyAmount,
      fee,
      tradeId,
      now,
      buyReason || null
    );

    const inv = await db
      .prepare(
        "SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN'"
      )
      .get(bot.bot_id);
    const newVirtualKrw = Math.max(0, Math.floor(Number(latestBot.allocated_capital || 0) - Number(inv?.invested || 0)));

    await db.prepare("UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      newVirtualKrw,
      `[가상체결] ${market} ${bestBidPrice.toLocaleString("ko-KR")}원 매수 체결 (${actualBuyAmount.toLocaleString("ko-KR")}원 / 가상잔고 ${newVirtualKrw.toLocaleString("ko-KR")}원)`,
      now,
      bot.bot_id
    );
    return true;
  }

  // [실거래 모드 (Live Trading)] — 5중 하드 가드레일(Hard Guardrail) + 2단계 커밋(2PC)
  // 매수 1호가(Best Bid) 조회 후 Step A(원자적 PENDING 선점 + 선차감) -> Step B(identifier 주문 전송) -> Step C(확정/환불/타임아웃 잠금)
  const bestBidPrice = options?.skipUpbitApi
    ? normalizeUpbitKrwTick(currentPrice)
    : await fetchUpbitBestBidPrice(market, currentPrice);
  if (!bestBidPrice || bestBidPrice <= 0) {
    console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 유효한 매수 1호가 조회 실패 (bestBidPrice=${bestBidPrice})`);
    return false;
  }

  const guardrailTxDeps = {
    runtimeConfig: cfg,
    withDbWriteLock,
    beginWriteTx,
    commitWriteTx,
    rollbackWriteTx,
    syncBotAccountsFromBots,
    onKillSwitch: (ks) => {
      dispatchMultiChannelNotification(
        db,
        {
          eventType: "CIRCUIT_BREAKER",
          botId: (ks?.halted_bots || [bot.bot_id])[0] || bot.bot_id,
          botName: latestBot.nickname || latestBot.name || bot.bot_id,
          market,
          reason: ks?.reason || "가드레일 비상 정지 발동",
        },
        { webPushBroadcastFn: broadcastWebPushNotification }
      ).catch(() => {});
    },
  };

  // [Step A] 단일 BEGIN IMMEDIATE 트랜잭션으로 5중 가드레일 검증 + live_order_intents(PENDING) 선점 + virtual_krw 선차감
  const claim = await claimLiveBuyIntentAtomic(
    db,
    {
      botId: bot.bot_id,
      market,
      orderKrw,
      bestBidPrice,
      floorTo8DecimalsStr,
      options,
      inMemoryCooldownMap: liveBotCooldownMap,
    },
    guardrailTxDeps
  );

  if (!claim || !claim.ok) {
    console.warn(
      `[LiveBuySkip][${bot.bot_id}][${normMkt}] 가드레일 선점 차단 (${claim?.code || "UNKNOWN"}): ${claim?.reason || ""}`
    );
    return false;
  }

  const { intentId, limitVolumeStr, limitVolNum, reservedKrw, stepLevel } = claim;
  const limitPriceStr = String(bestBidPrice);

  let orderUuid = "";
  let execPrice = Number(bestBidPrice);
  let execVolume = limitVolumeStr;
  let actualBuyAmount = Math.floor(limitVolNum * bestBidPrice);
  let fee = Math.floor(actualBuyAmount * 0.0005);

  if (options?.skipUpbitApi) {
    orderUuid = `sim-bid-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  } else {
    const rateDelayMs = options?.skipDelay ? 0 : 120;
    const pollAttempts = Math.max(1, Number(options?.pollAttempts ?? 10));
    const pollIntervalMs = Number.isFinite(Number(options?.pollIntervalMs)) ? Math.max(0, Number(options.pollIntervalMs)) : 4000;
    const postCancelDelayMs = options?.skipDelay ? 0 : 500;

    try {
      if (rateDelayMs > 0) await new Promise((r) => setTimeout(r, rateDelayMs));
      // [Step B] 업비트 POST /v1/orders 에 반드시 identifier: intentId 포함 (절대 맹목 재시도 금지)
      const params = {
        market,
        side: "bid",
        volume: limitVolumeStr,
        price: limitPriceStr,
        ord_type: "limit",
        identifier: intentId,
      };
      const token = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), params);
      const resp = await fetch("https://api.upbit.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(8000),
      });

      if (resp.status >= 400 && resp.status < 500) {
        // 명확한 4xx 거절: 업비트에 주문 미생성 확정 -> FAILED_NOT_CREATED 및 선차감 원화 정확히 1회 환불
        const errData = await resp.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
        console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 업비트 4xx 주문 거절 (HTTP ${resp.status}): ${errMsg}`);
        await refundFailedOrCanceledBuyIntentAtomic(
          db,
          {
            intentId,
            botId: bot.bot_id,
            nextStatus: "FAILED_NOT_CREATED",
            errorMessage: `Upbit 4xx(${resp.status}): ${errMsg}`,
            statusMsg: `${market} 지정가 매수 주문 거절(선차감 환불 완료): ${errMsg}`,
          },
          guardrailTxDeps
        );
        markBotDiagnosticStatus(bot.bot_id);
        return false;
      }

      if (resp.status !== 200 && resp.status !== 201) {
        // HTTP 5xx 등 생성 여부 불명확 -> 절대 즉시 재주문/환불 금지, UNKNOWN_TIMEOUT 잠금
        const errData = await resp.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
        console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 업비트 응답 불확실 (HTTP ${resp.status}, UNKNOWN_TIMEOUT 잠금): ${errMsg}`);
        await markLiveIntentUnknownTimeout(
          db,
          { intentId, botId: bot.bot_id, market, errorMessage: `Upbit uncertain status ${resp.status}: ${errMsg}` },
          guardrailTxDeps
        );
        return false;
      }

      const orderData = await resp.json();
      orderUuid = orderData?.uuid || "";
      if (!orderUuid) {
        console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 업비트 주문 응답 uuid 누락 (UNKNOWN_TIMEOUT 잠금)`);
        await markLiveIntentUnknownTimeout(
          db,
          { intentId, botId: bot.bot_id, market, errorMessage: "Upbit 200/201 response missing uuid" },
          guardrailTxDeps
        );
        return false;
      }

      await markLiveIntentSubmitted(db, { intentId, upbitOrderUuid: orderUuid }, guardrailTxDeps);

      await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${market} 매수 1호가(${bestBidPrice.toLocaleString("ko-KR")}원) 지정가 주문 접수 — 체결 대기 중(최대 40초)`,
        nowKSTString(),
        bot.bot_id
      );

      // 30초~40초 동안 체결 확인 후 미체결 시 조기(약 12초 경과) 매도 1호가 1회 정정 재주문, 최종 미체결 시 취소(cancel_order)
      let isOrderDone = false;
      let confirmedCancelZero = false;
      let retriedAtBestAsk = false;
      let activeLimitPrice = bestBidPrice;
      const askRetryAttemptIdx = pollAttempts >= 4 ? Math.min(2, Math.floor(pollAttempts / 2) - 1) : -1;
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
        try {
          const qParams = { uuid: orderUuid };
          const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
          const oResp = await fetch(
            `https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`,
            {
              headers: {
                Authorization: `Bearer ${qToken}`,
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(8000),
            }
          );
          if (oResp.status === 200) {
            const oDetail = await oResp.json();
            const state = String(oDetail?.state || "");
            const filledVol = Number(oDetail?.executed_volume || 0);
            if (state === "done" || state === "cancel") {
              isOrderDone = true;
              if (filledVol > 0) {
                execVolume = String(oDetail.executed_volume);
                const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
                const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
                if (totalFunds > 0) {
                  actualBuyAmount = Math.floor(totalFunds);
                  execPrice = normalizeExecPrice(totalFunds / filledVol, activeLimitPrice);
                } else {
                  actualBuyAmount = Math.floor(filledVol * activeLimitPrice);
                }
                if (oDetail.paid_fee !== undefined) {
                  fee = Math.ceil(Number(oDetail.paid_fee || fee));
                }
              } else {
                execVolume = "0";
                confirmedCancelZero = true;
              }
              break;
            }
            // 약 12초(3번째 폴링) 시점까지 전량 미체결(wait, filledVol=0)이면 매도 1호가(bestAsk)로 1회 정정 재주문
            if (
              !retriedAtBestAsk &&
              askRetryAttemptIdx >= 0 &&
              attempt === askRetryAttemptIdx &&
              state === "wait" &&
              filledVol === 0
            ) {
              retriedAtBestAsk = true;
              const bestAskPrice = await fetchUpbitBestAskPrice(market, activeLimitPrice);
              const tickSize = getUpbitKrwTickSize(activeLimitPrice);
              const maxAskRetryPrice = Math.max(activeLimitPrice * 1.0035, activeLimitPrice + tickSize * 3);
              if (!(bestAskPrice > activeLimitPrice && bestAskPrice <= maxAskRetryPrice)) {
                console.warn(
                  `[LiveBuyRetrySkip][${bot.bot_id}][${normMkt}] 매도1호가 정정 스킵 (bestAsk=${bestAskPrice}, activeBid=${activeLimitPrice}, maxAllowed=${maxAskRetryPrice.toFixed(4)})`
                );
              } else {
                const askVolStr = floorTo8DecimalsStr(Math.floor(reservedKrw / 1.0005) / bestAskPrice);
                const askVolNum = Number(askVolStr);
                if (!(askVolNum > 0 && askVolNum * bestAskPrice >= 5000)) {
                  console.warn(
                    `[LiveBuyRetrySkip][${bot.bot_id}][${normMkt}] 매도1호가 정정 스킵: 최소주문금액(5,000원) 미달 (notional=${Math.floor(askVolNum * bestAskPrice)}원)`
                  );
                } else {
                  const canceled = await cancelUpbitOrder(orderUuid, cfg);
                  if (canceled) {
                    if (postCancelDelayMs > 0) await new Promise((r) => setTimeout(r, postCancelDelayMs));
                    const cToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), { uuid: orderUuid });
                    const cResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`, {
                      headers: { Authorization: `Bearer ${cToken}`, Accept: "application/json" },
                      signal: AbortSignal.timeout(8000),
                    });
                    if (cResp.status === 200) {
                      const cDetail = await cResp.json();
                      const cFilled = Number(cDetail?.executed_volume || 0);
                      if (cFilled > 0) {
                        isOrderDone = true;
                        execVolume = String(cDetail.executed_volume);
                        const cTradesArr = Array.isArray(cDetail.trades) ? cDetail.trades : [];
                        const cTotalFunds = cTradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
                        if (cTotalFunds > 0) {
                          actualBuyAmount = Math.floor(cTotalFunds);
                          execPrice = normalizeExecPrice(cTotalFunds / cFilled, activeLimitPrice);
                        } else {
                          actualBuyAmount = Math.floor(cFilled * activeLimitPrice);
                          execPrice = activeLimitPrice;
                        }
                        if (cDetail.paid_fee !== undefined) {
                          fee = Math.ceil(Number(cDetail.paid_fee || fee));
                        }
                        break;
                      }
                      if (String(cDetail?.state || "") === "cancel") {
                        const retryIdentifier = `${intentId.slice(0, 36)}-ask1`;
                        const retryParams = {
                          market,
                          side: "bid",
                          volume: askVolStr,
                          price: String(bestAskPrice),
                          ord_type: "limit",
                          identifier: retryIdentifier,
                        };
                        const rToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), retryParams);
                        let rResp = null;
                        try {
                          rResp = await fetch("https://api.upbit.com/v1/orders", {
                            method: "POST",
                            headers: {
                              Authorization: `Bearer ${rToken}`,
                              "Content-Type": "application/json",
                              Accept: "application/json",
                            },
                            body: JSON.stringify(retryParams),
                            signal: AbortSignal.timeout(8000),
                          });
                        } catch (retryNetErr) {
                          console.warn(
                            `[LiveBuyRetry][${bot.bot_id}][${normMkt}] 매도1호가 정정 재주문 네트워크 예외 (id=${retryIdentifier}): ${retryNetErr?.message || retryNetErr} -> UNKNOWN_TIMEOUT 잠금`
                          );
                          await markLiveIntentUnknownTimeout(
                            db,
                            {
                              intentId,
                              botId: bot.bot_id,
                              market,
                              errorMessage: `Retry ask1 network error (identifier=${retryIdentifier}): ${retryNetErr?.message || retryNetErr}`,
                            },
                            guardrailTxDeps
                          );
                          return false;
                        }
                        if (rResp.status === 200 || rResp.status === 201) {
                          const rData = await rResp.json().catch(() => ({}));
                          if (rData?.uuid) {
                            orderUuid = rData.uuid;
                            activeLimitPrice = bestAskPrice;
                            execPrice = bestAskPrice;
                            await markLiveIntentSubmitted(db, { intentId, upbitOrderUuid: orderUuid }, guardrailTxDeps);
                            await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
                              `${market} 매수 1호가 미체결 -> 매도 1호가(${bestAskPrice.toLocaleString("ko-KR")}원) 정정 재주문`,
                              nowKSTString(),
                              bot.bot_id
                            );
                          } else {
                            console.warn(
                              `[LiveBuyRetry][${bot.bot_id}][${normMkt}] 매도1호가 정정 재주문 응답 uuid 누락 (id=${retryIdentifier}) -> UNKNOWN_TIMEOUT 잠금`
                            );
                            await markLiveIntentUnknownTimeout(
                              db,
                              {
                                intentId,
                                botId: bot.bot_id,
                                market,
                                errorMessage: `Retry ask1 missing uuid (identifier=${retryIdentifier})`,
                              },
                              guardrailTxDeps
                            );
                            return false;
                          }
                        } else if (rResp.status >= 400 && rResp.status < 500) {
                          // 원 주문은 이미 0체결 취소 확정 + 정정 재주문은 4xx 미생성 확정 -> 즉시 안전 환불 경로로 종료
                          const rErr = await rResp.json().catch(() => ({}));
                          console.warn(
                            `[LiveBuyRetry][${bot.bot_id}][${normMkt}] 매도1호가 정정 재주문 4xx 거절 (HTTP ${rResp.status}, id=${retryIdentifier}): ${rErr?.error?.message || "unknown"} -> 원 주문 취소 확정 환불`
                          );
                          isOrderDone = true;
                          confirmedCancelZero = true;
                          execVolume = "0";
                          break;
                        } else {
                          // HTTP 5xx 등 불확실 응답: 원 주문 UUID로 폴링하면 오환불 위험 -> 즉시 UNKNOWN_TIMEOUT 잠금 및 identifier 정산 대기
                          const rErr = await rResp.json().catch(() => ({}));
                          const errText = rErr?.error?.message || "unknown";
                          console.warn(
                            `[LiveBuyRetry][${bot.bot_id}][${normMkt}] 매도1호가 정정 재주문 불확실 응답 (HTTP ${rResp.status}, id=${retryIdentifier}): ${errText} -> UNKNOWN_TIMEOUT 잠금`
                          );
                          await markLiveIntentUnknownTimeout(
                            db,
                            {
                              intentId,
                              botId: bot.bot_id,
                              market,
                              errorMessage: `Retry ask1 uncertain HTTP ${rResp.status} (identifier=${retryIdentifier}): ${errText}`,
                            },
                            guardrailTxDeps
                          );
                          return false;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (pollErr) {
          console.warn(`[LiveBuyPoll][${bot.bot_id}][${normMkt}] 체결 폴링 조회 오류(attempt ${attempt + 1}):`, pollErr?.message || pollErr);
        }
      }

      // 40초 내 미체결 시 지정가 주문 취소 (cancel_order)
      if (!isOrderDone) {
        await cancelUpbitOrder(orderUuid, cfg);
        if (postCancelDelayMs > 0) await new Promise((r) => setTimeout(r, postCancelDelayMs));
        let filledAfterCancel = 0;
        let postCancelVerified = false;
        try {
          const qParams = { uuid: orderUuid };
          const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
          const oResp = await fetch(
            `https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`,
            {
              headers: {
                Authorization: `Bearer ${qToken}`,
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(8000),
            }
          );
          if (oResp.status === 200) {
            const oDetail = await oResp.json();
            const postState = String(oDetail?.state || "");
            filledAfterCancel = Number(oDetail?.executed_volume || 0);
            if (filledAfterCancel > 0) {
              postCancelVerified = true;
              execVolume = String(oDetail.executed_volume);
              const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
              const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
              if (totalFunds > 0) {
                actualBuyAmount = Math.floor(totalFunds);
                execPrice = normalizeExecPrice(totalFunds / filledAfterCancel, activeLimitPrice);
              } else {
                actualBuyAmount = Math.floor(filledAfterCancel * activeLimitPrice);
              }
              if (oDetail.paid_fee !== undefined) {
                fee = Math.ceil(Number(oDetail.paid_fee || fee));
              }
            } else if (postState === "cancel" || postState === "done") {
              postCancelVerified = true;
              confirmedCancelZero = true;
              execVolume = "0";
            }
          }
        } catch (postCancelErr) {
          console.warn(`[LiveBuyCancelCheck][${bot.bot_id}][${normMkt}] 취소 후 상태 재조회 오류:`, postCancelErr?.message || postCancelErr);
        }

        if (filledAfterCancel <= 0) {
          if (postCancelVerified && confirmedCancelZero) {
            console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 지정가 1호가(${bestBidPrice}원) 40초 미체결 자동 취소 및 환불 완료`);
            await refundFailedOrCanceledBuyIntentAtomic(
              db,
              {
                intentId,
                botId: bot.bot_id,
                nextStatus: "CANCELED",
                errorMessage: "40초 미체결 취소 확정 (0체결)",
                statusMsg: `${market} 지정가 매수(1호가 ${bestBidPrice.toLocaleString("ko-KR")}원) 40초 미체결로 자동 취소 및 선차감 환불 완료`,
              },
              guardrailTxDeps
            );
            markBotDiagnosticStatus(bot.bot_id);
          } else {
            console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 40초 취소 후 상태 미확정 -> UNKNOWN_TIMEOUT 정산 대기`);
            // 취소 결과를 네트워크 장애로 미확정 -> 절대 즉시 환불하지 않고 identifier 정산 대기
            await markLiveIntentUnknownTimeout(
              db,
              { intentId, botId: bot.bot_id, market, errorMessage: "Post-cancel order state unconfirmed" },
              guardrailTxDeps
            );
          }
          return false;
        }
      }

      if (Number(execVolume) <= 0) {
        if (confirmedCancelZero) {
          console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 지정가 매수 주문 미체결 취소 확정 및 환불 완료`);
          await refundFailedOrCanceledBuyIntentAtomic(
            db,
            {
              intentId,
              botId: bot.bot_id,
              nextStatus: "CANCELED",
              errorMessage: "지정가 매수 미체결 취소 확정",
              statusMsg: `${market} 지정가 매수 주문이 미체결 취소되어 선차감 원화가 환불되었습니다.`,
            },
            guardrailTxDeps
          );
          markBotDiagnosticStatus(bot.bot_id);
        } else {
          console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 체결 수량 미확정 -> UNKNOWN_TIMEOUT 잠금`);
          await markLiveIntentUnknownTimeout(
            db,
            { intentId, botId: bot.bot_id, market, errorMessage: "Executed volume unconfirmed" },
            guardrailTxDeps
          );
        }
        return false;
      }
    } catch (err) {
      console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 주문 네트워크 예외 (${err.name || "Error"}: ${err.message}) -> UNKNOWN_TIMEOUT 잠금`);
      // [Step C] 네트워크 타임아웃 / ECONNRESET / AbortError 등 체결 불확실:
      // 절대 즉시 재주문하거나 선차감 원화를 바로 환불하지 않고 UNKNOWN_TIMEOUT 잠금 -> 다음 정산 사이클에서 identifier 조회 확정
      await markLiveIntentUnknownTimeout(
        db,
        { intentId, botId: bot.bot_id, market, errorMessage: `${err.name || "Error"}: ${err.message}` },
        guardrailTxDeps
      );
      return false;
    }
  }

  const expectedPrice = Number(currentPrice || execPrice);
  const slippageBps = computeSlippageBps(expectedPrice, execPrice);
  const atrSizingMult = Number.isFinite(Number(options?.atrSizingMult))
    ? Number(Number(options.atrSizingMult).toFixed(4))
    : 1.0;

  // [Step C] 체결 확정 + 미사용 선차감 잔여분 단 1회 정산 + trades/bot_positions 멱등 기록
  const confirmed = await confirmBuyIntentAndRecordPositionAtomic(
    db,
    {
      intentId,
      botId: bot.bot_id,
      market,
      orderUuid,
      execPrice,
      execVolume,
      actualBuyAmount,
      fee,
      reservedKrw,
      stepLevel,
      buyReason: buyReason || null,
      expectedPrice,
      slippageBps,
      atrSizingMult,
      statusMsg: `${market} 최유리 지정가(1호가 ${execPrice.toLocaleString("ko-KR")}원) 매수 체결 (${actualBuyAmount.toLocaleString("ko-KR")}원 · 슬리피지 ${slippageBps >= 0 ? "+" : ""}${slippageBps}bps)`,
    },
    guardrailTxDeps
  );

  if (!confirmed?.confirmed) {
    console.warn(`[LiveBuySkip][${bot.bot_id}][${normMkt}] 매수 인텐트 최종 확정 실패 (intentId=${intentId})`);
    return false;
  }

  dispatchMultiChannelNotification(
    db,
    {
      eventType: "LIVE_BUY",
      botId: bot.bot_id,
      botName: latestBot.nickname || latestBot.name || bot.bot_id,
      market,
      price: execPrice,
      volume: execVolume,
      amountKrw: actualBuyAmount,
      reason: buyReason || "전략 매수 체결",
    },
    { webPushBroadcastFn: broadcastWebPushNotification }
  ).catch(() => {});

  return true;
}

/**
 * [Antigravity-Doc] 실전 매도 체결 완료 후 DB 원장 정산을 단일 `withDbWriteLock` 트랜잭션으로 원자적 처리한다.
 * 주요 처리 단계:
 *  1. 대상 포지션(`bot_positions`) CLOSED 처리 및 대응 `trades` 레코드 실현손익(`profit_krw`/`profit_pct`) 기록.
 *  2. 탈락(Draining) 봇인 경우: `computeDrainSellCapitalRestoration`으로 90% 상한 불변식을 지키며 순회수금을 후임/활성 봇에 복원
 *     (초과 수익은 예비비 유보)하고 `capital_restoration_logs` 및 `drain_handoff_logs` 기록.
 *  3. 활성 봇인 경우: 이중 계상 없이 `prevVirtual + netProceeds`로 `virtual_krw`/`allocated_capital` 갱신.
 *  4. 커밋 후 멀티채널 알림(`LIVE_SELL` / `DRAIN_HANDOFF` / `DRAIN_CAPITAL_RESTORED`) 발송.
 * @param {object} params
 * @returns {Promise<{isDrainingBot:boolean, netProceeds:number, totalProfitKrw:number, remainingOpenCnt:number, remainingOpenUsed:number, handoffAllocations:Array}>}
 */
export async function settleLiveSellOrderInDb({
  db,
  bot,
  targetPositions,
  sellUuid,
  sellPrice,
  actualTotalFunds,
  actualTotalFee,
  reasonLabel,
}) {
  const now = nowKSTString();
  const safeFunds = Number.isFinite(Number(actualTotalFunds)) ? Math.max(0, Math.floor(Number(actualTotalFunds))) : 0;
  const safeFee = Number.isFinite(Number(actualTotalFee)) ? Math.max(0, Math.floor(Number(actualTotalFee))) : 0;
  const netProceeds = Math.max(0, safeFunds - safeFee);
  const totalBuyAmount = targetPositions.reduce((acc, p) => acc + Math.max(0, Number(p.buy_amount || 0)), 0) || 1;
  const primaryPos = targetPositions[0];
  let totalProfitKrw = 0;

  let isDrainingBot = false;
  let remainingOpenCnt = 0;
  let remainingOpenUsed = 0;
  let handoffAllocations = [];

  await withDbWriteLock(async () => {
    try {
      await beginWriteTx(db);

    for (const p of targetPositions) {
      const pBuyAmt = Math.max(0, Number(p.buy_amount || 0));
      const pBuyFee = Math.max(0, Number(p.buy_fee || 0));
      const weight = pBuyAmt / totalBuyAmount;
      const posSellAmount = Math.floor(safeFunds * weight);
      const posSellFee = Math.floor(safeFee * weight);
      const posNetProceeds = Math.max(0, posSellAmount - posSellFee);
      const posProfitKrw = Math.floor(posNetProceeds - pBuyAmt - pBuyFee);
      const posProfitPct = pBuyAmt > 0 ? Number(((posProfitKrw / pBuyAmt) * 100).toFixed(2)) : 0;
      totalProfitKrw += posProfitKrw;

      await db.prepare("UPDATE bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND bot_id = ?").run(
        now,
        p.id,
        bot.bot_id
      );
      if (p.trade_id) {
        await db.prepare(`
          UPDATE trades
          SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, status = 'COMPLETED', sell_reason = ?
          WHERE id = ? AND bot_id = ?
        `).run(sellUuid, Number(sellPrice), p.volume, posSellAmount, now, posProfitKrw, posProfitPct, reasonLabel || null, p.trade_id, bot.bot_id);
      }
    }

    try {
      await db
        .prepare("UPDATE bot_accounts SET total_realized_pnl = total_realized_pnl + ?, updated_at = ? WHERE bot_id = ?")
        .run(totalProfitKrw, now, bot.bot_id);
    } catch (pnlErr) {
      console.warn(`[SettleSell][${bot.bot_id}] bot_accounts 실현손익 갱신 실패:`, pnlErr?.message || pnlErr);
    }

    const freshBot = await db.prepare("SELECT * FROM bots WHERE bot_id = ?").get(bot.bot_id);
    isDrainingBot = Number(freshBot?.is_selected_for_live || 0) !== 1;

    const remRow = await db
      .prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(buy_amount), 0) AS rem_used FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
      .get(bot.bot_id);
    remainingOpenCnt = Number(remRow?.cnt || 0);
    remainingOpenUsed = Math.max(0, Math.floor(Number(remRow?.rem_used || 0)));

    let restorationNotificationText = "";
    const rotCfg = await getAutoRotationConfig(db);
    const cachedEqKrw = Math.floor(Number(await getSetting("last_synced_total_equity_krw", "0")));
    const legacyCapKrw = Math.floor(Number(await getSetting("deployable_capital_cap_krw", await getSetting("total_capital", "0"))));
    const resolvedEq = resolveTotalEquityAndSingle90Cap({
      cachedTotalEquityKrw: cachedEqKrw > 0 ? cachedEqKrw : null,
      legacyAuto90PrincipalKrw: legacyCapKrw > 0 ? legacyCapKrw : null,
      maxDeployRatio: rotCfg.max_deploy_ratio || 0.9,
    });
    const configuredPrincipalKrw = resolvedEq.totalEquityKrw;
    const use90CapRestoration =
      isEquityTierAllocationMode(rotCfg.allocation_mode) || Boolean(freshBot?.replaced_by_bot_id);

    if (isDrainingBot) {
      const prevStrayCash = Math.max(0, Math.floor(Number(freshBot?.virtual_krw || 0)));
      const distributable = Math.max(0, netProceeds + prevStrayCash);

      const activeBots = await db
        .prepare("SELECT * FROM bots WHERE is_selected_for_live = 1 ORDER BY allocation_ratio DESC, bot_id ASC")
        .all();

      let totalRestoredKrw = 0;
      let surplusToReserveKrw = 0;
      let globalCapAfter = Math.floor(configuredPrincipalKrw * (rotCfg.max_deploy_ratio || 0.9));
      let totalUsedAfter = 0;

      if (use90CapRestoration && configuredPrincipalKrw > 0 && activeBots.length > 0) {
        // 원금 90% 상한 불변식 기반 교체 봇 우선 복원 (익절 초과분 예비비 유보, 손절 시 실회수액 한도 복원)
        const otherDrainingRow = await db
          .prepare(
            `SELECT COALESCE(SUM(bp.buy_amount), 0) AS rem_drain_locked
             FROM bot_positions bp
             JOIN bots b ON bp.bot_id = b.bot_id
             WHERE bp.status = 'OPEN' AND b.is_selected_for_live = 0`
          )
          .get();
        const remainingDrainingLockedAll = Math.max(0, Math.floor(Number(otherDrainingRow?.rem_drain_locked || 0)));

        const electedBotsNow = [];
        for (const ab of activeBots) {
          const abUsedRow = await db
            .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS used_amt FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
            .get(ab.bot_id);
          const abUsed = Math.max(0, Math.floor(Number(abUsedRow?.used_amt || 0)));
          electedBotsNow.push({
            bot_id: ab.bot_id,
            nickname: ab.nickname || ab.name,
            allocation_ratio: Number(ab.allocation_ratio || 0),
            target_capital_krw: Math.max(0, Math.floor(Number(ab.target_capital_krw || 0))),
            open_locked_krw: abUsed,
            virtual_krw: Math.max(0, Math.floor(Number(ab.virtual_krw || 0))),
            last_status_msg: ab.last_status_msg || "",
          });
        }

        const restResult = computeDrainSellCapitalRestoration({
          totalEquityKrw: configuredPrincipalKrw,
          drainingBot: freshBot,
          settledNetKrw: distributable,
          remainingDrainingLockedAll,
          electedBotsNow,
          actualAvailableKrw: null,
          maxDeployRatio: rotCfg.max_deploy_ratio || 0.9,
        });

        totalRestoredKrw = restResult.totalRestoredKrw;
        surplusToReserveKrw = restResult.surplusToReserveKrw;
        globalCapAfter = restResult.globalCapKrw;
        totalUsedAfter = restResult.totalUsedAfterKrw;

        for (const tr of restResult.transfers) {
          const ab = electedBotsNow.find((x) => x.bot_id === tr.bot_id);
          if (!ab || tr.restored_krw <= 0) continue;
          const nextVirtual = ab.virtual_krw + tr.restored_krw;
          const nextAlloc = nextVirtual + ab.open_locked_krw;
          let nextMsg = ab.last_status_msg;
          if (nextVirtual >= MIN_LIVE_ORDER_SAFE_KRW && String(nextMsg).includes("자금 복원 대기")) {
            nextMsg = `[✅ 자금 복원 완료] ${bot.bot_id} 청산으로 +${tr.restored_krw.toLocaleString("ko-KR")}원 복원 (가용 ${nextVirtual.toLocaleString("ko-KR")}원 · 정상 매수 개시)`;
          }
          await db
            .prepare("UPDATE bots SET virtual_krw = ?, allocated_capital = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
            .run(nextVirtual, nextAlloc, nextMsg, now, ab.bot_id);
          ab.virtual_krw = nextVirtual;
          handoffAllocations.push({
            bot_id: ab.bot_id,
            nickname: ab.nickname,
            ratio_pct: ab.allocation_ratio,
            amount_krw: tr.restored_krw,
            priority: tr.priority,
            new_virtual_krw: nextVirtual,
          });
        }

        // capital_restoration_logs 원장 기록
        try {
          if (restResult.transfers.length > 0) {
            for (const tr of restResult.transfers) {
              await db
                .prepare(
                  `INSERT INTO capital_restoration_logs (
                     source_bot_id, target_bot_id, order_uuid, settled_net_krw,
                     restored_krw, surplus_reserve_krw, total_used_after_krw, global_cap_krw, total_equity_snapshot_krw, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                  bot.bot_id,
                  tr.bot_id,
                  sellUuid || primaryPos.order_uuid || "",
                  distributable,
                  tr.restored_krw,
                  surplusToReserveKrw,
                  totalUsedAfter,
                  globalCapAfter,
                  configuredPrincipalKrw,
                  now
                );
            }
          } else if (distributable > 0) {
            await db
              .prepare(
                `INSERT INTO capital_restoration_logs (
                   source_bot_id, target_bot_id, order_uuid, settled_net_krw,
                   restored_krw, surplus_reserve_krw, total_used_after_krw, global_cap_krw, total_equity_snapshot_krw, created_at
                 ) VALUES (?, 'RESERVE', ?, ?, 0, ?, ?, ?, ?, ?)`
              )
              .run(
                bot.bot_id,
                sellUuid || primaryPos.order_uuid || "",
                distributable,
                surplusToReserveKrw,
                totalUsedAfter,
                globalCapAfter,
                configuredPrincipalKrw,
                now
              );
          }
        } catch {}

        const utilAfterPct =
          configuredPrincipalKrw > 0 ? Number(((totalUsedAfter / configuredPrincipalKrw) * 100).toFixed(2)) : 0;
        const targetSummary =
          handoffAllocations.length > 0
            ? handoffAllocations.map((a) => `${a.bot_id}(+${a.amount_krw.toLocaleString("ko-KR")}원)`).join(", ")
            : "예비비 전액 유보";
        restorationNotificationText = `[🛡️ Drain 매도 자금 복원] ${bot.bot_id}(${primaryPos.market}) 순회수 ${distributable.toLocaleString("ko-KR")}원 → 복원: ${targetSummary}${surplusToReserveKrw > 0 ? ` · 예비비 유보 ${surplusToReserveKrw.toLocaleString("ko-KR")}원` : ""} (총 자금 사용률 ${utilAfterPct}% / 상한 90%)`;
      } else {
        const ratioSum = activeBots.reduce((acc, ab) => {
          const r = Number(ab.allocation_ratio || 0);
          return acc + (Number.isFinite(r) && r > 0 ? r : 0);
        }, 0);

        if (activeBots.length > 0 && distributable > 0) {
          let distributed = 0;
          const shares = activeBots.map((ab) => {
            const r = Number(ab.allocation_ratio || 0);
            const safeRatio = Number.isFinite(r) && r > 0 ? r : 0;
            const share =
              ratioSum > 0
                ? Math.floor((distributable * safeRatio) / ratioSum)
                : Math.floor(distributable / activeBots.length);
            distributed += share;
            return { ab, share };
          });
          const remainder = distributable - distributed;
          if (remainder > 0 && shares.length > 0) {
            shares[0].share += remainder;
          }

          for (const item of shares) {
            const share = Math.max(0, item.share);
            const ab = item.ab;
            if (share <= 0) continue;
            const abUsedRow = await db
              .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS used_amt FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
              .get(ab.bot_id);
            const abUsed = Math.max(0, Math.floor(Number(abUsedRow?.used_amt || 0)));
            const prevVirtual = Math.max(0, Math.floor(Number(ab.virtual_krw || 0)));
            const prevAllocMinusUsed = Math.max(0, Math.floor(Number(ab.allocated_capital || 0)) - abUsed);
            const baseVirtual = Math.max(prevVirtual, prevAllocMinusUsed);
            const nextVirtual = baseVirtual + share;
            const nextAlloc = nextVirtual + abUsed;

            await db
              .prepare("UPDATE bots SET virtual_krw = ?, allocated_capital = ?, updated_at = ? WHERE bot_id = ?")
              .run(nextVirtual, nextAlloc, now, ab.bot_id);
            handoffAllocations.push({
              bot_id: ab.bot_id,
              nickname: ab.nickname || ab.name,
              ratio_pct: Number(ab.allocation_ratio || 0),
              amount_krw: share,
              new_virtual_krw: nextVirtual,
            });
          }
          totalRestoredKrw = distributed + Math.max(0, remainder);
        }
      }

      const nextDrainStatus = remainingOpenCnt > 0 ? "DRAINING" : "COMPLETED";
      const nextReplacedBy = remainingOpenCnt > 0 ? (freshBot?.replaced_by_bot_id || null) : null;
      const nextDrainStartedAt = remainingOpenCnt > 0 ? (freshBot?.drain_started_at || now) : null;
      const drainStatusMsg =
        remainingOpenCnt > 0
          ? `[🛡️ Graceful Drain] ${primaryPos.market} 매도 정산금 ${distributable.toLocaleString("ko-KR")}원(복원 ${totalRestoredKrw.toLocaleString("ko-KR")}원${surplusToReserveKrw > 0 ? `, 예비비 ${surplusToReserveKrw.toLocaleString("ko-KR")}원` : ""}) 처리 · 잔여 포지션 ${remainingOpenCnt}건(${remainingOpenUsed.toLocaleString("ko-KR")}원) 계속 감시 중`
          : `[✅ Graceful Drain 완료] ${primaryPos.market} 최종 청산(${totalProfitKrw >= 0 ? "+" : ""}${totalProfitKrw.toLocaleString("ko-KR")}원) 및 정산금 ${distributable.toLocaleString("ko-KR")}원 자동 복원 완료`;

      await db
        .prepare(
          `UPDATE bots
           SET is_selected_for_live = 0, is_running = 0, allocation_ratio = 0,
               target_capital_krw = 0, allocated_capital = ?, virtual_krw = 0,
               drain_status = ?, replaced_by_bot_id = ?, drain_started_at = ?,
               last_status_msg = ?, updated_at = ?
           WHERE bot_id = ?`
        )
        .run(remainingOpenUsed, nextDrainStatus, nextReplacedBy, nextDrainStartedAt, drainStatusMsg, now, bot.bot_id);

      try {
        await db
          .prepare(
            `INSERT INTO drain_handoff_logs (
               from_bot_id, market, position_id, trade_id, reason,
               sell_amount, sell_fee, net_proceeds_krw, realized_pnl_krw,
               allocations_json, remaining_positions_count, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            bot.bot_id,
            primaryPos.market,
            Number(primaryPos.id || 0),
            Number(primaryPos.trade_id || 0),
            reasonLabel || "",
            safeFunds,
            safeFee,
            distributable,
            totalProfitKrw,
            JSON.stringify(handoffAllocations),
            remainingOpenCnt,
            now
          );
      } catch {}
    } else {
      // 활성 봇 매도 정산: 방금 닫힌 포지션 원금(buy_amount)이 allocated_capital에 잔류하므로 이중 계상 금지 — 기존 가용현금(prevVirtual) + 순정산금(netProceeds)만 정확히 합산
      const prevVirtual = Math.max(0, Math.floor(Number(freshBot?.virtual_krw || 0)));
      const nextVirtual = prevVirtual + netProceeds;
      const nextAlloc = nextVirtual + remainingOpenUsed;
      const statusMsg = `${primaryPos.market} ${reasonLabel} 매도 완료 (${targetPositions.length}건 / ${
        totalProfitKrw >= 0 ? "+" : ""
      }${totalProfitKrw.toLocaleString("ko-KR")}원)`;

      await db
        .prepare(
          "UPDATE bots SET virtual_krw = ?, allocated_capital = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?"
        )
        .run(nextVirtual, nextAlloc, statusMsg, now, bot.bot_id);
    }

    if (!use90CapRestoration || !(configuredPrincipalKrw > 0)) {
      const totalCapRow = await db.prepare("SELECT COALESCE(SUM(allocated_capital), 0) AS total_cap FROM bots").get();
      const newTotalCap = Math.max(0, Math.floor(Number(totalCapRow?.total_cap || 0)));
      await db
        .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)")
        .run(String(newTotalCap), now);
    }

    await syncBotAccountsFromBots(db);
    await commitWriteTx(db);
    if (restorationNotificationText) {
      dispatchMultiChannelNotification(
        db,
        {
          eventType: "DRAIN_CAPITAL_RESTORED",
          botId: bot.bot_id,
          market: primaryPos.market,
          reason: restorationNotificationText,
        },
        { webPushBroadcastFn: broadcastWebPushNotification }
      ).catch(() => {});
    }
    } catch (txErr) {
      await rollbackWriteTx(db);
      throw txErr;
    }
  });

  const totalProfitPct =
    totalBuyAmount > 0 ? Number(((totalProfitKrw / totalBuyAmount) * 100).toFixed(2)) : 0;
  dispatchMultiChannelNotification(
    db,
    {
      eventType: isDrainingBot ? "DRAIN_HANDOFF" : "LIVE_SELL",
      botId: bot.bot_id,
      botName: bot.nickname || bot.name || bot.bot_id,
      market: primaryPos?.market,
      price: sellPrice,
      volume: primaryPos?.volume,
      amountKrw: safeFunds,
      profitKrw: totalProfitKrw,
      profitPct: totalProfitPct,
      reason: reasonLabel || "전략 청산",
      extra: {
        netProceedsKrw: netProceeds,
        remainingPositionsCount: remainingOpenCnt,
      },
    },
    { webPushBroadcastFn: broadcastWebPushNotification }
  ).catch(() => {});

  return {
    isDrainingBot,
    netProceeds,
    totalProfitKrw,
    remainingOpenCnt,
    remainingOpenUsed,
    handoffAllocations,
  };
}

/**
 * [Antigravity-Doc] 봇 매도 주문 실행 메인 엔진(가상거래/실거래 통합).
 * 실전(live) 모드 핵심 방어 로직:
 *  - 주의: 매수 쿨다운/비상정지/Graceful Drain 상태에서도 보유 포지션 청산 매도는 절대 차단하지 않음.
 *  - Step A (`claimLiveSellIntentAtomic`): `closing_lock=1` 및 `live_order_intents(SELL)` 선점으로 동일 포지션 중복 매도 차단.
 *  - 방어로직 0: `/v1/accounts` 조회 실패 시 DB 포지션을 파괴하지 않고 락 해제 후 다음 사이클 재시도.
 *  - 방어로직 1: 실계좌 잔고에서 타 봇 보유분(`otherBotsVol`)을 제외한 본인 지분만 매도하며, 고아 포지션은 타 봇 물량을 건드리지 않고 CLOSED 동기화.
 *  - 방어로직 2 (Buy-to-Cleanse): 평가액이 업비트 최소주문(5,000원) 미만일 때 포지션당 15분 쿨다운으로 5,500원 보충 매수 후 일괄 청산 시도.
 *  - Step B/C: `identifier: sellIntentId` 포함 시장가 매도 -> 체결 상세 조회 -> `settleLiveSellOrderInDb` -> `confirmSellIntentAtomic`.
 * @param {object} bot
 * @param {object} pos 청산 대상 OPEN 포지션
 * @param {number} sellPrice 현재가/기준 매도가
 * @param {string} reasonLabel 청산 사유
 * @param {object} [options={}]
 * @returns {Promise<boolean>}
 */
export async function executeBotSellOrder(bot, pos, sellPrice, reasonLabel, options = {}) {
  const db = getDb();
  const isLive = isLiveMode();

  if (!isLive) {
    // [가상거래 모드 (Paper Trading)]
    // 분리된 전용 가상 원장(paper_bot_positions, paper_trades)에서 매도 체결
    const currentPos = await db
      .prepare("SELECT * FROM paper_bot_positions WHERE id = ? AND bot_id = ? AND status = 'OPEN'")
      .get(pos.id, bot.bot_id);
    if (!currentPos) {
      console.warn(`[PaperSellSkip][${bot.bot_id}][${pos?.market || ""}] OPEN 가상 포지션 미존재 (posId=${pos?.id})`);
      return false;
    }

    const sameMarketOpenPositions = await db
      .prepare("SELECT * FROM paper_bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN' ORDER BY id ASC")
      .all(bot.bot_id, currentPos.market);

    const targetPositions = sameMarketOpenPositions.length > 0 ? sameMarketOpenPositions : [currentPos];
    const dbSumVolume = targetPositions.reduce((acc, p) => acc + Number(p.volume || 0), 0);
    if (dbSumVolume <= 0) {
      console.warn(`[PaperSellSkip][${bot.bot_id}][${currentPos.market}] 가상 매도 가능 수량 0 이하 (dbSumVolume=${dbSumVolume})`);
      return false;
    }

    const now = nowKSTString();
    const sellUuid = `paper-ask-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const actualTotalFunds = Math.floor(dbSumVolume * Number(sellPrice));
    const actualTotalFee = Math.floor(actualTotalFunds * 0.0005);
    const netTotalFunds = Math.max(0, actualTotalFunds - actualTotalFee);

    let totalProfitKrw = 0;
    for (const p of targetPositions) {
      const pVol = Number(p.volume || 0);
      const posRatio = dbSumVolume > 0 ? pVol / dbSumVolume : 1 / targetPositions.length;
      const posNetFunds = Math.floor(netTotalFunds * posRatio);
      const posGrossFunds = Math.floor(actualTotalFunds * posRatio);
      const profitKrw = posNetFunds - Number(p.buy_amount || 0);
      const profitPct = Number(p.avg_buy_price || 0) > 0
        ? ((Number(sellPrice) - Number(p.avg_buy_price)) / Number(p.avg_buy_price)) * 100.0
        : 0;
      totalProfitKrw += profitKrw;

      await db.prepare("UPDATE paper_bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ?").run(now, p.id);
      await db.prepare(`
        UPDATE paper_trades
        SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, status = 'COMPLETED'
        WHERE id = ?
      `).run(sellUuid, Number(sellPrice), String(p.volume), posGrossFunds, now, profitKrw, profitPct, p.trade_id);
    }

    const latestBot = await db.prepare("SELECT allocated_capital FROM bots WHERE bot_id = ?").get(bot.bot_id);
    const inv = await db
      .prepare(
        "SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM paper_bot_positions WHERE bot_id = ? AND status = 'OPEN'"
      )
      .get(bot.bot_id);
    const newVirtualKrw = Math.max(0, Math.floor(Number(latestBot?.allocated_capital || 0) - Number(inv?.invested || 0)));

    await db.prepare("UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      newVirtualKrw,
      `[가상체결] ${currentPos.market} ${reasonLabel} 매도 체결 (${totalProfitKrw >= 0 ? "+" : ""}${totalProfitKrw.toLocaleString("ko-KR")}원 / ${targetPositions.length}건 통합)`,
      now,
      bot.bot_id
    );
    await checkAndHaltIfZeroBalance("paper");
    return true;
  }

  // [실거래 모드 (Live Trading)] — Layer 1(단일 소유자+리스) + Layer 3(동일 order_uuid 중복 매도 차단)
  // 주의: 매수 쿨다운/상한 및 Graceful Drain(is_selected_for_live = 0) / 비상 정지 상태에서도 보유 포지션 청산 매도는 절대 차단하지 않음!
  const cfg = getRuntimeConfig();
  const sellGuardrailDeps = {
    runtimeConfig: cfg,
    withDbWriteLock,
    beginWriteTx,
    commitWriteTx,
    rollbackWriteTx,
  };

  // [Step A] 단일 BEGIN IMMEDIATE 트랜잭션으로 closing_lock=1 및 live_order_intents(SELL, sell:<order_uuid>) 원자적 선점
  const sellClaim = await claimLiveSellIntentAtomic(
    db,
    {
      botId: bot.bot_id,
      positionId: pos.id,
      sellPrice,
      floorTo8DecimalsStr,
      options,
    },
    sellGuardrailDeps
  );
  if (!sellClaim || !sellClaim.ok) {
    console.warn(
      `[LiveSellSkip][${bot.bot_id}][${pos?.market || ""}] 매도 클레임 보류 (${sellClaim?.code || "UNKNOWN"}): ${sellClaim?.reason || ""}`
    );
    return false;
  }

  const { intentId: sellIntentId, targetPositionUuid, currentPos, targetPositions, dbSumVolume } = sellClaim;
  const targetPositionIds = targetPositions.map((p) => p.id);

  // 시뮬레이션/테스트 모드에서는 외부 업비트 주문 없이 해당 포지션 volume만 정확히 체결 정산
  if (options?.skipUpbitApi) {
    const sellUuid = `sim-ask-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const sellVolNum = Number(floorTo8DecimalsStr(dbSumVolume));
    const safePrice = Number.isFinite(Number(sellPrice)) && Number(sellPrice) > 0 ? Number(sellPrice) : 0;
    const actualTotalFunds = Math.max(0, Math.floor(sellVolNum * safePrice));
    const actualTotalFee = Math.max(0, Math.floor(actualTotalFunds * 0.0005));
    try {
      const settled = await settleLiveSellOrderInDb({
        db,
        bot,
        targetPositions,
        sellUuid,
        sellPrice: safePrice,
        actualTotalFunds,
        actualTotalFee,
        reasonLabel,
      });
      await confirmSellIntentAtomic(
        db,
        { intentId: sellIntentId, upbitOrderUuid: sellUuid, targetPositionIds },
        sellGuardrailDeps
      );
      liveBotCooldownMap.set(`${bot.bot_id}|${currentPos.market}`, Date.now());
      if (settled.isDrainingBot) {
        console.log(
          `[Graceful Drain 정산 이관] 탈락 봇 ${bot.bot_id} ${currentPos.market} ${reasonLabel} 정산금 ${settled.netProceeds.toLocaleString("ko-KR")}원 이관 (잔여 ${settled.remainingOpenCnt}건)`
        );
      }
      return true;
    } catch (simErr) {
      console.warn(`[ExecuteSell][${bot.bot_id}][${currentPos.market}] 시뮬레이션 매도 정산 오류:`, simErr?.message || simErr);
      await releaseFailedSellIntentAtomic(
        db,
        { intentId: sellIntentId, targetPositionIds, targetPositionUuid, errorMessage: simErr.message },
        sellGuardrailDeps
      );
      return false;
    }
  }

  // 업비트 실계좌 보유 수량 조회 — 절대 계좌 전량을 매도하지 않고 본인 봇/order_uuid 기록 volume(소수점 8자리 내림 ROUND_DOWN)만 사용
  const currency = String(currentPos.market || "").split("-")[1] || "";
  let sellVolumeStr = floorTo8DecimalsStr(dbSumVolume);
  let actualCoinBalance = 0;
  let actualCoinLocked = 0;
  let otherBotsVol = 0;
  let accountFetched = false;
  let maxAvailableForThisBot = 0;
  const sellRateDelayMs = options?.skipDelay ? 0 : 120;

  try {
    const otherBotsRow = await db
      .prepare(
        "SELECT COALESCE(SUM(volume), 0) AS other_vol FROM bot_positions WHERE bot_id != ? AND market = ? AND status = 'OPEN'"
      )
      .get(bot.bot_id, currentPos.market);
    otherBotsVol = Number(otherBotsRow?.other_vol || 0);

    if (sellRateDelayMs > 0) await new Promise((r) => setTimeout(r, sellRateDelayMs));
    const acctToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim());
    const acctResp = await fetch("https://api.upbit.com/v1/accounts", {
      headers: {
        Authorization: `Bearer ${acctToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (acctResp.status === 200) {
      const accounts = await acctResp.json();
      if (Array.isArray(accounts)) {
        accountFetched = true;
        const coinAcct = accounts.find((a) => String(a.currency || "").toUpperCase() === currency.toUpperCase());
        actualCoinBalance = Number(coinAcct?.balance || 0);
        actualCoinLocked = Number(coinAcct?.locked || 0);
        maxAvailableForThisBot = Math.max(0, actualCoinBalance - otherBotsVol);
        const boundedVol = Math.min(dbSumVolume, maxAvailableForThisBot);
        sellVolumeStr = boundedVol > 0 ? floorTo8DecimalsStr(boundedVol) : "0";
      }
    }
  } catch (acctErr) {
    console.warn(`[ExecuteSell] ${currentPos.market} /v1/accounts 조회 실패(포지션 보존 후 다음 사이클 재시도):`, acctErr.message);
  }

  // [방어로직 0] /v1/accounts 조회 자체 실패 시 실계좌 0원으로 오판해 DB 포지션을 파괴(manual-sync)하지 않고 안전 중단 + 락 해제
  if (!accountFetched) {
    await releaseFailedSellIntentAtomic(
      db,
      {
        intentId: sellIntentId,
        targetPositionIds,
        targetPositionUuid,
        nextStatus: "FAILED_NOT_CREATED",
        errorMessage: "Upbit /v1/accounts unavailable before sell",
      },
      sellGuardrailDeps
    );
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${currentPos.market} 실계좌 잔고 확인 일시 지연 — 포지션 보존 후 재시도`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  // [방어로직 1] 업비트 실계좌(가용+미체결 잠금)가 0이거나, 잔여 물량이 100% 타 봇 지분(maxAvailableForThisBot <= 0)인 경우
  // 절대 타 봇 코인을 대신 매도하지 않고 본인 봇의 고아 포지션만 안전하게 CLOSED 동기화
  if (actualCoinBalance + actualCoinLocked <= 0.000001 || (actualCoinLocked <= 0.000001 && maxAvailableForThisBot <= 0.000001)) {
    console.log(
      `[Smart Cleanse] ${currentPos.market} 본인 봇 가용 수량 없음(실계좌=${actualCoinBalance}, 타봇보호=${otherBotsVol}) -> 타 봇 물량 보호 및 본인 포지션 CLOSED 동기화`
    );
    const nowSync = nowKSTString();
    let syncTotalProfitKrw = 0;
    for (const p of targetPositions) {
      await db.prepare("UPDATE bot_positions SET status = 'CLOSED', closing_lock = 0, closed_at = ? WHERE id = ? AND bot_id = ?").run(
        nowSync,
        p.id,
        bot.bot_id
      );
      if (p.trade_id) {
        const safeSyncPrice = Number(sellPrice || p.avg_buy_price || 0);
        const estSellAmt = Math.max(0, Math.floor(Number(p.volume || 0) * safeSyncPrice));
        const estSellFee = Math.floor(estSellAmt * 0.0005);
        const pBuyAmt = Math.max(0, Number(p.buy_amount || 0));
        const pBuyFee = Math.max(0, Number(p.buy_fee || 0));
        const estProfitKrw = Math.floor(estSellAmt - estSellFee - pBuyAmt - pBuyFee);
        const estProfitPct = pBuyAmt > 0 ? Number(((estProfitKrw / pBuyAmt) * 100).toFixed(2)) : 0;
        syncTotalProfitKrw += estProfitKrw;
        await db.prepare(`
          UPDATE trades
          SET sell_order_uuid = 'manual-sync', sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, status = 'COMPLETED'
          WHERE id = ? AND bot_id = ?
        `).run(safeSyncPrice, p.volume, estSellAmt, nowSync, estProfitKrw, estProfitPct, p.trade_id, bot.bot_id);
      }
    }
    try {
      await db
        .prepare("UPDATE bot_accounts SET total_realized_pnl = total_realized_pnl + ?, updated_at = ? WHERE bot_id = ?")
        .run(syncTotalProfitKrw, nowSync, bot.bot_id);
    } catch {}
    await confirmSellIntentAtomic(
      db,
      { intentId: sellIntentId, upbitOrderUuid: "manual-sync", targetPositionIds },
      sellGuardrailDeps
    );
    await syncDynamicLiveCapitalFromUpbit(true);
    return true;
  }

  if (Number(sellVolumeStr) <= 0) {
    console.warn(`[ExecuteSell] ${currentPos.market} 매도 가능 수량 0(잠금=${actualCoinLocked}) — 미체결 정리 대기`);
    await releaseFailedSellIntentAtomic(
      db,
      {
        intentId: sellIntentId,
        targetPositionIds,
        targetPositionUuid,
        nextStatus: "FAILED_NOT_CREATED",
        errorMessage: "Available sell volume is 0 (locked in open order)",
      },
      sellGuardrailDeps
    );
    return false;
  }

  let sellUuid = "";
  let actualTotalFunds = Math.floor(Number(sellVolumeStr) * Number(sellPrice));
  let orderEvalFunds = actualTotalFunds;
  let actualTotalFee = Math.floor(actualTotalFunds * 0.0005);
  let cleanseTopupCostKrw = 0;
  let executedSellAvgPrice = Number(sellPrice);

  // [방어로직 2] 평가금액이 업비트 최소주문금액(5,000원) 미만인 경우의 데드락 방어:
  // 무한 5,500원 보충 매수 루프 방지를 위해 포지션당 15분 쿨다운 적용 + identifier 부여 + 보충 매수 체결 수량을 DB에 선반영
  const cleanseGuardKey = `${bot.bot_id}|${currentPos.id}`;
  const lastCleanseAt = cleanseAttemptMap.get(cleanseGuardKey) || 0;
  if (orderEvalFunds < 5000 && Date.now() - lastCleanseAt >= 15 * 60 * 1000 && getLiveExecutorOwner(cfg) === "node") {
    cleanseAttemptMap.set(cleanseGuardKey, Date.now());
    console.warn(`[Smart Cleanse] ${currentPos.market} 평가액(${orderEvalFunds}원)이 업비트 최소주문(5,000원) 미만입니다. 청산용 보충 매수(Buy-to-Cleanse)를 시도합니다.`);
    try {
      const acctInfo = await fetchUpbitAccountBalance();
      const orderableKrw = Number(acctInfo.orderable_krw || 0);
      if (orderableKrw >= 6000) {
        const topupKrw = 5500;
        const topupBuyFee = Math.ceil(topupKrw * 0.0005);
        const buyParams = {
          market: currentPos.market,
          side: "bid",
          price: String(topupKrw),
          ord_type: "price",
          identifier: crypto.randomUUID(),
        };
        const buyToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), buyParams);
        const buyResp = await fetch("https://api.upbit.com/v1/orders", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${buyToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(buyParams),
          signal: AbortSignal.timeout(8000),
        });

        if (buyResp.status === 200 || buyResp.status === 201) {
          const buyOrderData = await buyResp.json().catch(() => ({}));
          const topupBuyUuid = buyOrderData?.uuid || "";
          let topupAddedVol = 0;

          // 보충 매수 주문 UUID 직접 체결 조회로 정확한 증가 수량 확보
          if (topupBuyUuid) {
            for (let attempt = 0; attempt < 3; attempt++) {
              await new Promise((r) => setTimeout(r, 500));
              try {
                const bqParams = { uuid: topupBuyUuid };
                const bqToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), bqParams);
                const bqResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(topupBuyUuid)}`, {
                  headers: { Authorization: `Bearer ${bqToken}`, Accept: "application/json" },
                  signal: AbortSignal.timeout(8000),
                });
                if (bqResp.status === 200) {
                  const bDetail = await bqResp.json();
                  const bVol = Number(bDetail?.executed_volume || 0);
                  if (bVol > 0) {
                    topupAddedVol = bVol;
                    break;
                  }
                }
              } catch {}
            }
          }

          if (topupAddedVol <= 0) {
            await new Promise((r) => setTimeout(r, 600));
            const acctToken2 = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim());
            const acctResp2 = await fetch("https://api.upbit.com/v1/accounts", {
              headers: { Authorization: `Bearer ${acctToken2}`, Accept: "application/json" },
              signal: AbortSignal.timeout(8000),
            });
            if (acctResp2.status === 200) {
              const accs = await acctResp2.json();
              const cAcc = Array.isArray(accs)
                ? accs.find((a) => String(a.currency || "").toUpperCase() === currency.toUpperCase())
                : null;
              const newBal = Number(cAcc?.balance || 0);
              topupAddedVol = Math.max(0, newBal - actualCoinBalance);
            }
          }

          if (topupAddedVol > 0) {
            const targetCleanseVol = Math.min(
              Math.max(0, actualCoinBalance + topupAddedVol - otherBotsVol),
              dbSumVolume + topupAddedVol
            );
            // 매도 실패 시에도 다음 사이클에 또 보충 매수하지 않도록 보충 수량을 포지션 원장에 즉시 반영
            const updatedPrimaryVol = floorTo8DecimalsStr(Number(currentPos.volume || 0) + topupAddedVol);
            const updatedPrimaryBuyAmt = Math.floor(Number(currentPos.buy_amount || 0)) + topupKrw;
            await db
              .prepare("UPDATE bot_positions SET volume = ?, buy_amount = ?, buy_fee = buy_fee + ? WHERE id = ? AND bot_id = ?")
              .run(updatedPrimaryVol, updatedPrimaryBuyAmt, topupBuyFee, currentPos.id, bot.bot_id);
            currentPos.volume = updatedPrimaryVol;
            currentPos.buy_amount = updatedPrimaryBuyAmt;
            currentPos.buy_fee = Number(currentPos.buy_fee || 0) + topupBuyFee;

            if (targetCleanseVol > 0) {
              sellVolumeStr = floorTo8DecimalsStr(targetCleanseVol);
              orderEvalFunds = Math.floor(Number(sellVolumeStr) * Number(sellPrice));
              cleanseTopupCostKrw = 0; // 보충 원금이 currentPos.buy_amount에 정확히 반영되었으므로 이중 차감 금지
              actualTotalFunds = orderEvalFunds;
              console.log(
                `[Smart Cleanse] 새 청산 수량: ${sellVolumeStr} (보충 수량 +${topupAddedVol}, 타봇 보호 차감: ${otherBotsVol}, 주문평가액: ${orderEvalFunds}원 >= 5,000원)`
              );
            }
          }
        }
      }
    } catch (cleanseErr) {
      console.warn(`[Smart Cleanse] 보충 청산 시도 중 오류:`, cleanseErr.message);
    }
  }

  // 여전히 5,000원 미만이면 업비트 API가 거절하므로 에러 상태 기록 및 closing_lock 해제 후 안전 종료
  if (orderEvalFunds < 5000) {
    const errMsg = `평가금액(${orderEvalFunds.toLocaleString("ko-KR")}원)이 업비트 최소주문(5,000원) 미만입니다. 업비트 앱의 '소액 코인 정리' 기능으로 정리하시면 봇이 자동 감지하여 청산 완료합니다.`;
    console.warn(`[ExecuteSell] ${currentPos.market} 매도 보류: ${errMsg}`);
    await releaseFailedSellIntentAtomic(
      db,
      {
        intentId: sellIntentId,
        targetPositionIds,
        targetPositionUuid,
        nextStatus: "FAILED_NOT_CREATED",
        errorMessage: "Order notional below 5,000 KRW Upbit floor",
      },
      sellGuardrailDeps
    );
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `[청산 대기] ${errMsg}`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const sellPollIntervalMs = Number.isFinite(Number(options?.sellPollIntervalMs))
    ? Math.max(0, Number(options.sellPollIntervalMs))
    : options?.skipDelay
    ? 0
    : 400;

  try {
    if (sellRateDelayMs > 0) await new Promise((r) => setTimeout(r, sellRateDelayMs));
    // [Step B] 업비트 POST /v1/orders 매도 요청에 반드시 identifier: sellIntentId 포함 (절대 맹목 재시도 금지)
    const params = {
      market: currentPos.market,
      side: "ask",
      volume: sellVolumeStr,
      ord_type: "market",
      identifier: sellIntentId,
    };
    const token = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), params);
    const resp = await fetch("https://api.upbit.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    });

    if (resp.status >= 400 && resp.status < 500) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
      console.warn(`[LiveSellSkip][${bot.bot_id}][${currentPos.market}] 업비트 매도 4xx 거절 (HTTP ${resp.status}): ${errMsg}`);
      await releaseFailedSellIntentAtomic(
        db,
        {
          intentId: sellIntentId,
          targetPositionIds,
          targetPositionUuid,
          nextStatus: "FAILED_NOT_CREATED",
          errorMessage: `Upbit 4xx(${resp.status}): ${errMsg}`,
        },
        sellGuardrailDeps
      );
      await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${currentPos.market} 매도 주문 실패: ${errMsg}`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }

    if (resp.status !== 200 && resp.status !== 201) {
      // HTTP 5xx 등 불확실 응답: 중복 매도 방지를 위해 closing_lock=1 유지 + UNKNOWN_TIMEOUT 정산 대기
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
      console.warn(`[LiveSellSkip][${bot.bot_id}][${currentPos.market}] 업비트 매도 응답 불확실 (HTTP ${resp.status}, UNKNOWN_TIMEOUT 잠금): ${errMsg}`);
      await markLiveIntentUnknownTimeout(
        db,
        { intentId: sellIntentId, botId: bot.bot_id, market: currentPos.market, errorMessage: `Sell uncertain HTTP ${resp.status}: ${errMsg}` },
        sellGuardrailDeps
      );
      return false;
    }

    const orderData = await resp.json();
    if (!orderData?.uuid) {
      console.warn(`[LiveSellSkip][${bot.bot_id}][${currentPos.market}] 업비트 매도 응답 uuid 누락 (UNKNOWN_TIMEOUT 잠금)`);
      await markLiveIntentUnknownTimeout(
        db,
        { intentId: sellIntentId, botId: bot.bot_id, market: currentPos.market, errorMessage: "Sell response missing uuid" },
        sellGuardrailDeps
      );
      return false;
    }
    sellUuid = orderData.uuid;
    await markLiveIntentSubmitted(db, { intentId: sellIntentId, upbitOrderUuid: sellUuid }, sellGuardrailDeps);

    // 매도 주문 체결 상세 조회 (GET /v1/order?uuid=...)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (sellPollIntervalMs > 0) await new Promise((r) => setTimeout(r, sellPollIntervalMs));
      try {
        const qParams = { uuid: sellUuid };
        const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
        const oResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(sellUuid)}`, {
          headers: {
            Authorization: `Bearer ${qToken}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (oResp.status === 200) {
          const oDetail = await oResp.json();
          const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
          const fundsSum = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
          const execSellVol = Number(oDetail.executed_volume || 0);
          if (fundsSum > 0) {
            actualTotalFunds = Math.max(0, Math.floor(fundsSum) - cleanseTopupCostKrw);
            if (execSellVol > 0) {
              executedSellAvgPrice = normalizeExecPrice(fundsSum / execSellVol, sellPrice);
            }
            if (oDetail.paid_fee !== undefined) {
              const totalPaidFee = Math.ceil(Number(oDetail.paid_fee || actualTotalFee));
              actualTotalFee = cleanseTopupCostKrw > 0 ? Math.max(1, Math.floor(actualTotalFunds * 0.0005)) : totalPaidFee;
            }
            break;
          }
        }
      } catch (sellPollErr) {
        console.warn(`[LiveSellPoll][${bot.bot_id}][${currentPos.market}] 매도 체결 상세 조회 오류:`, sellPollErr?.message || sellPollErr);
      }
    }
  } catch (err) {
    console.warn(`[LiveSellSkip][${bot.bot_id}][${currentPos.market}] 업비트 매도 네트워크 예외 (${err.name || "Error"}: ${err.message}) -> UNKNOWN_TIMEOUT 잠금`);
    // 네트워크 타임아웃 등 불확실 예외: 절대 즉시 중복 매도 금지 -> closing_lock=1 유지 + UNKNOWN_TIMEOUT 정산 대기
    await markLiveIntentUnknownTimeout(
      db,
      { intentId: sellIntentId, botId: bot.bot_id, market: currentPos.market, errorMessage: `Sell timeout/error: ${err.message}` },
      sellGuardrailDeps
    );
    return false;
  }

  const settled = await settleLiveSellOrderInDb({
    db,
    bot,
    targetPositions,
    sellUuid,
    sellPrice: executedSellAvgPrice,
    actualTotalFunds,
    actualTotalFee,
    reasonLabel,
  });
  await confirmSellIntentAtomic(
    db,
    { intentId: sellIntentId, upbitOrderUuid: sellUuid, targetPositionIds },
    sellGuardrailDeps
  );
  cleanseAttemptMap.delete(cleanseGuardKey);
  liveBotCooldownMap.set(`${bot.bot_id}|${currentPos.market}`, Date.now());

  // 업비트 실계좌 조회 가능 시 총 운영원금 동기화(성공 시 실잔고 90% 기준으로 정렬; 실패 시 위 Zero-Sum 직접 이관 유지)
  await syncDynamicLiveCapitalFromUpbit(true).catch(() => null);

  if (settled.isDrainingBot) {
    const activeBots = (await getBots("live")).filter((b) => Number(b.is_selected_for_live) === 1);
    const activeDesc = activeBots
      .map((ab) => `${ab.nickname}(비율 ${Number(ab.allocation_ratio || 0).toFixed(0)}% / 가용 ${Math.floor(Number(ab.virtual_krw || 0)).toLocaleString("ko-KR")}원)`)
      .join(", ");
    console.log(
      `[Graceful Drain 정산 이관] 탈락 봇 ${bot.bot_id}(${bot.nickname}) ${currentPos.market} ${reasonLabel} 매도 정산금 ${settled.netProceeds.toLocaleString("ko-KR")}원(실현손익 ${
        settled.totalProfitKrw >= 0 ? "+" : ""
      }${settled.totalProfitKrw.toLocaleString("ko-KR")}원) 회수 -> 활성 실전 봇 자동 귀속 (${activeDesc || "없음"})`
    );
  }
  await checkAndHaltIfZeroBalance();
  return true;
}

// ============================================================================
// 1. 실거래 매매 스케줄러 (선택된 1~3개 실전 봇 전용 - 기존 LLM/Regime 필터 100% 보존)
//    + 5중 하드 가드레일(Re-entrancy Mutex · Lease Lock · Timeout Reconciliation)
// ============================================================================
// [Antigravity-Doc] 실거래 스케줄러 및 틱 반응형 청산 런타임 상태·뮤텍스·캐시 맵
// - isBackendShuttingDown: SIGINT/SIGTERM 수신 시 신규 사이클 진입 차단
// - isLiveCycleRunning / liveCycleStartedAtMs: 비동기 재진입 뮤텍스 및 180초 고착 감지용
// - liveBotPeakMap: 포지션별 트레일링 스탑 최고가 추적 (`live-${pos.id}`)
// - liveBotCooldownMap: 매도 후 동일 종목 15분 재진입 쿨다운 (`${botId}|${market}`)
// - cleanseAttemptMap: 소액 Buy-to-Cleanse 15분 중복 시도 방지 캐시
// - lastTickExitCheckMap / inFlightTickExitSet: WebSocket 틱 청산 1.5초 디바운스 및 마켓별 동시 실행 락
// - circuitBreakerNotifiedDateMap: 일일 -4% 서킷브레이커 당일 중복 알림 방지
let isBackendShuttingDown = false;
let isLiveCycleRunning = false;
let liveCycleStartedAtMs = 0;
const liveBotPeakMap = new Map();
const liveBotCooldownMap = new Map();
const cleanseAttemptMap = new Map();
const lastTickExitCheckMap = new Map();
const inFlightTickExitSet = new Set();
const circuitBreakerNotifiedDateMap = new Map();
const LIVE_REENTRY_COOLDOWN_MS = 15 * 60 * 1000;
const TICK_EXIT_DEBOUNCE_MS = 1500;

/**
 * [Antigravity-Doc] 현재 실거래 사이클 뮤텍스 점유 여부 및 경과 시간(ms)을 반환한다(가드레일 상태 조회용).
 */
function getLiveCycleMutexState() {
  return {
    isRunning: isLiveCycleRunning,
    startedAtMs: liveCycleStartedAtMs,
    elapsedMs: isLiveCycleRunning && liveCycleStartedAtMs > 0 ? Math.max(0, Date.now() - liveCycleStartedAtMs) : 0,
  };
}

/**
 * [Antigravity-Doc] 인메모리 재진입 쿨다운 캐시를 초기화한다(테스트/수동 리셋용).
 */
function clearLiveCooldownCache() {
  liveBotCooldownMap.clear();
}

/**
 * [Antigravity-Doc] SQLite 기반 단일 실전 실행 주체 프로세스 리스(TTL 30초)를 획득하거나 갱신한다.
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
async function acquireLiveExecutorLease(options = {}) {
  const db = getDb();
  if (!db) return { ok: false, code: "NO_DB", reason: "DB not initialized" };
  return await acquireOrRenewLiveExecutorLease(
    db,
    {
      runtimeConfig: getRuntimeConfig(),
      withDbWriteLock,
      beginWriteTx,
      commitWriteTx,
      rollbackWriteTx,
    },
    { engine: "node", ...options }
  );
}

/**
 * [Antigravity-Doc] 그레이스풀 셧다운 시 보유 중인 실전 실행 리스를 즉시 반납한다.
 */
async function releaseLiveExecutorLeaseNow(options = {}) {
  const db = getDb();
  if (!db) return false;
  return await releaseLiveExecutorLease(
    db,
    {
      withDbWriteLock,
      beginWriteTx,
      commitWriteTx,
      rollbackWriteTx,
    },
    { engine: "node", ...options }
  );
}

/**
 * [Antigravity-Doc] 네트워크 타임아웃 등으로 미확정(`UNKNOWN_TIMEOUT`) 상태에 머문 주문 의도(Intent)를
 * 업비트 `identifier` 조회로 대사하여 체결 확정 또는 안전 환불을 완료한다.
 */
async function reconcileLiveOrderIntents(options = {}) {
  const db = getDb();
  if (!db) return { checked: 0, confirmed: 0, refunded: 0, pending: 0 };
  return await reconcileUnknownTimeoutIntents(
    db,
    {
      runtimeConfig: getRuntimeConfig(),
      createUpbitJwt,
      cancelUpbitOrder,
      normalizeExecPrice,
      settleLiveSellOrderInDb,
      syncBotAccountsFromBots,
      withDbWriteLock,
      beginWriteTx,
      commitWriteTx,
      rollbackWriteTx,
    },
    options
  );
}

/**
 * [Antigravity-Doc] 대시보드 및 `/api/guardrail/status`용 실전 주문 가드레일 종합 상태 페이로드를 반환한다.
 */
async function getLiveGuardrailStatusPayload() {
  const db = getDb();
  if (!db) {
    return {
      ok: false,
      live_executor_owner: getLiveExecutorOwner(getRuntimeConfig()),
      emergency_halted: false,
    };
  }
  return await getGuardrailStatus(db, getRuntimeConfig(), getLiveCycleMutexState());
}

// [Antigravity-Doc] 최근 5분간 계산된 마켓별 기술지표 캐시 (WebSocket 틱 청산 시 ATR 등 보조지표 즉시 참조용)
const latestMarketIndicatorsCache = new Map();
const TICK_INDICATOR_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * [Antigravity-Doc] 업비트 WebSocket 실시간 체결 틱 수신 시 호출되는 초저지연 반응형 스마트 청산 핸들러.
 * 10초 정기 루프를 기다리지 않고 1.5초 디바운스로 해당 마켓의 모든 OPEN 포지션(Draining 포함)에 대해
 * 3단계 스마트 청산(본절/시간제한/ATR 트레일링) 및 손절·익절 임계치 도달 시 즉시 `executeBotSellOrder`를 실행한다.
 * @param {{market?:string, price?:number, ticker?:object, indicators?:object, bypassDebounce?:boolean, allowPaperMode?:boolean, skipUpbitApi?:boolean}} [tickEvent={}]
 * @returns {Promise<object>}
 */
export async function triggerTickReactiveSmartExit(tickEvent = {}) {
  const market = String(tickEvent?.market || "").trim().toUpperCase();
  const price = Number(tickEvent?.price || 0);
  if (!market || !Number.isFinite(price) || price <= 0) {
    return { triggered: false, reason: "INVALID_TICK" };
  }

  if (tickEvent?.ticker) {
    upbitTickersCache.set(market, { ts: Date.now(), data: tickEvent.ticker });
  }

  if (!isLiveMode() && !tickEvent?.allowPaperMode) {
    return { triggered: false, reason: "NOT_LIVE_MODE" };
  }

  if (inFlightTickExitSet.has(market)) {
    return { triggered: false, reason: "IN_FLIGHT" };
  }

  const nowMs = Date.now();
  const lastCheckMs = lastTickExitCheckMap.get(market) || 0;
  if (!tickEvent?.bypassDebounce && nowMs - lastCheckMs < TICK_EXIT_DEBOUNCE_MS) {
    return { triggered: false, reason: "DEBOUNCED" };
  }

  const db = getDb();
  if (!db) return { triggered: false, reason: "NO_DB" };

  let openRows = [];
  try {
    openRows = await db
      .prepare(
        `SELECT p.*, b.stop_loss_pct, b.take_profit_pct, b.nickname, b.name, b.is_selected_for_live
         FROM bot_positions p
         JOIN bots b ON p.bot_id = b.bot_id
         WHERE p.market = ? AND p.status = 'OPEN'
         ORDER BY p.id ASC`
      )
      .all(market);
  } catch (dbErr) {
    console.warn(`[TickExit][${market}] 오픈 포지션 DB 조회 오류:`, dbErr?.message || dbErr);
    return { triggered: false, reason: "DB_QUERY_ERROR" };
  }

  if (!Array.isArray(openRows) || openRows.length === 0) {
    return { triggered: false, reason: "NO_OPEN_POSITION" };
  }

  lastTickExitCheckMap.set(market, nowMs);
  inFlightTickExitSet.add(market);
  const soldPositions = [];

  try {
    for (const pos of openRows) {
      const avgBuy = Number(pos.avg_buy_price || 0);
      if (avgBuy <= 0) continue;

      const peakKey = `live-${pos.id}`;
      const prevPeak = Number(liveBotPeakMap.get(peakKey) || pos.highest_price || avgBuy);
      const curPeak = Math.max(prevPeak, price);
      liveBotPeakMap.set(peakKey, curPeak);

      const pnlPct = ((price - avgBuy) / avgBuy) * 100.0;
      const stopLossPct = -Math.abs(Number(pos.stop_loss_pct || 2.5));
      const takeProfitPct = Math.abs(Number(pos.take_profit_pct || 4.5));

      const cachedIndEntry = latestMarketIndicatorsCache.get(market);
      const resolvedIndicators =
        tickEvent?.indicators ||
        (cachedIndEntry && nowMs - cachedIndEntry.ts <= TICK_INDICATOR_CACHE_TTL_MS ? cachedIndEntry.indicators : null);

      let exitReason = "";
      const smartExit = evaluateSmartExit({
        botId: pos.bot_id,
        position: pos,
        currentPrice: price,
        indicators: resolvedIndicators,
        peakPrice: curPeak,
        isLive: true,
        stopLossPct,
      });

      if (smartExit && smartExit.signal === "SELL") {
        exitReason = smartExit.reason;
      } else if (pnlPct <= stopLossPct) {
        exitReason = `틱즉시손절(${pnlPct.toFixed(2)}%)`;
      } else if (pnlPct >= takeProfitPct) {
        exitReason = `틱즉시익절(+${pnlPct.toFixed(2)}%)`;
      }

      if (exitReason) {
        const botRef = {
          bot_id: pos.bot_id,
          nickname: pos.nickname || pos.name || pos.bot_id,
          name: pos.name || pos.bot_id,
        };
        const sold = await executeBotSellOrder(botRef, pos, price, exitReason, {
          skipUpbitApi: Boolean(tickEvent?.skipUpbitApi),
        });
        if (sold) {
          liveBotPeakMap.delete(peakKey);
          soldPositions.push({
            position_id: pos.id,
            bot_id: pos.bot_id,
            market,
            sell_price: price,
            reason: exitReason,
          });
        }
      }
    }
    return {
      triggered: soldPositions.length > 0,
      sold_count: soldPositions.length,
      sold_positions: soldPositions,
    };
  } finally {
    inFlightTickExitSet.delete(market);
  }
}

upbitWsHub.onTickerTick((tickEvent) => {
  triggerTickReactiveSmartExit(tickEvent).catch((tickErr) => {
    console.warn(`[TickExit][${tickEvent?.market || "UNKNOWN"}] 틱 반응형 청산 처리 오류:`, tickErr?.message || tickErr);
  });
});

const livePaceSkipLogMap = new Map();
// 진단 스킵 메시지(속도제어 대기/호가 품질 가드/미체결 등) 실제 기록 시각 추적
// (syncDynamicLiveCapitalFromUpbit가 bots.updated_at을 6~10초마다 갱신해도 3분 TTL이 영구 연장되지 않도록 분리)
const liveDiagnosticStatusTsMap = new Map();
/**
 * [Antigravity-Doc] 봇의 진단 스킵 메시지(속도제어/호가 가드/미체결 등)가 3분간 UI에 유지되도록 기록 시각을 저장한다.
 */
function markBotDiagnosticStatus(botId) {
  if (botId) liveDiagnosticStatusTsMap.set(botId, Date.now());
}
/**
 * [Antigravity-Doc] KST 또는 ISO-8601 타임스탬프 문자열을 UTC 에포크 밀리초로 변환한다.
 */
function parseKstDateTimeMsLocal(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  if (!s) return NaN;
  if (s.includes("T") && (s.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(s))) {
    return Date.parse(s);
  }
  return Date.parse(s.replace(" ", "T") + "+09:00");
}

/**
 * [Antigravity-Doc] 10초 주기 실거래 자동매매 메인 사이클.
 * 실행 흐름:
 *  1. 가드레일 선행: 종료/모드 검사 -> 재진입 뮤텍스(180초 고착 복구) -> 프로세스 리스 획득 -> `UNKNOWN_TIMEOUT` 인텐트 대사 -> 동적 자본 동기화.
 *  2. 감시 대상 수집: 활성 봇 + Draining/일시정지 보유 포지션 봇의 유니버스 마켓 시세·지표·모멘텀 랭킹 일괄 빌드.
 *  3. 보유 포지션 청산 우선 평가: 스마트 청산 -> 손절/익절 -> 전략별 SELL 시그널 (비활성/차단/Draining 상태와 무관하게 무조건 실행).
 *  4. 신규 매수 탐색: 가동·잔고(>=5,050원)·서킷브레이커(-4%)·듀얼 AI 게이트웨이(`allowBuy`/`botOverrides`/`blacklist`)·속도제어 선검사(`precheckLiveBuyPaceLimits`) 통과 시 `executeBotBuyOrder` 실행.
 * @param {object} [options={}] 테스트용 오버라이드(`tickerMapOverride`, `mdMapOverride`, `skipUpbitApi` 등)
 * @returns {Promise<object|undefined>}
 */
export async function runLiveTradingBotsCycle(options = {}) {
  if (isBackendShuttingDown) return { skipped: true, reason: "BACKEND_SHUTTING_DOWN" };
  // 가상거래 모드에서는 Always-On Arena(runAlwaysOnPaperArenaCycle)가 10대 봇을 독립 운용하므로 실전 루프의 paper_* 교차 오염을 원천 차단
  if (!isLiveMode() && !options?.allowPaperMode) return { skipped: true, reason: "NOT_LIVE_MODE" };

  // [Phase 3] 비동기 루프 중첩 방지 (Re-entrancy Mutex + 시작 타임스탬프 + 180초 초과 비정상 고착 안전 복구)
  if (isLiveCycleRunning) {
    const elapsedMs = liveCycleStartedAtMs > 0 ? Date.now() - liveCycleStartedAtMs : 0;
    if (elapsedMs > LIVE_CYCLE_STALE_WARN_MS) {
      console.warn(
        `[LiveCycleMutex] WARNING: 이전 실전 사이클이 ${Math.round(elapsedMs / 1000)}초(>180초) 동안 종료되지 않아 안전 복구 후 재진입합니다.`
      );
      isLiveCycleRunning = false;
      liveCycleStartedAtMs = 0;
    } else {
      return { skipped: true, reason: "LIVE_CYCLE_MUTEX_ACTIVE", elapsed_ms: elapsedMs };
    }
  }

  isLiveCycleRunning = true;
  liveCycleStartedAtMs = Date.now();
  try {
    // [Phase 1] 단일 실전 실행 주체(LIVE_EXECUTOR_OWNER) + SQLite 프로세스 리스 락(TTL 30초) 획득/갱신
    const leaseRes = await acquireLiveExecutorLease({
      ownerId: options?.leaseOwnerId || "node",
      pid: options?.leasePid,
      host: options?.leaseHost,
    });
    if (!leaseRes.ok) {
      console.warn(`[LiveTradingCycle][Guardrail] 리스 락 미획득으로 사이클 건너뜀 (${leaseRes.code}): ${leaseRes.reason}`);
      return { skipped: true, reason: leaseRes.code, detail: leaseRes.reason };
    }

    // [Phase 2] 미해결 UNKNOWN_TIMEOUT 인텐트 업비트 identifier 정산 우선 수행
    if (!options?.skipUpbitApi || options?.reconcileTimeoutIntents) {
      await reconcileLiveOrderIntents().catch((recErr) => {
        console.warn("[LiveTradingCycle] Timeout intent reconciliation warning:", recErr.message);
      });
    }

    // 업비트 실계좌 잔고 기반 90% 동적 운영원금 동기화 (테스트/오프라인 skipUpbitApi 시 건너뜀)
    if (!options?.skipUpbitApi) {
      await syncDynamicLiveCapitalFromUpbit();
    }

    const haltInfo = await checkAndHaltIfZeroBalance("live");
    const allowNewBuysGlobal = !haltInfo.halted;

    const db = getDb();
    // 실전 선택+가동 중 봇 및 포지션 보호(Graceful Drain · 일시정지 보유 물량 포함) 대상 봇 모두 포함
    const allLiveBots = await getBots("live");
    const cycleBots = allLiveBots.filter(
      (b) =>
        (Number(b.is_selected_for_live) === 1 &&
          (Number(b.is_running) === 1 || (b.open_positions || []).length > 0)) ||
        (Number(b.is_selected_for_live) === 0 && (b.open_positions || []).length > 0)
    );
    if (cycleBots.length === 0) return;

    const baseMarkets = [...DEFAULT_MONITORED_KRW_MARKETS];
    // 기본 10종목 외 보유/Graceful Drain 포지션 종목도 누락 없이 병합하여 청산 감시 보장
    const openPosMarkets = cycleBots
      .flatMap((b) => (b.open_positions || []).map((p) => p.market || p.ticker))
      .filter(Boolean);
    const allMarkets = [...new Set([...baseMarkets, ...openPosMarkets])];
    if (upbitWsHub.isConnected()) {
      upbitWsHub.updateSubscriptions(allMarkets);
    }
    const tickerMap = options?.tickerMapOverride || (await fetchUpbitTickersMap(allMarkets));
    if (!tickerMap || tickerMap.size === 0) {
      console.warn(`[LiveTradingCycle] Upbit tickerMap 조회 비어 있음 (${allMarkets.length}종목) — 사이클 건너뜀`);
      return;
    }

    // 지표 패키지 사전 빌드 (공유 캐시 활용)
    const mdMap = options?.mdMapOverride || new Map();
    if (!options?.mdMapOverride) {
      for (const m of allMarkets) {
        const tk = tickerMap.get(m);
        if (tk) {
          mdMap.set(m, await buildMarketData(m, tk, fetchUpbitCandlesSorted));
        }
      }
    }
    const indCacheNowMs = Date.now();
    for (const [m, md] of mdMap.entries()) {
      if (md?.indicators) {
        latestMarketIndicatorsCache.set(String(m).toUpperCase(), { ts: indCacheNowMs, indicators: md.indicators });
      }
    }
    const { computeMomentumRanking } = await import("./common/algo_lab_service.mjs");
    const rankMap = options?.rankMapOverride || computeMomentumRanking(mdMap, allMarkets);

    const sellOpts = options?.skipUpbitApi ? { skipUpbitApi: true } : {};

    for (const bot of cycleBots) {
      const now = nowKSTString();
      const stopLossPct = -Math.abs(Number(bot.stop_loss_pct || 2.5));
      const takeProfitPct = Math.abs(Number(bot.take_profit_pct || 4.5));
      const minVol = Number(bot.min_volume_krw || 0);
      const cfg = bot.config || {};
      const params = {
        ...cfg,
        stop_loss_pct: bot.stop_loss_pct,
        take_profit_pct: bot.take_profit_pct,
      };

      // 1) 보유 포지션 손절/익절 및 알고리즘 SELL 시그널 평가 (BLOCK/해제/일시정지/잔고부족 여부와 무관하게 무조건 실행)
      const openByMarket = new Map();
      for (const p of bot.open_positions || []) {
        const mkt = p.market || p.ticker;
        if (!mkt) continue;
        if (!openByMarket.has(mkt)) openByMarket.set(mkt, []);
        openByMarket.get(mkt).push(p);
      }
      const soldPosIds = new Set();

      for (const pos of bot.open_positions || []) {
        if (soldPosIds.has(pos.id)) continue;
        const mkt = pos.market || pos.ticker;
        const tk = tickerMap.get(mkt);
        if (!tk) continue;
        const curPrice = Number(tk.trade_price);
        if (!Number.isFinite(curPrice) || curPrice <= 0) continue;
        const avgBuy = Number(pos.avg_buy_price);
        const pnlPct = avgBuy > 0 ? ((curPrice - avgBuy) / avgBuy) * 100.0 : 0;

        // 트레일링 스탑용 고점 갱신
        const peakKey = `live-${pos.id}`;
        const curPeak = Math.max(Number(liveBotPeakMap.get(peakKey) || avgBuy), curPrice);
        liveBotPeakMap.set(peakKey, curPeak);

        const md = mdMap.get(mkt);

        // 3단계 스마트 청산 유틸리티 (본절 스탑, 시간 제한 청산, 동적 ATR 트레일링 스탑)
        const smartExit = evaluateSmartExit({
          botId: bot.bot_id,
          position: pos,
          currentPrice: curPrice,
          indicators: md?.indicators,
          peakPrice: curPeak,
          isLive: true,
          stopLossPct: stopLossPct,
        });
        if (smartExit && smartExit.signal === "SELL") {
          const sold = await executeBotSellOrder(bot, pos, curPrice, smartExit.reason, sellOpts);
          if (sold) {
            liveBotPeakMap.delete(peakKey);
            soldPosIds.add(pos.id);
          }
          continue;
        }

        if (pnlPct <= stopLossPct) {
          const sold = await executeBotSellOrder(bot, pos, curPrice, `손절(${pnlPct.toFixed(2)}%)`, sellOpts);
          if (sold) {
            liveBotPeakMap.delete(peakKey);
            soldPosIds.add(pos.id);
          }
          continue;
        }
        if (pnlPct >= takeProfitPct) {
          const sold = await executeBotSellOrder(bot, pos, curPrice, `익절(+${pnlPct.toFixed(2)}%)`, sellOpts);
          if (sold) {
            liveBotPeakMap.delete(peakKey);
            soldPosIds.add(pos.id);
          }
          continue;
        }

        // 10대 알고리즘 전략별 청산 시그널 평가 (다중 분할 bot_06/bot_10은 동일 종목 그룹 전체 기준 평가)
        if (md) {
          const sameMktOpen = (openByMarket.get(mkt) || [pos]).filter((p) => !soldPosIds.has(p.id));
          const evalHeldInput =
            (bot.bot_id === "bot_10" || bot.bot_id === "bot_06") && sameMktOpen.length > 1 ? sameMktOpen : pos;
          const sig = evaluateStrategy(bot.bot_id, md, md.indicators, evalHeldInput, {
            params,
            peakPrice: curPeak,
            momentumRank: rankMap,
            market: mkt,
            isLive: true,
          });
          if (sig.signal === "SELL") {
            const sellTargets = Array.isArray(sig.sellPositionIds)
              ? sameMktOpen.filter((p) => sig.sellPositionIds.includes(p.id))
              : Array.isArray(evalHeldInput)
              ? evalHeldInput
              : [pos];
            for (const targetPos of sellTargets) {
              if (soldPosIds.has(targetPos.id)) continue;
              const sold = await executeBotSellOrder(bot, targetPos, curPrice, sig.reason, sellOpts);
              if (sold) {
                liveBotPeakMap.delete(`live-${targetPos.id}`);
                soldPosIds.add(targetPos.id);
                // 소액 다중 포지션 통합 청산(singleEvalKrw < 5,500원)으로 함께 닫힌 동일 종목 포지션도 즉시 soldPosIds에 반영
                const stillOpenRows = await db
                  .prepare("SELECT id FROM bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN'")
                  .all(bot.bot_id, mkt);
                const stillOpenSet = new Set(stillOpenRows.map((r) => r.id));
                for (const p of sameMktOpen) {
                  if (!stillOpenSet.has(p.id)) {
                    liveBotPeakMap.delete(`live-${p.id}`);
                    soldPosIds.add(p.id);
                  }
                }
              }
            }
            continue;
          }
        }
      }

      const refreshedBot = (await getBots("live")).find((b) => b.bot_id === bot.bot_id);
      if (!refreshedBot) continue;

      const remainingOpenCount = (refreshedBot.open_positions || []).length;
      const isSelectedLive = Number(refreshedBot.is_selected_for_live) === 1;
      const isRunningLive = Number(refreshedBot.is_running) === 1;

      if (!isSelectedLive) {
        const curMsg = String(refreshedBot.last_status_msg || "");
        if (remainingOpenCount === 0 && curMsg.startsWith("[✅ Graceful Drain 완료]")) {
          continue;
        }
        const drainMsg =
          remainingOpenCount > 0
            ? `[포지션 보호 청산 대기] 실전 해제됨 · 보유 ${remainingOpenCount}건 고유 전략 청산 감시중`
            : "실전 미선택 대기 중";
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          drainMsg,
          now,
          bot.bot_id
        );
        continue;
      }

      if (!allowNewBuysGlobal || !isRunningLive || Number(refreshedBot.allocated_capital) <= 0) {
        const curVkrw = Math.max(0, Math.floor(Number(refreshedBot.virtual_krw || 0)));
        if (isRunningLive && remainingOpenCount === 0 && curVkrw < MIN_LIVE_ORDER_SAFE_KRW) {
          await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
            `[⏳ 자금 복원 대기 중] 가용 ${curVkrw.toLocaleString("ko-KR")}원 (< 5,050원) · 기존 탈락 봇 청산 시 자동 매수 개시`,
            now,
            bot.bot_id
          );
        } else if (remainingOpenCount > 0) {
          await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
            `[일시중지 · 포지션 보호] 보유 ${remainingOpenCount}건 익절/손절 감시중`,
            now,
            bot.bot_id
          );
        }
        continue;
      }

      // [최소 주문금액(5,050원) 미달 자금 복원 대기 상태] 주문 거절 반복 없이 대기 후 복원 즉시 자동 매수 재개
      const availForNewBuy = Number(refreshedBot.virtual_krw || 0);
      if (availForNewBuy >= 0 && availForNewBuy < MIN_LIVE_ORDER_SAFE_KRW) {
        const waitMsg =
          remainingOpenCount > 0
            ? `실시간 감시 중 (${remainingOpenCount}건 보유 · 추가 매수 가용 ${Math.floor(availForNewBuy).toLocaleString("ko-KR")}원 < 5,050원)`
            : `[⏳ 자금 복원 대기 중] 가용 ${Math.floor(availForNewBuy).toLocaleString("ko-KR")}원 (< 5,050원) · 기존 탈락 봇 청산 시 자동 매수 개시`;
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          waitMsg,
          now,
          bot.bot_id
        );
        continue;
      }

      const heldSet = new Set((refreshedBot.open_positions || []).map((p) => p.market));
      const maxPositions = Math.max(1, Number(cfg.max_positions || 3));

      // [실전 서킷 브레이커] 당일(00:00 KST 기준) 누적 실현 손실이 배정 원금의 -4.0% 이하 시 신규 매수 차단
      const todayStartKst = `${nowKSTString().split(" ")[0]} 00:00:00`;
      let dailyProfit = 0;
      try {
        const dailyRow = await db
          .prepare("SELECT COALESCE(SUM(profit_krw), 0) AS daily_profit FROM trades WHERE bot_id = ? AND status = 'COMPLETED' AND sell_date >= ?")
          .get(bot.bot_id, todayStartKst);
        dailyProfit = Number(dailyRow?.daily_profit || 0);
      } catch (cbErr) {
        console.warn(`[CircuitBreaker][${bot.bot_id}] 당일 실현 손실 조회 오류:`, cbErr?.message || cbErr);
      }

      const allocatedCap = Number(refreshedBot.allocated_capital || 0);
      const lossLimit = allocatedCap > 0 ? -Math.floor(allocatedCap * 0.04) : -40000;
      if (allocatedCap > 0 && dailyProfit <= lossLimit) {
        const cbMsg = `[서킷 브레이커 발동] 당일 실현 손실(${dailyProfit.toLocaleString("ko-KR")}원 / -4.0% 한도 도달)로 자정까지 신규 매수 일시 차단`;
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          cbMsg,
          now,
          bot.bot_id
        );
        const todayKey = `${bot.bot_id}|${todayDateString()}`;
        if (!circuitBreakerNotifiedDateMap.has(todayKey)) {
          circuitBreakerNotifiedDateMap.set(todayKey, true);
          dispatchMultiChannelNotification(
            db,
            {
              eventType: "CIRCUIT_BREAKER",
              botId: bot.bot_id,
              botName: refreshedBot.nickname || refreshedBot.name || bot.bot_id,
              profitKrw: dailyProfit,
              reason: cbMsg,
            },
            { webPushBroadcastFn: broadcastWebPushNotification }
          ).catch(() => {});
        }
        continue;
      }

      // [듀얼 AI 동적 매수 게이트웨이] final_risk_alert / HALT_NEW_BUYS / bot_overrides[bot_id] === 'BLOCK' 확인
      const regimeInfo = await checkMarketRegimeFilter(tickerMap, options);
      if (
        regimeInfo.finalRiskAlert ||
        !regimeInfo.allowBuy ||
        regimeInfo.finalAction === "HALT_NEW_BUYS" ||
        regimeInfo.finalAction === "EMERGENCY_CLOSE_ALL" ||
        regimeInfo.multiplier <= 0
      ) {
        const msg =
          remainingOpenCount > 0
            ? `🟡 AI 장세 필터(${regimeInfo.finalAction})로 신규 진입 보류(보유 포지션 ${remainingOpenCount}건 정상 감시)`
            : `🟡 AI 장세 필터(${regimeInfo.finalAction})로 신규 진입 보류: ${regimeInfo.reason}`;
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          msg,
          now,
          bot.bot_id
        );
        continue;
      }

      const botOverrides = regimeInfo.botOverrides || {};
      const isBotBlocked = botOverrides[bot.bot_id] === "BLOCK";
      if (isBotBlocked) {
        const blockMsg =
          remainingOpenCount > 0
            ? `AI 장세 필터에 의해 신규 진입 보류(보유 포지션 ${remainingOpenCount}건 정상 감시)`
            : "AI 장세 필터에 의해 신규 진입 보류(보유 포지션은 정상 감시)";
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          blockMsg,
          now,
          bot.bot_id
        );
        continue;
      }

      const blacklistSet = new Set(
        (regimeInfo.blacklistTickers || []).map((t) => String(t || "").trim().toUpperCase())
      );

      // 2) 신규 매수 시그널 탐색 (블랙리스트 코인 제외)
      let candidates = allMarkets.filter((m) => {
        if (blacklistSet.has(String(m).toUpperCase())) return false;
        const tk = tickerMap.get(m);
        return tk && Number(tk.acc_trade_price_24h || 0) >= minVol && mdMap.get(m);
      });
      if (bot.bot_id === "bot_03") {
        candidates.sort((a, b) => (rankMap[a]?.rank || 99) - (rankMap[b]?.rank || 99));
      }

      let actionMsg = "";
      for (const mkt of candidates) {
        if (heldSet.has(mkt) && bot.bot_id !== "bot_06" && bot.bot_id !== "bot_10") continue;
        if (!heldSet.has(mkt) && heldSet.size >= maxPositions) continue;

        const md = mdMap.get(mkt);
        const held = (refreshedBot.open_positions || []).filter((p) => p.market === mkt);
        if (bot.bot_id === "bot_10" && held.length >= 2) continue;

        // 매도 직후 동일 종목 재진입 쿨다운(15분)은 아래 precheckLiveBuyPaceLimits에서 통합 검사 및 쓰로틀 로그/상태 기록
        const sig = evaluateStrategy(bot.bot_id, md, md.indicators, held, {
          params,
          momentumRank: rankMap,
          market: mkt,
          isLive: true,
        });

        if (sig.signal === "BUY") {
          // 10초 주기 루프 정상 속도 제어(쿨다운/최소매수간격/시간당·일일·전체 상한) 사전 검사
          // (virtual_krw < 0 이상치는 가드레일 Kill-Switch가 즉시 감지하도록 선검사 생략)
          if (Number(refreshedBot.virtual_krw || 0) >= 0) {
            const paceCheck = await precheckLiveBuyPaceLimits(db, {
              botId: bot.bot_id,
              market: mkt,
              openCount: held.length,
              runtimeConfig: getRuntimeConfig(),
              inMemoryCooldownMap: liveBotCooldownMap,
              ignoreCooldown: Boolean(options?.ignoreCooldown),
              ignoreMinInterval: Boolean(options?.ignoreMinInterval),
            });
            if (!paceCheck.ok) {
              const throttleKey = `${bot.bot_id}|${mkt}|${paceCheck.code}`;
              const lastLogMs = livePaceSkipLogMap.get(throttleKey) || 0;
              if (Date.now() - lastLogMs >= 60 * 1000) {
                livePaceSkipLogMap.set(throttleKey, Date.now());
                console.warn(`[LiveBuySkip][${bot.bot_id}][${mkt}] 속도제어 선검사 보류 (${paceCheck.code}): ${paceCheck.reason}`);
              }
              await db
                .prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?")
                .run(`[속도제어 대기:${paceCheck.code}] ${paceCheck.reason}`, now, bot.bot_id);
              markBotDiagnosticStatus(bot.bot_id);
              continue;
            }
          }

          const baseRatio = Number(sig.order_ratio || cfg.order_ratio || 0.35);
          const atr14Val = Number(md?.indicators?.m15?.atr14 || 0);
          const atrInfo = computeAtrVolatilityMultiplier({
            atr14: atr14Val,
            currentPrice: md.price,
          });
          const orderKrw = getSafeOrderKrw(refreshedBot, baseRatio, regimeInfo.multiplier ?? 1.0, {
            atr14: atr14Val,
            currentPrice: md.price,
          });
          if (orderKrw >= 5000) {
            const ok = await executeBotBuyOrder(refreshedBot, mkt, orderKrw, md.price, sig.reason, {
              ...sellOpts,
              stepIndex: held.length + 1,
              ignoreCooldown: Boolean(options?.ignoreCooldown),
              ignoreMinInterval: Boolean(options?.ignoreMinInterval),
              atrSizingMult: atrInfo.atr_sizing_mult,
            });
            if (ok) {
              actionMsg = `${mkt} ${sig.reason} 매수 체결 (${orderKrw.toLocaleString("ko-KR")}원)`;
              break;
            }
          } else {
            const minOrderMsg = `[최소주문 미달] ${mkt} 가용 원화 부족으로 최소안전주문(5,250원) 미달 (가용 ${Number(refreshedBot.virtual_krw || 0).toLocaleString("ko-KR")}원)`;
            console.warn(
              `[LiveBuySkip][${bot.bot_id}][${mkt}] 가용 원화 부족으로 최소안전주문(5,250원) 미달 (virtual_krw=${refreshedBot.virtual_krw}, mult=${regimeInfo.multiplier})`
            );
            await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
              minOrderMsg,
              now,
              bot.bot_id
            );
            markBotDiagnosticStatus(bot.bot_id);
          }
        }
      }

      if (!actionMsg) {
        const postBotRow = await db.prepare("SELECT is_running, last_status_msg, updated_at FROM bots WHERE bot_id = ?").get(bot.bot_id);
        const postMsg = String(postBotRow?.last_status_msg || "");
        const isHardPreservedMsg = postMsg.includes("가드레일") || postMsg.includes("타임아웃 정산");
        const isDiagnosticSkipMsg =
          postMsg.includes("호가 품질 가드") ||
          postMsg.includes("블랙리스트") ||
          postMsg.includes("미체결") ||
          postMsg.includes("주문 거절") ||
          postMsg.includes("속도제어 대기") ||
          postMsg.includes("최소주문 미달");
        let withinDiagnosticTtl = false;
        if (isDiagnosticSkipMsg) {
          const diagTs = liveDiagnosticStatusTsMap.get(bot.bot_id);
          withinDiagnosticTtl = Number.isFinite(diagTs) ? Date.now() - diagTs < 3 * 60 * 1000 : false;
          if (!withinDiagnosticTtl && diagTs !== undefined) {
            liveDiagnosticStatusTsMap.delete(bot.bot_id);
          }
        }
        const shouldPreserveMsg = isHardPreservedMsg || withinDiagnosticTtl;
        if (Number(postBotRow?.is_running ?? 1) === 1 && !shouldPreserveMsg) {
          const holdCnt = heldSet.size;
          const multPct = Math.round(Number(regimeInfo.multiplier ?? 1.0) * 100);
          const statusText = holdCnt > 0
            ? `실시간 감시 중 (${holdCnt}건 포지션 보유 · 익절/손절 감시 · AI 비중 ${multPct}%)`
            : `🟢 AI 신규매수 허용 (비중 ${multPct}%) · 진입 시그널 탐색`;
          await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
            statusText,
            now,
            bot.bot_id
          );
        }
      }
    }
  } catch (err) {
    console.error("[LiveTradingCycle] Error:", err.message);
  } finally {
    isLiveCycleRunning = false;
    liveCycleStartedAtMs = 0;
  }
}

// ============================================================================
// 2. 가상거래 상시 경쟁 스케줄러 (10대 순수 알고리즘 Always-On Arena - LLM/Regime 필터 완전 우회)
// ============================================================================
// [Antigravity-Doc] 10대 알고리즘 상시 가상 아레나 동시 실행 방지 플래그
let isPaperArenaCycleRunning = false;

/**
 * [Antigravity-Doc] 9초 주기 상시 가상거래 아레나 사이클(10대 순수 알고리즘 비교 검증용, AI 장세 필터 완전 우회).
 */
async function runAlwaysOnPaperArenaCycle() {
  if (isPaperArenaCycleRunning) return;
  isPaperArenaCycleRunning = true;
  try {
    const db = getDb();
    if (!db) return;
    await runArenaCycle(db, {
      getUniverse: async () => {
        const markets = await getValidKrwMarkets();
        const major = [...DEFAULT_MONITORED_KRW_MARKETS];
        const valid = markets.size > 0 ? major.filter((m) => markets.has(m)) : major;
        return valid.length > 0 ? valid : major;
      },
      fetchTickersMap: fetchUpbitTickersMap,
      fetchCandles: fetchUpbitCandlesSorted,
      getOrderbook: (market) => (!upbitWsHub.isStale() ? upbitWsHub.getLatestOrderbook(market) : null),
    });
  } catch (err) {
    console.warn("[AlwaysOnPaperArena] Cycle error:", err.message);
  } finally {
    isPaperArenaCycleRunning = false;
  }
}

/**
 * [Antigravity-Doc] 서버 기동 시 DB의 OPEN 실전 포지션(`bot_positions`)을 업비트 `/v1/order?uuid=...`로 재조회하여
 * 실제 체결 수량·평균 체결가·수수료를 정확히 동기화하고 봇별 배분을 재정렬한다.
 */
async function reconcileOpenPositionsWithUpbit() {
  if (!isLiveMode()) {
    return;
  }
  const cfg = getRuntimeConfig();
  if (!cfg.access_key || !cfg.secret_key || cfg.access_key === "YOUR_UPBIT_ACCESS_KEY") {
    return;
  }

  const db = getDb();
  const openPositions = await db
    .prepare("SELECT * FROM bot_positions WHERE status = 'OPEN' ORDER BY id ASC")
    .all();

  for (const pos of openPositions) {
    const uuid = String(pos.order_uuid || "").trim();
    if (!uuid || uuid.startsWith("upbit-bid-") || uuid.startsWith("order-bid-")) continue;
    try {
      await new Promise((r) => setTimeout(r, 150));
      const qParams = { uuid };
      const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
      const oResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(uuid)}`, {
        headers: {
          Authorization: `Bearer ${qToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (oResp.status === 200) {
        const oDetail = await oResp.json();
        const filledVol = Number(oDetail?.executed_volume || 0);
        if (filledVol > 0) {
          const exactVolStr = String(oDetail.executed_volume);
          const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
          const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
          const exactAvgPrice = totalFunds > 0 ? normalizeExecPrice(totalFunds / filledVol, pos.avg_buy_price) : Number(pos.avg_buy_price);
          const exactFee =
            oDetail.paid_fee !== undefined ? Math.ceil(Number(oDetail.paid_fee || pos.buy_fee || 0)) : Number(pos.buy_fee || 0);

          await db.prepare(
            "UPDATE bot_positions SET volume = ?, avg_buy_price = ?, buy_fee = ? WHERE id = ?"
          ).run(exactVolStr, exactAvgPrice, exactFee, pos.id);

          if (pos.trade_id) {
            await db.prepare(
              "UPDATE trades SET buy_price = ?, buy_volume = ? WHERE id = ?"
            ).run(exactAvgPrice, exactVolStr, pos.trade_id);
          }
        }
      }
    } catch {}
  }

  if (await getSetting("capital_configured", "0") === "1") {
    const currentTotalCap = Math.floor(Number(await getSetting("total_capital", "0")));
    await recalculateAndApplyBotAllocations(currentTotalCap);
  }
}



// ============================================================================
// 3. AI 실시간 시장 분석 & 봇 진단 + 뉴스 기반 AI 종합 시장 판단
//    - 30분 단위(1800초) Gemini Flash 빠른 시장 & 뉴스 분석
//    - 1시간 단위(3600초) Gemini Pro 심층 퀀트 분석
// ============================================================================
// [Antigravity-Doc] 정기 듀얼 AI 분석 스케줄러 뮤텍스 및 트랙별(market/news/pro) 실패 백오프 상태
let isScheduledAiAnalysisRunning = false;
const AI_SLOT_RETRY_BACKOFF_MS = 15 * 60 * 1000; // 일시 오류(503/타임아웃) 시 15분 쿨다운 후 최대 1회 재시도
const AI_SLOT_QUOTA_COOLDOWN_MS = 30 * 60 * 1000; // 429/할당량 소진 시 최소 30분 쿨다운 및 해당 슬롯 재시도 중단
const AI_SLOT_MAX_RETRIES_PER_SLOT = 1;
const aiSlotFailureState = {
  market: { slotKey: "", failCount: 0, nextRetryAtMs: 0, skipSlot: false },
  news: { slotKey: "", failCount: 0, nextRetryAtMs: 0, skipSlot: false },
  pro: { slotKey: "", failCount: 0, nextRetryAtMs: 0, skipSlot: false },
};

/**
 * [Antigravity-Doc] 지정 AI 트랙이 현재 슬롯에서 실행(또는 백오프 후 재시도) 가능한지 판별한다.
 */
function canAttemptAiSlot(track, slotKey, nowMs = Date.now()) {
  const st = aiSlotFailureState[track];
  if (!st || st.slotKey !== slotKey) return true;
  if (st.skipSlot) return false;
  if (st.failCount > AI_SLOT_MAX_RETRIES_PER_SLOT) return false;
  return nowMs >= st.nextRetryAtMs;
}

/**
 * [Antigravity-Doc] AI 트랙 성공 시 해당 트랙의 슬롯 실패/쿨다운 상태를 초기화한다.
 */
function clearAiSlotFailure(track) {
  aiSlotFailureState[track] = { slotKey: "", failCount: 0, nextRetryAtMs: 0, skipSlot: false };
}

/**
 * [Antigravity-Doc] AI 트랙 실패 시 오류 유형(429 할당량 vs 503/타임아웃)에 따라 재시도 쿨다운 또는 해당 슬롯 중단을 기록한다.
 */
function recordAiSlotFailure(track, slotKey, resultOrErr) {
  const nowMs = Date.now();
  const prev = aiSlotFailureState[track];
  const failCount = prev && prev.slotKey === slotKey ? prev.failCount + 1 : 1;
  const errCode = String(resultOrErr?.error || "").toUpperCase();
  const errMsg = String(resultOrErr?.message || resultOrErr || "");
  const isQuotaOr429 =
    errCode === "DAILY_QUOTA_EXCEEDED" ||
    /429|quota|rate limit|cooldown/i.test(errMsg);
  const skipSlot = isQuotaOr429 || failCount > AI_SLOT_MAX_RETRIES_PER_SLOT;
  const cooldownMs = isQuotaOr429 ? AI_SLOT_QUOTA_COOLDOWN_MS : AI_SLOT_RETRY_BACKOFF_MS * failCount;
  aiSlotFailureState[track] = {
    slotKey,
    failCount,
    nextRetryAtMs: nowMs + cooldownMs,
    skipSlot,
  };
  return { failCount, skipSlot, cooldownMin: Math.round(cooldownMs / 60000), isQuotaOr429 };
}

/**
 * [Antigravity-Doc] 10초마다 폴링하며 KST 매시 15분/45분 슬롯 기준으로 정기 듀얼 AI 분석을 자동 실행한다.
 *  - 30분 주기(15/45분): 뉴스 선행 수집 -> Flash 시황 분석(Ollama 우선) -> Flash 뉴스 분석(동일 슬롯 Ollama 결과 공유)
 *  - 1시간 주기(매시 15분): Gemini Pro 심층 거시 장세 분석
 */
async function checkAndRunScheduledAiMarketAnalysis() {
  if (isScheduledAiAnalysisRunning) return;
  try {
    const apiKey = await getGeminiApiKey();
    const ollamaCfg = await getOllamaRuntimeConfig();
    if (!apiKey && !ollamaCfg.enabled) return;

    const pad = (n) => String(n).padStart(2, "0");
    // 15분 / 45분 슬롯 기준 (다른 봇의 정각/30분 호출과 경합 방지)
    const nowMs = Date.now();
    const shiftedParts = getKstCalendarParts(nowMs - 15 * 60 * 1000);
    const slotDate = shiftedParts.dateStr;
    const slotHour = shiftedParts.hour;
    const slotMin = shiftedParts.minute >= 30 ? 45 : 15;
    const flashSlotKey = `${slotDate}_${pad(slotHour)}:${pad(slotMin)}`;
    const isProHour = slotMin === 15;
    const proSlotKey = `${slotDate}_${pad(slotHour)}:15_pro`;

    const lastMarketAutoSlot = await getSetting("ai_briefing_last_auto_slot", "");
    const lastNewsAutoSlot = await getSetting("ai_news_briefing_last_auto_slot", "");
    const lastProAutoSlot = await getSetting("ai_pro_briefing_last_auto_slot", "");

    const needFlashMarket =
      lastMarketAutoSlot !== flashSlotKey && canAttemptAiSlot("market", flashSlotKey, nowMs);
    const needFlashNews =
      lastNewsAutoSlot !== flashSlotKey && canAttemptAiSlot("news", flashSlotKey, nowMs);
    const needProInDepth =
      Boolean(apiKey) &&
      isProHour &&
      lastProAutoSlot !== proSlotKey &&
      canAttemptAiSlot("pro", proSlotKey, nowMs);

    if (!needFlashMarket && !needFlashNews && !needProInDepth) {
      return;
    }

    isScheduledAiAnalysisRunning = true;

    if (needFlashMarket || needFlashNews) {
      try {
        await syncNewsToDatabase(getDb());
      } catch (e) {
        console.warn("[AI Auto Analysis] Pre-sync news warning:", e.message);
      }
    }

    // 1. 30분 단위 FLASH_30M 시장 분석 & 봇 진단 (1순위: 로컬 Ollama qwen3-news -> 2순위: Gemini Flash -> 3순위: BTC 20MA)
    let sharedOllamaResult = null;
    let sharedOllamaMarketContext = null;
    let sharedRegimeFilter = null;
    if (needFlashMarket) {
      const engineLabel = ollamaCfg.enabled ? `로컬 Ollama(${ollamaCfg.model})` : "Gemini Flash";
      console.log(`[AI Auto Flash Analysis] 30분 정기 슬롯(${flashSlotKey}) ${engineLabel} 자동 시장 분석을 시작합니다...`);
      const marketResult = await generateAiMarketAnalysis({ triggerType: "AUTO", slotKey: flashSlotKey, preferredModel: "gemini-3.8-flash" });
      if (marketResult.success) {
        clearAiSlotFailure("market");
        if (marketResult.provider === "ollama" && marketResult.ollamaResult) {
          sharedOllamaResult = marketResult.ollamaResult;
          sharedOllamaMarketContext = marketResult.ollamaMarketContext || null;
          sharedRegimeFilter = marketResult.regime_filter || null;
        }
        console.log(
          `[AI Auto Flash Analysis] 30분 정기 슬롯(${flashSlotKey}) 완료 (엔진: ${marketResult.briefing?.provider}, 모델: ${marketResult.briefing?.model})`
        );
      } else {
        const failMeta = recordAiSlotFailure("market", flashSlotKey, marketResult);
        console.warn(
          `[AI Auto Flash Analysis] 30분 정기 슬롯(${flashSlotKey}) 실패 (${failMeta.skipSlot ? "현재 슬롯 재시도 중단 · 다음 정규 슬롯 대기" : `${failMeta.cooldownMin}분 후 재시도`}):`,
          marketResult.message
        );
      }
    }

    // 2. 30분 단위 FLASH_30M 뉴스 종합 판단 (동일 슬롯 Ollama 결과 공유로 CPU 이중 추론/타임아웃 및 상태 덮어쓰기 제거)
    if (needFlashNews) {
      const engineLabel = sharedOllamaResult
        ? `로컬 Ollama(${sharedOllamaResult.model}, 슬롯 결과 공유)`
        : ollamaCfg.enabled
        ? `로컬 Ollama(${ollamaCfg.model})`
        : "Gemini Flash";
      console.log(`[AI Auto News Analysis] 30분 정기 슬롯(${flashSlotKey}) ${engineLabel} 뉴스 종합 판단을 시작합니다...`);
      const newsResult = await generateAiNewsAnalysis({
        triggerType: "AUTO",
        slotKey: flashSlotKey,
        precomputedOllamaResult: sharedOllamaResult,
        precomputedMarketContext: sharedOllamaMarketContext,
        precomputedRegimeFilter: sharedRegimeFilter,
      });
      if (newsResult.success) {
        clearAiSlotFailure("news");
        console.log(
          `[AI Auto News Analysis] 30분 정기 슬롯(${flashSlotKey}) 완료 (엔진: ${newsResult.briefing?.provider}, 모델: ${newsResult.briefing?.model})`
        );
      } else {
        const failMeta = recordAiSlotFailure("news", flashSlotKey, newsResult);
        console.warn(
          `[AI Auto News Analysis] 30분 정기 슬롯(${flashSlotKey}) 실패 (${failMeta.skipSlot ? "현재 슬롯 재시도 중단 · 다음 정규 슬롯 대기" : `${failMeta.cooldownMin}분 후 재시도`}):`,
          newsResult.message
        );
      }
    }

    // 3. 1시간 정각 단위 Gemini Pro 심층 퀀트 분석 (PRO_60M)
    if (needProInDepth) {
      console.log(`[AI Auto Pro Analysis] 1시간 정각 심층 슬롯(${proSlotKey}) Gemini Pro 심층 퀀트 분석을 시작합니다...`);
      const proResult = await generateAiMarketAnalysis({ triggerType: "AUTO", slotKey: proSlotKey, preferredModel: "gemini-3.1-pro-preview", modelType: "pro" });
      if (proResult.success) {
        clearAiSlotFailure("pro");
        const db = getDb();
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_pro_briefing_last_auto_slot', ?, ?)").run(proSlotKey, nowKSTString());
        console.log(`[AI Auto Pro Analysis] 1시간 정각 심층 슬롯(${proSlotKey}) 완료 (모델: ${proResult.briefing?.model})`);
      } else {
        const failMeta = recordAiSlotFailure("pro", proSlotKey, proResult);
        console.warn(
          `[AI Auto Pro Analysis] 1시간 정각 심층 슬롯(${proSlotKey}) 실패 (${failMeta.skipSlot ? "현재 슬롯 재시도 중단 · 다음 정규 슬롯 대기" : `${failMeta.cooldownMin}분 후 재시도`}):`,
          proResult.message
        );
      }
    }
  } catch (err) {
    const shiftedErr = getKstCalendarParts(Date.now() - 15 * 60 * 1000);
    const padErr = (n) => String(n).padStart(2, "0");
    const errFlashSlot = `${shiftedErr.dateStr}_${padErr(shiftedErr.hour)}:${shiftedErr.minute >= 30 ? 45 : 15}`;
    const errProSlot = `${shiftedErr.dateStr}_${padErr(shiftedErr.hour)}:15_pro`;
    recordAiSlotFailure("market", errFlashSlot, err);
    recordAiSlotFailure("news", errFlashSlot, err);
    recordAiSlotFailure("pro", errProSlot, err);
    console.warn("[AI Auto Analysis] Scheduler error:", err.message);
  } finally {
    isScheduledAiAnalysisRunning = false;
  }
}

/**
 * [Antigravity-Doc] 모든 백그라운드 워커 및 인터벌 스케줄러를 1회 기동한다(중복 호출 방어).
 *  - Upbit WebSocket 허브 시작 -> 1초 후 PG 동기화/뉴스/미확정 주문 대사/포지션 대사/아레나/실전/AI/로테이션 초기 실행
 *  - 주기 타이머: 아레나(9s), 실전매매(10s), AI 분석(10s), 주간 로테이션(60s), 레거시 LLM 선정(60s), 뉴스 수집(30m)
 */
startBackgroundWorkers = async function() {
  if (workersStarted) return;
  workersStarted = true;

  // 업비트 공식 WebSocket 실시간 시세/호가/체결 허브 시작
  try {
    upbitWsHub.start([...DEFAULT_MONITORED_KRW_MARKETS]);
  } catch (wsErr) {
    console.warn("[UpbitWsHub] Start warning:", wsErr.message);
  }

  setTimeout(async () => {
    try {
      if (process.env.PG_SYNC_ENABLED !== "false" && process.env.DB_MODE !== "sqlite") {
        await pgSyncManager.connect();
      }
    } catch (err) {
      console.warn("[PgSync] Background sync init error:", err.message);
    }

    // 초기 암호화폐 뉴스 실시간 수집 및 감성 분석
    try {
      syncNewsToDatabase(getDb()).catch((err) => console.warn("[News] Initial sync error:", err.message));
    } catch {}

    await reconcileLiveOrderIntents().catch((err) => console.warn("[Startup] reconcileLiveOrderIntents error:", err?.message || err));
    await reconcileOpenPositionsWithUpbit().catch((err) => console.warn("[Startup] reconcileOpenPositionsWithUpbit error:", err?.message || err));
    await runAlwaysOnPaperArenaCycle().catch((err) => console.warn("[Startup] runAlwaysOnPaperArenaCycle error:", err?.message || err));
    await runLiveTradingBotsCycle().catch((err) => console.error("[Startup] runLiveTradingBotsCycle error:", err?.message || err));
    await checkAndRunScheduledAiMarketAnalysis().catch((err) => console.warn("[Startup] checkAndRunScheduledAiMarketAnalysis error:", err?.message || err));
    await checkAndRunScheduledAutoRotation().catch((err) => console.warn("[Startup] checkAndRunScheduledAutoRotation error:", err?.message || err));
    await checkAndRunScheduledLlmWeeklyBotSelection().catch((err) => console.warn("[Startup] checkAndRunScheduledLlmWeeklyBotSelection error:", err?.message || err));
  }, 1000);

  workerTimers.push(setInterval(runAlwaysOnPaperArenaCycle, 9000));
  workerTimers.push(setInterval(runLiveTradingBotsCycle, 10000));
  workerTimers.push(setInterval(checkAndRunScheduledAiMarketAnalysis, 10000));
  workerTimers.push(setInterval(checkAndRunScheduledAutoRotation, 60000));
  workerTimers.push(setInterval(checkAndRunScheduledLlmWeeklyBotSelection, 60000));

  // 30분 간격 암호화폐 뉴스 백그라운드 자동 수집
  workerTimers.push(setInterval(() => {
    try {
      const db = getDb();
      if (db) {
        syncNewsToDatabase(db).catch((err) => console.warn("[News] Periodic sync error:", err.message));
      }
    } catch {}
  }, 30 * 60 * 1000));

  console.log("[Workers] Background schedulers and 10-bot Arena cycles started successfully.");
};

// [Antigravity-Doc] 초기 설정 완료 상태면 백그라운드 워커 자동 기동, 미완료면 Setup Mode 안내 로그 출력
if (process.env.AUTOCOIN_LIBRARY_MODE !== "1" && isConfigured) {
  startBackgroundWorkers().catch((err) => console.warn("[Startup] Background worker start error:", err.message));
} else if (process.env.AUTOCOIN_LIBRARY_MODE !== "1") {
  console.log("[Setup] System is running in Setup Mode. Awaiting onboarding via /api/setup.");
}

export {
  evaluateWeeklyStrategyChampions,
  getDualAiCandidateModels,
  getSetting,
  getSafeOrderKrw,
  getUpbitKrwTickSize,
  normalizeUpbitKrwTick,
  syncBotAccountsFromBots,
  checkAndHaltIfZeroBalance,
  updateAutoRotationConfig,
  runLlmWeeklyBotSelection,
  getRuntimeConfig,
  saveRuntimeConfig,
  getGeminiApiKey,
  saveGeminiApiKey,
  getOllamaRuntimeConfig,
  saveOllamaSettings,
  checkOllamaStatus,
  invalidateOllamaStatusCache,
  callLocalOllamaCoinNewsAnalyzer,
  extractStructuredRegimeFromLlmText,
  normalizeLlmRegimeDecision,
  normalizeBlacklistTickers,
  buildDualAiMarketPromptContext,
  parseBoolFlag,
  DEFAULT_MONITORED_KRW_MARKETS,
  generateAiMarketAnalysis,
  generateAiNewsAnalysis,
  buildMechanicalFallbackRegime,
  synthesizeDualAiDecision,
  updateMarketRegimeFilterFromAnalysis,
  floorTo8DecimalsStr,
  normalizeExecPrice,
  withDbWriteLock,
  getEffectiveEntryCode,
  runAlwaysOnPaperArenaCycle,
  fetchUpbitTickersMap,
  fetchUpbitBestBidPrice,
  UpbitWsHub,
  upbitWsHub,
  analyzeOrderbookQuality,
  computeAtrVolatilityMultiplier,
  computeSlippageBps,
  ensureBacktestTables,
  fetchAndCacheHistoricalCandles,
  simulateBarByBarBacktest,
  runHistoricalBacktest,
  getBacktestHistory,
  buildChartTradeMarkers,
  loadNotificationSettings,
  saveNotificationSettings,
  maskSecretValue,
  formatNotificationMessage,
  dispatchMultiChannelNotification,
  isEncryptedVaultValue,
  encryptSecret,
  decryptSecret,
  safeDecryptSecret,
  migrateConfigSecrets,
  // 5중 실전 중복 주문 가드레일 Export
  getLiveExecutorOwner,
  getGuardrailConfig,
  ensureLiveGuardrailTables,
  acquireLiveExecutorLease,
  releaseLiveExecutorLeaseNow,
  precheckLiveBuyPaceLimits,
  reconcileLiveOrderIntents,
  getLiveGuardrailStatusPayload,
  getLiveCycleMutexState,
  resetGuardrailEmergencyState,
  clearLiveCooldownCache,
  buildBuyIntentBucket,
  buildSellIntentBucket,
};



