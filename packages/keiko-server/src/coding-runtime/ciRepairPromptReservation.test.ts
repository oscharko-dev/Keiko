import { describe, expect, it } from "vitest";

import { reservePromptWithCiRepair } from "./ciRepairPromptReservation.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";

type Authority = Pick<
  CodingRuntimeAuthorityService,
  "reservePromptTokens" | "authenticateCapability"
>;

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

  it("still surfaces the authority's own rejection when capability authentication itself fails", () => {
    const authority: Authority = {
      authenticateCapability: () => ({ ok: false, reason: "expired" }),
      reservePromptTokens: () => ({ ok: false, reason: "authority-expired" }),
    };

    const result = reservePromptWithCiRepair(authority, () => fakeBudget(() => true), "cap-4", 10);

    expect(result).toEqual({ ok: false, reason: "authority-expired" });
  });
});
