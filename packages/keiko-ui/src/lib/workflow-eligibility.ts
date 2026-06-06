// Issue #153 — workflow-eligibility helper for the Conversation Center handoff.
//
// AC #2 requires that the workflow launch surface use a STRICTER model filter than the
// general conversation filter (`isConversationEligibleModel`, which is just `kind === "chat"`).
// A workflow run REQUIRES a model that can also drive tool calls and emit structured output,
// because the workflow surface relies on both. The same predicate was already used by the
// pre-Conversation-Center `NewWindowDialog` launcher under the local name `isAgentWorkflowModel`;
// promoting it to `@/lib` gives both surfaces a single source of truth and lets the new in-chat
// launcher (ChatWindow + WorkflowHandoff) and the legacy modal stay byte-identical on the rule.
//
// Pure, total, no side effects. Pinned by WorkflowHandoff.test.tsx (workflow handoff suite) and
// NewWindowDialog.test.tsx (legacy launcher) for cross-surface drift detection.
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
