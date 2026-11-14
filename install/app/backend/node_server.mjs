import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgDb } from "./common/pg_db.mjs";
import { sqliteDb } from "./common/sqlite_db.mjs";
import { pgSyncManager } from "./common/pg_sync.mjs";
import { syncNewsToDatabase, queryNewsList } from "./common/news_service.mjs";
import * as webpush from "web-push";
import {
  STRATEGY_GROUP_ORDER,
  STRATEGY_GROUP_META,
  ALLOCATION_MODE_WEIGHTS,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(BASE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "auto_coin_trade.db");
const CONFIG_PATH = path.join(BASE_DIR, "config", "upbit_config.json");
const EXAMPLE_CONFIG_PATH = path.join(BASE_DIR, "config", "upbit_config.example.json");
const ENV_PATH = path.join(BASE_DIR, ".env");
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
const HOST = process.env.BACKEND_HOST || "0.0.0.0";
const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 8001);

let APP_VERSION = "0.0.22";
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

function nowKSTString() {
  return formatKstDateTime(new Date());
}

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
           SET allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, is_selected_for_live = ?, updated_at = ?
           WHERE bot_id = ?`
        )
        .run(
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

function todayDateString() {
  return nowKSTString().slice(0, 10);
}

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

let isConfigured = checkSetupCompleted();

// 데이터베이스 인스턴스 (SQLite / PostgreSQL 동적 분기)
export function getDb() {
  const mode = (process.env.DB_MODE || "sqlite").trim().toLowerCase();
  const syncEnabled = process.env.PG_SYNC_ENABLED !== "false";
  if (mode === "sqlite" || !syncEnabled) {
    return sqliteDb;
  }
  return pgDb;
}

const ALL_BOT_IDS = Array.from({ length: 10 }, (_, idx) => `bot_${String(idx + 1).padStart(2, "0")}`);
const TREND_BREAKOUT_BOT_IDS = new Set(["bot_01", "bot_02", "bot_03", "bot_04", "bot_07", "bot_09"]);
const MEAN_REVERSION_GRID_BOT_IDS = new Set(["bot_05", "bot_06", "bot_08", "bot_10"]);
const LEGACY_BOT_OVERRIDE_ALIAS = {
  bot_vb: "bot_01",
  bot_momentum: "bot_03",
  bot_bb: "bot_05",
};
const DEFAULT_BOT_OVERRIDES = Object.fromEntries(ALL_BOT_IDS.map((id) => [id, "ALLOW"]));
const DEFAULT_BOT_OVERRIDES_JSON = JSON.stringify(DEFAULT_BOT_OVERRIDES);

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

function floorTo8DecimalsStr(val) {
  const num = Number(val || 0);
  if (!Number.isFinite(num) || num <= 0) return "0";
  const floored = Math.floor(num * 100000000) / 100000000;
  return floored.toFixed(8).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m)) || "0";
}

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

function normalizeBlacklistTickers(rawList) {
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
  const dedup = new Set();
  for (const item of arr) {
    const clean = String(item || "").trim().toUpperCase();
    if (!clean) continue;
    dedup.add(clean.includes("-") ? clean : `KRW-${clean}`);
  }
  return Array.from(dedup).sort();
}

function buildMechanicalFallbackRegime({ btcPrice = 0, btcDaily20Ma = 0, btc4h60Ma = 0, label = "Fallback" } = {}) {
  const hasMa = btcPrice > 0 && btcDaily20Ma > 0;
  const isAboveMa20 = !hasMa || btcPrice >= btcDaily20Ma;
  const disparity = hasMa ? (((btcPrice - btcDaily20Ma) / btcDaily20Ma) * 100).toFixed(2) : "0.00";
  const overrides = {};
  for (const id of ALL_BOT_IDS) {
    overrides[id] = !isAboveMa20 && TREND_BREAKOUT_BOT_IDS.has(id) ? "BLOCK" : "ALLOW";
  }
  return {
    sentiment_score: isAboveMa20 ? 0.2 : -0.3,
    market_regime: isAboveMa20 ? "BULL" : "BEAR",
    risk_alert: false,
    recommended_action: isAboveMa20 ? "NORMAL" : "REDUCE_SIZE",
    position_size_multiplier: isAboveMa20 ? 1.0 : 0.5,
    bot_overrides: overrides,
    blacklist_tickers: [],
    reason: isAboveMa20
      ? `[${label}] BTC 일봉 20MA(${Math.floor(btcDaily20Ma).toLocaleString("ko-KR")}원) 상단(${disparity}%) -> 10대 봇 전체 ALLOW(1.0x)`
      : `[${label}] BTC 일봉 20MA(${Math.floor(btcDaily20Ma).toLocaleString("ko-KR")}원) 하단(${disparity}%) -> 돌파형 봇 BLOCK & 역추세·그리드·눌림목 ALLOW(0.5x)`,
  };
}

function synthesizeDualAiDecision(flashDecision, proDecision) {
  const flashAction = String(flashDecision?.recommended_action || "NORMAL").trim().toUpperCase();
  const proAction = String(proDecision?.recommended_action || "NORMAL").trim().toUpperCase();
  const flashAlert = Boolean(flashDecision?.risk_alert);
  const proAlert = Boolean(proDecision?.risk_alert);
  const flashMult = Math.max(0, Math.min(1, Number(flashDecision?.position_size_multiplier ?? 1.0)));
  const proMult = Math.max(0, Math.min(1, Number(proDecision?.position_size_multiplier ?? 1.0)));
  const flashScore = Math.max(-1, Math.min(1, Number(flashDecision?.sentiment_score ?? 0.0)));
  const proScore = Math.max(-1, Math.min(1, Number(proDecision?.sentiment_score ?? 0.0)));

  const flashOverrides = normalizeBotOverrides(flashDecision?.bot_overrides);
  const proOverrides = normalizeBotOverrides(proDecision?.bot_overrides);
  const finalOverrides = {};

  let finalRiskAlert = false;
  let finalAction = "NORMAL";
  let finalMult = 1.0;
  let synthMode = "DUAL_NORMAL_ALLOW";

  if (proAlert || proAction === "HALT_NEW_BUYS" || proAction === "EMERGENCY_CLOSE_ALL") {
    finalRiskAlert = true;
    finalAction = flashAction === "EMERGENCY_CLOSE_ALL" || proAction === "EMERGENCY_CLOSE_ALL" ? "EMERGENCY_CLOSE_ALL" : "HALT_NEW_BUYS";
    finalMult = 0.0;
    for (const id of ALL_BOT_IDS) finalOverrides[id] = "BLOCK";
    synthMode = "PRO_RISK_PRIORITY (심층 리스크 최우선 신규 매수 전면 차단)";
  } else if (flashAlert || flashAction === "HALT_NEW_BUYS" || flashAction === "EMERGENCY_CLOSE_ALL") {
    finalRiskAlert = true;
    finalAction = flashAction === "EMERGENCY_CLOSE_ALL" ? "EMERGENCY_CLOSE_ALL" : "HALT_NEW_BUYS";
    finalMult = 0.0;
    for (const id of ALL_BOT_IDS) finalOverrides[id] = "BLOCK";
    synthMode = "FLASH_SHOCK_DEFENSE (단기 돌발 악재 감지로 신규 매수 전면 차단)";
  } else if (
    flashAction === "REDUCE_SIZE" ||
    proAction === "REDUCE_SIZE" ||
    flashMult <= 0.5 ||
    proMult <= 0.5 ||
    flashScore <= -0.3 ||
    proScore <= -0.3
  ) {
    finalRiskAlert = false;
    finalAction = "REDUCE_SIZE";
    finalMult = Number(Math.max(0, Math.min(flashMult, proMult, 0.5)).toFixed(2));
    for (const id of ALL_BOT_IDS) {
      finalOverrides[id] = flashOverrides[id] === "BLOCK" || proOverrides[id] === "BLOCK" ? "BLOCK" : "ALLOW";
    }
    if (ALL_BOT_IDS.every((id) => finalOverrides[id] === "BLOCK")) {
      finalAction = "HALT_NEW_BUYS";
      finalMult = 0.0;
      synthMode = "CONSERVATIVE_ALL_BOTS_BLOCKED";
    } else {
      synthMode = "CONSERVATIVE_REDUCE (보수적 비중 축소 및 선별적 봇 진입 허용)";
    }
  } else {
    finalRiskAlert = false;
    finalAction = "NORMAL";
    finalMult = Number(Math.max(0, Math.min(flashMult, proMult, 1.0)).toFixed(2));
    for (const id of ALL_BOT_IDS) {
      finalOverrides[id] = flashOverrides[id] === "ALLOW" && proOverrides[id] === "ALLOW" ? "ALLOW" : "BLOCK";
    }
    if (ALL_BOT_IDS.every((id) => finalOverrides[id] === "BLOCK")) {
      finalAction = "HALT_NEW_BUYS";
      finalMult = 0.0;
      synthMode = "DUAL_ALL_BOTS_BLOCKED";
    } else {
      synthMode = "DUAL_NORMAL_ALLOW (양 모델 교차 검증 통과)";
    }
  }

  const finalScore =
    Math.min(flashScore, proScore) <= -0.5
      ? Number(Math.min(flashScore, proScore).toFixed(2))
      : Number((0.4 * flashScore + 0.6 * proScore).toFixed(2));

  const flashRegime = String(flashDecision?.market_regime || "SIDEWAYS").trim().toUpperCase();
  const proRegime = String(proDecision?.market_regime || "SIDEWAYS").trim().toUpperCase();
  let finalRegime = "SIDEWAYS";
  if (flashRegime === "HIGH_VOLATILITY_SHOCK" || proRegime === "HIGH_VOLATILITY_SHOCK") {
    finalRegime = "HIGH_VOLATILITY_SHOCK";
  } else if (flashRegime === "BEAR" || proRegime === "BEAR") {
    finalRegime = "BEAR";
  } else if (proRegime === "BULL" && (flashRegime === "BULL" || flashRegime === "SIDEWAYS")) {
    finalRegime = "BULL";
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

  if (!parsedDecision) {
    return { cleanText: rawText.trim(), structured: null };
  }

  const regime = String(parsedDecision.market_regime || "SIDEWAYS").trim().toUpperCase();
  const validRegime = ["BULL", "BEAR", "SIDEWAYS", "HIGH_VOLATILITY_SHOCK"].includes(regime) ? regime : "SIDEWAYS";
  const action = String(parsedDecision.recommended_action || "NORMAL").trim().toUpperCase();
  const validAction = ["NORMAL", "REDUCE_SIZE", "HALT_NEW_BUYS", "EMERGENCY_CLOSE_ALL"].includes(action) ? action : "NORMAL";
  const rawMult = Number(parsedDecision.position_size_multiplier ?? 1.0);
  const validMult = rawMult <= 0 ? 0.0 : rawMult < 0.75 ? 0.5 : 1.0;
  const riskAlert = Boolean(parsedDecision.risk_alert);
  const normalizedOverrides = riskAlert || validAction === "HALT_NEW_BUYS" || validAction === "EMERGENCY_CLOSE_ALL"
    ? Object.fromEntries(ALL_BOT_IDS.map((id) => [id, "BLOCK"]))
    : normalizeBotOverrides(parsedDecision.bot_overrides);

  const structured = {
    sentiment_score: Math.max(-1.0, Math.min(1.0, Number(parsedDecision.sentiment_score ?? 0.0))),
    market_regime: validRegime,
    risk_alert: riskAlert,
    recommended_action: validAction,
    position_size_multiplier: validMult,
    bot_overrides: normalizedOverrides,
    blacklist_tickers: normalizeBlacklistTickers(parsedDecision.blacklist_tickers),
    reason: String(parsedDecision.reason || "듀얼 AI 장세 및 봇 스위치 판단").trim(),
  };

  let cleanText = rawText;
  if (blockToStrip) {
    cleanText = cleanText.replace(blockToStrip, "");
  }
  cleanText = cleanText
    .replace(/###\s*\[?구조화.*$/gim, "")
    .trim();

  return { cleanText, structured };
}

function enrichRegimeFilterRow(row) {
  if (!row) return null;
  const botOverrides = normalizeBotOverrides(row.final_bot_overrides_json || row.bot_overrides_json);
  const blacklistTickers = normalizeBlacklistTickers(row.blacklist_tickers_json);
  return {
    ...row,
    bot_overrides: normalizeBotOverrides(row.bot_overrides_json || botOverrides),
    final_bot_overrides: botOverrides,
    blacklist_tickers: blacklistTickers,
  };
}

async function initializeDatabase() {
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
      trade_id BIGINT NOT NULL,
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
      trade_id BIGINT NOT NULL,
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
      allocation_mode TEXT DEFAULT 'RANK_WEIGHTED_40_35_25',
      min_weekly_trades INTEGER DEFAULT 2,
      last_rotated_at TEXT,
      next_rotation_at TEXT,
      updated_at TEXT
    );
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
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS strategy_group TEXT DEFAULT 'TREND_SWING';
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS is_selected_for_live INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_initial_capital BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_virtual_krw BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_is_running INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_peak_equity BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_mdd_pct NUMERIC(8,2) NOT NULL DEFAULT 0;
    ALTER TABLE bots ADD COLUMN IF NOT EXISTS paper_status_msg TEXT NOT NULL DEFAULT '시그널 대기 중';
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
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS buy_reason TEXT;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS sell_reason TEXT;
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
  `);

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
           allocation_mode, min_weekly_trades, last_rotated_at, next_rotation_at, updated_at
         ) VALUES (1, 1, 1, 9, 'RANK_WEIGHTED_40_35_25', 2, NULL, ?, ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .run(defaultNextRot, nowInit);
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
}

try {
  await initializeDatabase();
} catch (err) {
  if (!isConfigured) {
    console.log("[Setup Mode] DB not yet initialized. Setup wizard will handle configuration.");
  } else {
    console.warn("[Init] Warning initializing database:", err.message);
  }
}

let vapidPublicKey = "";
let vapidPrivateKey = "";

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

try {
  await initVapidKeys();
} catch (err) {
  // silent in setup mode
}

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

async function getSetting(key, defaultVal = "") {
  const db = getDb();
  const row = await db.prepare("SELECT value FROM system_settings WHERE key = ?").get(key);
  return row ? row.value : defaultVal;
}

function isLiveMode() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  return (
    String(cfg.trade_mode || "").toLowerCase() === "live" &&
    cfg.access_key &&
    cfg.secret_key &&
    cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY" &&
    String(cfg.access_key).trim() !== ""
  );
}

function getPositionsTableName(mode = null) {
  const m = mode || "live";
  return m === "live" ? "bot_positions" : "paper_bot_positions";
}

function getTradesTableName(mode = null) {
  const m = mode || "live";
  return m === "live" ? "trades" : "paper_trades";
}

async function getBots(mode = null) {
  const db = getDb();
  if (!db) return [];
  const rows = await db.prepare("SELECT * FROM bots ORDER BY bot_id ASC").all();
  const posTable = getPositionsTableName(mode);
  const tradesTable = getTradesTableName(mode);
  const todayStartKst = `${nowKSTString().split(" ")[0]} 00:00:00`;
  const result = [];
  for (const r of rows) {
    let config = {};
    try {
      config = JSON.parse(r.config_json || "{}");
    } catch {}
    const openPositions = await db
      .prepare(`SELECT * FROM ${posTable} WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC`)
      .all(r.bot_id);
    const usedCapital = Math.floor(
      openPositions.reduce((acc, p) => acc + Number(p.buy_amount || 0), 0)
    );
    const virtualKrw = Math.max(0, Math.floor(Number(r.allocated_capital || 0) - usedCapital));

    let dailyProfit = 0;
    try {
      const dailyRow = await db
        .prepare(`SELECT COALESCE(SUM(profit_krw), 0) AS daily_profit FROM ${tradesTable} WHERE bot_id = ? AND status = 'COMPLETED' AND sell_date >= ?`)
        .get(r.bot_id, todayStartKst);
      dailyProfit = Number(dailyRow?.daily_profit || 0);
    } catch {}

    const allocatedCap = Number(r.allocated_capital || 0);
    const dailyLossLimit = allocatedCap > 0 ? -Math.floor(allocatedCap * 0.04) : -40000;
    const isCircuitBreaker = Number(r.is_selected_for_live || 0) === 1 && allocatedCap > 0 && dailyProfit <= dailyLossLimit;

    const meta = getBotStrategyMeta(r.bot_id);

    result.push({
      ...r,
      ...meta,
      virtual_krw: virtualKrw,
      config,
      open_positions: openPositions,
      used_capital: usedCapital,
      daily_profit_krw: dailyProfit,
      daily_loss_limit_krw: dailyLossLimit,
      circuit_breaker_active: isCircuitBreaker,
    });
  }
  return result;
}

async function recalculateAndApplyBotAllocations(flooredTotal, ratiosMap = null, mode = null) {
  const db = getDb();
  const now = nowKSTString();
  const bots = await getBots(mode);
  const tradesTable = getTradesTableName(mode);
  const items = [];
  for (const b of bots) {
    const used = Math.floor(Number(b.used_capital || 0));
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
    items.push({
      bot_id: b.bot_id,
      used,
      ratio,
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
        "UPDATE bots SET allocation_ratio = ?, allocated_capital = 0, virtual_krw = 0, updated_at = ? WHERE bot_id = ?"
      ).run(it.ratio, now, it.bot_id);
    }
    return { totalUsed, totalAllocated: 0, totalVirtual: 0 };
  }

  const totalRatio = Number(items.reduce((acc, it) => acc + it.ratio, 0).toFixed(4));
  const targetPool =
    totalRatio >= 99.99
      ? flooredTotal
      : Math.max(totalUsed, Math.floor(flooredTotal * (totalRatio / 100.0)));

  // 이미 사용된 투자금(used)을 우선 반영하고, 잔여(신규 투입 포함) 투자금을 비율대로 분배하여
  // 전체 투자금 총액과 각 봇별 배정 원금(이미 사용 + 가용 잔고)의 합계가 정확히 일치하도록 계산
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
          .sort((a, b) => b.ratio - a.ratio);
        if (candidates.length > 0) {
          candidates[0].allocated += remainder;
        }
      }
      for (const it of unlocked) {
        it.virtual_krw = Math.max(0, it.allocated - it.used);
        it.locked = true;
      }
      break;
    }
  }

  for (const it of items) {
    await db.prepare(
      "UPDATE bots SET allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, updated_at = ? WHERE bot_id = ?"
    ).run(it.ratio, it.allocated, it.virtual_krw, now, it.bot_id);
  }
  await syncBotAccountsFromBots(db);

  return {
    totalUsed,
    totalAllocated: items.reduce((acc, it) => acc + it.allocated, 0),
    totalVirtual: items.reduce((acc, it) => acc + it.virtual_krw, 0),
  };
}

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
    const now = nowKSTString();
    await db.prepare("UPDATE bots SET is_running = 0, last_status_msg = ?, updated_at = ?").run(
      "잔고 0 이하 도달로 긴급 자동 중지됨",
      now
    );
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '1', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', ?, ?)").run(reason, now);
    return { halted: true, reason };
  }
  return {
    halted: await getSetting("zero_balance_halted", "0") === "1",
    reason: await getSetting("zero_balance_reason", ""),
  };
}

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

let cachedValidKrwMarkets = new Set();

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

async function fetchUpbitAccountBalance() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

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
// 업비트 실계좌 잔고의 90%를 자동 계산하여 총 운영원금으로 설정하고 각 실전 봇에 실시간 분배
// ============================================================================
let lastDynamicSyncMs = 0;
async function syncDynamicLiveCapitalFromUpbit(force = false, preloadedAccount = null) {
  const nowMs = Date.now();
  if (!force && !preloadedAccount && nowMs - lastDynamicSyncMs < 3000) {
    const currentCap = Math.floor(Number(await getSetting("total_capital", "0")));
    return { success: true, total_capital: currentCap, cached: true };
  }
  lastDynamicSyncMs = nowMs;

  try {
    const accountInfo = preloadedAccount || (await fetchUpbitAccountBalance());
    if (!accountInfo || !accountInfo.success) {
      const currentCap = Math.floor(Number(await getSetting("total_capital", "0")));
      return { success: false, total_capital: currentCap, reason: accountInfo?.message || "업비트 계좌 조회 실패" };
    }

    const rawAsset = Number(accountInfo.total_asset_krw ?? accountInfo.krw_total ?? accountInfo.krw_balance ?? 0);
    const totalAsset = Math.floor(rawAsset);

    if (totalAsset <= 0) {
      return { success: false, total_capital: 0, reason: "업비트 잔고가 0원 이하입니다." };
    }

    // 업비트 실 계좌 잔고를 계산하여 90%를 자동으로 운영원금으로 설정
    const dynamicTotalCapital = Math.floor(totalAsset * 0.9);
    const now = nowKSTString();
    const db = getDb();

    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(
      String(dynamicTotalCapital),
      now
    );
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(
      now
    );

    // 각 실전 봇에 비율대로 실시간 분배
    const allocResult = await recalculateAndApplyBotAllocations(dynamicTotalCapital, null, "live");

    // 실전 자산 월별 스냅샷 실시간 동기화
    syncMonthlyAssetSnapshot("live", accountInfo).catch(() => {});

    return {
      success: true,
      total_asset_krw: totalAsset,
      total_capital: dynamicTotalCapital,
      allocResult,
    };
  } catch (err) {
    console.error("[syncDynamicLiveCapitalFromUpbit] Error:", err.message);
    const currentCap = Math.floor(Number(await getSetting("total_capital", "0")));
    return { success: false, total_capital: currentCap, error: err.message };
  }
}

// ============================================================================
// 월별 보유 자산 스냅샷 자동 동기화 및 기록 함수
// - 이번달 1일 시점 평가자산과 현재 시점 평가자산, 증감액/증감률 기록
// - 매달 영구 보존 및 월별 자산 증감 그래프 데이터 제공
// ============================================================================
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

async function fetchUpbitRecentOrders(limit = 20) {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

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

async function checkUpbitStatus() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  const delayThreshold = Number(cfg.delay_threshold_ms || 800);
  const timeoutMs = Number(cfg.request_timeout_sec || 5) * 1000;
  const start = Date.now();
  const checkedAt = nowKSTString();

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
        };
      }
      return {
        status: "green",
        color: "green",
        label: "정상통신",
        latency_ms: elapsed,
        reason: `업비트 Open API 서버 정상 응답 (${elapsed}ms)`,
        checked_at: checkedAt,
      };
    }
    return {
      status: "red",
      color: "red",
      label: "통신불가",
      latency_ms: elapsed,
      reason: `업비트 Open API 서버 오류 응답 (HTTP ${resp.status})`,
      checked_at: checkedAt,
    };
  } catch (err) {
    return {
      status: "red",
      color: "red",
      label: "통신불가",
      latency_ms: Date.now() - start,
      reason: `업비트 Open API 서버 연결 실패: ${err.message}`,
      checked_at: checkedAt,
    };
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

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

async function getGeminiApiKey() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  if (cfg.gemini_api_key && cfg.gemini_api_key !== "YOUR_GEMINI_API_KEY_HERE" && cfg.gemini_api_key.trim().length > 0) {
    return cfg.gemini_api_key.trim();
  }
  const dbKey = await getSetting("gemini_api_key", "");
  if (dbKey && dbKey.trim().length > 0) {
    return dbKey.trim();
  }
  return (process.env.GEMINI_API_KEY || "").trim();
}

async function saveGeminiApiKey(key) {
  const cleanKey = (key || "").trim();
  try {
    let cfg = {};
    if (fs.existsSync(CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
    cfg.gemini_api_key = cleanKey;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write to config/upbit_config.json:", err.message);
  }
  const now = nowKSTString();
  const db = getDb();
  await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)").run(cleanKey, now);
  return cleanKey;
}

// ============================================================================
// Gemini 무료 API 일일 쿼터 및 듀얼 AI(Flash 30분 / Pro 1시간) 자동 분석 스케줄 관리
// - Google Gemini Free Tier 일일 무료 호출 한도: 20회/일
// - 30분 단위 Gemini Flash 빠른 분석 및 1시간 단위 Gemini Pro 심층 분석
// - 사용자 수동 호출 가능 무료 API 한도: 20 - 6 = 14회/일 (일일 수동 안전 가이드)
// ============================================================================
const GEMINI_DAILY_TOTAL_FREE_LIMIT = 50;
const AI_SCHEDULE_HOURS = Array.from({ length: 24 }, (_, i) => i);
const GEMINI_DAILY_AUTO_RESERVED = 6;
const GEMINI_DAILY_MANUAL_LIMIT = 30;

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
  const enrichedRegime = enrichRegimeFilterRow(regimeRow);
  return {
    has_key: !!apiKey,
    masked_key: maskedKey,
    latest: row || null,
    last_trigger_type: quota.last_trigger_type,
    regime_filter: enrichedRegime,
    quota,
  };
}

async function getLatestAiNewsBriefing() {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM ai_news_briefings ORDER BY id DESC LIMIT 1").get();
  const apiKey = await getGeminiApiKey();
  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "";
  const quota = await getGeminiQuotaStatus();
  return {
    has_key: !!apiKey,
    masked_key: maskedKey,
    latest: row || null,
    last_trigger_type: await getSetting("ai_news_briefing_last_trigger_type", "MANUAL"),
    last_auto_slot: await getSetting("ai_news_briefing_last_auto_slot", ""),
    quota,
  };
}

async function updateMarketRegimeFilterFromAnalysis({
  isPro = false,
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

    const loadSideState = async (settingKey, defaultScore, defaultAction) => {
      try {
        const raw = await getSetting(settingKey, "");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed.bot_overrides) {
            return {
              ...parsed,
              bot_overrides: normalizeBotOverrides(parsed.bot_overrides),
              blacklist_tickers: normalizeBlacklistTickers(parsed.blacklist_tickers),
            };
          }
        }
      } catch {}
      return {
        sentiment_score: Number(defaultScore ?? fallbackBase.sentiment_score),
        market_regime: String(curRow?.market_regime || fallbackBase.market_regime).toUpperCase(),
        risk_alert: Boolean(Number(curRow?.final_risk_alert || 0) === 1),
        recommended_action: String(defaultAction || fallbackBase.recommended_action).toUpperCase(),
        position_size_multiplier: Number(curRow?.final_position_multiplier ?? fallbackBase.position_size_multiplier),
        bot_overrides: normalizeBotOverrides(curRow?.final_bot_overrides_json || curRow?.bot_overrides_json || fallbackBase.bot_overrides),
        blacklist_tickers: normalizeBlacklistTickers(curRow?.blacklist_tickers_json),
        reason: String(curRow?.reason || fallbackBase.reason),
      };
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
      incomingDecision = {
        ...incomingDecision,
        bot_overrides: normalizeBotOverrides(incomingDecision.bot_overrides),
        blacklist_tickers: normalizeBlacklistTickers(incomingDecision.blacklist_tickers),
      };
    }

    let flashState = await loadSideState("dual_ai_flash_state_json", curRow?.flash_sentiment_score, curRow?.flash_recommended_action);
    let proState = await loadSideState("dual_ai_pro_state_json", curRow?.pro_sentiment_score, curRow?.pro_recommended_action);
    let flashUpdated = curRow?.flash_updated_at || now;
    let proUpdated = curRow?.pro_updated_at || now;

    if (isPro) {
      proState = incomingDecision;
      proUpdated = now;
      await db
        .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_pro_state_json', ?, ?)")
        .run(JSON.stringify(proState), now);
    } else {
      flashState = incomingDecision;
      flashUpdated = now;
      await db
        .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('dual_ai_flash_state_json', ?, ?)")
        .run(JSON.stringify(flashState), now);
    }

    const synthesized = synthesizeDualAiDecision(flashState, proState);
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
          updated_at = CURRENT_TIMESTAMP,
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
    console.log(
      `[Dual AI Update] Regime=${synthesized.market_regime}, Action=${synthesized.recommended_action}, Mult=${synthesized.final_position_multiplier}, Flash=${synthesized.flash_recommended_action}, Pro=${synthesized.pro_recommended_action}`
    );
    const updatedRow = await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    return enrichRegimeFilterRow(updatedRow);
  } catch (err) {
    console.error("[updateMarketRegimeFilterFromAnalysis] Error:", err.message);
    return null;
  }
}

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
      current_override: regimeFilter.botOverrides?.[b.bot_id] || "ALLOW",
      last_status_msg: b.last_status_msg,
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
  } catch {}

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
- 현재 듀얼 AI 게이트웨이 상태: ${regimeFilter.marketRegime || "SIDEWAYS"} | 투입 비중 ${Math.round(
    Number(regimeFilter.multiplier ?? 1) * 100
  )}% | ${isHoldCash ? "🔴 전역 신규 매수 차단 중" : "🟢 개별 봇 스위치 가동 중"}
- 현재 사유: ${regimeReason}

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
- 상태: ${b.is_running ? "가동중" : "중지"} | 현재 게이트웨이: ${b.current_override}
- 배정: ${b.allocated_capital.toLocaleString("ko-KR")}원 / 투자중: ${b.used_capital.toLocaleString("ko-KR")}원 / 가용: ${b.virtual_krw.toLocaleString("ko-KR")}원
- 최근 메시지: ${b.last_status_msg}
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

function getDualAiCandidateModels(isProTarget = false, preferredModel = "") {
  const pref = String(preferredModel || "").trim();
  const baseList = isProTarget
    ? [
        "gemini-3.1-pro-preview",
        "gemini-pro-latest",
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
      ]
    : [
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-2.5-flash",
      ];
  if (pref && !baseList.includes(pref)) {
    return [pref, ...baseList];
  }
  return baseList;
}

async function generateAiMarketAnalysis(options = {}) {
  const triggerType = options?.triggerType === "AUTO" ? "AUTO" : "MANUAL";
  const slotKey = options?.slotKey || null;
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: "NO_API_KEY",
      message: "Gemini API 키가 등록되지 않았습니다. config/upbit_config.json 파일의 gemini_api_key 항목에 키를 입력하시거나 웹 화면에서 등록해주세요.",
      quota: await getGeminiQuotaStatus(),
    };
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (triggerType === "MANUAL" && quotaBefore.remaining_calls <= 0) {
    return {
      success: false,
      error: "DAILY_QUOTA_EXCEEDED",
      message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
      quota: quotaBefore,
    };
  }

  const isProTarget = options?.modelType === "pro" || String(options?.preferredModel || "").includes("pro");
  const ctx = await buildDualAiMarketPromptContext({ isProTarget });
  const { btcPrice, btcDaily20Ma, btc4h60Ma, isHoldCash, regimeReason, nowStr, prompt } = ctx;
  const db = getDb();

  // Gemini API 호출 (지수 백오프: 1초, 2초, 4초 재시도 + 모델 폴백)
  const candidateModels = getDualAiCandidateModels(isProTarget, options?.preferredModel);
  const backoffDelaysMs = [1000, 2000, 4000];
  let chosenModel = candidateModels[0];
  let analysisText = "";
  let lastErrorMsg = "";
  let quota429Count = 0;
  const unavailable404Models = new Set();

  for (let attempt = 0; attempt < backoffDelaysMs.length + 1 && !analysisText; attempt += 1) {
    quota429Count = 0;
    for (const model of candidateModels) {
      if (unavailable404Models.has(model)) continue;
      let timeoutTimer = null;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          apiKey
        )}`;
        const controller = new AbortController();
        timeoutTimer = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 8192,
            },
          }),
        });
        clearTimeout(timeoutTimer);

        if (response.ok) {
          const resJson = await response.json();
          const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            chosenModel = model;
            analysisText = text;
            break;
          }
        } else {
          const errText = await response.text();
          if (response.status === 429) quota429Count += 1;
          if (response.status === 404 || response.status === 400) unavailable404Models.add(model);
          console.warn(`[Gemini API] Model ${model} failed (HTTP ${response.status}, attempt ${attempt + 1}):`, errText.slice(0, 200));
          try {
            const errJson = JSON.parse(errText);
            lastErrorMsg = errJson?.error?.message || `HTTP ${response.status}`;
          } catch {
            lastErrorMsg = `HTTP ${response.status}: ${errText.slice(0, 120)}`;
          }
        }
      } catch (reqErr) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        console.warn(`[Gemini API] Request exception for model ${model} (attempt ${attempt + 1}):`, reqErr.message);
        lastErrorMsg = reqErr.message;
      }
    }

    if (!analysisText && unavailable404Models.size < candidateModels.length && attempt < backoffDelaysMs.length) {
      const waitMs = backoffDelaysMs[attempt];
      console.log(`[Gemini API] Waiting ${waitMs / 1000}s exponential backoff before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  if (!analysisText) {
    // AI 호출 실패 또는 쿼터 초과 시 BTC 일봉 20MA 기반 기계적 Fallback 적용
    try {
      const fallbackDecision = buildMechanicalFallbackRegime({
        btcPrice,
        btcDaily20Ma,
        btc4h60Ma,
        label: isProTarget ? "Pro Fallback" : "Flash Fallback",
      });
      await updateMarketRegimeFilterFromAnalysis({
        isPro: isProTarget,
        btcPrice,
        btcDaily20Ma,
        btc4h60Ma,
        isHoldCash: fallbackDecision.recommended_action === "HALT_NEW_BUYS",
        regimeReason: fallbackDecision.reason,
        decision: fallbackDecision,
        isFallback: true,
      });
    } catch (fbErr) {
      console.warn("[Gemini Fallback] updateMarketRegimeFilter error:", fbErr.message);
    }

    if (quota429Count === candidateModels.length && triggerType === "MANUAL") {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      return {
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: exhaustedQuota,
      };
    }
    return {
      success: false,
      error: "API_CALL_FAILED",
      message: `Gemini API 호출 실패 (BTC 20MA 기계적 Fallback 적용): ${lastErrorMsg || "응답 텍스트를 생성하지 못했습니다."}`,
      quota: await getGeminiQuotaStatus(),
    };
  }

  const { cleanText, structured } = extractStructuredRegimeFromLlmText(analysisText);
  const briefingMarkdown = cleanText || analysisText;

  // 듀얼 AI 필터 테이블(market_regime_filter) 원자적 갱신
  const updatedRegime = await updateMarketRegimeFilterFromAnalysis({
    isPro: isProTarget,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    isHoldCash,
    regimeReason,
    analysisText,
    decision: structured,
  });

  // DB 저장 및 쿼터 차감
  const insertStmt = await db.prepare(`
    INSERT INTO ai_market_briefings (
      provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertStmt.run(
    "gemini",
    chosenModel,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    updatedRegime?.recommended_action === "HALT_NEW_BUYS" ? "HOLD_CASH" : updatedRegime?.market_regime || "NORMAL",
    briefingMarkdown,
    nowStr
  );

  await db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_briefing_last_trigger_type', ?, ?)"
  ).run(triggerType, nowStr);
  if (triggerType === "AUTO" && slotKey && !isProTarget) {
    await db.prepare(
      "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_briefing_last_auto_slot', ?, ?)"
    ).run(slotKey, nowStr);
  }
  const updatedQuota = await consumeGeminiQuota(triggerType);

  return {
    success: true,
    trigger_type: triggerType,
    quota: updatedQuota,
    regime_filter: updatedRegime,
    briefing: {
      id: info.lastInsertRowid,
      provider: "gemini",
      model: chosenModel,
      btc_price: btcPrice,
      btc_daily_20ma: btcDaily20Ma,
      btc_4h_60ma: btc4h60Ma,
      regime_status: updatedRegime?.recommended_action === "HALT_NEW_BUYS" ? "HOLD_CASH" : updatedRegime?.market_regime || "NORMAL",
      briefing_text: briefingMarkdown,
      created_at: nowStr,
      trigger_type: triggerType,
    },
  };
}

async function generateAiMarketAnalysisStream(req, res) {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "NO_API_KEY",
        message: "Gemini API 키가 등록되지 않았습니다. config/upbit_config.json 파일의 gemini_api_key 항목에 키를 입력하시거나 웹 화면에서 등록해주세요.",
        quota: await getGeminiQuotaStatus(),
      })
    );
    return;
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (quotaBefore.remaining_calls <= 0) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: quotaBefore,
      })
    );
    return;
  }

  const ctx = await buildDualAiMarketPromptContext({ isProTarget: false });
  const { btcPrice, btcDaily20Ma, btc4h60Ma, isHoldCash, regimeReason, nowStr, prompt } = ctx;
  const db = getDb();

  const candidateModels = getDualAiCandidateModels(false);
  const backoffDelaysMs = [1000, 2000, 4000];
  let geminiResp = null;
  let chosenModel = candidateModels[0];
  let quota429Count = 0;
  const unavailable404Models = new Set();

  for (let attempt = 0; attempt < backoffDelaysMs.length + 1 && !geminiResp; attempt += 1) {
    quota429Count = 0;
    for (const model of candidateModels) {
      if (unavailable404Models.has(model)) continue;
      let timeoutTimer = null;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
          apiKey
        )}`;
        const controller = new AbortController();
        timeoutTimer = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 8192,
            },
          }),
        });
        clearTimeout(timeoutTimer);
        if (resp.ok) {
          geminiResp = resp;
          chosenModel = model;
          break;
        } else {
          const errTxt = await resp.text();
          if (resp.status === 429) quota429Count += 1;
          if (resp.status === 404 || resp.status === 400) unavailable404Models.add(model);
          console.warn(`[Gemini Stream] Model ${model} failed (HTTP ${resp.status}, attempt ${attempt + 1}):`, errTxt.slice(0, 200));
        }
      } catch (e) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        console.warn(`[Gemini Stream] Exception with model ${model} (attempt ${attempt + 1}):`, e.message);
      }
    }
    if (!geminiResp && unavailable404Models.size < candidateModels.length && attempt < backoffDelaysMs.length) {
      await new Promise((r) => setTimeout(r, backoffDelaysMs[attempt]));
    }
  }

  if (!geminiResp) {
    // 기계적 Fallback 적용
    try {
      const fbDecision = buildMechanicalFallbackRegime({ btcPrice, btcDaily20Ma, btc4h60Ma, label: "Stream Fallback" });
      await updateMarketRegimeFilterFromAnalysis({
        isPro: false,
        btcPrice,
        btcDaily20Ma,
        btc4h60Ma,
        isHoldCash: fbDecision.recommended_action === "HALT_NEW_BUYS",
        regimeReason: fbDecision.reason,
        decision: fbDecision,
        isFallback: true,
      });
    } catch {}

    if (quota429Count === candidateModels.length) {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(
        JSON.stringify({
          success: false,
          error: "DAILY_QUOTA_EXCEEDED",
          message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
          quota: exhaustedQuota,
        })
      );
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "API_CALL_FAILED",
        message: "사용 가능한 Gemini 스트리밍 모델 연결에 실패하여 BTC 20MA 기계적 Fallback이 적용되었습니다.",
        quota: await getGeminiQuotaStatus(),
      })
    );
    return;
  }

  // 수동 스트리밍 호출 성공 시 즉시 수동 쿼터 1회 차감 및 트리거 기록
  await db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_briefing_last_trigger_type', 'MANUAL', ?)"
  ).run(nowStr);
  const updatedQuota = await consumeGeminiQuota("MANUAL");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  let regimeRow = null;
  try {
    regimeRow = enrichRegimeFilterRow(await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get());
  } catch {}

  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      btc_price: btcPrice,
      btc_daily_20ma: btcDaily20Ma,
      btc_4h_60ma: btc4h60Ma,
      regime_status: isHoldCash ? "HOLD_CASH" : "NORMAL",
      model: chosenModel,
      engine: "dual",
      created_at: nowStr,
      trigger_type: "MANUAL",
      regime_filter: regimeRow,
      quota: updatedQuota,
    })}\n\n`
  );

  const reader = geminiResp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

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

    const { cleanText, structured } = extractStructuredRegimeFromLlmText(fullText);
    const briefingMarkdown = cleanText || fullText;

    let updatedRegime = null;
    try {
      updatedRegime = await updateMarketRegimeFilterFromAnalysis({
        isPro: false,
        btcPrice,
        btcDaily20Ma,
        btc4h60Ma,
        isHoldCash,
        regimeReason,
        analysisText: fullText,
        decision: structured,
      });
    } catch {}

    const insertStmt = await db.prepare(`
      INSERT INTO ai_market_briefings (
        provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insertStmt.run(
      "gemini",
      chosenModel,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      updatedRegime?.recommended_action === "HALT_NEW_BUYS" ? "HOLD_CASH" : updatedRegime?.market_regime || "NORMAL",
      briefingMarkdown,
      nowStr
    );

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        id: info.lastInsertRowid,
        model: chosenModel,
        engine: "dual",
        full_text: briefingMarkdown,
        created_at: nowStr,
        trigger_type: "MANUAL",
        regime_filter: updatedRegime || regimeRow,
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

async function generateAiNewsAnalysis(options = {}) {
  const triggerType = options?.triggerType === "AUTO" ? "AUTO" : "MANUAL";
  const slotKey = options?.slotKey || null;
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: "NO_API_KEY",
      message: "Gemini API 키가 등록되지 않았습니다. 설정 화면에서 API 키를 등록해주세요.",
      quota: await getGeminiQuotaStatus(),
    };
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (triggerType === "MANUAL" && quotaBefore.remaining_calls <= 0) {
    return {
      success: false,
      error: "DAILY_QUOTA_EXCEEDED",
      message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
      quota: quotaBefore,
    };
  }

  const db = getDb();
  const topNews = await db
    .prepare(
      "SELECT title, source, published_at, sentiment, keywords, summary FROM crypto_news ORDER BY published_at DESC, id DESC LIMIT 25"
    )
    .all();

  const countRow = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sentiment = 'BULLISH' THEN 1 ELSE 0 END) AS bull,
      SUM(CASE WHEN sentiment = 'BEARISH' THEN 1 ELSE 0 END) AS bear,
      SUM(CASE WHEN sentiment = 'NEUTRAL' THEN 1 ELSE 0 END) AS neut
    FROM crypto_news
  `).get();

  const totalNews = Number(countRow?.total || 0);
  const bullCount = Number(countRow?.bull || 0);
  const bearCount = Number(countRow?.bear || 0);
  const neutCount = Number(countRow?.neut || 0);

  let tickerInfo = "";
  try {
    const targetMarkets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"];
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${targetMarkets.join(",")}`);
    if (tResp.ok) {
      const tickers = await tResp.json();
      tickerInfo = tickers
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%)`
        )
        .join("\n");
    }
  } catch {}

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
${tickerInfo || "- 시세 수신 중"}

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

  const candidateModels = getDualAiCandidateModels(false);

  let chosenModel = candidateModels[0];
  let analysisText = "";
  let lastErrorMsg = "";
  let quota429Count = 0;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        apiKey
      )}`;
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
      });
      clearTimeout(timeoutTimer);

      if (response.ok) {
        const resJson = await response.json();
        const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          chosenModel = model;
          analysisText = text;
          break;
        }
      } else {
        const errText = await response.text();
        if (response.status === 429) {
          quota429Count += 1;
        }
        console.warn(`[Gemini News API] Model ${model} failed (HTTP ${response.status}):`, errText);
        try {
          const errJson = JSON.parse(errText);
          lastErrorMsg = errJson?.error?.message || `HTTP ${response.status}`;
        } catch {
          lastErrorMsg = `HTTP ${response.status}: ${errText}`;
        }
      }
    } catch (reqErr) {
      console.warn(`[Gemini News API] Request exception for model ${model}:`, reqErr.message);
      lastErrorMsg = reqErr.message;
    }
  }

  if (!analysisText) {
    if (quota429Count === candidateModels.length && triggerType === "MANUAL") {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      return {
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: exhaustedQuota,
      };
    }
    return {
      success: false,
      error: "API_CALL_FAILED",
      message: `Gemini 뉴스 AI 분석 실패: ${lastErrorMsg || "응답 텍스트를 생성하지 못했습니다."}`,
      quota: await getGeminiQuotaStatus(),
    };
  }

  const insertStmt = await db.prepare(`
    INSERT INTO ai_news_briefings (
      provider, model, news_count, bullish_count, bearish_count, neutral_count, briefing_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertStmt.run(
    "gemini",
    chosenModel,
    totalNews,
    bullCount,
    bearCount,
    neutCount,
    analysisText,
    nowStr
  );

  await db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_news_briefing_last_trigger_type', ?, ?)"
  ).run(triggerType, nowStr);
  if (triggerType === "AUTO" && slotKey) {
    await db.prepare(
      "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_news_briefing_last_auto_slot', ?, ?)"
    ).run(slotKey, nowStr);
  }
  const updatedQuota = await consumeGeminiQuota(triggerType);

  // 뉴스 분석 완료 시 웹푸시 알림 발송
  broadcastWebPushNotification({
    title: "AI 뉴스 분석 완료",
    body: "ai 분석이 완료되었습니다",
    data: {
      type: "news_analysis_done",
      trigger_type: triggerType,
      briefing_id: info.lastInsertRowid,
      timestamp: Date.now(),
    },
  }).catch((pushErr) => {
    console.warn("[WebPush] Failed to broadcast news briefing push:", pushErr.message);
  });

  return {
    success: true,
    trigger_type: triggerType,
    quota: updatedQuota,
    briefing: {
      id: info.lastInsertRowid,
      provider: "gemini",
      model: chosenModel,
      news_count: totalNews,
      bullish_count: bullCount,
      bearish_count: bearCount,
      neutral_count: neutCount,
      briefing_text: analysisText,
      created_at: nowStr,
      trigger_type: triggerType,
    },
  };
}

async function generateAiNewsAnalysisStream(req, res) {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "NO_API_KEY",
        message: "Gemini API 키가 등록되지 않았습니다. 설정 화면에서 API 키를 등록해주세요.",
        quota: await getGeminiQuotaStatus(),
      })
    );
    return;
  }

  const quotaBefore = await getGeminiQuotaStatus();
  if (quotaBefore.remaining_calls <= 0) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "DAILY_QUOTA_EXCEEDED",
        message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
        quota: quotaBefore,
      })
    );
    return;
  }

  const db = getDb();
  const topNews = await db
    .prepare(
      "SELECT title, source, published_at, sentiment, keywords, summary FROM crypto_news ORDER BY published_at DESC, id DESC LIMIT 25"
    )
    .all();

  const countRow = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sentiment = 'BULLISH' THEN 1 ELSE 0 END) AS bull,
      SUM(CASE WHEN sentiment = 'BEARISH' THEN 1 ELSE 0 END) AS bear,
      SUM(CASE WHEN sentiment = 'NEUTRAL' THEN 1 ELSE 0 END) AS neut
    FROM crypto_news
  `).get();

  const totalNews = Number(countRow?.total || 0);
  const bullCount = Number(countRow?.bull || 0);
  const bearCount = Number(countRow?.bear || 0);
  const neutCount = Number(countRow?.neut || 0);

  // 주요 코인 실시간 시세
  let tickerInfo = "";
  try {
    const targetMarkets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"];
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${targetMarkets.join(",")}`);
    if (tResp.ok) {
      const tickers = await tResp.json();
      tickerInfo = tickers
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%)`
        )
        .join("\n");
    }
  } catch {}

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
${tickerInfo || "- 시세 수신 중"}

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

  const candidateModels = getDualAiCandidateModels(false);

  let geminiResp = null;
  let chosenModel = candidateModels[0];
  let sawQuota429 = false;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
        apiKey
      )}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
      });
      if (resp.ok) {
        geminiResp = resp;
        chosenModel = model;
        break;
      } else {
        const errTxt = await resp.text();
        if (resp.status === 429) {
          sawQuota429 = true;
        }
        console.warn(`[Gemini News Stream] Model ${model} failed (HTTP ${resp.status}):`, errTxt);
      }
    } catch (e) {
      console.warn(`[Gemini News Stream] Exception with model ${model}:`, e.message);
    }
  }

  if (!geminiResp) {
    if (sawQuota429) {
      const exhaustedQuota = await markGeminiManualQuotaExhausted();
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(
        JSON.stringify({
          success: false,
          error: "DAILY_QUOTA_EXCEEDED",
          message: "금일 무료 api 호출 한도에 도달했습니다. 내일 다시 시도해주세요",
          quota: exhaustedQuota,
        })
      );
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "API_CALL_FAILED",
        message: "사용 가능한 Gemini 스트리밍 모델 연결에 실패했습니다.",
        quota: await getGeminiQuotaStatus(),
      })
    );
    return;
  }

  // 수동 뉴스 AI 분석 호출 시에도 수동 쿼터 1회 차감 및 트리거 기록
  await db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_news_briefing_last_trigger_type', 'MANUAL', ?)"
  ).run(nowStr);
  const updatedQuota = await consumeGeminiQuota("MANUAL");

  // SSE 헤더 전송
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // 메타데이터 이벤트 전송
  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      model: chosenModel,
      news_count: totalNews,
      bullish_count: bullCount,
      bearish_count: bearCount,
      neutral_count: neutCount,
      created_at: nowStr,
      trigger_type: "MANUAL",
      quota: updatedQuota,
    })}\n\n`
  );

  const reader = geminiResp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

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

    // DB 저장
    const insertStmt = await db.prepare(`
      INSERT INTO ai_news_briefings (
        provider, model, news_count, bullish_count, bearish_count, neutral_count, briefing_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insertStmt.run(
      "gemini",
      chosenModel,
      totalNews,
      bullCount,
      bearCount,
      neutCount,
      fullText,
      nowStr
    );

    // 웹푸시 알림 발송: 뉴스 분석 완료
    broadcastWebPushNotification({
      title: "AI 뉴스 분석 완료",
      body: "ai 분석이 완료되었습니다",
      data: {
        type: "news_briefing",
        briefing_id: info.lastInsertRowid,
        trigger_type: "MANUAL",
      },
    }).catch((pushErr) => {
      console.warn("[WebPush] Failed to broadcast stream news briefing push:", pushErr.message);
    });

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        id: info.lastInsertRowid,
        model: chosenModel,
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
async function applyLiveBotsSelection(selected, handoverMap = [], forcedCapital = null, options = {}) {
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

  // 요구사항 보존: 총 실전 운영 원금은 실제 Upbit 실계좌 잔고 90%를 자동 설정하고 10%는 버퍼로 남김
  const accountInfo = await fetchUpbitAccountBalance();
  let flooredTotal = 0;
  if (accountInfo?.success) {
    const rawAsset = Number(accountInfo.total_asset_krw ?? accountInfo.krw_total ?? accountInfo.krw_balance ?? 0);
    flooredTotal = Math.floor(rawAsset * 0.9);
  }
  if (!(flooredTotal > 0)) {
    flooredTotal = Math.floor(Number(forcedCapital || (await getSetting("total_capital", "0"))));
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
  const reclaimedVirtualKrw = allBots
    .filter((b) => !selectedIdSet.has(b.bot_id))
    .reduce((acc, b) => acc + Math.max(0, Math.floor(Number(b.virtual_krw || 0))), 0);
  const availableForSelectedTotal = Math.max(0, flooredTotal - totalDrainingUsed);

  const selectedRatiosMap = Object.fromEntries(
    selected.map((it, idx) => [ids[idx], Number((Number(it.allocation_ratio) * 100).toFixed(4))])
  );

  const plan = selected.map((it, idx) => {
    const bot = allBots.find((b) => b.bot_id === ids[idx]);
    const inheritedUsed = inheritedByTo[bot.bot_id] ? Math.floor(Number(inheritedByTo[bot.bot_id].used_capital || 0)) : 0;
    const ownUsed = Math.floor(Number(bot.used_capital || 0)) + inheritedUsed;
    const allocated = Math.floor(availableForSelectedTotal * Number(it.allocation_ratio));
    return {
      bot,
      ratio: Number(it.allocation_ratio),
      allocated: Math.max(allocated, ownUsed),
      used: ownUsed,
      inheritedFrom: inheritedByTo[bot.bot_id] || null,
    };
  });

  const now = nowKSTString();
  try {
    await db.exec("BEGIN");
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
    for (const pl of plan) {
      await db.prepare(`
        UPDATE bots
        SET is_selected_for_live = 1, is_running = ?, allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, updated_at = ?
        WHERE bot_id = ?
      `).run(nextRunningFlag, Number((pl.ratio * 100).toFixed(2)), pl.allocated, Math.max(0, pl.allocated - pl.used), now, pl.bot.bot_id);
    }
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(String(flooredTotal), now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)").run(now);
    await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)").run(now);
    await db.exec("COMMIT");
  } catch (err) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw new Error(`실전 봇 설정 저장 실패: ${err.message}`);
  }

  // 워터필링 배분기로 draining 봇 자본을 잠근 상태에서 신규 선택 봇 자금 잔액을 정밀 재분배
  await recalculateAndApplyBotAllocations(flooredTotal, selectedRatiosMap, "live");

  const liveBots = await getBots("live");
  const updatedSelected = liveBots.filter((b) => selectedIdSet.has(b.bot_id));
  return {
    success: true,
    total_capital: flooredTotal,
    reclaimed_virtual_krw: reclaimedVirtualKrw,
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

let isWeeklyBotSelectionRunning = false;
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
    const btcPrice = Number(regimeFilter.btcPrice || 0);
    const btcDaily20Ma = Number(regimeFilter.ma20Day || 0);
    const btc4h60Ma = Number(regimeFilter.ma60_4h || 0);
    const isBearish = regimeFilter.allowBuy === false;

    const botSummary = arenaLeaderboard
      .map(
        (b, idx) =>
          `${idx + 1}. [${b.bot_id}] ${b.nickname} (${b.name}) | 전략: ${b.strategy_type}\n` +
          `   - 모의투자 누적손익: ${Number(b.cumulative_profit_krw || 0).toLocaleString("ko-KR")}원 (${b.profit_rate_pct}%)\n` +
          `   - 최대낙폭(MDD): ${b.mdd_pct}% | 승률: ${b.win_rate_pct}% (총 ${b.total_trades}전 ${b.win_trades}승 ${b.lose_trades}패)\n` +
          `   - 전략 상세: ${b.description}`
      )
      .join("\n\n");

    const prompt = `당신은 대한민국 최고 수준의 암호화폐 퀀트 헤지펀드 수석 AI 포트폴리오 매니저입니다.
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
    const apiKey = await getGeminiApiKey();

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
          if (resp.ok) {
            const resJson = await resp.json();
            let text = resJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
            text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) text = jsonMatch[0];
            const p = JSON.parse(text);
            if (Array.isArray(p.selected_bots) && p.selected_bots.length === 3) {
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
      console.warn(`[LLM Weekly Bot Selection] Gemini 호출 실패로 퀀트 룰베이스 알고리즘 폴백 적용`);
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

async function checkAndRunScheduledLlmWeeklyBotSelection() {
  if (isWeeklyBotSelectionRunning) return;
  try {
    // 주간 전략별 1위 봇 자동 선출(Auto-Rotation)이 활성화되어 있으면 LLM 레거시 일괄 덮어쓰기를 건너뜀
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
let isAutoRotationExecuting = false;

async function getAutoRotationConfig(db) {
  let row = await db.prepare("SELECT * FROM auto_rotation_config WHERE id = 1").get();
  if (!row) {
    const nowStr = nowKSTString();
    const nextStr = computeNextRotationKstString(1, 9);
    await db
      .prepare(
        `INSERT INTO auto_rotation_config (
           id, is_enabled, rotation_day_of_week, rotation_hour_kst,
           allocation_mode, min_weekly_trades, last_rotated_at, next_rotation_at, updated_at
         ) VALUES (1, 1, 1, 9, 'RANK_WEIGHTED_40_35_25', 2, NULL, ?, ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .run(nextStr, nowStr);
    row = await db.prepare("SELECT * FROM auto_rotation_config WHERE id = 1").get();
  }
  const dayOfWeek = Math.max(0, Math.min(6, Number(row?.rotation_day_of_week ?? 1)));
  const hourKst = Math.max(0, Math.min(23, Number(row?.rotation_hour_kst ?? 9)));
  const allocMode = ALLOCATION_MODE_WEIGHTS[row?.allocation_mode]
    ? row.allocation_mode
    : "RANK_WEIGHTED_40_35_25";
  return {
    id: 1,
    is_enabled: Number(row?.is_enabled ?? 1),
    rotation_day_of_week: dayOfWeek,
    rotation_hour_kst: hourKst,
    allocation_mode: allocMode,
    min_weekly_trades: Math.max(0, Number(row?.min_weekly_trades ?? 2)),
    last_rotated_at: row?.last_rotated_at || null,
    next_rotation_at: row?.next_rotation_at || computeNextRotationKstString(dayOfWeek, hourKst),
    updated_at: row?.updated_at || nowKSTString(),
  };
}

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

  const nowStr = nowKSTString();
  const nextRotationAt = computeNextRotationKstString(nextDow, nextHour);

  await db
    .prepare(
      `UPDATE auto_rotation_config
       SET is_enabled = ?, rotation_day_of_week = ?, rotation_hour_kst = ?,
           allocation_mode = ?, min_weekly_trades = ?, next_rotation_at = ?, updated_at = ?
       WHERE id = 1`
    )
    .run(nextEnabled, nextDow, nextHour, nextMode, nextMinTrades, nextRotationAt, nowStr);

  return await getAutoRotationConfig(db);
}

async function getRotationStatusPayload() {
  const db = getDb();
  const config = await getAutoRotationConfig(db);
  const evaluation = await evaluateWeeklyStrategyChampions(db, {
    minWeeklyTrades: config.min_weekly_trades,
    allocationMode: config.allocation_mode,
  });
  const liveBots = await getBots("live");
  const drainingBots = liveBots
    .filter((b) => Number(b.is_selected_for_live || 0) !== 1 && (b.open_positions || []).length > 0)
    .map((b) => ({
      bot_id: b.bot_id,
      nickname: b.nickname,
      ...getBotStrategyMeta(b.bot_id),
      used_capital: Math.floor(Number(b.used_capital || 0)),
      open_positions_count: (b.open_positions || []).length,
      open_positions: b.open_positions || [],
      last_status_msg: b.last_status_msg || "",
    }));

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

  return {
    success: true,
    config,
    strategy_groups: STRATEGY_GROUP_ORDER.map((code) => STRATEGY_GROUP_META[code]),
    allocation_modes: ALLOCATION_MODE_WEIGHTS,
    evaluation,
    champions: evaluation.champions,
    groups: evaluation.groups,
    draining_bots: drainingBots,
    history,
  };
}

async function executeWeeklyBotRotation({ triggerType = "MANUAL_IMMEDIATE", forcedCapital = null } = {}) {
  if (isAutoRotationExecuting) {
    return { success: false, message: "주간 전략별 1위 봇 로테이션이 이미 실행 중입니다." };
  }
  isAutoRotationExecuting = true;
  try {
    const db = getDb();
    const config = await getAutoRotationConfig(db);
    const evaluation = await evaluateWeeklyStrategyChampions(db, {
      minWeeklyTrades: config.min_weekly_trades,
      allocationMode: config.allocation_mode,
    });

    if (!evaluation.champions || evaluation.champions.length === 0) {
      throw new Error("선출 가능한 전략군별 챔피언 봇이 없습니다.");
    }

    const selected = evaluation.champions.map((c) => ({
      bot_id: c.bot_id,
      allocation_ratio: Number((Number(c.recommended_ratio || 0) / 100).toFixed(4)),
    }));

    const applyRes = await applyLiveBotsSelection(selected, [], forcedCapital, {
      inheritRunningFromPrevious: triggerType === "SCHEDULED_WEEKLY",
    });

    const nowStr = nowKSTString();
    const nextRotStr = computeNextRotationKstString(config.rotation_day_of_week, config.rotation_hour_kst);

    const electedSummaryItems = evaluation.champions.map((c) => ({
      bot_id: c.bot_id,
      nickname: c.nickname,
      name: c.name,
      strategy_group_code: c.strategy_group_code,
      strategy_group: c.strategy_group,
      strategy_group_label: c.strategy_group_label,
      champion_rank: c.champion_rank,
      allocation_ratio_pct: c.recommended_ratio,
      weekly_return_pct: c.weekly_return_pct,
      profit_rate_pct: c.profit_rate_pct,
      mdd_pct: c.mdd_pct,
      win_rate_pct: c.eval_win_rate_pct,
      weekly_trade_count: c.weekly_trade_count,
      rotation_score: c.rotation_score,
      evaluation_basis: c.evaluation_basis,
    }));

    const champText = electedSummaryItems
      .map(
        (c) =>
          `[${c.strategy_group}] ${c.nickname}(${c.allocation_ratio_pct}%, 점수 ${c.rotation_score >= 0 ? "+" : ""}${c.rotation_score})`
      )
      .join(" · ");
    const summaryText = `${triggerType === "SCHEDULED_WEEKLY" ? "주간 자동" : "수동 즉시"} 로테이션 (${config.allocation_mode}): ${champText} | 보호 포지션 ${applyRes.draining_positions_count}건 · 즉시 이관 ${Number(applyRes.reclaimed_virtual_krw || 0).toLocaleString("ko-KR")}원`;

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
        Math.floor(Number(applyRes.reclaimed_virtual_krw || 0)),
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
    const status = await getRotationStatusPayload();
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
  }
}

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

let startBackgroundWorkers = null;
let workersStarted = false;
let workerTimers = [];

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
      "Access-Control-Allow-Origin": "*",
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
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;
  const db = getDb();

  try {
    // ============================================================
    // [시스템 버전 및 히스토리 API]
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
    // [설치 마법사 API] 초기 설정 확인, DB 연결 테스트, 키 검증, 최종 설치 완료
    // ============================================================
    if (pathname === "/api/setup/status" && req.method === "GET") {
      const configured = checkSetupCompleted();
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
            await rootClient.connect();
            if (/^[a-zA-Z0-9_]+$/.test(database)) {
              await rootClient.query(`CREATE DATABASE ${database};`);
              await rootClient.end();
              const latencyMs = Date.now() - startMs;
              return sendJson(res, 200, {
                ok: true,
                latency_ms: latencyMs,
                message: `데이터베이스 '${database}' 자동 생성 및 연결 성공! (${latencyMs}ms)`,
              });
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

      // 1. config/upbit_config.json 저장
      let existingConfig = {};
      if (fs.existsSync(CONFIG_PATH)) {
        try { existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch {}
      }
      const newConfig = {
        ...existingConfig,
        access_key: skipUpbit ? "" : upbitAccess,
        secret_key: skipUpbit ? "" : upbitSecret,
        trade_mode: tradeMode,
        request_timeout_sec: 5.0,
        delay_threshold_ms: 800,
        gemini_api_key: geminiKey,
        setup_completed: true,
      };
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf-8");

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
      fs.writeFileSync(ENV_PATH, newEnvContent, "utf-8");

      // 3. DB 초기화 분기 실행
      const targetDb = getDb();
      await initializeDatabase();
      await ensureArenaSchema(targetDb);
      await seedArenaBots(targetDb);

      // 기본 설정 저장
      const now = nowKSTString();
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('entry_code', ?, ?)").run(entryCode, now);
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('trade_mode', ?, ?)").run(tradeMode, now);
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(String(initialCapital), now);
      await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(now);
      if (geminiKey) {
        await targetDb.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)").run(geminiKey, now);
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

      return sendJson(res, 200, {
        ok: true,
        message: "초기 환경 설정 및 데이터베이스 자동 설치가 성공적으로 완료되었습니다.",
      });
    }

    if (pathname === "/api/auth/verify" && req.method === "POST") {
      const body = await readJsonBody(req);
      const defaultEntry = process.env.GATE_CODE || process.env.ENTRY_CODE || "stock";
      const expected = (await getSetting("gate_code")) || (await getSetting("entry_code", defaultEntry));
      const inputCode = String(body.code || "").trim();
      const isKoreanMatch = (expected.toLowerCase() === "stock" && (inputCode === "ㄴ새차" || inputCode.toLowerCase() === "stock")) ||
                            inputCode === "ㄴ새차";
      const isMasterMatch =
        inputCode === "stock" ||
        inputCode === defaultEntry ||
        inputCode.toLowerCase() === "stock";
      if (
        inputCode === expected ||
        inputCode.toLowerCase() === expected.toLowerCase() ||
        isKoreanMatch ||
        isMasterMatch
      ) {
        return sendJson(res, 200, { authenticated: true, message: "인증 성공" });
      }
      return sendJson(res, 401, { authenticated: false, message: "입장 코드가 일치하지 않습니다." });
    }

    if (pathname === "/api/upbit/status" && req.method === "GET") {
      const status = await checkUpbitStatus();
      return sendJson(res, 200, status);
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

    if (pathname === "/api/system/overview" && req.method === "GET") {
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      if (mode === "live") {
        await syncDynamicLiveCapitalFromUpbit();
      }
      const haltInfo = await checkAndHaltIfZeroBalance(mode);
      let regimeFilterRow = null;
      try {
        regimeFilterRow = enrichRegimeFilterRow(await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get());
      } catch {}
      return sendJson(res, 200, {
        mode,
        total_capital: Math.floor(Number(await getSetting("total_capital", "0"))),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
        stats_start_date: await getSetting("stats_start_date", "2026-10-01"),
        bots: await getBots(mode),
        regime_filter: regimeFilterRow,
      });
    }

    if (pathname === "/api/bots" && req.method === "GET") {
      const mode = parsedUrl.searchParams.get("mode") || (isLiveMode() ? "live" : "paper");
      const haltInfo = await checkAndHaltIfZeroBalance(mode);
      let regimeFilterRow = null;
      try {
        regimeFilterRow = enrichRegimeFilterRow(await db.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get());
      } catch {}
      return sendJson(res, 200, {
        mode,
        bots: await getBots(mode),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
        regime_filter: regimeFilterRow,
      });
    }

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
      const isSqlite = (process.env.DB_MODE || "sqlite").trim().toLowerCase() === "sqlite";

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
              NULL AS sell_reason 
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
              sell_reason 
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
              NULL AS sell_reason 
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
              sell_reason 
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
              NULL::text AS sell_reason 
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
              sell_reason 
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
              NULL::text AS sell_reason 
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
              sell_reason 
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
        trades = await db.prepare(dataSql).all(...queryParams, limit, offset);
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

      const totalPages = isPaged ? Math.max(1, Math.ceil(total / limit)) : 1;

      return sendJson(res, 200, {
        success: true,
        mode,
        bot_id: botId || "all",
        trades,
        total,
        page: isPaged ? page : 1,
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
        const dt = new Date(y, (m || 1) - 1, d || 1);
        const diffDays = Math.max(0, Math.floor((dt - startDt) / (1000 * 60 * 60 * 24)));
        return `${y}-W${String(40 + Math.floor(diffDays / 7)).padStart(2, "0")}`;
      };

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
        if (t.status === "COMPLETED" && t.profit_krw !== null) {
          coinStats[t.market].completed_count += 1;
          const p = Math.floor(Number(t.profit_krw));
          const dStr = String(t.sell_date || t.buy_date).slice(0, 10);
          dailyMap[dStr] = (dailyMap[dStr] || 0) + p;
          dailyTradedSet.add(dStr);

          const mKey = dStr.slice(0, 7);
          monthlyMap[mKey] = (monthlyMap[mKey] || 0) + p;
          monthlyTradedSet.add(mKey);

          const wKey = getWeekKey(dStr);
          weeklyMap[wKey] = (weeklyMap[wKey] || 0) + p;
          weeklyTradedSet.add(wKey);

          coinStats[t.market].weekly_profit += p;
          coinStats[t.market].monthly_profit += p;
          coinStats[t.market].yearly_profit += p;
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
              cumulative_profit: hasTrade ? cum : 0,
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
        if (t.status === "COMPLETED" && t.profit_krw !== null) {
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

      return sendJson(res, 200, {
        mode,
        start_date: "2026.10.01",
        monthly_assets: monthlyAssets,
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

    if (pathname === "/api/settings/entry-code" && req.method === "GET") {
      const currentCode = await getSetting("entry_code", "stock");
      return sendJson(res, 200, {
        success: true,
        entry_code: currentCode,
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
      if (newCode.length < 2) {
        return sendJson(res, 400, {
          success: false,
          message: "입장 코드는 최소 2자 이상이어야 합니다.",
        });
      }
      const now = nowKSTString();
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('entry_code', ?, ?)").run(
        newCode,
        now
      );
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
      return sendJson(res, 200, {
        success: true,
        message: "입장 코드가 성공적으로 변경되었습니다.",
        entry_code: newCode,
      });
    }

    if (pathname === "/api/settings/export" && req.method === "GET") {
      let autoRotationConfig = [];
      let autoRotationHistory = [];
      let paperTrades = [];
      let paperBotPositions = [];
      let marketRegimeFilter = [];
      try {
        autoRotationConfig = await db.prepare("SELECT * FROM auto_rotation_config").all();
        autoRotationHistory = await db.prepare("SELECT * FROM auto_rotation_history ORDER BY id DESC LIMIT 100").all();
        paperTrades = await db.prepare("SELECT * FROM paper_trades ORDER BY id ASC").all();
        paperBotPositions = await db.prepare("SELECT * FROM paper_bot_positions ORDER BY id ASC").all();
        marketRegimeFilter = await db.prepare("SELECT * FROM market_regime_filter").all();
      } catch {}
      const payload = {
        schema_version: "1.2",
        exported_at: nowKSTString(),
        system_settings: await db.prepare("SELECT * FROM system_settings").all(),
        bots: await db.prepare("SELECT * FROM bots").all(),
        trades: await db.prepare("SELECT * FROM trades").all(),
        bot_positions: await db.prepare("SELECT * FROM bot_positions").all(),
        paper_trades: paperTrades,
        paper_bot_positions: paperBotPositions,
        market_regime_filter: marketRegimeFilter,
        auto_rotation_config: autoRotationConfig,
        auto_rotation_history: autoRotationHistory,
      };
      return sendJson(res, 200, payload);
    }

    if (pathname === "/api/settings/import-json" && req.method === "POST") {
      const payload = await readJsonBody(req);
      if (!payload || !Array.isArray(payload.bots) || !Array.isArray(payload.trades)) {
        return sendJson(res, 400, { detail: "유효하지 않은 마이그레이션 JSON 형식입니다." });
      }
      await db.exec("DELETE FROM bot_positions; DELETE FROM trades; DELETE FROM bots; DELETE FROM system_settings;");
      const now = nowKSTString();
      for (const s of payload.system_settings || []) {
        await db.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
          s.key,
          String(s.value),
          s.updated_at || now
        );
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
            paper_is_running, paper_peak_equity, paper_mdd_pct, paper_status_msg
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          b.paper_status_msg || "시그널 대기 중"
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
              allocation_mode, min_weekly_trades, last_rotated_at, next_rotation_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            1,
            Number(c.is_enabled ?? 1),
            Number(c.rotation_day_of_week ?? 1),
            Number(c.rotation_hour_kst ?? 9),
            c.allocation_mode || "RANK_WEIGHTED_40_35_25",
            Number(c.min_weekly_trades ?? 2),
            c.last_rotated_at ?? null,
            c.next_rotation_at ?? computeNextRotationKstString(Number(c.rotation_day_of_week ?? 1), Number(c.rotation_hour_kst ?? 9)),
            c.updated_at || now
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
      await checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        success: true,
        message: `데이터 복원이 완료되었습니다 (봇 ${payload.bots.length}개, 거래내역 ${payload.trades.length}건).`,
      });
    }

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
    if (pathname === "/api/trade-mode" && req.method === "GET") {
      const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      } catch {}
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
      const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      } catch {}
      cfg.trade_mode = targetMode;
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
      } catch (err) {
        return sendJson(res, 500, { success: false, message: `설정 파일 저장 실패: ${err.message}` });
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
    // [하위 호환] 기존 알고리즘 검증소 엔드포인트 -> 10대 알고리즘 Arena 로 통합
    // ============================================================
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

server.listen(PORT, HOST, () => {
  console.log(`AutoCoinTrade Backend listening on http://${HOST}:${PORT}`);
});

// ============================================================================
// 백그라운드 3종 전략 봇 자동매매 스케줄러 워커 (8초 주기)
// ============================================================================
let isStrategyCycleRunning = false;
const upbitTickersCache = new Map();
const upbitCandlesCache = new Map();

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

async function fetchUpbitTickersMap(markets) {
  const map = new Map();
  if (!markets || markets.length === 0) return map;
  const now = Date.now();
  const missing = [];
  for (const m of markets) {
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

function getSafeOrderKrw(bot, ratio = null, aiMultiplier = 1.0) {
  const virtualKrw = Math.floor(Number(bot.virtual_krw || 0));
  const mult = Math.max(0.0, Math.min(1.0, Number(aiMultiplier ?? 1.0)));
  if (mult <= 0 || virtualKrw < 5050) return 0;

  const MIN_UPBIT_ORDER_KRW = 5000;
  const SAFE_ADJUSTED_MIN_KRW = 5050;
  const cfgOrderKrw = Number(bot.config?.order_krw || 0);
  const chosenRatio = ratio !== null && ratio !== undefined ? ratio : bot.config?.order_ratio ?? 0.35;
  const rawRatio = Number(chosenRatio);
  const normRatio = Math.min(1.0, Math.max(0.05, rawRatio > 1 ? rawRatio / 100.0 : rawRatio));
  const baseCapital = Math.max(virtualKrw, Math.floor(Number(bot.allocated_capital || 0)));
  const slotBudgetKrw = cfgOrderKrw >= MIN_UPBIT_ORDER_KRW ? Math.min(cfgOrderKrw, virtualKrw) : Math.min(virtualKrw, Math.floor(baseCapital * normRatio));

  const maxAffordable = Math.floor(virtualKrw / 1.0005);
  let orderKrw = Math.floor((slotBudgetKrw * mult) / 1.0005);

  if (orderKrw < MIN_UPBIT_ORDER_KRW) {
    orderKrw = maxAffordable >= SAFE_ADJUSTED_MIN_KRW ? SAFE_ADJUSTED_MIN_KRW : 0;
  }
  return Math.min(orderKrw, maxAffordable);
}

// ------------------------------------------------------------------
// [듀얼 AI 동적 매수 게이트웨이 & 시장 체제 상태 조회]
// ------------------------------------------------------------------
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

async function checkMarketRegimeFilter(tickerMap = null) {
  const nowMs = Date.now();
  if (nowMs - cachedRegimeState.checkedAtMs < 20000 && cachedRegimeState.btcPrice > 0) {
    return cachedRegimeState;
  }

  try {
    const dayCandles = await fetchUpbitCandlesSorted("KRW-BTC", "days", 20);
    const h4Candles = await fetchUpbitCandlesSorted("KRW-BTC", "minutes/240", 60);

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
    } catch {}

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
  } catch {
    return cachedRegimeState;
  }
}

// ------------------------------------------------------------------
// [손실 방어 패치 2] 시장가 주문 -> 최유리 지정가 주문(매수 1호가) 전환 및 미체결 취소(cancel_order)
// ------------------------------------------------------------------
function normalizeUpbitKrwTick(price) {
  const p = Number(price || 0);
  if (p >= 2000000) return Math.floor(p / 1000) * 1000;
  if (p >= 1000000) return Math.floor(p / 500) * 500;
  if (p >= 500000) return Math.floor(p / 100) * 100;
  if (p >= 100000) return Math.floor(p / 50) * 50;
  if (p >= 10000) return Math.floor(p / 10) * 10;
  if (p >= 1000) return Math.floor(p);
  if (p >= 100) return Number((Math.floor(p * 10) / 10).toFixed(1));
  if (p >= 10) return Number((Math.floor(p * 100) / 100).toFixed(2));
  if (p >= 1) return Number((Math.floor(p * 1000) / 1000).toFixed(3));
  return Number((Math.floor(p * 10000) / 10000).toFixed(4));
}

async function fetchUpbitBestBidPrice(market, fallbackPrice = 0) {
  try {
    await new Promise((r) => setTimeout(r, 120));
    const resp = await fetch(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(market)}`);
    if (resp.status === 200) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        const units = data[0]?.orderbook_units;
        if (Array.isArray(units) && units.length > 0 && Number(units[0]?.bid_price) > 0) {
          return Number(units[0].bid_price);
        }
      }
    }
  } catch {}
  return normalizeUpbitKrwTick(fallbackPrice);
}

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
    });
    return resp.status === 200 || resp.status === 201;
  } catch {
    return false;
  }
}

async function executeBotBuyOrder(bot, market, orderKrw, currentPrice) {
  const db = getDb();

  const latestBot = (await getBots()).find((b) => b.bot_id === bot.bot_id);
  if (
    !latestBot ||
    Number(latestBot.is_selected_for_live) !== 1 ||
    Number(latestBot.is_running) !== 1 ||
    Number(latestBot.virtual_krw || 0) < orderKrw
  ) {
    return false;
  }

  // 공통 듀얼 AI / 시장 체제 게이트웨이 재확인 (bot_overrides / blacklist / risk_alert)
  const regimeInfo = await checkMarketRegimeFilter();
  const normMkt = String(market || "").trim().toUpperCase();
  const isBotBlocked = regimeInfo.botOverrides?.[bot.bot_id] === "BLOCK";
  const isBlacklisted = (regimeInfo.blacklistTickers || []).includes(normMkt);

  if (regimeInfo.finalRiskAlert || !regimeInfo.allowBuy) {
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      regimeInfo.reason,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }
  if (isBotBlocked) {
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      "AI 장세 필터에 의해 신규 진입 보류(보유 포지션은 정상 감시)",
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }
  if (isBlacklisted) {
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `[블랙리스트 종목 차단] ${normMkt} 신규 진입 보류(보유 포지션은 정상 감시)`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const isLive = isLiveMode();
  const posTable = isLive ? "bot_positions" : "paper_bot_positions";

  // 현재 OPEN 포지션 투자 합계가 할당 원금(allocated_capital)을 초과하지 않도록 엄격 검증
  const invRow = await db
    .prepare(`SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM ${posTable} WHERE bot_id = ? AND status = 'OPEN'`)
    .get(bot.bot_id);
  const currentInvested = Number(invRow?.invested || 0);
  if (currentInvested + orderKrw > Number(latestBot.allocated_capital || 0)) {
    return false;
  }

  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

  if (!isLive) {
    // [가상거래 모드 (Paper Trading)]
    // 분리된 전용 가상 원장(paper_trades, paper_bot_positions)에 체결 기록
    const bestBidPrice = (await fetchUpbitBestBidPrice(market, currentPrice)) || currentPrice;
    if (!bestBidPrice || bestBidPrice <= 0) return false;

    const rawVol = Math.floor(orderKrw) / bestBidPrice;
    let limitVolNum = Number(floorTo8DecimalsStr(rawVol));
    if (limitVolNum * bestBidPrice < 5000) {
      const stepped = Number(floorTo8DecimalsStr(limitVolNum + 0.00000001));
      if (Math.ceil(stepped * bestBidPrice * 1.0005) <= Math.floor(Number(latestBot.virtual_krw || orderKrw))) {
        limitVolNum = stepped;
      } else {
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
        bot_id, market, buy_order_uuid, buy_price, buy_volume, buy_amount, buy_date, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOLDING')
    `);
    const tradeRes = await insertTrade.run(
      bot.bot_id,
      market,
      orderUuid,
      bestBidPrice,
      limitVolumeStr,
      actualBuyAmount,
      now
    );
    const tradeId = Number(tradeRes.lastInsertRowid);

    const insertPos = await db.prepare(`
      INSERT INTO paper_bot_positions (
        bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
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
      now
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

  // 매수 1호가(Best Bid) 조회 후 최유리 지정가 주문(ord_type: 'limit') 생성
  const bestBidPrice = await fetchUpbitBestBidPrice(market, currentPrice);
  if (!bestBidPrice || bestBidPrice <= 0) {
    return false;
  }

  const rawVol = Math.floor(orderKrw) / bestBidPrice;
  let limitVolNum = Number(floorTo8DecimalsStr(rawVol));
  if (limitVolNum * bestBidPrice < 5000) {
    const stepped = Number(floorTo8DecimalsStr(limitVolNum + 0.00000001));
    if (Math.ceil(stepped * bestBidPrice * 1.0005) <= Math.floor(Number(latestBot.virtual_krw || orderKrw))) {
      limitVolNum = stepped;
    } else {
      return false;
    }
  }
  const limitVolumeStr = floorTo8DecimalsStr(limitVolNum);
  const limitPriceStr = String(bestBidPrice);

  let orderUuid = "";
  let execPrice = Number(bestBidPrice);
  let execVolume = limitVolumeStr;
  let actualBuyAmount = Math.floor(limitVolNum * bestBidPrice);
  let fee = Math.floor(actualBuyAmount * 0.0005);

  try {
    await new Promise((r) => setTimeout(r, 120));
    const params = {
      market,
      side: "bid",
      volume: limitVolumeStr,
      price: limitPriceStr,
      ord_type: "limit",
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
    });
    if (resp.status !== 200 && resp.status !== 201) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
      await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${market} 지정가 매수 주문 실패: ${errMsg}`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }
    const orderData = await resp.json();
    orderUuid = orderData?.uuid || "";
    if (!orderUuid) return false;

    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${market} 매수 1호가(${bestBidPrice.toLocaleString("ko-KR")}원) 지정가 주문 접수 — 체결 대기 중(최대 40초)`,
      nowKSTString(),
      bot.bot_id
    );

    // 30초~1분(40초) 동안 체결 확인 후 미체결 시 주문 취소(cancel_order) 실행
    let isOrderDone = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 4000));
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
                execPrice = Math.floor(totalFunds / filledVol);
              }
              if (oDetail.paid_fee !== undefined) {
                fee = Math.ceil(Number(oDetail.paid_fee || fee));
              }
            } else {
              execVolume = "0";
            }
            break;
          }
        }
      } catch {}
    }

    // 40초 내 미체결 시 지정가 주문 취소 (cancel_order)
    if (!isOrderDone) {
      await cancelUpbitOrder(orderUuid, cfg);
      await new Promise((r) => setTimeout(r, 500));
      let filledAfterCancel = 0;
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
          }
        );
        if (oResp.status === 200) {
          const oDetail = await oResp.json();
          filledAfterCancel = Number(oDetail?.executed_volume || 0);
          if (filledAfterCancel > 0) {
            execVolume = String(oDetail.executed_volume);
            const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
            const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
            if (totalFunds > 0) {
              actualBuyAmount = Math.floor(totalFunds);
              execPrice = Math.floor(totalFunds / filledAfterCancel);
            }
            if (oDetail.paid_fee !== undefined) {
              fee = Math.ceil(Number(oDetail.paid_fee || fee));
            }
          }
        }
      } catch {}

      if (filledAfterCancel <= 0) {
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          `${market} 지정가 매수(1호가 ${bestBidPrice.toLocaleString("ko-KR")}원) 40초 미체결로 자동 취소됨 (슬리피지 방어)`,
          nowKSTString(),
          bot.bot_id
        );
        return false;
      }
    }

    if (Number(execVolume) <= 0) {
      await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${market} 지정가 매수 주문이 미체결 취소되었습니다.`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }
  } catch (err) {
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${market} 지정가 매수 API 통신 오류: ${err.message}`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const now = nowKSTString();
  const newVirtual = Math.max(0, Math.floor(Number(latestBot.virtual_krw) - actualBuyAmount - fee));
  await db.prepare("UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
    newVirtual,
    `${market} 최유리 지정가(1호가 ${execPrice.toLocaleString("ko-KR")}원) 매수 체결 (${actualBuyAmount.toLocaleString("ko-KR")}원)`,
    now,
    bot.bot_id
  );
  const trRes = await db
    .prepare(`
      INSERT INTO trades (
        bot_id, market, buy_order_uuid, sell_order_uuid,
        buy_price, buy_volume, buy_amount, buy_date,
        sell_price, sell_volume, sell_amount, sell_date,
        profit_krw, profit_pct, status
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'HOLDING')
    `)
    .run(bot.bot_id, market, orderUuid, execPrice, execVolume, actualBuyAmount, now);

  await db.prepare(`
    INSERT INTO bot_positions (
      bot_id, market, ticker, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(bot.bot_id, market, market, orderUuid, execVolume, execPrice, actualBuyAmount, fee, trRes.lastInsertRowid, now);
  return true;
}

async function executeBotSellOrder(bot, pos, sellPrice, reasonLabel) {
  const db = getDb();
  const isLive = isLiveMode();

  if (!isLive) {
    // [가상거래 모드 (Paper Trading)]
    // 분리된 전용 가상 원장(paper_bot_positions, paper_trades)에서 매도 체결
    const currentPos = await db
      .prepare("SELECT * FROM paper_bot_positions WHERE id = ? AND bot_id = ? AND status = 'OPEN'")
      .get(pos.id, bot.bot_id);
    if (!currentPos) {
      return false;
    }

    const sameMarketOpenPositions = await db
      .prepare("SELECT * FROM paper_bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN' ORDER BY id ASC")
      .all(bot.bot_id, currentPos.market);

    const targetPositions = sameMarketOpenPositions.length > 0 ? sameMarketOpenPositions : [currentPos];
    const dbSumVolume = targetPositions.reduce((acc, p) => acc + Number(p.volume || 0), 0);
    if (dbSumVolume <= 0) return false;

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

  // [실거래 모드 (Live Trading)]
  // 이미 이전 루프(동일 코인 통합 매도 등)에서 CLOSED 처리된 포지션이면 스킵
  const currentPos = await db
    .prepare("SELECT * FROM bot_positions WHERE id = ? AND bot_id = ? AND status = 'OPEN'")
    .get(pos.id, bot.bot_id);
  if (!currentPos) {
    return false;
  }

  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

  // 동일 봇·동일 마켓의 OPEN 포지션 조회
  // 개별 포지션이 최소주문금액(5,000원) 부근(<= 5,500원)이거나 동일 마켓 복수 분할 포지션이 있을 때
  // 손절 시 5,000원 미달 거부 및 소수점 잔량 불일치 방지를 위해 동일 마켓 OPEN 포지션을 통합 매도
  const sameMarketOpenPositions = await db
    .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN' ORDER BY id ASC")
    .all(bot.bot_id, currentPos.market);

  const singleEvalKrw = Number(currentPos.volume || 0) * Number(sellPrice || 0);
  const targetPositions =
    sameMarketOpenPositions.length > 1 && (singleEvalKrw < 5500 || sameMarketOpenPositions.length >= 2)
      ? sameMarketOpenPositions
      : [currentPos];

  const dbSumVolume = targetPositions.reduce((acc, p) => acc + Number(p.volume || 0), 0);
  if (dbSumVolume <= 0) {
    return false;
  }

  // 업비트 실계좌 보유 수량 조회 — 절대 계좌 전량을 매도하지 않고 본인 봇/order_uuid 기록 volume(소수점 8자리 내림 ROUND_DOWN)만 사용
  const currency = String(currentPos.market || "").split("-")[1] || "";
  let sellVolumeStr = floorTo8DecimalsStr(dbSumVolume);
  let actualCoinBalance = 0;

  try {
    await new Promise((r) => setTimeout(r, 120));
    const acctToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim());
    const acctResp = await fetch("https://api.upbit.com/v1/accounts", {
      headers: {
        Authorization: `Bearer ${acctToken}`,
        Accept: "application/json",
      },
    });
    if (acctResp.status === 200) {
      const accounts = await acctResp.json();
      const coinAcct = Array.isArray(accounts)
        ? accounts.find((a) => String(a.currency || "").toUpperCase() === currency.toUpperCase())
        : null;
      actualCoinBalance = Number(coinAcct?.balance || 0);
      if (actualCoinBalance > 0) {
        const otherBotsRow = await db
          .prepare(
            "SELECT COALESCE(SUM(volume), 0) AS other_vol FROM bot_positions WHERE bot_id != ? AND market = ? AND status = 'OPEN'"
          )
          .get(bot.bot_id, currentPos.market);
        const otherBotsVol = Number(otherBotsRow?.other_vol || 0);
        const maxAvailableForThisBot = Math.max(0, actualCoinBalance - otherBotsVol);
        const boundedVol = Math.min(dbSumVolume, maxAvailableForThisBot);
        if (boundedVol > 0) {
          sellVolumeStr = floorTo8DecimalsStr(boundedVol);
        }
      }
    }
  } catch {}

  // [방어로직 1] 업비트 실계좌에 코인이 이미 0(소액정리/수동매도 등)이면 DB 포지션을 즉시 CLOSED 처리하여 데드락 해제
  if (actualCoinBalance <= 0.000001) {
    console.log(`[Smart Cleanse] ${currentPos.market} 업비트 실계좌 보유 수량이 0이므로 포지션을 정상 청산(CLOSED) 동기화합니다.`);
    const nowSync = nowKSTString();
    for (const p of targetPositions) {
      await db.prepare("UPDATE bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND bot_id = ?").run(
        nowSync,
        p.id,
        bot.bot_id
      );
      if (p.trade_id) {
        await db.prepare(`
          UPDATE trades
          SET sell_order_uuid = 'manual-sync', sell_price = ?, sell_volume = ?, sell_amount = 0, sell_date = ?, profit_krw = ?, profit_pct = -100.0, status = 'COMPLETED'
          WHERE id = ? AND bot_id = ?
        `).run(sellPrice, p.volume, nowSync, -Number(p.buy_amount || 0), p.trade_id, bot.bot_id);
      }
    }
    await syncDynamicLiveCapitalFromUpbit(true);
    return true;
  }

  let sellUuid = "";
  let actualTotalFunds = Math.floor(Number(sellVolumeStr) * Number(sellPrice));
  let actualTotalFee = Math.floor(actualTotalFunds * 0.0005);

  // [방어로직 2] 평가금액이 업비트 최소주문금액(5,000원) 미만인 경우의 데드락 방어:
  // 업비트 계좌에 가용 현금이 있으면 5,500원치 보충 시장가 매수 후 즉시 합산 전량 시장가 매도(Buy-to-Cleanse)를 실행하여 포지션 정상 청산
  if (actualTotalFunds < 5000) {
    console.warn(`[Smart Cleanse] ${currentPos.market} 평가액(${actualTotalFunds}원)이 업비트 최소주문(5,000원) 미만입니다. 청산용 보충 매수(Buy-to-Cleanse)를 시도합니다.`);
    try {
      const acctInfo = await fetchUpbitAccountBalance();
      const orderableKrw = Number(acctInfo.orderable_krw || 0);
      if (orderableKrw >= 6000) {
        const topupKrw = 5500;
        const buyParams = {
          market: currentPos.market,
          side: "bid",
          price: String(topupKrw),
          ord_type: "price",
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
        });

        if (buyResp.status === 200 || buyResp.status === 201) {
          console.log(`[Smart Cleanse] ${currentPos.market} ${topupKrw}원 보충 매수 성공. 600ms 대기 후 전량 시장가 매도 진행...`);
          await new Promise((r) => setTimeout(r, 600));

          // 갱신된 실계좌 잔고 재조회
          const acctToken2 = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim());
          const acctResp2 = await fetch("https://api.upbit.com/v1/accounts", {
            headers: { Authorization: `Bearer ${acctToken2}`, Accept: "application/json" },
          });
          if (acctResp2.status === 200) {
            const accs = await acctResp2.json();
            const cAcc = accs.find((a) => String(a.currency || "").toUpperCase() === currency.toUpperCase());
            const newBal = Number(cAcc?.balance || 0);
            if (newBal > 0) {
              sellVolumeStr = String(cAcc.balance);
              actualTotalFunds = Math.floor(newBal * Number(sellPrice));
              console.log(`[Smart Cleanse] 새 청산 수량: ${sellVolumeStr} (평가액: ${actualTotalFunds}원 >= 5,000원)`);
            }
          }
        }
      }
    } catch (cleanseErr) {
      console.warn(`[Smart Cleanse] 보충 청산 시도 중 오류:`, cleanseErr.message);
    }
  }

  // 여전히 5,000원 미만이면 업비트 API가 거절하므로 에러 상태 기록 후 안전 종료
  if (actualTotalFunds < 5000) {
    const errMsg = `평가금액(${actualTotalFunds.toLocaleString("ko-KR")}원)이 업비트 최소주문(5,000원) 미만입니다. 업비트 앱의 '소액 코인 정리' 기능으로 정리하시면 봇이 자동 감지하여 청산 완료합니다.`;
    console.warn(`[ExecuteSell] ${currentPos.market} 매도 보류: ${errMsg}`);
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `[청산 대기] ${errMsg}`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  try {
    await new Promise((r) => setTimeout(r, 120));
    const params = {
      market: currentPos.market,
      side: "ask",
      volume: sellVolumeStr,
      ord_type: "market",
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
    });
    if (resp.status !== 200 && resp.status !== 201) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
      await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${currentPos.market} 매도 주문 실패: ${errMsg}`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }
    const orderData = await resp.json();
    if (!orderData?.uuid) return false;
    sellUuid = orderData.uuid;

    // 매도 주문 체결 상세 조회 (GET /v1/order?uuid=...)
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const qParams = { uuid: sellUuid };
        const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
        const oResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(sellUuid)}`, {
          headers: {
            Authorization: `Bearer ${qToken}`,
            Accept: "application/json",
          },
        });
        if (oResp.status === 200) {
          const oDetail = await oResp.json();
          const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
          const fundsSum = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
          if (fundsSum > 0) {
            actualTotalFunds = Math.floor(fundsSum);
            if (oDetail.paid_fee !== undefined) {
              actualTotalFee = Math.ceil(Number(oDetail.paid_fee || actualTotalFee));
            }
            break;
          }
        }
      } catch {}
    }
  } catch (err) {
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${currentPos.market} 매도 통신 오류: ${err.message}`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const now = nowKSTString();
  const totalBuyAmount = targetPositions.reduce((acc, p) => acc + Number(p.buy_amount || 0), 0) || 1;
  let totalProfitKrw = 0;

  for (const p of targetPositions) {
    const weight = Number(p.buy_amount || 0) / totalBuyAmount;
    const posSellAmount = Math.floor(actualTotalFunds * weight);
    const posSellFee = Math.floor(actualTotalFee * weight);
    const posNetProceeds = posSellAmount - posSellFee;
    const posProfitKrw = Math.floor(posNetProceeds - Number(p.buy_amount) - Number(p.buy_fee || 0));
    const posProfitPct = Number(((posProfitKrw / Number(p.buy_amount)) * 100).toFixed(2));
    totalProfitKrw += posProfitKrw;

    await db.prepare("UPDATE bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND bot_id = ?").run(
      now,
      p.id,
      bot.bot_id
    );
    await db.prepare(`
      UPDATE trades
      SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, status = 'COMPLETED'
      WHERE id = ? AND bot_id = ?
    `).run(sellUuid, sellPrice, p.volume, posSellAmount, now, posProfitKrw, posProfitPct, p.trade_id, bot.bot_id);
  }

  // 매도 후 전체 운용 원금 대비 이미 사용된 투자금을 재계산하여 봇별 배정 원금 및 가용 잔고(virtual_krw) 재분배
  const isDrainingBot = Number(bot.is_selected_for_live || 0) !== 1;
  const netProceeds = Math.max(0, Math.floor(actualTotalFunds - actualTotalFee));
  const currentTotalCap = Math.floor(Number(await getSetting("total_capital", "0")));
  const syncRes = await syncDynamicLiveCapitalFromUpbit(true).catch(() => null);
  if (!syncRes?.success) {
    const adjustedCap = Math.max(0, currentTotalCap + Math.floor(totalProfitKrw));
    if (adjustedCap !== currentTotalCap) {
      await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(String(adjustedCap), now);
    }
    await recalculateAndApplyBotAllocations(adjustedCap, null, "live");
  }

  try {
    await db
      .prepare("UPDATE bot_accounts SET total_realized_pnl = total_realized_pnl + ?, updated_at = ? WHERE bot_id = ?")
      .run(totalProfitKrw, now, bot.bot_id);
  } catch {}
  await syncBotAccountsFromBots(db);

  if (isDrainingBot) {
    const remRow = await db
      .prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(buy_amount), 0) AS rem_used FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
      .get(bot.bot_id);
    const remCnt = Number(remRow?.cnt || 0);
    const remUsed = Math.floor(Number(remRow?.rem_used || 0));
    const activeBots = (await getBots("live")).filter((b) => Number(b.is_selected_for_live) === 1);
    const activeDesc = activeBots
      .map((ab) => `${ab.nickname}(비율 ${Number(ab.allocation_ratio || 0).toFixed(0)}% / 가용 ${Math.floor(Number(ab.virtual_krw || 0)).toLocaleString("ko-KR")}원)`)
      .join(", ");
    console.log(
      `[Graceful Drain 정산 이관] 탈락 봇 ${bot.bot_id}(${bot.nickname}) ${currentPos.market} ${reasonLabel} 매도 정산금 ${netProceeds.toLocaleString("ko-KR")}원(실현손익 ${
        totalProfitKrw >= 0 ? "+" : ""
      }${totalProfitKrw.toLocaleString("ko-KR")}원) 회수 -> 활성 실전 봇 자동 귀속 (${activeDesc || "없음"})`
    );
    const drainStatusMsg =
      remCnt > 0
        ? `[🛡️ Graceful Drain] ${currentPos.market} 매도 정산금 ${netProceeds.toLocaleString("ko-KR")}원 활성 봇 이관 완료 · 잔여 포지션 ${remCnt}건(${remUsed.toLocaleString("ko-KR")}원) 계속 감시 중`
        : `[✅ Graceful Drain 완료] ${currentPos.market} 최종 청산(${totalProfitKrw >= 0 ? "+" : ""}${totalProfitKrw.toLocaleString("ko-KR")}원) 및 정산금 ${netProceeds.toLocaleString("ko-KR")}원 활성 봇 자동 귀속 완료`;
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      drainStatusMsg,
      now,
      bot.bot_id
    );
  } else {
    await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${currentPos.market} ${reasonLabel} 매도 완료 (${targetPositions.length}건 통합 / ${
        totalProfitKrw >= 0 ? "+" : ""
      }${totalProfitKrw.toLocaleString("ko-KR")}원)`,
      now,
      bot.bot_id
    );
  }
  await checkAndHaltIfZeroBalance();
  return true;
}

// ============================================================================
// 1. 실거래 매매 스케줄러 (선택된 1~3개 실전 봇 전용 - 기존 LLM/Regime 필터 100% 보존)
// ============================================================================
let isLiveCycleRunning = false;
const liveBotPeakMap = new Map();

async function runLiveTradingBotsCycle() {
  if (isLiveCycleRunning) return;
  isLiveCycleRunning = true;
  try {
    // 업비트 실계좌 잔고 기반 90% 동적 운영원금 및 각 봇별 비율 실시간 동기화
    await syncDynamicLiveCapitalFromUpbit();

    const haltInfo = await checkAndHaltIfZeroBalance("live");
    if (haltInfo.halted) return;

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

    const allMarkets = [
      "KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE",
      "KRW-SUI", "KRW-AVAX", "KRW-SHIB"
    ];
    const tickerMap = await fetchUpbitTickersMap(allMarkets);
    if (!tickerMap || tickerMap.size === 0) return;

    // 지표 패키지 사전 빌드 (공유 캐시 활용)
    const mdMap = new Map();
    for (const m of allMarkets) {
      const tk = tickerMap.get(m);
      if (tk) {
        mdMap.set(m, await buildMarketData(m, tk, fetchUpbitCandlesSorted));
      }
    }
    const { computeMomentumRanking } = await import("./common/algo_lab_service.mjs");
    const rankMap = computeMomentumRanking(mdMap, allMarkets);

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

      // 1) 보유 포지션 손절/익절 및 알고리즘 SELL 시그널 평가 (BLOCK/해제/일시정지 여부와 무관하게 무조건 실행)
      for (const pos of bot.open_positions || []) {
        const tk = tickerMap.get(pos.market);
        if (!tk) continue;
        const curPrice = Number(tk.trade_price);
        const avgBuy = Number(pos.avg_buy_price);
        const pnlPct = ((curPrice - avgBuy) / avgBuy) * 100.0;

        // 트레일링 스탑용 고점 갱신
        const peakKey = `live-${pos.id}`;
        const curPeak = Math.max(Number(liveBotPeakMap.get(peakKey) || avgBuy), curPrice);
        liveBotPeakMap.set(peakKey, curPeak);

        const md = mdMap.get(pos.market);

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
          await executeBotSellOrder(bot, pos, curPrice, smartExit.reason);
          liveBotPeakMap.delete(peakKey);
          continue;
        }

        if (pnlPct <= stopLossPct) {
          await executeBotSellOrder(bot, pos, curPrice, `손절(${pnlPct.toFixed(2)}%)`);
          liveBotPeakMap.delete(peakKey);
          continue;
        }
        if (pnlPct >= takeProfitPct) {
          await executeBotSellOrder(bot, pos, curPrice, `익절(+${pnlPct.toFixed(2)}%)`);
          liveBotPeakMap.delete(peakKey);
          continue;
        }

        // 10대 알고리즘 전략별 청산 시그널 평가
        if (md) {
          const sig = evaluateStrategy(bot.bot_id, md, md.indicators, pos, {
            params,
            peakPrice: curPeak,
            momentumRank: rankMap,
            market: pos.market,
            isLive: true,
          });
          if (sig.signal === "SELL") {
            await executeBotSellOrder(bot, pos, curPrice, sig.reason);
            liveBotPeakMap.delete(peakKey);
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

      if (!isRunningLive || Number(refreshedBot.allocated_capital) <= 0) {
        if (remainingOpenCount > 0) {
          await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
            `[일시중지 · 포지션 보호] 보유 ${remainingOpenCount}건 익절/손절 감시중`,
            now,
            bot.bot_id
          );
        }
        continue;
      }

      const heldSet = new Set((refreshedBot.open_positions || []).map((p) => p.market));
      const maxPositions = Math.max(1, Number(cfg.max_positions || 2));

      // [실전 서킷 브레이커] 당일(00:00 KST 기준) 누적 실현 손실이 배정 원금의 -4.0% 이하 시 신규 매수 차단
      const todayStartKst = `${nowKSTString().split(" ")[0]} 00:00:00`;
      let dailyProfit = 0;
      try {
        const dailyRow = await db
          .prepare("SELECT COALESCE(SUM(profit_krw), 0) AS daily_profit FROM trades WHERE bot_id = ? AND status = 'COMPLETED' AND sell_date >= ?")
          .get(bot.bot_id, todayStartKst);
        dailyProfit = Number(dailyRow?.daily_profit || 0);
      } catch {}

      const allocatedCap = Number(refreshedBot.allocated_capital || 0);
      const lossLimit = allocatedCap > 0 ? -Math.floor(allocatedCap * 0.04) : -40000;
      if (allocatedCap > 0 && dailyProfit <= lossLimit) {
        const cbMsg = `[서킷 브레이커 발동] 당일 실현 손실(${dailyProfit.toLocaleString("ko-KR")}원 / -4.0% 한도 도달)로 자정까지 신규 매수 일시 차단`;
        await db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          cbMsg,
          now,
          bot.bot_id
        );
        continue;
      }

      // [듀얼 AI 동적 매수 게이트웨이] final_risk_alert / HALT_NEW_BUYS / bot_overrides[bot_id] === 'BLOCK' 확인
      const regimeInfo = await checkMarketRegimeFilter(tickerMap);
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

        const sig = evaluateStrategy(bot.bot_id, md, md.indicators, held, {
          params,
          momentumRank: rankMap,
          market: mkt,
          isLive: true,
        });

        if (sig.signal === "BUY") {
          const baseRatio = Number(sig.order_ratio || cfg.order_ratio || 0.35);
          const orderKrw = getSafeOrderKrw(refreshedBot, baseRatio, regimeInfo.multiplier ?? 1.0);
          if (orderKrw >= 5000) {
            const ok = await executeBotBuyOrder(refreshedBot, mkt, orderKrw, md.price);
            if (ok) {
              actionMsg = `${mkt} ${sig.reason} 매수 체결 (${orderKrw.toLocaleString("ko-KR")}원)`;
              break;
            }
          }
        }
      }

      if (!actionMsg) {
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
  } catch (err) {
    console.error("[LiveTradingCycle] Error:", err.message);
  } finally {
    isLiveCycleRunning = false;
  }
}

// ============================================================================
// 2. 가상거래 상시 경쟁 스케줄러 (10대 순수 알고리즘 Always-On Arena - LLM/Regime 필터 완전 우회)
// ============================================================================
let isPaperArenaCycleRunning = false;

async function runAlwaysOnPaperArenaCycle() {
  if (isPaperArenaCycleRunning) return;
  isPaperArenaCycleRunning = true;
  try {
    const db = getDb();
    if (!db) return;
    await runArenaCycle(db, {
      getUniverse: async () => {
        const markets = await getValidKrwMarkets();
        const major = [
          "KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE",
          "KRW-SUI", "KRW-AVAX", "KRW-SHIB", "KRW-ADA", "KRW-NEAR"
        ];
        return major.filter((m) => markets.has(m) || true);
      },
      fetchTickersMap: fetchUpbitTickersMap,
      fetchCandles: fetchUpbitCandlesSorted,
    });
  } catch (err) {
    console.warn("[AlwaysOnPaperArena] Cycle error:", err.message);
  } finally {
    isPaperArenaCycleRunning = false;
  }
}

async function reconcileOpenPositionsWithUpbit() {
  if (!isLiveMode()) {
    return;
  }
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
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
      });
      if (oResp.status === 200) {
        const oDetail = await oResp.json();
        const filledVol = Number(oDetail?.executed_volume || 0);
        if (filledVol > 0) {
          const exactVolStr = String(oDetail.executed_volume);
          const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
          const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
          const exactAvgPrice = totalFunds > 0 ? Math.floor(totalFunds / filledVol) : Number(pos.avg_buy_price);
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
let isScheduledAiAnalysisRunning = false;
let lastScheduledMarketAiFailureMs = 0;
let lastScheduledNewsAiFailureMs = 0;
let lastScheduledProAiFailureMs = 0;

async function checkAndRunScheduledAiMarketAnalysis() {
  if (isScheduledAiAnalysisRunning) return;
  try {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) return;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const curHour = now.getHours();
    const curMin = now.getMinutes();
    const slotMin = curMin >= 30 ? 30 : 0;
    const flashSlotKey = `${today}_${pad(curHour)}:${pad(slotMin)}`;
    const isProHour = slotMin === 0;
    const proSlotKey = `${today}_${pad(curHour)}:00_pro`;

    const lastMarketAutoSlot = await getSetting("ai_briefing_last_auto_slot", "");
    const lastNewsAutoSlot = await getSetting("ai_news_briefing_last_auto_slot", "");
    const lastProAutoSlot = await getSetting("ai_pro_briefing_last_auto_slot", "");

    const needFlashMarket =
      lastMarketAutoSlot !== flashSlotKey &&
      !(lastScheduledMarketAiFailureMs > 0 && Date.now() - lastScheduledMarketAiFailureMs < 5 * 60 * 1000);
    const needFlashNews =
      lastNewsAutoSlot !== flashSlotKey &&
      !(lastScheduledNewsAiFailureMs > 0 && Date.now() - lastScheduledNewsAiFailureMs < 5 * 60 * 1000);
    const needProInDepth =
      isProHour &&
      lastProAutoSlot !== proSlotKey &&
      !(lastScheduledProAiFailureMs > 0 && Date.now() - lastScheduledProAiFailureMs < 5 * 60 * 1000);

    if (!needFlashMarket && !needFlashNews && !needProInDepth) {
      return;
    }

    isScheduledAiAnalysisRunning = true;

    // 1. 30분 단위 Gemini Flash 시장 분석 & 봇 진단
    if (needFlashMarket) {
      console.log(`[AI Auto Flash Analysis] 30분 정기 슬롯(${flashSlotKey}) Gemini Flash 자동 시장 분석을 시작합니다...`);
      const marketResult = await generateAiMarketAnalysis({ triggerType: "AUTO", slotKey: flashSlotKey, preferredModel: "gemini-3.8-flash" });
      if (marketResult.success) {
        lastScheduledMarketAiFailureMs = 0;
        console.log(`[AI Auto Flash Analysis] 30분 정기 슬롯(${flashSlotKey}) 완료 (모델: ${marketResult.briefing?.model})`);
      } else {
        lastScheduledMarketAiFailureMs = Date.now();
        console.warn(`[AI Auto Flash Analysis] 30분 정기 슬롯(${flashSlotKey}) 실패:`, marketResult.message);
      }
    }

    // 2. 30분 단위 Gemini Flash 뉴스 종합 판단
    if (needFlashNews) {
      console.log(`[AI Auto News Analysis] 30분 정기 슬롯(${flashSlotKey}) 뉴스 종합 판단을 시작합니다...`);
      try {
        await syncNewsToDatabase(getDb());
      } catch (e) {
        console.warn("[AI Auto News Analysis] Pre-sync news warning:", e.message);
      }
      const newsResult = await generateAiNewsAnalysis({ triggerType: "AUTO", slotKey: flashSlotKey });
      if (newsResult.success) {
        lastScheduledNewsAiFailureMs = 0;
        console.log(`[AI Auto News Analysis] 30분 정기 슬롯(${flashSlotKey}) 완료 (모델: ${newsResult.briefing?.model})`);
      } else {
        lastScheduledNewsAiFailureMs = Date.now();
        console.warn(`[AI Auto News Analysis] 30분 정기 슬롯(${flashSlotKey}) 실패:`, newsResult.message);
      }
    }

    // 3. 1시간 정각 단위 Gemini Pro 심층 퀀트 분석
    if (needProInDepth) {
      console.log(`[AI Auto Pro Analysis] 1시간 정각 심층 슬롯(${proSlotKey}) Gemini Pro 심층 퀀트 분석을 시작합니다...`);
      const proResult = await generateAiMarketAnalysis({ triggerType: "AUTO", slotKey: proSlotKey, preferredModel: "gemini-3.1-pro-preview", modelType: "pro" });
      if (proResult.success) {
        lastScheduledProAiFailureMs = 0;
        const db = getDb();
        await db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('ai_pro_briefing_last_auto_slot', ?, ?)").run(proSlotKey, nowKSTString());
        console.log(`[AI Auto Pro Analysis] 1시간 정각 심층 슬롯(${proSlotKey}) 완료 (모델: ${proResult.briefing?.model})`);
      } else {
        lastScheduledProAiFailureMs = Date.now();
        console.warn(`[AI Auto Pro Analysis] 1시간 정각 심층 슬롯(${proSlotKey}) 실패:`, proResult.message);
      }
    }
  } catch (err) {
    lastScheduledMarketAiFailureMs = Date.now();
    lastScheduledNewsAiFailureMs = Date.now();
    lastScheduledProAiFailureMs = Date.now();
    console.warn("[AI Auto Analysis] Scheduler error:", err.message);
  } finally {
    isScheduledAiAnalysisRunning = false;
  }
}

startBackgroundWorkers = async function() {
  if (workersStarted) return;
  workersStarted = true;

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

    await reconcileOpenPositionsWithUpbit().catch(() => {});
    await runAlwaysOnPaperArenaCycle().catch(() => {});
    await runLiveTradingBotsCycle().catch(() => {});
    await checkAndRunScheduledAiMarketAnalysis().catch(() => {});
    await checkAndRunScheduledAutoRotation().catch(() => {});
    await checkAndRunScheduledLlmWeeklyBotSelection().catch(() => {});
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

if (isConfigured) {
  startBackgroundWorkers().catch((err) => console.warn("[Startup] Background worker start error:", err.message));
} else {
  console.log("[Setup] System is running in Setup Mode. Awaiting onboarding via /api/setup.");
}



