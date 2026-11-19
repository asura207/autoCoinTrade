/**
 * tests/verify_crypto_vault.mjs
 *
 * [Prompt 5 Verification Suite]
 * 1. AES-256-GCM encrypt/decrypt roundtrip + random IV non-determinism
 * 2. Ciphertext & Auth-Tag tamper detection (strict throw + safe fallback)
 * 3. Legacy plaintext config transparent read & auto-migration on disk (0600 chmod, no plaintext leak)
 * 4. Cross-language interop: Node.js crypto_vault.mjs ciphertext decrypted by Python llm_filter_worker._decrypt_vault_secret()
 * 5. DevSecOps artifacts presence check (Dockerfile, docker-compose.yml, .dockerignore, .github/workflows/ci.yml)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocoin-vault-test-"));
const TMP_KEY_PATH = path.join(TMP_DIR, ".vault_master_key");
const TMP_CFG_PATH = path.join(TMP_DIR, "upbit_config.json");
const TEST_MASTER_KEY = "autocoin-cross-lang-test-master-key-2026-secure!";

process.env.AUTOCOIN_LIBRARY_MODE = "1";
process.env.AUTOCOIN_MASTER_KEY = TEST_MASTER_KEY;
process.env.AUTOCOIN_VAULT_KEY_PATH = TMP_KEY_PATH;

const results = [];

try {
  const {
    VAULT_PREFIX,
    encryptSecret,
    decryptSecret,
    safeDecryptSecret,
    isEncryptedVaultValue,
    migrateConfigSecrets,
  } = await import("../backend/common/crypto_vault.mjs");

  // 1. Encrypt / Decrypt Roundtrip + Random IV
  const sampleSecret = "UpbitSuperSecretAccessKey_9988776655";
  const enc1 = encryptSecret(sampleSecret);
  const enc2 = encryptSecret(sampleSecret);
  assert.ok(enc1.startsWith(VAULT_PREFIX), "Encrypted value must start with enc:v1:");
  assert.equal(isEncryptedVaultValue(enc1), true);
  assert.notEqual(enc1, enc2, "Random 12-byte IV must produce unique ciphertexts");
  assert.equal(decryptSecret(enc1), sampleSecret);
  assert.equal(decryptSecret(enc2), sampleSecret);
  results.push({ check: "AES-256-GCM Roundtrip & Unique IV", status: "PASS", detail: `format=${enc1.slice(0, 26)}...` });

  // 2. Auth-Tag & Ciphertext Tamper Rejection
  const parts = enc1.slice(VAULT_PREFIX.length).split(":");
  const tamperedTag = `${parts[1].slice(0, -2)}${parts[1].endsWith("ff") ? "00" : "ff"}`;
  const tamperedCipher = `${VAULT_PREFIX}${parts[0]}:${tamperedTag}:${parts[2]}`;

  assert.throws(
    () => decryptSecret(tamperedCipher),
    /decryption failed/i,
    "Tampered GCM auth tag MUST throw in decryptSecret"
  );
  assert.equal(safeDecryptSecret(tamperedCipher), "", "safeDecryptSecret must safely return empty string on tamper");

  // Wrong master key must also fail GCM authentication
  assert.throws(
    () => decryptSecret(enc1, { masterKey: "wrong-master-key-definitely-invalid" }),
    /decryption failed/i,
    "Wrong master key MUST fail GCM verification"
  );
  results.push({ check: "GCM AuthTag Tamper & Wrong-Key Rejection", status: "PASS", detail: "Strict throw + safe fallback verified" });

  // 3. Plaintext Config Transparent Migration on Disk (0600 permissions)
  const legacyPlainCfg = {
    access_key: "PLAIN_ACCESS_KEY_123456",
    secret_key: "PLAIN_SECRET_KEY_ABCDEF",
    gemini_api_key: "GEMINI_TEST_KEY_987654321",
    trade_mode: "paper",
  };
  fs.writeFileSync(TMP_CFG_PATH, JSON.stringify(legacyPlainCfg, null, 2), "utf8");

  const migRes = migrateConfigSecrets(TMP_CFG_PATH);
  assert.equal(migRes.migrated, true, "Plaintext config must trigger migration");
  assert.equal(migRes.decryptedConfig.access_key, "PLAIN_ACCESS_KEY_123456");
  assert.equal(migRes.decryptedConfig.secret_key, "PLAIN_SECRET_KEY_ABCDEF");
  assert.equal(migRes.decryptedConfig.gemini_api_key, "GEMINI_TEST_KEY_987654321");

  const rawDiskText = fs.readFileSync(TMP_CFG_PATH, "utf8");
  assert.ok(!rawDiskText.includes("PLAIN_ACCESS_KEY_123456"), "Raw config on disk must NOT contain plaintext access_key");
  assert.ok(!rawDiskText.includes("PLAIN_SECRET_KEY_ABCDEF"), "Raw config on disk must NOT contain plaintext secret_key");
  assert.ok(!rawDiskText.includes("GEMINI_TEST_KEY_987654321"), "Raw config on disk must NOT contain plaintext gemini_api_key");
  const diskJson = JSON.parse(rawDiskText);
  assert.equal(isEncryptedVaultValue(diskJson.access_key), true);
  assert.equal(isEncryptedVaultValue(diskJson.secret_key), true);
  assert.equal(isEncryptedVaultValue(diskJson.gemini_api_key), true);
  const modeBits = fs.statSync(TMP_CFG_PATH).mode & 0o777;
  assert.equal(modeBits, 0o600, "Migrated config file must have 0600 permissions");

  // Re-running migration on already-encrypted config is idempotent
  const secondMig = migrateConfigSecrets(TMP_CFG_PATH);
  assert.equal(secondMig.migrated, false, "Already encrypted config must be idempotent");
  assert.equal(secondMig.decryptedConfig.gemini_api_key, "GEMINI_TEST_KEY_987654321");
  results.push({ check: "Plaintext -> Vault Disk Migration (0600)", status: "PASS", detail: "Zero plaintext on disk, idempotent re-run" });

  // 4. Cross-Language Interop: Node.js encryptSecret -> Python llm_filter_worker._decrypt_vault_secret
  const pyBin = fs.existsSync(path.resolve(".venv/bin/python")) ? path.resolve(".venv/bin/python") : "python3";
  const crossSecret = "AIzaTestCrossLanguageVaultInteropSecret_012345";
  const nodeEncrypted = encryptSecret(crossSecret);
  const pyScript = `
import os, sys
sys.path.insert(0, os.getcwd())
import llm_filter_worker as lfw
dec = lfw._decrypt_vault_secret(sys.argv[1])
print(dec, end="")
`;
  const pyOut = execFileSync(pyBin, ["-c", pyScript, nodeEncrypted], {
    env: { ...process.env, AUTOCOIN_MASTER_KEY: TEST_MASTER_KEY },
    encoding: "utf8",
  });
  assert.equal(pyOut, crossSecret, "Python _decrypt_vault_secret must decrypt Node.js AES-256-GCM ciphertext identically");
  results.push({ check: "Node.js <-> Python Vault Interop", status: "PASS", detail: "Python decrypted Node AES-256-GCM ciphertext identically" });

  // 5. DevSecOps Artifacts Verification
  for (const relPath of ["Dockerfile", "docker-compose.yml", ".dockerignore", ".github/workflows/ci.yml"]) {
    const absPath = path.resolve(relPath);
    assert.ok(fs.existsSync(absPath), `Required DevSecOps file must exist: ${relPath}`);
    const content = fs.readFileSync(absPath, "utf8");
    assert.ok(content.length > 50, `${relPath} must be non-empty`);
  }
  const dockerfileText = fs.readFileSync(path.resolve("Dockerfile"), "utf8");
  assert.ok(dockerfileText.includes("USER autocoin"), "Dockerfile must run as non-root user");
  assert.ok(dockerfileText.includes("HEALTHCHECK"), "Dockerfile must include HEALTHCHECK");
  results.push({ check: "DevSecOps Artifacts (Docker & CI)", status: "PASS", detail: "Dockerfile(non-root+HEALTHCHECK), compose, .dockerignore, ci.yml OK" });

  console.log("\n=== [Prompt 5] AES-256-GCM Crypto Vault & DevSecOps Verification ===");
  console.table(results);
} finally {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}
