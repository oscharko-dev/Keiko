import { describe, expect, it } from "vitest";

import { realBinaryScenarioArtifactErrors } from "../lib/coding-issue-journey-real-binary-evidence.mjs";

const SHA = "1".repeat(40);
const DIGESTS = ["a", "b", "c", "d", "e", "f"].map((value) => value.repeat(64));

function artifact() {
  return {
    schemaVersion: 1,
    evidenceKind: "keiko-code-task-real-binary-v1",
    scenarioId: "real-binary-lane",
    evidenceClass: "production-functional",
    sourceCommitSha: SHA,
    platformTarget: "macos-arm64",
    result: "passed",
    runtime: { name: "opencode-compatible", version: "1.17.17", target: "macos-arm64" },
    run: { correlationId: "real-binary-correlation", activityLogSha256: DIGESTS[0] },
    limits: {
      contextWindow: 32_768,
      outputTokens: 4_096,
      gatewayRequestCount: 2,
      gatewayCatalogBindingRequestCount: 2,
    },
    missingPayload: { unavailableReason: "payload-missing" },
    h1Search: {
      toolCallId: "h1-real-binary-search",
      hitCount: 1,
      pathDigest: DIGESTS[1],
      snippetDigest: DIGESTS[2],
      startLine: 1,
      endLine: 2,
      readTargetDerivedFromResult: true,
    },
    managedCatalog: {
      binding: {
        catalogRevision: DIGESTS[3],
        profile: { id: "opencode", version: 1 },
        projectionDigest: DIGESTS[4],
        handlerSetDigest: DIGESTS[5],
      },
      settlementCount: 3,
      proof: {
        kind: "managed-search-read",
        searchSettled: true,
        boundedReadSettled: true,
        causalHandoff: true,
      },
    },
  };
}

describe("real-binary #3390 evidence", () => {
  it("accepts only the closed body-free projection of a complete real-binary run", () => {
    expect(realBinaryScenarioArtifactErrors(artifact())).toEqual([]);
    expect(realBinaryScenarioArtifactErrors({ ...artifact(), rawActivity: "secret" })).toEqual([
      "artifact must have the closed real-binary shape",
    ]);
  });

  it.each([
    ["source identity", (value) => ({ ...value, sourceCommitSha: "main" })],
    [
      "runtime identity",
      (value) => ({ ...value, runtime: { ...value.runtime, version: "latest" } }),
    ],
    [
      "run binding",
      (value) => ({ ...value, run: { ...value.run, activityLogSha256: "/tmp/log" } }),
    ],
    ["gateway limits", (value) => ({ ...value, limits: { ...value.limits, outputTokens: 8_192 } })],
    ["missing payload", (value) => ({ ...value, missingPayload: { unavailableReason: "ready" } })],
    [
      "search handoff",
      (value) => ({
        ...value,
        h1Search: { ...value.h1Search, readTargetDerivedFromResult: false },
      }),
    ],
    ["search cardinality", (value) => ({ ...value, h1Search: { ...value.h1Search, hitCount: 2 } })],
    [
      "nested body field",
      (value) => ({ ...value, h1Search: { ...value.h1Search, rawPath: "/private/repo" } }),
    ],
    [
      "catalog settlement",
      (value) => ({ ...value, managedCatalog: { ...value.managedCatalog, settlementCount: 0 } }),
    ],
  ])("rejects a malformed %s", (_label, mutate) => {
    expect(realBinaryScenarioArtifactErrors(mutate(artifact()))).not.toEqual([]);
  });
});
