/**
 * [Antigravity-Doc]
 * 파일 역할: 업비트 API 키, Gemini API 키, 알림 토큰 등 민감 비밀값을 AES-256-GCM으로 암·복호화하는 볼트(Vault) 보안 모듈
 * 아키텍처:
 * - 마스터 키 시드는 `options.masterKey` -> `process.env.AUTOCOIN_MASTER_KEY` -> `data/.vault_master_key` 파일(0600 권한 자동 생성) 순으로 결정합니다.
 * - PBKDF2-HMAC-SHA256(100,000회)으로 32바이트 AES 키를 파생하며, 반복 연산 비용을 줄이기 위해 인메모리 캐시(`derivedKeyCache`)를 사용합니다.
 * - 암호문은 `enc:v1:<ivHex>:<authTagHex>:<cipherHex>` 포맷을 따르며, 접두사가 없는 기존 평문 데이터도 하위 호환으로 복호화/마이그레이션할 수 있습니다.
 * 주요 의존성: `node:crypto`, `node:fs`, `node:path`, `node:url`
 * 수정 시 주의사항:
 * - `VAULT_PREFIX`, `PBKDF2_SALT`, `PBKDF2_ITERATIONS`, `IV_LEN`, `TAG_LEN`을 변경하면 기존에 암호화된 DB/설정 파일 값을 복호화할 수 없게 됩니다.
 * - `getOrCreateMasterKeyMaterial`의 catch 폴백 블록에서 참조하는 `os`는 파일 상단에 import되어 있지 않으므로, 파일 시스템 권한 오류 환경에서는 주의가 필요합니다(기존 코드 유지).
 */
/**
 * backend/common/crypto_vault.mjs
 *
 * Node.js 내장 node:crypto 기반 AES-256-GCM API 키 암호화 볼트(Vault)
 * - 암호문 포맷: enc:v1:<12byte_iv_hex>:<16byte_auth_tag_hex>:<ciphertext_hex>
 * - 마스터 키: process.env.AUTOCOIN_MASTER_KEY 우선 참조, 미설정 시 data/.vault_master_key (0600 권한) 자동 생성
 * - 레거시 평문 호환: enc:v1: 접두사가 없는 기존 평문 키는 투명하게 그대로 반환 후 저장 시 자동 암호화 마이그레이션
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// [Antigravity-Doc] ESM 모듈 경로 및 프로젝트 루트 디렉터리 계산
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");

// [Antigravity-Doc] 암호문 버전 접두사 및 기본 암호화 대상 설정 필드 목록
export const VAULT_PREFIX = "enc:v1:";
export const VAULT_SECRET_FIELDS = ["access_key", "secret_key", "gemini_api_key"];
// [Antigravity-Doc] PBKDF2 키 파생 파라미터 및 AES-256-GCM 규격 상수 (키 32바이트, IV 12바이트, 인증 태그 16바이트)
const PBKDF2_SALT = "autocoin-vault-salt-v1";
const PBKDF2_ITERATIONS = 100000;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

// [Antigravity-Doc] 템플릿 예시 값(플레이스홀더) 목록: 실제 키가 아니므로 암호화 대상에서 제외
const PLACEHOLDER_SECRETS = new Set([
  "YOUR_UPBIT_ACCESS_KEY",
  "YOUR_UPBIT_SECRET_KEY",
  "YOUR_GEMINI_API_KEY_HERE",
]);

// [Antigravity-Doc] 마스터 키 문자열별 PBKDF2 파생 키(Buffer) 캐시 (최대 16개 유지하여 메모리 누수 방지)
const derivedKeyCache = new Map();

/**
 * [Antigravity-Doc]
 * 역할: 마스터 키 파일의 절대 경로를 계산합니다.
 * 매개변수:
 * - customPath {string} [""]: 호출부가 직접 지정한 키 파일 경로 (미지정 시 `AUTOCOIN_VAULT_KEY_PATH` -> `data/.vault_master_key` 순)
 * 반환값: {string} 정규화된 절대 파일 경로
 */
export function resolveVaultKeyFilePath(customPath = "") {
  const raw = customPath || process.env.AUTOCOIN_VAULT_KEY_PATH || path.join(ROOT_DIR, "data", ".vault_master_key");
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw);
}

/**
 * [Antigravity-Doc]
 * 역할: 암호화/복호화에 사용할 마스터 키 원문(Material)을 조회하거나, 없을 경우 256비트 난수로 신규 생성해 파일에 저장합니다.
 * 매개변수:
 * - options {object} [{}]: `{ masterKey, keyFilePath }` 오버라이드 옵션
 * 반환값: {string} 마스터 키 문자열
 * 부수효과/예외 처리: 키 파일이 없으면 디렉터리를 생성하고 `0600`(소유자 전용 읽기/쓰기) 권한으로 키 파일을 기록합니다.
 */
export function getOrCreateMasterKeyMaterial(options = {}) {
  // [Antigravity-Doc] 1순위: 함수 인자로 명시된 masterKey
  if (options?.masterKey && String(options.masterKey).trim()) {
    return String(options.masterKey).trim();
  }
  // [Antigravity-Doc] 2순위: 프로세스 환경 변수 AUTOCOIN_MASTER_KEY
  if (process.env.AUTOCOIN_MASTER_KEY && String(process.env.AUTOCOIN_MASTER_KEY).trim()) {
    return String(process.env.AUTOCOIN_MASTER_KEY).trim();
  }
  // [Antigravity-Doc] 3순위: 로컬 키 파일 읽기 (최소 32자 이상일 때만 유효 키로 인정)
  const keyFilePath = resolveVaultKeyFilePath(options?.keyFilePath);
  try {
    if (fs.existsSync(keyFilePath)) {
      const existing = fs.readFileSync(keyFilePath, "utf8").trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
    // [Antigravity-Doc] 키 파일이 없거나 손상된 경우 32바이트(64 hex 문자) 난수 마스터 키 신규 생성 및 0600 권한 고정
    const dir = path.dirname(keyFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(keyFilePath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(keyFilePath, 0o600);
    } catch {}
    return generated;
  } catch (err) {
    // 파일 시스템 쓰기 불가 예외 시 프로세스 고정 폴백 시드
    return `fallback-host-key-${os.hostname?.() || "local"}-${ROOT_DIR}`;
  }
}

/**
 * [Antigravity-Doc]
 * 역할: 마스터 키 원문에서 PBKDF2-SHA256으로 32바이트 AES-256 키를 파생하고 캐시합니다.
 * 매개변수:
 * - masterMaterial {string}: 마스터 키 시드 문자열
 * 반환값: {Buffer} 32바이트 대칭키 버퍼
 * 부수효과/예외 처리: 캐시 크기가 16개를 초과하면 전체 캐시를 비워 테스트/다중 키 환경에서의 메모리 누수를 방지합니다.
 */
function deriveAes256Key(masterMaterial) {
  if (derivedKeyCache.has(masterMaterial)) {
    return derivedKeyCache.get(masterMaterial);
  }
  const key = crypto.pbkdf2Sync(masterMaterial, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LEN, "sha256");
  if (derivedKeyCache.size > 16) {
    derivedKeyCache.clear();
  }
  derivedKeyCache.set(masterMaterial, key);
  return key;
}

/**
 * [Antigravity-Doc]
 * 역할: 주어진 값이 볼트 암호문 포맷(`enc:v1:...`)인지 판별합니다.
 * 매개변수:
 * - val {any}: 검사할 값
 * 반환값: {boolean} 암호문 여부
 */
export function isEncryptedSecret(val) {
  return typeof val === "string" && val.startsWith(VAULT_PREFIX);
}

// [Antigravity-Doc] 외부 모듈 호환을 위한 isEncryptedSecret 별칭 export
export const isEncryptedVaultValue = isEncryptedSecret;

/**
 * [Antigravity-Doc]
 * 역할: 값이 비어 있거나 문자열이 아니거나 기본 플레이스홀더(예: `YOUR_UPBIT_ACCESS_KEY`)인지 판별합니다.
 * 매개변수:
 * - val {any}: 검사할 비밀값
 * 반환값: {boolean} 실제 설정되지 않은 플레이스홀더/빈 값이면 `true`
 */
export function isPlaceholderSecret(val) {
  if (!val || typeof val !== "string") return true;
  const trimmed = val.trim();
  return !trimmed || PLACEHOLDER_SECRETS.has(trimmed);
}

/**
 * [Antigravity-Doc]
 * 역할: 평문 비밀 문자열을 AES-256-GCM으로 암호화하여 `enc:v1:<iv>:<tag>:<cipher>` 포맷으로 반환합니다.
 * 매개변수:
 * - plaintext {string|null|undefined}: 암호화할 평문
 * - options {object} [{}]: 마스터 키 오버라이드 옵션
 * 반환값: {string} 암호문 문자열 (빈 값, 플레이스홀더, 이미 암호화된 문자열은 재암호화하지 않고 그대로 반환)
 * 부수효과/예외 처리: 매 호출마다 12바이트 무작위 IV를 새로 생성해 동일 평문이라도 매번 다른 암호문이 생성됩니다.
 */
export function encryptSecret(plaintext, options = {}) {
  if (plaintext === null || plaintext === undefined) return "";
  const str = String(plaintext).trim();
  // [Antigravity-Doc] 빈 문자열, 플레이스홀더, 이미 암호화된 값은 이중 암호화를 막기 위해 원본 유지
  if (!str || PLACEHOLDER_SECRETS.has(str)) return str;
  if (isEncryptedSecret(str)) return str;

  // [Antigravity-Doc] 마스터 키 파생 및 랜덤 IV 기반 AES-256-GCM 암호화 수행
  const masterMaterial = getOrCreateMasterKeyMaterial(options);
  const key = deriveAes256Key(masterMaterial);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${VAULT_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * [Antigravity-Doc]
 * 역할: `enc:v1:...` 포맷의 암호문을 AES-256-GCM으로 검증 및 복호화하여 원문 문자열을 반환합니다.
 * 매개변수:
 * - value {string|null|undefined}: 복호화할 암호문 또는 레거시 평문
 * - options {object} [{}]: `{ masterKey, keyFilePath, strict }` (`strict: false` 시 포맷/인증 오류에 예외 대신 빈 문자열 반환)
 * 반환값: {string} 복호화된 평문 문자열
 * 부수효과/예외 처리: `enc:v1:` 접두사가 없으면 레거시 평문으로 간주해 그대로 반환합니다. `strict !== false` 상태에서 변조·키 불일치 시 Error를 throw합니다.
 */
export function decryptSecret(value, options = {}) {
  if (value === null || value === undefined) return "";
  const str = String(value).trim();
  if (!str) return "";
  if (!isEncryptedSecret(str)) {
    // 레거시 평문 하위 호환성 100% 보장
    return str;
  }

  // [Antigravity-Doc] 접두사 제거 후 iv:tag:cipher 3분할 구조 검증
  const body = str.slice(VAULT_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    if (options?.strict === false) return "";
    throw new Error("Invalid encrypted secret format (expected enc:v1:iv:tag:cipher)");
  }

  // [Antigravity-Doc] IV(24 hex자)와 AuthTag(32 hex자)의 길이 및 16진수 유효성 검증
  const [ivHex, tagHex, cipherHex] = parts;
  if (ivHex.length !== IV_LEN * 2 || tagHex.length !== TAG_LEN * 2 || !/^[0-9a-fA-F]+$/.test(ivHex + tagHex)) {
    if (options?.strict === false) return "";
    throw new Error("Invalid IV or AuthTag hex in encrypted secret");
  }

  // [Antigravity-Doc] GCM 인증 태그를 설정하여 위변조 검증과 동시에 복호화 실행
  try {
    const masterMaterial = getOrCreateMasterKeyMaterial(options);
    const key = deriveAes256Key(masterMaterial);
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const ciphertext = cipherHex ? Buffer.from(cipherHex, "hex") : Buffer.alloc(0);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    if (options?.strict === false) {
      return "";
    }
    throw new Error(`Vault AES-256-GCM decryption failed (tampered or wrong master key): ${err.message}`);
  }
}

/**
 * [Antigravity-Doc]
 * 역할: 복호화 실패 시 예외를 던지지 않고 빈 문자열(`""`)을 반환하는 안전 복호화 헬퍼입니다.
 * 매개변수:
 * - value {string}: 암호문 또는 평문
 * - options {object} [{}]: 추가 옵션 (`strict: false` 강제 적용)
 * 반환값: {string} 복호화된 문자열 또는 실패 시 `""`
 */
export function safeDecryptSecret(value, options = {}) {
  return decryptSecret(value, { ...options, strict: false });
}

/**
 * [Antigravity-Doc]
 * 역할: 설정 객체 또는 JSON 설정 파일 경로에서 지정된 비밀 필드들의 평문을 자동 암호화 마이그레이션하고, 암호화본과 복호화본을 함께 반환합니다.
 * 매개변수:
 * - rawConfigOrPath {object|string} [{}]: 설정 객체 또는 JSON 파일 절대 경로
 * - secretFields {string[]} [VAULT_SECRET_FIELDS]: 암·복호화 대상 필드명 배열
 * - options {object} [{}]: 마스터 키 등 볼트 옵션
 * 반환값: {{encryptedConfig: object, decryptedConfig: object, migrated: boolean}} 디스크 저장용 암호화 객체, 런타임용 복호화 객체, 평문->암호문 전환 발생 여부
 * 부수효과/예외 처리: 파일 경로가 전달되고 평문 필드가 암호화(`migrated === true`)된 경우 원본 JSON 파일을 `0600` 권한으로 덮어씁니다.
 */
export function migrateConfigSecrets(
  rawConfigOrPath = {},
  secretFields = VAULT_SECRET_FIELDS,
  options = {}
) {
  let filePath = null;
  let rawConfig = rawConfigOrPath;
  // [Antigravity-Doc] 문자열 경로 입력 시 JSON 파일을 직접 로드 (파일 부재 또는 파싱 실패 시 빈 결과 반환)
  if (typeof rawConfigOrPath === "string") {
    filePath = rawConfigOrPath;
    if (!fs.existsSync(filePath)) {
      return { encryptedConfig: {}, decryptedConfig: {}, migrated: false };
    }
    try {
      rawConfig = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return { encryptedConfig: {}, decryptedConfig: {}, migrated: false };
    }
  }
  if (!rawConfig || typeof rawConfig !== "object") {
    return { encryptedConfig: {}, decryptedConfig: {}, migrated: false };
  }
  const encryptedConfig = { ...rawConfig };
  const decryptedConfig = { ...rawConfig };
  let migrated = false;

  // [Antigravity-Doc] 각 비밀 필드를 순회하며 플레이스홀더는 유지, 기존 암호문은 복호화, 평문은 신규 암호화(migrated=true) 처리
  for (const field of secretFields) {
    if (!(field in rawConfig)) continue;
    const rawVal = String(rawConfig[field] ?? "").trim();
    if (!rawVal || isPlaceholderSecret(rawVal)) {
      encryptedConfig[field] = rawVal;
      decryptedConfig[field] = rawVal;
      continue;
    }
    if (isEncryptedSecret(rawVal)) {
      encryptedConfig[field] = rawVal;
      decryptedConfig[field] = safeDecryptSecret(rawVal, options);
    } else {
      decryptedConfig[field] = rawVal;
      encryptedConfig[field] = encryptSecret(rawVal, options);
      migrated = true;
    }
  }

  // [Antigravity-Doc] 파일 기반 호출에서 평문이 암호화되었으면 암호화본을 디스크에 0600 권한으로 영구 반영
  if (filePath && migrated) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(encryptedConfig, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }

  return { encryptedConfig, decryptedConfig, migrated };
}