import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type { CiRepairBudgetBlockReason } from "./codingRuntimeCiRepairBudgetTypes.js";

type CiRepairAdmission = ReturnType<CodingRuntimeAuthorityService["admitModelCall"]>;

/**
 * Admits one model call of a run: the run's CI-repair budget first, then the run's own authority.
 * Keiko does not limit tokens (#4346), so neither side charges anything: the repair budget admits
 * the call against its time and authority limits, and the authority only checks the run is live.
 *
 * Owner audit finding b2-3 (PR #3394): the run's authority must never be touched for a call the
 * repair budget refuses. `authenticateCapability` is a pure, side-effect-free read (it only
 * verifies the capability's binding), so resolving the run identity through it first, asking the
 * CI-repair budget for that run, and consulting the authority only once the repair budget admits
 * the call keeps a rejected repair budget from reaching the authority at all.
 *
 * #3873 review (PR #3876): a refusal by the repair budget is recorded where the authority's own
 * refusal is (`recordCiRepairModelCallRefusal`) with the closed reason the budget refused with, so the
 * run's terminal cause names the repair's runtime limit and nothing else.
 */
export function admitModelCallWithCiRepair(
  authority: Pick<CodingRuntimeAuthorityService, "admitModelCall" | "authenticateCapability"> &
    Partial<Pick<CodingRuntimeAuthorityService, "recordCiRepairModelCallRefusal">>,
  budgetForRun: (runId: string) => CiRepairExecutionBudget | undefined,
  capability: string,
): CiRepairAdmission {
  const authenticated = authority.authenticateCapability(capability, "model-gateway");
  if (authenticated.ok) {
    const runId = authenticated.binding.runId;
    const admitted = budgetForRun(runId)?.admitModelCall();
    if (admitted?.accepted === false) return refusedByCiRepair(authority, runId, admitted.reason);
  }
  return authority.admitModelCall(capability);
}

// The call is refused as the authority refuses a call it cannot admit, and the closed reason the
// CI-repair budget gave is recorded beside it for the run's terminal cause.
function refusedByCiRepair(
  authority: Partial<Pick<CodingRuntimeAuthorityService, "recordCiRepairModelCallRefusal">>,
  runId: string,
  reason: CiRepairBudgetBlockReason,
): CiRepairAdmission {
  authority.recordCiRepairModelCallRefusal?.(runId, reason);
  return { ok: false, reason: "authority-budget-exceeded" };
}
