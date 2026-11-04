import {
  GATEWAY_NATIVE_ADVERTISEMENT_CAPTURE_BYTES,
  GATEWAY_NATIVE_EXACT_CONTENT_TOOLS,
  isGatewayNativeToolAdvertisement,
  toolArgumentLimitsByToolName,
  type GatewayNativeToolAdvertisement,
  type GatewayToolAdvertisement,
  type GatewayToolCatalogAdvertisement,
  type ToolInvocationBinding,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  GENERIC_TOOL_ARGUMENT_LIMITS,
  TOOL_CATALOG_LIMITS,
  toolArgumentLimits,
  type ToolArgumentLimits,
  type ToolResultReason,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureCatalogJson,
  captureCatalogEnvelope,
  createToolInvocationNormalizer,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
  ToolCatalogError,
  type CatalogFailureReason,
  type ToolInvocationNormalizer,
  type CatalogSchemaMismatch,
} from "@oscharko-dev/keiko-tool-catalog";
import { MalformedToolCallError } from "@oscharko-dev/keiko-security/errors/gateway";
import { toolSchemaCorrectionMessage, type GatewayToolCallRepair } from "./toolSchemaCorrection.js";
import { markdownCodeRanges } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { isDeepFrozen } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import type {
  GatewayRequest,
  NormalizedResponse,
  NormalizedToolCall,
  ToolDefinition,
  UsageMetadata,
} from "./types.js";
import { logCorrelationId, resolveLogSink, type ModelGatewayLogSink } from "./observability.js";

const TOOL_CATALOG_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.tool-catalog.rejected",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "toolCatalogBridge.reject",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["projection", "response"],
    },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["assistant-text"],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["invalid"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "unknown-tool",
        "unoffered-tool",
        "ambiguous-alias",
        "invalid-arguments",
        "version-mismatch",
        "projection-mismatch",
        "unsupported-capability",
        "cursor-invalid",
        "cursor-expired",
        "cursor-replayed",
        "workspace-stale",
        "consumer-stale",
        "replay-conflict",
        "recovery-required",
      ],
    },
    canonicalToolId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 256,
    },
    contractVersion: { type: "integer", dataClass: "count", required: false },
    catalogReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "invalid-shape",
        "input-bound",
        "invalid-identity",
        "duplicate-identity",
        "invalid-schema",
        "unsupported-schema",
        "ambiguous-effects",
        "missing-bounds",
        "unsupported-dialect",
        "unrepresentable-projection",
        "incompatible-version",
        "invalid-compatibility",
        "expired-compatibility",
        "result-contract-failed",
      ],
    },
    missingRequired: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 64,
    },
    missingRequiredCount: { type: "integer", dataClass: "count", required: false },
    invalidPaths: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 64,
    },
    invalidPathCount: { type: "integer", dataClass: "count", required: false },
    unexpectedPropertyCount: { type: "integer", dataClass: "count", required: false },
    droppedPathCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-tool-catalog"],
  proofIds: ["gateway.tool-catalog.rejected.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_NATIVE_PASSTHROUGH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.tool-catalog.native-passthrough",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "toolCatalogBridge.bindCall",
  fields: {
    projectionDigest: { type: "string", dataClass: "digest", required: true, maxLength: 128 },
    toolCount: { type: "integer", dataClass: "count", required: true },
    // A native call naming a tool the request did not offer (#3897): the producer answers it.
    unofferedCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-tool-catalog"],
  proofIds: ["gateway.tool-catalog.native-passthrough.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_CALL_BOUND_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.tool-catalog.call-bound",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "toolCatalogBridge.bindCall",
  fields: {
    projectionDigest: { type: "string", dataClass: "digest", required: true, maxLength: 128 },
    toolCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-tool-catalog"],
  proofIds: ["gateway.tool-catalog.call-bound.emitted-line"],
  releaseImpact: "patch",
});

const TOOL_CATALOG_PROJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.tool-catalog.projected",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "toolCatalogBridge.prepare",
  fields: {
    projectionDigest: { type: "string", dataClass: "digest", required: true, maxLength: 128 },
    toolCount: { type: "integer", dataClass: "count", required: true },
    compatibility: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["bound", "native"],
    },
    offerRemainingMs: { type: "number", dataClass: "duration", required: true },
  },
  causal: "none",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-tool-catalog"],
  proofIds: ["gateway.tool-catalog.projected.emitted-line"],
  releaseImpact: "patch",
});

function toolCatalogEnvelope(
  log: ModelGatewayLogSink,
  level: "info" | "warn",
  errorKind?: "validation-failed",
): {
  readonly level: "info" | "warn";
  readonly correlationId?: string;
  readonly errorKind?: "validation-failed";
} {
  const correlationId = logCorrelationId(log);
  return {
    level,
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(errorKind === undefined ? {} : { errorKind }),
  };
}

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
  /** The body-free correction the model receives for this rejection; undefined when none applies. */
  correction(): string | undefined {
    return toolSchemaCorrectionMessage(this.repair);
  }
}

export type { GatewayToolCallRepair } from "./toolSchemaCorrection.js";
export interface GatewayToolCatalogBridge {
  readonly assertNativeTransport: (response: NormalizedResponse) => void;
  readonly bindCalls: (calls: readonly NormalizedToolCall[]) => readonly NormalizedToolCall[];
  readonly tools: readonly ToolDefinition[];
  readonly bind: (call: NormalizedToolCall) => NormalizedToolCall;
  /**
   * True when `alias` is offered as the governed changeset edit (#4009). Its arguments are matched
   * against and written to workspace files byte for byte, so the adapter scrubs only the configured
   * provider literals from them. Resolved through the catalog identity, never the alias spelling.
   */
  readonly isExactContentTool: (alias: string) => boolean;
}

/** The one governed tool whose arguments are workspace file content, consumed byte for byte. */
const EXACT_CONTENT_TOOL_ID = "keiko.changeset.edit";

function isExactContentTool(
  normalizer: ToolInvocationNormalizer | undefined,
  alias: string,
): boolean {
  return (
    normalizer?.binding.projection.tools.some(
      (tool) => tool.alias === alias && tool.toolRef.canonicalId === EXACT_CONTENT_TOOL_ID,
    ) === true
  );
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
const BOUND_ADVERTISEMENT_KEYS = ["kind", "catalog", "projection", "offered"];
function frozenObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null && isDeepFrozen(value) ? value : undefined;
}
/**
 * A bound advertisement whose catalog and projection are deeply frozen cannot change while the
 * provider works, so only its small offer is captured anew; the catalog keeps its identity and the
 * invocation binding reuses its earlier verification. Copying the whole catalog on every round made
 * a long Chat tool turn copy and re-verify every descriptor dozens of times (#4173).
 */
function frozenBoundAdvertisement(input: unknown): GatewayToolCatalogAdvertisement | undefined {
  if (typeof input !== "object" || input === null || dataField(input, "kind") !== "bound")
    return undefined;
  if (
    Reflect.ownKeys(input).length !== BOUND_ADVERTISEMENT_KEYS.length ||
    !BOUND_ADVERTISEMENT_KEYS.every((key) => Object.hasOwn(input, key))
  )
    return undefined;
  const catalog = frozenObject(dataField(input, "catalog"));
  const projection = frozenObject(dataField(input, "projection"));
  if (catalog === undefined || projection === undefined) return undefined;
  const offered = captureCatalogEnvelope(dataField(input, "offered"));
  return Object.freeze({
    kind: "bound",
    catalog,
    projection,
    offered,
  }) as unknown as GatewayToolCatalogAdvertisement;
}

function capturedAdvertisement(input: unknown): GatewayToolAdvertisement {
  const frozen = frozenBoundAdvertisement(input);
  if (frozen !== undefined) return frozen;
  // A native advertisement carries the runtime's whole tool set under its own byte contract; a
  // bound catalog keeps the per-call budget (#3897 review).
  const native =
    typeof input === "object" && input !== null && dataField(input, "kind") === "native";
  const value = native
    ? captureCatalogJson(input, GATEWAY_NATIVE_ADVERTISEMENT_CAPTURE_BYTES)
    : captureCatalogEnvelope(input);
  requireBridge(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "projection-mismatch",
  );
  const object = value as Readonly<Record<string, unknown>>;
  if (object.kind === "native") {
    requireBridge(isGatewayNativeToolAdvertisement(object), "projection-mismatch");
    return object;
  }
  requireBridge(
    object.kind === "bound" &&
      Object.keys(object).length === BOUND_ADVERTISEMENT_KEYS.length &&
      BOUND_ADVERTISEMENT_KEYS.every((key) => Object.hasOwn(object, key)),
    "projection-mismatch",
  );
  return object as unknown as GatewayToolCatalogAdvertisement;
}

/**
 * The native OpenCode advertisement (#3897) is transport data end to end: its definitions go to
 * the provider verbatim and every returned call is handed back by name, bounded and unexpired,
 * never bound to a Keiko handler. OpenCode executes it under the server-owned permission policy.
 */
function nativeBridge(
  advertisement: GatewayNativeToolAdvertisement,
  now: () => number,
  log: ModelGatewayLogSink,
): GatewayToolCatalogBridge {
  const tools: readonly ToolDefinition[] = Object.freeze(
    advertisement.tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    ),
  );
  const exactContent = new Set(GATEWAY_NATIVE_EXACT_CONTENT_TOOLS);
  return Object.freeze({
    tools,
    assertNativeTransport: (response: NormalizedResponse): void => {
      assertNativeTransport(response, tools, log);
    },
    bind: (call: NormalizedToolCall): NormalizedToolCall =>
      bindCall(undefined, call, now, log, advertisement),
    bindCalls: (calls: readonly NormalizedToolCall[]): readonly NormalizedToolCall[] =>
      bindCalls(undefined, calls, now, log, advertisement),
    isExactContentTool: (alias: string): boolean => exactContent.has(alias),
  });
}

/** Native extensions retain their exact pinned schemas and never become managed handlers. */
function nativeExtensionTools(normalizer: ToolInvocationNormalizer): readonly ToolDefinition[] {
  return normalizer.binding.projection.nativeExtensions.map((extension) => {
    const definition = OPENCODE_NATIVE_EXTENSION_DEFINITIONS.find(
      (entry) =>
        `${entry.alias}@${String(entry.contractVersion)}` ===
        `${extension.alias}@${String(extension.contractVersion)}`,
    );
    if (definition === undefined) throw new TypeError("Missing native extension definition");
    return Object.freeze({
      name: definition.alias,
      description: definition.description,
      parameters: definition.inputSchema,
    });
  });
}
function isCodeModeProjection(normalizer: ToolInvocationNormalizer): boolean {
  return isNativeExtensionAlias(normalizer, "execute");
}
function definitions(normalizer: ToolInvocationNormalizer, now: number): readonly ToolDefinition[] {
  const tools = normalizer.tools(now);
  requireBridge(
    tools.every((tool) => tool.inputSchema.type === "object"),
    "unsupported-capability",
  );
  return Object.freeze([
    ...(isCodeModeProjection(normalizer) ? [] : tools).map((tool) =>
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
/**
 * The argument ceilings the call is captured under: the changeset ceilings for the governed
 * changeset edit and for the native file-content tools, the generic ones for everything else. The
 * name is read without running an accessor; anything unreadable is captured (and rejected) under the
 * generic ceilings.
 */
function callArgumentLimits(
  input: NormalizedToolCall,
  normalizer: ToolInvocationNormalizer | undefined,
  native: GatewayNativeToolAdvertisement | undefined,
): ToolArgumentLimits {
  const descriptor =
    typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "name") : undefined;
  const name: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : null;
  if (typeof name !== "string") return GENERIC_TOOL_ARGUMENT_LIMITS;
  if (native !== undefined) return toolArgumentLimitsByToolName(name);
  const tool = normalizer?.binding.projection.tools.find((entry) => entry.alias === name);
  return tool === undefined
    ? GENERIC_TOOL_ARGUMENT_LIMITS
    : toolArgumentLimits(tool.toolRef.canonicalId);
}
function captureCall(
  input: NormalizedToolCall,
  normalizer: ToolInvocationNormalizer | undefined,
  native: GatewayNativeToolAdvertisement | undefined,
): NormalizedToolCall {
  const object = captureCatalogJson(
    input,
    undefined,
    callArgumentLimits(input, normalizer, native),
  ) as Readonly<Record<string, unknown>>;
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
  readonly transport?: "assistant-text";
  readonly canonicalToolId?: string;
  readonly contractVersion?: number;
  readonly catalogReason?: CatalogFailureReason;
  readonly missingRequired?: readonly string[];
  readonly missingRequiredCount?: number;
  readonly invalidPaths?: readonly string[];
  readonly invalidPathCount?: number;
  readonly unexpectedPropertyCount?: number;
  readonly droppedPathCount?: number;
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
  log.write(
    activityLogEvent(
      TOOL_CATALOG_REJECTED_OPERATION,
      toolCatalogEnvelope(log, "warn", "validation-failed"),
      { phase, status: error.status, reason: error.reason, ...details },
    ),
  );
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
/**
 * A native advertisement's call (#3897) is handed back by name only: captured, unexpired and one
 * of the advertised tools. OpenCode executes it; no Keiko handler is bound.
 */
function bindNativeCall(
  advertisement: GatewayNativeToolAdvertisement,
  call: NormalizedToolCall,
  now: () => number,
  log: ModelGatewayLogSink,
): NormalizedToolCall {
  if (Date.parse(advertisement.offered.expiresAt) <= now())
    throw new ToolCatalogError("expired-compatibility");
  // Binding is by name only and grants nothing (ADR-0175 D2): the producer owns its tools. A name
  // the request did not offer goes to it as in standalone OpenCode, which answers the model with
  // its own unavailable-tool result and continues the turn; refusing it here ended the whole turn.
  const offered = advertisement.tools.some((tool) => tool.name === call.name);
  log.write(
    activityLogEvent(TOOL_CATALOG_NATIVE_PASSTHROUGH_OPERATION, toolCatalogEnvelope(log, "info"), {
      projectionDigest: advertisement.toolSetDigest,
      toolCount: 1,
      ...(offered ? {} : { unofferedCount: 1 }),
    }),
  );
  return call;
}

function bindCall(
  normalizer: ToolInvocationNormalizer | undefined,
  input: NormalizedToolCall,
  now: () => number,
  log: ModelGatewayLogSink,
  native?: GatewayNativeToolAdvertisement,
): NormalizedToolCall {
  let captured: NormalizedToolCall | undefined;
  try {
    const call = captureCall(input, normalizer, native);
    captured = call;
    if (native !== undefined) return bindNativeCall(native, call, now, log);
    requireBridge(normalizer !== undefined, "unoffered-tool");
    if (isNativeExtensionAlias(normalizer, call.name)) {
      normalizer.tools(now());
      log.write(
        activityLogEvent(
          TOOL_CATALOG_NATIVE_PASSTHROUGH_OPERATION,
          toolCatalogEnvelope(log, "info"),
          {
            projectionDigest: normalizer.binding.projection.projectionDigest,
            toolCount: 1,
          },
        ),
      );
      return call;
    }
    requireBridge(!isCodeModeProjection(normalizer), "unoffered-tool");
    const invocation = normalizer.bindAlias(call.name, call.arguments, now());
    log.write(
      activityLogEvent(TOOL_CATALOG_CALL_BOUND_OPERATION, toolCatalogEnvelope(log, "info"), {
        projectionDigest: invocation.projectionDigest,
        toolCount: 1,
      }),
    );
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
  native?: GatewayNativeToolAdvertisement,
): readonly NormalizedToolCall[] {
  let entries: readonly NormalizedToolCall[];
  try {
    requireGenuineCallArray(calls);
    entries = calls.map((call) => captureCall(call, normalizer, native));
    requireBridge(
      new Set(entries.map((call) => call.id)).size === entries.length,
      "invalid-arguments",
    );
  } catch (cause) {
    return reject(log, "response", cause);
  }
  return Object.freeze(entries.map((call) => bindCall(normalizer, call, now, log, native)));
}

// Reserved model transport markers outside Markdown code are a failed tool invocation, never
// executable prose. Only aliases from this captured, validated offer can request a correction.
const TEXT_TOOL_CALL =
  /(?:<channel>\s*<tool_call>|<\|tool_call>)\s*(?:call:)?([A-Za-z]\w{0,127})\s*\{/gu;

function textInvocationAlias(
  content: string,
  tools: readonly ToolDefinition[],
): string | undefined {
  const code = markdownCodeRanges(content);
  const aliases = new Set(tools.map((tool) => tool.name));
  let range = 0;
  for (const match of content.matchAll(TEXT_TOOL_CALL)) {
    while ((code[range]?.end ?? Number.POSITIVE_INFINITY) <= match.index) range += 1;
    if ((code[range]?.start ?? Number.POSITIVE_INFINITY) <= match.index) continue;
    const alias = match[1];
    if (alias !== undefined && aliases.has(alias)) return alias;
  }
  return undefined;
}

function assertNativeTransport(
  response: NormalizedResponse,
  tools: readonly ToolDefinition[],
  log: ModelGatewayLogSink,
): void {
  if (tools.length === 0 || response.toolCalls.length > 0) return;
  const offeredAlias = textInvocationAlias(response.content, tools);
  if (offeredAlias === undefined) return;
  const repair = Object.freeze({
    toolCallId: "assistant-text-call",
    offeredAlias,
    transport: "assistant-text" as const,
  });
  reject(
    log,
    "response",
    new GatewayToolCatalogError("invalid-arguments", undefined, true, repair),
    {
      catalogReason: "invalid-shape",
      transport: "assistant-text",
    },
  );
}

function bridge(
  normalizer: ToolInvocationNormalizer | undefined,
  tools: readonly ToolDefinition[],
  now: () => number,
  log: ModelGatewayLogSink,
): GatewayToolCatalogBridge {
  return Object.freeze({
    tools,
    assertNativeTransport: (response: NormalizedResponse): void => {
      assertNativeTransport(response, tools, log);
    },
    bind: (call: NormalizedToolCall): NormalizedToolCall => bindCall(normalizer, call, now, log),
    bindCalls: (calls: readonly NormalizedToolCall[]): readonly NormalizedToolCall[] =>
      bindCalls(normalizer, calls, now, log),
    isExactContentTool: (alias: string): boolean => isExactContentTool(normalizer, alias),
  });
}

function prepare(
  request: GatewayRequest,
  now: () => number,
  log: ModelGatewayLogSink,
  recordProjection: boolean,
): GatewayToolCatalogBridge {
  const input = dataField(request, "toolCatalog");
  const oldTools = dataField(request, "tools");
  if (input === undefined) {
    requireBridge(oldTools === undefined, "projection-mismatch");
    return bridge(undefined, Object.freeze([]), now, log);
  }
  const advertisement = capturedAdvertisement(input);
  requireBridge(oldTools === undefined, "projection-mismatch");
  if (advertisement.kind === "native") {
    if (recordProjection)
      log.write(
        activityLogEvent(TOOL_CATALOG_PROJECTED_OPERATION, toolCatalogEnvelope(log, "info"), {
          projectionDigest: advertisement.toolSetDigest,
          toolCount: advertisement.tools.length,
          compatibility: advertisement.kind,
          offerRemainingMs: Math.max(0, Date.parse(advertisement.offered.expiresAt) - now()),
        }),
      );
    return nativeBridge(advertisement, now, log);
  }
  const normalizer = normalizerFor(advertisement);
  const tools = definitions(normalizer, now());
  if (recordProjection)
    log.write(
      activityLogEvent(TOOL_CATALOG_PROJECTED_OPERATION, toolCatalogEnvelope(log, "info"), {
        projectionDigest: normalizer.binding.projection.projectionDigest,
        toolCount: tools.length,
        compatibility: advertisement.kind,
        // How long the advertised offer stays bindable from this point. Read next to the fetch's own
        // `durationMs` it reconstructs an `expired-compatibility` rejection from the log alone: a
        // response that took longer than this window was bound against an offer that had run out.
        offerRemainingMs: Math.max(0, Date.parse(advertisement.offered.expiresAt) - now()),
      }),
    );
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
  recordProjection = true,
): GatewayToolCatalogBridge {
  const log = resolveLogSink(sink);
  try {
    return prepare(request, now, log, recordProjection);
  } catch (cause) {
    return reject(log, "projection", cause);
  }
}
