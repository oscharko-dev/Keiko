import { describe, expect, it } from "vitest";

import { reservePromptWithCiRepair } from "./ciRepairPromptReservation.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";

type Authority = Pick<
  CodingRuntimeAuthorityService,
  "reservePromptTokens" | "authenticateCapability"
> &
  Partial<Pick<CodingRuntimeAuthorityService, "recordCiRepairPromptRefusal">>;

function fakeBudget(chargePrompt: (promptTokens: number) => boolean): CiRepairExecutionBudget {
  return {
    admitTool: () => undefined,
    canChargePrompt: chargePrompt,
    chargePrompt,
    observed: () => undefined,
  };
}

// Owner audit finding b2-3 (PR #3394): a prompt-token reservation was never released when the
// CI-repair budget rejected it. `reservePromptTokens` was charged unconditionally BEFORE the
// repair budget was consulted, so a `blocked` repair record left every further model call for the
// run silently draining the run's real authority-level prompt budget with nothing to reverse the
// charge. This test fails against that ordering (the fake authority records every accepted call,
// and a blocked repair budget used to still show one) and passes once the repair budget is
// consulted first.
describe("reservePromptWithCiRepair", () => {
  it("never reserves the real authority budget when the CI-repair budget rejects (b2-3)", () => {
    let realReservationCount = 0;
    const authority: Authority = {
      authenticateCapability: (_capability, audience) =>
        audience === "model-gateway"
          ? {
              ok: true,
              issuedAtMs: 0,
              binding: {
                runId: "run-1",
                workspaceRootDigest: "a".repeat(64),
                envelopeDigest: "b".repeat(64),
                adapterKind: "model-gateway-sidecar",
                audience: "model-gateway",
                expiresAtMs: Date.parse("2026-09-05T12:00:00.000Z"),
              },
            }
          : { ok: false, reason: "invalid" },
      reservePromptTokens: () => {
        realReservationCount += 1;
        return { ok: true, runId: "run-1" };
      },
    };
    const blockedBudget = fakeBudget(() => false);

    const result = reservePromptWithCiRepair(authority, () => blockedBudget, "cap-1", 500);

    expect(result).toEqual({ ok: false, reason: "authority-budget-exceeded" });
    // The failure-before behaviour reserved the real budget unconditionally and only rejected
    // afterward, leaving the reservation charged with nothing to release it. Fixed, the real
    // reservation is never even requested once the repair budget has already said no.
    expect(realReservationCount).toBe(0);
  });

  it("reserves the real authority budget once the CI-repair budget admits the call", () => {
    const authority: Authority = {
      authenticateCapability: () => ({
        ok: true,
        issuedAtMs: 0,
        binding: {
          runId: "run-2",
          workspaceRootDigest: "a".repeat(64),
          envelopeDigest: "b".repeat(64),
          adapterKind: "model-gateway-sidecar",
          audience: "model-gateway",
          expiresAtMs: Date.parse("2026-09-05T12:00:00.000Z"),
        },
      }),
      reservePromptTokens: (_capability, promptTokens) => {
        expect(promptTokens).toBe(500);
        return { ok: true, runId: "run-2" };
      },
    };
    let chargedWith: number | undefined;
    const admittingBudget = fakeBudget((promptTokens) => {
      chargedWith = promptTokens;
      return true;
    });

    const result = reservePromptWithCiRepair(authority, () => admittingBudget, "cap-2", 500);

    expect(result).toEqual({ ok: true, runId: "run-2" });
    expect(chargedWith).toBe(500);
  });

  it("falls through to the ordinary authority reservation when no CI-repair budget is bound to the run", () => {
    const authority: Authority = {
      authenticateCapability: () => ({
        ok: true,
        issuedAtMs: 0,
        binding: {
          runId: "run-3",
          workspaceRootDigest: "a".repeat(64),
          envelopeDigest: "b".repeat(64),
          adapterKind: "model-gateway-sidecar",
          audience: "model-gateway",
          expiresAtMs: Date.parse("2026-09-05T12:00:00.000Z"),
        },
      }),
      reservePromptTokens: () => ({ ok: true, runId: "run-3" }),
    };

    const result = reservePromptWithCiRepair(authority, () => undefined, "cap-3", 100);

    expect(result).toEqual({ ok: true, runId: "run-3" });
  });

  // #3873 review (PR #3876): the early return that spares the real budget (b2-3) also skipped the
  // authority's record of why the run's last model call was refused, which a failed run's settlement
  // reads to name its prompt allowance. The refusal is recorded where the authority's own is.
  describe("the refusal a CI-repair budget answers", () => {
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

    it("records the refusal for the run, still without reserving the real authority budget", () => {
      const refusals: string[] = [];
      let reservations = 0;
      const authority: Authority = {
        authenticateCapability: () => binding("run-refused"),
        reservePromptTokens: () => {
          reservations += 1;
          return { ok: true, runId: "run-refused" };
        },
        recordCiRepairPromptRefusal: (runId): void => {
          refusals.push(runId);
        },
      };

      const result = reservePromptWithCiRepair(
        authority,
        () => fakeBudget(() => false),
        "cap-refused",
        500,
      );

      expect(result).toEqual({ ok: false, reason: "authority-budget-exceeded" });
      expect(refusals).toEqual(["run-refused"]);
      expect(reservations).toBe(0);
    });

    it("records the refusal of a charge the budget declines after the authority admitted the call", () => {
      const refusals: string[] = [];
      const authority: Authority = {
        authenticateCapability: () => binding("run-declined"),
        reservePromptTokens: () => ({ ok: true, runId: "run-declined" }),
        recordCiRepairPromptRefusal: (runId): void => {
          refusals.push(runId);
        },
      };
      // The budget admitted the estimate, then refused the charge itself.
      const budget: CiRepairExecutionBudget = {
        ...fakeBudget(() => false),
        canChargePrompt: () => true,
      };

      expect(reservePromptWithCiRepair(authority, () => budget, "cap-declined", 500)).toEqual({
        ok: false,
        reason: "authority-budget-exceeded",
      });
      expect(refusals).toEqual(["run-declined"]);
    });

    it("records nothing for a call the budget admits or the authority itself refuses", () => {
      const refusals: string[] = [];
      const record = (runId: string): void => {
        refusals.push(runId);
      };
      const admitted: Authority = {
        authenticateCapability: () => binding("run-admitted"),
        reservePromptTokens: () => ({ ok: true, runId: "run-admitted" }),
        recordCiRepairPromptRefusal: record,
      };
      expect(
        reservePromptWithCiRepair(admitted, () => fakeBudget(() => true), "cap-admitted", 10).ok,
      ).toBe(true);
      expect(reservePromptWithCiRepair(admitted, () => undefined, "cap-admitted", 10).ok).toBe(
        true,
      );

      // The authority's own refusal is recorded by the authority, not a second time here.
      const refusing: Authority = {
        authenticateCapability: () => binding("run-authority"),
        reservePromptTokens: () => ({ ok: false, reason: "authority-budget-exceeded" }),
        recordCiRepairPromptRefusal: record,
      };
      expect(
        reservePromptWithCiRepair(refusing, () => fakeBudget(() => true), "cap-authority", 10),
      ).toEqual({ ok: false, reason: "authority-budget-exceeded" });

      // A capability that does not authenticate has no run to record anything for.
      const unauthenticated: Authority = {
        authenticateCapability: () => ({ ok: false, reason: "expired" }),
        reservePromptTokens: () => ({ ok: false, reason: "authority-expired" }),
        recordCiRepairPromptRefusal: record,
      };
      reservePromptWithCiRepair(unauthenticated, () => fakeBudget(() => false), "cap-bad", 10);

      expect(refusals).toEqual([]);
    });
  });

  it("still surfaces the authority's own rejection when capability authentication itself fails", () => {
    const authority: Authority = {
      authenticateCapability: () => ({ ok: false, reason: "expired" }),
      reservePromptTokens: () => ({ ok: false, reason: "authority-expired" }),
    };

    const result = reservePromptWithCiRepair(authority, () => fakeBudget(() => true), "cap-4", 10);

    expect(result).toEqual({ ok: false, reason: "authority-expired" });
  });
});
