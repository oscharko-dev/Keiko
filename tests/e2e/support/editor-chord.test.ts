// Negative fixtures for the buffer-replacement postcondition (PR #3355 review, P2). The helper it
// guards runs only inside Playwright, so the decision itself was extracted into a pure function —
// otherwise the two corruptions below are only ever exercised against a live editor, which is
// exactly why they went unnoticed: both PASSED the old check.
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorModifier, replacementViolations } from "./editor-chord.js";

const NEW = ['export const value = "new";'];
const OLD = ['export const value = "old";'];

// `editorModifier`'s "Meta" branch is dead under every currently-wired device profile — both the
// chromium and firefox projects in playwright.config.ts force a Windows user agent, so nothing in
// the live suite ever exercises it, and a typo in the callback ("macOS" instead of "Macintosh")
// would pass every real run silently (PR #3355 review, IDX45). This exercises both branches
// directly against a fake `Page` whose `evaluate()` runs editorModifier's REAL browser-side
// callback against a stubbed global `navigator`, rather than re-deriving the substring check here
// — a re-derived fixture could not catch a typo in the production callback because both sides
// would drift together (AGENTS.md §7).
function fakePageWithUserAgent(userAgent: string): Page {
  return {
    evaluate: <T>(pageFunction: () => T) => {
      vi.stubGlobal("navigator", { userAgent });
      return Promise.resolve(pageFunction());
    },
  } as unknown as Page;
}

describe("editorModifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves "Meta" when the browser reports a Macintosh user agent', async () => {
    const page = fakePageWithUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    await expect(editorModifier(page)).resolves.toBe("Meta");
  });

  it('resolves "Control" for a non-Macintosh user agent (this suite\'s forced Windows UA)', async () => {
    const page = fakePageWithUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    await expect(editorModifier(page)).resolves.toBe("Control");
  });
});

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
