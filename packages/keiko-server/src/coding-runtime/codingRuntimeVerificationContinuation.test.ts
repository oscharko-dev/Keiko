import { describe, expect, it } from "vitest";
import { recordVerificationContinuation } from "./codingRuntimeVerificationContinuation.js";
import type { ServerLogEvent } from "../observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

describe("verification continuation emitted evidence", () => {
  it.each([
    ["continued", undefined],
    ["dispatch-refused", "unavailable"],
    ["dispatch-threw", "unavailable"],
    ["run-superseded", "conflict"],
    ["not-evidenced", "validation-failed"],
  ] as const)("records actual %s disposition and registered proof", (state, errorKind) => {
    const lines: ServerLogEvent[] = [];
    recordVerificationContinuation(
      {
        write: (line): void => {
          lines.push(line);
        },
      },
      "run-qualified-1",
      1,
      state,
    );
    const line = lines[0];
    if (line === undefined) throw new TypeError("Missing continuation evidence");
    expect(line.errorKind).toBe(errorKind);
    expect(
      expectActivityLogProof(
        "coding-runtime.run.verification-continuation.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ state, attempt: 1, runId: "run-qualified-1" });
  });

  it("retains the original typed transport code, frames and cause classes without message bodies", () => {
    const lines: ServerLogEvent[] = [];
    const error = Object.assign(
      new Error("PRIVATE_TRANSPORT_CANARY", { cause: new TypeError("PRIVATE_CAUSE_CANARY") }),
      { code: "TRANSPORT_UNAVAILABLE" },
    );
    recordVerificationContinuation(
      {
        write: (line): void => {
          lines.push(line);
        },
      },
      "run-qualified-1",
      1,
      "dispatch-threw",
      error,
    );
    const line = lines[0];
    if (line === undefined) throw new TypeError("Missing dispatch failure evidence");
    expect(line.extra).toMatchObject({
      errorClass: "Error",
      code: "TRANSPORT_UNAVAILABLE",
      causeChain: ["TypeError"],
      frames: expect.any(Array) as unknown,
    });
    expect(JSON.stringify(line)).not.toContain("PRIVATE_TRANSPORT_CANARY");
    expect(JSON.stringify(line)).not.toContain("PRIVATE_CAUSE_CANARY");
    expectActivityLogProof(
      "coding-runtime.run.verification-continuation.emitted-line",
      formatActivityLogProofLine(line),
    );
  });
});
