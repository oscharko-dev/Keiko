import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as decoder from "./binaryDetect.js";
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
        if (args[1] > 4096) action?.();
        return bytes;
      },
    },
  };
}

describe("fresh multi-range excerpt projection", () => {
  it("classifies and decodes once rather than reopening once per requested range", async (): Promise<void> => {
    const reads = observedReads();
    const decode = vi.spyOn(decoder, "decodeTextFileBytes");
    const result = await readExcerpt(scope(), request(), { fs: reads.fs });
    expect(result.windows).toHaveLength(40);
    expect(result.omittedRangeCount).toBe(0);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(reads.caps).toHaveLength(2);
    expect(reads.caps.filter((cap) => cap > 4096)).toHaveLength(1);
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

  it("rejects malformed ranges before any file bytes are read", async (): Promise<void> => {
    const reads = observedReads();
    await expect(
      readExcerpt(
        scope(),
        {
          ...request(),
          ranges: [{ startLine: 0, endLine: 1 }],
        },
        { fs: reads.fs },
      ),
    ).rejects.toThrow("invalid excerpt ranges");
    expect(reads.caps).toEqual([]);
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
    expect(reads.caps.filter((cap) => cap > 4096)).toHaveLength(1);
  });
});
