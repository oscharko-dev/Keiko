import { catalogScopeDigest, captureCatalogConsumerContext } from "./catalogToolRequest.js";
import type { CatalogConsumer, CodingCatalogConsumer } from "./catalogToolPorts.js";
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
import type {
  BoundToolSet,
  CatalogBoundHandler,
  CatalogConsumerPort,
  CatalogToolBinderInput,
  CatalogToolBinderOptions,
  CatalogToolExecutionOverride,
  OfferedToolSet,
} from "./catalogToolPorts.js";

export type { CatalogBoundHandler } from "./catalogToolPorts.js";
/** Server-private state. The public binder exposes only safe binding, offer and result projections. */
export interface CatalogBindingState<Consumer extends CatalogConsumer = CodingCatalogConsumer> {
  readonly projection: CompiledToolProjection;
  readonly profile: CatalogProfile;
  readonly handlers: readonly CatalogBoundHandler<Consumer>[];
  readonly handlersByRef: ReadonlyMap<string, CatalogBoundHandler<Consumer>>;
  readonly handlerSetDigest: CatalogDigest;
  readonly bindingReadiness: BoundToolSet["readiness"] | undefined;
  readonly input: CatalogToolBinderInput<Consumer>;
  readonly options: CatalogToolBinderOptions<Consumer>;
  readonly executionOverride: CatalogToolExecutionOverride<Consumer> | undefined;
  latestOffer: OfferedToolSet | undefined;
  offerContext: Consumer["context"] | undefined;
  offerScopeDigest: CatalogDigest | undefined;
}
/** Immutable catalog compilation and handler identities prepared once by production composition. */
export interface CatalogBindingPreparation<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
> {
  readonly catalog: CatalogToolBinderOptions<Consumer>["catalog"];
  readonly projection: CompiledToolProjection;
  readonly profile: CatalogProfile;
  readonly handlers: readonly CatalogBoundHandler<Consumer>[];
  readonly handlersByRef: ReadonlyMap<string, CatalogBoundHandler<Consumer>>;
  readonly handlerSetDigest: CatalogDigest;
  readonly bindingReadiness: BoundToolSet["readiness"] | undefined;
  readonly input: CatalogToolBinderInput<Consumer>;
}
const READINESS: ReadonlySet<string> = new Set(TOOL_HANDLER_READINESS);
function requireBinding(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Invalid catalog handler binding");
}
function refKey(ref: ToolRef): string {
  return `${ref.canonicalId}@${String(ref.contractVersion)}`;
}
function captureHandlers<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  input: CatalogToolBinderInput<Consumer>,
  descriptors: readonly ToolDescriptor[],
): readonly CatalogBoundHandler<Consumer>[] {
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
export function computeHandlerSetDigest<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  projection: CompiledToolProjection,
  handlers: readonly CatalogBoundHandler<Consumer>[],
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
function captureConsumerPort<Consumer extends CatalogConsumer>(
  port: CatalogConsumerPort<Consumer>,
): CatalogConsumerPort<Consumer> {
  const consumerPort = Object.freeze({ ...port });
  requireBinding(
    [
      consumerPort.scope,
      consumerPort.requiredEffects,
      consumerPort.captureAction,
      consumerPort.captureApprovedAction,
    ].every((value) => typeof value === "function"),
  );
  requireBinding(new Set(["workspace-stale", "consumer-stale"]).has(consumerPort.staleReason));
  return consumerPort;
}
function buildCatalogPreparation<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  input: CatalogToolBinderInput<Consumer>,
  sourceCatalog: CatalogToolBinderOptions<Consumer>["catalog"],
  observeReadiness: boolean,
): CatalogBindingPreparation<Consumer> {
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
  const handlers = captureHandlers<Consumer>(input, descriptors);
  const consumerPort = captureConsumerPort(input.consumerPort);
  const handlersByRef = new Map(
    handlers.map((handler) => [refKey(handler.descriptor.toolRef), handler]),
  );
  return Object.freeze({
    catalog,
    projection,
    profile,
    handlers,
    handlersByRef,
    handlerSetDigest: computeHandlerSetDigest<Consumer>(projection, handlers),
    bindingReadiness: observeReadiness
      ? catalogBoundToolSetReadiness<Consumer>(handlers)
      : undefined,
    input: {
      ...input,
      consumerPort,
      projection,
      handlerBindings: handlers.flatMap((handler) =>
        handler.binding === undefined ? [] : [handler.binding],
      ),
    },
  });
}
function bindingFromPreparation<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  preparation: CatalogBindingPreparation<Consumer>,
  options: CatalogToolBinderOptions<Consumer>,
  executionOverride?: CatalogToolExecutionOverride<Consumer>,
): CatalogBindingState<Consumer> {
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
    offerScopeDigest: undefined,
  };
}
function bindingFailure<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  input: CatalogToolBinderInput<Consumer>,
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
export function createCatalogBinding<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  input: CatalogToolBinderInput<Consumer>,
  options: CatalogToolBinderOptions<Consumer>,
): CatalogBindingState<Consumer> {
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    correlationId = options.context().correlationId;
    return bindingFromPreparation<Consumer>(
      buildCatalogPreparation<Consumer>(input, options.catalog, false),
      options,
    );
  } catch (error) {
    bindingFailure<Consumer>(input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
export function createCatalogBindingPreparation<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
>(
  input: CatalogToolBinderInput<Consumer>,
  catalog: CatalogToolBinderOptions<Consumer>["catalog"],
  observeReadiness = true,
): CatalogBindingPreparation<Consumer> {
  try {
    return buildCatalogPreparation<Consumer>(input, catalog, observeReadiness);
  } catch (error) {
    bindingFailure<Consumer>(input, error, UNKNOWN_CORRELATION_ID);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
export function createCatalogBindingFromPreparation<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
>(
  preparation: CatalogBindingPreparation<Consumer>,
  options: CatalogToolBinderOptions<Consumer>,
  executionOverride?: CatalogToolExecutionOverride<Consumer>,
): CatalogBindingState<Consumer> {
  try {
    return bindingFromPreparation<Consumer>(preparation, options, executionOverride);
  } catch (error) {
    bindingFailure<Consumer>(preparation.input, error, UNKNOWN_CORRELATION_ID);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
/** Derive an attested unavailable-handler variant without compiling again or installing handlers. */
export function deriveCatalogBindingPreparation<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
>(
  preparation: CatalogBindingPreparation<Consumer>,
  unavailableToolRefs: readonly ToolRef[],
): CatalogBindingPreparation<Consumer> {
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
    handlerSetDigest: computeHandlerSetDigest<Consumer>(preparation.projection, handlers),
    bindingReadiness: catalogBoundToolSetReadiness<Consumer>(handlers),
    input: Object.freeze({
      ...preparation.input,
      handlerBindings: Object.freeze(
        handlers.flatMap((handler) => (handler.binding === undefined ? [] : [handler.binding])),
      ),
    }),
  });
}
export function catalogHandlerReadiness<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  handler: CatalogBoundHandler<Consumer>,
): ToolHandlerReadiness {
  if (handler.binding === undefined) return "unavailable";
  const readiness = handler.binding.readiness();
  return READINESS.has(readiness) ? readiness : "mismatch";
}
function catalogBoundToolSetReadiness<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  handlers: readonly CatalogBoundHandler<Consumer>[],
): BoundToolSet["readiness"] {
  return handlers.every((handler) => catalogHandlerReadiness<Consumer>(handler) === "ready")
    ? "ready"
    : "unavailable";
}
export function catalogHandlerFor<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  ref: ToolRef,
): CatalogBoundHandler<Consumer> | undefined {
  return state.handlersByRef.get(refKey(ref));
}
export function assertCatalogCompatibility<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
>(state: CatalogBindingState<Consumer>): void {
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
export function catalogBoundToolSet<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
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
export function lifecycleIdentity<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  context: Consumer["context"],
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
function canOffer<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  handler: CatalogBoundHandler<Consumer>,
  context: Consumer["context"],
  offerId: string,
): boolean {
  if (handler.binding === undefined) return false;
  if (!state.input.budgetPort.available(handler.descriptor, context)) return false;
  const request = handler.binding.previewAction({ actionId: offerId, idempotencyKey: offerId });
  requireBinding(
    state.input.consumerPort
      .requiredEffects(request)
      .every((effect) => handler.descriptor.effects.includes(effect)),
  );
  const authority = state.input.authorityPort.preview(context.authority, request);
  return (
    authority.ok ||
    (authority.reason === "approval-required" &&
      state.input.approvalPort.available(request, context))
  );
}
function recordCatalogOffer<Consumer extends CatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  context: Consumer["context"],
  offer: OfferedToolSet,
): void {
  const { binding, toolRefs } = offer;
  const identity = lifecycleIdentity<Consumer>(state, context);
  emitBindingReadiness(state, identity, binding);
  emitToolLifecycleEvent(state.input.logPort, {
    ...identity,
    op: "tool-catalog.projection",
    readiness: toolRefs.length > 0 ? "ready" : "unavailable",
    resultCount: toolRefs.length,
  });
}
function admitCatalogOffer<Consumer extends CatalogConsumer>(
  state: CatalogBindingState<Consumer>,
): {
  readonly context: Consumer["context"];
  readonly scopeDigest: CatalogDigest;
  readonly expiry: number;
  readonly offerId: string;
} {
  const context = state.options.context();
  const scopeDigest = catalogScopeDigest(state.input.consumerPort.scope(context));
  assertCatalogCompatibility<Consumer>(state);
  const now = state.options.now();
  const expiry = Math.min(Date.parse(context.authorityExpiresAt), now + 30_000);
  requireBinding(Number.isSafeInteger(expiry) && expiry > now);
  const offerId = state.options.mintId();
  requireBinding(/^[A-Za-z0-9_-]{1,128}$/u.test(offerId));
  return { context, scopeDigest, expiry, offerId };
}
function buildCatalogOffer<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
): OfferedToolSet {
  const { context, scopeDigest, expiry, offerId } = admitCatalogOffer(state);
  const readiness = state.handlers.map(catalogHandlerReadiness);
  const binding = catalogBoundToolSet<Consumer>(state, readiness);
  const toolRefs = state.handlers
    .filter(
      (handler, index) =>
        readiness[index] === "ready" && canOffer<Consumer>(state, handler, context, offerId),
    )
    .map((handler) => handler.descriptor.toolRef);
  const offer = deepFreeze({
    binding,
    offerId,
    toolRefs,
    expiresAt: new Date(expiry).toISOString(),
  });
  recordCatalogOffer(state, context, offer);
  state.offerContext = captureCatalogConsumerContext(context);
  state.offerScopeDigest = scopeDigest;
  state.latestOffer = offer;
  return offer;
}
function selectedBindingReadiness<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  selectedReady: boolean,
): BoundToolSet["readiness"] {
  if (!selectedReady) return "unavailable";
  return state.bindingReadiness ?? "ready";
}

function emitBindingReadiness<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  identity: ReturnType<typeof lifecycleIdentity>,
  binding: BoundToolSet,
): void {
  if (binding.readiness === "ready") {
    emitToolLifecycleEvent(state.input.logPort, {
      ...identity,
      op: "tool-catalog.bind-ready",
      readiness: "ready",
      handlerSetDigest: binding.handlerSetDigest,
    });
    return;
  }
  emitToolLifecycleEvent(state.input.logPort, {
    ...identity,
    op: "tool-catalog.bind-unavailable",
    readiness: "unavailable",
    reason: "handler-unavailable",
  });
}

function buildCatalogOfferForTool<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  toolRef: ToolRef,
): OfferedToolSet {
  const { context, scopeDigest, expiry, offerId } = admitCatalogOffer(state);
  const handler = catalogHandlerFor<Consumer>(state, toolRef);
  requireBinding(handler !== undefined);
  const readiness = catalogHandlerReadiness<Consumer>(handler);
  const ready = readiness === "ready";
  // This targeted offer is used only to reify an already parsed, catalog-known facade request at
  // dispatch time. Keep the ready handler in that internal offer so the canonical invocation path
  // can settle a current authority or budget refusal as `denied` with `effectStarted: false`.
  // The model-facing whole-catalog offer above still calls `canOffer`, so it never advertises an
  // action that current authority or budget does not admit. An unavailable handler remains absent
  // here and therefore retains the canonical `unoffered-tool` result.
  const toolRefs = ready ? [handler.descriptor.toolRef] : [];
  const binding: BoundToolSet = deepFreeze({
    catalogRevision: state.projection.catalogRevision,
    profile: state.projection.profile,
    projectionDigest: state.projection.projectionDigest,
    handlerSetDigest: state.handlerSetDigest,
    readiness: selectedBindingReadiness<Consumer>(state, ready),
  });
  const offer: OfferedToolSet = deepFreeze({
    binding,
    offerId,
    toolRefs,
    expiresAt: new Date(expiry).toISOString(),
  });
  const identity = lifecycleIdentity<Consumer>(state, context);
  emitBindingReadiness<Consumer>(state, identity, binding);
  emitToolLifecycleEvent(state.input.logPort, {
    ...identity,
    op: "tool-catalog.projection",
    readiness: toolRefs.length === 1 ? "ready" : "unavailable",
    resultCount: toolRefs.length,
  });
  state.offerContext = captureCatalogConsumerContext(context);
  state.offerScopeDigest = scopeDigest;
  state.latestOffer = offer;
  return offer;
}
export function createCatalogOffer<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
): OfferedToolSet {
  state.latestOffer = undefined;
  state.offerContext = undefined;
  state.offerScopeDigest = undefined;
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    correlationId = state.options.context().correlationId;
    return buildCatalogOffer<Consumer>(state);
  } catch (error) {
    bindingFailure<Consumer>(state.input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
export function createCatalogOfferForTool<Consumer extends CatalogConsumer = CodingCatalogConsumer>(
  state: CatalogBindingState<Consumer>,
  toolRef: ToolRef,
): OfferedToolSet {
  state.latestOffer = undefined;
  state.offerContext = undefined;
  state.offerScopeDigest = undefined;
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    correlationId = state.options.context().correlationId;
    return buildCatalogOfferForTool<Consumer>(state, toolRef);
  } catch (error) {
    bindingFailure<Consumer>(state.input, error, correlationId);
    throw new TypeError("Invalid catalog handler binding", { cause: error });
  }
}
