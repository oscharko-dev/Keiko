import { describe, expect, it } from "vitest";

import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";

describe("runtime authority projection", () => {
  it("is deterministic, domain-separated, decimal-only, and never exposes its raw value", () => {
    const sentinel = "secret://customer.example/private/workspace";
    const operator = projectRuntimeAuthorityValue("operator", sentinel);

    expect(operator).toBe(projectRuntimeAuthorityValue("operator", sentinel));
    expect(operator).not.toBe(projectRuntimeAuthorityValue("task", sentinel));
    expect(operator).toMatch(/^operator-[0-9]+$/u);
    expect(operator).not.toContain(sentinel);
  });

  it("does not collapse distinct raw values", () => {
    expect(projectRuntimeAuthorityValue("branch", "issue/2258-a")).not.toBe(
      projectRuntimeAuthorityValue("branch", "issue/2258-b"),
    );
  });
});
