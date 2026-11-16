import { describe, expect, it } from "vitest";

import { admitModelCallWithCiRepair } from "./ciRepairModelCallAdmission.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type {
  CiRepairExecutionBudget,
  CiRepairPromptAdmission,
} from "./codingRuntimeCiRepairController.js";
import type { CiRepairBudgetBlockReason } from "./codingRuntimeCiRepairBudgetTypes.js";

type Authority = Pick<CodingRuntimeAuthorityService, "admitModelCall" | "authenticateCapability"> &
  Partial<Pick<CodingRuntimeAuthorityService, "recordCiRepairModelCallRefusal">>;

const ADMITTED: CiRepairPromptAdmission = { accepted: true };

function refusal(reason: CiRepairBudgetBlockReason): CiRepairPromptAdmission {
  return { accepted: false, reason };
}

function fakeBudget(admitModelCall: () => CiRepairPromptAdmission): CiRepairExecutionBudget {
  return {
    admitTool: () => undefined,
    admitModelCall,
    observed: () => undefined,
  };
}

const binding = (runId: string): ReturnType<Authority["authenticateCapability"]> => ({
  ok: true,
  issuedAtMs: 0,
  binding: {
    runId,
    workspaceRootDigest: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    adapterKind: "model-gateway-sidecar",
    audience: "model-gateway",
    expiresAtMs: Date.parse("2026-09-05T12:00:00.000Z"),
  },
});

// Owner audit finding b2-3 (PR #3394): the run's authority must never be consulted for a call the
// CI-repair budget refuses. Keiko does not limit tokens (#4346), so neither side charges anything
// for the call's prompt: the repair budget admits against its time and authority limits and the
// authority only checks the run is live.
describe("admitModelCallWithCiRepair", () => {
  it("never consults the authority when the CI-repair budget rejects (b2-3)", () => {
    let authorityAdmissions = 0;
    const authority: Authority = {
      authenticateCapability: (_capability, audience) =>
        audience === "model-gateway" ? binding("run-1") : { ok: false, reason: "invalid" },
      admitModelCall: () => {
        authorityAdmissions += 1;
        return { ok: true, runId: "run-1" };
      },
    };

    const result = admitModelCallWithCiRepair(
      authority,
      () => fakeBudget(() => refusal("deadline-exhausted")),
      "cap-1",
    );

    expect(result).toEqual({ ok: false, reason: "authority-budget-exceeded" });
    expect(authorityAdmissions).toBe(0);
  });

  it("admits through the authority once the CI-repair budget admits the call", () => {
    const authority: Authority = {
      authenticateCapability: () => binding("run-2"),
      admitModelCall: () => ({ ok: true, runId: "run-2" }),
    };
    let budgetAdmissions = 0;
    const admittingBudget = fakeBudget(() => {
      budgetAdmissions += 1;
      return ADMITTED;
    });

    const result = admitModelCallWithCiRepair(authority, () => admittingBudget, "cap-2");

    expect(result).toEqual({ ok: true, runId: "run-2" });
    expect(budgetAdmissions).toBe(1);
  });

  it("falls through to the ordinary authority admission when no CI-repair budget is bound to the run", () => {
    const authority: Authority = {
      authenticateCapability: () => binding("run-3"),
      admitModelCall: () => ({ ok: true, runId: "run-3" }),
    };

    const result = admitModelCallWithCiRepair(authority, () => undefined, "cap-3");

    expect(result).toEqual({ ok: true, runId: "run-3" });
  });

  // #3873 review (PR #3876): the early return that spares the authority (b2-3) also skipped the
  // authority's record of why the run's last model call was refused, which a failed run's settlement
  // reads to name the limit. The refusal is recorded where the authority's own is, with the closed
  // reason the CI-repair budget gave.
  describe("the refusal a CI-repair budget answers", () => {
    // Every closed reason the budget can refuse with, as a record the compiler keeps complete: a
    // reason added to the vocabulary must be listed here before this file compiles.
    const EVERY_REASON: Record<CiRepairBudgetBlockReason, true> = {
      "authority-denied": true,
      "invalid-binding": true,
      "invalid-input": true,
      "stale-revision": true,
      "clock-drift": true,
      "deadline-exhausted": true,
      "tool-budget-exhausted": true,
      "attempt-budget-exhausted": true,
      "storage-capacity": true,
      "attempt-active": true,
      "attempt-replayed": true,
      "attempt-missing": true,
      "recovery-required": true,
      "storage-unavailable": true,
    };
    const REASONS = Object.keys(EVERY_REASON) as CiRepairBudgetBlockReason[];

    it.each(REASONS)(
      "records the exact %s a check refused with for the run, still without consulting the authority",
      (reason) => {
        const refusals: (readonly [string, CiRepairBudgetBlockReason])[] = [];
        let admissions = 0;
        const authority: Authority = {
          authenticateCapability: () => binding("run-refused"),
          admitModelCall: () => {
            admissions += 1;
            return { ok: true, runId: "run-refused" };
          },
          recordCiRepairModelCallRefusal: (runId, recorded): void => {
            refusals.push([runId, recorded]);
          },
        };

        const result = admitModelCallWithCiRepair(
          authority,
          () => fakeBudget(() => refusal(reason)),
          "cap-refused",
        );

        expect(result).toEqual({ ok: false, reason: "authority-budget-exceeded" });
        expect(refusals).toEqual([["run-refused", reason]]);
        expect(admissions).toBe(0);
      },
    );

    it("records nothing for a call the budget admits or the authority itself refuses", () => {
      const refusals: string[] = [];
      const record = (runId: string): void => {
        refusals.push(runId);
      };
      const admitted: Authority = {
        authenticateCapability: () => binding("run-admitted"),
        admitModelCall: () => ({ ok: true, runId: "run-admitted" }),
        recordCiRepairModelCallRefusal: record,
      };
      expect(
        admitModelCallWithCiRepair(admitted, () => fakeBudget(() => ADMITTED), "cap-admitted").ok,
      ).toBe(true);
      expect(admitModelCallWithCiRepair(admitted, () => undefined, "cap-admitted").ok).toBe(true);

      // The authority's own refusal is recorded by the authority, not a second time here.
      const refusing: Authority = {
        authenticateCapability: () => binding("run-authority"),
        admitModelCall: () => ({ ok: false, reason: "authority-budget-exceeded" }),
        recordCiRepairModelCallRefusal: record,
      };
      expect(
        admitModelCallWithCiRepair(refusing, () => fakeBudget(() => ADMITTED), "cap-authority"),
      ).toEqual({ ok: false, reason: "authority-budget-exceeded" });

      // A capability that does not authenticate has no run to record anything for.
      const unauthenticated: Authority = {
        authenticateCapability: () => ({ ok: false, reason: "expired" }),
        admitModelCall: () => ({ ok: false, reason: "authority-expired" }),
        recordCiRepairModelCallRefusal: record,
      };
      admitModelCallWithCiRepair(
        unauthenticated,
        () => fakeBudget(() => refusal("deadline-exhausted")),
        "cap-bad",
      );

      expect(refusals).toEqual([]);
    });
  });

  it("still surfaces the authority's own rejection when capability authentication itself fails", () => {
    const authority: Authority = {
      authenticateCapability: () => ({ ok: false, reason: "expired" }),
      admitModelCall: () => ({ ok: false, reason: "authority-expired" }),
    };

    const result = admitModelCallWithCiRepair(authority, () => fakeBudget(() => ADMITTED), "cap-4");

    expect(result).toEqual({ ok: false, reason: "authority-expired" });
  });
});
