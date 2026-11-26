import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_SHA256_CHUNK_BYTES, sha256FileSync } from "./file-sha256.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileWith(bytes: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-file-sha256-"));
  roots.push(root);
  const path = join(root, "payload.bin");
  writeFileSync(path, bytes);
  return path;
}

describe("sha256FileSync (#4495)", () => {
  it.each([
    ["an empty file", 0],
    ["a file below one chunk", 17],
    ["a file of exactly one chunk", FILE_SHA256_CHUNK_BYTES],
    ["a file spanning several chunks", FILE_SHA256_CHUNK_BYTES * 2 + 3],
  ])("hashes %s as its whole bytes", (_name, size) => {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251;
    expect(sha256FileSync(fileWith(bytes))).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("fails for a missing file and for a directory", () => {
    expect(() => sha256FileSync(join(tmpdir(), "keiko-file-sha256-missing", "none"))).toThrow();
    const root = mkdtempSync(join(tmpdir(), "keiko-file-sha256-"));
    roots.push(root);
    expect(() => sha256FileSync(root)).toThrow();
  });
});
