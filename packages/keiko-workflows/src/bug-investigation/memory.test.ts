import { describe, expect, it, vi } from "vitest";
import { acquireMemoryContext, emitMemoryWriteCandidate } from "./memory.js";
import type {
  MemoryId,
  MemoryWorkflowPort,
  MemoryWorkflowContext,
  MemoryUsedEvent,
  MemoryWriteCandidateEvent,
} from "@oscharko-dev/keiko-contracts";
import type { BugReportInput, BugInvestigationReport } from "./types.js";

function makePort(overrides: Partial<MemoryWorkflowPort> = {}): MemoryWorkflowPort {
  return {
    getContextForWorkflow: vi.fn().mockResolvedValue({
      text: "previous fix: use n / 2",
      includedMemoryIds: ["mem-1" as MemoryId],
    } satisfies MemoryWorkflowContext),
    onMemoryUsed: vi.fn(),
    onMemoryWriteCandidate: vi.fn(),
    ...overrides,
  };
}

function makeReport(overrides: Partial<BugInvestigationReport> = {}): BugInvestigationReport {
  return {
    workflowId: "bug-investigation",
    status: "fix-applied",
    modelId: "m",
    durationMs: 0,
    verified: {
      patchValidates: true,
      patchApplied: true,
      failureFrames: [],
    },
    hypothesis: { rootCause: "off-by-one in divisor" },
    changedFiles: [],
    regressionCoverage: 0,
    nextActions: [],
    modelCallCount: 1,
    patchRetryCount: 0,
    ...overrides,
  };
}

describe("acquireMemoryContext", () => {
  it("returns undefined when port is undefined", async () => {
    const result = await acquireMemoryContext(undefined, { description: "bug" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when port returns empty text", async () => {
    const port = makePort({
      getContextForWorkflow: vi.fn().mockResolvedValue({
        text: "",
        includedMemoryIds: ["mem-1" as MemoryId],
      } satisfies MemoryWorkflowContext),
    });
    const result = await acquireMemoryContext(port, { description: "bug" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when port returns empty includedMemoryIds", async () => {
    const port = makePort({
      getContextForWorkflow: vi.fn().mockResolvedValue({
        text: "some context",
        includedMemoryIds: [],
      } satisfies MemoryWorkflowContext),
    });
    const result = await acquireMemoryContext(port, { description: "bug" });
    expect(result).toBeUndefined();
  });

  it("returns context and calls onMemoryUsed when port returns non-empty context", async () => {
    const onMemoryUsed = vi.fn<(event: MemoryUsedEvent) => void>();
    const port = makePort({ onMemoryUsed });
    const report: BugReportInput = { description: "half() returns wrong value" };

    const result = await acquireMemoryContext(port, report);

    expect(result).toEqual({
      text: "previous fix: use n / 2",
      includedMemoryIds: ["mem-1"],
    });
    expect(onMemoryUsed).toHaveBeenCalledOnce();
    const event = onMemoryUsed.mock.calls[0]?.[0];
    expect(event?.memoryIds).toEqual(["mem-1"]);
    expect(event?.reason).toBe("bug-investigation:pre-prompt");
  });

  it("returns context when onMemoryUsed is absent on the port", async () => {
    const port: MemoryWorkflowPort = {
      getContextForWorkflow: vi.fn().mockResolvedValue({
        text: "previous fix: use n / 2",
        includedMemoryIds: ["mem-1" as MemoryId],
      } satisfies MemoryWorkflowContext),
    };
    const result = await acquireMemoryContext(port, { description: "bug" });
    expect(result).toBeDefined();
    expect(result?.text).toBe("previous fix: use n / 2");
  });

  it("returns undefined (degrades gracefully) when getContextForWorkflow throws", async () => {
    const port = makePort({
      getContextForWorkflow: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const result = await acquireMemoryContext(port, { description: "bug" });
    expect(result).toBeUndefined();
  });
});

describe("emitMemoryWriteCandidate", () => {
  it("is a no-op when port is undefined", () => {
    expect(() => {
      emitMemoryWriteCandidate(undefined, makeReport());
    }).not.toThrow();
  });

  it("is a no-op when onMemoryWriteCandidate is absent on the port", () => {
    const port: MemoryWorkflowPort = {
      getContextForWorkflow: vi.fn(),
    };
    expect(() => {
      emitMemoryWriteCandidate(port, makeReport());
    }).not.toThrow();
  });

  it("is a no-op when status is 'failed'", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ status: "failed" }));
    expect(onMemoryWriteCandidate).not.toHaveBeenCalled();
  });

  it("is a no-op when status is 'cancelled'", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ status: "cancelled" }));
    expect(onMemoryWriteCandidate).not.toHaveBeenCalled();
  });

  it("is a no-op when status is 'rejected'", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ status: "rejected" }));
    expect(onMemoryWriteCandidate).not.toHaveBeenCalled();
  });

  it("emits a write-candidate when status is 'fix-applied'", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ status: "fix-applied" }));
    expect(onMemoryWriteCandidate).toHaveBeenCalledOnce();
    const event = onMemoryWriteCandidate.mock.calls[0]?.[0];
    expect(event?.source).toBe("workflow-success");
  });

  it("emits a write-candidate when status is 'fix-proposed'", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ status: "fix-proposed" }));
    expect(onMemoryWriteCandidate).toHaveBeenCalledOnce();
  });

  it("emits a write-candidate when status is 'investigation-only'", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ status: "investigation-only" }));
    expect(onMemoryWriteCandidate).toHaveBeenCalledOnce();
  });

  it("proposalSummary includes rootCause when present", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(
      port,
      makeReport({ hypothesis: { rootCause: "off-by-one in divisor" } }),
    );
    const event = onMemoryWriteCandidate.mock.calls[0]?.[0];
    expect(event?.proposalSummary).toContain("off-by-one in divisor");
    expect(event?.proposalSummary).toContain("fix-applied");
  });

  it("proposalSummary includes status when rootCause is absent", () => {
    const onMemoryWriteCandidate = vi.fn<(event: MemoryWriteCandidateEvent) => void>();
    const port = makePort({ onMemoryWriteCandidate });
    emitMemoryWriteCandidate(port, makeReport({ hypothesis: {} }));
    const event = onMemoryWriteCandidate.mock.calls[0]?.[0];
    expect(event?.proposalSummary).toContain("fix-applied");
    expect(event?.proposalSummary).toContain("without a recorded root cause");
  });

  it("degrades gracefully when onMemoryWriteCandidate throws", () => {
    const port = makePort({
      onMemoryWriteCandidate: vi.fn().mockImplementation(() => {
        throw new Error("callback error");
      }),
    });
    expect(() => {
      emitMemoryWriteCandidate(port, makeReport());
    }).not.toThrow();
  });
});
