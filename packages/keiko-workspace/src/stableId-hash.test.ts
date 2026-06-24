import { describe, expect, it } from "vitest";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "./fs.js";
import { fileContentHash, hashExcerptContent, MAX_HASH_FILE_BYTES } from "./stableId.js";

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

// In-memory WorkspaceFs fake that serves bytes from a {path: Uint8Array|string} map. readFileBytes
// honours the maxBytes cap exactly like nodeWorkspaceFs (subarray of the first maxBytes bytes), so a
// truncation test exercises the real bound. The synchronous surface is stubbed inertly.
function fakeFs(files: Readonly<Record<string, Uint8Array | string>>): WorkspaceFs {
  return {
    readFileUtf8: (): string => "",
    stat: (): WorkspaceStat => ({
      size: 0,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }),
    readDir: (): readonly WorkspaceDirEntry[] => [],
    realPath: (p: string): string => p,
    exists: (p: string): boolean => Object.prototype.hasOwnProperty.call(files, p),
    readFileBytes: (absolutePath: string, maxBytes: number): Promise<Uint8Array> => {
      const entry = files[absolutePath];
      if (entry === undefined) {
        return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
      }
      const cap = Math.max(0, Math.floor(maxBytes));
      return Promise.resolve(toBytes(entry).subarray(0, cap));
    },
  };
}

// Fake WITHOUT the optional readFileBytes port (legacy synchronous-only surface).
function fakeFsNoBytes(): WorkspaceFs {
  return {
    readFileUtf8: (): string => "",
    stat: (): WorkspaceStat => ({
      size: 0,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }),
    readDir: (): readonly WorkspaceDirEntry[] => [],
    realPath: (p: string): string => p,
    exists: (): boolean => true,
  };
}

describe("hashExcerptContent (excerpt-content hash, content-only — no deny gate involved)", () => {
  it("is deterministic for the same content", () => {
    expect(hashExcerptContent("line a\nline b")).toBe(hashExcerptContent("line a\nline b"));
  });

  it("differs for different content", () => {
    expect(hashExcerptContent("line a")).not.toBe(hashExcerptContent("line b"));
  });

  it("returns a stable, defined 64-char hex for the empty string", () => {
    const empty = hashExcerptContent("");
    expect(empty).toBe(hashExcerptContent(""));
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes multibyte/emoji content consistently by bytes", () => {
    const content = "héllo 🌍 こんにちは";
    expect(hashExcerptContent(content)).toBe(hashExcerptContent(content));
    expect(hashExcerptContent(content)).not.toBe(hashExcerptContent("hello world"));
  });
});

describe("fileContentHash (file-level invalidation signal, content-only — caller deny-gates)", () => {
  it("produces the same hash for the same bytes across calls", async () => {
    const fs = fakeFs({ "/ws/a.ts": "const x = 1;\n" });
    const first = await fileContentHash(fs, "/ws/a.ts");
    const second = await fileContentHash(fs, "/ws/a.ts");
    expect(first).toBeDefined();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a defined hash for an empty file (hash of zero bytes)", async () => {
    const fs = fakeFs({ "/ws/empty.ts": "" });
    const hash = await fileContentHash(fs, "/ws/empty.ts");
    expect(hash).toBe(hashExcerptContent(""));
  });

  it("returns undefined when readFileBytes is absent (legacy fake), without throwing", async () => {
    const fs = fakeFsNoBytes();
    await expect(fileContentHash(fs, "/ws/a.ts")).resolves.toBeUndefined();
  });

  it("returns the SAME hash for two files sharing the first 131072 bytes but differing after (documents the 128 KiB truncation limitation)", async () => {
    // Fixed literal head longer than the documented cap, independent of the constant under test, so
    // the mutation probe (raising MAX_HASH_FILE_BYTES past this length) makes the tails fall inside
    // the hashed window and this expectation FLIPS — pinning the documented bound.
    const head = "x".repeat(200_000);
    const fs = fakeFs({
      "/ws/big-a.ts": `${head}TAIL-A`,
      "/ws/big-b.ts": `${head}TAIL-B-different-and-longer`,
    });
    const hashA = await fileContentHash(fs, "/ws/big-a.ts");
    const hashB = await fileContentHash(fs, "/ws/big-b.ts");
    expect(hashA).toBeDefined();
    expect(hashA).toBe(hashB);
  });

  it("pins the documented 128 KiB hash bound", () => {
    expect(MAX_HASH_FILE_BYTES).toBe(131_072);
  });

  it("distinguishes files that differ within the first 131072 bytes", async () => {
    const fs = fakeFs({
      "/ws/a.ts": `${"x".repeat(10)}A`,
      "/ws/b.ts": `${"x".repeat(10)}B`,
    });
    expect(await fileContentHash(fs, "/ws/a.ts")).not.toBe(await fileContentHash(fs, "/ws/b.ts"));
  });

  it("propagates a readFileBytes rejection rather than swallowing it (caller handles IO)", async () => {
    const fs = fakeFs({ "/ws/a.ts": "ok" });
    await expect(fileContentHash(fs, "/ws/missing.ts")).rejects.toThrow(/ENOENT/);
  });
});
