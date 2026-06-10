// AES-256-GCM authenticated encryption primitive — the leaf crypto boundary for at-rest secrecy.
// Two envelope formats share one key and one AAD so a value sealed by either path is bound to this
// domain and cannot be replayed into another:
//
//   string envelope:  "kv1.<base64url(nonce12)>.<base64url(ciphertext||tag16)>"
//   binary envelope:  0x01 || nonce12 || ciphertext || tag16   (one Buffer, no separators)
//
// GCM gives confidentiality AND integrity: open() recomputes the 16-byte auth tag and throws on
// any mismatch, so a tampered ciphertext or a wrong key both fail loudly (never silent corruption).
// The nonce is a fresh 12 random bytes per call — the GCM-safe size, and random-per-call keeps us
// far from the birthday bound for the local single-DB write volume in scope. AAD pins every
// envelope to "keiko-memory-v1" so a ciphertext lifted from another keiko surface won't open here.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretboxError } from "./errors/secretbox.js";

const STRING_PREFIX = "kv1.";
const BINARY_VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("keiko-memory-v1");

function encrypt(key: Buffer, nonce: Buffer, plaintext: Buffer): { ct: Buffer; tag: Buffer } {
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ct, tag: cipher.getAuthTag() };
}

// All decrypt failures funnel through here as a single SecretboxError class — Node throws a generic
// Error on auth-tag mismatch, which we normalise so callers branch on the type, not the message.
function decrypt(key: Buffer, nonce: Buffer, ct: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SecretboxError("secretbox: authentication failed (wrong key or tampered data)");
  }
}

export function sealString(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const { ct, tag } = encrypt(key, nonce, Buffer.from(plaintext, "utf8"));
  const body = Buffer.concat([ct, tag]);
  return `${STRING_PREFIX}${nonce.toString("base64url")}.${body.toString("base64url")}`;
}

export function openString(key: Buffer, envelope: string): string {
  if (!isSealed(envelope)) {
    throw new SecretboxError("secretbox: envelope is missing the kv1 prefix");
  }
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    throw new SecretboxError("secretbox: envelope must have three parts");
  }
  const nonce = Buffer.from(parts[1] ?? "", "base64url");
  const body = Buffer.from(parts[2] ?? "", "base64url");
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) {
    throw new SecretboxError("secretbox: envelope nonce or body length is invalid");
  }
  const ct = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  return decrypt(key, nonce, ct, tag).toString("utf8");
}

export function sealBytes(key: Buffer, buf: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const { ct, tag } = encrypt(key, nonce, buf);
  return Buffer.concat([Buffer.from([BINARY_VERSION]), nonce, ct, tag]);
}

export function openBytes(key: Buffer, envelope: Buffer): Buffer {
  const minLength = 1 + NONCE_BYTES + TAG_BYTES;
  if (envelope.length < minLength || envelope[0] !== BINARY_VERSION) {
    throw new SecretboxError("secretbox: binary envelope is malformed or has an unknown version");
  }
  const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
  const ct = envelope.subarray(1 + NONCE_BYTES, envelope.length - TAG_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  return decrypt(key, nonce, ct, tag);
}

export function isSealed(value: string): boolean {
  return value.startsWith(STRING_PREFIX);
}
