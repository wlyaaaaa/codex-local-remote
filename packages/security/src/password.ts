import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_VERSION = 1;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

const COMMON_PASSWORDS = new Set([
  "123456789",
  "adminadmin",
  "changeme",
  "letmein",
  "password",
  "password1",
  "password123",
  "qwerty123",
]);

export interface PasswordStrengthResult {
  ok: boolean;
  issues: string[];
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function checkPasswordStrength(password: string): PasswordStrengthResult {
  const issues: string[] = [];
  const length = codePointLength(password);
  const byteLength = Buffer.byteLength(password, "utf8");
  const normalized = password
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]/gu, "");

  if (length < 15) {
    issues.push("too-short");
  }
  if (length > 256 || byteLength > 1_024) {
    issues.push("too-long");
  }
  if (password.trim().length === 0) {
    issues.push("blank");
  }
  if (
    COMMON_PASSWORDS.has(normalized) ||
    normalized.startsWith("password") ||
    normalized.startsWith("qwerty")
  ) {
    issues.push("common");
  }
  if (new Set(Array.from(normalized)).size < 6) {
    issues.push("too-repetitive");
  }

  return { ok: issues.length === 0, issues };
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const strength = checkPasswordStrength(password);
  if (!strength.ok) {
    throw new Error(`Password does not meet policy: ${strength.issues.join(",")}`);
  }

  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt);
  return [
    "scrypt",
    `v=${SCRYPT_VERSION}`,
    `N=${SCRYPT_N}`,
    `r=${SCRYPT_R}`,
    `p=${SCRYPT_P}`,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (codePointLength(password) > 256 || Buffer.byteLength(password, "utf8") > 1_024) {
    return false;
  }
  const parts = encodedHash.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "scrypt" ||
    parts[1] !== `v=${SCRYPT_VERSION}` ||
    parts[2] !== `N=${SCRYPT_N}` ||
    parts[3] !== `r=${SCRYPT_R}` ||
    parts[4] !== `p=${SCRYPT_P}`
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[5] ?? "", "base64url");
    const expected = Buffer.from(parts[6] ?? "", "base64url");
    if (
      salt.length !== SCRYPT_SALT_LENGTH ||
      expected.length !== SCRYPT_KEY_LENGTH ||
      salt.toString("base64url") !== parts[5] ||
      expected.toString("base64url") !== parts[6]
    ) {
      return false;
    }
    const actual = await deriveKey(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
