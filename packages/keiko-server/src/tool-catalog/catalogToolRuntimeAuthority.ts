import {
  captureCatalogJson,
  createToolRef,
  validateToolArguments,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  codingToolRequiredActionClasses,
  parseCodingToolRequest,
  type CodingToolActionRequest,
} from "../coding-runtime/codingToolIpc.js";
import {
  assertCatalogCompatibility,
  catalogHandlerReadiness,
  type CatalogBindingState,
  type CatalogBoundHandler,
} from "./catalogToolBinder.js";
import type {
  BoundToolInvocation,
  CatalogActionIdentity,
  CatalogTrustedContext,
} from "./catalogToolPorts.js";

export class CatalogDispatchFault extends Error {
  public constructor(
    public readonly status: Exclude<ToolResultStatus, "completed">,
    public readonly reason: ToolResultReason,
    cause?: unknown,
  ) {
    super("Catalog dispatch rejected", { cause });
  }
}
export function requireDispatch(
  condition: boolean,
  status: Exclude<ToolResultStatus, "completed">,
  reason: ToolResultReason,
): asserts condition {
  if (!condition) throw new CatalogDispatchFault(status, reason);
}
export function catalogBudgetOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new CatalogDispatchFault("failed", "budget-port-failed", error);
  }
}
function captureInvocationObject(source: unknown): CatalogJsonObject {
  try {
    const value = captureCatalogJson(source);
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
export function captureCatalogInvocation(
  state: CatalogBindingState,
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
  const handler = state.handlers.find((item) => sameRef(item.descriptor.toolRef, ref));
  requireDispatch(handler !== undefined, "invalid", "unknown-tool");
  if (!state.latestOffer.toolRefs.some((item) => sameRef(item, ref))) {
    const current = catalogDispatchContext(state);
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
export function sameRef(
  left: BoundToolInvocation["toolRef"],
  right: BoundToolInvocation["toolRef"],
): boolean {
  return left.canonicalId === right.canonicalId && left.contractVersion === right.contractVersion;
}
export function catalogDispatchContext(state: CatalogBindingState): CatalogTrustedContext {
  return Object.freeze({ ...state.options.context() });
}
export function revalidateCatalogContext(
  state: CatalogBindingState,
  expected: CatalogTrustedContext,
  handler: CatalogBoundHandler,
): CatalogTrustedContext {
  const current = catalogDispatchContext(state);
  const offered = state.offerContext;
  requireDispatch(offered !== undefined, "invalid", "unoffered-tool");
  requireDispatch(
    [offered, expected].every(
      (prior) =>
        prior.runId === current.runId &&
        prior.workspaceIdentity === current.workspaceIdentity &&
        prior.workspaceRoot === current.workspaceRoot &&
        prior.workspaceRevision === current.workspaceRevision,
    ),
    "invalid",
    "workspace-stale",
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
    Date.parse(state.latestOffer?.expiresAt ?? "") > state.options.now(),
    "invalid",
    "unoffered-tool",
  );
  try {
    assertCatalogCompatibility(state);
  } catch {
    throw new CatalogDispatchFault("invalid", "recovery-required");
  }
  requireDispatch(catalogHandlerReadiness(handler) === "ready", "failed", "handler-unavailable");
  return current;
}
export function captureHandlerAction(
  handler: CatalogBoundHandler,
  args: CatalogJsonValue,
  identity: CatalogActionIdentity,
): CodingToolActionRequest {
  requireDispatch(handler.binding !== undefined, "failed", "handler-unavailable");
  const captured = captureCatalogJson(handler.binding.actionFor(args, identity));
  const parsed = parseCodingToolRequest(
    JSON.stringify(captured),
    handler.descriptor.bounds.maxArgumentBytes,
  );
  requireDispatch(
    parsed?.actionId === identity.actionId && parsed.idempotencyKey === identity.idempotencyKey,
    "failed",
    "handler-mismatch",
  );
  requireDispatch(
    codingToolRequiredActionClasses(parsed).every((effect) =>
      handler.descriptor.effects.includes(effect),
    ),
    "failed",
    "handler-mismatch",
  );
  return deepFreeze(parsed);
}
function withoutProof(request: CodingToolActionRequest): string {
  const value = { ...request };
  if ("approvalProof" in value) delete value.approvalProof;
  return canonicalise(value);
}
export async function approveCatalogAction(
  state: CatalogBindingState,
  request: CodingToolActionRequest,
  context: CatalogTrustedContext,
): Promise<CodingToolActionRequest> {
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
  const captured = captureCatalogJson(approved);
  const parsed = parseCodingToolRequest(JSON.stringify(captured), 262_144);
  requireDispatch(
    parsed !== undefined && withoutProof(parsed) === withoutProof(request),
    "denied",
    "approval-rejected",
  );
  return deepFreeze(parsed);
}
