import {
  assertCompatibilityTime,
  captureCatalogJson,
  compileToolProjection,
  computeHandlerSetDigest as computeCanonicalHandlerSetDigest,
  lookupCatalogTool,
  type ToolHandlerSetIdentity,
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
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { emitToolLifecycleEvent } from "./catalogToolLifecycle.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import {
  correlationIdOrUnknown,
  isValidCorrelationId,
  UNKNOWN_CORRELATION_ID,
} from "../correlation.js";
import { codingToolRequiredActionClasses } from "../coding-runtime/codingToolIpc.js";
import type {
  BoundToolSet,
  CatalogToolBinderInput,
  CatalogToolBinderOptions,
  CatalogToolExecutionOverride,
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
  readonly handlersByRef: ReadonlyMap<string, CatalogBoundHandler>;
  readonly handlerSetDigest: CatalogDigest;
  readonly bindingReadiness: BoundToolSet["readiness"] | undefined;
  readonly input: CatalogToolBinderInput;
  readonly options: CatalogToolBinderOptions;
  readonly executionOverride: CatalogToolExecutionOverride | undefined;
  latestOffer: OfferedToolSet | undefined;
  offerContext: CatalogTrustedContext | undefined;
}
/** Immutable catalog compilation and handler identities prepared once by production composition. */
export interface CatalogBindingPreparation {
  readonly catalog: CatalogToolBinderOptions["catalog"];
  readonly projection: CompiledToolProjection;
  readonly profile: CatalogProfile;
  readonly handlers: readonly CatalogBoundHandler[];
  readonly handlersByRef: ReadonlyMap<string, CatalogBoundHandler>;
  readonly handlerSetDigest: CatalogDigest;
  readonly bindingReadiness: BoundToolSet["readiness"] | undefined;
  readonly input: CatalogToolBinderInput;
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
  const descriptorsByRef = new Map(
    descriptors.map((descriptor) => [refKey(descriptor.toolRef), descriptor]),
  );
  const captured = input.handlerBindings.map((binding) => {
    const descriptor = descriptorsByRef.get(refKey(binding.toolRef));
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
  const capturedByRef = new Map(captured.map((binding) => [refKey(binding.toolRef), binding]));
  return Object.freeze(
    descriptors.map((descriptor) => ({
      descriptor,
      binding: capturedByRef.get(refKey(descriptor.toolRef)),
    })),
  );
}
/**
 * The one formula for "what handler set is actually bound," reused wherever a real
 * `CatalogBoundHandler[]` exists (this module's own `buildCatalogBinding`, and any other
 * production composition that assembles real bindings against this same catalog/projection --
 * e.g. `opencodeToolSchemas.ts`'s `createOpenCodeGatewayToolCatalogAdvertisement`, once its
 * composition point supplies real bindings instead of the compiled projection's static
 * declarations alone; #3413 F8 review, findings b1-2 / #3414-AC4). Exported so a caller never
 * re-derives this hash independently and risks the two copies drifting apart.
 */
export function computeHandlerSetDigest(
  projection: CompiledToolProjection,
  handlers: readonly CatalogBoundHandler[],
): CatalogDigest {
  const bindings: readonly ToolHandlerSetIdentity[] = handlers.map(({ descriptor, binding }) => ({
    toolRef: descriptor.toolRef,
    descriptorDigest: descriptor.descriptorDigest,
    handlerId: binding?.handlerId ?? null,
    handlerVersion: binding?.handlerVersion ?? null,
    catalogAction: binding?.catalogAction ?? null,
  }));
  return computeCanonicalHandlerSetDigest(projection.projectionDigest, bindings);
}
function buildCatalogPreparation(
  input: CatalogToolBinderInput,
  sourceCatalog: CatalogToolBinderOptions["catalog"],
  observeReadiness: boolean,
): CatalogBindingPreparation {
  const catalog = verifyToolCatalogSnapshot(sourceCatalog);
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
  const handlersByRef = new Map(
    handlers.map((handler) => [refKey(handler.descriptor.toolRef), handler]),
  );
  return Object.freeze({
    catalog,
    projection,
    profile,
    handlers,
    handlersByRef,
    handlerSetDigest: computeHandlerSetDigest(projection, handlers),
    bindingReadiness: observeReadiness ? catalogBoundToolSetReadiness(handlers) : undefined,
    input: {
      ...input,
      projection,
      handlerBindings: handlers.flatMap((handler) =>
        handler.binding === undefined ? [] : [handler.binding],
      ),
    },
  });
}
function bindingFromPreparation(
  preparation: CatalogBindingPreparation,
  options: CatalogToolBinderOptions,
  executionOverride?: CatalogToolExecutionOverride,
): CatalogBindingState {
  requireBinding(options.catalog.catalogRevision === preparation.catalog.catalogRevision);
  return {
    projection: preparation.projection,
    profile: preparation.profile,
    handlers: preparation.handlers,
    handlersByRef: preparation.handlersByRef,
    handlerSetDigest: preparation.handlerSetDigest,
    bindingReadiness: preparation.bindingReadiness,
    input: preparation.input,
    options: { ...options, catalog: preparation.catalog },
    executionOverride,
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
    return bindingFromPreparation(buildCatalogPreparation(input, options.catalog, false), options);
  } catch (error) {
    bindingFailure(input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
export function createCatalogBindingPreparation(
  input: CatalogToolBinderInput,
  catalog: CatalogToolBinderOptions["catalog"],
): CatalogBindingPreparation {
  try {
    return buildCatalogPreparation(input, catalog, true);
  } catch (error) {
    bindingFailure(input, error, UNKNOWN_CORRELATION_ID);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
export function createCatalogBindingFromPreparation(
  preparation: CatalogBindingPreparation,
  options: CatalogToolBinderOptions,
  executionOverride?: CatalogToolExecutionOverride,
): CatalogBindingState {
  try {
    return bindingFromPreparation(preparation, options, executionOverride);
  } catch (error) {
    bindingFailure(preparation.input, error, UNKNOWN_CORRELATION_ID);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
/** Derive an attested unavailable-handler variant without compiling again or installing handlers. */
export function deriveCatalogBindingPreparation(
  preparation: CatalogBindingPreparation,
  unavailableToolRefs: readonly ToolRef[],
): CatalogBindingPreparation {
  const unavailable = new Set<string>();
  for (const toolRef of unavailableToolRefs) {
    const key = refKey(toolRef);
    requireBinding(preparation.handlersByRef.has(key) && !unavailable.has(key));
    unavailable.add(key);
  }
  const handlers = Object.freeze(
    preparation.handlers.map((handler) =>
      unavailable.has(refKey(handler.descriptor.toolRef))
        ? Object.freeze({ descriptor: handler.descriptor, binding: undefined })
        : handler,
    ),
  );
  const handlersByRef = new Map(
    handlers.map((handler) => [refKey(handler.descriptor.toolRef), handler]),
  );
  return Object.freeze({
    ...preparation,
    handlers,
    handlersByRef,
    handlerSetDigest: computeHandlerSetDigest(preparation.projection, handlers),
    bindingReadiness: catalogBoundToolSetReadiness(handlers),
    input: Object.freeze({
      ...preparation.input,
      handlerBindings: Object.freeze(
        handlers.flatMap((handler) => (handler.binding === undefined ? [] : [handler.binding])),
      ),
    }),
  });
}
export function catalogHandlerReadiness(handler: CatalogBoundHandler): ToolHandlerReadiness {
  if (handler.binding === undefined) return "unavailable";
  const readiness = handler.binding.readiness();
  return READINESS.has(readiness) ? readiness : "mismatch";
}
function catalogBoundToolSetReadiness(
  handlers: readonly CatalogBoundHandler[],
): BoundToolSet["readiness"] {
  return handlers.every((handler) => catalogHandlerReadiness(handler) === "ready")
    ? "ready"
    : "unavailable";
}
export function catalogHandlerFor(
  state: CatalogBindingState,
  ref: ToolRef,
): CatalogBoundHandler | undefined {
  return state.handlersByRef.get(refKey(ref));
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
  // Guarded exactly like `bindingFailure` below (and `server-log.ts`'s own `parentCorrelationId`
  // shape guard): `context` is server-composed but its correlation ids are plain strings, not a
  // branded shape, so a caller that has not validated them yet must not reach
  // `emitToolLifecycleEvent` unguarded -- its own shape check (validateToolLifecycleEvent) throws
  // on an invalid id, which turns a malformed identity into an unhandled rejection instead of a
  // body-free diagnostic (b3-17/b3-10).
  const correlationId = correlationIdOrUnknown(context.correlationId);
  const parentCorrelationId =
    context.parentCorrelationId !== undefined && isValidCorrelationId(context.parentCorrelationId)
      ? context.parentCorrelationId
      : undefined;
  return {
    correlationId,
    catalogRevision: state.projection.catalogRevision,
    profile: state.projection.profile,
    projectionDigest: state.projection.projectionDigest,
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
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
function selectedBindingReadiness(
  state: CatalogBindingState,
  selectedReady: boolean,
): BoundToolSet["readiness"] {
  if (!selectedReady) return "unavailable";
  return state.bindingReadiness ?? "ready";
}
function buildCatalogOfferForTool(state: CatalogBindingState, toolRef: ToolRef): OfferedToolSet {
  const context = state.options.context();
  assertCatalogCompatibility(state);
  const now = state.options.now();
  const expiry = Math.min(Date.parse(context.authorityExpiresAt), now + 30_000);
  requireBinding(Number.isSafeInteger(expiry) && expiry > now);
  const offerId = state.options.mintId();
  requireBinding(/^[A-Za-z0-9_-]{1,128}$/u.test(offerId));
  const handler = catalogHandlerFor(state, toolRef);
  requireBinding(handler !== undefined);
  const readiness = catalogHandlerReadiness(handler);
  const ready = readiness === "ready";
  const toolRefs =
    ready && canOffer(state, handler, context, offerId) ? [handler.descriptor.toolRef] : [];
  const binding: BoundToolSet = deepFreeze({
    catalogRevision: state.projection.catalogRevision,
    profile: state.projection.profile,
    projectionDigest: state.projection.projectionDigest,
    handlerSetDigest: state.handlerSetDigest,
    readiness: selectedBindingReadiness(state, ready),
  });
  const offer: OfferedToolSet = deepFreeze({
    binding,
    offerId,
    toolRefs,
    expiresAt: new Date(expiry).toISOString(),
  });
  const identity = lifecycleIdentity(state, context);
  const bindingReady = binding.readiness === "ready";
  emitToolLifecycleEvent(state.input.logPort, {
    ...identity,
    op: bindingReady ? "tool-catalog.bind-ready" : "tool-catalog.bind-unavailable",
    readiness: bindingReady ? "ready" : "unavailable",
    ...(bindingReady
      ? { handlerSetDigest: binding.handlerSetDigest }
      : { reason: "handler-unavailable" as const }),
  });
  emitToolLifecycleEvent(state.input.logPort, {
    ...identity,
    op: "tool-catalog.projection",
    readiness: toolRefs.length === 1 ? "ready" : "unavailable",
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
export function createCatalogOfferForTool(
  state: CatalogBindingState,
  toolRef: ToolRef,
): OfferedToolSet {
  state.latestOffer = undefined;
  state.offerContext = undefined;
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    correlationId = state.options.context().correlationId;
    return buildCatalogOfferForTool(state, toolRef);
  } catch (error) {
    bindingFailure(state.input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
