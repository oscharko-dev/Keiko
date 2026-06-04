// Re-export shim: the unit-test workflow event union and every member interface live in
// @oscharko-dev/keiko-contracts (issue #158). The contracts BARREL exposes only WorkflowEvent +
// WorkflowEventSink because several member names collide with HarnessEvent members by structural
// convention (ADR-0008 D4); the contracts subpath `unit-test-events` carries the full member set
// so internal consumers can keep importing concrete shapes from "./events.js" unchanged.

export type {
  WorkflowStartedEvent,
  ConventionsDetectedEvent,
  ContextSelectedEvent,
  ModelCallStartedEvent,
  ModelCallCompletedEvent,
  PatchValidatedEvent,
  PatchAppliedEvent,
  VerificationResultEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowEvent,
  WorkflowEventSink,
} from "@oscharko-dev/keiko-contracts/unit-test-events";
