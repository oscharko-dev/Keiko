import { describe, expect, it } from "vitest";
import { CODING_WORKBENCH_VERIFICATION_GAPS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  recordVerificationContinuation,
  VERIFICATION_CONTINUATION_MAX,
  VERIFICATION_CONTINUATION_SKIP_REASONS,
  verificationContinuationIntent,
} from "./codingRuntimeVerificationContinuation.js";
import type { ServerLogEvent } from "../observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

function capture(): {
  readonly lines: ServerLogEvent[];
  readonly sink: { write: (l: ServerLogEvent) => void };
} {
  const lines: ServerLogEvent[] = [];
  return {
    lines,
    sink: {
      write: (line): void => {
        lines.push(line);
      },
    },
  };
}

describe("verification continuation emitted evidence", () => {
  it.each([
    ["continued", undefined],
    ["skipped", undefined],
    ["dispatch-refused", "unavailable"],
    ["dispatch-threw", "unavailable"],
    ["run-superseded", "conflict"],
    ["not-evidenced", "validation-failed"],
  ] as const)("records actual %s disposition and registered proof", (state, errorKind) => {
    const { lines, sink } = capture();
    recordVerificationContinuation(sink, "run-qualified-1", 1, state);
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

  it("allows one automatic continuation per run", () => {
    expect(VERIFICATION_CONTINUATION_MAX).toBe(1);
  });

  it("names why no continuation ran, with the closed skip reason and the gap", () => {
    const { lines, sink } = capture();
    recordVerificationContinuation(sink, "run-qualified-1", 0, "skipped", {
      skipReason: "no-failed-check",
      gap: "no-check-run",
    });
    const line = lines[0];
    if (line === undefined) throw new TypeError("Missing skip evidence");
    expect(
      expectActivityLogProof(
        "coding-runtime.run.verification-continuation.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ state: "skipped", skipReason: "no-failed-check", gap: "no-check-run" });
  });

  it.each(VERIFICATION_CONTINUATION_SKIP_REASONS)("registers the skip reason %s", (skipReason) => {
    const { lines, sink } = capture();
    recordVerificationContinuation(sink, "run-qualified-1", 0, "skipped", { skipReason });
    const line = lines[0];
    if (line === undefined) throw new TypeError("Missing skip evidence");
    expect(
      expectActivityLogProof(
        "coding-runtime.run.verification-continuation.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ skipReason });
  });

  it.each(CODING_WORKBENCH_VERIFICATION_GAPS)(
    "registers the contract's verification gap %s on the line",
    (gap) => {
      const { lines, sink } = capture();
      recordVerificationContinuation(sink, "run-qualified-1", 0, "not-evidenced", { gap });
      const line = lines[0];
      if (line === undefined) throw new TypeError("Missing gap evidence");
      expect(
        expectActivityLogProof(
          "coding-runtime.run.verification-continuation.emitted-line",
          formatActivityLogProofLine(line),
        ),
      ).toMatchObject({ gap });
    },
  );

  it("names the failed check and its failed steps on the continued line, nothing else of the run", () => {
    const { lines, sink } = capture();
    recordVerificationContinuation(sink, "run-qualified-1", 1, "continued", {
      failure: { check: "typecheck", failedCount: 4 },
    });
    const line = lines[0];
    if (line === undefined) throw new TypeError("Missing continued evidence");
    expect(
      expectActivityLogProof(
        "coding-runtime.run.verification-continuation.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ state: "continued", check: "typecheck", failedCount: 4 });
  });

  it("retains the original typed transport code, frames and cause classes without message bodies", () => {
    const { lines, sink } = capture();
    const error = Object.assign(
      new Error("PRIVATE_TRANSPORT_CANARY", { cause: new TypeError("PRIVATE_CAUSE_CANARY") }),
      { code: "TRANSPORT_UNAVAILABLE" },
    );
    recordVerificationContinuation(sink, "run-qualified-1", 1, "dispatch-threw", { error });
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

describe("verificationContinuationIntent", () => {
  it("states the one failed check and its failed steps and asks to repair and rerun it", () => {
    const intent = verificationContinuationIntent({ check: "test", failedCount: 2 }, true);
    expect(intent).toContain("The test check you ran after your last change failed");
    expect(intent).toContain("2 steps failed");
    expect(intent).toContain("repair the cause");
    expect(intent).toContain("rerun the same check in your shell");
    expect(intent).toContain("state the exact cause once");
  });

  it("is generic about an unknown check and singular about one failed step", () => {
    const intent = verificationContinuationIntent({ check: "check", failedCount: 1 }, undefined);
    expect(intent).toContain("A check you ran after your last change failed (1 step failed)");
  });

  it("never mentions a shell to a model that has none", () => {
    const intent = verificationContinuationIntent({ check: "build", failedCount: 1 }, false);
    expect(intent.toLowerCase()).not.toContain("shell");
    expect(intent).toContain("governed verification tool");
  });

  it("is no blind request: it says nothing about verification being incomplete in general", () => {
    const intent = verificationContinuationIntent({ check: "lint", failedCount: 3 }, true);
    expect(intent).not.toContain("Verification is not complete");
  });
});
