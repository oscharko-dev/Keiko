import { describe, expect, it } from "vitest";

import {
  MAX_CONFLICT_CHARS,
  MAX_TRACKED_CONFLICTS,
  conflictReplacement,
  parseConflictMarkers,
} from "./conflict-markers.js";

const TWO_WAY = "<<<<<<< ours\nalpha\n=======\nbeta\n>>>>>>> theirs\n";
const DIFF3 =
  "<<<<<<< local\r\nleft\r\n||||||| base\r\nold\r\n=======\r\nright\r\n>>>>>>> remote\r\n";

describe("parseConflictMarkers", () => {
  it("detects two-way and diff3 blocks with exact byte-preserving regions", () => {
    const text = `head\n${TWO_WAY}middle\r\n${DIFF3}tail`;
    const model = parseConflictMarkers(text);

    expect(model).toMatchObject({ total: 2, truncated: false, malformed: false });
    expect(
      model.conflicts.map((entry) => [entry.oursLabel, entry.baseLabel, entry.theirsLabel]),
    ).toEqual([
      ["ours", "", "theirs"],
      ["local", "base", "remote"],
    ]);
    const [twoWay, diff3] = model.conflicts;
    expect(twoWay === undefined ? "" : conflictReplacement(text, twoWay, "ours")).toBe("alpha\n");
    expect(twoWay === undefined ? "" : conflictReplacement(text, twoWay, "theirs")).toBe("beta\n");
    expect(diff3 === undefined ? "" : conflictReplacement(text, diff3, "both")).toBe(
      "left\r\nright\r\n",
    );
  });

  it.each([
    ["unterminated", "<<<<<<< a\na\n=======\nb\n"],
    ["nested", "<<<<<<< a\n<<<<<<< b\n=======\nb\n>>>>>>> b\n=======\na\n>>>>>>> a\n"],
    ["duplicate base", "<<<<<<< a\n||||||| b\n||||||| c\n=======\nd\n>>>>>>> e\n"],
    ["reversed", "<<<<<<< a\na\n>>>>>>> b\n=======\nc\n"],
    ["orphan", "=======\n"],
  ])("fails closed for %s grammar", (_name, text) => {
    expect(parseConflictMarkers(text)).toEqual({
      conflicts: [],
      total: 0,
      truncated: false,
      malformed: true,
    });
  });

  it("treats indented and token-prefix lookalikes as ordinary source", () => {
    const text = 'const marker = "<<<<<<< ours";\n <<<<<<< ours\n<<<<<<<extra\n';
    expect(parseConflictMarkers(text)).toMatchObject({ total: 0, malformed: false });
  });

  it("caps tracked blocks and oversized content without retaining unsafe ranges", () => {
    const many = TWO_WAY.repeat(MAX_TRACKED_CONFLICTS + 3);
    const capped = parseConflictMarkers(many);
    expect(capped).toMatchObject({ total: MAX_TRACKED_CONFLICTS + 3, truncated: true });
    expect(capped.conflicts).toHaveLength(MAX_TRACKED_CONFLICTS);

    const huge = `<<<<<<< a\n${"x".repeat(MAX_CONFLICT_CHARS)}\n=======\ny\n>>>>>>> b\n`;
    expect(parseConflictMarkers(huge)).toMatchObject({ conflicts: [], total: 1, truncated: true });
  });

  it("never returns a replacement outside its recognized block across hostile line tables", () => {
    for (const ours of ["", "a\n", "=======not-a-marker\n", "🧪\r\n"]) {
      for (const theirs of ["", "z\n", " ||||||| indented\n", "ß\r\n"]) {
        const text = `prefix\n<<<<<<<\n${ours}=======\n${theirs}>>>>>>>\nsuffix\n`;
        const conflict = parseConflictMarkers(text).conflicts[0];
        expect(conflict).toBeDefined();
        if (conflict === undefined) continue;
        const replaced =
          text.slice(0, conflict.range.start) +
          conflictReplacement(text, conflict, "both") +
          text.slice(conflict.range.end);
        expect(replaced.startsWith("prefix\n")).toBe(true);
        expect(replaced.endsWith("suffix\n")).toBe(true);
      }
    }
  });
});
