import { describe, expect, it } from "vitest";
import { compactIssueKeys } from "./jiraDraftKeyRanges.js";

describe("compactIssueKeys (#4178)", () => {
  it("collapses consecutive keys of one project and keeps every other key exactly", () => {
    expect(
      compactIssueKeys(["SYN-3", "SYN-1", "SYN-2", "SYN-7", "ABC-10", "ABC-11", "SYN-9", "SYN-8"]),
    ).toEqual(["SYN-1..SYN-3", "SYN-7..SYN-9", "ABC-10..ABC-11"]);
  });

  it("ignores duplicates and leaves a value that is not an issue key as it is", () => {
    expect(compactIssueKeys(["SYN-1", "SYN-1", "odd key", "SYN-2"])).toEqual([
      "SYN-1..SYN-2",
      "odd key",
    ]);
  });

  it("stays small for thousands of keys and is empty for none", () => {
    const keys = Array.from({ length: 20_000 }, (_, index) => `SYN-${String(index + 1)}`);
    expect(compactIssueKeys(keys)).toEqual(["SYN-1..SYN-20000"]);
    expect(compactIssueKeys([])).toEqual([]);
  });
});
