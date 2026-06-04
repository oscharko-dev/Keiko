// Public facade for the exploration planner and budget governor (Epic #177, Issue #181).
// Thin wrapper over createExplorationPlan + createGovernor so external consumers can plan
// and arm a governor in one call without knowing the internal file layout.

import {
  createExplorationPlan,
  type CreatePlanDeps,
  type CreatePlanInput,
  type ExplorationPlan,
} from "./plan.js";
import { createGovernor, type GovernorState } from "./governor.js";

export function planExploration(input: CreatePlanInput, deps?: CreatePlanDeps): ExplorationPlan {
  return createExplorationPlan(input, deps);
}

export interface PlanAndGovernResult {
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState | undefined;
}

export function planAndGovern(input: CreatePlanInput, deps?: CreatePlanDeps): PlanAndGovernResult {
  const plan = createExplorationPlan(input, deps);
  if (plan.state !== "ready") {
    return { plan, governor: undefined };
  }
  return { plan, governor: createGovernor(plan) };
}
