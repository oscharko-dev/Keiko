import { describe, expect, it, vi } from "vitest";
import { RepoSearchInvalidRangeError } from "./errors.js";
import { anchoredExcerptByteWindows } from "./repoSearchExcerptWindow.js";
import { readExcerpt, type SearchScope } from "./repoSearch.js";
import { memFs } from "./testing.js";

const limits = { maxBytes: 8192, maxWindows: 3, maxTotalBytes: 8192 };
function nearbyContent(): string {
  return (
    "a".repeat(2500) +
    "TargetOne" +
    "b".repeat(700) +
    "TargetTwo" +
    "c".repeat(700) +
    "TargetThree" +
    "d".repeat(1000)
  );
}
function scope(): SearchScope {
  return {
    scopeId: "anchor-window",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "fixture",
      version: "0",
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}
function byteCount(windows: readonly { readonly content: string }[] | undefined): number {
  return (windows ?? []).reduce((sum, window) => sum + Buffer.byteLength(window.content), 0);
}

function expectSourceOrder(windows: readonly { readonly startLine: number }[] | undefined): void {
  const first = windows?.[0];
  const second = windows?.[1];
  if (first === undefined || second === undefined) throw new TypeError("Expected two windows");
  expect(first.startLine).toBeLessThan(second.startLine);
}

describe("bounded anchor excerpt windows", () => {
  it.each([undefined, 1])(
    "preserves fitting nearby values through the facade with maxWindows %s",
    async (maxWindows) => {
      const content =
        "padding\n".repeat(100) +
        "x".repeat(200) +
        "TargetOne=first\n" +
        "x".repeat(280) +
        "TargetTwo=second\n" +
        "tail\n".repeat(100);
      const fs = memFs("/ws", { "manual.txt": content });
      const request = {
        scopePath: "manual.txt",
        startLine: 1,
        endLine: 203,
        maxBytes: 400,
        maxTotalBytes: 400,
        anchors: ["TargetOne", "TargetTwo"],
      };
      const result = await readExcerpt(
        scope(),
        { ...request, ...(maxWindows === undefined ? {} : { maxWindows }) },
        { fs },
      );
      expect(result.content).toContain("TargetOne=first");
      expect(result.content).toContain("TargetTwo=second");
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(request.maxBytes);
      expect(result.windows ?? [result]).toHaveLength(1);
      expect(result.truncated).toBe(true);
      expect(result.anchoredWindowApplied).toBe(true);
      const offset = content.indexOf(result.content);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(result.atom.lineRange).toEqual({
        startLine: content.slice(0, offset).split("\n").length,
        endLine: content.slice(0, offset + result.content.length).split("\n").length,
      });
      const grouped = await readExcerpt(scope(), { ...request, maxWindows: 2 }, { fs });
      expect(result.content).toBe(grouped.content);
      expect(result.atom.lineRange).toEqual(grouped.atom.lineRange);
    },
  );

  it("retains the whole fitting slice instead of sharing its budget over covered anchors", () => {
    const content = nearbyContent();
    const windows = anchoredExcerptByteWindows(
      content,
      ["TargetOne", "TargetTwo", "TargetThree"],
      limits,
      17,
    );
    expect(windows).toEqual([
      { content, startLine: 17, endLine: 17, anchoredWindowApplied: false },
    ]);
    expect(byteCount(windows)).toBe(Buffer.byteLength(content));
  });
  it("spends one complete window on nearby anchors without duplicate overlap", () => {
    const content =
      "x".repeat(1000) +
      "TargetOne=first" +
      "x".repeat(100) +
      "TargetTwo=second" +
      "x".repeat(1000);
    const windows = anchoredExcerptByteWindows(
      content,
      ["TargetOne", "TargetTwo"],
      { maxBytes: 400, maxWindows: 2, maxTotalBytes: 800 },
      1,
    );
    expect(windows).toHaveLength(1);
    expect(windows?.[0]?.content).toContain("TargetOne=first");
    expect(windows?.[0]?.content).toContain("TargetTwo=second");
    expect(byteCount(windows)).toBe(400);
  });
  it("consolidates partially overlapping views without clipping the later actual value", () => {
    const content =
      "x".repeat(1000) +
      "TargetOne=first" +
      "x".repeat(286) +
      "TargetTwo=second" +
      "x".repeat(1000);
    const windows = anchoredExcerptByteWindows(
      content,
      ["TargetOne", "TargetTwo"],
      {
        maxBytes: 400,
        maxWindows: 2,
        maxTotalBytes: 800,
      },
      1,
    );
    expect(windows).toHaveLength(1);
    expect(windows?.[0]?.content).toContain("TargetOne=first");
    expect(windows?.[0]?.content).toContain("TargetTwo=second");
    expect(byteCount(windows)).toBe(400);
  });
  it("returns distant windows in source order while preserving requested-anchor priority", () => {
    const content =
      "padding\n".repeat(50) + "TargetOne=first\n" + "padding\n".repeat(50) + "TargetTwo=second\n";
    const request = { maxBytes: 80, maxWindows: 2, maxTotalBytes: 160 };
    const windows = anchoredExcerptByteWindows(content, ["TargetTwo", "TargetOne"], request, 11);
    expect(windows?.[0]?.content).toContain("TargetOne=first");
    expect(windows?.[1]?.content).toContain("TargetTwo=second");
    expectSourceOrder(windows);
    const first = anchoredExcerptByteWindows(
      content,
      ["TargetTwo", "TargetOne"],
      { ...request, maxWindows: 1 },
      11,
    );
    expect(first?.[0]?.content).toContain("TargetTwo=second");
    expect(byteCount(windows)).toBeLessThanOrEqual(request.maxTotalBytes);
  });
  it("rejects an oversized anchor envelope through the facade before filesystem IO", async () => {
    const fs = memFs("/ws", { "manual.txt": "TargetOne=first" });
    const stat = vi.spyOn(fs, "stat");
    await expect(
      readExcerpt(
        scope(),
        {
          scopePath: "manual.txt",
          startLine: 1,
          endLine: 1,
          maxBytes: 80,
          anchors: ["x".repeat(4097)],
        },
        { fs },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
    expect(stat).not.toHaveBeenCalled();
  });
  it("deduplicates anchors before charging the existing request envelope", () => {
    const anchor = "a".repeat(3000);
    const windows = anchoredExcerptByteWindows(anchor, [anchor, anchor], limits, 1);
    expect(windows?.[0]?.content).toBe(anchor);
  });
  it("enforces the same envelope for direct helper calls", () => {
    expect(() => anchoredExcerptByteWindows("text", ["x".repeat(4097)], limits, 1)).toThrow(
      RepoSearchInvalidRangeError,
    );
  });
  it.each([1, 3])(
    "returns a whole fitting slice through the facade with %i windows",
    async (maxWindows) => {
      const content = nearbyContent();
      const fs = memFs("/ws", { "manual.txt": content });
      const result = await readExcerpt(
        scope(),
        {
          scopePath: "manual.txt",
          startLine: 1,
          endLine: 1,
          ...limits,
          maxWindows,
          anchors: ["TargetOne", "TargetTwo", "TargetThree"],
        },
        { fs },
      );
      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
      expect(result.windows ?? [result]).toHaveLength(1);
      expect(result.atom.lineRange).toEqual({ startLine: 1, endLine: 1 });
      expect(result.omittedRangeCount).toBeUndefined();
    },
  );
  it("keeps Unicode case-folding and complete UTF-8 code points under cumulative bytes", () => {
    const content =
      "é🙂\n".repeat(300) + "ſtatus=first\n" + "é🙂\n".repeat(300) + "KeyProbe=second\n";
    const windows = anchoredExcerptByteWindows(
      content,
      ["KeyProbe", "STATUS"],
      {
        maxBytes: 101,
        maxWindows: 2,
        maxTotalBytes: 171,
      },
      41,
    );
    expect(windows).toHaveLength(2);
    expect(windows?.[0]?.content).toContain("ſtatus=first");
    expect(windows?.[1]?.content).toContain("KeyProbe=second");
    expect(byteCount(windows)).toBeLessThanOrEqual(171);
    for (const window of windows ?? []) {
      expect(Buffer.byteLength(window.content)).toBeLessThanOrEqual(101);
      expect(window.content).not.toContain("\ufffd");
      const index = content.indexOf(window.content);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(window.startLine).toBe(41 + content.slice(0, index).split("\n").length - 1);
    }
  });
  it("encodes the source once rather than re-encoding each anchor's source prefix", () => {
    const anchors = Array.from({ length: 16 }, (_value, index) => `Anchor${String(index)}`);
    const content = anchors.map((anchor) => "é🙂".repeat(1000) + anchor).join("\n");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const windows = anchoredExcerptByteWindows(
        content,
        anchors,
        {
          maxBytes: 64,
          maxWindows: anchors.length,
          maxTotalBytes: 1024,
        },
        1,
      );
      expect(windows).toHaveLength(anchors.length);
      expect(encode).toHaveBeenCalledTimes(1);
      expect(byteCount(windows)).toBeLessThanOrEqual(1024);
    } finally {
      encode.mockRestore();
    }
  });
});
