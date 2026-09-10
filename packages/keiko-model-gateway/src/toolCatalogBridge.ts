import type {
  GatewayToolCatalogAdvertisement,
  ToolInvocationBinding,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  TOOL_CATALOG_LIMITS,
  type ToolResultReason,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureCatalogJson,
  createToolInvocationNormalizer,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
  ToolCatalogError,
  type ToolInvocationNormalizer,
  type CatalogSchemaMismatch,
} from "@oscharko-dev/keiko-tool-catalog";
import { MalformedToolCallError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayRequest, NormalizedToolCall, ToolDefinition, UsageMetadata } from "./types.js";
import { resolveLogSink, type ModelGatewayLogSink } from "./observability.js";

export class GatewayToolCatalogError extends MalformedToolCallError {
  readonly status = "invalid";
  override readonly retryable: boolean;
  constructor(
    readonly reason: ToolResultReason<"invalid">,
    cause?: unknown,
    retryable = false,
    readonly repair?: GatewayToolCallRepair | undefined,
  ) {
    super(`catalog tool request ${reason}`);
    this.retryable = retryable;
    if (cause !== undefined) this.cause = cause;
  }
}
/**
 * Body-free provider-call identity retained only for a bounded schema-correction retry, plus the
 * schema's own account of the mismatch (declared property names and counts, never the arguments) so
 * the correction can name what to fix.
 */
export interface GatewayToolCallRepair {
  readonly toolCallId: string;
  readonly offeredAlias: string;
  readonly shape?: CatalogSchemaMismatch | undefined;
}
export interface GatewayToolCatalogBridge {
  readonly bindCalls: (calls: readonly NormalizedToolCall[]) => readonly NormalizedToolCall[];
  readonly tools: readonly ToolDefinition[];
  readonly bind: (call: NormalizedToolCall) => NormalizedToolCall;
}

/** Retains counts the provider reported before its semantically invalid tool call was rejected. */
export function retainMeasuredCatalogFailureUsage(error: unknown, usage: UsageMetadata): void {
  if (!(error instanceof GatewayToolCatalogError) || error.partialUsage !== undefined) return;
  error.partialUsage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    streamedChars: 0,
  };
}
function requireBridge(value: boolean, reason: ToolResultReason<"invalid">): asserts value {
  if (!value) throw new GatewayToolCatalogError(reason);
}
function dataField(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  requireBridge("value" in descriptor && descriptor.enumerable === true, "projection-mismatch");
  return descriptor.value as unknown;
}
function capturedAdvertisement(input: unknown): GatewayToolCatalogAdvertisement {
  const value = captureCatalogJson(input);
  requireBridge(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "projection-mismatch",
  );
  const object = value as Readonly<Record<string, unknown>>;
  const keys = ["kind", "catalog", "projection", "offered"];
  requireBridge(
    object.kind === "bound" &&
      Object.keys(object).length === keys.length &&
      keys.every((key) => Object.hasOwn(object, key)),
    "projection-mismatch",
  );
  return object as unknown as GatewayToolCatalogAdvertisement;
}
/**
 * Native extensions (`question`, `todowrite`) are never Keiko tool descriptors (ADR-0175 D2) and
 * carry no schema on the compiled projection -- their pinned wire schema is the single source
 * `@oscharko-dev/keiko-tool-catalog`'s `OPENCODE_NATIVE_EXTENSION_DEFINITIONS`. A projection may
 * only ever declare the closed `"question" | "todowrite"` alias set (contracts-enforced), so a
 * missing definition here is an impossible-by-contract drift, not a request-shaped error.
 */
function nativeExtensionDefinition(
  alias: "question" | "todowrite",
): (typeof OPENCODE_NATIVE_EXTENSION_DEFINITIONS)[number] {
  const definition = OPENCODE_NATIVE_EXTENSION_DEFINITIONS.find((entry) => entry.alias === alias);
  if (definition === undefined)
    throw new TypeError(`Missing native extension definition: ${alias}`);
  return definition;
}
function nativeExtensionTools(normalizer: ToolInvocationNormalizer): readonly ToolDefinition[] {
  return normalizer.binding.projection.nativeExtensions.map((extension) => {
    const definition = nativeExtensionDefinition(extension.alias);
    return Object.freeze({
      name: definition.alias,
      description: definition.description,
      parameters: definition.inputSchema,
    });
  });
}
function definitions(normalizer: ToolInvocationNormalizer, now: number): readonly ToolDefinition[] {
  const tools = normalizer.tools(now);
  requireBridge(
    tools.every((tool) => tool.inputSchema.type === "object"),
    "unsupported-capability",
  );
  return Object.freeze([
    ...tools.map((tool) =>
      Object.freeze({
        name: tool.alias,
        description: tool.description,
        parameters: tool.inputSchema,
      }),
    ),
    ...nativeExtensionTools(normalizer),
  ]);
}
/** A native extension is transport data (ADR-0175 D2): no binder invocation, no handler call. */
function isNativeExtensionAlias(normalizer: ToolInvocationNormalizer, alias: string): boolean {
  return normalizer.binding.projection.nativeExtensions.some(
    (extension) => extension.alias === alias,
  );
}

function normalizerFor(advertisement: GatewayToolCatalogAdvertisement): ToolInvocationNormalizer {
  const binding: ToolInvocationBinding = {
    catalog: advertisement.catalog,
    projection: advertisement.projection,
    offered: advertisement.offered,
  };
  return createToolInvocationNormalizer(binding);
}
function captureCall(input: NormalizedToolCall): NormalizedToolCall {
  const object = captureCatalogJson(input) as Readonly<Record<string, unknown>>;
  requireBridge(
    Object.keys(object).length === 3 &&
      ["id", "name", "arguments"].every((key) => Object.hasOwn(object, key)),
    "invalid-arguments",
  );
  requireBridge(
    typeof object.id === "string" &&
      /^[A-Za-z0-9_.:-]{1,128}$/u.test(object.id) &&
      typeof object.name === "string",
    "invalid-arguments",
  );
  return object as unknown as NormalizedToolCall;
}
interface CatalogRejectionDetails {
  readonly canonicalToolId?: string | undefined;
  readonly contractVersion?: number | undefined;
  readonly catalogReason?: string | undefined;
  readonly missingRequired?: readonly string[] | undefined;
  readonly missingRequiredCount?: number | undefined;
  readonly invalidPaths?: readonly string[] | undefined;
  readonly invalidPathCount?: number | undefined;
  readonly unexpectedPropertyCount?: number | undefined;
  readonly droppedPathCount?: number | undefined;
}

// The schema's account of an `invalid-shape` rejection, in the schema's vocabulary only: declared
// property paths and counts. Run 7 (2026-09-10): three identical rejections of one call exhausted
// the retry budget while the line said `invalid-shape` and nothing else.
function shapeDetails(shape: CatalogSchemaMismatch | undefined): CatalogRejectionDetails {
  if (shape === undefined) return {};
  return {
    missingRequired: shape.missingRequired,
    missingRequiredCount: shape.missingRequired.length,
    invalidPaths: shape.invalidPaths,
    invalidPathCount: shape.invalidPaths.length,
    unexpectedPropertyCount: shape.unexpectedPropertyCount,
    droppedPathCount: shape.droppedPathCount,
  };
}

function retryableResponseRejection(phase: "projection" | "response", cause: unknown): boolean {
  return (
    phase === "response" &&
    cause instanceof ToolCatalogError &&
    (cause.reason === "invalid-shape" || cause.reason === "invalid-identity")
  );
}

function reject(
  log: ModelGatewayLogSink,
  phase: "projection" | "response",
  cause: unknown,
  details: CatalogRejectionDetails = {},
  repair?: GatewayToolCallRepair,
): never {
  const reason = phase === "projection" ? "projection-mismatch" : "invalid-arguments";
  const error =
    cause instanceof GatewayToolCatalogError
      ? cause
      : new GatewayToolCatalogError(
          reason,
          cause,
          retryableResponseRejection(phase, cause),
          repair,
        );
  log.write({
    level: "warn",
    category: "gateway",
    op: "gateway.tool-catalog.rejected",
    errorKind: "validation",
    extra: { phase, status: error.status, reason: error.reason, ...details },
  });
  throw error;
}

function schemaRepair(
  normalizer: ToolInvocationNormalizer | undefined,
  call: NormalizedToolCall,
  cause: unknown,
): GatewayToolCallRepair | undefined {
  if (!(cause instanceof ToolCatalogError) || cause.reason !== "invalid-shape") return undefined;
  const projected = normalizer?.binding.projection.tools.find((tool) => tool.alias === call.name);
  if (projected === undefined) return undefined;
  return Object.freeze({
    toolCallId: call.id,
    offeredAlias: projected.alias,
    ...(cause.shape === undefined ? {} : { shape: cause.shape }),
  });
}

function rejectionDetails(
  normalizer: ToolInvocationNormalizer | undefined,
  call: NormalizedToolCall,
  cause: unknown,
): CatalogRejectionDetails {
  const projected = normalizer?.binding.projection.tools.find((tool) => tool.alias === call.name);
  return {
    ...(projected === undefined
      ? {}
      : {
          canonicalToolId: projected.toolRef.canonicalId,
          contractVersion: projected.toolRef.contractVersion,
        }),
    ...(cause instanceof ToolCatalogError
      ? { catalogReason: cause.reason, ...shapeDetails(cause.shape) }
      : {}),
  };
}
function bindCall(
  normalizer: ToolInvocationNormalizer | undefined,
  input: NormalizedToolCall,
  now: () => number,
  log: ModelGatewayLogSink,
): NormalizedToolCall {
  let captured: NormalizedToolCall | undefined;
  try {
    const call = captureCall(input);
    captured = call;
    requireBridge(normalizer !== undefined, "unoffered-tool");
    if (isNativeExtensionAlias(normalizer, call.name)) {
      log.write({
        level: "info",
        category: "gateway",
        op: "gateway.tool-catalog.native-passthrough",
        extra: {
          projectionDigest: normalizer.binding.projection.projectionDigest,
          toolCount: 1,
        },
      });
      return call;
    }
    const invocation = normalizer.bindAlias(call.name, call.arguments, now());
    log.write({
      level: "info",
      category: "gateway",
      op: "gateway.tool-catalog.call-bound",
      extra: { projectionDigest: invocation.projectionDigest, toolCount: 1 },
    });
    return Object.freeze({
      ...call,
      arguments: invocation.arguments as Record<string, unknown>,
      invocation,
    });
  } catch (cause) {
    return reject(
      log,
      "response",
      cause,
      rejectionDetails(normalizer, input, cause),
      captured === undefined ? undefined : schemaRepair(normalizer, captured, cause),
    );
  }
}
// `captureCatalogJson`'s budget is a single accumulator shared across everything it copies --
// right-sized for one call's arguments, wrong for a batch: `TOOL_CATALOG_LIMITS.maxResultBytes`
// equals `maxArgumentBytes`, so passing the whole array through it with that budget would reject
// up to `maxArrayItems` legitimate calls (e.g. 50 parallel tool calls) the moment their COMBINED
// size passes one call's ceiling, even though every one of them is individually well under it --
// reusing that helper here would resurrect the exact shared-budget bug the batch bounds test below
// ("binds a batch whose combined size exceeds one call's byte budget...") pins as fixed. The array
// only needs to be proven genuine and bounded in length here -- mirrors `copyArray`'s own shape
// checks (dense, correctly-prototyped, no smuggled own keys, no sparse holes or accessor-backed
// indices) without sharing a byte budget across siblings; `captureCall` below still re-validates
// (and re-bounds) every entry individually.
//
// The denseness check MUST be an explicit index loop, not `Array.prototype.every`/`map`: both
// SKIP an index that doesn't exist as an own property (a hole) instead of visiting and rejecting
// it. A hole paired with one smuggled extra own key (e.g. `calls.length = 2; calls.extra = "x"`)
// keeps `Reflect.ownKeys(calls).length === calls.length + 1` true by coincidence, so only this
// per-index walk still catches it.
function requireGenuineCallArray(calls: readonly NormalizedToolCall[]): void {
  requireBridge(
    Array.isArray(calls) &&
      Object.getPrototypeOf(calls) === Array.prototype &&
      Reflect.ownKeys(calls).length === calls.length + 1 &&
      calls.length <= TOOL_CATALOG_LIMITS.maxArrayItems,
    "invalid-arguments",
  );
  for (let index = 0; index < calls.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(calls, String(index));
    requireBridge(
      descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true,
      "invalid-arguments",
    );
  }
}
function bindCalls(
  normalizer: ToolInvocationNormalizer | undefined,
  calls: readonly NormalizedToolCall[],
  now: () => number,
  log: ModelGatewayLogSink,
): readonly NormalizedToolCall[] {
  let entries: readonly NormalizedToolCall[];
  try {
    requireGenuineCallArray(calls);
    entries = calls.map(captureCall);
    requireBridge(
      new Set(entries.map((call) => call.id)).size === entries.length,
      "invalid-arguments",
    );
  } catch (cause) {
    return reject(log, "response", cause);
  }
  return Object.freeze(entries.map((call) => bindCall(normalizer, call, now, log)));
}

function bridge(
  normalizer: ToolInvocationNormalizer | undefined,
  tools: readonly ToolDefinition[],
  now: () => number,
  log: ModelGatewayLogSink,
): GatewayToolCatalogBridge {
  return Object.freeze({
    tools,
    bind: (call: NormalizedToolCall): NormalizedToolCall => bindCall(normalizer, call, now, log),
    bindCalls: (calls: readonly NormalizedToolCall[]): readonly NormalizedToolCall[] =>
      bindCalls(normalizer, calls, now, log),
  });
}

function prepare(
  request: GatewayRequest,
  now: () => number,
  log: ModelGatewayLogSink,
): GatewayToolCatalogBridge {
  const input = dataField(request, "toolCatalog");
  const oldTools = dataField(request, "tools");
  if (input === undefined) {
    requireBridge(oldTools === undefined, "projection-mismatch");
    return bridge(undefined, Object.freeze([]), now, log);
  }
  const advertisement = capturedAdvertisement(input);
  const normalizer = normalizerFor(advertisement);
  const tools = definitions(normalizer, now());
  requireBridge(oldTools === undefined, "projection-mismatch");
  log.write({
    level: "info",
    category: "gateway",
    op: "gateway.tool-catalog.projected",
    extra: {
      projectionDigest: normalizer.binding.projection.projectionDigest,
      toolCount: tools.length,
      compatibility: advertisement.kind,
      // How long the advertised offer stays bindable from this point. Read next to the fetch's own
      // `durationMs` it reconstructs an `expired-compatibility` rejection from the log alone: a
      // response that took longer than this window was bound against an offer that had run out.
      offerRemainingMs: Date.parse(advertisement.offered.expiresAt) - now(),
    },
  });
  return bridge(normalizer, tools, now, log);
}
/**
 * Runs before transport; captures the exact advertisement used again after asynchronous provider
 * work. Streaming and buffered calls bind identically -- the streaming adapter accumulates tool
 * calls from SSE deltas and binds them at the terminal `done` chunk via the same `bindCalls`.
 */
export function createGatewayToolCatalogBridge(
  request: GatewayRequest,
  now: () => number,
  sink?: ModelGatewayLogSink,
): GatewayToolCatalogBridge {
  const log = resolveLogSink(sink);
  try {
    return prepare(request, now, log);
  } catch (cause) {
    return reject(log, "projection", cause);
  }
}
