// Handlers for the planning and context-selection states. Planning emits the task
// rationale as a reasoning:trace. Context-selection finalises the message array and
// enforces maxContextBytes before any model call (ADR-0004 D3 enforcement point).

import { HARNESS_CODES, toFailure } from "./errors.js";
import { contextBytes, type RunContext, type StateStep } from "./context.js";

export function handlePlanning(ctx: RunContext): StateStep {
  ctx.emitter.emit({
    type: "reasoning:trace",
    phase: "planning",
    rationale: ctx.plan.rationale,
  });
  return { to: "context-selection", reason: "plan constructed" };
}

export function handleContextSelection(ctx: RunContext): StateStep {
  const bytes = contextBytes(ctx.messages);
  if (bytes > ctx.limits.maxContextBytes) {
    ctx.failure = toFailure(
      HARNESS_CODES.LIMIT_CONTEXT_SIZE,
      `context ${String(bytes)} bytes exceeds limit ${String(ctx.limits.maxContextBytes)}`,
    );
    return { to: "limit-exceeded", reason: "maxContextBytes exceeded" };
  }
  return { to: "model-call", reason: "context assembled within byte budget" };
}
