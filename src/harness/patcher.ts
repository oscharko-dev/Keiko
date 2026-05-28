// Handlers for the patch-proposal, verification, and reporting states. The harness NEVER
// applies a patch: the diff is emitted as a patch:proposed event and carried on the run
// result. Nothing here touches the file system (ADR-0004 D8, dry-run by default).

import { HARNESS_CODES, toFailure } from "./errors.js";
import type { RunContext, StateStep } from "./context.js";

const encoder = new TextEncoder();

function patchByteLength(diff: string): number {
  return encoder.encode(diff).length;
}

export function handlePatchProposal(ctx: RunContext): StateStep {
  const diff = ctx.lastResponse?.content ?? "";
  const bytes = patchByteLength(diff);
  if (bytes > ctx.limits.maxPatchBytes) {
    ctx.failure = toFailure(
      HARNESS_CODES.LIMIT_PATCH_SIZE,
      `patch ${String(bytes)} bytes exceeds limit ${String(ctx.limits.maxPatchBytes)}`,
    );
    return { to: "limit-exceeded", reason: "maxPatchBytes exceeded" };
  }
  ctx.patchDiff = diff;
  ctx.emitter.emit({
    type: "patch:proposed",
    targetFile: ctx.plan.targetFile,
    patchBytes: bytes,
    diff,
  });
  return { to: "verification", reason: "patch assembled and proposed (not applied)" };
}

// Wave-1 verification is a structural check: a proposed patch must be non-empty. Real test/
// command verification arrives with the tool execution layer (issue #6).
export function handleVerification(ctx: RunContext): StateStep {
  const passed = (ctx.patchDiff ?? "").trim().length > 0;
  ctx.emitter.emit({
    type: "verification:result",
    passed,
    detail: passed ? "non-empty patch produced" : "empty patch",
  });
  if (passed) {
    return { to: "reporting", reason: "verification passed" };
  }
  ctx.counters.failureAttempts += 1;
  if (ctx.counters.failureAttempts >= ctx.limits.maxFailureAttempts) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_FAILURE_ATTEMPTS, "verification kept failing");
    return { to: "limit-exceeded", reason: "maxFailureAttempts exceeded after verification" };
  }
  return { to: "planning", reason: "verification failed; re-planning" };
}

// Records the final report on the context. The run:completed event is emitted by the loop
// once the terminal `completed` state is reached, so it is the last event in the stream.
export function handleReporting(ctx: RunContext): StateStep {
  ctx.report = ctx.lastResponse?.content ?? "no model output";
  return { to: "completed", reason: "report generated" };
}
