// Public sub-barrel for the exploration planner and budget governor (Epic #177, Issue #181).
// External consumers import every planner symbol through this module; internal modules
// (anchors.ts, plan.ts, governor.ts, explorationPlanner.ts) are implementation detail.

export type {
  AnchorExtractionInput,
  AnchorExtractionResult,
  SearchAnchor,
  SearchAnchorKind,
} from "./anchors.js";
export { extractAnchors } from "./anchors.js";

export type {
  ClarificationPrompt,
  ClarificationReason,
  CreatePlanDeps,
  CreatePlanInput,
  ExplorationPlan,
  ExplorationPlanState,
  RetrievalRing,
  RetrievalRingKind,
} from "./plan.js";
export { createExplorationPlan } from "./plan.js";

export type { GovernorState, GovernorStatus } from "./governor.js";
export { advanceRing, applyUsage, canContinue, complete, createGovernor } from "./governor.js";

export type { PlanAndGovernResult } from "./explorationPlanner.js";
export { planAndGovern, planExploration } from "./explorationPlanner.js";
