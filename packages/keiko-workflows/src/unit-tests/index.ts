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

// Convention-driven frontend test-style selection (Issue #1203). The detector reads local manifests /
// framework config; the selector maps a target to its test style; resolveTestStrategy composes both
// over a workflow target and ContextPack.
export {
  detectFrontendStack,
  detectFrontendStackFromDependencies,
  manifestDependencyNames,
  selectTestStrategy,
  EMPTY_FRONTEND_TEST_STACK,
  TEST_STYLES,
  type ComponentFramework,
  type FrontendStackSignals,
  type FrontendTestStack,
  type ManifestReaderFs,
  type StrategyInput,
  type TestStrategy,
  type TestStyle,
  type TestVerification,
} from "./frontend.js";

export { resolveTestStrategy, strategyAnchorPath } from "./strategy.js";

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
