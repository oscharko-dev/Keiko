import { describe, expect, it } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  UserId,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "@oscharko-dev/keiko-contracts/memory";

import { extractWorkflowOutcomeCandidates } from "./intent-workflow.js";
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

function outcome(overrides: Partial<WorkflowOutcomeInput> = {}): WorkflowOutcomeInput {
  return {
    runId: "wr-1" as WorkflowRunId,
    outcomeKind: "success",
    structuredReport: "the test runner is vitest",
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("extractWorkflowOutcomeCandidates", () => {
  it("emits a semantic-fact candidate for outcomeKind=success", () => {
    const results = extractWorkflowOutcomeCandidates(outcome(), ctx());
    expect(results).toHaveLength(1);
    const first = results[0];
    expect(first?.kind).toBe("candidate");
    if (first?.kind !== "candidate") return;
    expect(first.proposal.type).toBe("semantic-fact");
    expect(first.proposal.body).toBe("the test runner is vitest");
    expect(first.proposal.provenance.sourceKind).toBe("workflow-outcome");
    expect(first.proposal.provenance.sourceWorkflowRunId).toBe("wr-1");
    expect(first.proposal.provenance.confidence).toBeLessThan(1);
  });

  it("emits a correction candidate for outcomeKind=corrected", () => {
    const results = extractWorkflowOutcomeCandidates(
      outcome({ outcomeKind: "corrected", structuredReport: "should use pnpm" }),
      ctx(),
    );
    expect(results).toHaveLength(1);
    const first = results[0];
    if (first?.kind !== "candidate") {
      throw new Error("expected candidate outcome");
    }
    expect(first.proposal.type).toBe("correction");
    expect(first.proposal.provenance.sourceKind).toBe("accepted-correction");
    expect(first.proposal.provenance.sourceWorkflowRunId).toBe("wr-1");
  });

  it("returns [] for outcomeKind=failed (no learning from failed runs)", () => {
    const results = extractWorkflowOutcomeCandidates(outcome({ outcomeKind: "failed" }), ctx());
    expect(results).toEqual([]);
  });

  it("prefers workflow scope when workflowDefinitionId is available", () => {
    const results = extractWorkflowOutcomeCandidates(
      outcome(),
      ctx({ workflowDefinitionId: "wf-1" as WorkflowDefinitionId }),
    );
    const first = results[0];
    if (first?.kind !== "candidate") {
      throw new Error("expected candidate");
    }
    expect(first.proposal.scope).toEqual({ kind: "workflow", workflowDefinitionId: "wf-1" });
  });

  it("falls back to user scope when no workflowDefinitionId", () => {
    const results = extractWorkflowOutcomeCandidates(outcome(), ctx());
    const first = results[0];
    if (first?.kind !== "candidate") {
      throw new Error("expected candidate");
    }
    expect(first.proposal.scope).toEqual({ kind: "user", userId: "u-1" });
  });

  it("rejects a credential-bearing structuredReport with credential-shape", () => {
    const shape = "sk" + "-" + "abcdef0123456789abcdef0123";
    const results = extractWorkflowOutcomeCandidates(
      outcome({ structuredReport: `the key is ${shape}` }),
      ctx(),
    );
    expect(results[0]).toEqual({ kind: "rejected", reason: "credential-shape" });
  });

  it("rejects an empty structuredReport with empty-content", () => {
    const results = extractWorkflowOutcomeCandidates(outcome({ structuredReport: "   " }), ctx());
    expect(results[0]).toEqual({ kind: "rejected", reason: "empty-content" });
  });
});
