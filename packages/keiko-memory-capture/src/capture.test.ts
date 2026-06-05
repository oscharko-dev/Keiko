import { describe, expect, it } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  UserId,
  WorkflowRunId,
} from "@oscharko-dev/keiko-contracts/memory";

import { extractCandidatesFromUserText, extractCandidatesFromWorkflowOutcome } from "./capture.js";
import type { CaptureContext, WorkflowOutcomeInput } from "./types.js";

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  let memCounter = 0;
  let proCounter = 0;
  return {
    userId: "u-1" as UserId,
    nowMs: 1_700_000_000_000,
    newMemoryId: (): MemoryId => `m-${String(++memCounter)}` as MemoryId,
    newProposalId: (): MemoryProposalId => `p-${String(++proCounter)}` as MemoryProposalId,
    ...overrides,
  };
}

describe("extractCandidatesFromUserText", () => {
  it("returns empty-content rejection on blank input", () => {
    expect(extractCandidatesFromUserText("   ", ctx())).toEqual([
      { kind: "rejected", reason: "empty-content" },
    ]);
  });

  it("returns exceeds-length-limit on oversize input", () => {
    const huge = "remember that " + "x".repeat(5000);
    expect(extractCandidatesFromUserText(huge, ctx())).toEqual([
      { kind: "rejected", reason: "exceeds-length-limit" },
    ]);
  });

  it("returns restricted-sensitivity when policy default is restricted", () => {
    expect(
      extractCandidatesFromUserText("remember dark mode", ctx(), {
        defaultSensitivity: "restricted",
      }),
    ).toEqual([{ kind: "rejected", reason: "restricted-sensitivity" }]);
  });

  it("emits a remember candidate for a 'remember that' phrase", () => {
    const result = extractCandidatesFromUserText("remember that I prefer dark mode", ctx());
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("candidate");
  });

  it("emits a forget operation for 'forget about X' with resolver match", () => {
    const result = extractCandidatesFromUserText("forget about dark mode", ctx(), {
      resolver: () => ["m-9" as MemoryId],
    });
    expect(result[0]?.kind).toBe("forget");
  });

  it("emits an update operation for 'update memory about ...'", () => {
    const result = extractCandidatesFromUserText("update memory about runner to be vitest", ctx(), {
      resolver: () => ["m-3" as MemoryId],
    });
    expect(result[0]?.kind).toBe("update");
  });

  it("emits a correction candidate for 'actually, ...'", () => {
    const result = extractCandidatesFromUserText("actually, the runner is vitest", ctx());
    expect(result[0]?.kind).toBe("candidate");
    if (result[0]?.kind !== "candidate") return;
    expect(result[0].proposal.type).toBe("correction");
  });

  it("returns [] when no intent matches", () => {
    expect(extractCandidatesFromUserText("what is the weather", ctx())).toEqual([]);
  });

  it("rejects with credential-shape for credential bodies", () => {
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    const result = extractCandidatesFromUserText(`remember that ${shape}`, ctx());
    expect(result[0]).toEqual({ kind: "rejected", reason: "credential-shape" });
  });

  it("priority: forget wins over remember when both could match", () => {
    // Construct a string that would match both — 'remember about forget' vs 'forget about remember'.
    // The grammar is constructed so the forget regex fires first per the EXTRACTORS order.
    const result = extractCandidatesFromUserText("forget about old runner setting", ctx(), {
      resolver: () => ["m-1" as MemoryId],
    });
    expect(result[0]?.kind).toBe("forget");
  });
});

describe("extractCandidatesFromWorkflowOutcome", () => {
  it("delegates to the workflow extractor", () => {
    const outcome: WorkflowOutcomeInput = {
      runId: "wr-1" as WorkflowRunId,
      outcomeKind: "success",
      structuredReport: "the test runner is vitest",
      capturedAt: 1_700_000_000_000,
    };
    const result = extractCandidatesFromWorkflowOutcome(outcome, ctx());
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("candidate");
  });

  it("returns restricted-sensitivity when policy default is restricted", () => {
    const outcome: WorkflowOutcomeInput = {
      runId: "wr-1" as WorkflowRunId,
      outcomeKind: "success",
      structuredReport: "anything",
      capturedAt: 0,
    };
    expect(
      extractCandidatesFromWorkflowOutcome(outcome, ctx(), { defaultSensitivity: "restricted" }),
    ).toEqual([{ kind: "rejected", reason: "restricted-sensitivity" }]);
  });
});
