import { MAX_RUNTIME_MAX_DURATION_MINUTES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { describe, expect, it } from "vitest";

import { MAX_RUNTIME_MAX_DURATION_MINUTES as AUTHORITY_MAXIMUM } from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";

describe("the longest native Coding run", () => {
  it("is one value in the contract and in the runtime authority that enforces it", () => {
    expect(MAX_RUNTIME_MAX_DURATION_MINUTES).toBe(AUTHORITY_MAXIMUM);
  });
});
