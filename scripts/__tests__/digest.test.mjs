import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256, sha256File } from "../lib/digest.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("digest", () => {
  it("hashes strings and bytes to the same hex the platform produces", () => {
    expect(sha256("keiko")).toBe(createHash("sha256").update("keiko").digest("hex"));
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(sha256("")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("hashes a file's raw bytes, byte-for-byte", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-digest-test-"));
    roots.push(root);
    const path = join(root, "payload.bin");
    const bytes = Buffer.from("line1\r\nline2\n", "utf8");
    writeFileSync(path, bytes);
    // Raw bytes on purpose: no newline normalization — a digest that silently normalized would
    // report identical hashes for different files.
    expect(sha256File(path)).toBe(sha256(bytes));
    expect(sha256File(path)).not.toBe(sha256("line1\nline2\n"));
  });
});
