import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as decoder from "./binaryDetect.js";
import { DEFAULT_BINARY_PROBE } from "./binaryDetect.js";
import { detectWorkspaceAt } from "./detect.js";
import { RepoSearchInvalidRangeError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import {
  readExcerpt,
  type ReadExcerptRequest,
  type ReadExcerptResult,
  type SearchScope,
} from "./repoSearch.js";

let root = "";
const source = "A\n中中中\nB\nunrequested tail";

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-range-queues-"));
  writeFileSync(join(root, "readings.txt"), source);
});

afterEach((): void => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "range-queues",
    relativePaths: [],
  };
}

function range(line: number): { readonly startLine: number; readonly endLine: number } {
  return { startLine: line, endLine: line };
}

function request(): ReadExcerptRequest {
  return {
    scopePath: "readings.txt",
    startLine: 1,
    endLine: 4,
    maxBytes: 32,
    maxTotalBytes: 32,
    maxWindows: 4,
    ranges: [range(1)],
    rangeQueues: [[range(2)], [range(3)]],
  };
}

function observedReads(): { readonly fs: WorkspaceFs; readonly caps: number[] } {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new TypeError("Expected the guarded production byte reader");
  const caps: number[] = [];
  return {
    caps,
    fs: {
      ...nodeWorkspaceFs,
      readFileBytes: async (...args): Promise<Uint8Array> => {
        caps.push(args[1]);
        return read(...args);
      },
    },
  };
}

function windows(result: ReadExcerptResult): NonNullable<ReadExcerptResult["windows"]> {
  return result.windows ?? [result];
}

function returnedBytes(result: ReadExcerptResult): number {
  return windows(result).reduce((bytes, window) => bytes + Buffer.byteLength(window.content), 0);
}

describe("trusted excerpt range queue boundaries", () => {
  it("shares a complete duplicate prefix view without false omissions or extra returned bytes", async () => {
    const grant = Buffer.byteLength("A") + Buffer.byteLength("中中中") + Buffer.byteLength("B");
    const result = await readExcerpt(scope(), {
      ...request(),
      rangeQueues: [[range(1), range(2)], [range(3)]],
      maxTotalBytes: grant,
    });
    expect(
      windows(result)
        .map((window) => window.content)
        .sort(),
    ).toEqual(["A", "B", "中中中"]);
    expect(windows(result).every((window) => !window.truncated)).toBe(true);
    expect(returnedBytes(result)).toBe(grant);
    expect(result.omittedRangeCount).toBe(0);
  });

  it("does not retire a partially returned line from a later complete overlapping view", async () => {
    writeFileSync(join(root, "readings.txt"), "abcdefghij\nB\nuntouched\nlast");
    const grant = 22;
    const first = await readExcerpt(scope(), {
      ...request(),
      rangeQueues: [[range(2)]],
      maxBytes: 8,
      maxTotalBytes: 8,
    });
    expect(first.content).toBe("abcdefgh");
    expect(first.truncated).toBe(true);
    expect(first.completedRanges).toEqual([]);
    const remaining = grant - returnedBytes(first);
    const complete = { startLine: 1, endLine: 2 };
    const second = await readExcerpt(scope(), {
      ...request(),
      ranges: [],
      rangeQueues: [[complete]],
      processedRanges: first.processedRanges,
      completedRanges: first.completedRanges,
      expectedSourceFingerprint: first.sourceFingerprint,
      maxBytes: remaining,
      maxTotalBytes: remaining,
    });
    expect(second.content).toBe("abcdefghij\nB");
    expect(second.truncated).toBe(false);
    expect(second.completedRanges).toEqual([complete]);
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(returnedBytes(first) + returnedBytes(second)).toBe(20);
    expect(returnedBytes(first) + returnedBytes(second)).toBeLessThanOrEqual(grant);
  });

  it("defers an unrepresentable initial range so the residual grant can return it whole", async () => {
    writeFileSync(join(root, "readings.txt"), "A\n中\nB\nunrequested tail");
    const grant = 4;
    const first = await readExcerpt(scope(), {
      ...request(),
      ranges: undefined,
      rangeQueues: [[range(2)], [range(3)]],
      firstRoundOnly: true,
      maxBytes: 2,
      maxTotalBytes: grant,
    });
    expect(windows(first).map((window) => window.content)).toEqual(["B"]);
    expect(first.processedRanges).toEqual([range(3)]);
    expect(first.omittedRangeCount).toBe(1);
    const remaining = grant - returnedBytes(first);
    const second = await readExcerpt(scope(), {
      ...request(),
      ranges: undefined,
      rangeQueues: [[range(2)], [range(3)]],
      processedRanges: first.processedRanges,
      expectedSourceFingerprint: first.sourceFingerprint,
      maxBytes: remaining,
      maxTotalBytes: remaining,
    });
    expect(second.content).toBe("中");
    expect(second.truncated).toBe(false);
    expect(second.processedRanges).toEqual([range(2)]);
    expect(second.omittedRangeCount).toBe(0);
    expect(returnedBytes(first) + returnedBytes(second)).toBe(grant);
  });

  it("reuses one classified source and unused queue bytes for a complete multibyte range", async () => {
    const reads = observedReads();
    const decode = vi.spyOn(decoder, "decodeTextFileBytes");
    const grant = Buffer.byteLength("A") + Buffer.byteLength("中中中") + Buffer.byteLength("B");
    const result = await readExcerpt(
      scope(),
      { ...request(), maxTotalBytes: grant },
      { fs: reads.fs },
    );
    expect(windows(result).map((window) => window.content)).toEqual(["A", "B", "中中中"]);
    expect(windows(result).every((window) => !window.truncated)).toBe(true);
    expect(returnedBytes(result)).toBe(grant);
    expect(result.omittedRangeCount).toBe(0);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(reads.caps).toHaveLength(2);
    expect(reads.caps.filter((cap) => cap > DEFAULT_BINARY_PROBE.maxProbeBytes)).toHaveLength(1);
    expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains the cumulative byte and window caps when a multibyte range is partial", async () => {
    const result = await readExcerpt(scope(), {
      ...request(),
      ranges: [],
      rangeQueues: [[range(2), range(4)], [range(3)]],
      maxBytes: 4,
      maxTotalBytes: 6,
      maxWindows: 2,
    });
    expect(windows(result).map((window) => window.content)).toEqual(["B", "中"]);
    expect(windows(result)).toHaveLength(2);
    expect(windows(result).some((window) => window.truncated)).toBe(true);
    for (const window of windows(result))
      expect(Buffer.byteLength(window.content)).toBeLessThanOrEqual(4);
    expect(returnedBytes(result)).toBeLessThanOrEqual(6);
    expect(result.omittedRangeCount).toBe(1);
  });

  it("reports an entirely deferred first round with an empty prefix without an outside-range error", async () => {
    const reads = observedReads();
    const result = await readExcerpt(
      scope(),
      {
        ...request(),
        ranges: [],
        rangeQueues: [[range(2)]],
        firstRoundOnly: true,
        maxTotalBytes: 2,
      },
      { fs: reads.fs },
    );
    expect(result.content).toBe("");
    expect(result.windows).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.processedRanges).toEqual([]);
    expect(result.omittedRangeCount).toBe(1);
    expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(reads.caps.filter((cap) => cap > DEFAULT_BINARY_PROBE.maxProbeBytes)).toHaveLength(1);
  });

  it("keeps omissions when queues are supplied without a prefix ranges field", async () => {
    const result = await readExcerpt(scope(), {
      ...request(),
      ranges: undefined,
      rangeQueues: [[range(1)], [range(2)]],
      firstRoundOnly: true,
      maxTotalBytes: 1,
    });
    expect(result.content).toBe("A");
    expect(result.processedRanges).toEqual([range(1)]);
    expect(result.omittedRangeCount).toBe(1);
    expect(returnedBytes(result)).toBe(1);
  });

  it("rechecks the source after a queue-only projection before returning content", async () => {
    const reads = observedReads();
    const decode = decoder.decodeTextFileBytes;
    let decoded = false;
    let changed = false;
    vi.spyOn(decoder, "decodeTextFileBytes").mockImplementation((...args) => {
      const result = decode(...args);
      decoded = true;
      return result;
    });
    const nowMs = (): number => {
      if (decoded && !changed) {
        writeFileSync(join(root, "readings.txt"), `${source}\nchanged after decoding`);
        changed = true;
      }
      return 0;
    };
    await expect(
      readExcerpt(
        scope(),
        {
          ...request(),
          ranges: undefined,
        },
        { fs: reads.fs, nowMs },
      ),
    ).rejects.toMatchObject({ reason: "io-error" });
    expect(changed).toBe(true);
    expect(reads.caps.filter((cap) => cap > DEFAULT_BINARY_PROBE.maxProbeBytes)).toHaveLength(1);
  });

  it.each([
    null,
    "not-an-array",
    [null],
    [range(1)],
    ["not-a-queue"],
    [[null]],
    [[{ startLine: 0, endLine: 1 }]],
    [[{ startLine: 1, endLine: 5 }]],
  ])("rejects malformed nested queues before reading file bytes (%#)", async (rangeQueues) => {
    const reads = observedReads();
    await expect(
      readExcerpt(
        scope(),
        {
          ...request(),
          rangeQueues: rangeQueues as unknown as NonNullable<ReadExcerptRequest["rangeQueues"]>,
        },
        { fs: reads.fs },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
    expect(reads.caps).toEqual([]);
  });

  it("binds expansion to the whole redacted source even when the requested line is unchanged", async () => {
    const first = await readExcerpt(scope(), {
      ...request(),
      ranges: undefined,
      rangeQueues: [[range(1)]],
    });
    expect(first.content).toBe("A");
    expect(first.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    writeFileSync(join(root, "readings.txt"), "A\n中中中\nB\nchanged unrequested tail");
    await expect(
      readExcerpt(scope(), {
        ...request(),
        ranges: undefined,
        rangeQueues: [[range(1)]],
        expectedSourceFingerprint: first.sourceFingerprint,
      }),
    ).rejects.toMatchObject({ reason: "io-error" });
  });

  it("does not replay a processed partial range as a complete view during expansion", async () => {
    const first = await readExcerpt(scope(), {
      ...request(),
      ranges: undefined,
      rangeQueues: [[range(2)]],
      maxBytes: 4,
      maxTotalBytes: 4,
    });
    expect(first.content).toBe("中");
    expect(first.truncated).toBe(true);
    expect(first.processedRanges).toEqual([range(2)]);
    const second = await readExcerpt(scope(), {
      ...request(),
      ranges: undefined,
      rangeQueues: [[range(2)], [range(3)]],
      processedRanges: first.processedRanges,
      expectedSourceFingerprint: first.sourceFingerprint,
    });
    expect(second.content).toBe("B");
    expect(second.processedRanges).toEqual([range(3)]);
    expect(second.omittedRangeCount).toBe(0);
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(returnedBytes(first) + returnedBytes(second)).toBe(4);
  });
});
