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

import * as publicRemediation from "@oscharko-dev/keiko-contracts/runtime/update-remediation";

describe("source and public remediation decision preservation", () => {
  for (const [surface, parse] of [
    ["source", parseUpdateRemediationActionRequest],
    ["public", publicRemediation.parseUpdateRemediationActionRequest],
  ] as const) {
    it.each(["run", "defer"])(`${surface}: retains admitted decision %s`, (decision) => {
      expect(parse({ actionId: "action-1", decision })).toEqual({
        ok: true,
        value: { actionId: "action-1", decision },
      });
    });
    it.each([null, 1, "foreign", {}, []])(
      `${surface}: refuses malformed decision %j`,
      (decision) => {
        expect(parse({ actionId: "action-1", decision })).toEqual({
          ok: false,
          errors: ["decision must be run or defer"],
        });
      },
    );
    it(`${surface}: preserves omission and explicit undefined`, () => {
      expect(parse({ actionId: "action-1" })).toEqual({
        ok: true,
        value: { actionId: "action-1" },
      });
      expect(parse({ actionId: "action-1", decision: undefined })).toEqual({
        ok: true,
        value: { actionId: "action-1" },
      });
    });
  }
});

describe("copied persist admission", () => {
  for (const [surface, parse] of [
    ["source", parseUpdateRemediationStatusRequest],
    ["public", publicRemediation.parseUpdateRemediationStatusRequest],
  ] as const) {
    it(`${surface}: refuses the malformed final copied persist flag`, () => {
      let reads = 0;
      const input = {
        get persist(): unknown {
          reads += 1;
          return reads === 4 ? "invalid" : true;
        },
      };
      expect(parse(input)).toEqual({ ok: false, errors: ["persist must be a boolean"] });
      expect(reads).toBe(4);
    });
    it(`${surface}: preserves a healthy changing final copied persist flag`, () => {
      let reads = 0;
      const input = {
        get persist(): unknown {
          reads += 1;
          return reads === 4 ? false : true;
        },
      };
      expect(parse(input)).toEqual({ ok: true, value: { persist: false } });
      expect(reads).toBe(4);
    });
  }
});

describe("Consolidated Support physical arrays", () => {
  for (const [surface, parse] of [
    ["source", parseUpdateRemediationActionRequest],
    ["public", publicRemediation.parseUpdateRemediationActionRequest],
  ] as const) {
    it(`${surface}: healthy preserves impact references`, () => {
      const affectedStateStores = ["memory-vault"];
      const stateImpact = [
        {
          store: "memory-vault",
          description: "upgrade",
          remediation: "migration-required",
          userActionRequired: false,
        },
      ];
      const result = parse({ actionId: "fixture", impact: { affectedStateStores, stateImpact } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("healthy impact required");
      expect(result.value.impact?.affectedStateStores).toBe(affectedStateStores);
      expect(result.value.impact?.stateImpact).toBe(stateImpact);
    });
    for (const [field, message] of [
      ["affectedStateStores", "impact.affectedStateStores must be a string array"],
      ["stateImpact", "impact.stateImpact must contain release-impact state entries"],
    ] as const) {
      it(`${surface}: unsafe refuses physical ${field}`, () => {
        const entries = Object.assign([42], { every: (): boolean => true });
        expect(parse({ actionId: "fixture", impact: { [field]: entries } })).toEqual({
          ok: false,
          errors: [message],
        });
      });
    }
  }
});
