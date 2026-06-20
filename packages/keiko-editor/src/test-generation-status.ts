/**
 * Pure test-generation flow reducer (Issue #1202, ADR-0042 D7).
 *
 * Models the editor "Generate Tests" action as a small state machine so the host can render run status
 * and failure states deterministically, with stale-response discard, and keep the editor usable after a
 * generation fails or is cancelled. No Monaco, no I/O, no model. Every surfaced message is content-free
 * (a stable label or the server's content-free `reason`) — never a prompt, model output, or secret.
 */
import type {
  EditorTestGenerationAssurance,
  EditorTestGenerationFunnel,
  EditorTestGenerationOutcome,
  EditorTestGenerationResult,
} from "./types.js";

export type TestGenerationFlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting"; readonly requestId: string }
  | { readonly kind: "disabled"; readonly reason: string }
  | {
      readonly kind: "deferred";
      readonly reason: string;
      readonly funnel: EditorTestGenerationFunnel;
    }
  | {
      readonly kind: "preview";
      readonly result: EditorTestGenerationResult;
      readonly funnel: EditorTestGenerationFunnel;
      readonly assurance: EditorTestGenerationAssurance;
      // Present when the candidate is `unverified`: why it is not apply-ready (content-free).
      readonly reason?: string | undefined;
    }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "cancelled" };

export type TestGenerationFlowAction =
  | { readonly type: "request"; readonly requestId: string }
  | { readonly type: "resolve"; readonly outcome: EditorTestGenerationOutcome }
  | { readonly type: "error"; readonly reason: string }
  | { readonly type: "cancel" }
  | { readonly type: "dismiss" };

export const IDLE_TEST_GENERATION_STATE: TestGenerationFlowState = { kind: "idle" };

const GENERIC_FAILURE_REASON = "Test generation failed. The editor is still usable.";

// Projects a resolved outcome to its flow state. Total over the discriminated outcome union.
function outcomeToState(outcome: EditorTestGenerationOutcome): TestGenerationFlowState {
  if (outcome.status === "disabled") {
    return { kind: "disabled", reason: outcome.reason };
  }
  if (outcome.status === "deferred") {
    return { kind: "deferred", reason: outcome.reason, funnel: outcome.funnel };
  }
  if (outcome.status === "generated") {
    return {
      kind: "preview",
      result: outcome.result,
      funnel: outcome.funnel,
      assurance: outcome.assurance,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
  }
  return { kind: "failed", reason: outcome.reason };
}

// Whether a resolved outcome belongs to the in-flight request (stale-response discard): an outcome is
// applied only while requesting and only when its request id matches the pending one. `requestId` is
// globally unique per run (the host mints it via createEditorRequestId), so matching it alone is
// sufficient; streamId/sequence disambiguation is only needed once concurrent runs share a stream.
function isCurrent(state: TestGenerationFlowState, outcome: EditorTestGenerationOutcome): boolean {
  return state.kind === "requesting" && outcome.request.requestId === state.requestId;
}

/**
 * The pure flow reducer. `request` starts a run; `resolve` applies a matching outcome (stale outcomes
 * are ignored); `error` and `cancel` apply only to an in-flight run; `dismiss` clears any terminal
 * state back to idle. Unknown transitions return the current state unchanged.
 */
export function testGenerationReducer(
  state: TestGenerationFlowState,
  action: TestGenerationFlowAction,
): TestGenerationFlowState {
  switch (action.type) {
    case "request":
      return { kind: "requesting", requestId: action.requestId };
    case "resolve":
      return isCurrent(state, action.outcome) ? outcomeToState(action.outcome) : state;
    case "error":
      return state.kind === "requesting"
        ? {
            kind: "failed",
            reason: action.reason.length > 0 ? action.reason : GENERIC_FAILURE_REASON,
          }
        : state;
    case "cancel":
      return state.kind === "requesting" ? { kind: "cancelled" } : state;
    case "dismiss":
      return IDLE_TEST_GENERATION_STATE;
    default:
      return state;
  }
}

/** Whether a run is in flight (the action should be disabled while true). */
export function isTestGenerationBusy(state: TestGenerationFlowState): boolean {
  return state.kind === "requesting";
}

/** Whether a reviewable candidate is being previewed. */
export function isTestGenerationPreviewing(
  state: TestGenerationFlowState,
): state is Extract<TestGenerationFlowState, { kind: "preview" }> {
  return state.kind === "preview";
}

const STATIC_STATUS: Readonly<Record<TestGenerationFlowState["kind"], string>> = {
  idle: "",
  requesting: "Generating tests…",
  preview: "Review the generated tests before applying them.",
  cancelled: "Test generation was cancelled. The editor is still usable.",
  disabled: "",
  deferred: "",
  failed: "",
};

const ASSURED_PREVIEW_STATUS =
  "Generated tests passed the assured pre-filter (build, pass, stability, coverage, mutation); review before applying.";
const UNVERIFIED_PREVIEW_STATUS =
  "Generated tests are not apply-ready: they did not pass the assured pre-filter and are shown as untrusted evidence only.";

function describeOptionalCount(label: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${label} ${value.toString()}`;
}

function describeFunnel(funnel: EditorTestGenerationFunnel): string {
  const coverage = [
    describeOptionalCount("lines", funnel.coverageLineDelta),
    describeOptionalCount("branches", funnel.coverageBranchDelta),
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const mutation =
    funnel.mutantsKilled === undefined || funnel.mutantsTotal === undefined
      ? undefined
      : `mutation ${funnel.mutantsKilled.toString()}/${funnel.mutantsTotal.toString()} killed`;
  const evidence = [coverage.length > 0 ? `coverage delta ${coverage}` : undefined, mutation]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  return (
    `Funnel: ${funnel.candidatesGenerated.toString()} generated, ` +
    `${funnel.candidatesSurfaced.toString()} surfaced; build ${funnel.build}; pass ${funnel.pass}; ` +
    `stability ${funnel.stability} (${funnel.stabilityRunsRequired.toString()} runs); ` +
    `coverage ${funnel.coverage}; mutation ${funnel.mutation}` +
    (evidence.length > 0 ? `; ${evidence}.` : ".")
  );
}

/** A content-free, actionable status line for the current flow state. Empty string means "no status". */
export function describeTestGenerationStatus(state: TestGenerationFlowState): string {
  if (state.kind === "disabled" || state.kind === "deferred" || state.kind === "failed") {
    return state.reason;
  }
  if (state.kind === "preview") {
    const funnel = describeFunnel(state.funnel);
    if (state.assurance === "assured") {
      return `${ASSURED_PREVIEW_STATUS} ${funnel}`;
    }
    const reason =
      state.reason !== undefined && state.reason.length > 0
        ? state.reason
        : UNVERIFIED_PREVIEW_STATUS;
    return `${reason} ${funnel}`;
  }
  return STATIC_STATUS[state.kind];
}
