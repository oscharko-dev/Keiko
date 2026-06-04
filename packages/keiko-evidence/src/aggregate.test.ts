import { describe, expect, it } from "vitest";
import { aggregateUsage } from "./aggregate.js";
import type { HarnessEvent } from "@oscharko-dev/keiko-contracts";

function modelCompleted(
  seq: number,
  prompt: number,
  completion: number,
  latency: number,
): HarnessEvent {
  return {
    schemaVersion: "1",
    runId: "r1",
    fingerprint: "fp",
    seq,
    ts: 1000 + seq,
    type: "model:call:completed",
    modelId: "m1",
    finishReason: "stop",
    toolCallCount: 0,
    usage: {
      requestId: `req-${String(seq)}`,
      promptTokens: prompt,
      completionTokens: completion,
      latencyMs: latency,
    },
  };
}

function stateTransition(seq: number): HarnessEvent {
  return {
    schemaVersion: "1",
    runId: "r1",
    fingerprint: "fp",
    seq,
    ts: 1000 + seq,
    type: "state:transition",
    from: "intake",
    to: "planning",
    reason: "ok",
  };
}

describe("aggregateUsage", () => {
  it("folds the four totals over model:call:completed events only", () => {
    const events: readonly HarnessEvent[] = [
      stateTransition(0),
      modelCompleted(1, 100, 50, 200),
      modelCompleted(2, 30, 10, 80),
      stateTransition(3),
    ];
    expect(aggregateUsage(events)).toEqual({
      promptTokens: 130,
      completionTokens: 60,
      requestCount: 2,
      totalLatencyMs: 280,
    });
  });

  it("returns all-zero totals when no model calls completed", () => {
    expect(aggregateUsage([stateTransition(0)])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
      totalLatencyMs: 0,
    });
  });
});

// resolveCostClass moved to @oscharko-dev/keiko-model-gateway in issue #163 — its tests live at
// packages/keiko-model-gateway/src/capabilities.test.ts (registry behaviour) and
// packages/keiko-model-gateway/src/index.test.ts (public surface pin).
