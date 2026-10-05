import { describe, expect, it } from "vitest";
import { anchoredExcerptByteWindows } from "./repoSearchExcerptWindow.js";
import { readExcerpt, type SearchScope } from "./repoSearch.js";
import { memFs } from "./testing.js";

function separated(anchors: readonly string[]): string {
  return anchors.map((anchor) => `padding\n${"x".repeat(80)}${anchor}${"y".repeat(80)}\n`).join("");
}

function expectSourceWindows(
  content: string,
  windows: ReturnType<typeof anchoredExcerptByteWindows>,
  maxBytes: number,
  maxTotalBytes: number,
): void {
  expect(windows?.length).toBeGreaterThan(0);
  let previousEnd = 0;
  let total = 0;
  for (const window of windows ?? []) {
    const offset = content.indexOf(window.content);
    expect(offset).toBeGreaterThanOrEqual(previousEnd);
    expect(window.startLine).toBe(11 + content.slice(0, offset).split("\n").length - 1);
    expect(window.endLine).toBe(window.startLine + window.content.split("\n").length - 1);
    previousEnd = offset + window.content.length;
    const bytes = Buffer.byteLength(window.content);
    expect(bytes).toBeLessThanOrEqual(maxBytes);
    total += bytes;
  }
  expect(total).toBeLessThanOrEqual(maxTotalBytes);
}

function overlapFixture(): { readonly content: string; readonly anchors: readonly string[] } {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return {
    anchors: [alphabet.slice(0, 45), alphabet.slice(35, 60)],
    content: `padding\n${"x".repeat(100)}${alphabet}${"y".repeat(100)}\ntail`,
  };
}

function searchScope(): SearchScope {
  return {
    scopeId: "anchor-grants",
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

describe("anchor-window grants and source boundaries", () => {
  it("redistributes a tight grant so short and long distant anchors both remain complete", () => {
    const anchors = ["NeedleA", "LengthyTargetValue"];
    const content = separated(anchors);
    const windows = anchoredExcerptByteWindows(
      content,
      anchors,
      { maxBytes: 24, maxWindows: 2, maxTotalBytes: 30 },
      11,
    );
    expect(windows).toHaveLength(2);
    expect(windows?.[0]?.content).toContain(anchors[0]);
    expect(windows?.[1]?.content).toContain(anchors[1]);
    expectSourceWindows(content, windows, 24, 30);
  });

  it("returns source prefixes when all complete anchor ranges cannot fit", () => {
    const anchors = ["NeedleA", "LengthyTargetValue"];
    const content = separated(anchors);
    const windows = anchoredExcerptByteWindows(
      content,
      anchors,
      { maxBytes: 10, maxWindows: 2, maxTotalBytes: 3 },
      11,
    );
    expect(windows?.map((window) => window.content)).toEqual(["N", "L"]);
    expectSourceWindows(content, windows, 10, 3);
  });

  it("returns no windows when each selected anchor receives a zero-byte grant", () => {
    const anchors = ["NeedleA", "NeedleB", "NeedleC"];
    expect(
      anchoredExcerptByteWindows(
        separated(anchors),
        anchors,
        { maxBytes: 8, maxWindows: 3, maxTotalBytes: 2 },
        11,
      ),
    ).toBeUndefined();
  });

  it("keeps the actual start of an anchor longer than its entire window", () => {
    const content = separated(["LengthyTargetValue"]);
    const windows = anchoredExcerptByteWindows(
      content,
      ["LengthyTargetValue"],
      { maxBytes: 4, maxWindows: 1, maxTotalBytes: 4 },
      11,
    );
    expect(windows?.[0]?.content).toContain("Len");
    expect(windows?.[0]?.content).not.toContain("LengthyTargetValue");
    expectSourceWindows(content, windows, 4, 4);
  });

  it("does not move a later overlapping anchor past its source start at the midpoint", () => {
    const { content, anchors } = overlapFixture();
    const windows = anchoredExcerptByteWindows(
      content,
      anchors,
      { maxBytes: 24, maxWindows: 2, maxTotalBytes: 48 },
      11,
    );
    expect(windows).toHaveLength(2);
    expect(windows?.[0]?.content).toContain("ABC");
    expect(windows?.[1]?.content).toContain("jkl");
    expectSourceWindows(content, windows, 24, 48);
  });
  it("preserves the clipped anchor starts and source lines through the safe excerpt facade", async () => {
    const { content, anchors } = overlapFixture();
    const result = await readExcerpt(
      searchScope(),
      {
        scopePath: "notes.txt",
        startLine: 1,
        endLine: 3,
        anchors,
        maxBytes: 24,
        maxWindows: 2,
        maxTotalBytes: 48,
      },
      { fs: memFs("/ws", { "notes.txt": content }) },
    );
    expect(result.truncated).toBe(true);
    expect(result.windows).toHaveLength(2);
    expect(result.windows?.[0]?.content).toContain("ABC");
    expect(result.windows?.[1]?.content).toContain("jkl");
    for (const window of result.windows ?? []) {
      expect(window.atom.lineRange).toEqual({ startLine: 2, endLine: 2 });
      expect(window.atom.scopePath).toBe("notes.txt");
      expect(window.truncated).toBe(true);
    }
    expect(
      (result.windows ?? []).reduce(
        (bytes, window) => bytes + Buffer.byteLength(window.content),
        0,
      ),
    ).toBeLessThanOrEqual(48);
  });
});
