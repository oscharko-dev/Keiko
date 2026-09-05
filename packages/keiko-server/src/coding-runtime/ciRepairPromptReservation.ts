import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";

/** The gateway's existing prompt estimate is reserved once, then durably attributed before network dispatch. */
export function reservePromptWithCiRepair(
  authority: Pick<CodingRuntimeAuthorityService, "reservePromptTokens">,
  budgetForRun: (runId: string) => CiRepairExecutionBudget | undefined,
  capability: string,
  promptTokens: number,
): ReturnType<CodingRuntimeAuthorityService["reservePromptTokens"]> {
  const reserved = authority.reservePromptTokens(capability, promptTokens);
  if (!reserved.ok) return reserved;
  return budgetForRun(reserved.runId)?.chargePrompt(promptTokens) === false
    ? { ok: false, reason: "authority-budget-exceeded" }
    : reserved;
}
