// Public barrel for the unit-test generation workflow (ADR-0008 D1). Re-exports the single entry
// (generateUnitTests), the static UI descriptor, the Markdown renderer, the WorkflowEvent family,
// and all public types. Internal pipeline modules (internal, model-loop, verify-stage, stages,
// emit, parse, context, prompt) are NOT re-exported — they are implementation detail. Explicit
// named re-exports, `type` keyword for type-only, double quotes, `.js`.

export { generateUnitTests } from "./workflow.js";

export { assembleReport, renderMarkdownReport, type ReportParts } from "./report.js";

export {
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  type WorkflowDescriptor,
  type WorkflowInputSpec,
} from "./descriptor.js";

export { detectConventions, isTestPath } from "./conventions.js";

export {
  DEFAULT_WORKFLOW_LIMITS,
  type AddedTestFile,
  type FileNamingStyle,
  type TestConventions,
  type UnitTestTarget,
  type UnitTestWorkflowDeps,
  type UnitTestWorkflowInput,
  type UnitTestWorkflowReport,
  type WorkflowLimits,
  type WorkflowStatus,
} from "./types.js";

export type {
  ConventionsDetectedEvent,
  ContextSelectedEvent,
  ModelCallCompletedEvent,
  ModelCallStartedEvent,
  PatchAppliedEvent,
  PatchValidatedEvent,
  VerificationResultEvent,
  WorkflowCompletedEvent,
  WorkflowEvent,
  WorkflowEventSink,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
} from "./events.js";
