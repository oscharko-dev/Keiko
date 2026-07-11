import { describe, expect, it } from "vitest";

import { gitObjectId } from "./gitObjectId";

describe("gitObjectId", () => {
  it("accepts only bounded lower-case SHA-1 and SHA-256 object ids", () => {
    expect(gitObjectId("a".repeat(40))).toBe("a".repeat(40));
    expect(gitObjectId("b".repeat(64))).toBe("b".repeat(64));
    expect(gitObjectId("A".repeat(40))).toBeUndefined();
    expect(gitObjectId("a".repeat(39))).toBeUndefined();
    expect(gitObjectId(`${"a".repeat(40)}:refs/heads/main`)).toBeUndefined();
  });
});
