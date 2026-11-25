/**
 * [Antigravity-Doc]
 * 파일 역할: AutoCoinTrade 프론트엔드의 프로덕션 전용 보안 강화(Hardened) 정적 파일 서빙 및 API 리버스 프록시 서버입니다.
 * 구성 요소:
 *   - 프로젝트 루트 .env 보조 파서 (loadRootEnv)
 *   - 공통 보안 HTTP 응답 헤더 주입 (setSecurityHeaders)
 *   - /api/* 백엔드 리버스 프록시 및 SSE(Server-Sent Events) 실시간 스트리밍 중계 (proxyApiRequest)
 *   - 경로 순회(Path Traversal)·심볼릭 링크·숨김 파일·Vite 내부 경로 차단 및 정적 파일/SPA 폴백 서빙 (handleStaticRequest, serveFile)
 *   - 프론트엔드 로그 순환 스케줄러 연동 및 SIGINT/SIGTERM 우아한 종료(Graceful Shutdown)
 * 수정 시 주의사항:
 *   - 실행 전 반드시 `frontend/dist/index.html` 빌드 산출물이 존재해야 하며, 미존재 시 프로세스가 즉시 종료(exit 1)됩니다.
 *   - SSE 스트리밍 정상 동작을 위해 proxyApiRequest 내부의 `res.flushHeaders()` 및 스트림 파이프 구조를 유지하세요.
 *   - 정적 파일 보안 검사(isUnsafeDecodedPath, REAL_DIST_DIR 접두사 검증)를 완화하면 민감 파일 노출 위험이 생깁니다.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
// [Antigravity-Doc] 백엔드 공통 로그 로테이션 스케줄러(보존 일수 초과 로그 자동 정리)
import { startLogRotationScheduler } from "../backend/common/log_rotator.mjs";

// [Antigravity-Doc] 현재 파일(frontend/server.mjs) 디렉터리, 프로젝트 루트, Vite 빌드 산출물(dist) 절대 경로 상수
const CURRENT_DIR = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, "..");
const DIST_DIR = path.resolve(CURRENT_DIR, "dist");

/**
 * [Antigravity-Doc]
 * 프로젝트 루트의 `.env` 파일을 직접 읽어 key-value 맵으로 반환합니다.
 * - OS/systemd 등에서 이미 주입된 `process.env`를 덮어쓰지 않고 폴백 용도로만 사용합니다.
 * - 빈 줄, `#` 주석 줄, `=` 미포함 줄은 무시하며, 값 양끝의 큰따옴표/작은따옴표를 제거합니다.
 * - 파일이 없거나 읽기 실패 시 빈 객체({})를 반환하여 서버 기동을 방해하지 않습니다.
 */
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

// [Antigravity-Doc] 서버 네트워크 바인딩 및 백엔드 API 프록시 대상 상수 (process.env > 루트 .env > 기본값 순으로 결정)
const fileEnv = loadRootEnv();
// [Antigravity-Doc] 프론트엔드 HTTP 서버 바인딩 호스트 (기본값: 127.0.0.1 로컬 루프백)
const FRONTEND_HOST = process.env.FRONTEND_HOST || fileEnv.FRONTEND_HOST || "127.0.0.1";
// [Antigravity-Doc] 프론트엔드 HTTP 서버 리슨 포트 (기본값: 9000)
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || fileEnv.FRONTEND_PORT || fileEnv.VITE_PORT || 9000);
// [Antigravity-Doc] /api/* 요청을 전달할 백엔드 서버 URL 문자열 및 파싱된 URL 객체 (기본값: http://127.0.0.1:8001)
const BACKEND_URL = process.env.BACKEND_URL || fileEnv.BACKEND_URL || "http://127.0.0.1:8001";
const BACKEND_TARGET = new URL(BACKEND_URL);

// [Antigravity-Doc] 기동 전 필수 빌드 산출물(dist/index.html) 존재 여부 검사 — 미빌드 상태에서의 오작동 방지
if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
  console.error("[Frontend Server] ERROR: frontend/dist/index.html 이 없습니다. 'npm run build'를 먼저 실행하세요.");
  process.exit(1);
}
// [Antigravity-Doc] 심볼릭 링크를 모두 해석한 실제 dist 디렉터리 절대 경로 (심볼릭 링크 탈출 공격 방어 기준 경로)
const REAL_DIST_DIR = fs.realpathSync(DIST_DIR);

// [Antigravity-Doc] 정적 파일 확장자별 HTTP Content-Type(MIME) 매핑 테이블 (미등록 확장자는 application/octet-stream 처리)
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

// [Antigravity-Doc] 프로덕션 정적 서버에서 접근을 원천 차단할 Vite 개발 전용 경로 및 소스/패키지 경로 접두사 목록
const BLOCKED_PATH_PREFIXES = ["/@id", "/@fs", "/@vite", "/__vite", "/node_modules", "/src/"];

/**
 * [Antigravity-Doc]
 * 모든 정적/프록시/에러 응답에 기본 웹 보안 헤더를 주입합니다.
 * - X-Content-Type-Options: nosniff (브라우저의 MIME 스니핑 차단)
 * - X-Frame-Options: SAMEORIGIN (외부 도메인 iframe 클릭재킹 차단)
 * - Referrer-Policy: same-origin (외부 사이트로 Referer URL 유출 최소화)
 */
function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
}

/**
 * [Antigravity-Doc]
 * 단순 텍스트 에러/상태 응답(400, 404, 405, 500 등)을 보안 헤더와 함께 안전하게 전송합니다.
 * 이미 헤더가 전송된 경우 중복 전송 에러를 방지하기 위해 즉시 반환합니다.
 */
function sendText(res, status, text) {
  if (res.headersSent) return;
  setSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/**
 * [Antigravity-Doc]
 * 소켓 원격 주소가 로컬 루프백(IPv4 127.0.0.1, IPv6 ::1, IPv4-mapped ::ffff:127.0.0.1)인지 판별합니다.
 * 로컬 리버스 프록시(예: Nginx, Cloudflare Tunnel 등)에서 온 신뢰된 홉(trustedHop)일 때만
 * 클라이언트가 보낸 X-Forwarded-* / CF-Connecting-IP 헤더를 신뢰하도록 제어하는 데 사용됩니다.
 */
/**
 * /api/* 요청을 백엔드 서버로 스트리밍(SSE 포함) 프록시 전달한다.
 */
function isLoopbackRemote(addr) {
  const s = String(addr || "");
  return s === "127.0.0.1" || s === "::1" || s === "::ffff:127.0.0.1";
}

/**
 * [Antigravity-Doc]
 * `/api` 및 `/api/*` 요청을 백엔드 서버(BACKEND_TARGET)로 양방향 스트리밍 프록시합니다.
 * 주요 처리 흐름:
 *   1. 프로토콜(http/https)에 맞는 Node 내장 클라이언트 선택 및 Host 헤더를 백엔드 대상으로 교체
 *   2. trustedHop(루프백 경유) 여부에 따라 x-forwarded-host / x-forwarded-for / x-forwarded-proto 헤더 위변조 방지
 *   3. 백엔드 응답 수신 시 보안 헤더 주입 + `res.flushHeaders()` 즉시 호출로 SSE(text/event-stream) 버퍼링 지연 제거
 *   4. 백엔드 연결 실패 시 502 JSON 에러 응답 반환, 클라이언트 연결 중단(aborted/close) 시 업스트림 요청 즉시 파괴(리소스 누수 방지)
 */
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
  // [Antigravity-Doc] 신뢰된 로컬 프록시 경유 시 CF-Connecting-IP/X-Forwarded-For를 보존하고, 직접 접속 시 소켓 실제 IP로 덮어써 IP 스푸핑 차단
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
      // [Antigravity-Doc] SSE(실시간 AI 브리핑·시세 스트리밍) 청크가 지연 없이 클라이언트에 도달하도록 헤더를 즉시 플러시
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }
      proxyRes.pipe(res);
    }
  );

  // [Antigravity-Doc] 백엔드 프로세스 다운 또는 네트워크 장애 시 502 Bad Gateway JSON 응답 처리
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      setSecurityHeaders(res);
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, detail: "백엔드 API 서버에 연결할 수 없습니다." }));
    } else {
      res.destroy();
    }
  });

  // [Antigravity-Doc] 브라우저 탭 닫기·요청 취소 시 백엔드 프록시 소켓(특히 SSE 장기 연결)을 즉시 정리
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

/**
 * [Antigravity-Doc]
 * URI 디코딩된 요청 경로의 보안 위험 여부를 사전 검증합니다.
 * 차단 대상:
 *   - 빈 경로, 널 바이트(\0), 윈도우 스타일 역슬래시(\) 포함 경로
 *   - BLOCKED_PATH_PREFIXES에 해당하는 Vite 내부 경로(/node_modules, /src/, /@vite 등)
 *   - 경로 세그먼트 중 `.`, `..` 또는 `.`으로 시작하는 숨김 파일/디렉터리(.env, .git 등)
 */
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

/**
 * [Antigravity-Doc]
 * 검증된 정적 파일을 스트림 방식으로 클라이언트에 전송합니다.
 * 캐시 정책(Cache-Control) 3단계 분기:
 *   1. index.html: 배포 즉시 최신 번들을 로드하도록 `no-cache, no-store, must-revalidate`
 *   2. /assets/* (Vite 콘텐츠 해시 포함 파일): 1년 장기 불변 캐시 (`public, max-age=31536000, immutable`)
 *   3. 그 외 정적 파일(favicon 등): 5분 단기 캐시 (`public, max-age=300`)
 * HEAD 메서드 요청 시 바디 스트림을 열지 않고 헤더만 응답합니다.
 */
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

/**
 * [Antigravity-Doc]
 * `/api/*` 이외의 모든 정적 리소스 및 SPA 클라이언트 라우팅 요청을 처리합니다.
 * 단계별 처리 흐름:
 *   1. HTTP 메서드 검증 (GET, HEAD만 허용, 그 외 405 반환)
 *   2. URL 파싱 및 decodeURIComponent 수행 (잘못된 인코딩은 400 반환)
 *   3. isUnsafeDecodedPath + DIST_DIR 경계 검사로 경로 순회(Directory Traversal) 차단
 *   4. 파일 존재 시 `fs.realpathSync`로 심볼릭 링크 탈출 여부 재검증 후 파일/디렉터리 서빙
 *   5. 존재하지 않는 경로 중 확장자가 있는 요청(.php, .env 등)은 404 차단, 확장자 없는 경로만 SPA `index.html`로 폴백
 */
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

  // [Antigravity-Doc] 선행 슬래시 제거 후 DIST_DIR 기준으로 후보 파일 경로를 정규화하고 디렉터리 경계 이탈 차단
  const relPath = decodedPath.replace(/^\/+/, "");
  const candidate = relPath ? path.resolve(DIST_DIR, relPath) : path.join(DIST_DIR, "index.html");
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + path.sep)) {
    return sendText(res, 404, "Not Found");
  }

  if (fs.existsSync(candidate)) {
    try {
      // [Antigravity-Doc] 심볼릭 링크를 통한 REAL_DIST_DIR 외부 파일 접근 차단
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

  // [Antigravity-Doc] 정적 리소스/취약점 스캔 요청(.env, .php 등)이 SPA index.html(200)로 잘못 응답되지 않도록 404 차단
  // 알 수 없는 확장자(.env, .php, .json 등)는 SPA 폴백하지 않고 즉시 404 차단
  if (path.extname(decodedPath)) {
    return sendText(res, 404, "Not Found");
  }

  // [Antigravity-Doc] 확장자가 없는 클라이언트 라우트(/news, /settings 등)는 React SPA 진입점 index.html로 폴백
  const spaIndex = path.join(REAL_DIST_DIR, "index.html");
  return serveFile(req, res, spaIndex, false);
}

// [Antigravity-Doc] 메인 HTTP 서버 인스턴스: 요청 경로가 `/api` 또는 `/api/*`이면 백엔드 프록시로, 그 외에는 정적/SPA 핸들러로 분기
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

// [Antigravity-Doc] 실행 중인 로그 로테이션 스케줄러 제어 핸들 (종료 시 stop() 호출용)
let logRotationHandle = null;

// [Antigravity-Doc] 지정 호스트·포트로 서버 리슨 시작 및 프로젝트 logs/ 디렉터리 로그 자동 정리 스케줄러 가동
server.listen(FRONTEND_PORT, FRONTEND_HOST, () => {
  console.log(`[AutoCoinTrade] Hardened Static Frontend Server listening on http://${FRONTEND_HOST}:${FRONTEND_PORT} -> API proxy ${BACKEND_URL}`);
  logRotationHandle = startLogRotationScheduler({
    logsDir: path.join(PROJECT_ROOT, "logs"),
    retentionDays: process.env.LOG_RETENTION_DAYS || fileEnv.LOG_RETENTION_DAYS,
    loggerPrefix: "[Frontend LogRotator]",
  });
});

/**
 * [Antigravity-Doc]
 * OS 종료 시그널(SIGINT, SIGTERM) 수신 시 로그 스케줄러와 HTTP 서버를 안전하게 정리합니다.
 * 장기 SSE 연결 등으로 인해 server.close()가 지연되더라도 최대 2초 후 강제 종료(.unref()로 정상 종료는 방해하지 않음)합니다.
 */
function shutdown(signal) {
  console.log(`[Frontend Server] Received ${signal}, shutting down cleanly...`);
  if (logRotationHandle) {
    logRotationHandle.stop();
    logRotationHandle = null;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

// [Antigravity-Doc] Ctrl+C(SIGINT) 및 systemd/컨테이너 중지 시그널(SIGTERM)에 우아한 종료 핸들러 바인딩
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
