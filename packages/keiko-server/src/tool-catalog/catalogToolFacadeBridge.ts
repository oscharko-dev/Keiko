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
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { emitToolLifecycleEvent, type CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";

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

/** Thrown before the wrapped handler ever runs; the facade maps this to its own "denied" status. */
export class CatalogFacadeDeniedError extends Error {
  public constructor(public readonly reason: "budget-exhausted") {
    super("Catalog tool dispatch denied");
    this.name = "CatalogFacadeDeniedError";
  }
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
type TerminalStatus = "completed" | "denied" | "failed";
interface TerminalFields extends InvocationMeta {
  readonly status: TerminalStatus;
  readonly reason: string;
  readonly reservationId: string | null;
  readonly effectStarted: boolean;
  readonly budgetDisposition: "not-reserved" | "committed" | "released";
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

/** Settles a "denied" outcome and throws before the wrapped handler ever runs (fail closed). */
function denyBudgetExhausted(runtime: BridgeRuntime, meta: InvocationMeta): never {
  emitSettlement(runtime, {
    ...meta,
    status: "denied",
    reason: "budget-exhausted",
    reservationId: null,
    effectStarted: false,
    budgetDisposition: "not-reserved",
  });
  throw new CatalogFacadeDeniedError("budget-exhausted");
}

async function runReserved<T>(
  runtime: BridgeRuntime,
  meta: InvocationMeta,
  reservation: CatalogFacadeBudgetReservation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();
    runtime.input.budget.commit(reservation);
    emitSettlement(runtime, {
      ...meta,
      status: "completed",
      reason: "none",
      reservationId: reservation.reservationId,
      effectStarted: true,
      budgetDisposition: "committed",
    });
    return result;
  } catch (error) {
    runtime.input.budget.release(reservation);
    emitSettlement(runtime, {
      ...meta,
      status: "failed",
      reason: "handler-failed",
      reservationId: reservation.reservationId,
      effectStarted: false,
      budgetDisposition: "released",
      error,
    });
    throw error;
  }
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
  if (!runtime.input.budget.available()) denyBudgetExhausted(runtime, meta);
  const reservation = runtime.input.budget.reserve();
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
