// Regression (#3532): `coding-runtime.tool-availability.failed` declared `frames` and `causeChain`
// required, but persisted-line redaction omits an empty array, so the ORDINARY failure — a thrown
// error without Keiko frames or without a cause — persisted a line that failed its own
// registration and was dropped. The proof below throws exactly that error and requires the line
// the production formatter persists to validate.

import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { resolveChildModelForRun } from "./productionManagedWorktreeTools.js";

const RUN_ID = "run-availability-omitted-evidence";
const DIGEST = "b".repeat(64);

describe("coding-runtime.tool-availability.failed without frames or a cause", () => {
  it("persists a line that validates against its own registration", () => {
    const events: ServerLogEvent[] = [];
    const childModel = resolveChildModelForRun({
      authorityRef: { runId: RUN_ID, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
      childModelPortFactory: () => {
        throw new Error("private child configuration failure without a cause");
      },
      activityLog: { write: (event): void => void events.push(event) },
    });

    expect(childModel).toEqual({});
    const line = formatActivityLogProofLine(events[0] ?? {});
    const persisted = expectActivityLogProof(
      "coding-runtime.tool-availability.failed.emitted-line",
      line,
    );
    expect(persisted).toMatchObject({
      runId: RUN_ID,
      stage: "child-model-resolution",
      reason: "configuration-resolution-failed",
    });
    expect(persisted).not.toHaveProperty("causeChain");
    expect(line).not.toContain("private child configuration failure");
  });
});
