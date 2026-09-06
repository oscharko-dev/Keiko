// The mandatory catalog dispatch path (catalog-runtime.ts) requires a bound CatalogToolPort for
// every model tool call. Two production callers (#3407 the read-only child, #3408 the editor-agent
// producer) already own an existing ToolPort-shaped host whose authority is checked upstream of
// the harness session -- the child's per-call parent gate, the producer's own admission/root
// checks before the session is created. Neither needs the coding-workbench Authority Envelope the
// server's `createCatalogToolBinder` binds (that machinery stays legacy-native's alone, per
// ADR-0175 D1). This is the ONE thin adapter both reuse: it turns an existing ToolPort into the
// CatalogToolPort dispatch shape without a second execution path -- every call still runs through
// the injected ToolPort's own execute(), and settlement/reservation bookkeeping reuses the
// harness's own per-run budget port (catalog-budget.ts), the same accounting the legacy-native
// factory (`_support.ts` test fixture) already exercises. No new authority, policy or activity-log
// subsystem is introduced: the harness emitter's existing tool:call:* events and the
// observeExecution evidence check (catalog-runtime.ts) apply exactly as they do for every other
// bound catalog.
import type {
  CatalogToolPort,
  GatewayToolCatalogAdvertisement,
  ToolInvocationBudgetReservation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogVersionRef,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  BoundToolSet,
  BoundToolInvocation,
  CatalogToolDispatchOutcome,
  OfferedToolSet,
  ToolInvocationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type {
  ToolRef,
  ToolResultEnvelope,
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  catalogJsonBytes,
  compileToolProjection,
  lookupCatalogTool,
  type ToolCatalog,
} from "@oscharko-dev/keiko-tool-catalog";
import type { HarnessCatalogContext, HarnessCatalogFactory } from "./catalog-runtime.js";
import type { ToolCallResult, ToolPort } from "./ports.js";

type CompiledProjection = ReturnType<typeof compileToolProjection>;

const OFFER_EXPIRY_ISO = "2100-01-01T00:00:00.000Z";
const INVOCATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function offeredSet(catalog: ToolCatalog, projection: CompiledProjection): OfferedToolSet {
  return {
    binding: {
      catalogRevision: catalog.catalogRevision,
      profile: projection.profile,
      projectionDigest: projection.projectionDigest,
      handlerSetDigest: projection.projectionDigest,
      readiness: "ready",
    },
    offerId: `${projection.profile.id}-offer`,
    toolRefs: projection.tools.map((tool) => tool.toolRef),
    expiresAt: OFFER_EXPIRY_ISO,
  };
}

/** Body-free identity of the exact ready projection bound to one existing ToolPort. */
export interface LegacyPortCatalogBindingEvidence extends BoundToolSet {
  readonly toolRefs: readonly ToolRef[];
}

export type LegacyPortCatalogLifecycleObservation =
  | {
      readonly phase: "binding";
      readonly binding: LegacyPortCatalogBindingEvidence;
    }
  | {
      readonly phase: "invocation-started";
      readonly binding: LegacyPortCatalogBindingEvidence;
      readonly invocationId: string;
      readonly toolRef: ToolRef;
      readonly reservationId: string;
    }
  | {
      readonly phase: "invocation-settled";
      readonly binding: LegacyPortCatalogBindingEvidence;
      readonly invocationId: string;
      readonly toolRef: ToolRef;
      readonly settlementId: string;
      readonly reservationId: string | null;
      readonly status: ToolResultEnvelope["status"];
      readonly reason: ToolResultEnvelope["reason"];
      readonly effectStarted: boolean;
      readonly budgetDisposition: ToolInvocationReceipt["budgetDisposition"];
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly resultCount: number;
      readonly durationMs: number;
      readonly truncated: boolean;
    };

export type LegacyPortCatalogLifecycleObserver = (
  observation: LegacyPortCatalogLifecycleObservation,
) => void;

export type LegacyPortCatalogResultDisposition = {
  readonly [Status in ToolResultStatus]: {
    readonly status: Status;
    readonly reason: ToolResultReason<Status>;
  };
}[ToolResultStatus];

export type LegacyPortCatalogResultClassifier = (
  result: ToolCallResult,
) => LegacyPortCatalogResultDisposition;

export interface LegacyPortCatalogBinding {
  readonly factory: HarnessCatalogFactory;
  readonly evidence: LegacyPortCatalogBindingEvidence;
}

/**
 * Adapts an existing ToolPort into a HarnessCatalogFactory bound to one profile of `catalog`.
 * The port's own `execute()` remains the sole dispatch path; this only supplies the settlement
 * envelope catalog-runtime.ts requires (ADR-0175 D5) around that same call.
 */
export function createLegacyPortCatalogFactory(
  catalog: ToolCatalog,
  profile: CatalogVersionRef,
  port: ToolPort,
): HarnessCatalogFactory {
  return createLegacyPortCatalogBinding(catalog, profile, port).factory;
}

/**
 * Builds the adapter and exposes its exact body-free binding identity to production callers that
 * must persist catalog lifecycle evidence. The optional observer sees no arguments or result body.
 */
export function createLegacyPortCatalogBinding(
  catalog: ToolCatalog,
  profile: CatalogVersionRef,
  port: ToolPort,
  observe?: LegacyPortCatalogLifecycleObserver,
  classifyResult?: LegacyPortCatalogResultClassifier,
): LegacyPortCatalogBinding {
  const projection = compileToolProjection(catalog, profile);
  const offered = offeredSet(catalog, projection);
  const evidence: LegacyPortCatalogBindingEvidence = {
    ...offered.binding,
    toolRefs: offered.toolRefs,
  };
  const advertisement: GatewayToolCatalogAdvertisement = {
    kind: "bound",
    catalog,
    projection,
    offered,
  };
  const factory = (context: HarnessCatalogContext): CatalogToolPort => {
    let sequence = 0;
    observe?.({ phase: "binding", binding: evidence });
    const nextInvocationId = (): string => {
      sequence += 1;
      return `${context.runId}-${projection.profile.id}-${String(sequence)}`;
    };
    return {
      kind: "catalog",
      offer: (): GatewayToolCatalogAdvertisement => advertisement,
      // `request.invocation` is `BoundToolInvocation`, whose `kind` field is the single literal
      // "bound" (governed-tool-lifecycle.ts) -- the only value ever constructed by the
      // invocation normalizer's trust-boundary validation (keiko-tool-catalog/src/invocation.ts).
      // A per-call `kind !== "bound"` guard here would be unreachable by construction (confirmed:
      // the sibling native port implementation, nativeCatalogToolPort.ts, dispatches
      // `request.invocation` with no such check), so this adapter trusts the type instead of
      // re-deriving a check the normalizer already owns.
      execute: (request): Promise<CatalogToolDispatchOutcome> =>
        dispatch(
          catalog,
          projection,
          port,
          context,
          evidence,
          observe,
          classifyResult,
          request.toolCallId,
          request.invocation,
          nextInvocationId(),
        ),
    };
  };
  return { factory, evidence };
}

interface DispatchTarget {
  readonly descriptor: ToolDescriptor;
  readonly alias: string;
}

function resolveDispatchTarget(
  catalog: ToolCatalog,
  projection: CompiledProjection,
  toolRef: BoundToolInvocation["toolRef"],
): DispatchTarget {
  const descriptor = lookupCatalogTool(catalog, toolRef);
  const tool = projection.tools.find((entry) => entry.toolRef.canonicalId === toolRef.canonicalId);
  if (descriptor === undefined || tool === undefined)
    throw new TypeError("Unknown legacy-port catalog tool identity");
  return { descriptor, alias: tool.alias };
}

// Discriminated by key rather than a `kind` tag: the two branches never need to carry the same
// shape, and `"failed" in reserved` narrows just as precisely.
type ReserveOutcome =
  | { readonly reservation: ToolInvocationBudgetReservation }
  | { readonly failed: ToolInvocationBudgetReservation | undefined };

/**
 * Reserves and checks the budget without ever leaving a reservation dangling: a denied reserve()
 * never created a charge (ADR-0175 D6 pre-reservation rejection), and a revoked check() releases
 * the charge it just made before reporting failure (ADR-0175 D6 pre-effect reservations release).
 */
function reserveOrFail(
  context: HarnessCatalogContext,
  descriptor: ToolDescriptor,
  invocationId: string,
): ReserveOutcome {
  const reservation = context.budgetPort.reserve(descriptor, context, invocationId);
  if (reservation === undefined) return { failed: undefined };
  if (context.budgetPort.check(reservation, context)) return { reservation };
  context.budgetPort.release(reservation);
  return { failed: reservation };
}

/**
 * Runs the bound ToolPort under an already-live reservation, releasing it on any throw/rejection
 * so a failing handler never leaks a HarnessCounterBudget charge (ADR-0175 D6: throw/rejection
 * before settlement -> failed/handler-failed).
 */
async function executeOrFail(
  port: ToolPort,
  context: HarnessCatalogContext,
  toolCallId: string,
  alias: string,
  invocation: BoundToolInvocation,
  reservation: ToolInvocationBudgetReservation,
): Promise<{ readonly result: ToolCallResult } | { readonly failed: true }> {
  try {
    const result = await port.execute({
      toolCallId,
      toolName: alias,
      arguments: invocation.arguments as Record<string, unknown>,
      signal: context.signal,
    });
    return { result };
  } catch {
    context.budgetPort.release(reservation);
    return { failed: true };
  }
}

/** The shaped ADR-0175 D6 outcome for any pre-settlement throw/rejection; body-free by design. */
function handlerFailedOutcome(
  invocation: BoundToolInvocation,
  invocationId: string,
  reservation: ToolInvocationBudgetReservation | undefined,
): Extract<CatalogToolDispatchOutcome, { readonly kind: "settled" }> {
  return {
    kind: "settled",
    receipt: {
      invocationId,
      reservationId: reservation?.reservationId ?? null,
      settlementId: invocationId,
      budgetDisposition: reservation === undefined ? "not-reserved" : "released",
      effectStarted: false,
      status: "failed",
    },
    result: {
      schemaVersion: 1,
      invocationId,
      toolRef: invocation.toolRef,
      projectionDigest: invocation.projectionDigest,
      status: "failed",
      reason: "handler-failed",
      effectStarted: false,
      metrics: {
        inputBytes: catalogJsonBytes(invocation.arguments),
        outputBytes: 0,
        resultCount: 0,
        durationMs: 0,
      },
      page: null,
      data: null,
    },
  };
}

function settledOutcome(
  invocation: BoundToolInvocation,
  invocationId: string,
  reservationId: string,
  output: string,
  durationMs: number,
  disposition: LegacyPortCatalogResultDisposition,
): Extract<CatalogToolDispatchOutcome, { readonly kind: "settled" }> {
  const result = settledResult(invocation, invocationId, output, durationMs, disposition);
  return {
    kind: "settled",
    receipt: {
      invocationId,
      reservationId,
      settlementId: invocationId,
      budgetDisposition: "committed",
      effectStarted: true,
      status: disposition.status,
    },
    result,
  };
}

interface SettledResultBase {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly toolRef: BoundToolInvocation["toolRef"];
  readonly projectionDigest: BoundToolInvocation["projectionDigest"];
  readonly effectStarted: true;
  readonly metrics: ToolResultEnvelope["metrics"];
}

function settledResultBase(
  invocation: BoundToolInvocation,
  invocationId: string,
  output: string,
  durationMs: number,
): SettledResultBase {
  return {
    schemaVersion: 1 as const,
    invocationId,
    toolRef: invocation.toolRef,
    projectionDigest: invocation.projectionDigest,
    effectStarted: true,
    metrics: {
      inputBytes: catalogJsonBytes(invocation.arguments),
      outputBytes: catalogJsonBytes(output),
      resultCount: 0,
      durationMs,
    },
  };
}

function settledResult(
  invocation: BoundToolInvocation,
  invocationId: string,
  output: string,
  durationMs: number,
  disposition: LegacyPortCatalogResultDisposition,
): ToolResultEnvelope {
  const base = settledResultBase(invocation, invocationId, output, durationMs);
  if (disposition.status === "completed")
    return {
      ...base,
      metrics: { ...base.metrics, resultCount: 1 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: output,
    };
  const failure = { ...base, page: null, data: null };
  switch (disposition.status) {
    case "denied":
      return { ...failure, status: "denied", reason: disposition.reason };
    case "invalid":
      return { ...failure, status: "invalid", reason: disposition.reason };
    case "busy":
      return { ...failure, status: "busy", reason: disposition.reason };
    case "cancelled":
      return { ...failure, status: "cancelled", reason: disposition.reason };
    case "timeout":
      return { ...failure, status: "timeout", reason: disposition.reason };
    case "failed":
      return { ...failure, status: "failed", reason: disposition.reason };
  }
}

async function dispatch(
  catalog: ToolCatalog,
  projection: CompiledProjection,
  port: ToolPort,
  context: HarnessCatalogContext,
  binding: LegacyPortCatalogBindingEvidence,
  observe: LegacyPortCatalogLifecycleObserver | undefined,
  classifyResult: LegacyPortCatalogResultClassifier | undefined,
  toolCallId: string,
  invocation: BoundToolInvocation,
  invocationId: string,
): Promise<CatalogToolDispatchOutcome> {
  if (!INVOCATION_ID.test(invocationId))
    throw new TypeError("Invalid legacy-port catalog invocation identity");
  const { descriptor, alias } = resolveDispatchTarget(catalog, projection, invocation.toolRef);
  const reserved = reserveOrFail(context, descriptor, invocationId);
  if ("failed" in reserved) {
    const outcome = handlerFailedOutcome(invocation, invocationId, reserved.failed);
    observeSettlement(observe, binding, outcome);
    return outcome;
  }
  return dispatchReserved({
    binding,
    context,
    descriptor,
    invocation,
    invocationId,
    observe,
    classifyResult,
    port,
    toolCallId,
    alias,
    reservation: reserved.reservation,
  });
}

interface ReservedDispatchInput {
  readonly binding: LegacyPortCatalogBindingEvidence;
  readonly context: HarnessCatalogContext;
  readonly descriptor: ToolDescriptor;
  readonly invocation: BoundToolInvocation;
  readonly invocationId: string;
  readonly observe: LegacyPortCatalogLifecycleObserver | undefined;
  readonly port: ToolPort;
  readonly toolCallId: string;
  readonly alias: string;
  readonly reservation: ToolInvocationBudgetReservation;
  readonly classifyResult: LegacyPortCatalogResultClassifier | undefined;
}

async function dispatchReserved(input: ReservedDispatchInput): Promise<CatalogToolDispatchOutcome> {
  const { binding, context, descriptor, invocation, invocationId, observe, port, toolCallId } =
    input;
  observe?.({
    phase: "invocation-started",
    binding,
    invocationId,
    toolRef: descriptor.toolRef,
    reservationId: input.reservation.reservationId,
  });
  const executed = await executeOrFail(
    port,
    context,
    toolCallId,
    input.alias,
    invocation,
    input.reservation,
  );
  if ("failed" in executed) {
    const outcome = handlerFailedOutcome(invocation, invocationId, input.reservation);
    observeSettlement(observe, binding, outcome);
    return outcome;
  }
  context.budgetPort.commit(input.reservation);
  context.observeExecution({
    toolRef: descriptor.toolRef,
    toolCallId,
    commandExecuted: executed.result.commandExecuted === true,
    durationMs: executed.result.durationMs,
    ...(executed.result.metadata === undefined ? {} : { metadata: executed.result.metadata }),
  });
  const outcome = settledOutcome(
    invocation,
    invocationId,
    input.reservation.reservationId,
    executed.result.output,
    executed.result.durationMs,
    input.classifyResult?.(executed.result) ?? { status: "completed", reason: "none" },
  );
  observeSettlement(observe, binding, outcome);
  return outcome;
}

function observeSettlement(
  observe: LegacyPortCatalogLifecycleObserver | undefined,
  binding: LegacyPortCatalogBindingEvidence,
  outcome: Extract<CatalogToolDispatchOutcome, { readonly kind: "settled" }>,
): void {
  const { receipt, result } = outcome;
  observe?.({
    phase: "invocation-settled",
    binding,
    invocationId: receipt.invocationId,
    toolRef: requireToolRef(result.toolRef),
    settlementId: receipt.settlementId,
    reservationId: receipt.reservationId,
    status: result.status,
    reason: result.reason,
    effectStarted: receipt.effectStarted,
    budgetDisposition: receipt.budgetDisposition,
    inputBytes: result.metrics.inputBytes,
    outputBytes: result.metrics.outputBytes,
    resultCount: result.metrics.resultCount,
    durationMs: result.metrics.durationMs,
    truncated: result.page?.truncated ?? false,
  });
}

function requireToolRef(value: ToolRef | null): ToolRef {
  if (value !== null) return value;
  throw new TypeError("Legacy-port settlement omitted its bound tool identity");
}
