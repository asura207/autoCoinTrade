import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLogRotationScheduler } from "../backend/common/log_rotator.mjs";

const CURRENT_DIR = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, "..");
const DIST_DIR = path.resolve(CURRENT_DIR, "dist");

/**
 * 루트 .env 파일의 환경변수를 process.env에 덮어쓰지 않고 보조로 파싱한다.
 */
function loadRootEnv() {
  const envMap = {};
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (!fs.existsSync(envPath)) return envMap;
  try {
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      envMap[key] = val;
    }
  } catch {}
  return envMap;
}

const fileEnv = loadRootEnv();
const FRONTEND_HOST = process.env.FRONTEND_HOST || fileEnv.FRONTEND_HOST || "127.0.0.1";
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || fileEnv.FRONTEND_PORT || fileEnv.VITE_PORT || 9000);
const BACKEND_URL = process.env.BACKEND_URL || fileEnv.BACKEND_URL || "http://127.0.0.1:8001";
const BACKEND_TARGET = new URL(BACKEND_URL);

if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
  console.error("[Frontend Server] ERROR: frontend/dist/index.html 이 없습니다. 'npm run build'를 먼저 실행하세요.");
  process.exit(1);
}
const REAL_DIST_DIR = fs.realpathSync(DIST_DIR);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const BLOCKED_PATH_PREFIXES = ["/@id", "/@fs", "/@vite", "/__vite", "/node_modules", "/src/"];

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
}

function sendText(res, status, text) {
  if (res.headersSent) return;
  setSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/**
 * /api/* 요청을 백엔드 서버로 스트리밍(SSE 포함) 프록시 전달한다.
 */
function isLoopbackRemote(addr) {
  const s = String(addr || "");
  return s === "127.0.0.1" || s === "::1" || s === "::ffff:127.0.0.1";
}

function proxyApiRequest(req, res) {
  const client = BACKEND_TARGET.protocol === "https:" ? https : http;
  const headers = { ...req.headers };
  const originalHost = req.headers.host || "";
  headers.host = BACKEND_TARGET.host;
  const remoteIp = req.socket?.remoteAddress || "127.0.0.1";
  const trustedHop = isLoopbackRemote(remoteIp);
  if (originalHost) {
    headers["x-forwarded-host"] =
      trustedHop && req.headers["x-forwarded-host"] ? String(req.headers["x-forwarded-host"]) : originalHost;
  }
  headers["x-forwarded-for"] = trustedHop
    ? String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || remoteIp)
    : remoteIp;
  headers["x-forwarded-proto"] =
    trustedHop && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]) : "http";

  const proxyReq = client.request(
    {
      protocol: BACKEND_TARGET.protocol,
      hostname: BACKEND_TARGET.hostname,
      port: BACKEND_TARGET.port || (BACKEND_TARGET.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      setSecurityHeaders(res);
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      setSecurityHeaders(res);
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, detail: "백엔드 API 서버에 연결할 수 없습니다." }));
    } else {
      res.destroy();
    }
  });

  req.on("aborted", () => {
    proxyReq.destroy();
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });

  req.pipe(proxyReq);
}

function isUnsafeDecodedPath(decodedPath) {
  if (!decodedPath || decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return true;
  }
  const lower = decodedPath.toLowerCase();
  if (BLOCKED_PATH_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix))) {
    return true;
  }
  const segments = decodedPath.split("/").filter(Boolean);
  return segments.some((seg) => seg === "." || seg === ".." || seg.startsWith("."));
}

function serveFile(req, res, filePath, isAsset) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const cacheControl =
    filePath.endsWith(`${path.sep}index.html`)
      ? "no-cache, no-store, must-revalidate"
      : isAsset
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300";

  setSecurityHeaders(res);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendText(res, 500, "Internal Server Error");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function handleStaticRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method Not Allowed");
  }

  let parsed;
  try {
    parsed = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return sendText(res, 400, "Bad Request");
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return sendText(res, 400, "Bad Request");
  }

  if (isUnsafeDecodedPath(decodedPath)) {
    return sendText(res, 404, "Not Found");
  }

  const relPath = decodedPath.replace(/^\/+/, "");
  const candidate = relPath ? path.resolve(DIST_DIR, relPath) : path.join(DIST_DIR, "index.html");
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + path.sep)) {
    return sendText(res, 404, "Not Found");
  }

  if (fs.existsSync(candidate)) {
    try {
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate !== REAL_DIST_DIR && !realCandidate.startsWith(REAL_DIST_DIR + path.sep)) {
        return sendText(res, 404, "Not Found");
      }
      const stat = fs.statSync(realCandidate);
      if (stat.isFile()) {
        const isAsset = decodedPath.startsWith("/assets/");
        return serveFile(req, res, realCandidate, isAsset);
      }
      if (stat.isDirectory()) {
        const idx = path.join(realCandidate, "index.html");
        if (fs.existsSync(idx) && fs.realpathSync(idx).startsWith(REAL_DIST_DIR + path.sep)) {
          return serveFile(req, res, idx, false);
        }
      }
    } catch {
      return sendText(res, 404, "Not Found");
    }
  }

  // 알 수 없는 확장자(.env, .php, .json 등)는 SPA 폴백하지 않고 즉시 404 차단
  if (path.extname(decodedPath)) {
    return sendText(res, 404, "Not Found");
  }

  const spaIndex = path.join(REAL_DIST_DIR, "index.html");
  return serveFile(req, res, spaIndex, false);
}

const server = http.createServer((req, res) => {
  let reqPathname = "/";
  try {
    reqPathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
  } catch {
    return sendText(res, 400, "Bad Request");
  }
  if (reqPathname === "/api" || reqPathname.startsWith("/api/")) {
    return proxyApiRequest(req, res);
  }
  return handleStaticRequest(req, res);
});

let logRotationHandle = null;

server.listen(FRONTEND_PORT, FRONTEND_HOST, () => {
  console.log(`[AutoCoinTrade] Hardened Static Frontend Server listening on http://${FRONTEND_HOST}:${FRONTEND_PORT} -> API proxy ${BACKEND_URL}`);
  logRotationHandle = startLogRotationScheduler({
    logsDir: path.join(PROJECT_ROOT, "logs"),
    retentionDays: process.env.LOG_RETENTION_DAYS || fileEnv.LOG_RETENTION_DAYS,
    loggerPrefix: "[Frontend LogRotator]",
  });
});

function shutdown(signal) {
  console.log(`[Frontend Server] Received ${signal}, shutting down cleanly...`);
  if (logRotationHandle) {
    logRotationHandle.stop();
    logRotationHandle = null;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
