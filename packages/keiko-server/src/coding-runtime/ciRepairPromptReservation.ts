import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";

type CiRepairReservation = ReturnType<CodingRuntimeAuthorityService["reservePromptTokens"]>;

/**
 * The gateway's existing prompt estimate is reserved once, then durably attributed before network
 * dispatch.
 *
 * Owner audit finding b2-3 (PR #3394): this used to reserve the run's real authority-level prompt
 * budget FIRST and only then ask the CI-repair budget, so a repair-budget rejection left the
 * authority charge in place with nothing to release it (`CodingRuntimeAuthorityService` exposes no
 * refund/release for `reservePromptTokens` — the state it consumes lives behind
 * `runtimeAuthorityService.ts` and the editor-owned agent authority registry, both outside this
 * finding's write scope). Once a run's repair record went `blocked`, every further model call for
 * that run silently drained the real budget until an unrelated `authority-budget-exceeded`
 * eventually terminated the run. `authenticateCapability` is a pure, side-effect-free read (it only
 * verifies the capability's binding — no reservation, no charge), so resolving the run identity
 * through it first, checking the CI-repair budget for that run, and reserving the real authority
 * budget only once the repair budget admits the call closes the leak without needing any change to
 * the authority owner's own ledger: a rejected repair budget now returns before the real reservation
 * is ever requested.
 *
 * #3873 review (PR #3876): that early return also bypassed the one place that records why a run's
 * last model call was refused — the authority's own admission record, which a failed run's
 * settlement reads to name its prompt allowance. A run whose CI-repair prompt budget refused its
 * call therefore settled `model-turn-failed` and named no limit. The refusal is now recorded where
 * the authority's own refusal is (`recordCiRepairPromptRefusal`), still without a reservation.
 */
export function reservePromptWithCiRepair(
  authority: Pick<CodingRuntimeAuthorityService, "reservePromptTokens" | "authenticateCapability"> &
    Partial<Pick<CodingRuntimeAuthorityService, "recordCiRepairPromptRefusal">>,
  budgetForRun: (runId: string) => CiRepairExecutionBudget | undefined,
  capability: string,
  promptTokens: number,
): CiRepairReservation {
  const authenticated = authority.authenticateCapability(capability, "model-gateway");
  if (authenticated.ok) {
    const runId = authenticated.binding.runId;
    const budget = budgetForRun(runId);
    if (budget?.canChargePrompt(promptTokens) === false) {
      return refusedByCiRepair(authority, runId);
    }
    const reservation = authority.reservePromptTokens(capability, promptTokens);
    if (!reservation.ok || budget === undefined) return reservation;
    return budget.chargePrompt(promptTokens) ? reservation : refusedByCiRepair(authority, runId);
  }
  return authority.reservePromptTokens(capability, promptTokens);
}

// The CI-repair budget is the run's prompt allowance counted over the repair: its refusal is the
// authority's `authority-budget-exceeded`, and is recorded as one.
function refusedByCiRepair(
  authority: Partial<Pick<CodingRuntimeAuthorityService, "recordCiRepairPromptRefusal">>,
  runId: string,
): CiRepairReservation {
  authority.recordCiRepairPromptRefusal?.(runId);
  return { ok: false, reason: "authority-budget-exceeded" };
}
