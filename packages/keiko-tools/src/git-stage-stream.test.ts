import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GitStageLargeFile } from "@oscharko-dev/keiko-workspace/internal/git-index";

// A chunk that counts how often its bytes are iterated one by one: hashing and the NUL probe read
// the chunk as a whole, only a byte-by-byte walk (the CRLF shape) iterates it.
class CountingChunk extends Uint8Array {
  public static walks = 0;
  public override [Symbol.iterator](): ArrayIterator<number> {
    CountingChunk.walks += 1;
    return super[Symbol.iterator]();
  }
}

const body = new CountingChunk(Buffer.from("line one\r\nline two\r\n", "utf8"));
vi.mock("@oscharko-dev/keiko-workspace/internal/git-index", () => ({
  streamGitStageFile: (
    _root: string,
    _file: unknown,
    _options: unknown,
    visit: (chunk: Uint8Array) => void,
  ): Promise<void> => {
    visit(body);
    return Promise.resolve();
  },
}));

const { analyzeLargeFile, blobIdOfLargeFile } = await import("./git-stage-stream.js");
const file = { path: "big.bin", mode: "100644", size: body.length } as GitStageLargeFile;
const expectedId = (algorithm: "sha1" | "sha256"): string =>
  createHash(algorithm)
    .update(`blob ${String(body.length)}\0`)
    .update(body)
    .digest("hex");

describe("the blob id of a large file", () => {
  it.each([
    [40, "sha1"],
    [64, "sha256"],
  ] as const)(
    "hashes a %s-character id and probes NUL without walking the bytes",
    async (length, algo) => {
      CountingChunk.walks = 0;
      const result = await blobIdOfLargeFile("/root", file, length, {});
      expect(result).toEqual({ objectId: expectedId(algo), hasNul: false });
      expect(CountingChunk.walks).toBe(0);
    },
  );
  it("leaves the CRLF analysis to the staging path that needs it", async () => {
    CountingChunk.walks = 0;
    const analysis = await analyzeLargeFile("/root", file, 40, {});
    expect(CountingChunk.walks).toBeGreaterThan(0);
    expect(analysis.objectId).toBe(expectedId("sha1"));
    expect(analysis.crlfBreaks).toBe(2);
  });
});
