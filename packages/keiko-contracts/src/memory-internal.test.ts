// KEIKO-1024 — memory branded ids reach the memory store, evidence exports and the browser, exactly
// like the sibling prompt-enhancer ids, but were validated for non-emptiness alone. An id could
// carry surrounding whitespace, unbounded length, a control character, a bidi-override that makes it
// render as a different id, or a `../` traversal fragment, and still validate.

import { describe, expect, it } from "vitest";
import { validateMemoryIdString } from "./memory-internal.js";

function reasonsFor(value: unknown): readonly string[] {
  const errors: string[] = [];
  validateMemoryIdString("memory.id", value, errors);
  return errors;
}

describe("validateMemoryIdString", () => {
  it.each(["mem-1", "memory:abc-123", "A1._:-"])("accepts the well-formed id %s", (value) => {
    expect(reasonsFor(value)).toEqual([]);
  });

  it.each([
    ["a non-string", 7],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["leading whitespace", " mem-1"],
    ["trailing whitespace", "mem-1 "],
  ])("rejects %s", (_label, value) => {
    expect(reasonsFor(value).length).toBeGreaterThan(0);
  });

  it("rejects an id longer than the bound", () => {
    expect(reasonsFor("m".repeat(256))).toEqual([]);
    expect(reasonsFor("m".repeat(257)).length).toBeGreaterThan(1 - 1);
    expect(reasonsFor("m".repeat(257))).not.toEqual([]);
  });

  it("rejects a non-NFKC-normalised id", () => {
    // U+FF41 FULLWIDTH LATIN SMALL LETTER A normalises to "a" under NFKC.
    expect(reasonsFor("\uff41mem")).not.toEqual([]);
  });

  it.each([0x202e, 0x200b, 0x2066, 0x2060, 0xfeff, 0x0000, 0x001f])(
    "rejects an id containing U+%s",
    (codePoint) => {
      expect(reasonsFor(`mem${String.fromCodePoint(codePoint)}1`)).not.toEqual([]);
    },
  );

  it.each(["../secrets", "mem/1", "mem\\1"])("rejects the path fragment in %j", (value) => {
    expect(reasonsFor(value)).not.toEqual([]);
  });

  // stripUnsafeFormatChars (text-safety.ts) deliberately PRESERVES TAB/LF/CR for legitimate
  // multi-line text content, so the control-character gate above must not rely on it alone for an
  // identifier: an id is a single token, and an embedded newline or tab is itself the defect (it
  // can smuggle a fake extra record into a line-oriented export, or make two ids that render
  // differently compare equal). Distinct from the bidi/zero-width/control set above, which
  // stripUnsafeFormatChars does catch.
  it.each([
    ["TAB", 0x09],
    ["LF", 0x0a],
    ["CR", 0x0d],
  ])("rejects an id containing an embedded %s", (_label, codePoint) => {
    expect(reasonsFor(`mem${String.fromCodePoint(codePoint)}forged`)).not.toEqual([]);
  });
});
