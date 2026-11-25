/**
 * [Antigravity-Doc]
 * 파일 역할: KST(+09:00) 자정 기준 일별 로그 로테이션(`*.log` -> `*.log_YYYYMMDD`), 만료 로그 자동 삭제 및 CLI 실행기 모듈
 * 아키텍처:
 * - 실행 중인 백그라운드 프로세스들이 열어둔 `O_APPEND` 로그 파일 디스크립터를 끊지 않고 로테이션하기 위해 `copytruncate` 방식(`archiveAndTruncateFile`)을 사용합니다.
 * - 다중 프로세스(API 서버, 봇 워커, CLI 등)가 동시에 로테이션을 시도해도 충돌하지 않도록 `logs/.rotate.lock` 파일 락(PID 생존 체크 + 30초 stale 회수)과 원자적 상태 파일(`.log_rotation_state.json`)을 관리합니다.
 * - `startLogRotationScheduler`는 최대 1시간 단위로 타이머를 재계산해 OS 슬립이나 시계 보정 이후에도 KST 00:00 자정 로테이션을 정확히 트리거합니다.
 * 주요 의존성: `node:fs`, `node:path`, `node:url`
 * 수정 시 주의사항:
 * - 모든 날짜 경계 계산은 서버 로컬 타임존과 무관하게 `KST_OFFSET_MS`(UTC+9) 기준으로 통일되어 있습니다.
 * - 파일 하단의 직접 실행 가드(`process.argv[1] === __filename`)를 통해 `node backend/common/log_rotator.mjs --midnight` 형태로 독립 실행할 수 있습니다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// [Antigravity-Doc] KST 시차(9시간), 하루 밀리초, 기본 보관 일수(7일), 상태/락 파일명 및 로테이션 파일명 정규식 상수
const KST_OFFSET_MS = 9 * 3600 * 1000;
const MS_PER_DAY = 86400 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const STATE_FILENAME = ".log_rotation_state.json";
const LOCK_FILENAME = ".rotate.lock";
const ROTATED_LOG_PATTERN = /^(.+\.log)_(\d{8})$/;

// [Antigravity-Doc] ESM 현재 파일 경로 및 프로젝트 루트 디렉터리 계산
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * [Antigravity-Doc]
 * 역할: 숫자를 최소 2자리 0-패딩 문자열로 변환합니다 (예: `5` -> `"05"`).
 * 매개변수:
 * - n {number}: 변환할 정수
 * 반환값: {string}
 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * [Antigravity-Doc]
 * 역할: 임의의 시각을 KST(+09:00) 달력 구성 요소 및 정수 일수 인덱스(`dayIndex`)로 변환합니다.
 * 매개변수:
 * - dateInput {Date|number|string} [new Date()]: 기준 시각
 * 반환값: {{year, month, day, hour, minute, second, dateKey, isoDate, timestamp, dayIndex}}
 */
/**
 * KST(+09:00) 기준 날짜/시각 구성 요소를 반환한다.
 */
export function getKstCalendarKey(dateInput = new Date()) {
  const ref = dateInput instanceof Date ? dateInput : new Date(dateInput);
  // [Antigravity-Doc] UTC 타임스탬프에 +9시간을 더한 뒤 getUTC* 메서드로 서버 로컬 타임존 영향을 완전히 배제
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
 * [Antigravity-Doc]
 * 역할: 기준 시각의 KST 전일 날짜 키(`YYYYMMDD`)를 계산합니다.
 * 매개변수:
 * - dateInput {Date|number|string} [new Date()]: 기준 시각
 * 반환값: {string} 전일 `YYYYMMDD` 문자열
 */
/**
 * 기준 시각의 전날 KST YYYYMMDD 문자열을 반환한다.
 */
export function getPreviousKstDateKey(dateInput = new Date()) {
  const { year, month, day } = getKstCalendarKey(dateInput);
  const prev = new Date(Date.UTC(year, month - 1, day - 1));
  return `${prev.getUTCFullYear()}${pad2(prev.getUTCMonth() + 1)}${pad2(prev.getUTCDate())}`;
}

/**
 * [Antigravity-Doc]
 * 역할: `YYYYMMDD` 문자열의 실존 날짜 여부(예: 2월 30일 차단)를 검증하고 epoch 기준 일수 정수로 변환합니다.
 * 매개변수:
 * - dateKey {string}: 8자리 날짜 키
 * 반환값: {number|null} 유효한 날짜면 정수 일수 인덱스, 유효하지 않으면 `null`
 */
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
  // [Antigravity-Doc] Date.UTC 역검증으로 존재하지 않는 달력 날짜(예: 20260230) 필터링
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
 * [Antigravity-Doc]
 * 역할: 주어진 시각부터 다음 KST 자정(00:00:00.000)까지 남은 밀리초를 계산합니다.
 * 매개변수:
 * - dateInput {Date|number|string} [new Date()]: 기준 시각
 * 반환값: {number} 남은 밀리초 (0 이상)
 */
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
 * [Antigravity-Doc]
 * 역할: 로그 보관 일수를 인자 > 환경 변수(`LOG_RETENTION_DAYS`) > 기본값(7일) 순으로 해석하고 1 이상의 정수로 정규화합니다.
 * 매개변수:
 * - value {number|string|undefined}: 명시적 보관 일수
 * 반환값: {number} 정규화된 보관 일수(일)
 */
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

/**
 * [Antigravity-Doc]
 * 역할: `process.kill(pid, 0)` 시그널 검사로 해당 PID 프로세스가 현재 살아 있는지 확인합니다.
 * 매개변수:
 * - pid {number}: 검사할 프로세스 ID
 * 반환값: {boolean} 살아 있거나 권한 부족(`EPERM`)이면 `true`, 종료되었으면 `false`
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * [Antigravity-Doc]
 * 역할: `logs/.rotate.lock` 파일의 원자적 생성(`wx` 플래그)을 통해 다중 프로세스 간 로그 로테이션 임계 구역을 배타적으로 실행합니다.
 * 매개변수:
 * - logsDir {string}: 로그 디렉터리 경로
 * - fn {Function}: 락 획득 상태에서 실행할 작업 콜백
 * - options {object} [{}]: `{ timeoutMs = 5000, staleMs = 30000 }`
 * 반환값: {Promise<any>} `fn()`의 실행 결과
 * 부수효과/예외 처리: 락 소유 프로세스가 죽었거나 30초 이상 경과한 stale 락은 자동 제거 후 재시도하며, 타임아웃 초과 시 예외를 throw합니다.
 */
async function withLogRotateLock(logsDir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(logsDir, { recursive: true });
  const lockPath = path.join(logsDir, LOCK_FILENAME);
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  // [Antigravity-Doc] O_EXCL('wx')로 원자적 락 파일 생성 시도; 이미 존재하면 stale 여부 판정 후 25ms 간격 재시도
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

      // [Antigravity-Doc] 기존 락 파일의 타임스탬프와 소유 PID를 점검해 비정상 종료된 프로세스의 stale 락 회수
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

  // [Antigravity-Doc] 콜백 실행 후 성공/실패와 무관하게 락 파일 정리
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

/**
 * [Antigravity-Doc]
 * 역할: `.log_rotation_state.json`에서 마지막 로테이션 완료 일자(`lastRotatedDate`)를 읽습니다.
 * 매개변수:
 * - statePath {string}: 상태 파일 경로
 * 반환값: {{lastRotatedDate: string|null}}
 */
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

/**
 * [Antigravity-Doc]
 * 역할: 임시 파일에 기록 후 `renameSync`로 교체하여 로테이션 상태 파일을 원자적으로 저장합니다.
 * 매개변수:
 * - statePath {string}: 상태 파일 경로
 * - state {object}: 저장할 상태 객체
 * 반환값: 없음 (void)
 */
function writeRotationState(statePath, state) {
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, statePath);
}

/**
 * [Antigravity-Doc]
 * 역할: 64KB 버퍼로 원본 로그를 아카이브 파일에 append 복사한 뒤 원본을 0바이트로 truncate합니다(copytruncate 방식).
 * 매개변수:
 * - filePath {string}: 활성 `*.log` 원본 경로
 * - archivePath {string}: 대상 `*.log_YYYYMMDD` 아카이브 경로
 * - now {Date}: truncate 후 원본 파일의 atime/mtime 갱신에 사용할 기준 시각
 * 반환값: 없음 (void)
 * 부수효과/예외 처리: 1차 복사 직후 2차 드레인 루프를 한 번 더 수행해 복사 도중 기록된 로그 유실을 최소화하고, `finally`에서 파일 디스크립터를 반드시 닫습니다.
 */
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
    // [Antigravity-Doc] 1차 순차 읽기·쓰기로 기존 로그 본문 전체를 아카이브에 추가
    while (true) {
      const bytesRead = fs.readSync(srcFd, buf, 0, buf.length, offset);
      if (bytesRead <= 0) break;
      fs.writeSync(destFd, buf, 0, bytesRead);
      offset += bytesRead;
    }

    // [Antigravity-Doc] 2차 추가 드레인: 1차 복사 중 다른 프로세스가 append한 꼬리 바이트까지 수거
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

  // [Antigravity-Doc] 원본 파일 크기 초기화 및 mtime을 현재 시각으로 갱신해 동일 날짜 중복 로테이션 방지
  fs.truncateSync(filePath, 0);
  fs.utimesSync(filePath, now, now);
}

/**
 * [Antigravity-Doc]
 * 역할: 보관 일수(`retentionDays`)를 초과한 아카이브 로그(`*.log_YYYYMMDD`) 파일을 탐색해 삭제합니다.
 * 매개변수:
 * - options {object} [{}]: `{ logsDir, retentionDays = 7, now = new Date() }`
 * 반환값: {string[]} 실제 삭제된 파일명 배열
 * 부수효과/예외 처리: 파일 삭제 중 `ENOENT` 외 오류는 경고 로깅 후 나머지 파일 정리를 계속 진행합니다.
 */
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

  // [Antigravity-Doc] *.log_YYYYMMDD 패턴에 일치하는 파일의 경과 일수가 보관 기간을 초과하면 unlink
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
 * [Antigravity-Doc]
 * 역할: 파일 락 보호 하에 `logs/*.log` 파일들을 모드(`auto`/`startup`/`midnight`/`force`/`initOnly`)에 따라 일별 분할하고 만료 로그를 정리합니다.
 * 매개변수:
 * - options {object} [{}]:
 *   - logsDir {string}: 대상 로그 디렉터리
 *   - retentionDays {number} [7]: 보관 일수
 *   - mode {"auto"|"startup"|"midnight"} ["auto"]: 실행 모드
 *   - force {boolean} [false]: 당일 이미 로테이션되었어도 강제 분할 여부
 *   - initOnly {boolean} [false]: 실제 분할 없이 상태 파일 초기화 및 만료 로그 정리만 수행
 *   - now {Date|number|string} [new Date()]: 기준 시각
 * 반환값: {Promise<{rotated: Array<{source, archive, bytes}>, deleted: string[], skipped: boolean, initialized?: boolean, todayKey: string}>}
 */
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

    // [Antigravity-Doc] initOnly 모드: 초기 상태 파일 기록 및 만료 로그 정리만 수행하고 즉시 반환
    if (initOnly) {
      if (!state.lastRotatedDate) {
        writeRotationState(statePath, { lastRotatedDate: todayKey, updatedAt: timestamp });
      }
      const deleted = cleanupExpiredLogs({ logsDir, retentionDays: effectiveRetention, now: refNow });
      return { rotated: [], deleted, skipped: false, initialized: true, todayKey };
    }

    // [Antigravity-Doc] 숨김 파일 제외 활성 *.log 파일 목록 수집
    const activeLogs = fs
      .readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".log"))
      .map((entry) => entry.name)
      .sort();

    // [Antigravity-Doc] auto 모드 해석: 마지막 로테이션일이 오늘보다 이전이면 midnight, 아니면 startup으로 결정
    let resolvedMode = mode;
    if (resolvedMode === "auto") {
      if (state.lastRotatedDate && state.lastRotatedDate < todayKey) {
        resolvedMode = "midnight";
      } else {
        resolvedMode = "startup";
      }
    }

    // [Antigravity-Doc] 당일 자정 로테이션이 이미 완료되었고 강제 옵션이 없으면 중복 분할 방지(만료 삭제만 수행)
    if (!force && resolvedMode === "midnight" && state.lastRotatedDate === todayKey) {
      const deleted = cleanupExpiredLogs({ logsDir, retentionDays: effectiveRetention, now: refNow });
      return { rotated: [], deleted, skipped: true, todayKey };
    }

    const rotated = [];

    // [Antigravity-Doc] 각 활성 로그 파일의 최종 수정일(KST)과 실행 모드에 따라 아카이브 날짜 키 결정 후 분할
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

    // [Antigravity-Doc] 로테이션 기준일 상태 파일 갱신 및 보관 기간 초과 파일 삭제
    if (force || resolvedMode === "midnight" || !state.lastRotatedDate || state.lastRotatedDate < todayKey) {
      writeRotationState(statePath, { lastRotatedDate: todayKey, updatedAt: timestamp });
    }

    const deleted = cleanupExpiredLogs({ logsDir, retentionDays: effectiveRetention, now: refNow });
    return { rotated, deleted, skipped: false, todayKey };
  });
}

/**
 * [Antigravity-Doc]
 * 역할: 기동 시 1회 startup 점검을 수행하고, 이후 매일 KST 자정(00:00)마다 자동으로 `rotateLogs`를 실행하는 백그라운드 스케줄러를 시작합니다.
 * 매개변수:
 * - options {object} [{}]: `{ logsDir, retentionDays = 7, loggerPrefix = "[LogRotator]", runStartupCheck = true }`
 * 반환값: {{stop: Function}} 스케줄러 중지 핸들
 * 부수효과/예외 처리: 타이머에 `unref()`를 호출해 서버 종료를 방해하지 않으며, 예외 발생 시 경고만 로깅하고 다음 자정 예약을 유지합니다.
 */
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

  // [Antigravity-Doc] 최대 1시간 간격으로 깨어나 KST 날짜 경계 도달 여부를 확인하는 자기 재예약 타이머
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

  // [Antigravity-Doc] 스케줄러 시작 직후 전일 미분할 로그가 남아 있다면 비동기로 정리
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

/**
 * [Antigravity-Doc]
 * 역할: CLI 실행 시 환경 변수 또는 프로젝트 루트 `.env` 파일에서 `LOG_RETENTION_DAYS` 값을 읽어옵니다.
 * 매개변수:
 * - projectRoot {string}: `.env`가 위치한 프로젝트 루트 경로
 * 반환값: {string|undefined} 설정된 보관 일수 문자열 또는 미설정 시 `undefined`
 */
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

/**
 * [Antigravity-Doc]
 * 역할: CLI 인자(`--startup`, `--midnight`, `--force`, `--init`, `--logs-dir`, `--retention-days`)를 파싱해 `rotateLogs`를 실행합니다.
 * 매개변수:
 * - argv {string[]} [process.argv.slice(2)]: 커맨드라인 인자 배열
 * 반환값: {Promise<object>} `rotateLogs` 실행 결과
 */
export async function runCli(argv = process.argv.slice(2)) {
  let mode = "auto";
  let force = false;
  let initOnly = false;
  let logsDir = path.join(DEFAULT_PROJECT_ROOT, "logs");
  let retentionDays = readRetentionFromDotEnv(DEFAULT_PROJECT_ROOT);

  // [Antigravity-Doc] 지원 CLI 플래그 순차 파싱
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

// [Antigravity-Doc] 이 모듈을 CLI 스크립트로 직접 실행한 경우에만 runCli() 자동 기동
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((err) => {
    console.error("[LogRotator] Fatal error:", err);
    process.exit(1);
  });
}