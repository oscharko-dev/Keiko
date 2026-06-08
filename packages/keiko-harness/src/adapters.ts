// Production-side port adapters. GatewayModelPort wraps the ADR-0003 Gateway and
// propagates the run's AbortSignal as GatewayRequest.cancellationSignal. DryRunToolPort
// records tool calls without executing them — the Wave-1 no-op executor that keeps the
// CLI dry-run path free of any side effect (real executors land in issue #6).

import {
  CancelledError,
  type GatewayRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort, ToolCallRequest, ToolCallResult, ToolPort } from "./ports.js";

// The minimal Gateway surface the model port depends on. Depending on this structural
// type (not the concrete Gateway class) keeps the harness decoupled and trivially fakeable.
export interface ChatModel {
  readonly chat: (request: GatewayRequest) => Promise<NormalizedResponse>;
  // Optional streaming surface (#152). A concrete Gateway always provides it; structural fakes
  // may omit it. GatewayModelPort.callStream forwards to it.
  readonly chatStream?: (request: GatewayRequest) => AsyncIterable<GatewayStreamChunk>;
}

export class GatewayModelPort implements ModelPort {
  constructor(private readonly gateway: ChatModel) {}

  async call(request: GatewayRequest, signal: AbortSignal): Promise<NormalizedResponse> {
    return this.gateway.chat({ ...request, cancellationSignal: signal });
  }

  // #152 — propagate the run's AbortSignal as GatewayRequest.cancellationSignal, mirroring `call`.
  // The concrete Gateway always exposes chatStream; defaultModelPortFactory only ever constructs
  // this port with a real Gateway, so the non-null assertion is sound at the production call site.
  callStream(request: GatewayRequest, signal: AbortSignal): AsyncIterable<GatewayStreamChunk> {
    const stream = this.gateway.chatStream;
    if (stream === undefined) {
      throw new Error("gateway does not support streaming");
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
  private readonly recorded: RecordedToolCall[] = [];

  constructor(private readonly tools: readonly ToolDefinition[] = []) {}

  execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (request.signal.aborted) {
      return Promise.reject(new CancelledError("tool execution aborted before start"));
    }
    this.recorded.push({
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      arguments: request.arguments,
    });
    return Promise.resolve({ toolCallId: request.toolCallId, output: "", durationMs: 0 });
  }

  listTools(): readonly ToolDefinition[] {
    return this.tools;
  }

  calls(): readonly RecordedToolCall[] {
    return this.recorded;
  }
}
