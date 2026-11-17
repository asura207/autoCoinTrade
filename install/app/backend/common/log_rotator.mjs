import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KST_OFFSET_MS = 9 * 3600 * 1000;
const MS_PER_DAY = 86400 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const STATE_FILENAME = ".log_rotation_state.json";
const LOCK_FILENAME = ".rotate.lock";
const ROTATED_LOG_PATTERN = /^(.+\.log)_(\d{8})$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * KST(+09:00) 기준 날짜/시각 구성 요소를 반환한다.
 */
export function getKstCalendarKey(dateInput = new Date()) {
  const ref = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const kst = new Date(ref.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  const day = kst.getUTCDate();
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const second = kst.getUTCSeconds();
  const dateKey = `${year}${pad2(month)}${pad2(day)}`;
  const isoDate = `${year}-${pad2(month)}-${pad2(day)}`;
  const timestamp = `${isoDate} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  const dayIndex = Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
  return { year, month, day, hour, minute, second, dateKey, isoDate, timestamp, dayIndex };
}

/**
 * 기준 시각의 전날 KST YYYYMMDD 문자열을 반환한다.
 */
export function getPreviousKstDateKey(dateInput = new Date()) {
  const { year, month, day } = getKstCalendarKey(dateInput);
  const prev = new Date(Date.UTC(year, month - 1, day - 1));
  return `${prev.getUTCFullYear()}${pad2(prev.getUTCMonth() + 1)}${pad2(prev.getUTCDate())}`;
}

/**
 * YYYYMMDD 문자열을 검증해 정수 일수 인덱스로 변환한다.
 */
export function parseDateKeyToDayIndex(dateKey) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcMs = Date.UTC(year, month - 1, day);
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utcMs / MS_PER_DAY);
}

/**
 * 다음 KST 자정(00:00:00)까지 남은 밀리초를 반환한다.
 */
export function msUntilNextKstMidnight(dateInput = new Date()) {
  const ref = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const { year, month, day } = getKstCalendarKey(ref);
  const nextMidnightRealMs = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0) - KST_OFFSET_MS;
  return Math.max(0, nextMidnightRealMs - ref.getTime());
}

/**
 * 보관 일수 설정값을 검증/정규화한다(기본 7일).
 */
export function resolveRetentionDays(value) {
  const raw = value ?? process.env.LOG_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.floor(parsed);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function withLogRotateLock(logsDir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(logsDir, { recursive: true });
  const lockPath = path.join(logsDir, LOCK_FILENAME);
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o644);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw err;
      }

      let removedStale = false;
      try {
        const stat = fs.statSync(lockPath);
        let lockPid = null;
        let lockTs = stat.mtimeMs;
        try {
          const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
          if (Number.isInteger(parsed?.pid)) lockPid = parsed.pid;
          if (Number.isFinite(parsed?.ts)) lockTs = parsed.ts;
        } catch {}
        const ageMs = Date.now() - lockTs;
        if (ageMs > staleMs || (lockPid !== null && lockPid !== process.pid && !isPidAlive(lockPid))) {
          fs.unlinkSync(lockPath);
          removedStale = true;
        }
      } catch (statErr) {
        if (statErr?.code === "ENOENT") {
          removedStale = true;
        }
      }

      if (removedStale) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring log rotation lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

function readRotationState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return { lastRotatedDate: null };
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return {
      lastRotatedDate: typeof parsed?.lastRotatedDate === "string" ? parsed.lastRotatedDate : null,
    };
  } catch {
    return { lastRotatedDate: null };
  }
}

function writeRotationState(statePath, state) {
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, statePath);
}

/**
 * 실행 중인 프로세스의 O_APPEND 파일 디스크립터를 유지한 채
 * 기존 로그 내용을 *.log_yyyymmdd 파일로 안전하게 복사·아카이브하고 원본 파일을 0바이트로 초기화한다.
 */
function archiveAndTruncateFile(filePath, archivePath, now) {
  const buf = Buffer.allocUnsafe(65536);
  const srcFd = fs.openSync(filePath, "r");
  const destFd = fs.openSync(archivePath, "a", 0o644);
  let offset = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(srcFd, buf, 0, buf.length, offset);
      if (bytesRead <= 0) break;
      fs.writeSync(destFd, buf, 0, bytesRead);
      offset += bytesRead;
    }

    // 복사 도중 추가 기록된 마지막 바이트까지 반영해 유실 구간을 최소화한다.
    while (true) {
      const extraRead = fs.readSync(srcFd, buf, 0, buf.length, offset);
      if (extraRead <= 0) break;
      fs.writeSync(destFd, buf, 0, extraRead);
      offset += extraRead;
    }
  } finally {
    fs.closeSync(destFd);
    fs.closeSync(srcFd);
  }

  fs.truncateSync(filePath, 0);
  fs.utimesSync(filePath, now, now);
}

/**
 * 만들어진 지 보관 기간(기본 7일)이 지난 로테이션 로그(*.log_yyyymmdd)를 삭제한다.
 */
export function cleanupExpiredLogs({
  logsDir = path.join(DEFAULT_PROJECT_ROOT, "logs"),
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = new Date(),
} = {}) {
  const deleted = [];
  if (!fs.existsSync(logsDir)) return deleted;

  const limitDays = resolveRetentionDays(retentionDays);
  const { dayIndex: todayDayIndex } = getKstCalendarKey(now);
  const entries = fs.readdirSync(logsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const match = ROTATED_LOG_PATTERN.exec(entry.name);
    if (!match) continue;

    const fileDayIndex = parseDateKeyToDayIndex(match[2]);
    if (fileDayIndex === null) continue;

    const ageDays = todayDayIndex - fileDayIndex;
    if (ageDays > limitDays) {
      const targetPath = path.join(logsDir, entry.name);
      try {
        fs.unlinkSync(targetPath);
        deleted.push(entry.name);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          console.warn(`[LogRotator] Failed to delete expired log ${entry.name}: ${err.message}`);
        }
      }
    }
  }

  return deleted;
}

/**
 * logs/*.log 파일을 일자별(*.log_yyyymmdd)로 분할하고 만료된 로그를 정리한다.
 */
export async function rotateLogs({
  logsDir = path.join(DEFAULT_PROJECT_ROOT, "logs"),
  retentionDays = DEFAULT_RETENTION_DAYS,
  mode = "auto",
  force = false,
  initOnly = false,
  now = new Date(),
} = {}) {
  const refNow = now instanceof Date ? now : new Date(now);
  const effectiveRetention = resolveRetentionDays(retentionDays);

  return await withLogRotateLock(logsDir, () => {
    const statePath = path.join(logsDir, STATE_FILENAME);
    const state = readRotationState(statePath);
    const { dateKey: todayKey, timestamp } = getKstCalendarKey(refNow);
    const yesterdayKey = getPreviousKstDateKey(refNow);

    if (initOnly) {
      if (!state.lastRotatedDate) {
        writeRotationState(statePath, { lastRotatedDate: todayKey, updatedAt: timestamp });
      }
      const deleted = cleanupExpiredLogs({ logsDir, retentionDays: effectiveRetention, now: refNow });
      return { rotated: [], deleted, skipped: false, initialized: true, todayKey };
    }

    const activeLogs = fs
      .readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".log"))
      .map((entry) => entry.name)
      .sort();

    let resolvedMode = mode;
    if (resolvedMode === "auto") {
      if (state.lastRotatedDate && state.lastRotatedDate < todayKey) {
        resolvedMode = "midnight";
      } else {
        resolvedMode = "startup";
      }
    }

    if (!force && resolvedMode === "midnight" && state.lastRotatedDate === todayKey) {
      const deleted = cleanupExpiredLogs({ logsDir, retentionDays: effectiveRetention, now: refNow });
      return { rotated: [], deleted, skipped: true, todayKey };
    }

    const rotated = [];

    for (const fileName of activeLogs) {
      const filePath = path.join(logsDir, fileName);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const fileDateKey = getKstCalendarKey(new Date(stat.mtimeMs)).dateKey;
      let archiveDateKey = null;

      if (force) {
        archiveDateKey = fileDateKey < todayKey ? fileDateKey : todayKey;
      } else if (resolvedMode === "midnight") {
        archiveDateKey = fileDateKey < yesterdayKey ? fileDateKey : yesterdayKey;
      } else if (fileDateKey < todayKey) {
        // startup 모드: 이전 날짜에 마지막으로 기록된 로그만 아카이브하고 당일 로그는 유지한다.
        archiveDateKey = fileDateKey;
      }

      if (!archiveDateKey) continue;

      const archiveName = `${fileName}_${archiveDateKey}`;
      const archivePath = path.join(logsDir, archiveName);

      try {
        archiveAndTruncateFile(filePath, archivePath, refNow);
        rotated.push({ source: fileName, archive: archiveName, bytes: stat.size });
      } catch (err) {
        console.warn(`[LogRotator] Failed to rotate ${fileName} -> ${archiveName}: ${err.message}`);
      }
    }

    if (force || resolvedMode === "midnight" || !state.lastRotatedDate || state.lastRotatedDate < todayKey) {
      writeRotationState(statePath, { lastRotatedDate: todayKey, updatedAt: timestamp });
    }

    const deleted = cleanupExpiredLogs({ logsDir, retentionDays: effectiveRetention, now: refNow });
    return { rotated, deleted, skipped: false, todayKey };
  });
}

/**
 * KST 00:00 자정마다 로그 분할 및 7일 경과 파일 삭제를 자동 실행하는 스케줄러를 시작한다.
 */
export function startLogRotationScheduler({
  logsDir = path.join(DEFAULT_PROJECT_ROOT, "logs"),
  retentionDays = DEFAULT_RETENTION_DAYS,
  loggerPrefix = "[LogRotator]",
  runStartupCheck = true,
} = {}) {
  let stopped = false;
  let timer = null;
  let targetDateKey = getKstCalendarKey(new Date(Date.now() + msUntilNextKstMidnight(new Date()) + 1000)).dateKey;

  const scheduleNext = () => {
    if (stopped) return;
    const now = new Date();
    const msLeft = msUntilNextKstMidnight(now);
    // 최대 1시간 단위로 재계산해 시스템 슬립/시계 보정에도 자정 트리거 정확도를 보장한다.
    const delayMs = Math.min(Math.max(50, msLeft + 50), 60 * 60 * 1000);

    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const currentNow = new Date();
        const currentKey = getKstCalendarKey(currentNow).dateKey;
        if (currentKey >= targetDateKey) {
          const result = await rotateLogs({
            logsDir,
            retentionDays,
            mode: "midnight",
            now: currentNow,
          });
          if (!result.skipped && (result.rotated.length > 0 || result.deleted.length > 0)) {
            console.log(
              `${loggerPrefix} Midnight rotation completed (${currentKey}): rotated=${result.rotated.length}, deleted=${result.deleted.length}`
            );
          }
          targetDateKey = getKstCalendarKey(
            new Date(currentNow.getTime() + msUntilNextKstMidnight(currentNow) + 1000)
          ).dateKey;
        }
      } catch (err) {
        console.warn(`${loggerPrefix} Midnight rotation warning:`, err.message);
      } finally {
        scheduleNext();
      }
    }, delayMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  };

  if (runStartupCheck) {
    rotateLogs({ logsDir, retentionDays, mode: "startup" }).catch((err) => {
      console.warn(`${loggerPrefix} Startup rotation warning:`, err.message);
    });
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function readRetentionFromDotEnv(projectRoot) {
  if (process.env.LOG_RETENTION_DAYS) return process.env.LOG_RETENTION_DAYS;
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return undefined;
  try {
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === "LOG_RETENTION_DAYS") {
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        return val;
      }
    }
  } catch {}
  return undefined;
}

export async function runCli(argv = process.argv.slice(2)) {
  let mode = "auto";
  let force = false;
  let initOnly = false;
  let logsDir = path.join(DEFAULT_PROJECT_ROOT, "logs");
  let retentionDays = readRetentionFromDotEnv(DEFAULT_PROJECT_ROOT);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--startup") mode = "startup";
    else if (arg === "--midnight") mode = "midnight";
    else if (arg === "--force") force = true;
    else if (arg === "--init") initOnly = true;
    else if (arg === "--logs-dir" && argv[i + 1]) {
      logsDir = path.resolve(argv[++i]);
    } else if (arg === "--retention-days" && argv[i + 1]) {
      retentionDays = argv[++i];
    }
  }

  const result = await rotateLogs({ logsDir, retentionDays, mode, force, initOnly });
  if (!result.skipped && (result.rotated.length > 0 || result.deleted.length > 0)) {
    console.log(
      `[LogRotator] Done (${result.todayKey}): rotated=${result.rotated.map((r) => `${r.source}->${r.archive}`).join(", ") || "none"}, deleted=${result.deleted.join(", ") || "none"}`
    );
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((err) => {
    console.error("[LogRotator] Fatal error:", err);
    process.exit(1);
  });
}
