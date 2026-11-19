import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256, sha256File, sha256FileChunked } from "../lib/digest.mjs";

const readRequests = vi.hoisted(() => []);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readSync: (fd, buffer, offset, length, position) => {
      readRequests.push(length);
      return actual.readSync(fd, buffer, offset, length, position);
    },
  };
});

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// FIPS 180-4 known-answer vectors: the proof is independent of the module under test AND of the
// platform hash the module wraps (CodeRabbit on #3069 — a same-module comparison is circular).
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("digest", () => {
  it("matches the FIPS 180-4 known-answer vectors for strings and bytes alike", () => {
    expect(sha256("")).toBe(SHA256_EMPTY);
    expect(sha256("abc")).toBe(SHA256_ABC);
    // Buffers hash byte-identically to their string form — hash.update accepts both, and the
    // portable/release scripts pass file bytes through this exact path.
    expect(sha256(Buffer.from("abc", "utf8"))).toBe(SHA256_ABC);
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("hashes a file's raw bytes, byte-for-byte, against the known-answer vector", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-digest-test-"));
    roots.push(root);
    const path = join(root, "payload.bin");
    writeFileSync(path, Buffer.from("abc", "utf8"));
    // The file digest must equal the independent vector — not merely agree with sha256() from
    // the same module — and raw bytes stay raw: no newline normalization.
    expect(sha256File(path)).toBe(SHA256_ABC);
    const crlf = join(root, "crlf.bin");
    writeFileSync(crlf, Buffer.from("line1\r\nline2\n", "utf8"));
    expect(sha256File(crlf)).not.toBe(sha256("line1\nline2\n"));
  });

  it("hashes a file in chunks to the same digest, across chunk boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-digest-test-"));
    roots.push(root);
    const empty = join(root, "empty.bin");
    writeFileSync(empty, Buffer.alloc(0));
    expect(sha256FileChunked(empty)).toBe(SHA256_EMPTY);
    const abc = join(root, "abc.bin");
    writeFileSync(abc, Buffer.from("abc", "utf8"));
    expect(sha256FileChunked(abc)).toBe(SHA256_ABC);
    // Larger than two 1 MiB chunks and not a multiple of one.
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const large = join(root, "large.bin");
    writeFileSync(large, bytes);
    expect(sha256FileChunked(large)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("stops reading one byte past the limit instead of reading to the end", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-digest-test-"));
    roots.push(root);
    const path = join(root, "long.bin");
    const limit = 1024 * 1024 + 5;
    writeFileSync(path, Buffer.alloc(4 * 1024 * 1024, 7));
    readRequests.length = 0;
    expect(sha256FileChunked(path, limit)).toBeUndefined();
    // Every request is bounded by the remaining allowance plus one byte, so the total requested
    // never exceeds limit + 1 (a reader that reads to EOF would request 4 MiB).
    expect(readRequests.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(limit + 1);
    // The exact limit still succeeds.
    const exact = join(root, "exact.bin");
    writeFileSync(exact, Buffer.from("abc", "utf8"));
    expect(sha256FileChunked(exact, 3)).toBe(SHA256_ABC);
  });
});
