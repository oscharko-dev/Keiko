import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createCodingRuntimeContextUsageRegistry } from "./codingRuntimeContextUsage.js";
import { observeGatewayPromptTokens } from "./codingRuntimeContextUsageObservation.js";

const CONVERSATION = { agentKey: "agent", headKey: "head", toolBearing: true } as const;

function observed(): { events: ServerLogEvent[]; log: { write: (event: ServerLogEvent) => void } } {
  const events: ServerLogEvent[] = [];
  return { events, log: { write: (event): void => void events.push(event) } };
}

describe("gateway prompt observation", () => {
  it("records an accepted and a rejected sample as body-free lines, and nothing without a geometry", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    const { events, log } = observed();
    observeGatewayPromptTokens(registry, "run-context-1", CONVERSATION, 7_303, 1, log);
    expect(events).toEqual([]);

    registry.bindGeometry("run-context-1", {
      capacityTokens: 272_000,
      reservedOutputTokens: 32_768,
    });
    observeGatewayPromptTokens(registry, "run-context-1", CONVERSATION, 7_303, 1, log);
    observeGatewayPromptTokens(registry, "run-context-1", CONVERSATION, 7_303, 1, log);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      op: "coding-runtime.context-usage.observed",
      correlationId: "run-context-1",
      level: "info",
      extra: {
        state: "accepted",
        capacityTokens: 272_000,
        usedInputTokens: 7_303,
        reservedOutputTokens: 32_768,
        sampleDigest: createHash("sha256").update("gateway-call:1").digest("hex"),
      },
    });
    expect(events[1]).toMatchObject({
      level: "warn",
      errorKind: "conflict",
      extra: { state: "rejected" },
    });
    expect(registry.read("run-context-1")?.usedInputTokens).toBe(7_303);
    expect(
      expectActivityLogProof(
        "coding-runtime.context-usage.observed.emitted-line",
        formatActivityLogProofLine(events[0] ?? {}),
      ),
    ).toMatchObject({ correlationId: "run-context-1", state: "accepted", usedInputTokens: 7_303 });
    expect(
      expectActivityLogProof(
        "coding-runtime.context-usage.observed.emitted-line",
        formatActivityLogProofLine(events[1] ?? {}),
      ),
    ).toMatchObject({ correlationId: "run-context-1", state: "rejected" });
  });
});
