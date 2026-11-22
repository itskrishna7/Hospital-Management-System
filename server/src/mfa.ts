import crypto from "node:crypto";
import { env } from "./config/env.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MFA_ISSUER = "MediVerse";

function encryptionKey() {
  return Buffer.from(crypto.hkdfSync("sha256", env.SESSION_SECRET!, "MediVerse MFA", "mfa-secret-encryption", 32));
}

export function encryptMfaSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptMfaSecret(value: string) {
  const [ivValue, tagValue, ciphertextValue] = value.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Stored MFA secret is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}

function encodeBase32(bytes: Buffer) {
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) encoded += BASE32[(buffer << (5 - bits)) & 31];
  return encoded;
}

function decodeBase32(value: string) {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/g, "")) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret.");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

export function generateMfaSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function createTotpUri(secret: string, account: string) {
  const label = encodeURIComponent(`${MFA_ISSUER}:${account}`);
  const query = new URLSearchParams({ secret, issuer: MFA_ISSUER, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function createTotpCode(secret: string, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  const submitted = Buffer.from(code);
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(createTotpCode(secret, timestamp + offset));
    if (crypto.timingSafeEqual(submitted, expected)) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => crypto.randomBytes(8).toString("hex"));
}

export function hashRecoveryCode(code: string) {
  return crypto.createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}
