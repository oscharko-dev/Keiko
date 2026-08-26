/**
 * The one seam every Monaco language-intelligence bridge settles through.
 *
 * Monaco's provider contract expects a *value* — an empty list, `undefined`, no markers — never a
 * throw. Every bridge therefore ends in a `catch` that returns that empty value, which made a
 * language-provider crash, a request timeout, a transport failure and a genuinely empty result
 * indistinguishable to the user: all four rendered as "nothing found". A capped result was equally
 * silent, because the server's `truncated` flag was dropped before it reached the editor.
 *
 * This module keeps Monaco's contract intact and makes the difference observable. A bridge hands
 * {@link runLanguageBridgeCall} its resolver call plus the Monaco values to use for a discarded and a
 * failed call; the seam classifies what actually happened into one
 * {@link EditorLanguageIntelligenceEvent} — `ok`, `empty`, `capped`, `cancelled` or `failed` — reports
 * it to the host-injected reporter, and returns the value Monaco expects. Failure surfacing therefore
 * lives in ONE place for every surface rather than in fourteen `catch` blocks.
 *
 * Events are content-free by construction (ADR-0042 D4 evidence redaction): an event carries the
 * operation and a failure *class*, never an error message, a buffer excerpt, a path or an endpoint.
 * The class is what an operator needs to act — a timeout, a transport break and a provider crash have
 * different fixes — and it cannot leak the document.
 *
 * `cancelled` is deliberately its own status and NOT a failure: Monaco cancels a superseded hover or
 * completion on virtually every keystroke, so treating an abort as a failure would paint a permanent
 * error. {@link reduceLanguageIntelligence} ignores it entirely.
 */

/** Every Monaco language-intelligence surface the editor bridges to a host resolver. */
export type EditorLanguageOperation =
  | "completion"
  | "inline-completion"
  | "hover"
  | "symbols"
  | "formatting"
  | "definition"
  | "type-definition"
  | "implementation"
  | "references"
  | "code-actions"
  | "signature-help"
  | "inlay-hints"
  | "call-hierarchy"
  | "diagnostics";

/**
 * Canonical operation order. Presentation picks the first affected operation from this list so the
 * status text is deterministic regardless of which surface the user happened to trigger first.
 */
export const EDITOR_LANGUAGE_OPERATIONS: readonly EditorLanguageOperation[] = [
  "diagnostics",
  "completion",
  "inline-completion",
  "hover",
  "signature-help",
  "definition",
  "type-definition",
  "implementation",
  "references",
  "call-hierarchy",
  "symbols",
  "code-actions",
  "formatting",
  "inlay-hints",
];

/**
 * Why a bridge call produced no usable result. A class, never a message:
 *  - `timeout` — the request exceeded its deadline (the server language service is bounded).
 *  - `transport` — the call never reached a responder (loopback BFF down, fetch rejected).
 *  - `provider` — a responder answered with a failure (language-service crash, invalid payload).
 */
export type EditorLanguageFailureKind = "timeout" | "transport" | "provider";

/** What a settled bridge call produced. `capped` is a partial result honouring a server cap. */
export type EditorLanguageResultKind = "ok" | "empty" | "capped";

/** The classified outcome of exactly one bridge call. */
export type EditorLanguageOutcome =
  | { readonly status: EditorLanguageResultKind }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly failure: EditorLanguageFailureKind };

/** One content-free observation: which surface settled, and how. */
export interface EditorLanguageIntelligenceEvent {
  readonly operation: EditorLanguageOperation;
  readonly outcome: EditorLanguageOutcome;
}

/**
 * The host-injected sink for bridge outcomes. Absent when the host surfaces no language-intelligence
 * state, in which case the seam still returns Monaco's expected value — behaviour is unchanged, only
 * unobserved.
 */
export type EditorLanguageIntelligenceReporter = (event: EditorLanguageIntelligenceEvent) => void;

// ─── Failure classification ─────────────────────────────────────────────────────────────────────

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : "";
}

const TIMEOUT_NAMES: ReadonlySet<string> = new Set(["TimeoutError", "DeadlineExceededError"]);
const TIMEOUT_MARKERS: readonly string[] = ["timeout", "timed out", "deadline"];
const TRANSPORT_MARKERS: readonly string[] = [
  "failed to fetch",
  "load failed",
  "network",
  "econnrefused",
  "socket hang up",
];

/** True when the rejection is Monaco/host cancellation rather than a fault. */
export function isCancellation(error: unknown): boolean {
  const name = errorName(error);
  if (name === "AbortError" || name === "CanceledError" || name === "CancellationError") {
    return true;
  }
  return errorMessage(error).includes("aborted");
}

function matchesAny(message: string, markers: readonly string[]): boolean {
  return markers.some((marker) => message.includes(marker));
}

/**
 * Classify a bridge rejection into a failure class. Only the error's `name` and `message` shape are
 * inspected; neither is retained on the emitted event, so no message ever reaches the UI or a log.
 */
export function classifyLanguageFailure(error: unknown): EditorLanguageFailureKind {
  const name = errorName(error);
  const message = errorMessage(error);
  if (TIMEOUT_NAMES.has(name) || matchesAny(message, TIMEOUT_MARKERS)) {
    return "timeout";
  }
  if (error instanceof TypeError || matchesAny(message, TRANSPORT_MARKERS)) {
    return "transport";
  }
  return "provider";
}

/** Map a rejection to its outcome: cancellation is not a failure, everything else is classified. */
export function outcomeForError(error: unknown): EditorLanguageOutcome {
  if (isCancellation(error)) {
    return { status: "cancelled" };
  }
  return { status: "failed", failure: classifyLanguageFailure(error) };
}

/**
 * Classify a settled result by how much of it arrived. `truncated` comes from the server's result cap
 * and outranks emptiness: a cap that dropped every item is still a cap, not an empty document.
 */
export function classifyResultKind(
  itemCount: number,
  truncated?: boolean,
): EditorLanguageResultKind {
  if (truncated === true) {
    return "capped";
  }
  return itemCount === 0 ? "empty" : "ok";
}

// ─── The shared call seam ───────────────────────────────────────────────────────────────────────

/**
 * One bridge call, described so the seam can settle it. `TResponse` is the host resolver's response
 * and `TValue` the Monaco value the provider must return.
 */
export interface LanguageBridgeCall<TResponse, TValue> {
  readonly operation: EditorLanguageOperation;
  /** Invokes the host resolver. Rejections are classified here, never propagated to Monaco. */
  readonly resolve: () => Promise<TResponse>;
  /**
   * True when a later request superseded this response, or the document moved on. A discarded
   * response is neither presented nor reported: it describes a buffer state that no longer exists.
   */
  readonly isDiscarded?: ((response: TResponse) => boolean) | undefined;
  /** The Monaco value for a discarded response. */
  readonly discardedValue: TValue;
  /** The Monaco value for a failed call — Monaco's contract expects a value, never a throw. */
  readonly failedValue: TValue;
  /** How much of the result arrived (`ok` / `empty` / `capped`). */
  readonly classify: (response: TResponse) => EditorLanguageResultKind;
  /** Maps a kept response onto the Monaco value. */
  readonly present: (response: TResponse) => TValue;
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
}

/**
 * Settle one bridge call: await the resolver, drop a superseded response, report the classified
 * outcome exactly once, and hand Monaco the value its provider contract requires. A failure returns
 * the same empty value as before — the difference is that it is now *reported* as a failure instead
 * of being indistinguishable from an empty result.
 */
export async function runLanguageBridgeCall<TResponse, TValue>(
  call: LanguageBridgeCall<TResponse, TValue>,
): Promise<TValue> {
  try {
    const response = await call.resolve();
    if (call.isDiscarded?.(response) === true) {
      return call.discardedValue;
    }
    call.report?.({ operation: call.operation, outcome: { status: call.classify(response) } });
    return call.present(response);
  } catch (error) {
    call.report?.({ operation: call.operation, outcome: outcomeForError(error) });
    return call.failedValue;
  }
}

// ─── Host-facing state ─────────────────────────────────────────────────────────────────────────

/** The last non-cancelled outcome status per operation. */
export type EditorLanguageStatusByOperation = Readonly<
  Partial<Record<EditorLanguageOperation, "ok" | "empty" | "capped" | "failed">>
>;

export interface EditorLanguageIntelligenceState {
  readonly statuses: EditorLanguageStatusByOperation;
}

/** The initial state: nothing observed yet, so nothing to surface. */
export const EMPTY_LANGUAGE_INTELLIGENCE_STATE: EditorLanguageIntelligenceState = { statuses: {} };

/**
 * Fold one event into the state. Cancellation and a status that did not change return the SAME state
 * object, so a host holding this in React state re-renders only on a real transition (Monaco cancels
 * a superseded request on nearly every keystroke).
 */
export function reduceLanguageIntelligence(
  state: EditorLanguageIntelligenceState,
  event: EditorLanguageIntelligenceEvent,
): EditorLanguageIntelligenceState {
  const status = event.outcome.status;
  if (status === "cancelled" || state.statuses[event.operation] === status) {
    return state;
  }
  return { statuses: { ...state.statuses, [event.operation]: status } };
}

/**
 * What the editor surface must tell the user: which operations are failing and which returned a
 * capped result, in {@link EDITOR_LANGUAGE_OPERATIONS} order so wording is deterministic.
 */
export interface EditorLanguageIntelligenceSummary {
  readonly failed: readonly EditorLanguageOperation[];
  readonly capped: readonly EditorLanguageOperation[];
}

export function summarizeLanguageIntelligence(
  state: EditorLanguageIntelligenceState,
): EditorLanguageIntelligenceSummary {
  const failed: EditorLanguageOperation[] = [];
  const capped: EditorLanguageOperation[] = [];
  for (const operation of EDITOR_LANGUAGE_OPERATIONS) {
    const status = state.statuses[operation];
    if (status === "failed") {
      failed.push(operation);
    } else if (status === "capped") {
      capped.push(operation);
    }
  }
  return { failed, capped };
}

/**
 * The single state the editor surface presents, or `null` when every observed operation answered
 * honestly. A failure outranks a cap: a broken provider is the more urgent thing to say, and the cap
 * it may also have reported is a consequence of the same outage.
 *
 * `operation` names the leading affected surface and `operationCount` how many share the state, so the
 * host can render one honest sentence ("Hover unavailable", "Hover and 2 more unavailable") without
 * the editor package owning any wording.
 */
export interface EditorLanguageIntelligenceNotice {
  readonly status: "failed" | "capped";
  readonly operation: EditorLanguageOperation;
  readonly operationCount: number;
}

export function languageIntelligenceNotice(
  summary: EditorLanguageIntelligenceSummary,
): EditorLanguageIntelligenceNotice | null {
  const failed = summary.failed[0];
  if (failed !== undefined) {
    return { status: "failed", operation: failed, operationCount: summary.failed.length };
  }
  const capped = summary.capped[0];
  if (capped !== undefined) {
    return { status: "capped", operation: capped, operationCount: summary.capped.length };
  }
  return null;
}

// ─── Bridge helpers shared across every host-resolver bridge (KEIKO-0908 / KEIKO-0912) ─────────

/** Minimal structural shape of the disposable object every bridge already holds. */
export interface LanguageBridgeDisposer {
  dispose(): void;
}

/**
 * Minimal structural shape of the Monaco cancellation token every bridge already receives. Kept
 * local (rather than importing `MonacoCancellationToken` from `completion-bridge.ts`) so this
 * lower-level module never cycles back into the bridges that depend on it.
 */
export interface LanguageBridgeCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): LanguageBridgeDisposer;
}

/** Compose several disposables into a single one; each is disposed in registration order. */
export function composeDisposers(
  disposers: readonly LanguageBridgeDisposer[],
): LanguageBridgeDisposer {
  return {
    dispose(): void {
      for (const disposer of disposers) {
        disposer.dispose();
      }
    },
  };
}

/** {@link controllerForToken}'s result: the wired controller plus the subscription's disposer. */
export interface LanguageBridgeAbortWiring {
  readonly controller: AbortController;
  readonly dispose: () => void;
}

/**
 * Wire an AbortController to a Monaco cancellation token: abort immediately if the token has
 * already fired, and abort on the token's cancellation event otherwise. The returned controller's
 * signal is what a host resolver receives so it can stop early.
 *
 * `onCancellationRequested` returns an `IDisposable` for the listener it registers. #2906 round-3
 * review: a caller that drops that disposer leaks the listener closure (and, transitively, this
 * controller) for the lifetime of the token source -- every successful, never-cancelled provider
 * call would otherwise accumulate one live subscription until Monaco eventually destroys the token
 * source. The disposer is returned alongside the controller so every caller can release it once the
 * call settles, exactly like completion-bridge.ts's own inline wiring already does.
 */
export function controllerForToken(
  token: LanguageBridgeCancellationToken,
): LanguageBridgeAbortWiring {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  return {
    controller,
    dispose: (): void => {
      subscription.dispose();
    },
  };
}
