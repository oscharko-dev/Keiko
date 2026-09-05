// Production-side port adapters. GatewayModelPort wraps the ADR-0003 Gateway and
// propagates the run's AbortSignal as GatewayRequest.cancellationSignal. DryRunToolPort
// exposes no productive handlers and rejects attempts without fabricating a successful result.
//
// ADR-0175 D1/D6 assign bound/ready/offer/dispatch to server composition (#3413); this harness
// retains only its outer run counters and AbortSignal/run settlement (#3409). The CLI and server
// run engine compose their sessions with `dryRun: true` (packages/keiko-cli/src/run.ts,
// packages/keiko-server/src/run-engine.ts) and never supply `bindToolCatalog`, so `session.ts`
// structurally never binds a catalog for them (`resolveDryRun(config) === true` short-circuits
// `bindHarnessCatalog`). That composition is intentionally non-productive: dry-run stays the
// nonproductive readiness mode for those two call sites (docs/architecture/tool-catalog
// -migration inventory rows `cli-composition`/`server-composition`, owner #3409). `listTools()`
// still advertises the compiled `legacy-native@1` catalog projection for honest discovery — what
// the profile declares — while `execute()` unconditionally refuses with a closed harness error so
// no advertised tool is ever reported as available or executed.
import {
  CancelledError,
  type GatewayCallRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import { createInitialToolCatalog, gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import { HarnessCatalogError } from "./catalog-errors.js";
import { HARNESS_CODES } from "./errors.js";
import type { ModelPort, ToolCallRequest, ToolCallResult, ToolPort } from "./ports.js";

// The one implemented legacy-tool profile (packages/keiko-tool-catalog/src/legacy.ts). Computed
// once at module load: the catalog/profile are fixed local declarations, never customer input.
const LEGACY_NATIVE_PROFILE = { id: "legacy-native", version: 1 } as const;
const LEGACY_NATIVE_TOOL_DEFINITIONS: readonly ToolDefinition[] = gatewayToolDefinitions(
  createInitialToolCatalog(),
  LEGACY_NATIVE_PROFILE,
);

// The minimal Gateway surface the model port depends on. Depending on this structural
// type (not the concrete Gateway class) keeps the harness decoupled and trivially fakeable.
//
// `request` is a `GatewayCallRequest` (ADR-0173 D5): `GatewayRequest` plus an optional
// `logContext` carrying the caller's correlation id. Widening from `GatewayRequest` adds exactly
// one optional field, so a fake built against the narrower type stays assignable here.
export interface ChatModel {
  readonly chat: (request: GatewayCallRequest) => Promise<NormalizedResponse>;
  // Optional streaming surface (#152). A concrete Gateway always provides it; structural fakes
  // may omit it. GatewayModelPort.callStream forwards to it.
  readonly chatStream?: (request: GatewayCallRequest) => AsyncIterable<GatewayStreamChunk>;
}

export class GatewayModelPort implements ModelPort {
  constructor(private readonly gateway: ChatModel) {}

  async call(request: GatewayCallRequest, signal: AbortSignal): Promise<NormalizedResponse> {
    return this.gateway.chat({ ...request, cancellationSignal: signal });
  }

  // #152 — propagate the run's AbortSignal as GatewayRequest.cancellationSignal, mirroring `call`.
  // The concrete Gateway always exposes chatStream; defaultModelPortFactory only ever constructs
  // this port with a real Gateway, so the non-null assertion is sound at the production call site.
  //
  // Object spread forwards `logContext` when the caller supplied one — no change needed here for
  // the correlation id to reach the Gateway's log lines.
  callStream(request: GatewayCallRequest, signal: AbortSignal): AsyncIterable<GatewayStreamChunk> {
    const stream = this.gateway.chatStream;
    if (stream === undefined) {
      throw new TypeError("gateway does not support streaming");
    }
    return stream.call(this.gateway, { ...request, cancellationSignal: signal });
  }
}

// A recorded dry-run tool invocation. Exposed for tests and the run manifest.
export interface RecordedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export class DryRunToolPort implements ToolPort {
  execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (request.signal.aborted) {
      return Promise.reject(new CancelledError("tool execution aborted before start"));
    }
    return Promise.reject(
      new HarnessCatalogError(HARNESS_CODES.TOOL_ERROR, "Dry-run tool handler unavailable"),
    );
  }

  // Advertisement only (ADR-0175 D4: "dry-run ... backends are readiness states, never
  // productive availability"). The list is the fixed compiled legacy-native@1 projection, never
  // caller input, and execute() above refuses every one of these names unconditionally.
  listTools(): readonly ToolDefinition[] {
    return LEGACY_NATIVE_TOOL_DEFINITIONS;
  }

  calls(): readonly RecordedToolCall[] {
    return [];
  }
}
