// Request-parser tests for the update-remediation contract.
//
// Added with KEIKO-0326, which replaced this module's private copy of the target-version shape rule
// (a duplicated pattern plus length bound) with the shared `validTargetVersion` from
// update-session.ts. That removed covered lines from a thinly-tested file and dropped it under its
// governed per-file coverage floor — the ratchet caught it, which is what the ratchet is for. These
// tests cover the parse boundary the change actually touched rather than restoring the deleted
// duplicate.

import { describe, expect, it } from "vitest";
import {
  isUpdateRemediationStatus,
  isUpdateStateStore,
  parseUpdateRemediationActionRequest,
  parseUpdateRemediationStatusRequest,
  UPDATE_REMEDIATION_DECISIONS,
} from "./update-remediation.js";

describe("parseUpdateRemediationStatusRequest", () => {
  it("accepts an empty request — every field is optional", () => {
    expect(parseUpdateRemediationStatusRequest({})).toEqual({ ok: true, value: {} });
  });

  it("rejects a non-object", () => {
    for (const input of [null, undefined, 7, "x", []]) {
      expect(parseUpdateRemediationStatusRequest(input).ok).toBe(false);
    }
  });

  it("accepts a well-formed target version and carries it through", () => {
    const parsed = parseUpdateRemediationStatusRequest({ targetVersion: "1.2.3" });
    expect(parsed).toEqual({ ok: true, value: { targetVersion: "1.2.3" } });
  });

  // The shape rule now lives in update-session.ts and is shared with parseTargetVersion here, so
  // these are the same rejections that predicate pins — reached through this parser.
  it.each(["1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.3-rc1", "", " 1.2.3", "1".repeat(65)])(
    "rejects the malformed target version %j",
    (targetVersion) => {
      expect(parseUpdateRemediationStatusRequest({ targetVersion }).ok).toBe(false);
    },
  );

  it("rejects a non-boolean persist flag and accepts a boolean one", () => {
    expect(parseUpdateRemediationStatusRequest({ persist: "yes" }).ok).toBe(false);
    expect(parseUpdateRemediationStatusRequest({ persist: true })).toEqual({
      ok: true,
      value: { persist: true },
    });
  });
});

describe("parseUpdateRemediationActionRequest", () => {
  it("requires an actionId", () => {
    expect(parseUpdateRemediationActionRequest({}).ok).toBe(false);
    expect(parseUpdateRemediationActionRequest({ actionId: "" }).ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(parseUpdateRemediationActionRequest(null).ok).toBe(false);
  });

  it("rejects a decision outside the closed set and accepts each member", () => {
    expect(parseUpdateRemediationActionRequest({ actionId: "act-1", decision: "maybe" }).ok).toBe(
      false,
    );
    for (const decision of UPDATE_REMEDIATION_DECISIONS) {
      expect(parseUpdateRemediationActionRequest({ actionId: "act-1", decision }).ok).toBe(true);
    }
  });

  it("applies the same target-version rule as the status request", () => {
    expect(
      parseUpdateRemediationActionRequest({ actionId: "act-1", targetVersion: "1.2.3" }).ok,
    ).toBe(true);
    expect(
      parseUpdateRemediationActionRequest({ actionId: "act-1", targetVersion: "v1.2.3" }).ok,
    ).toBe(false);
  });
});

describe("closed-set membership guards", () => {
  it("recognises exactly the declared remediation statuses", () => {
    expect(isUpdateRemediationStatus("pending")).toBe(true);
    expect(isUpdateRemediationStatus("not-a-status")).toBe(false);
    expect(isUpdateRemediationStatus(7)).toBe(false);
  });

  it("recognises exactly the declared state stores", () => {
    expect(isUpdateStateStore("not-a-store")).toBe(false);
    expect(isUpdateStateStore(null)).toBe(false);
  });
});
