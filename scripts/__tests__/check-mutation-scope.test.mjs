import { describe, expect, it } from "vitest";

import { requiresSecurityMutation } from "../check-mutation-scope.mjs";

describe("mutation scope", () => {
  it("requires mutation testing for governed and security-critical production code", () => {
    expect(requiresSecurityMutation(["packages/keiko-security/src/redaction.ts"])).toBe(true);
    expect(
      requiresSecurityMutation([
        "packages/keiko-server/src/coding-runtime/supervisedCodingPolicy.ts",
      ]),
    ).toBe(true);
    expect(requiresSecurityMutation(["packages/keiko-workflows/src/authority.ts"])).toBe(true);
  });

  it("does not spend mutation time on documentation or tests only", () => {
    expect(requiresSecurityMutation(["docs/qa/mutation-testing.md"])).toBe(false);
    expect(requiresSecurityMutation(["packages/keiko-security/src/redaction.test.ts"])).toBe(false);
  });
});
