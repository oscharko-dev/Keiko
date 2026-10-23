import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_RUNTIME_REVERT_ACTIONS,
  CODING_WORKBENCH_RUNTIME_REVERT_MAX_COUNT,
  isCodingWorkbenchRuntimeRevertAction,
  unpairedCodingWorkbenchRuntimeRevertChannelPayload,
  validateCodingWorkbenchRuntimeRevertChannelPayload,
} from "./coding-workbench-runtime-api.js";

const STATE = { staged: false, fileCount: 2, additions: 12, deletions: 4 };

describe("turn revert contract (B3, S04)", () => {
  it("names exactly the two actions the browser may request", () => {
    expect(CODING_WORKBENCH_RUNTIME_REVERT_ACTIONS).toEqual(["undo", "restore"]);
    expect(isCodingWorkbenchRuntimeRevertAction("undo")).toBe(true);
    expect(isCodingWorkbenchRuntimeRevertAction("restore")).toBe(true);
    for (const foreign of ["commit", "clear", "stage", "Undo", "", "undo ", undefined, null, 1]) {
      expect(isCodingWorkbenchRuntimeRevertAction(foreign)).toBe(false);
    }
  });

  it("accepts the constant unpaired projection and a paired payload with or without counts", () => {
    expect(unpairedCodingWorkbenchRuntimeRevertChannelPayload()).toEqual({ session: "unpaired" });
    for (const payload of [
      { session: "unpaired" },
      { session: "active" },
      { session: "active", revert: STATE },
      { session: "active", revert: { ...STATE, staged: true } },
      {
        session: "active",
        revert: { ...STATE, fileCount: CODING_WORKBENCH_RUNTIME_REVERT_MAX_COUNT },
      },
    ]) {
      expect(validateCodingWorkbenchRuntimeRevertChannelPayload(payload).ok).toBe(true);
    }
  });

  it.each([
    ["a non-object", "active"],
    ["an array", []],
    ["a missing session", {}],
    ["an unknown session", { session: "paired" }],
    ["an unknown key", { session: "active", paths: ["a.ts"] }],
    ["revert state on an unpaired caller", { session: "unpaired", revert: STATE }],
    ["a non-object revert", { session: "active", revert: "staged" }],
    ["a missing count", { session: "active", revert: { staged: false, fileCount: 1 } }],
    ["a path smuggled into the state", { session: "active", revert: { ...STATE, path: "a.ts" } }],
    ["a non-boolean staged flag", { session: "active", revert: { ...STATE, staged: "yes" } }],
    ["a negative count", { session: "active", revert: { ...STATE, additions: -1 } }],
    ["a fractional count", { session: "active", revert: { ...STATE, deletions: 0.5 } }],
    ["a string count", { session: "active", revert: { ...STATE, fileCount: "2" } }],
    [
      "a count above the bound",
      {
        session: "active",
        revert: { ...STATE, fileCount: CODING_WORKBENCH_RUNTIME_REVERT_MAX_COUNT + 1 },
      },
    ],
  ])("rejects %s", (_name, payload) => {
    expect(validateCodingWorkbenchRuntimeRevertChannelPayload(payload).ok).toBe(false);
  });
});
