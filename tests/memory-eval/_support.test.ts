import { describe, expect, it } from "vitest";

import { loadFixture } from "./_support.js";

describe("memory-eval fixture validation", () => {
  it("rejects fixture scopes that omit the coordinate required by their kind", () => {
    expect(() => loadFixture("invalid-scope.json")).toThrow(
      "fixture invalid-scope.json contains a malformed entry",
    );
  });
});
