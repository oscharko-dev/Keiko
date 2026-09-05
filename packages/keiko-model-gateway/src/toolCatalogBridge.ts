import type {
  GatewayToolCatalogAdvertisement,
  ToolInvocationBinding,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { ToolResultReason } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureCatalogJson,
  createToolInvocationNormalizer,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
  type ToolInvocationNormalizer,
} from "@oscharko-dev/keiko-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { MalformedToolCallError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayRequest, NormalizedToolCall, ToolDefinition } from "./types.js";
import { resolveLogSink, type ModelGatewayLogSink } from "./observability.js";

export class GatewayToolCatalogError extends MalformedToolCallError {
  readonly status = "invalid";
  constructor(
    readonly reason: ToolResultReason<"invalid">,
    cause?: unknown,
  ) {
    super(`catalog tool request ${reason}`);
    if (cause !== undefined) this.cause = cause;
  }
}
export interface GatewayToolCatalogBridge {
  readonly bindCalls: (calls: readonly NormalizedToolCall[]) => readonly NormalizedToolCall[];
  readonly tools: readonly ToolDefinition[];
  readonly bind: (call: NormalizedToolCall) => NormalizedToolCall;
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
  const legacy = object.kind === "legacy-native";
  const keys = ["kind", "catalog", "projection", "offered", ...(legacy ? ["legacySession"] : [])];
  requireBridge(
    (legacy || object.kind === "bound") &&
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
  return createToolInvocationNormalizer(binding, advertisement.legacySession);
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
function reject(log: ModelGatewayLogSink, phase: "projection" | "response", cause: unknown): never {
  const reason = phase === "projection" ? "projection-mismatch" : "invalid-arguments";
  const error =
    cause instanceof GatewayToolCatalogError ? cause : new GatewayToolCatalogError(reason, cause);
  log.write({
    level: "warn",
    category: "gateway",
    op: "gateway.tool-catalog.rejected",
    errorKind: "validation",
    extra: { phase, status: error.status, reason: error.reason },
  });
  throw error;
}
function bindCall(
  normalizer: ToolInvocationNormalizer | undefined,
  input: NormalizedToolCall,
  now: () => number,
  log: ModelGatewayLogSink,
): NormalizedToolCall {
  try {
    const call = captureCall(input);
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
    return reject(log, "response", cause);
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
    const captured = captureCatalogJson(calls);
    requireBridge(Array.isArray(captured), "invalid-arguments");
    entries = (captured as readonly NormalizedToolCall[]).map(captureCall);
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
    requireBridge(
      oldTools === undefined || canonicalise(captureCatalogJson(oldTools)) === "[]",
      "projection-mismatch",
    );
    return bridge(undefined, Object.freeze([]), now, log);
  }
  const advertisement = capturedAdvertisement(input);
  const normalizer = normalizerFor(advertisement);
  const tools = definitions(normalizer, now());
  if (oldTools !== undefined)
    requireBridge(
      advertisement.kind === "legacy-native" &&
        canonicalise(captureCatalogJson(oldTools)) === canonicalise(tools),
      "projection-mismatch",
    );
  log.write({
    level: "info",
    category: "gateway",
    op: "gateway.tool-catalog.projected",
    extra: {
      projectionDigest: normalizer.binding.projection.projectionDigest,
      toolCount: tools.length,
      compatibility: advertisement.kind,
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
