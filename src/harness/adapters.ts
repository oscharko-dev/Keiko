// Production-side port adapters. GatewayModelPort wraps the ADR-0003 Gateway and
// propagates the run's AbortSignal as GatewayRequest.cancellationSignal. DryRunToolPort
// records tool calls without executing them — the Wave-1 no-op executor that keeps the
// CLI dry-run path free of any side effect (real executors land in issue #6).

import { CancelledError } from "../gateway/errors.js";
import type { GatewayRequest, NormalizedResponse, ToolDefinition } from "../gateway/types.js";
import type { ModelPort, ToolCallRequest, ToolCallResult, ToolPort } from "./ports.js";

// The minimal Gateway surface the model port depends on. Depending on this structural
// type (not the concrete Gateway class) keeps the harness decoupled and trivially fakeable.
export interface ChatModel {
  readonly chat: (request: GatewayRequest) => Promise<NormalizedResponse>;
}

export class GatewayModelPort implements ModelPort {
  constructor(private readonly gateway: ChatModel) {}

  async call(request: GatewayRequest, signal: AbortSignal): Promise<NormalizedResponse> {
    return this.gateway.chat({ ...request, cancellationSignal: signal });
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
