import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";

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
 */
export function reservePromptWithCiRepair(
  authority: Pick<CodingRuntimeAuthorityService, "reservePromptTokens" | "authenticateCapability">,
  budgetForRun: (runId: string) => CiRepairExecutionBudget | undefined,
  capability: string,
  promptTokens: number,
): ReturnType<CodingRuntimeAuthorityService["reservePromptTokens"]> {
  const authenticated = authority.authenticateCapability(capability, "model-gateway");
  if (authenticated.ok) {
    const budget = budgetForRun(authenticated.binding.runId);
    if (budget?.chargePrompt(promptTokens) === false) {
      return { ok: false, reason: "authority-budget-exceeded" };
    }
  }
  return authority.reservePromptTokens(capability, promptTokens);
}
