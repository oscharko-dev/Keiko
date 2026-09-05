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
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { captureToolInvocationReceipt } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { errorKindOf } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import type {
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ToolBudgetDisposition } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { emitToolLifecycleEvent, type CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";
import { CatalogDispatchFault, catalogBudgetOperation } from "./catalogToolRuntimeAuthority.js";

/**
 * Confidently-matched facade actions this bridge routes through the real catalog lifecycle and
 * settlement primitives (#3413, F8). Every canonical id below is an unambiguous mapping from the
 * IPC action shape (as `opencodeRuntimeAdapter.ts`'s `wireRequestFor`/`parseDraftToolRequest`
 * actually produce it for a model tool call) to a real production catalog canonical tool id
 * (OPENCODE_GATEWAY_CATALOG, opencodeToolSchemas.ts / opencode.ts). A request shape absent from
 * `catalogIdFor` is uncovered: `dispatch` below runs the existing handler unchanged and records one
 * body-free `tool-catalog.dispatch-unbound` line instead of a lifecycle pair -- never zero evidence.
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
      return request.phase === "propose"
        ? "keiko.git.stage"
        : request.phase === "execute"
          ? "keiko.git.execute"
          : undefined;
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
  if (request.phase === "execute") return request.intent === "merge" ? undefined : "keiko.git.execute";
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
  readonly catalog: ToolCatalog;
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

function resolveDescriptor(
  catalog: ToolCatalog,
  request: CodingToolActionRequest,
): ToolDescriptor | undefined {
  const canonicalId = catalogIdFor(request);
  if (canonicalId === undefined) return undefined;
  return lookupCatalogTool(catalog, createToolRef(canonicalId, 1));
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
 * Classifies a rejection exactly the way `CatalogInvocation.fail()` does: a `CatalogDispatchFault`
 * carries its own settled `status`/`reason` (e.g. a budget port failure surfaced through
 * `catalogBudgetOperation`); anything else is an opaque handler rejection.
 */
function classifyFailure(error: unknown): { status: ToolResultStatus; reason: ToolResultReason } {
  if (error instanceof CatalogDispatchFault) return { status: error.status, reason: error.reason };
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
  } catch (accountingFault) {
    return {
      budgetDisposition: effectStarted ? "commit-uncertain" : "release-uncertain",
      accountingFault:
        accountingFault instanceof Error
          ? accountingFault
          : new Error("catalog-budget-accounting-failed"),
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

/** Settles the failure path: releases the reservation once and reports the original rejection
 * (classified through the shared `CatalogDispatchFault` vocabulary), never the handler's own
 * error masked by an unrelated accounting failure. */
function settleFailure(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  error: unknown,
): void {
  const accounting = settleReservation(runtime, reservation, false);
  const classified = classifyFailure(error);
  emitSettlement(runtime, {
    ...meta,
    status: accounting.accountingFault === undefined ? classified.status : "failed",
    reason: accounting.accountingFault === undefined ? classified.reason : "budget-port-failed",
    reservationId: reservation.reservationId,
    effectStarted: false,
    budgetDisposition: accounting.budgetDisposition,
    error: accounting.accountingFault ?? error,
  });
}

async function runReserved<T>(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  run: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    settleFailure(runtime, meta, reservation, error);
    throw error;
  }
  return settleSuccess(runtime, meta, reservation, result);
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
