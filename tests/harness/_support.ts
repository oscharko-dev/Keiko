// Shared deterministic test fixtures: stub clock, scripted model port, recording tool
// port, and a RunContext builder. No real timers, network, or fs (ADR-0004 test rules).

import type {
  NormalizedResponse,
  NormalizedToolCall,
  ToolDefinition,
} from "../../src/gateway/types.js";
import type { Clock } from "../../src/gateway/types.js";
import { Emitter } from "../../src/harness/emitter.js";
import { MemoryEventSink } from "../../src/harness/sinks.js";
import { newCounters, type RunContext } from "../../src/harness/context.js";
import type {
  ModelPort,
  ToolCallRequest,
  ToolCallResult,
  ToolPort,
} from "../../src/harness/ports.js";
import { resolveTaskPlan } from "../../src/harness/tasks/policy.js";
import { DEFAULT_LIMITS, type HarnessLimits, type TaskInput } from "../../src/harness/types.js";

export function stubClock(start = 0): { clock: Clock; set: (ms: number) => void } {
  let current = start;
  const pendingSleeps = new Set<() => void>();
  return {
    set: (ms: number): void => {
      current = ms;
      for (const resolve of pendingSleeps) {
        resolve();
      }
      pendingSleeps.clear();
    },
    clock: {
      now: (): number => current,
      sleep: (_ms: number, signal?: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new Error("aborted"));
            return;
          }
          const finish = (): void => {
            pendingSleeps.delete(finish);
            resolve();
          };
          pendingSleeps.add(finish);
          signal?.addEventListener(
            "abort",
            () => {
              pendingSleeps.delete(finish);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    },
  };
}

export function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    modelId: "m",
    content: "diff content",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
    ...overrides,
  };
}

export function toolCall(id: string, name = "read_file"): NormalizedToolCall {
  return { id, name, arguments: {} };
}

// A model port that returns scripted responses (one per call), or throws scripted errors.
export function scriptedModel(script: readonly (NormalizedResponse | Error)[]): {
  port: ModelPort;
  calls: () => number;
  requests: () => readonly Parameters<ModelPort["call"]>[0][];
} {
  let i = 0;
  const requests: Parameters<ModelPort["call"]>[0][] = [];
  return {
    calls: (): number => i,
    requests: (): readonly Parameters<ModelPort["call"]>[0][] => requests,
    port: {
      call: (request): Promise<NormalizedResponse> => {
        requests.push(request);
        const item = script[Math.min(i, script.length - 1)];
        i += 1;
        if (item instanceof Error) {
          return Promise.reject(item);
        }
        return Promise.resolve(item ?? response());
      },
    },
  };
}

export function recordingTool(tools: readonly ToolDefinition[] = []): {
  port: ToolPort;
  calls: () => readonly ToolCallRequest[];
} {
  const seen: ToolCallRequest[] = [];
  return {
    calls: (): readonly ToolCallRequest[] => seen,
    port: {
      execute: (request: ToolCallRequest): Promise<ToolCallResult> => {
        seen.push(request);
        return Promise.resolve({
          toolCallId: request.toolCallId,
          output: "tool output",
          durationMs: 0,
        });
      },
      listTools: (): readonly ToolDefinition[] => tools,
    },
  };
}

export interface CtxOptions {
  readonly task: TaskInput;
  readonly model: ModelPort;
  readonly tools?: ToolPort | undefined;
  readonly clock?: Clock | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: Partial<HarnessLimits> | undefined;
  readonly sink?: MemoryEventSink | undefined;
}

export function buildContext(options: CtxOptions): { ctx: RunContext; sink: MemoryEventSink } {
  const sink = options.sink ?? new MemoryEventSink();
  const clock = options.clock ?? stubClock().clock;
  const limits: HarnessLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const plan = resolveTaskPlan(options.task);
  const emitter = new Emitter([sink], clock, "run-1", "fp");
  const ctx: RunContext = {
    model: options.model,
    tools: options.tools ?? recordingTool().port,
    emitter,
    clock,
    signal: options.signal ?? new AbortController().signal,
    limits,
    modelId: "m",
    taskType: options.task.taskType,
    plan,
    startedAt: clock.now(),
    counters: newCounters(),
    messages: [...plan.messages],
    lastResponse: undefined,
    patchDiff: undefined,
    report: undefined,
    failure: undefined,
    cancelReason: undefined,
    cancelledAtState: undefined,
  };
  return { ctx, sink };
}
