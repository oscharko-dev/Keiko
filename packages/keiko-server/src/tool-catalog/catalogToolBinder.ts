import {
  assertCompatibilityTime,
  captureCatalogJson,
  compileToolProjection,
  lookupCatalogTool,
  verifyToolCatalogSnapshot,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogCompatibility,
  CatalogDigest,
  CatalogProfile,
  CompiledToolProjection,
  ToolDescriptor,
  ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  TOOL_HANDLER_READINESS,
  type ToolHandlerReadiness,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { emitToolLifecycleEvent } from "./catalogToolLifecycle.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { codingToolRequiredActionClasses } from "../coding-runtime/codingToolAuthorityPort.js";
import type {
  BoundToolSet,
  CatalogToolBinderInput,
  CatalogToolBinderOptions,
  CatalogToolHandlerBinding,
  CatalogTrustedContext,
  OfferedToolSet,
} from "./catalogToolPorts.js";

export interface CatalogBoundHandler {
  readonly descriptor: ToolDescriptor;
  readonly binding: CatalogToolHandlerBinding | undefined;
}
/** Server-private state. The public binder exposes only safe binding, offer and result projections. */
export interface CatalogBindingState {
  readonly projection: CompiledToolProjection;
  readonly profile: CatalogProfile;
  readonly handlers: readonly CatalogBoundHandler[];
  readonly handlerSetDigest: CatalogDigest;
  readonly input: CatalogToolBinderInput;
  readonly options: CatalogToolBinderOptions;
  latestOffer: OfferedToolSet | undefined;
  offerContext: CatalogTrustedContext | undefined;
}
const READINESS: ReadonlySet<string> = new Set(TOOL_HANDLER_READINESS);
function requireBinding(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Invalid catalog handler binding");
}
function refKey(ref: ToolRef): string {
  return `${ref.canonicalId}@${String(ref.contractVersion)}`;
}
function captureHandlers(
  input: CatalogToolBinderInput,
  descriptors: readonly ToolDescriptor[],
): readonly CatalogBoundHandler[] {
  const seen = new Set<string>();
  const captured = input.handlerBindings.map((binding) => {
    const descriptor = descriptors.find((item) => refKey(item.toolRef) === refKey(binding.toolRef));
    requireBinding(descriptor !== undefined && !seen.has(refKey(descriptor.toolRef)));
    seen.add(refKey(descriptor.toolRef));
    requireBinding(
      binding.descriptorDigest === descriptor.descriptorDigest &&
        binding.handlerId === descriptor.handlerRequirement.id &&
        binding.handlerVersion === descriptor.handlerRequirement.contractVersion,
    );
    requireBinding(
      descriptor.actionMapping.some((mapping) => mapping.action === binding.catalogAction),
    );
    requireBinding(
      [binding.readiness, binding.previewAction, binding.actionFor, binding.execute].every(
        (value) => typeof value === "function",
      ),
    );
    return { ...binding, toolRef: descriptor.toolRef };
  });
  return descriptors.map((descriptor) => ({
    descriptor,
    binding: captured.find((binding) => refKey(binding.toolRef) === refKey(descriptor.toolRef)),
  }));
}
function handlerDigest(
  projection: CompiledToolProjection,
  handlers: readonly CatalogBoundHandler[],
): CatalogDigest {
  return sha256Hex(
    canonicalise({
      domain: "keiko.tool-handler-set.v1",
      projectionDigest: projection.projectionDigest,
      bindings: handlers.map(({ descriptor, binding }) => ({
        toolRef: descriptor.toolRef,
        descriptorDigest: descriptor.descriptorDigest,
        handlerId: binding?.handlerId ?? null,
        handlerVersion: binding?.handlerVersion ?? null,
        catalogAction: binding?.catalogAction ?? null,
      })),
    }),
  ) as CatalogDigest;
}
function buildCatalogBinding(
  input: CatalogToolBinderInput,
  options: CatalogToolBinderOptions,
): CatalogBindingState {
  const catalog = verifyToolCatalogSnapshot(options.catalog);
  const projection = compileToolProjection(catalog, input.projection.profile);
  requireBinding(canonicalise(captureCatalogJson(input.projection)) === canonicalise(projection));
  const profile = catalog.profiles.find(
    (entry) =>
      entry.profile.id === projection.profile.id &&
      entry.profile.version === projection.profile.version,
  );
  requireBinding(profile !== undefined);
  const descriptors = projection.tools.map((tool) => {
    const descriptor = lookupCatalogTool(catalog, tool.toolRef);
    requireBinding(descriptor !== undefined);
    return descriptor;
  });
  const handlers = captureHandlers(input, descriptors);
  return {
    projection,
    profile,
    handlers,
    handlerSetDigest: handlerDigest(projection, handlers),
    input: {
      ...input,
      projection,
      handlerBindings: handlers.flatMap((handler) =>
        handler.binding === undefined ? [] : [handler.binding],
      ),
    },
    options: { ...options, catalog },
    latestOffer: undefined,
    offerContext: undefined,
  };
}
function bindingFailure(
  input: CatalogToolBinderInput,
  error: unknown,
  correlationId: string,
): void {
  emitServerDiagnostic(
    input.logPort.diagnostics,
    serverDiagnosticFromError({
      correlationId: isValidCorrelationId(correlationId) ? correlationId : UNKNOWN_CORRELATION_ID,
      operation: "tool-catalog.binding-failed",
      source: "tool-catalog-binding",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}
export function createCatalogBinding(
  input: CatalogToolBinderInput,
  options: CatalogToolBinderOptions,
): CatalogBindingState {
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    correlationId = options.context().correlationId;
    return buildCatalogBinding(input, options);
  } catch (error) {
    bindingFailure(input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
export function catalogHandlerReadiness(handler: CatalogBoundHandler): ToolHandlerReadiness {
  if (handler.binding === undefined) return "unavailable";
  const readiness = handler.binding.readiness();
  return READINESS.has(readiness) ? readiness : "mismatch";
}
export function assertCatalogCompatibility(state: CatalogBindingState): void {
  const now = state.options.now();
  requireBinding(Number.isSafeInteger(now) && now >= 0);
  for (const entry of state.profile.compatibility) {
    assertEntryScope(entry, state.projection);
    assertCompatibilityTime(entry, now);
  }
}
function assertEntryScope(entry: CatalogCompatibility, projection: CompiledToolProjection): void {
  requireBinding(
    entry.profile.id === projection.profile.id &&
      entry.profile.version === projection.profile.version &&
      entry.adapter.id === projection.adapterRuntime.id &&
      entry.adapter.version === projection.adapterRuntime.version,
  );
}
export function catalogBoundToolSet(
  state: CatalogBindingState,
  readiness = state.handlers.map(catalogHandlerReadiness),
): BoundToolSet {
  const ready = readiness.every((value) => value === "ready");
  return deepFreeze({
    catalogRevision: state.projection.catalogRevision,
    profile: state.projection.profile,
    projectionDigest: state.projection.projectionDigest,
    handlerSetDigest: state.handlerSetDigest,
    readiness: ready ? "ready" : "unavailable",
  });
}
export function lifecycleIdentity(
  state: CatalogBindingState,
  context: CatalogTrustedContext,
): {
  readonly correlationId: string;
  readonly catalogRevision: CatalogDigest;
  readonly profile: CatalogProfile["profile"];
  readonly projectionDigest: CatalogDigest;
  readonly parentCorrelationId?: string;
} {
  return {
    correlationId: context.correlationId,
    catalogRevision: state.projection.catalogRevision,
    profile: state.projection.profile,
    projectionDigest: state.projection.projectionDigest,
    ...(context.parentCorrelationId === undefined
      ? {}
      : { parentCorrelationId: context.parentCorrelationId }),
  };
}
function canOffer(
  state: CatalogBindingState,
  handler: CatalogBoundHandler,
  context: CatalogTrustedContext,
  offerId: string,
): boolean {
  if (handler.binding === undefined) return false;
  if (!state.input.budgetPort.available(handler.descriptor, context)) return false;
  const request = handler.binding.previewAction({ actionId: offerId, idempotencyKey: offerId });
  requireBinding(
    codingToolRequiredActionClasses(request).every((effect) =>
      handler.descriptor.effects.includes(effect),
    ),
  );
  const authority = state.input.authorityPort.preview(context.authority, request);
  return (
    authority.ok ||
    (authority.reason === "approval-required" &&
      state.input.approvalPort.available(request, context))
  );
}
function buildCatalogOffer(state: CatalogBindingState): OfferedToolSet {
  const context = state.options.context();
  assertCatalogCompatibility(state);
  const now = state.options.now();
  const expiry = Math.min(Date.parse(context.authorityExpiresAt), now + 30_000);
  requireBinding(Number.isSafeInteger(expiry) && expiry > now);
  const offerId = state.options.mintId();
  requireBinding(/^[A-Za-z0-9_-]{1,128}$/u.test(offerId));
  const readiness = state.handlers.map(catalogHandlerReadiness);
  const binding = catalogBoundToolSet(state, readiness);
  const toolRefs = state.handlers
    .filter(
      (handler, index) =>
        readiness[index] === "ready" && canOffer(state, handler, context, offerId),
    )
    .map((handler) => handler.descriptor.toolRef);
  const offer = deepFreeze({
    binding,
    offerId,
    toolRefs,
    expiresAt: new Date(expiry).toISOString(),
  });
  const identity = lifecycleIdentity(state, context);
  if (binding.readiness === "ready")
    emitToolLifecycleEvent(state.input.logPort, {
      ...identity,
      op: "tool-catalog.bind-ready",
      readiness: "ready",
      handlerSetDigest: binding.handlerSetDigest,
    });
  else
    emitToolLifecycleEvent(state.input.logPort, {
      ...identity,
      op: "tool-catalog.bind-unavailable",
      readiness: "unavailable",
      reason: "handler-unavailable",
    });
  emitToolLifecycleEvent(state.input.logPort, {
    ...identity,
    op: "tool-catalog.projection",
    readiness: toolRefs.length > 0 ? "ready" : "unavailable",
    resultCount: toolRefs.length,
  });
  state.offerContext = Object.freeze({ ...context });
  state.latestOffer = offer;
  return offer;
}
export function createCatalogOffer(state: CatalogBindingState): OfferedToolSet {
  state.latestOffer = undefined;
  state.offerContext = undefined;
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    correlationId = state.options.context().correlationId;
    return buildCatalogOffer(state);
  } catch (error) {
    bindingFailure(state.input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
