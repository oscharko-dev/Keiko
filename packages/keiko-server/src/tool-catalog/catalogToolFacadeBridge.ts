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
 * settlement primitives (#3413, F8). Every entry is an unambiguous 1:1 mapping from the IPC
 * action shape to a real production catalog canonical tool id (OPENCODE_GATEWAY_CATALOG,
 * opencodeToolSchemas.ts). An action absent from this map is uncovered: `dispatch` below runs the
 * existing handler unchanged, with no log line and no behaviour change.
 *
 * Coverage is deliberately narrow for this change: `discover` never carries optional fields and
 * never needs approval, so it round-trips through settlement without inventing IPC<->catalog
 * argument translation for the other actions. Widening coverage (read's optional startLine/
 * maxLines defaults, edit, verification, egress, skill, child-agent, and the git/delivery/search/
 * command actions the production catalog does not model at all yet) is tracked as follow-up work
 * -- see this change's report for exact file:line pointers.
 */
const CATALOG_FACADE_TOOL_IDS: Partial<Record<CodingToolActionRequest["action"], string>> =
  Object.freeze({
    discover: "keiko.workspace.discover",
  });

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
  const canonicalId = CATALOG_FACADE_TOOL_IDS[request.action];
  if (canonicalId === undefined) return undefined;
  return lookupCatalogTool(catalog, createToolRef(canonicalId, 1));
}

function identityFields(runtime: BridgeRuntime): {
  readonly correlationId: string;
  readonly catalogRevision: CompiledToolProjection["catalogRevision"];
  readonly profile: CompiledToolProjection["profile"];
  readonly projectionDigest: CompiledToolProjection["projectionDigest"];
  readonly parentCorrelationId?: string;
} {
  const ctx = runtime.input.context();
  const correlationId =
    typeof ctx.correlationId === "string" && isValidCorrelationId(ctx.correlationId)
      ? ctx.correlationId
      : UNKNOWN_CORRELATION_ID;
  return {
    correlationId,
    catalogRevision: runtime.projection.catalogRevision,
    profile: runtime.projection.profile,
    projectionDigest: runtime.projection.projectionDigest,
    ...(ctx.parentCorrelationId === undefined
      ? {}
      : { parentCorrelationId: ctx.parentCorrelationId }),
  };
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
): { readonly budgetDisposition: ToolBudgetDisposition; readonly accountingFault?: unknown } {
  try {
    if (effectStarted) runtime.input.budget.commit(reservation);
    else runtime.input.budget.release(reservation);
    return { budgetDisposition: effectStarted ? "committed" : "released" };
  } catch (accountingFault) {
    return {
      budgetDisposition: effectStarted ? "commit-uncertain" : "release-uncertain",
      accountingFault,
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
  const available = catalogBudgetOperation(() => runtime.input.budget.available());
  if (!available) denyBudgetExhausted(runtime, meta);
  const reservation = catalogBudgetOperation(() => runtime.input.budget.reserve());
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
      return descriptor === undefined ? run() : dispatchCovered(runtime, descriptor, run);
    },
  });
}
