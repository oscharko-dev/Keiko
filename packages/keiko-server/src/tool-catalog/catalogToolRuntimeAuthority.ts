import type { CatalogConsumer, CodingCatalogConsumer } from "./catalogToolPorts.js";
import { CatalogDispatchFault, requireDispatch } from "./catalogToolErrors.js";
import {
  catalogScopeDigest,
  captureCatalogConsumerContext,
  sameRef,
} from "./catalogToolRequest.js";
export { CatalogDispatchFault, requireDispatch } from "./catalogToolErrors.js";
export { sameRef } from "./catalogToolRequest.js";
import {
  captureCatalogJson,
  createToolRef,
  validateToolArguments,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  GENERIC_TOOL_ARGUMENT_LIMITS,
  toolArgumentLimits,
  type CatalogJsonObject,
  type CatalogDigest,
  type CatalogJsonValue,
  type CatalogProfile,
  type ToolArgumentLimits,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  assertCatalogCompatibility,
  catalogHandlerFor,
  catalogHandlerReadiness,
  type CatalogBindingState,
  type CatalogBoundHandler,
} from "./catalogToolBinder.js";
import type {
  BoundToolInvocation,
  CatalogActionIdentity,
  CatalogConsumerPort,
  CatalogToolExecutionOverride,
} from "./catalogToolPorts.js";

export function catalogBudgetOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new CatalogDispatchFault("failed", "budget-port-failed", error);
  }
}
// The ceilings the invocation is captured under follow the tool it names; the descriptor's own
// bounds still decide what its arguments may be (`validateToolArguments`). A reference that cannot
// be read as plain data is captured, and rejected, under the generic ceilings.
function invocationLimits(source: unknown): ToolArgumentLimits {
  if (typeof source !== "object" || source === null) return GENERIC_TOOL_ARGUMENT_LIMITS;
  const ref = Object.getOwnPropertyDescriptor(source, "toolRef")?.value as unknown;
  if (typeof ref !== "object" || ref === null) return GENERIC_TOOL_ARGUMENT_LIMITS;
  const id = Object.getOwnPropertyDescriptor(ref, "canonicalId")?.value as unknown;
  return typeof id === "string" ? toolArgumentLimits(id) : GENERIC_TOOL_ARGUMENT_LIMITS;
}
function captureInvocationObject(source: unknown): CatalogJsonObject {
  try {
    const value = captureCatalogJson(source, undefined, invocationLimits(source));
    requireDispatch(
      value !== null && typeof value === "object" && !Array.isArray(value),
      "invalid",
      "invalid-arguments",
    );
    return value as CatalogJsonObject;
  } catch (error) {
    if (error instanceof CatalogDispatchFault) throw error;
    throw new CatalogDispatchFault("invalid", "invalid-arguments");
  }
}
export function captureCatalogInvocation<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  source: unknown,
): BoundToolInvocation {
  const object = captureInvocationObject(source);
  requireDispatch(
    Object.keys(object)
      .sort((left, right) => left.localeCompare(right))
      .join() === "arguments,kind,offerId,projectionDigest,toolRef",
    "invalid",
    "invalid-arguments",
  );
  requireDispatch(object.kind === "bound", "invalid", "invalid-arguments");
  requireDispatch(
    object.projectionDigest === state.projection.projectionDigest,
    "invalid",
    "projection-mismatch",
  );
  requireDispatch(
    typeof object.offerId === "string" && object.offerId === state.latestOffer?.offerId,
    "invalid",
    "unoffered-tool",
  );
  const ref = captureRef(object.toolRef);
  const handler = catalogHandlerFor<Consumer>(state, ref);
  requireDispatch(handler !== undefined, "invalid", "unknown-tool");
  if (!state.latestOffer.toolRefs.some((item) => sameRef(item, ref))) {
    const current = catalogDispatchContext<Consumer>(state);
    requireDispatch(
      catalogBudgetOperation(() => state.input.budgetPort.available(handler.descriptor, current)),
      "denied",
      "budget-exhausted",
    );
    requireDispatch(false, "invalid", "unoffered-tool");
  }
  let args: CatalogJsonValue;
  try {
    args = validateToolArguments(object.arguments, handler.descriptor);
  } catch {
    throw new CatalogDispatchFault("invalid", "invalid-arguments");
  }
  return deepFreeze({
    kind: "bound",
    toolRef: ref,
    projectionDigest: state.projection.projectionDigest,
    offerId: object.offerId,
    arguments: args,
  });
}
function captureRef(value: CatalogJsonValue | undefined): ReturnType<typeof createToolRef> {
  requireDispatch(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid",
    "unknown-tool",
  );
  const ref = value as CatalogJsonObject;
  requireDispatch(
    Object.keys(ref)
      .sort((left, right) => left.localeCompare(right))
      .join() === "canonicalId,contractVersion",
    "invalid",
    "unknown-tool",
  );
  try {
    requireDispatch(
      typeof ref.canonicalId === "string" && typeof ref.contractVersion === "number",
      "invalid",
      "unknown-tool",
    );
    return createToolRef(ref.canonicalId, ref.contractVersion);
  } catch {
    throw new CatalogDispatchFault("invalid", "unknown-tool");
  }
}
export function catalogDispatchContext<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
): Consumer["context"] {
  return captureCatalogConsumerContext(state.options.context());
}
// `admittedAt` is the instant the invocation was admitted: an offer bounds admission, not the call
// it admitted. The live authority, the workspace revision, compatibility and the handler's
// readiness are rechecked against now on every revalidation; the offer's expiry only against the
// admission, so an effect that starts after a long step or a human decision is never refused merely
// because the offer that admitted it has since expired (PR #3452, F43/F44).
export function revalidateCatalogContext<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  expected: Consumer["context"],
  handler: CatalogBoundHandler<Consumer>,
  admittedAt: number,
  expectedScope: CatalogDigest,
): Consumer["context"] {
  const current = catalogDispatchContext<Consumer>(state);
  const offered = state.offerContext;
  requireDispatch(offered !== undefined, "invalid", "unoffered-tool");
  const currentScope = catalogScopeDigest(state.input.consumerPort.scope(current));
  requireDispatch(
    [offered, expected].every((prior) => prior.runId === current.runId) &&
      expectedScope === currentScope &&
      state.offerScopeDigest === expectedScope,
    "invalid",
    state.input.consumerPort.staleReason,
  );
  requireDispatch(
    current.authority === expected.authority && current.authority === offered.authority,
    "denied",
    "authority-revoked",
  );
  requireDispatch(
    Date.parse(current.authorityExpiresAt) > state.options.now(),
    "denied",
    "authority-expired",
  );
  requireDispatch(
    Date.parse(state.latestOffer?.expiresAt ?? "") > admittedAt,
    "invalid",
    "unoffered-tool",
  );
  try {
    assertCatalogCompatibility<Consumer>(state);
  } catch {
    throw new CatalogDispatchFault("invalid", "recovery-required");
  }
  requireDispatch(
    catalogHandlerReadiness<Consumer>(handler) === "ready",
    "failed",
    "handler-unavailable",
  );
  return current;
}
export function captureHandlerAction<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  consumer: CatalogConsumerPort<Consumer>,
  handler: CatalogBoundHandler<Consumer>,
  args: CatalogJsonValue,
  identity: CatalogActionIdentity,
  executionOverride?: CatalogToolExecutionOverride<Consumer>,
  profile?: CatalogProfile,
): Consumer["action"] {
  requireDispatch(handler.binding !== undefined, "failed", "handler-unavailable");
  requireDispatch(
    executionOverride === undefined ||
      sameRef(executionOverride.toolRef, handler.descriptor.toolRef),
    "failed",
    "handler-mismatch",
  );
  const actionFor = executionOverride?.actionFor ?? handler.binding.actionFor;
  const captured = captureCatalogJson(
    actionFor(args, identity),
    undefined,
    toolArgumentLimits(handler.descriptor.toolRef.canonicalId),
  );
  const parsed = consumer.captureAction(handler, captured, executionOverride, profile);
  requireDispatch(
    parsed?.actionId === identity.actionId && parsed.idempotencyKey === identity.idempotencyKey,
    "failed",
    "handler-mismatch",
  );
  requireDispatch(
    consumer.requiredEffects(parsed).every((effect) => handler.descriptor.effects.includes(effect)),
    "failed",
    "handler-mismatch",
  );
  return deepFreeze(parsed);
}

function withoutProof(request: CatalogConsumer["action"]): string {
  const value = { ...request };
  if ("approvalProof" in value) delete value.approvalProof;
  return canonicalise(value);
}
export async function approveCatalogAction<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
>(
  state: CatalogBindingState<Consumer>,
  request: Consumer["action"],
  context: Consumer["context"],
  handler: CatalogBoundHandler<Consumer>,
): Promise<Consumer["action"]> {
  const preview = state.input.authorityPort.preview(context.authority, request);
  if (preview.ok) return request;
  requireDispatch(preview.reason === "approval-required", "denied", "hard-denial");
  requireDispatch(
    state.input.approvalPort.available(request, context),
    "denied",
    "approval-required",
  );
  const approved = await state.input.approvalPort.request(request, context);
  requireDispatch(approved !== undefined, "denied", "approval-rejected");
  // The admitted descriptor owns the ceiling; a consumer's action text cannot widen it.
  const captured = captureCatalogJson(
    approved,
    undefined,
    toolArgumentLimits(handler.descriptor.toolRef.canonicalId),
  );
  const parsed = state.input.consumerPort.captureApprovedAction(captured);
  requireDispatch(
    parsed !== undefined && withoutProof(parsed) === withoutProof(request),
    "denied",
    "approval-rejected",
  );
  return deepFreeze(parsed);
}
