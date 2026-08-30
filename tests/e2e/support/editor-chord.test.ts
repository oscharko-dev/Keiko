// Negative fixtures for the buffer-replacement postcondition (PR #3355 review, P2). The helper it
// guards runs only inside Playwright, so the decision itself was extracted into a pure function —
// otherwise the two corruptions below are only ever exercised against a live editor, which is
// exactly why they went unnoticed: both PASSED the old check.
import { describe, expect, it } from "vitest";

import { replacementViolations } from "./editor-chord.js";

const NEW = ['export const value = "new";'];
const OLD = ['export const value = "old";'];

describe("replacementViolations", () => {
  it("accepts a clean replacement", () => {
    expect(replacementViolations(NEW, NEW, OLD)).toEqual([]);
  });

  // The first corruption the review named: a select-all that reached nothing leaves the old buffer
  // in place and `insertText` appends. Every expected line still appears at most once and the
  // anchor is present, so the old check passed this.
  it("rejects stale content that survived alongside the new text", () => {
    const violations = replacementViolations(NEW, [...OLD, ...NEW], OLD);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("stale line");
  });

  // The second: a select-all that wiped the buffer and an insert that never landed. The old check
  // passed this because `anchor.startsWith("")` is true for the empty rendered line.
  it("rejects an empty buffer when text was supposed to be inserted", () => {
    const violations = replacementViolations(NEW, [""], OLD);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("expected the buffer to contain");
  });

  it("rejects the doubling the previous check did catch", () => {
    const violations = replacementViolations(NEW, [...NEW, ...NEW], OLD);
    expect(violations.some((entry) => entry.includes("appears 2x"))).toBe(true);
  });

  // The tolerances that must survive, or the guard would fail correct products.
  it("allows a line the caller legitimately repeated", () => {
    const same = ["same", "same"];
    expect(replacementViolations(same, same, OLD)).toEqual([]);
  });

  it("allows a stale line the new text also contains", () => {
    const kept = ["kept", "fresh"];
    expect(replacementViolations(kept, kept, ["kept"])).toEqual([]);
  });

  it("allows Monaco's ghost text to extend or shorten the anchor line", () => {
    expect(replacementViolations(["ret"], ["return 42;"], OLD)).toEqual([]);
    expect(replacementViolations(["return 42;"], ["return"], OLD)).toEqual([]);
  });

  it("allows a line to go missing when an inline completion replaced it", () => {
    expect(replacementViolations(["first", "second"], ["first"], OLD)).toEqual([]);
  });

  describe("emptying the buffer", () => {
    it("accepts an empty buffer when that is what was asked for", () => {
      expect(replacementViolations([""], [""], OLD)).toEqual([]);
    });

    it("rejects leftovers when the buffer was supposed to be emptied", () => {
      const violations = replacementViolations([""], OLD, OLD);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("expected an empty buffer");
    });
  });
});
