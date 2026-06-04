// Workflow-outcome candidate extractor for keiko-memory-capture (Epic #204 child #207).
//
// Workflow outcomes are the second canonical capture trigger: a workflow run that completed
// (success) or that the user reviewed and corrected (corrected) produces a candidate memory.
// Failed runs are intentionally NOT a learning surface — they would teach the system from
// incomplete information, which inverts the governance contract.
//
// Output sensitivity follows the policy classifier on the structured report. Workflow scope is
// preferred when the workflow definition id is available (so the memory rides with the workflow,
// not with a single conversation); we fall back to user scope when no workflow id is present.

import type { MemoryType, WorkflowRunId } from "@oscharko-dev/keiko-contracts/memory";

import { buildProposal } from "./_envelopes.js";
import { applyPolicy } from "./policy.js";
import { inferScopeFromContext } from "./scope-inference.js";
import { scanForSecrets } from "./secret-patterns.js";
import type {
  CaptureContext,
  CaptureOutcome,
  CapturePolicyOptions,
  WorkflowOutcomeInput,
} from "./types.js";

// Confidence for workflow-derived candidates. Lower than 1.0 because the system inferred the
// learning rather than the user stating it explicitly. The retrieval layer (#210) is expected
// to weight by provenance.confidence; a lower value means a workflow-derived memory ranks below
// an equivalent explicit-user-instruction memory.
const WORKFLOW_CONFIDENCE = 0.6;

// Scope inference for workflow extraction: prefer workflow scope, fall back to user.
function resolveWorkflowScope(
  context: CaptureContext,
  policy: CapturePolicyOptions,
): ReturnType<typeof inferScopeFromContext> {
  const hint =
    policy.scopeKind ?? (context.workflowDefinitionId !== undefined ? "workflow" : "user");
  return inferScopeFromContext(context, {
    scopeKind: hint,
    ...(policy.allowGlobalScope !== undefined && { allowGlobalScope: policy.allowGlobalScope }),
  });
}

function emitWorkflowCandidate(
  body: string,
  type: MemoryType,
  runId: WorkflowRunId,
  context: CaptureContext,
  policy: CapturePolicyOptions,
): CaptureOutcome {
  const reason = scanForSecrets(body, policy.customerIdentifierMatchers ?? []);
  if (reason !== null) {
    return { kind: "rejected", reason };
  }
  const scope = resolveWorkflowScope(context, policy);
  if (scope === null) {
    return { kind: "rejected", reason: "scope-not-resolvable" };
  }
  const decision = applyPolicy(body, {
    ...(policy.defaultSensitivity !== undefined && {
      defaultSensitivity: policy.defaultSensitivity,
    }),
  });
  const sourceKind = type === "correction" ? "accepted-correction" : "workflow-outcome";
  const proposal = buildProposal(
    {
      context,
      scope,
      body,
      type,
      sensitivity: decision.sensitivity,
      sourceKind,
      sourceWorkflowRunId: runId,
    },
    WORKFLOW_CONFIDENCE,
  );
  return { kind: "candidate", proposal, requiresApproval: decision.requiresApproval };
}

// Pure: no IO, no clock; the structured report and runId come from `outcome`, the clock and id
// factory come from `context`. `failed` outcomes return `[]` deliberately so a caller iterating
// many runs sees nothing rather than a placeholder.
export function extractWorkflowOutcomeCandidates(
  outcome: WorkflowOutcomeInput,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): readonly CaptureOutcome[] {
  if (outcome.outcomeKind === "failed") {
    return [];
  }
  const body = outcome.structuredReport.trim();
  if (body.length === 0) {
    return [{ kind: "rejected", reason: "empty-content" }];
  }
  const type: MemoryType = outcome.outcomeKind === "corrected" ? "correction" : "semantic-fact";
  return [emitWorkflowCandidate(body, type, outcome.runId, context, policy)];
}
