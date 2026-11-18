import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-ollama-test-"));
const TEST_DB_PATH = path.join(TMP_DIR, "test_ollama.db");
const TEST_CONFIG_PATH = path.join(TMP_DIR, "upbit_config.json");
const TEST_ENV_PATH = path.join(TMP_DIR, ".env");

fs.writeFileSync(
  TEST_CONFIG_PATH,
  JSON.stringify(
    {
      trade_mode: "paper",
      request_timeout_sec: 5.0,
      delay_threshold_ms: 800,
      gemini_api_key: "",
      use_local_ollama_news: true,
      ollama_base_url: "http://127.0.0.1:19999",
      ollama_news_model: "qwen3-news",
      ollama_timeout_ms: 25000,
      setup_completed: true,
    },
    null,
    2
  ),
  "utf-8"
);
fs.writeFileSync(TEST_ENV_PATH, "DB_MODE=sqlite\nPG_SYNC_ENABLED=false\n", "utf-8");

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_DB_PATH = TEST_DB_PATH;
process.env.AUTOCOIN_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.AUTOCOIN_ENV_PATH = TEST_ENV_PATH;
process.env.DB_MODE = "sqlite";
process.env.PG_SYNC_ENABLED = "false";

function startMockOllamaServer({ failMode = "none", customReply = null } = {}) {
  const capturedChatRequests = [];
  const capturedTagRequests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString("utf-8")));
    req.on("end", () => {
      if (req.url === "/api/tags" && req.method === "GET") {
        capturedTagRequests.push({ url: req.url, method: req.method });
        if (failMode === "http500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "mock tags failure" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen3-news:latest" }] }));
        return;
      }

      if (req.url === "/api/chat" && req.method === "POST") {
        const parsedReq = JSON.parse(body || "{}");
        capturedChatRequests.push(parsedReq);

        if (failMode === "http500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ollama internal failure" }));
          return;
        }
        if (failMode === "bad_json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: { role: "assistant", content: "not valid json {{" } }));
          return;
        }

        const defaultDecision = customReply || {
          sentiment_score: -0.2,
          market_regime: "SIDEWAYS",
          risk_alert: false,
          recommended_action: "REDUCE_SIZE",
          position_size_multiplier: 0.5,
          bot_overrides: {
            bot_01: "BLOCK",
            bot_02: "BLOCK",
            bot_03: "BLOCK",
            bot_04: "ALLOW",
            bot_05: "ALLOW",
            bot_06: "ALLOW",
            bot_07: "BLOCK",
            bot_08: "ALLOW",
            bot_09: "BLOCK",
            bot_10: "ALLOW",
          },
          blacklist_tickers: ["xrp", "KRW-SOL"],
          reason: "단기 횡보 및 XRP 개별 변동성 확대로 돌파형 봇 보류 및 역추세 봇 50% 운용.",
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: parsedReq.model || "qwen3-news",
            done: true,
            message: {
              role: "assistant",
              content: JSON.stringify(defaultDecision),
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        capturedChatRequests,
        capturedTagRequests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function runPythonCheck(ollamaUrl, dbPath) {
  const pyBin = fs.existsSync(path.join(ROOT_DIR, ".venv", "bin", "python"))
    ? path.join(ROOT_DIR, ".venv", "bin", "python")
    : "python3";

  const script = `
import json
import os
import sys

sys.path.insert(0, ${JSON.stringify(ROOT_DIR)})
os.environ["AUTOCOIN_LIBRARY_MODE"] = "1"
os.environ["AUTOCOIN_ENV_PATH"] = ${JSON.stringify(TEST_ENV_PATH)}
os.environ["AUTOCOIN_CONFIG_PATH"] = ${JSON.stringify(TEST_CONFIG_PATH)}
os.environ["USE_LOCAL_OLLAMA_NEWS"] = "true"
os.environ["OLLAMA_BASE_URL"] = ${JSON.stringify(ollamaUrl)}
os.environ["OLLAMA_NEWS_MODEL"] = "qwen3-news"
os.environ["OLLAMA_TIMEOUT_MS"] = "25000"
os.environ["DB_MODE"] = "sqlite"

import llm_filter_worker
from init_db import init_database, get_db_connection
from llm_filter_worker import (
    call_flash_fast_analysis,
    get_gemini_api_key,
    synthesize_dual_decisions,
    update_market_regime_filter_table,
    save_ai_briefings_to_db,
    make_fallback_regime,
)

db_path = ${JSON.stringify(dbPath)}
init_database(db_path)

btc_summary = {
    "current_price": 130000000.0,
    "change_rate_24h": 1.5,
    "change_rate_1h": 0.2,
    "ma20": 128000000.0,
    "disparity_pct": 1.56,
    "is_above_ma20": True,
    "ma60_4h": 127000000.0,
    "disparity_4h_pct": 2.36,
    "is_above_ma60_4h": True,
}
news_items = [
    {"title": "BTC 현물 ETF 순유입 지속", "summary": "기관 자금 유입", "sentiment": "BULLISH", "source": "TokenPost"},
    {"title": "XRP 단기 변동성 확대", "summary": "리플 급락 경계", "sentiment": "BEARISH", "source": "Google News"},
]

flash_res = call_flash_fast_analysis(
    btc_summary=btc_summary,
    news_headlines=news_items,
    open_positions=["KRW-BTC"],
    db_path=db_path,
)
assert flash_res["provider"] == "ollama", f"Expected ollama, got {flash_res.get('provider')}"
assert flash_res["model"] == "qwen3-news", f"Expected qwen3-news, got {flash_res.get('model')}"
assert "KRW-XRP" in flash_res["blacklist_tickers"], f"Expected KRW-XRP normalization, got {flash_res['blacklist_tickers']}"
assert "KRW-SOL" in flash_res["blacklist_tickers"], f"Expected KRW-SOL, got {flash_res['blacklist_tickers']}"

pro_res = make_fallback_regime(btc_summary, "Pro Baseline")
synth = synthesize_dual_decisions(flash_res, pro_res)
update_market_regime_filter_table(synth, db_path=db_path)
save_ai_briefings_to_db(flash_res, pro_res, synth, btc_summary, news_items, db_path=db_path)

conn = get_db_connection(db_path)
mb = dict(conn.execute("SELECT * FROM ai_market_briefings ORDER BY id DESC LIMIT 1;").fetchone())
nb = dict(conn.execute("SELECT * FROM ai_news_briefings ORDER BY id DESC LIMIT 1;").fetchone())
rf = dict(conn.execute("SELECT * FROM market_regime_filter WHERE id = 1;").fetchone())
conn.close()

assert mb["provider"] == "ollama" and mb["model"] == "qwen3-news"
assert nb["provider"] == "ollama" and nb["model"] == "qwen3-news"
assert rf["flash_recommended_action"] == "REDUCE_SIZE"
assert "KRW-XRP" in json.loads(rf["blacklist_tickers_json"])

# Test Tier 2 Gemini Flash fallback when Ollama unreachable (mocked Gemini call)
os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:19999"
os.environ["GEMINI_API_KEY"] = "mock-gemini-key-for-py-tier2"
os.environ["OPENAI_API_KEY"] = ""
orig_call_gemini = llm_filter_worker._call_gemini_api_with_model
try:
    def _mock_gemini_call(system_prompt, user_prompt, candidate_models, api_key, max_retries=4):
        return (
            json.dumps({
                "sentiment_score": 0.1,
                "market_regime": "SIDEWAYS",
                "risk_alert": False,
                "recommended_action": "NORMAL",
                "position_size_multiplier": 1.0,
                "bot_overrides": {"bot_01": "BLOCK", "bot_05": "ALLOW"},
                "blacklist_tickers": ["doge"],
                "reason": "Python Tier 2 Gemini Flash fallback verification",
            }),
            "gemini-2.5-flash",
        )
    llm_filter_worker._call_gemini_api_with_model = _mock_gemini_call
    py_tier2 = call_flash_fast_analysis(btc_summary, news_items, [], db_path=db_path)
    assert py_tier2["provider"] == "gemini", f"Expected gemini, got {py_tier2.get('provider')}"
    assert py_tier2["model"] == "gemini-2.5-flash"
    assert "KRW-DOGE" in py_tier2["blacklist_tickers"]
finally:
    llm_filter_worker._call_gemini_api_with_model = orig_call_gemini

# Test Tier 3 fallback when Ollama unreachable and no Gemini key
os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:19999"
os.environ["GEMINI_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""
assert get_gemini_api_key(db_path=db_path) == "", "Expected empty Gemini key in isolated test env"
btc_below = {
    "current_price": 120000000.0,
    "ma20": 128000000.0,
    "disparity_pct": -6.25,
    "is_above_ma20": False,
    "ma60_4h": 125000000.0,
    "disparity_4h_pct": -4.0,
    "is_above_ma60_4h": False,
}
fb = call_flash_fast_analysis(btc_below, news_items, [], db_path=db_path)
assert fb["provider"] == "fallback", f"Expected fallback, got {fb.get('provider')}"
assert fb["position_size_multiplier"] == 0.5
assert fb["bot_overrides"]["bot_01"] == "BLOCK"
assert fb["bot_overrides"]["bot_05"] == "ALLOW"
print("PYTHON_OLLAMA_OK")
`;

  await new Promise((resolve, reject) => {
    const child = spawn(pyBin, ["-c", script], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        AUTOCOIN_LIBRARY_MODE: "1",
        AUTOCOIN_ENV_PATH: TEST_ENV_PATH,
        AUTOCOIN_CONFIG_PATH: TEST_CONFIG_PATH,
        DB_MODE: "sqlite",
        PG_SYNC_ENABLED: "false",
        GEMINI_API_KEY: "",
        OPENAI_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code === 0 && out.includes("PYTHON_OLLAMA_OK")) {
        resolve();
      } else {
        reject(new Error(`Python check failed (code=${code}):\nSTDOUT:\n${out}\nSTDERR:\n${err}`));
      }
    });
  });
}

async function waitForServerReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (resp.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for node_server on port ${port}`);
}

async function runHttpE2eCheck(ollamaUrl) {
  const serverDbPath = path.join(TMP_DIR, "http_e2e.db");
  const serverConfigPath = path.join(TMP_DIR, "http_config.json");
  fs.writeFileSync(
    serverConfigPath,
    JSON.stringify(
      {
        trade_mode: "paper",
        request_timeout_sec: 5.0,
        delay_threshold_ms: 800,
        gemini_api_key: "",
        use_local_ollama_news: true,
        ollama_base_url: ollamaUrl,
        ollama_news_model: "qwen3-news",
        ollama_timeout_ms: 25000,
        setup_completed: true,
      },
      null,
      2
    ),
    "utf-8"
  );

  const testPort = 18900 + Math.floor(Math.random() * 500);

  const child = spawn("node", ["backend/node_server.mjs"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      AUTOCOIN_LIBRARY_MODE: "0",
      AUTOCOIN_DB_PATH: serverDbPath,
      AUTOCOIN_CONFIG_PATH: serverConfigPath,
      AUTOCOIN_ENV_PATH: TEST_ENV_PATH,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(testPort),
      DB_MODE: "sqlite",
      PG_SYNC_ENABLED: "false",
      SETUP_COMPLETED: "true",
      GATE_CODE: "stock",
      ENTRY_CODE: "stock",
      USE_LOCAL_OLLAMA_NEWS: "true",
      OLLAMA_BASE_URL: ollamaUrl,
      OLLAMA_NEWS_MODEL: "qwen3-news",
      OLLAMA_TIMEOUT_MS: "25000",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.on("data", (d) => (stderrBuf += d.toString()));

  try {
    await waitForServerReady(testPort);

    // 1. Login to get HttpOnly signed session cookie
    const loginResp = await fetch(`http://127.0.0.1:${testPort}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "stock" }),
    });
    assert.equal(loginResp.status, 200, `Login failed: ${stderrBuf}`);
    const setCookie = loginResp.headers.get("set-cookie") || "";
    const cookieHeader = setCookie.split(";")[0];
    assert.ok(cookieHeader.startsWith("autoCoinTrade_session="), "Expected signed session cookie");

    // 2. GET /api/system/overview, /api/upbit/status, /api/health
    const [overviewResp, statusResp, healthResp] = await Promise.all([
      fetch(`http://127.0.0.1:${testPort}/api/system/overview`, { headers: { Cookie: cookieHeader } }),
      fetch(`http://127.0.0.1:${testPort}/api/upbit/status`, { headers: { Cookie: cookieHeader } }),
      fetch(`http://127.0.0.1:${testPort}/api/health`, { headers: { Cookie: cookieHeader } }),
    ]);
    assert.equal(overviewResp.status, 200);
    assert.equal(statusResp.status, 200);
    assert.equal(healthResp.status, 200);
    const overview = await overviewResp.json();
    const status = await statusResp.json();
    const health = await healthResp.json();

    for (const obj of [overview.ollama, status.ollama, health.ollama]) {
      assert.equal(obj.enabled, true);
      assert.equal(obj.url, ollamaUrl);
      assert.equal(obj.reachable, true);
      assert.equal(obj.model, "qwen3-news");
      assert.equal(typeof obj.latency_ms, "number");
    }

    // 3. SSE Stream Endpoints (/api/ai/stream-analyze and /api/ai/stream-news-analyze)
    const streamMarketResp = await fetch(`http://127.0.0.1:${testPort}/api/ai/stream-analyze`, {
      method: "POST",
      headers: { Cookie: cookieHeader },
    });
    assert.equal(streamMarketResp.status, 200);
    assert.ok((streamMarketResp.headers.get("content-type") || "").includes("text/event-stream"));
    const streamMarketBody = await streamMarketResp.text();
    const marketEvents = streamMarketBody
      .split("\n\n")
      .map((blk) => blk.trim())
      .filter((blk) => blk.startsWith("data:"))
      .map((blk) => JSON.parse(blk.slice(5).trim()));

    assert.ok(marketEvents.some((e) => e.type === "meta" && e.provider === "ollama" && e.model === "qwen3-news"));
    assert.ok(marketEvents.some((e) => e.type === "chunk" && e.text.length > 0));
    assert.ok(marketEvents.some((e) => e.type === "done" && e.provider === "ollama" && e.model === "qwen3-news"));

    const streamNewsResp = await fetch(`http://127.0.0.1:${testPort}/api/ai/stream-news-analyze`, {
      method: "POST",
      headers: { Cookie: cookieHeader },
    });
    assert.equal(streamNewsResp.status, 200);
    const streamNewsBody = await streamNewsResp.text();
    const newsEvents = streamNewsBody
      .split("\n\n")
      .map((blk) => blk.trim())
      .filter((blk) => blk.startsWith("data:"))
      .map((blk) => JSON.parse(blk.slice(5).trim()));

    assert.ok(newsEvents.some((e) => e.type === "meta" && e.provider === "ollama" && e.model === "qwen3-news"));
    assert.ok(newsEvents.some((e) => e.type === "chunk" && e.text.length > 0));
    assert.ok(newsEvents.some((e) => e.type === "done" && e.provider === "ollama" && e.model === "qwen3-news"));

    const overviewAfterResp = await fetch(`http://127.0.0.1:${testPort}/api/system/overview`, { headers: { Cookie: cookieHeader } });
    assert.equal(overviewAfterResp.status, 200);
    const overviewAfter = await overviewAfterResp.json();
    assert.equal(overviewAfter.regime_filter.flash_provider, "ollama");
    assert.equal(overviewAfter.regime_filter.flash_model, "qwen3-news");

    // 4. GET/PUT /api/settings/ollama -> update to unreachable URL & verify health shows reachable: false
    const getSettingsResp = await fetch(`http://127.0.0.1:${testPort}/api/settings/ollama`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(getSettingsResp.status, 200);
    const getSettings = await getSettingsResp.json();
    assert.equal(getSettings.use_local_ollama_news, true);
    assert.equal(getSettings.ollama_news_model, "qwen3-news");

    const putSettingsResp = await fetch(`http://127.0.0.1:${testPort}/api/settings/ollama`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        use_local_ollama_news: true,
        ollama_base_url: "http://127.0.0.1:19999",
        ollama_news_model: "qwen3-news",
        ollama_timeout_ms: 5000,
      }),
    });
    assert.equal(putSettingsResp.status, 200);
    const putSettings = await putSettingsResp.json();
    assert.equal(putSettings.ollama.reachable, false);

    // Restore original mock URL
    await fetch(`http://127.0.0.1:${testPort}/api/settings/ollama`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        use_local_ollama_news: true,
        ollama_base_url: ollamaUrl,
        ollama_news_model: "qwen3-news",
        ollama_timeout_ms: 25000,
      }),
    });
  } finally {
    child.kill("SIGTERM");
  }
}

async function runTests() {
  const reportRows = [];
  const mockOllama = await startMockOllamaServer();

  try {
    process.env.USE_LOCAL_OLLAMA_NEWS = "true";
    process.env.OLLAMA_BASE_URL = mockOllama.url;
    process.env.OLLAMA_NEWS_MODEL = "qwen3-news";
    process.env.OLLAMA_TIMEOUT_MS = "25000";
    process.env.GEMINI_API_KEY = "";

    const { sqliteDb } = await import("../backend/common/sqlite_db.mjs");
    const {
      initializeDatabase,
      callLocalOllamaCoinNewsAnalyzer,
      generateAiMarketAnalysis,
      generateAiNewsAnalysis,
      buildMechanicalFallbackRegime,
    } = await import("../backend/node_server.mjs");

    await initializeDatabase();

    // Seed sample crypto news
    await sqliteDb
      .prepare(
        `INSERT OR IGNORE INTO crypto_news (title, link, source, published_at, summary, sentiment, keywords, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "비트코인 기관 매수세 유입 지속",
        "https://example.com/news-1",
        "TokenPost",
        "2026-11-17 21:00:00",
        "글로벌 자산운용사 현물 ETF 유입이 이어지고 있습니다.",
        "BULLISH",
        "#비트코인 #ETF",
        "2026-11-17 21:05:00"
      );

    // 1. Direct callLocalOllamaCoinNewsAnalyzer payload & schema check
    const directRes = await callLocalOllamaCoinNewsAnalyzer(
      [{ title: "테스트 속보", summary: "단기 횡보 및 XRP 주의", sentiment: "BEARISH" }],
      { btcPrice: 130000000, btcChangePct: 1.2, btcDaily20Ma: 128000000, btc4h60Ma: 127000000, fngValue: 55, fngClass: "Greed", openTickers: ["KRW-BTC"] },
      [{ bot_id: "bot_01", nickname: "돌파봇" }, { bot_id: "bot_05", nickname: "볼린저봇" }]
    );

    assert.equal(mockOllama.capturedChatRequests.length, 1);
    const reqPayload = mockOllama.capturedChatRequests[0];
    assert.equal(reqPayload.model, "qwen3-news");
    assert.equal(reqPayload.stream, false);
    assert.equal(reqPayload.think, false, "Ollama payload MUST set think: false");
    assert.equal(reqPayload.format, "json", "Ollama payload MUST set format: 'json'");

    assert.equal(directRes.provider, "ollama");
    assert.equal(directRes.model, "qwen3-news");
    assert.deepEqual(directRes.blacklist_tickers, ["KRW-SOL", "KRW-XRP"]);
    assert.equal(directRes.bot_overrides.bot_01, "BLOCK");
    assert.equal(directRes.bot_overrides.bot_05, "ALLOW");
    reportRows.push({ suite: "NodeOllamaDirect", check: "think:false, format:json, KRW-* & bot_01~10 norm", status: "PASS" });

    // 2. generateAiMarketAnalysis & generateAiNewsAnalysis -> Tier 1 Ollama DB persistence
    const marketRes = await generateAiMarketAnalysis({
      triggerType: "AUTO",
      slotKey: "2026-11-17_22:30",
      skipUpbitApi: true,
      skipExternalApi: true,
    });
    assert.equal(marketRes.success, true);
    assert.equal(marketRes.provider, "ollama");
    assert.equal(marketRes.briefing.provider, "ollama");
    assert.equal(marketRes.briefing.model, "qwen3-news");
    assert.equal(marketRes.regime_filter.flash_provider, "ollama");
    assert.equal(marketRes.regime_filter.flash_model, "qwen3-news");

    const newsRes = await generateAiNewsAnalysis({
      triggerType: "AUTO",
      slotKey: "2026-11-17_22:30",
      skipUpbitApi: true,
      skipExternalApi: true,
    });
    assert.equal(newsRes.success, true);
    assert.equal(newsRes.provider, "ollama");
    assert.equal(newsRes.briefing.provider, "ollama");
    assert.equal(newsRes.briefing.model, "qwen3-news");
    assert.equal(newsRes.regime_filter.flash_provider, "ollama");
    assert.equal(newsRes.regime_filter.flash_model, "qwen3-news");

    const mbRow = await sqliteDb.prepare("SELECT * FROM ai_market_briefings ORDER BY id DESC LIMIT 1").get();
    const nbRow = await sqliteDb.prepare("SELECT * FROM ai_news_briefings ORDER BY id DESC LIMIT 1").get();
    const rfRow = await sqliteDb.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
    assert.equal(mbRow.provider, "ollama");
    assert.equal(mbRow.model, "qwen3-news");
    assert.equal(nbRow.provider, "ollama");
    assert.equal(nbRow.model, "qwen3-news");
    assert.equal(rfRow.flash_recommended_action, "REDUCE_SIZE");
    assert.deepEqual(JSON.parse(rfRow.blacklist_tickers_json), ["KRW-SOL", "KRW-XRP"]);
    reportRows.push({ suite: "NodeTier1DB", check: "market_regime_filter + ai_market/news_briefings ollama save", status: "PASS" });

    // 3. Tier 1 unreachable -> Tier 2 Gemini Flash Fallback (mocked Gemini fetch)
    const origFetch = globalThis.fetch;
    process.env.GEMINI_API_KEY = "mock-gemini-key-for-tier2-test";
    let geminiMockHits = 0;
    globalThis.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        geminiMockHits += 1;
        if (geminiMockHits === 1) {
          // Simulate 429 on first model to verify backoff/model fallback!
          return new Response(JSON.stringify({ error: { message: "Mock 429" } }), { status: 429 });
        }
        const mockMarkdown = [
          "## ⚡ Gemini Flash Fallback 브리핑",
          "로컬 Ollama 미응답으로 Gemini Flash 백업 엔진이 작동했습니다.",
          "```json",
          JSON.stringify({
            sentiment_score: -0.1,
            market_regime: "SIDEWAYS",
            risk_alert: false,
            recommended_action: "NORMAL",
            position_size_multiplier: 1.0,
            bot_overrides: {
              bot_01: "BLOCK", bot_02: "ALLOW", bot_03: "BLOCK", bot_04: "ALLOW", bot_05: "ALLOW",
              bot_06: "ALLOW", bot_07: "BLOCK", bot_08: "ALLOW", bot_09: "BLOCK", bot_10: "ALLOW",
            },
            blacklist_tickers: ["DOGE"],
            reason: "Gemini Flash Fallback 테스트",
          }),
          "```",
        ].join("\n");
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: mockMarkdown }] } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return origFetch(url, init);
    };
    try {
      const tier2Res = await generateAiMarketAnalysis({
        triggerType: "AUTO",
        slotKey: "2026-11-17_23:00",
        ollamaBaseUrl: "http://127.0.0.1:19999",
        skipUpbitApi: true,
        skipExternalApi: true,
        backoffDelaysMs: [10, 20, 40],
      });
      assert.equal(tier2Res.success, true);
      assert.equal(tier2Res.provider, "gemini");
      assert.equal(tier2Res.fallback_used, true);
      assert.equal(tier2Res.briefing.provider, "gemini");
      assert.equal(tier2Res.regime_filter.flash_provider, "gemini");
      assert.equal(tier2Res.regime_filter.flash_model, tier2Res.briefing.model);
      assert.ok(geminiMockHits >= 2, "Expected Gemini fallback retry across models");
      const rfTier2 = await sqliteDb.prepare("SELECT * FROM market_regime_filter WHERE id = 1").get();
      assert.ok(JSON.parse(rfTier2.blacklist_tickers_json).includes("KRW-DOGE"));
    } finally {
      globalThis.fetch = origFetch;
      process.env.GEMINI_API_KEY = "";
    }
    reportRows.push({ suite: "NodeTier2Fallback", check: "Unreachable Ollama -> Gemini Flash Fallback + 429 retry", status: "PASS" });

    // 4. Both Ollama & Gemini unavailable -> Tier 3 Mechanical Fallback
    const fbMarketRes = await generateAiMarketAnalysis({
      triggerType: "AUTO",
      slotKey: "2026-11-17_23:30",
      ollamaBaseUrl: "http://127.0.0.1:19999",
      skipUpbitApi: true,
      skipExternalApi: true,
      backoffDelaysMs: [10, 20, 40],
    });
    assert.equal(fbMarketRes.success, false);
    assert.equal(fbMarketRes.fallback_tier, "MECHANICAL_20MA");
    assert.ok(fbMarketRes.regime_filter, "Tier 3 mechanical fallback must update market_regime_filter");

    const mechBelow = buildMechanicalFallbackRegime({ btcPrice: 120000000, btcDaily20Ma: 125000000, btc4h60Ma: 124000000 });
    assert.equal(mechBelow.position_size_multiplier, 0.5);
    assert.equal(mechBelow.bot_overrides.bot_01, "BLOCK");
    assert.equal(mechBelow.bot_overrides.bot_05, "ALLOW");

    const mechAbove = buildMechanicalFallbackRegime({ btcPrice: 130000000, btcDaily20Ma: 125000000, btc4h60Ma: 124000000 });
    assert.equal(mechAbove.position_size_multiplier, 1.0);
    assert.equal(mechAbove.bot_overrides.bot_01, "ALLOW");
    assert.equal(mechAbove.bot_overrides.bot_05, "ALLOW");
    reportRows.push({ suite: "NodeTier3Fallback", check: "Both failed -> BTC 20MA/60MA Mechanical Safe Mode", status: "PASS" });

    // 5. Bad JSON from Ollama -> throws cleanly and triggers fallback
    const badOllama = await startMockOllamaServer({ failMode: "bad_json" });
    try {
      await assert.rejects(
        () =>
          callLocalOllamaCoinNewsAnalyzer([], {}, [], {
            baseUrl: badOllama.url,
            model: "qwen3-news",
            timeoutMs: 5000,
          }),
        /SyntaxError|JSON|missing/i
      );
    } finally {
      await badOllama.close();
    }
    reportRows.push({ suite: "NodeBadJson", check: "Malformed Ollama JSON triggers fallback exception", status: "PASS" });

    // 6. Python llm_filter_worker.py check
    const pyDbPath = path.join(TMP_DIR, "python_ollama.db");
    await runPythonCheck(mockOllama.url, pyDbPath);
    reportRows.push({ suite: "PythonWorker", check: "llm_filter_worker.py Ollama Tier 1 + Fallback Tier 3", status: "PASS" });

    // 7. Live HTTP server endpoints + SSE Typewriter stream check
    await runHttpE2eCheck(mockOllama.url);
    reportRows.push({ suite: "HttpSseE2E", check: "/api/system/overview, /api/health, /api/settings/ollama, SSE stream", status: "PASS" });

    await sqliteDb.close();
    console.log("\n=== Ollama (qwen3-news) Integration & 3-Tier Fallback Verification ===");
    console.table(reportRows);
  } finally {
    await mockOllama.close();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

await runTests();
