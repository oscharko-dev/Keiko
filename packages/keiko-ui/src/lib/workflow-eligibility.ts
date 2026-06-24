// Issue #153 — workflow-eligibility helper for Agent widget workflow launches.
//
// AC #2 requires that the workflow launch surface use a STRICTER model filter than the
// general conversation filter (`isConversationEligibleModel`, which is just `kind === "chat"`).
// A workflow run REQUIRES a model that can also drive tool calls and emit structured output,
// because the workflow surface relies on both. The NewWindowDialog launcher exposes the predicate
// under the local name `isAgentWorkflowModel`.
//
// Pure, total, no side effects. Pinned by workflow-eligibility.test.ts and
// NewWindowDialog.test.tsx for launcher drift detection.
//
// ELIG-F1: eligibility is INTENTIONALLY DERIVED from kind + toolCalling +
// structuredOutput, the three runtime capabilities a workflow run actually needs.
// `ModelCapability.workflowEligible` is descriptive provider/registry metadata and
// is deliberately NOT consulted here: it defaults to `false` for unknown discovered
// models, so gating on it would silently break ALL handoff for capable models whose
// provider never set the flag. The derived predicate is the single source of truth;
// `workflowEligible` is a hint, not a gate. Pinned by workflow-eligibility.test.ts.
import type { ModelCapability } from "./types";

export function isWorkflowEligibleModel(model: ModelCapability): boolean {
  return model.kind === "chat" && model.toolCalling && model.structuredOutput;
}
