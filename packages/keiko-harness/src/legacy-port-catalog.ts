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
  BoundToolInvocation,
  CatalogToolDispatchOutcome,
  OfferedToolSet,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
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
  const projection = compileToolProjection(catalog, profile);
  const advertisement: GatewayToolCatalogAdvertisement = {
    kind: "bound",
    catalog,
    projection,
    offered: offeredSet(catalog, projection),
  };
  return (context: HarnessCatalogContext): CatalogToolPort => {
    let sequence = 0;
    const nextInvocationId = (): string => {
      sequence += 1;
      return `${context.runId}-${projection.profile.id}-${String(sequence)}`;
    };
    return {
      kind: "catalog",
      offer: (): GatewayToolCatalogAdvertisement => advertisement,
      execute: (request): Promise<CatalogToolDispatchOutcome> => {
        if (request.invocation.kind !== "bound")
          throw new TypeError("Legacy-port catalog requires a bound invocation");
        return dispatch(
          catalog,
          projection,
          port,
          context,
          request.toolCallId,
          request.invocation,
          nextInvocationId(),
        );
      },
    };
  };
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
): CatalogToolDispatchOutcome {
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
): CatalogToolDispatchOutcome {
  return {
    kind: "settled",
    receipt: {
      invocationId,
      reservationId,
      settlementId: invocationId,
      budgetDisposition: "committed",
      effectStarted: true,
      status: "completed",
    },
    result: {
      schemaVersion: 1,
      invocationId,
      toolRef: invocation.toolRef,
      projectionDigest: invocation.projectionDigest,
      status: "completed",
      reason: "none",
      effectStarted: true,
      metrics: {
        inputBytes: catalogJsonBytes(invocation.arguments),
        outputBytes: catalogJsonBytes(output),
        resultCount: 1,
        durationMs,
      },
      page: { truncated: false, reason: "none", cursor: null },
      data: output,
    },
  };
}

async function dispatch(
  catalog: ToolCatalog,
  projection: CompiledProjection,
  port: ToolPort,
  context: HarnessCatalogContext,
  toolCallId: string,
  invocation: BoundToolInvocation,
  invocationId: string,
): Promise<CatalogToolDispatchOutcome> {
  if (!INVOCATION_ID.test(invocationId))
    throw new TypeError("Invalid legacy-port catalog invocation identity");
  const { descriptor, alias } = resolveDispatchTarget(catalog, projection, invocation.toolRef);
  const reserved = reserveOrFail(context, descriptor, invocationId);
  if ("failed" in reserved) return handlerFailedOutcome(invocation, invocationId, reserved.failed);
  const executed = await executeOrFail(
    port,
    context,
    toolCallId,
    alias,
    invocation,
    reserved.reservation,
  );
  if ("failed" in executed)
    return handlerFailedOutcome(invocation, invocationId, reserved.reservation);
  context.budgetPort.commit(reserved.reservation);
  context.observeExecution({
    toolRef: descriptor.toolRef,
    toolCallId,
    commandExecuted: executed.result.commandExecuted === true,
    durationMs: executed.result.durationMs,
    ...(executed.result.metadata === undefined ? {} : { metadata: executed.result.metadata }),
  });
  return settledOutcome(
    invocation,
    invocationId,
    reserved.reservation.reservationId,
    executed.result.output,
    executed.result.durationMs,
  );
}
