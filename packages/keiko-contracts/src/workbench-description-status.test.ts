import { describe, expect, it } from "vitest";
import {
  isWorkbenchDescriptionStatus,
  WORKBENCH_DESCRIPTION_REASON_STATES,
  type WorkbenchDescriptionStatus,
} from "./workbench-description-status.js";

const digest = "a".repeat(64);
const sha = "1".repeat(40);

function valid(overrides: Partial<WorkbenchDescriptionStatus> = {}): WorkbenchDescriptionStatus {
  return {
    schemaVersion: "1",
    runId: "run-1",
    remoteDigest: digest,
    baseSha: sha,
    headSha: sha,
    generationVersion: 1,
    state: "current",
    reason: "generated",
    snapshotDigest: "b".repeat(64),
    draftDigest: "c".repeat(64),
    artifactOutcome: "complete",
    observedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function missingObservedAt(): Record<string, unknown> {
  const status: Record<string, unknown> = { ...valid() };
  delete status.observedAt;
  return status;
}

describe("isWorkbenchDescriptionStatus", () => {
  it("accepts a well-formed status for every closed reason and its paired state", () => {
    for (const [reason, state] of Object.entries(WORKBENCH_DESCRIPTION_REASON_STATES)) {
      const artifactBearing = state === "current" || state === "partial" || state === "fallback";
      expect(
        isWorkbenchDescriptionStatus(
          valid({
            reason: reason as WorkbenchDescriptionStatus["reason"],
            state,
            snapshotDigest: artifactBearing ? "b".repeat(64) : null,
            draftDigest: artifactBearing ? "c".repeat(64) : null,
            artifactOutcome: artifactBearing ? "complete" : null,
          }),
        ),
      ).toBe(true);
    }
  });

  it.each([
    ["not an object", "hostile"],
    ["null", null],
    ["an array", []],
    ["missing a key", missingObservedAt()],
    ["carrying an extra key", { ...valid(), extra: "value" }],
    ["wrong schema version", valid({ schemaVersion: "2" as never })],
    ["an empty run id", valid({ runId: "" })],
    ["a run id with a path separator", valid({ runId: "run/1" })],
    ["a short remote digest", valid({ remoteDigest: "a".repeat(63) })],
    ["a non-hex remote digest", valid({ remoteDigest: "g".repeat(64) })],
    ["a base sha of the wrong length", valid({ baseSha: "1".repeat(39) })],
    ["a non-integer generation version", valid({ generationVersion: 1.5 })],
    ["a zero generation version", valid({ generationVersion: 0 })],
    ["an unknown reason", valid({ reason: "unknown-reason" as never })],
    ["a state that does not match its reason", valid({ reason: "generated", state: "blocked" })],
    [
      "an artifact outcome without a draft digest",
      valid({ artifactOutcome: "complete", draftDigest: null }),
    ],
    [
      "a draft digest on a blocked status",
      valid({
        reason: "authority-expired",
        state: "blocked",
        snapshotDigest: null,
        draftDigest: "c".repeat(64),
        artifactOutcome: null,
      }),
    ],
    ["a non-iso observedAt", valid({ observedAt: "not-a-date" })],
    ["a snapshot digest of the wrong length", valid({ snapshotDigest: "b".repeat(63) })],
  ])("rejects %s", (_label, candidate) => {
    expect(isWorkbenchDescriptionStatus(candidate)).toBe(false);
  });
});
