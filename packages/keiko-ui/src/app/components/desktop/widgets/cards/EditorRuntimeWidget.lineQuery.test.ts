// GEN-PERF-EDITOR-004 — currentLineQueryText must read one line without splitting the entire
// buffer into an N-line array. We assert equivalence with the naive split-based extractor and
// prove String.prototype.split is never called on the buffer for a large file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { currentLineQueryText, lineAtIndex } from "./EditorRuntimeWidget";

function naiveLine(text: string, line: number): string {
  return text.split("\n")[line] ?? "";
}

describe("lineAtIndex (GEN-PERF-EDITOR-004)", () => {
  it("matches the split-based extractor across representative lines", () => {
    const text = Array.from(
      { length: 500 },
      (_, i) => `const value${String(i)} = ${String(i)};`,
    ).join("\n");
    for (const line of [0, 1, 249, 499, 500, 1000, -1]) {
      expect(lineAtIndex(text, line)).toBe(naiveLine(text, line));
    }
  });

  it("handles a trailing newline and empty lines", () => {
    const text = "a\n\nb\n";
    expect(lineAtIndex(text, 0)).toBe("a");
    expect(lineAtIndex(text, 1)).toBe("");
    expect(lineAtIndex(text, 2)).toBe("b");
    expect(lineAtIndex(text, 3)).toBe("");
    expect(lineAtIndex(text, 4)).toBe("");
  });
});

describe("currentLineQueryText (GEN-PERF-EDITOR-004)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not split the whole buffer to read a single line's query", () => {
    const bigLine = 3000;
    const text = Array.from({ length: 5000 }, (_, i) => `token_${String(i)}.member`).join("\n");
    const splitSpy = vi.spyOn(String.prototype, "split");

    const query = currentLineQueryText(text, bigLine, "token_3000.".length);

    // The extracted query reflects the correct line …
    expect(query).toContain("token_3000");
    // … and no split() was invoked (the old text.split("\n") path is gone).
    expect(splitSpy).not.toHaveBeenCalled();
  });

  it("returns the identifier fragment before the cursor on the target line", () => {
    const text = "line0\nfoo.bar.baz\nline2";
    // Cursor right after "foo.bar" on line 1.
    expect(currentLineQueryText(text, 1, "foo.bar".length)).toBe("foo.bar");
  });
});
