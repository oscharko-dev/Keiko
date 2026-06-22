// Memory integration for the bug-investigation workflow (Issue #213 / Epic #204).
// Composes the optional MemoryWorkflowPort to fetch a scoped, prompt-ready memory context
// before model invocation and to emit a one-line write-candidate after a terminal success.
// READ-ONLY by design: memory cannot bypass the existing apply gates (#6 applyEnabled),
// scope guard (D6 bound 2), or patch limits (D6 bound 1) — those remain the sole write
// surface (epic §Architecture Invariants 1+2). Defence-in-depth: callers prepend the
// returned text to the user message via prompt.ts which already redacts + byte-caps every
// free-text field through safePromptText.
//
// Scope strategy: bug-investigation runs inside one repository, so workflow memory is
// bounded to the current project path. This prevents lessons from one regulated repository
// from being recalled in another while still letting the memory proposal provenance carry
// `workflow-outcome` / `sourceWorkflowRunId` through the capture pipeline.

import type {
  MemoryScope,
  MemoryWorkflowContext,
  MemoryWorkflowPort,
  MemoryWriteCandidateEvent,
} from "@oscharko-dev/keiko-contracts";
import type { ProjectId } from "@oscharko-dev/keiko-contracts/memory";
import type {
  BugInvestigationReport,
  BugReportInput,
  BugWorkflowStatus,
  Hypothesis,
} from "./types.js";

// Default token budget passed to the port. The port may ignore it; the workflow does not
// enforce it (the prompt boundary clamp in safePromptText is the authoritative byte cap).
const DEFAULT_MEMORY_TOKEN_BUDGET = 2_048;

// The subset of statuses that should trigger a memory write-candidate. Aligned with the
// epic's "workflow-success" source kind. Cancelled / failed / rejected do NOT emit.
const SUCCESS_STATUSES: ReadonlySet<BugWorkflowStatus> = new Set<BugWorkflowStatus>([
  "fix-applied",
  "fix-proposed",
  "investigation-only",
]);

// Build the lexical query passed to the memory retriever. Prefers the bug description; falls
// back to a generic label so the port always has a non-empty query to score against.
function memoryQueryText(report: BugReportInput): string {
  const desc = report.description?.trim();
  return desc !== undefined && desc.length > 0 ? desc : "bug investigation";
}

function bugInvestigationMemoryScope(workspaceRoot: string): MemoryScope {
  return {
    kind: "project",
    projectId: workspaceRoot as ProjectId,
  };
}

// Fetches the assembled memory context. Returns undefined when no port was injected OR when
// the port returned an empty block — both cases are treated identically by the prompt
// builder so retrieval failures degrade gracefully (text === "" is indistinguishable from
// "no port").
export async function acquireMemoryContext(
  port: MemoryWorkflowPort | undefined,
  report: BugReportInput,
  workspaceRoot: string,
): Promise<MemoryWorkflowContext | undefined> {
  if (port === undefined) {
    return undefined;
  }
  const scope = bugInvestigationMemoryScope(workspaceRoot);
  try {
    const context = await port.getContextForWorkflow(
      [scope],
      memoryQueryText(report),
      DEFAULT_MEMORY_TOKEN_BUDGET,
    );
    if (context.text.length === 0 || context.includedMemoryIds.length === 0) {
      return undefined;
    }
    port.onMemoryUsed?.({
      memoryIds: context.includedMemoryIds,
      scopes: [scope],
      reason: "bug-investigation:pre-prompt",
    });
    return context;
  } catch {
    return undefined;
  }
}

// Compose the one-line proposal summary. PURE: no IO, no clock, no randomness.
function buildProposalSummary(status: BugWorkflowStatus, hypothesis: Hypothesis): string {
  const root = hypothesis.rootCause?.trim();
  if (root !== undefined && root.length > 0) {
    return `[${status}] ${root}`;
  }
  return `[${status}] bug investigation completed without a recorded root cause`;
}

// Emits a write-candidate when the run reached a terminal success state. Caller decides
// whether to convert the candidate into a #207 capture proposal. NO-OP when the port is
// absent OR when the run was cancelled / failed / rejected (the latter mirrors the spec's
// "do NOT emit write-candidate on failure" rule).
export function emitMemoryWriteCandidate(
  port: MemoryWorkflowPort | undefined,
  report: BugInvestigationReport,
  workspaceRoot: string,
): void {
  if (port?.onMemoryWriteCandidate === undefined) {
    return;
  }
  if (!SUCCESS_STATUSES.has(report.status)) {
    return;
  }
  const event: MemoryWriteCandidateEvent = {
    proposalSummary: buildProposalSummary(report.status, report.hypothesis),
    scope: bugInvestigationMemoryScope(workspaceRoot),
    source: "workflow-success",
  };
  try {
    port.onMemoryWriteCandidate(event);
  } catch {
    // defensive: callback exceptions must not propagate into runPipeline
  }
}
