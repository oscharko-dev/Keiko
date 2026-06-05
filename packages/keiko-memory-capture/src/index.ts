// Public surface of @oscharko-dev/keiko-memory-capture (Epic #204 child #207).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). The capture layer is the PRIMARY secret-rejection
// boundary: storage (#206) and audit (#214) treat the body as already-policy-gated.

export { KEIKO_MEMORY_CAPTURE_VERSION } from "./version.js";
export { CaptureRejection, type RejectionReason } from "./errors.js";
export type {
  CaptureContext,
  CaptureMemoryResolver,
  CaptureOutcome,
  CapturePolicyOptions,
  WorkflowOutcomeInput,
} from "./types.js";
export { extractCandidatesFromUserText, extractCandidatesFromWorkflowOutcome } from "./capture.js";
// Individual extractors are NOT re-exported: callers must go through the top-level capture
// surface so the pre-flight (empty / length / restricted-default) and priority order are
// enforced uniformly. The internal modules (intent-explicit, intent-workflow, policy,
// secret-patterns, scope-inference, _envelopes, _constants) stay package-private per
// ADR-0019 trust rule 7.
