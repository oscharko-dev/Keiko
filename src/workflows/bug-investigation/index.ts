// Public barrel for the bug-investigation workflow (ADR-0009 D1). Re-exports the single entry
// (investigateBug), the static UI descriptor, the Markdown renderer, the BugInvestigationEvent
// family, and all public types. Internal pipeline modules (internal, model-loop, verify-stage,
// stages, emit, parse, context, prompt) are NOT re-exported — they are implementation detail. The
// shared WorkflowDescriptor/WorkflowInputSpec types are intentionally NOT re-exported here (the top
// workflows barrel exposes them exactly once from ./descriptor.js, ADR-0009 D12). Explicit named
// re-exports, `type` keyword for type-only, double quotes, `.js`.

export { investigateBug } from "./workflow.js";

export { assembleBugReport, renderBugMarkdownReport, type BugReportParts } from "./report.js";

export { BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR } from "./descriptor.js";

export { isSensitivePath, isElevatedReviewPath } from "./guard.js";

export { parseFailureEvidence, MAX_FRAMES } from "./failure-parse.js";

export {
  DEFAULT_BUG_WORKFLOW_LIMITS,
  type BugInvestigationInput,
  type BugInvestigationDeps,
  type BugInvestigationReport,
  type BugReportInput,
  type BugWorkflowLimits,
  type BugWorkflowStatus,
  type ChangedFile,
  type FailureEvidence,
  type FailureFrame,
  type Hypothesis,
  type ParsedBugOutput,
  type VerifiedFindings,
} from "./types.js";

export type {
  BugContextSelectedEvent,
  BugInvestigationCompletedEvent,
  BugInvestigationEvent,
  BugInvestigationFailedEvent,
  BugInvestigationStartedEvent,
  BugModelCallCompletedEvent,
  BugModelCallStartedEvent,
  BugPatchAppliedEvent,
  BugPatchValidatedEvent,
  BugVerificationResultEvent,
  BugWorkflowEventSink,
  FailureParsedEvent,
  RootCauseProposedEvent,
} from "./events.js";
