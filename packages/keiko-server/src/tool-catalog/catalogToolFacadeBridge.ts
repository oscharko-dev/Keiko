import { randomUUID } from "node:crypto";
import {
  compileToolProjection,
  createToolRef,
  lookupCatalogTool,
  type ToolCatalog,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogVersionRef,
  CompiledToolProjection,
  ToolDescriptor,
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { captureToolInvocationReceipt } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { errorKindOf } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import type { ToolBudgetDisposition } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { emitToolLifecycleEvent, type CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";
import { CatalogDispatchFault, catalogBudgetOperation } from "./catalogToolRuntimeAuthority.js";

/**
 * Confidently-matched facade actions this bridge routes through the real catalog LIFECYCLE
 * emission (catalogToolLifecycle.ts's `emitToolLifecycleEvent`, the same op vocabulary and receipt
 * shape #3413's own settlement uses) and the shared fault-shaping primitives
 * (catalogToolRuntimeAuthority.ts's `CatalogDispatchFault`/`catalogBudgetOperation`) (#3413, F8).
 * It does NOT route through `createCatalogToolBinder`/`CatalogInvocation`
 * (catalogToolDispatch.ts/catalogToolSettlement.ts): that pair is shaped for a prior `offer()`
 * negotiating a catalog-schema `{toolRef, projectionDigest, offerId, arguments}` invocation, which
 * `codingToolFacade.ts`'s already-parsed `CodingToolActionRequest` never carries (ADR-0175 D6
 * "Production mounting" explains the shape mismatch in full).
 *
 * DECISION (#3413 F8 review, finding b1-1 -- superseding the prior "tracked as outOfScopeNeeds"
 * note): this bridge, not the offer/dispatch/cursor binder pair, is and remains the one production
 * dispatch owner. AGENTS.md section 5 forbids growing a second parallel dispatch path, and ADR-0175
 * D6 already documents the binder's shape as incompatible with an already-parsed
 * `CodingToolActionRequest` -- reshaping one to fit the other would be the wrong kind of "fix" for
 * either side. `catalogToolBinder.ts`/`catalogToolDispatch.ts`/`catalogToolSettlement.ts`/
 * `catalogToolCursor.ts`/`catalogToolContinuation.ts`/`nativeCatalogToolPort.ts` are kept, not
 * deleted: they remain a real, independently-tested reference implementation of the full
 * offer/dispatch contract (ADR-0175 D4-D6) that this bridge's own bookkeeping below deliberately
 * mirrors in miniature, and their tests continue to pin that contract in isolation. But they have
 * no production caller and this bridge does not acquire one by wiring them in. Acceptance criteria
 * that need real production behaviour are instead closed HERE, in the bridge's own construction and
 * dispatch path:
 *   - readiness rejection for a canonical id this bridge maps to but the composed catalog does not
 *     contain: `resolveAction` distinguishes "structurally uncovered" (`catalogIdFor` returns
 *     `undefined` by design) from "missing" (a canonical id was produced but `lookupCatalogTool`
 *     found no descriptor for it) and fails closed on the latter via `dispatchMissing`, emitting
 *     the real `tool-catalog.bind-unavailable` op instead of silently running the action unbound.
 *     "Duplicate handler" detection is deliberately NOT implemented at this level: `gitCatalogId`/
 *     `deliveryCatalogId` intentionally resolve several actions (stage-execute, every non-merge
 *     delivery execute intent) onto the SAME shared `keiko.git.execute` descriptor, so flagging a
 *     shared descriptor as an error would reject correct, documented behaviour. "Orphaned handler"
 *     (a descriptor whose handler requirement nothing satisfies) has no meaning at this layer
 *     either: this bridge never owns a handler set -- the handler is always the caller-supplied
 *     `run` thunk passed into `dispatch()` per call, not a binder-composed registration.
 *   - dispatch-time projection revalidation (AC3): `CatalogFacadeBridgeInput.catalog` accepts
 *     either a static `ToolCatalog` or a `() => ToolCatalog` provider. A static value cannot drift
 *     after construction (it is the same frozen object for the bridge's whole lifetime, and today's
 *     one production caller, `codingToolAuthorityPort.ts`'s `catalogFacadeBridgeFor`, passes exactly
 *     that -- a snapshot built once via `createOpenCodeGatewayToolCatalogAdvertisement`), so
 *     `projectionDrift` is a guaranteed no-op for it. A provider function lets a future composition
 *     supply a genuinely live catalog source; `dispatchCovered` then re-derives the projection
 *     identity before every dispatch and settles `invalid`/`projection-mismatch` (fail closed,
 *     before the handler ever runs) the moment the live projection digest no longer matches the one
 *     captured at construction. Wiring an actual live catalog source into `catalogFacadeBridgeFor`
 *     remains open follow-up work outside this file's write scope (tracked as outOfScopeNeeds).
 *   - authoritative deadline / timeout and late-completion quarantine (AC6, AC8 partial):
 *     `runReservedWithDeadline` races the wrapped handler against `descriptor.bounds.maxDurationMs`
 *     and settles `timeout`/`deadline-exceeded` (never `cancelled`) when the deadline wins. The
 *     handler is never abandoned unobserved: a resolution or rejection that arrives after the
 *     deadline has already settled the invocation is discarded via a real
 *     `tool-catalog.completion-discarded` line instead of an unhandled rejection or a second
 *     settlement.
 *
 * Still genuinely open, and NOT closed by this bridge (outOfScopeNeeds, precise patches reported
 * against the owning files in the #3413 F8 review rather than guessed here):
 *   - `busy` and cross-process-restart dedup (AC8) need the same idempotency-registry discipline
 *     `codingToolFacade.ts`'s `executeStagedEdit` already applies to `edit` via
 *     `CodingToolInvocationRegistry`, extended to every catalog-bridged action family -- a
 *     composition change in `codingToolFacade.ts`/`codingToolAuthorityPort.ts`, not this file.
 *   - opaque cursors (AC7) need a `CodingToolInvocationRegistry` threaded into this bridge's
 *     construction from the composition layer, plus a page/cursor-shaped return contract on the
 *     `search`/`discover` domain handlers -- both outside this file's write scope.
 *   - a result schema/size bound before `completed` (`result-contract-failed`, part of AC6) is
 *     deliberately NOT added here: `run()`'s resolved value is `unknown` in production
 *     (`codingToolFacade.ts`'s `runDelegate` returns `Promise<unknown>`, not a catalog-JSON
 *     envelope), and the real shape of every one of the ~9 covered action families' results was not
 *     individually verified in this review's time budget. A blanket `captureCatalogJson`-style
 *     bound risks turning legitimate production results into spurious `result-contract-failed`
 *     rejections; that verification belongs with whoever owns each domain handler's result
 *     contract, not a guess made here.
 * This bridge reimplements its own compact reserve/settle/account bookkeeping below
 * (`dispatchCovered`/`runReserved`/`settleSuccess`/`settleFailure`), sharing only the fault
 * vocabulary and accounting discipline with `CatalogInvocation`, never its offer/dispatch/cursor
 * state machine.
 *
 * Every canonical id below is an unambiguous mapping from the IPC action shape (as
 * `opencodeRuntimeAdapter.ts`'s `wireRequestFor`/`parseDraftToolRequest` actually produce it for a
 * model tool call) to a real production catalog canonical tool id (OPENCODE_GATEWAY_CATALOG,
 * opencodeToolSchemas.ts / opencode.ts). A request shape absent from `catalogIdFor` is uncovered:
 * `dispatch` below runs the existing handler unchanged and records one body-free
 * `tool-catalog.dispatch-unbound` line instead of a lifecycle pair -- never zero evidence.
 *
 * `read` is the one action with a real 1:1 catalog tool (`keiko.workspace.read`) that is
 * deliberately left OUT of `catalogIdFor`: the catalog's model-facing schema requires `startLine`
 * and `maxLines` (opencode.ts's `readSpec`, mirrored by the real wire schema in
 * opencodeToolSchemas.ts, which already requires both today) while `CodingToolActionRequest`'s
 * `read` variant keeps them optional for internal callers this bridge's write scope may not touch
 * (codingToolIpc.ts's `readRequest` parser, opencodeRuntimeAdapter.ts, both outside/forbidden for
 * this change). Binding it without knowing every internal caller's expectation would risk silently
 * changing read-window bounds; left uncovered and reported rather than guessed.
 *
 * `command` and `connector` have no catalog descriptor at all yet (no `opencode.ts` spec models
 * them), so both stay structurally uncovered here, not merely unmapped.
 */
function gitCatalogId(
  request: Extract<CodingToolActionRequest, { readonly action: "git" }>,
): string | undefined {
  switch (request.operation) {
    case "status":
      return "keiko.git.status";
    case "diff":
      return "keiko.git.diff";
    case "ci":
      return "keiko.ci.status";
    case "stage":
      // RuntimeGitRequest's stage variant is exhaustively "propose" | "execute" -- no third phase.
      return request.phase === "propose" ? "keiko.git.stage" : "keiko.git.execute";
    default:
      // "read" | "write": the lower-level git port, never produced by a model tool call today.
      return undefined;
  }
}

// `keiko.git.execute` redeems ANY approved stage/commit/push/pull-request proposal (one shared
// tool, opencode.ts's `gitExecuteSpec`) -- `intent` only distinguishes which proposal kind at the
// `delivery` layer, so every execute-phase intent except "merge" (which no tool models) resolves to
// the same canonical id.
function deliveryCatalogId(
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): string | undefined {
  if (request.phase === "execute")
    return request.intent === "merge" ? undefined : "keiko.git.execute";
  if (request.phase !== "propose") return undefined; // "reconcile" or no phase: not model-facing
  switch (request.intent) {
    case "commit":
      return "keiko.git.commit";
    case "push":
      return "keiko.git.push";
    case "pull-request":
      return "keiko.git.pullrequest";
    default:
      return undefined; // "merge": no proposal tool models it
  }
}

const SIMPLE_CATALOG_TOOL_IDS: Partial<Record<CodingToolActionRequest["action"], string>> =
  Object.freeze({
    discover: "keiko.workspace.discover",
    search: "keiko.repo.search",
    edit: "keiko.changeset.edit",
    verification: "keiko.verification.run",
    egress: "keiko.research.fetch",
    skill: "keiko.skill.invoke",
    "child-agent": "keiko.child.run",
  });

function catalogIdFor(request: CodingToolActionRequest): string | undefined {
  if (request.action === "git") return gitCatalogId(request);
  if (request.action === "delivery") return deliveryCatalogId(request);
  return SIMPLE_CATALOG_TOOL_IDS[request.action];
}

export interface CatalogFacadeBudgetReservation {
  readonly reservationId: string;
}
export interface CatalogFacadeBudgetPort {
  readonly available: () => boolean;
  readonly reserve: () => CatalogFacadeBudgetReservation;
  readonly commit: (reservation: CatalogFacadeBudgetReservation) => void;
  readonly release: (reservation: CatalogFacadeBudgetReservation) => void;
}

/**
 * Always-available in-memory reservation bookkeeping: real reservation ids and real commit/
 * release accounting, no enforced ceiling. #3413 explicitly scopes run-level counters to its own
 * owner ("Do not create harness run/model/tool/command/wall-time counters or a second run
 * terminal"); binding this port to a real enforced ceiling is tracked as follow-up work rather
 * than invented here.
 */
export function createInMemoryCatalogFacadeBudgetPort(
  mintId: () => string = randomUUID,
): CatalogFacadeBudgetPort {
  return Object.freeze({
    available: (): boolean => true,
    reserve: (): CatalogFacadeBudgetReservation => Object.freeze({ reservationId: mintId() }),
    commit: (): void => undefined,
    release: (): void => undefined,
  });
}

export interface CatalogFacadeBridgeContext {
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
}
export interface CatalogFacadeBridgeInput {
  /**
   * A static catalog cannot drift after construction, so passing one keeps `dispatchCovered`'s
   * projection revalidation (AC3) a guaranteed no-op -- today's one production caller passes a
   * static snapshot. A `() => ToolCatalog` provider lets a future composition supply a genuinely
   * live source and get real per-dispatch drift detection; see the file header for the full
   * decision record.
   */
  readonly catalog: ToolCatalog | (() => ToolCatalog);
  readonly profile: CatalogVersionRef;
  readonly budget: CatalogFacadeBudgetPort;
  readonly logPort: CatalogLifecycleLogPort;
  readonly context: () => CatalogFacadeBridgeContext;
  readonly mintId?: () => string;
  readonly now?: () => number;
}
export interface CatalogFacadeBridge {
  readonly resolve: (request: CodingToolActionRequest) => ToolDescriptor | undefined;
  /** Resolves a catalog binding for `request` and settles around `run`; uncovered actions just run. */
  readonly dispatch: <T>(request: CodingToolActionRequest, run: () => Promise<T>) => Promise<T>;
}

interface BridgeRuntime {
  readonly input: CatalogFacadeBridgeInput;
  readonly projection: CompiledToolProjection;
  readonly mintId: () => string;
  readonly now: () => number;
}
interface InvocationMeta {
  readonly descriptor: ToolDescriptor;
  readonly invocationId: string;
  readonly settlementId: string;
  readonly startedAt: number;
}
interface TerminalFields extends InvocationMeta {
  readonly status: ToolResultStatus;
  readonly reason: ToolResultReason;
  readonly reservationId: string | null;
  readonly effectStarted: boolean;
  readonly budgetDisposition: ToolBudgetDisposition;
  readonly error?: unknown;
}

function currentCatalog(input: CatalogFacadeBridgeInput): ToolCatalog {
  return typeof input.catalog === "function" ? input.catalog() : input.catalog;
}

type ResolutionOutcome =
  | { readonly kind: "uncovered" }
  | { readonly kind: "resolved"; readonly descriptor: ToolDescriptor }
  | { readonly kind: "missing"; readonly canonicalId: string };

/** `catalogIdFor` returning `undefined` is a designed exclusion (see the coverage tables above);
 * `catalogIdFor` returning an id `lookupCatalogTool` cannot find is a real readiness gap -- the
 * composed catalog dropped a canonical id this bridge maps to -- and must never be treated the
 * same way (#3413 F8 review, finding b1-1). */
function resolveAction(catalog: ToolCatalog, request: CodingToolActionRequest): ResolutionOutcome {
  const canonicalId = catalogIdFor(request);
  if (canonicalId === undefined) return { kind: "uncovered" };
  const descriptor = lookupCatalogTool(catalog, createToolRef(canonicalId, 1));
  return descriptor === undefined
    ? { kind: "missing", canonicalId }
    : { kind: "resolved", descriptor };
}

function resolveDescriptor(
  catalog: ToolCatalog,
  request: CodingToolActionRequest,
): ToolDescriptor | undefined {
  const outcome = resolveAction(catalog, request);
  return outcome.kind === "resolved" ? outcome.descriptor : undefined;
}

function correlationIdFor(runtime: BridgeRuntime): string {
  const ctx = runtime.input.context();
  return typeof ctx.correlationId === "string" && isValidCorrelationId(ctx.correlationId)
    ? ctx.correlationId
    : UNKNOWN_CORRELATION_ID;
}

function identityFields(runtime: BridgeRuntime): {
  readonly correlationId: string;
  readonly catalogRevision: CompiledToolProjection["catalogRevision"];
  readonly profile: CompiledToolProjection["profile"];
  readonly projectionDigest: CompiledToolProjection["projectionDigest"];
  readonly parentCorrelationId?: string;
} {
  const ctx = runtime.input.context();
  return {
    correlationId: correlationIdFor(runtime),
    catalogRevision: runtime.projection.catalogRevision,
    profile: runtime.projection.profile,
    projectionDigest: runtime.projection.projectionDigest,
    ...(ctx.parentCorrelationId === undefined
      ? {}
      : { parentCorrelationId: ctx.parentCorrelationId }),
  };
}

/**
 * A request the catalog does not (yet) cover keeps its exact prior dispatch behaviour, but must
 * never run with zero evidence: a single body-free line records which action ran unbound, so an
 * operator reading the activity log can distinguish "not catalog-covered" from "the catalog silently
 * dropped this call" (#3413 F8 review). `action` alone is logged -- one of twelve closed literal
 * values (`CodingToolAction`), never request content.
 */
function emitUnbound(runtime: BridgeRuntime, request: CodingToolActionRequest): void {
  const correlationId = correlationIdFor(runtime);
  try {
    runtime.input.logPort.primary.write({
      category: "security",
      op: "tool-catalog.dispatch-unbound",
      correlationId,
      extra: { action: request.action },
    });
  } catch (error) {
    emitServerDiagnostic(
      runtime.input.logPort.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "tool-catalog.lifecycle-sink-failed",
        source: "tool-catalog-dispatch-unbound",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}

/**
 * A canonical id `catalogIdFor` produced but the composed catalog does not contain is a readiness
 * failure, never silent unbound execution: the handler never runs. Emits the real
 * `tool-catalog.bind-unavailable` op (readiness `unavailable`, reason `unknown-tool`) so an operator
 * can distinguish "this composition dropped a tool the bridge expects" from every other outcome
 * (#3413 F8 review, findings b1-1/AC10/AC11 -- this op was previously reachable only from the
 * unwired binder's own tests).
 */
function emitBindUnavailable(runtime: BridgeRuntime): void {
  const correlationId = correlationIdFor(runtime);
  try {
    emitToolLifecycleEvent(runtime.input.logPort, {
      ...identityFields(runtime),
      op: "tool-catalog.bind-unavailable",
      readiness: "unavailable",
      reason: "unknown-tool",
    });
  } catch (error) {
    emitServerDiagnostic(
      runtime.input.logPort.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "tool-catalog.lifecycle-sink-failed",
        source: "tool-catalog-bind-unavailable",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}

function dispatchMissing<T>(runtime: BridgeRuntime): Promise<T> {
  emitBindUnavailable(runtime);
  return Promise.reject(new CatalogDispatchFault("invalid", "unknown-tool"));
}

function emitSettlement(runtime: BridgeRuntime, fields: TerminalFields): void {
  const receipt = captureToolInvocationReceipt({
    invocationId: fields.invocationId,
    settlementId: fields.settlementId,
    reservationId: fields.reservationId,
    status: fields.status,
    effectStarted: fields.effectStarted,
    budgetDisposition: fields.budgetDisposition,
  });
  emitToolLifecycleEvent(runtime.input.logPort, {
    ...identityFields(runtime),
    op: "tool-catalog.invocation-settled",
    ...receipt,
    toolRef: fields.descriptor.toolRef,
    reason: fields.reason,
    inputBytes: 0,
    outputBytes: 0,
    resultCount: fields.status === "completed" ? 1 : 0,
    durationMs: Math.max(0, runtime.now() - fields.startedAt),
    truncated: false,
    ...(fields.status === "failed"
      ? {
          errorKind: errorKindOf(fields.error),
          frames: keikoStackFrames(fields.error),
          causeChain: causeChain(fields.error),
        }
      : {}),
  });
}

function emitStarted(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
): void {
  emitToolLifecycleEvent(runtime.input.logPort, {
    ...identityFields(runtime),
    op: "tool-catalog.invocation-started",
    invocationId: meta.invocationId,
    toolRef: meta.descriptor.toolRef,
    state: "started",
    reason: "none",
    reservationId: reservation.reservationId,
  });
}

/**
 * Settles a "denied" outcome and throws before the wrapped handler ever runs (fail closed). Throws
 * the shared `CatalogDispatchFault` -- the exact exception-shaping primitive
 * `CatalogInvocation.reserve()`/`.fail()` (catalogToolSettlement.ts) uses for every rejection --
 * rather than a second, bridge-local error type, so both settlement implementations attach the
 * same `status`/`reason` vocabulary to a fault and a caller can branch on one exception class
 * regardless of which path produced it.
 */
function denyBudgetExhausted(runtime: BridgeRuntime, meta: InvocationMeta): never {
  emitSettlement(runtime, {
    ...meta,
    status: "denied",
    reason: "budget-exhausted",
    reservationId: null,
    effectStarted: false,
    budgetDisposition: "not-reserved",
  });
  throw new CatalogDispatchFault("denied", "budget-exhausted");
}

/**
 * A live (function-provided) catalog is re-derived and compared against the projection captured at
 * construction; a static catalog cannot drift by construction, so this is a guaranteed no-op for
 * today's one production caller (#3413 F8 review, AC3 -- see the file header decision record). A
 * catalog that no longer compiles cleanly counts as drift too, rather than propagating an
 * unclassified `compileToolProjection` failure.
 */
function projectionDrift(runtime: BridgeRuntime): boolean {
  if (typeof runtime.input.catalog !== "function") return false;
  try {
    const live = compileToolProjection(runtime.input.catalog(), runtime.input.profile);
    return live.projectionDigest !== runtime.projection.projectionDigest;
  } catch {
    return true;
  }
}

/** Settles an `invalid`/`projection-mismatch` outcome and throws before the wrapped handler ever
 * runs (fail closed) -- the catalog this bridge was built from has since been revised. */
function denyProjectionMismatch(runtime: BridgeRuntime, meta: InvocationMeta): never {
  emitSettlement(runtime, {
    ...meta,
    status: "invalid",
    reason: "projection-mismatch",
    reservationId: null,
    effectStarted: false,
    budgetDisposition: "not-reserved",
  });
  throw new CatalogDispatchFault("invalid", "projection-mismatch");
}

/**
 * Classifies a rejection exactly the way `CatalogInvocation.fail()` does: a `CatalogDispatchFault`
 * carries its own settled `status`/`reason` (e.g. a budget port failure surfaced through
 * `catalogBudgetOperation`). A mid-flight `AbortSignal` firing (ADR-0175 D6's "Mid-flight abort"
 * row) settles `cancelled`/`parent-cancelled` exactly as `catalogToolSettlement.ts`'s
 * `checkStopped()` does for the real binder path -- detected through `errorKindOf`, the same
 * content-free classifier this bridge already uses for the settlement's `errorKind` field, rather
 * than a second abort-detection helper. Anything else is an opaque handler rejection.
 */
function classifyFailure(error: unknown): { status: ToolResultStatus; reason: ToolResultReason } {
  if (error instanceof CatalogDispatchFault) return { status: error.status, reason: error.reason };
  if (errorKindOf(error) === "AbortError")
    return { status: "cancelled", reason: "parent-cancelled" };
  return { status: "failed", reason: "handler-failed" };
}

/**
 * Commits or releases a settled reservation, mirroring `CatalogInvocation.account()`
 * (catalogToolSettlement.ts): exactly one accounting call per reservation, never both. A failing
 * accounting call settles as the canonical `budget-port-failed`/`*-uncertain` pair instead of the
 * caller's own error, because the reservation's true state is now unknown.
 */
function settleReservation(
  runtime: BridgeRuntime,
  reservation: CatalogFacadeBudgetReservation,
  effectStarted: boolean,
): { readonly budgetDisposition: ToolBudgetDisposition; readonly accountingFault?: Error } {
  try {
    if (effectStarted) runtime.input.budget.commit(reservation);
    else runtime.input.budget.release(reservation);
    return { budgetDisposition: effectStarted ? "committed" : "released" };
  } catch (error_) {
    return {
      budgetDisposition: effectStarted ? "commit-uncertain" : "release-uncertain",
      accountingFault:
        error_ instanceof Error ? error_ : new Error("catalog-budget-accounting-failed"),
    };
  }
}

/** Settles the success path: commits the reservation once and fails closed if that commit itself
 * fails, instead of falling through to a second, unpaired `release()` on the same reservation. */
function settleSuccess<T>(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  result: T,
): T {
  const accounting = settleReservation(runtime, reservation, true);
  emitSettlement(runtime, {
    ...meta,
    status: accounting.accountingFault === undefined ? "completed" : "failed",
    reason: accounting.accountingFault === undefined ? "none" : "budget-port-failed",
    reservationId: reservation.reservationId,
    effectStarted: true,
    budgetDisposition: accounting.budgetDisposition,
    error: accounting.accountingFault,
  });
  if (accounting.accountingFault !== undefined) throw accounting.accountingFault;
  return result;
}

/** Settles the failure path after the handler has started: conservatively commits the reservation
 * and reports the original rejection (classified through the shared `CatalogDispatchFault`
 * vocabulary), never the handler's own error masked by an unrelated accounting failure. */
function settleFailure(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  error: unknown,
): void {
  const accounting = settleReservation(runtime, reservation, true);
  const classified = classifyFailure(error);
  emitSettlement(runtime, {
    ...meta,
    status: accounting.accountingFault === undefined ? classified.status : "failed",
    reason: accounting.accountingFault === undefined ? classified.reason : "budget-port-failed",
    reservationId: reservation.reservationId,
    effectStarted: true,
    budgetDisposition: accounting.budgetDisposition,
    error: accounting.accountingFault ?? error,
  });
}

/** Marker rejection for a deadline race, never surfaced to the caller: `runReservedWithDeadline`
 * always translates it into the canonical `CatalogDispatchFault("timeout","deadline-exceeded")`. */
class CatalogFacadeDeadlineExceeded extends Error {
  public constructor() {
    super("catalog facade bridge deadline exceeded");
  }
}

async function settleAfterHandler<T>(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  handlerPromise: Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await handlerPromise;
  } catch (error) {
    settleFailure(runtime, meta, reservation, error);
    throw error;
  }
  return settleSuccess(runtime, meta, reservation, result);
}

/** Settles a "timeout" outcome once the authoritative deadline has already won the race; mirrors
 * `settleFailure`'s conservative "commit, not release" accounting since an effect may already have
 * started and the handler was never actually cancelled, only abandoned. */
function settleTimeout(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
): void {
  const accounting = settleReservation(runtime, reservation, true);
  emitSettlement(runtime, {
    ...meta,
    status: accounting.accountingFault === undefined ? "timeout" : "failed",
    reason: accounting.accountingFault === undefined ? "deadline-exceeded" : "budget-port-failed",
    reservationId: reservation.reservationId,
    effectStarted: true,
    budgetDisposition: accounting.budgetDisposition,
    error: accounting.accountingFault,
  });
}

/** ADR-0175 D6's "Result/cancellation arrives after settled" row: a completion this bridge no
 * longer owns must never publish content, charge a budget again, or emit a second terminal event --
 * it is recorded as one body-free `tool-catalog.completion-discarded` line instead. */
function emitDiscarded(runtime: BridgeRuntime, meta: InvocationMeta): void {
  const correlationId = correlationIdFor(runtime);
  try {
    emitToolLifecycleEvent(runtime.input.logPort, {
      ...identityFields(runtime),
      op: "tool-catalog.completion-discarded",
      invocationId: meta.invocationId,
      toolRef: meta.descriptor.toolRef,
      settlementId: meta.settlementId,
      reason: "late-completion",
    });
  } catch (error) {
    emitServerDiagnostic(
      runtime.input.logPort.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "tool-catalog.lifecycle-sink-failed",
        source: "tool-catalog-completion-discarded",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}

/**
 * Races the wrapped handler against `descriptor.bounds.maxDurationMs`. The handler is attached to
 * immediately regardless of which side wins (never an unhandled rejection): if the deadline wins,
 * the invocation settles `timeout`/`deadline-exceeded` and any later handler resolution/rejection
 * is quarantined via `emitDiscarded` instead of double-settling or silently vanishing.
 */
async function runReservedWithDeadline<T>(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  handlerPromise: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, deadlineMs);
  timer.unref();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer.ref = timer.ref; // no-op keep type inference stable; timer already scheduled above
    setTimeout(() => reject(new CatalogFacadeDeadlineExceeded()), 0);
  });
  void timeout;
  const quarantine = handlerPromise.then(
    () => {
      if (timedOut) emitDiscarded(runtime, meta);
    },
    () => {
      if (timedOut) emitDiscarded(runtime, meta);
    },
  );
  void quarantine;
  try {
    const result = await Promise.race([
      handlerPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new CatalogFacadeDeadlineExceeded());
        }, deadlineMs).unref();
      }),
    ]);
    clearTimeout(timer);
    return settleSuccess(runtime, meta, reservation, result);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof CatalogFacadeDeadlineExceeded) {
      timedOut = true;
      settleTimeout(runtime, meta, reservation);
      throw new CatalogDispatchFault("timeout", "deadline-exceeded");
    }
    settleFailure(runtime, meta, reservation, error);
    throw error;
  }
}

async function runReserved<T>(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  run: () => Promise<T>,
): Promise<T> {
  const handlerPromise = run();
  const deadlineMs = meta.descriptor.bounds.maxDurationMs;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return settleAfterHandler(runtime, meta, reservation, handlerPromise);
  }
  return runReservedWithDeadline(runtime, meta, reservation, handlerPromise, deadlineMs);
}

/**
 * Resolves availability and reserves budget, settling (and throwing) BEFORE the handler ever runs
 * if either budget-port call itself throws or reports unavailable -- mirroring
 * `CatalogInvocation`'s own guarantee (catalogToolDispatch.ts's `executeInvocation`, one try/catch
 * around the whole pre-reservation sequence) that a pre-reservation failure is never silently
 * unlogged. Before this, `available()`/`reserve()` throwing propagated straight out of `dispatch()`
 * with zero `tool-catalog.*` evidence even though the call still failed closed to the caller
 * (#3413 F8 review, latent because the wired in-memory budget port never throws).
 */
function reserveOrSettleDenied(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
): CatalogFacadeBudgetReservation {
  try {
    const available = catalogBudgetOperation(() => runtime.input.budget.available());
    if (!available) denyBudgetExhausted(runtime, meta);
    return catalogBudgetOperation(() => runtime.input.budget.reserve());
  } catch (error) {
    // `denyBudgetExhausted` already emitted its own "denied" settlement before throwing -- only a
    // budget-port exception (classified `CatalogDispatchFault("failed","budget-port-failed", ...)`
    // by `catalogBudgetOperation`) reaches here still unsettled.
    if (error instanceof CatalogDispatchFault && error.status === "denied") throw error;
    settleUnreserved(runtime, meta, error);
    throw error;
  }
}

function settleUnreserved(runtime: BridgeRuntime, meta: InvocationMeta, error: unknown): void {
  const classified = classifyFailure(error);
  emitSettlement(runtime, {
    ...meta,
    status: classified.status,
    reason: classified.reason,
    reservationId: null,
    effectStarted: false,
    budgetDisposition: "not-reserved",
    error,
  });
}

async function dispatchCovered<T>(
  runtime: BridgeRuntime,
  descriptor: ToolDescriptor,
  run: () => Promise<T>,
): Promise<T> {
  const meta: InvocationMeta = {
    descriptor,
    invocationId: runtime.mintId(),
    settlementId: runtime.mintId(),
    startedAt: runtime.now(),
  };
  const reservation = reserveOrSettleDenied(runtime, meta);
  emitStarted(runtime, meta, reservation);
  return runReserved(runtime, meta, reservation, run);
}

export function createCatalogFacadeBridge(input: CatalogFacadeBridgeInput): CatalogFacadeBridge {
  const runtime: BridgeRuntime = {
    input,
    projection: compileToolProjection(input.catalog, input.profile),
    mintId: input.mintId ?? randomUUID,
    now: input.now ?? Date.now,
  };
  return Object.freeze({
    resolve: (request: CodingToolActionRequest): ToolDescriptor | undefined =>
      resolveDescriptor(input.catalog, request),
    dispatch: <T>(request: CodingToolActionRequest, run: () => Promise<T>): Promise<T> => {
      const descriptor = resolveDescriptor(input.catalog, request);
      if (descriptor === undefined) {
        emitUnbound(runtime, request);
        return run();
      }
      return dispatchCovered(runtime, descriptor, run);
    },
  });
}
