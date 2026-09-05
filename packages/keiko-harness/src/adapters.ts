// Production-side port adapters. GatewayModelPort wraps the ADR-0003 Gateway and
// propagates the run's AbortSignal as GatewayRequest.cancellationSignal. DryRunToolPort
// exposes no productive handlers and rejects attempts without fabricating a successful result.

import {
  CancelledError,
  type GatewayCallRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import { HarnessCatalogError } from "./catalog-errors.js";
import { HARNESS_CODES } from "./errors.js";
import type { ModelPort, ToolCallRequest, ToolCallResult, ToolPort } from "./ports.js";

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
  // Retain only the finite constructor transport during issue3409 migration. Definitions cannot
  // make this unavailable executor productive.
  constructor(legacyDefinitions: readonly ToolDefinition[] = []) {
    void legacyDefinitions;
  }

  execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (request.signal.aborted) {
      return Promise.reject(new CancelledError("tool execution aborted before start"));
    }
    return Promise.reject(
      new HarnessCatalogError(HARNESS_CODES.TOOL_ERROR, "Dry-run tool handler unavailable"),
    );
  }

  listTools(): readonly ToolDefinition[] {
    return [];
  }

  calls(): readonly RecordedToolCall[] {
    return [];
  }
}
