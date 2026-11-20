import { describe, expect, it } from "vitest";

import { CODING_WORKBENCH_RUNTIME_FAILURE_CODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

import { classifyManagerStartFailure } from "./launchFailure.js";
import {
  isSupervisorRefusalFailureCode,
  supervisorRefusalFailureCode,
} from "./supervisorRefusal.js";

describe("supervisorRefusalFailureCode", () => {
  it.each([
    ["supervisor-grants-acl", "runtime-supervisor-grants-acl"],
    ["supervisor-grants-directory", "runtime-supervisor-grants-directory"],
    ["supervisor-grants-capability", "runtime-supervisor-grants-capability"],
    ["supervisor-gateway-connect", "runtime-supervisor-gateway-connect"],
    ["supervisor-gateway-admit", "runtime-supervisor-gateway-admit"],
    ["supervisor-protocol", "runtime-supervisor-refused"],
    ["supervisor-job-create", "runtime-supervisor-refused"],
    ["supervisor-process-create", "runtime-supervisor-refused"],
    ["supervisor-environment-guard", "runtime-supervisor-refused"],
    ["supervisor-unknown", "runtime-supervisor-refused"],
  ])("maps %s to %s", (refusal, code) => {
    expect(supervisorRefusalFailureCode(refusal)).toBe(code);
    expect(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).toContain(code);
    expect(classifyManagerStartFailure(code as never)).toBe(code);
  });

  it("names no cause for a tree that was not refused", () => {
    expect(supervisorRefusalFailureCode(undefined)).toBeUndefined();
    expect(supervisorRefusalFailureCode("signal")).toBeUndefined();
    expect(isSupervisorRefusalFailureCode("runtime-failed")).toBe(false);
  });

  it("keeps every other start failure on its existing code", () => {
    expect(classifyManagerStartFailure("protocol-schema-mismatch")).toBe("runtime-failed");
    expect(classifyManagerStartFailure("workspace-unqualified")).toBe("workspace-unqualified");
  });
});
