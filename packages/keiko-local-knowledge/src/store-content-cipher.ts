// Store content cipher — the single crypto boundary for Local Knowledge encryption at rest
// (Issue #1322, Epic #1319; ADR-0047). Resolves a 32-byte AES-256-GCM key once at store-open and
// binds it into a `StoreContentCipher` that the row layer threads through every read/write of the
// reconstructive content columns (document_texts.normalized_text,
// document_text_windows.normalized_text, vectors.embedding, sections.section_path_json, and
// parsed_units path JSON). The key NEVER appears in an error message, event, or persisted row; only
// sealed envelopes touch SQLite.
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
  // Seals/opens a TEXT content column. Once an encrypted store handle is returned, openText is
  // strict: unsealed text, malformed envelopes, wrong-key content, and tampering fail closed. Legacy
  // plaintext tolerance lives only in the migration classifier, before the handle is returned.
  readonly sealText: (plaintext: string) => string;
  readonly openText: (stored: string) => string;
  // Seals/opens a BLOB content column. Encrypted openVector always authenticates the sealed binary
  // envelope and verifies the decrypted plaintext length. Legacy plaintext-length vectors are sealed
  // only by the migration sweep, never returned by a steady-state encrypted store.
  readonly sealVector: (plaintext: Uint8Array) => Uint8Array;
  readonly openVector: (stored: Uint8Array, plaintextByteLength: number) => Uint8Array;
  // Seals/opens arbitrary BLOB content. Used for bounded PDF preview blobs; callers still verify
  // content-hash and byte-length at the row boundary after opening.
  readonly sealBlob: (plaintext: Uint8Array) => Uint8Array;
  readonly openBlob: (stored: Uint8Array) => Uint8Array;
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
  sealBlob: (plaintext: Uint8Array): Uint8Array => plaintext,
  openBlob: (stored: Uint8Array): Uint8Array => stored,
  isSealed: (): boolean => false,
};

function openEncryptedText(keyBuf: Buffer, stored: string): string {
  if (!isSealed(stored)) {
    throw new KnowledgeStoreError("encrypted Local Knowledge text content is not sealed at rest");
  }
  try {
    return openString(keyBuf, stored);
  } catch (cause) {
    throw new KnowledgeStoreError(
      "cannot open encrypted Local Knowledge text content: wrong key or tampered content",
      { cause },
    );
  }
}

function openEncryptedBlob(keyBuf: Buffer, stored: Uint8Array): Uint8Array {
  try {
    return openBytes(keyBuf, Buffer.from(stored));
  } catch (cause) {
    throw new KnowledgeStoreError(
      "cannot open encrypted Local Knowledge blob content: wrong key or tampered content",
      { cause },
    );
  }
}

function openEncryptedVector(
  keyBuf: Buffer,
  stored: Uint8Array,
  plaintextByteLength: number,
): Uint8Array {
  let opened: Buffer;
  try {
    opened = openBytes(keyBuf, Buffer.from(stored));
  } catch (cause) {
    throw new KnowledgeStoreError(
      "cannot open encrypted Local Knowledge vector content: wrong key or tampered content",
      { cause },
    );
  }
  if (opened.byteLength !== plaintextByteLength) {
    throw new KnowledgeStoreError(
      "encrypted Local Knowledge vector content length does not match vector_dimensions",
    );
  }
  return opened;
}

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
    openText: (stored: string): string => openEncryptedText(keyBuf, stored),
    sealVector: (plaintext: Uint8Array): Uint8Array => sealBytes(keyBuf, Buffer.from(plaintext)),
    sealBlob: (plaintext: Uint8Array): Uint8Array => sealBytes(keyBuf, Buffer.from(plaintext)),
    openBlob: (stored: Uint8Array): Uint8Array => openEncryptedBlob(keyBuf, stored),
    openVector: (stored: Uint8Array, plaintextByteLength: number): Uint8Array =>
      openEncryptedVector(keyBuf, stored, plaintextByteLength),
    isSealed,
  };
}
