import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as decoder from "./binaryDetect.js";
import { DEFAULT_BINARY_PROBE } from "./binaryDetect.js";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { readExcerpt, type ReadExcerptRequest, type SearchScope } from "./repoSearch.js";

let root = "";
let content = "";
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-multi-range-"));
  content = Array.from({ length: 480 }, (_value, index) =>
    index % 12 === 0 ? `RangeReadingProbe value-${String(10000 + index / 12)}` : "",
  ).join("\n");
  writeFileSync(join(root, "readings.txt"), content);
});
afterEach((): void => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "multi-range",
    relativePaths: [],
  };
}

function request(): ReadExcerptRequest {
  return {
    scopePath: "readings.txt",
    startLine: 1,
    endLine: 480,
    maxBytes: 8192,
    maxTotalBytes: 128 * 1024,
    ranges: Array.from({ length: 40 }, (_value, index) => ({
      startLine: index * 12 + 1,
      endLine: index * 12 + 1,
    })),
  };
}

function observedReads(action?: () => void): { readonly fs: WorkspaceFs; readonly caps: number[] } {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new Error("Expected safe production byte reader");
  const caps: number[] = [];
  return {
    caps,
    fs: {
      ...nodeWorkspaceFs,
      readFileBytes: async (...args): Promise<Uint8Array> => {
        const bytes = await read(...args);
        caps.push(args[1]);
        if (args[1] > DEFAULT_BINARY_PROBE.maxProbeBytes) action?.();
        return bytes;
      },
    },
  };
}

describe("fresh multi-range excerpt projection", () => {
  it("preserves admitted file identity when a range carries unrelated request properties", async () => {
    const range = { startLine: 1, endLine: 1, scopePath: "forged.txt", anchors: ["forged"] };
    const result = await readExcerpt(scope(), { ...request(), ranges: [range] });
    expect(result.atom.scopePath).toBe("readings.txt");
    expect(result.content).toBe("RangeReadingProbe value-10000");
    expect(result.atom.lineRange).toEqual({ startLine: 1, endLine: 1 });
    expect(JSON.stringify(result)).not.toContain("forged");
  });

  it("omits an unrepresentable multibyte range without spending a returned-window slot", async () => {
    writeFileSync(join(root, "readings.txt"), "1234567890\n中\nx");
    const result = await readExcerpt(scope(), {
      ...request(),
      startLine: 1,
      endLine: 3,
      maxBytes: 10,
      maxTotalBytes: 12,
      maxWindows: 2,
      ranges: [1, 2, 3].map((line) => ({ startLine: line, endLine: line })),
    });
    expect(result.windows?.map((window) => window.content)).toEqual(["1234567890", "x"]);
    expect(result.windows?.map((window) => window.atom.lineRange)).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
    ]);
    expect(result.omittedRangeCount).toBe(1);
  });

  it("classifies and decodes once rather than reopening once per requested range", async (): Promise<void> => {
    const reads = observedReads();
    const decode = vi.spyOn(decoder, "decodeTextFileBytes");
    const result = await readExcerpt(scope(), request(), { fs: reads.fs });
    expect(result.windows).toHaveLength(40);
    expect(result.omittedRangeCount).toBe(0);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(reads.caps).toHaveLength(2);
    expect(reads.caps.filter((cap) => cap > DEFAULT_BINARY_PROBE.maxProbeBytes)).toHaveLength(1);
    for (const [index, window] of (result.windows ?? []).entries()) {
      expect(window.content).toBe(`RangeReadingProbe value-${String(10000 + index)}`);
      expect(window.atom.lineRange).toEqual({ startLine: index * 12 + 1, endLine: index * 12 + 1 });
    }
  });

  it("reports all unprocessed ranges when the cumulative byte grant is spent", async (): Promise<void> => {
    const result = await readExcerpt(scope(), { ...request(), maxTotalBytes: 32 });
    expect(result.omittedRangeCount).toBe(38);
    expect(
      (result.windows ?? [result]).reduce(
        (sum, window) => sum + Buffer.byteLength(window.content),
        0,
      ),
    ).toBe(32);
    expect(result.windows?.at(-1)?.truncated).toBe(true);
  });

  it.each([
    [],
    null,
    "not-an-array",
    [null],
    [{ startLine: 0, endLine: 1 }],
    [{ startLine: 1.5, endLine: 2 }],
    [{ startLine: 1, endLine: Number.NaN }],
    [{ startLine: 1, endLine: Infinity }],
    [{ startLine: 2, endLine: 1 }],
    [{ startLine: 1, endLine: 481 }],
    [{ startLine: "1", endLine: 2 }],
    [{ startLine: 1 }],
  ])("rejects malformed ranges before any file bytes are read (%#)", async (ranges) => {
    const reads = observedReads();
    await expect(
      readExcerpt(
        scope(),
        {
          ...request(),
          ranges: ranges as unknown as NonNullable<ReadExcerptRequest["ranges"]>,
        },
        { fs: reads.fs },
      ),
    ).rejects.toThrow("invalid excerpt ranges");
    expect(reads.caps).toEqual([]);
  });

  it("does not publish content when the total byte grant is zero", async () => {
    await expect(readExcerpt(scope(), { ...request(), maxTotalBytes: 0 })).rejects.toMatchObject({
      reason: "io-error",
    });
  });

  it("keeps duplicate and overlapping explicit ranges in requested order and charges each", async () => {
    writeFileSync(join(root, "readings.txt"), "alpha\nbeta\ngamma");
    const result = await readExcerpt(scope(), {
      ...request(),
      startLine: 1,
      endLine: 3,
      maxBytes: 32,
      maxTotalBytes: 64,
      ranges: [
        { startLine: 1, endLine: 2 },
        { startLine: 1, endLine: 2 },
        { startLine: 2, endLine: 3 },
      ],
    });
    expect(result.windows?.map((window) => window.content)).toEqual([
      "alpha\nbeta",
      "alpha\nbeta",
      "beta\ngamma",
    ]);
    expect(result.windows?.map((window) => window.atom.lineRange)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 1, endLine: 2 },
      { startLine: 2, endLine: 3 },
    ]);
    expect(result.omittedRangeCount).toBe(0);
    const charged = await readExcerpt(scope(), {
      ...request(),
      startLine: 1,
      endLine: 3,
      maxBytes: 32,
      maxTotalBytes: 20,
      ranges: [
        { startLine: 1, endLine: 2 },
        { startLine: 1, endLine: 2 },
        { startLine: 2, endLine: 3 },
      ],
    });
    expect(charged.windows?.map((window) => window.content)).toEqual([
      "alpha\nbeta",
      "alpha\nbeta",
    ]);
    expect(charged.omittedRangeCount).toBe(1);
  });

  it("shares anchors and a multi-window byte budget across disjoint requested ranges", async () => {
    writeFileSync(
      join(root, "readings.txt"),
      `${"prefix ".repeat(50)}FirstRangeProbe${" filler".repeat(50)}SecondRangeProbe\nFinalRangeProbe`,
    );
    const result = await readExcerpt(scope(), {
      ...request(),
      startLine: 1,
      endLine: 2,
      maxBytes: 32,
      maxTotalBytes: 80,
      maxWindows: 3,
      anchors: ["FirstRangeProbe", "SecondRangeProbe", "FinalRangeProbe"],
      ranges: [
        { startLine: 1, endLine: 1 },
        { startLine: 2, endLine: 2 },
      ],
    });
    expect(result.windows).toHaveLength(3);
    expect(result.windows?.map((window) => window.content)).toEqual([
      expect.stringContaining("FirstRangeProbe"),
      expect.stringContaining("SecondRangeProbe"),
      "FinalRangeProbe",
    ]);
    expect(result.windows?.map((window) => window.atom.lineRange)).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
    ]);
    expect(
      (result.windows ?? []).reduce((sum, window) => sum + Buffer.byteLength(window.content), 0),
    ).toBeLessThanOrEqual(80);
    expect(result.omittedRangeCount).toBe(0);
  });

  it("retains a valid window when a later stale location exceeds physical EOF", async () => {
    writeFileSync(join(root, "readings.txt"), "alpha\nbeta");
    const result = await readExcerpt(scope(), {
      ...request(),
      startLine: 1,
      endLine: 10,
      ranges: [
        { startLine: 1, endLine: 1 },
        { startLine: 8, endLine: 8 },
      ],
    });
    expect(result.content).toBe("alpha");
    expect(result.atom.lineRange).toEqual({ startLine: 1, endLine: 1 });
    expect(result.omittedRangeCount).toBe(1);
  });

  it("preserves an explicit returned-window limit and its skipped-range count", async (): Promise<void> => {
    const result = await readExcerpt(scope(), { ...request(), maxWindows: 2 });
    expect(result.windows).toHaveLength(2);
    expect(result.omittedRangeCount).toBe(38);
  });

  it("keeps decoded UTF16 source coordinates for every requested range", async (): Promise<void> => {
    writeFileSync(
      join(root, "readings.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]),
    );
    const result = await readExcerpt(scope(), request());
    expect(result.windows?.at(-1)?.content).toBe("RangeReadingProbe value-10039");
    expect(result.windows?.at(-1)?.atom.lineRange).toEqual({ startLine: 469, endLine: 469 });
  });

  it("rejects binary bytes after an apparently valid prefix before publishing early ranges", async (): Promise<void> => {
    writeFileSync(join(root, "readings.txt"), `${content}${"\n".repeat(5000)}\0`);
    await expect(readExcerpt(scope(), request())).rejects.toMatchObject({ reason: "binary" });
  });

  it.each(["denied", "symlink", "hardlink", "scope"])(
    "preserves %s admission before returning any batched range",
    async (kind): Promise<void> => {
      const reads = observedReads();
      const selected = scope();
      let scopePath = "readings.txt";
      if (kind === "denied") {
        scopePath = ".env";
        writeFileSync(join(root, scopePath), content);
      }
      if (kind === "symlink") {
        scopePath = "alias.txt";
        symlinkSync(".env", join(root, scopePath));
        writeFileSync(join(root, ".env"), content);
      }
      if (kind === "hardlink") {
        scopePath = "alias.txt";
        linkSync(join(root, "readings.txt"), join(root, scopePath));
      }
      await expect(
        readExcerpt(
          kind === "scope" ? { ...selected, relativePaths: ["selected"] } : selected,
          { ...request(), scopePath },
          { fs: reads.fs },
        ),
      ).rejects.toThrow();
      expect(reads.caps).toEqual([]);
    },
  );

  it("rejects a file change between the guarded read and range projection", async (): Promise<void> => {
    const reads = observedReads(() => {
      writeFileSync(join(root, "readings.txt"), "changed source");
    });
    await expect(readExcerpt(scope(), request(), { fs: reads.fs })).rejects.toMatchObject({
      reason: "io-error",
    });
  });

  it("observes timer-driven abort before publishing any range from the completed read", async (): Promise<void> => {
    const abort = new AbortController();
    const reads = observedReads(() => {
      setImmediate(() => {
        abort.abort();
      });
    });
    await expect(
      readExcerpt(scope(), request(), { fs: reads.fs, signal: abort.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(reads.caps.filter((cap) => cap > DEFAULT_BINARY_PROBE.maxProbeBytes)).toHaveLength(1);
  });
});
