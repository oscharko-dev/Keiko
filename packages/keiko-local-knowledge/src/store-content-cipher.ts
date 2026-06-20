// Store content cipher — the single crypto boundary for Local Knowledge encryption at rest
// (Issue #1322, Epic #1319; ADR-0047). Resolves a 32-byte AES-256-GCM key once at store-open and
// binds it into a `StoreContentCipher` that the row layer threads through every read/write of the
// three reconstructive content columns (document_texts.normalized_text,
// document_text_windows.normalized_text, vectors.embedding). The key NEVER appears in an error
// message, event, or persisted row; only sealed envelopes touch SQLite.
//
// Mirrors keiko-memory-vault's MemoryContentCipher (ADR-0035): crypto knowledge lives only here, so
// retrieval/parsing/UI layers stay crypto-free and just call seal*/open* at the column boundary.
//
// Plaintext mode binds the identity cipher (PLAINTEXT_CONTENT_CIPHER), so every call site is
// byte-for-byte unchanged when no key provider is supplied. Encryption is therefore opt-in per
// store-open: keiko-server injects a key provider for production stores; the in-package evaluation
// harness and tests open plaintext stores unchanged.

import {
  isSealed,
  openBytes,
  openString,
  sealBytes,
  sealString,
} from "@oscharko-dev/keiko-security";

import { KnowledgeStoreError } from "./errors.js";

const KEY_BYTES = 32;

export interface StoreContentCipher {
  // true only for the encrypted cipher. The span reader branches on this so the plaintext path keeps
  // its in-SQL SUBSTR (no full materialization) while the encrypted path decrypts one bounded unit.
  readonly isEncrypted: boolean;
  // Seals/opens a TEXT content column. openText tolerates legacy plaintext (a value written before
  // encryption, or by the not-yet-swept migration window) by returning it verbatim, so reads never
  // fail mid-migration. A sealed value opened with the wrong key throws loudly (secretbox auth fail).
  readonly sealText: (plaintext: string) => string;
  readonly openText: (stored: string) => string;
  // Seals/opens a BLOB content column. There is no in-band plaintext-vs-sealed marker for raw bytes,
  // so openVector uses the cleartext vector_dimensions to compute the expected plaintext byte length:
  // a stored blob of exactly that length is legacy plaintext, anything else is a sealed binary
  // envelope authenticated by openBytes (throws loudly on a wrong key or tampered data).
  readonly sealVector: (plaintext: Uint8Array) => Uint8Array;
  readonly openVector: (stored: Uint8Array, plaintextByteLength: number) => Uint8Array;
  // Whether a TEXT value is already a sealed envelope. Used by the migration sweep for idempotency
  // (skip already-sealed rows) and by the key-verification probe (a probe must be sealed). Keeping it
  // on the cipher keeps the migration module crypto-free.
  readonly isSealed: (value: string) => boolean;
}

// Identity cipher for plaintext stores. Every method is a no-op pass-through so a store opened
// without a key provider behaves exactly as it did before encryption existed.
export const PLAINTEXT_CONTENT_CIPHER: StoreContentCipher = {
  isEncrypted: false,
  sealText: (plaintext: string): string => plaintext,
  openText: (stored: string): string => stored,
  sealVector: (plaintext: Uint8Array): Uint8Array => plaintext,
  openVector: (stored: Uint8Array): Uint8Array => stored,
  isSealed: (): boolean => false,
};

export function createEncryptedContentCipher(key: Uint8Array): StoreContentCipher {
  // Copy into a Buffer so the cipher owns its key material and a caller mutating the provider's array
  // cannot retroactively change the key. Length is validated here (not deeper) so a misconfigured key
  // provider fails at store-open with a clear, secret-free message.
  const keyBuf = Buffer.from(key);
  if (keyBuf.length !== KEY_BYTES) {
    throw new KnowledgeStoreError("encrypted local-knowledge store key must be exactly 32 bytes");
  }
  return {
    isEncrypted: true,
    sealText: (plaintext: string): string => sealString(keyBuf, plaintext),
    openText: (stored: string): string => (isSealed(stored) ? openString(keyBuf, stored) : stored),
    sealVector: (plaintext: Uint8Array): Uint8Array => sealBytes(keyBuf, Buffer.from(plaintext)),
    openVector: (stored: Uint8Array, plaintextByteLength: number): Uint8Array =>
      stored.byteLength === plaintextByteLength ? stored : openBytes(keyBuf, Buffer.from(stored)),
    isSealed,
  };
}
