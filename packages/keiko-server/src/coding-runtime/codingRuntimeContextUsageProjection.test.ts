import { describe, expect, it } from "vitest";

import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import { CodingRuntimeOrchestratorState } from "./codingRuntimeOrchestratorState.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";

const AT = "2026-09-15T06:30:00.000Z";
const DIGEST = "a".repeat(64);

function snapshot(): CodingRuntimeSnapshot {
  return {
    schemaVersion: "1",
    runId: "run-1",
    state: "running",
    revision: 1,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: AT,
    updatedAt: AT,
    taskDigest: DIGEST,
    workspaceDigest: DIGEST,
    operatorDigest: DIGEST,
    authorityDigest: DIGEST,
    bindingDigest: DIGEST,
    provenanceDigest: DIGEST,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 1,
  };
}

describe("coding runtime context usage projection", () => {
  it("omits context usage until a runtime reports it", () => {
    const state = new CodingRuntimeOrchestratorState({
      eventHub: new CodingRuntimeEventHub(),
      now: (): Date => new Date(AT),
      pendingPermission: (): undefined => undefined,
      effectiveMode: (): "governed-assist" => "governed-assist",
    });

    expect(state.publicSnapshot(snapshot())).not.toHaveProperty("contextUsage");
  });

  it("projects current context separately from cumulative run usage", () => {
    const contextUsage = {
      state: "available" as const,
      source: "provider-reported" as const,
      capacityTokens: 128_000,
      usedInputTokens: 42_000,
      reservedOutputTokens: 8_000,
      freeTokens: 78_000,
      cumulativePromptTokens: 90_000,
      updatedAt: AT,
    };
    const state = new CodingRuntimeOrchestratorState({
      eventHub: new CodingRuntimeEventHub(),
      now: (): Date => new Date(AT),
      pendingPermission: (): undefined => undefined,
      effectiveMode: (): "governed-assist" => "governed-assist",
      contextUsage: (): typeof contextUsage => contextUsage,
    });

    expect(state.publicSnapshot(snapshot()).contextUsage).toEqual(contextUsage);
  });
});
