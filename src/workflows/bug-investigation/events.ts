// Re-export shim: the bug-investigation workflow event union and every member interface live in
// @oscharko-dev/keiko-contracts (issue #158). Member names are DISTINCT from the unit-test
// workflow's (ADR-0009 D5) so the package-root barrel surfaces every member name as well as the
// union; this shim mirrors that surface so existing internal consumers continue importing from
// "./events.js" unchanged.

export type {
  BugInvestigationStartedEvent,
  FailureParsedEvent,
  BugContextSelectedEvent,
  BugModelCallStartedEvent,
  BugModelCallCompletedEvent,
  RootCauseProposedEvent,
  BugPatchValidatedEvent,
  BugPatchAppliedEvent,
  BugVerificationResultEvent,
  BugInvestigationCompletedEvent,
  BugInvestigationFailedEvent,
  BugInvestigationEvent,
  BugWorkflowEventSink,
} from "@oscharko-dev/keiko-contracts/bug-investigation-events";
