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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");

export const VAULT_PREFIX = "enc:v1:";
export const VAULT_SECRET_FIELDS = ["access_key", "secret_key", "gemini_api_key"];
const PBKDF2_SALT = "autocoin-vault-salt-v1";
const PBKDF2_ITERATIONS = 100000;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

const PLACEHOLDER_SECRETS = new Set([
  "YOUR_UPBIT_ACCESS_KEY",
  "YOUR_UPBIT_SECRET_KEY",
  "YOUR_GEMINI_API_KEY_HERE",
]);

const derivedKeyCache = new Map();

export function resolveVaultKeyFilePath(customPath = "") {
  const raw = customPath || process.env.AUTOCOIN_VAULT_KEY_PATH || path.join(ROOT_DIR, "data", ".vault_master_key");
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw);
}

export function getOrCreateMasterKeyMaterial(options = {}) {
  if (options?.masterKey && String(options.masterKey).trim()) {
    return String(options.masterKey).trim();
  }
  if (process.env.AUTOCOIN_MASTER_KEY && String(process.env.AUTOCOIN_MASTER_KEY).trim()) {
    return String(process.env.AUTOCOIN_MASTER_KEY).trim();
  }
  const keyFilePath = resolveVaultKeyFilePath(options?.keyFilePath);
  try {
    if (fs.existsSync(keyFilePath)) {
      const existing = fs.readFileSync(keyFilePath, "utf8").trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
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

export function isEncryptedSecret(val) {
  return typeof val === "string" && val.startsWith(VAULT_PREFIX);
}

export const isEncryptedVaultValue = isEncryptedSecret;

export function isPlaceholderSecret(val) {
  if (!val || typeof val !== "string") return true;
  const trimmed = val.trim();
  return !trimmed || PLACEHOLDER_SECRETS.has(trimmed);
}

export function encryptSecret(plaintext, options = {}) {
  if (plaintext === null || plaintext === undefined) return "";
  const str = String(plaintext).trim();
  if (!str || PLACEHOLDER_SECRETS.has(str)) return str;
  if (isEncryptedSecret(str)) return str;

  const masterMaterial = getOrCreateMasterKeyMaterial(options);
  const key = deriveAes256Key(masterMaterial);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${VAULT_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(value, options = {}) {
  if (value === null || value === undefined) return "";
  const str = String(value).trim();
  if (!str) return "";
  if (!isEncryptedSecret(str)) {
    // 레거시 평문 하위 호환성 100% 보장
    return str;
  }

  const body = str.slice(VAULT_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    if (options?.strict === false) return "";
    throw new Error("Invalid encrypted secret format (expected enc:v1:iv:tag:cipher)");
  }

  const [ivHex, tagHex, cipherHex] = parts;
  if (ivHex.length !== IV_LEN * 2 || tagHex.length !== TAG_LEN * 2 || !/^[0-9a-fA-F]+$/.test(ivHex + tagHex)) {
    if (options?.strict === false) return "";
    throw new Error("Invalid IV or AuthTag hex in encrypted secret");
  }

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

export function safeDecryptSecret(value, options = {}) {
  return decryptSecret(value, { ...options, strict: false });
}

export function migrateConfigSecrets(
  rawConfigOrPath = {},
  secretFields = VAULT_SECRET_FIELDS,
  options = {}
) {
  let filePath = null;
  let rawConfig = rawConfigOrPath;
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

  if (filePath && migrated) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(encryptedConfig, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }

  return { encryptedConfig, decryptedConfig, migrated };
}
