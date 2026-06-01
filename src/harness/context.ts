// Mutable run state shared across the state handlers. Created once per run by the loop;
// handlers read ports/limits/clock and mutate counters, the message accumulator, and the
// terminal-outcome carriers (patchDiff, report, failure). Keeping this in one place lets
// each handler file stay small and free of cross-handler imports.

import type { ChatMessage } from "../gateway/types.js";
import type { Clock } from "../gateway/types.js";
import { Emitter } from "./emitter.js";
import type { NormalizedResponse } from "../gateway/types.js";
import type { ModelPort, ToolPort } from "./ports.js";
import type { TaskPlan } from "./tasks/policy.js";
import type {
  HarnessFailure,
  HarnessLimits,
  HarnessStateName,
  RunCounters,
  TaskType,
} from "./types.js";

export interface RunContext {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly emitter: Emitter;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly limits: HarnessLimits;
  readonly modelId: string;
  readonly taskType: TaskType;
  readonly plan: TaskPlan;
  readonly startedAt: number;
  readonly counters: RunCounters;
  // Accumulating conversation passed to the model on each call.
  messages: ChatMessage[];
  // The most recent model response; the tool-call handler reads its toolCalls.
  lastResponse: NormalizedResponse | undefined;
  // Terminal-outcome carriers, filled as the run progresses.
  patchDiff: string | undefined;
  report: string | undefined;
  failure: HarnessFailure | undefined;
  cancelReason: string | undefined;
  cancelledAtState: HarnessStateName | undefined;
}

// The result of a single state handler: the next state and the human-readable reason
// recorded on the state:transition event.
export interface StateStep {
  readonly to: HarnessStateName;
  readonly reason: string;
}

export function newCounters(): RunCounters {
  return {
    iterations: 0,
    modelCalls: 0,
    toolCalls: 0,
    commandExecutions: 0,
    failureAttempts: 0,
    browserNavigations: 0,
  };
}

// UTF-8 byte length of the serialised message array — the zero-dependency context-size
// proxy (ADR-0004 D3). Tokens require a model-specific tokeniser; bytes do not.
const encoder = new TextEncoder();

export function contextBytes(messages: readonly ChatMessage[]): number {
  return encoder.encode(JSON.stringify(messages)).length;
}
