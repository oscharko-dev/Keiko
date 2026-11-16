import { describe, expect, it } from "vitest";
import * as contract from "@oscharko-dev/keiko-contracts/runtime/process-environment";
import { environmentVariableNames, environmentVariableValue } from "./process-environment.js";

describe("process environment compatibility exports", () => {
  it("preserves the canonical owner for existing security consumers", () => {
    expect(environmentVariableNames).toBe(contract.environmentVariableNames);
    expect(environmentVariableValue).toBe(contract.environmentVariableValue);
  });
});
