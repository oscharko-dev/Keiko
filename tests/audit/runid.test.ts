import { describe, expect, it } from "vitest";
import { assertValidRunId } from "../../src/audit/runid.js";
import { InvalidRunIdError } from "../../src/audit/errors.js";

const NUL = String.fromCharCode(0);

describe("assertValidRunId", () => {
  it.each(["run-123", "abc_DEF.456", "r", "a-b_c.d-1"])("accepts a normal id %s", (id) => {
    expect(() => {
      assertValidRunId(id);
    }).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["dot-dot", ".."],
    ["forward slash", "a/b"],
    ["back slash", "a\\b"],
    ["NUL byte", `a${NUL}b`],
    ["leading dot", ".hidden"],
    ["traversal segment", "../escape"],
    ["space", "a b"],
    ["colon", "a:b"],
  ])("rejects %s", (_label, id) => {
    expect(() => {
      assertValidRunId(id);
    }).toThrow(InvalidRunIdError);
  });

  it("rejects an over-length id", () => {
    expect(() => {
      assertValidRunId("a".repeat(257));
    }).toThrow(InvalidRunIdError);
  });

  it("accepts an id at the length cap", () => {
    expect(() => {
      assertValidRunId("a".repeat(256));
    }).not.toThrow();
  });
});
