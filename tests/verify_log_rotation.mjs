import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupExpiredLogs,
  getKstCalendarKey,
  getPreviousKstDateKey,
  msUntilNextKstMidnight,
  parseDateKeyToDayIndex,
  rotateLogs,
  startLogRotationScheduler,
} from "../backend/common/log_rotator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function kstDate(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - 9 * 3600 * 1000);
}

function makeTempLogsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-log-rotator-"));
}

function writeWithMtime(filePath, content, mtimeDate) {
  fs.writeFileSync(filePath, content, "utf-8");
  fs.utimesSync(filePath, mtimeDate, mtimeDate);
}

const results = [];

function record(check, detail) {
  results.push({ suite: "LogRotation", check, detail, status: "PASS" });
}

// 1. KST Calendar & Midnight Math
{
  const midnightUtc = new Date("2026-11-15T15:00:00.000Z"); // 2026-11-16 00:00:00 KST
  const parts = getKstCalendarKey(midnightUtc);
  assert.equal(parts.dateKey, "20261116");
  assert.equal(parts.hour, 0);
  assert.equal(getPreviousKstDateKey(midnightUtc), "20261115");

  const oneSecBefore = kstDate(2026, 11, 15, 23, 59, 59);
  assert.equal(msUntilNextKstMidnight(oneSecBefore), 1000);

  assert.equal(getPreviousKstDateKey(kstDate(2026, 12, 1, 0, 0, 0)), "20261130");
  assert.equal(parseDateKeyToDayIndex("20260230"), null);
  assert.notEqual(parseDateKeyToDayIndex("20261115"), null);
  record("KstCalendarMath", "KST midnight, month rollover, and invalid date checks");
}

// 2. Midnight Rotation & 0-Byte File Handling
{
  const dir = makeTempLogsDir();
  try {
    const tPrev = kstDate(2026, 11, 15, 23, 50, 0);
    const tMidnight = kstDate(2026, 11, 16, 0, 0, 1);

    writeWithMtime(path.join(dir, "backend.log"), "backend line\n", tPrev);
    writeWithMtime(path.join(dir, "frontend.log"), "", tPrev);
    writeWithMtime(path.join(dir, "tunnel.log"), "tunnel line\n", tPrev);
    fs.writeFileSync(path.join(dir, ".backend.pid"), "12345", "utf-8");
    fs.writeFileSync(path.join(dir, ".gitkeep"), "", "utf-8");

    const res = await rotateLogs({ logsDir: dir, mode: "midnight", now: tMidnight });
    assert.equal(res.skipped, false);
    assert.equal(res.rotated.length, 3);

    assert.equal(fs.readFileSync(path.join(dir, "backend.log_20261115"), "utf-8"), "backend line\n");
    assert.equal(fs.readFileSync(path.join(dir, "frontend.log_20261115"), "utf-8"), "");
    assert.equal(fs.readFileSync(path.join(dir, "tunnel.log_20261115"), "utf-8"), "tunnel line\n");

    for (const active of ["backend.log", "frontend.log", "tunnel.log"]) {
      const st = fs.statSync(path.join(dir, active));
      assert.equal(st.size, 0);
      assert.equal(getKstCalendarKey(new Date(st.mtimeMs)).dateKey, "20261116");
    }
    assert.equal(fs.readFileSync(path.join(dir, ".backend.pid"), "utf-8"), "12345");
    assert.equal(fs.existsSync(path.join(dir, ".gitkeep")), true);
    record("MidnightRotation", "Archives *.log -> *.log_yyyymmdd and resets active logs including 0-byte files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Idempotency + Late Midnight Write Guard
{
  const dir = makeTempLogsDir();
  try {
    const tStateInit = kstDate(2026, 11, 15, 12, 0, 0);
    await rotateLogs({ logsDir: dir, initOnly: true, now: tStateInit });

    // Log line written right at 00:00:00.500 before cron ran at 00:00:01
    writeWithMtime(path.join(dir, "backend.log"), "just before rotate\n", kstDate(2026, 11, 16, 0, 0, 0, 500));

    const first = await rotateLogs({ logsDir: dir, mode: "midnight", now: kstDate(2026, 11, 16, 0, 0, 1) });
    assert.equal(first.skipped, false);
    assert.equal(fs.readFileSync(path.join(dir, "backend.log_20261115"), "utf-8"), "just before rotate\n");

    fs.appendFileSync(path.join(dir, "backend.log"), "new day line\n", "utf-8");
    const second = await rotateLogs({ logsDir: dir, mode: "midnight", now: kstDate(2026, 11, 16, 0, 0, 5) });
    assert.equal(second.skipped, true);
    assert.equal(fs.readFileSync(path.join(dir, "backend.log"), "utf-8"), "new day line\n");
    assert.equal(fs.readFileSync(path.join(dir, "backend.log_20261115"), "utf-8"), "just before rotate\n");
    record("IdempotencyAndMidnightSkew", "Prevents double rotation on same day and names yesterday correctly");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 4. Startup Mode (Stale Previous Day vs Same Day)
{
  const dir = makeTempLogsDir();
  try {
    writeWithMtime(path.join(dir, "backend.log"), "stale 13th\n", kstDate(2026, 11, 13, 18, 0, 0));
    writeWithMtime(path.join(dir, "frontend.log"), "today 16th\n", kstDate(2026, 11, 16, 8, 0, 0));

    const res = await rotateLogs({ logsDir: dir, mode: "startup", now: kstDate(2026, 11, 16, 10, 0, 0) });
    assert.equal(res.rotated.length, 1);
    assert.equal(res.rotated[0].archive, "backend.log_20261113");
    assert.equal(fs.readFileSync(path.join(dir, "backend.log_20261113"), "utf-8"), "stale 13th\n");
    assert.equal(fs.statSync(path.join(dir, "backend.log")).size, 0);
    assert.equal(fs.readFileSync(path.join(dir, "frontend.log"), "utf-8"), "today 16th\n");
    record("StartupRotation", "Archives stale previous-day logs while keeping active same-day logs");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 5. 7-Day Retention Cleanup
{
  const dir = makeTempLogsDir();
  try {
    const files = [
      "backend.log_20261107",
      "backend.log_20261108",
      "backend.log_20261109",
      "frontend.log_20261108",
      "tunnel.log_20261115",
      "backend.log",
      ".backend.pid",
      "keep_me.txt",
    ];
    for (const f of files) {
      fs.writeFileSync(path.join(dir, f), "data", "utf-8");
    }

    const deleted = cleanupExpiredLogs({
      logsDir: dir,
      retentionDays: 7,
      now: kstDate(2026, 11, 16, 0, 0, 0),
    });

    assert.deepEqual(deleted.sort(), ["backend.log_20261107", "backend.log_20261108", "frontend.log_20261108"].sort());
    assert.equal(fs.existsSync(path.join(dir, "backend.log_20261109")), true);
    assert.equal(fs.existsSync(path.join(dir, "tunnel.log_20261115")), true);
    assert.equal(fs.existsSync(path.join(dir, "backend.log")), true);
    assert.equal(fs.existsSync(path.join(dir, ".backend.pid")), true);
    assert.equal(fs.existsSync(path.join(dir, "keep_me.txt")), true);
    record("Retention7Days", "Deletes rotated logs > 7 days old and keeps <= 7 days + control files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 6. Append-Safety & Concurrent Lock Execution
{
  const dir = makeTempLogsDir();
  try {
    const tPrev = kstDate(2026, 11, 15, 22, 0, 0);
    fs.writeFileSync(path.join(dir, "backend.log_20261115"), "part1\n", "utf-8");
    writeWithMtime(path.join(dir, "backend.log"), "part2\n", tPrev);

    const [r1, r2] = await Promise.all([
      rotateLogs({ logsDir: dir, mode: "midnight", now: kstDate(2026, 11, 16, 0, 0, 1) }),
      rotateLogs({ logsDir: dir, mode: "midnight", now: kstDate(2026, 11, 16, 0, 0, 1) }),
    ]);

    const rotatedCount = [r1, r2].filter((r) => !r.skipped).length;
    assert.equal(rotatedCount, 1);
    assert.equal(fs.readFileSync(path.join(dir, "backend.log_20261115"), "utf-8"), "part1\npart2\n");
    assert.equal(fs.statSync(path.join(dir, "backend.log")).size, 0);
    record("AppendAndConcurrency", "Preserves existing archive contents and serializes concurrent rotations");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 7. Scheduler Lifecycle & CLI Verification
{
  const dir = makeTempLogsDir();
  try {
    const handle = startLogRotationScheduler({ logsDir: dir, runStartupCheck: false });
    handle.stop();

    execFileSync(
      process.execPath,
      [path.join(PROJECT_ROOT, "scripts", "rotate_logs.mjs"), "--init", "--logs-dir", dir],
      { stdio: "pipe" }
    );
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".log_rotation_state.json"), "utf-8"));
    assert.match(state.lastRotatedDate, /^\d{8}$/);
    record("SchedulerAndCli", "Scheduler starts/stops cleanly and CLI --init writes state");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== Daily Log Rotation & 7-Day Retention Verification ===");
console.table(results);
