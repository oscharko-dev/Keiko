import { describe, expect, it, vi } from "vitest";
import { acquireMemoryContext } from "./memory.js";
import type {
  MemoryId,
  MemoryWorkflowPort,
  MemoryWorkflowContext,
  MemoryUsedEvent,
} from "@oscharko-dev/keiko-contracts";
import type { ProjectId } from "@oscharko-dev/keiko-contracts/memory";
import type { BugReportInput } from "./types.js";

const WORKSPACE_ROOT = "/repo/project-a";

function makePort(overrides: Partial<MemoryWorkflowPort> = {}): MemoryWorkflowPort {
  return {
    getContextForWorkflow: vi.fn().mockResolvedValue({
      text: "previous fix: use n / 2",
      includedMemoryIds: ["mem-1" as MemoryId],
    } satisfies MemoryWorkflowContext),
    onMemoryUsed: vi.fn(),
    ...overrides,
  };
}

describe("acquireMemoryContext", () => {
  it("returns undefined when port is undefined", async () => {
    const result = await acquireMemoryContext(undefined, { description: "bug" }, WORKSPACE_ROOT);
    expect(result).toBeUndefined();
  });

  it("returns undefined when port returns empty text", async () => {
    const port = makePort({
      getContextForWorkflow: vi.fn().mockResolvedValue({
        text: "",
        includedMemoryIds: ["mem-1" as MemoryId],
      } satisfies MemoryWorkflowContext),
    });
    const result = await acquireMemoryContext(port, { description: "bug" }, WORKSPACE_ROOT);
    expect(result).toBeUndefined();
  });

  it("returns undefined when port returns empty includedMemoryIds", async () => {
    const port = makePort({
      getContextForWorkflow: vi.fn().mockResolvedValue({
        text: "some context",
        includedMemoryIds: [],
      } satisfies MemoryWorkflowContext),
    });
    const result = await acquireMemoryContext(port, { description: "bug" }, WORKSPACE_ROOT);
    expect(result).toBeUndefined();
  });

  it("returns context and calls onMemoryUsed when port returns non-empty context", async () => {
    const onMemoryUsed = vi.fn<(event: MemoryUsedEvent) => void>();
    const port = makePort({ onMemoryUsed });
    const report: BugReportInput = { description: "half() returns wrong value" };

    const result = await acquireMemoryContext(port, report, WORKSPACE_ROOT);

    expect(result).toEqual({
      text: "previous fix: use n / 2",
      includedMemoryIds: ["mem-1"],
    });
    expect(port.getContextForWorkflow).toHaveBeenCalledWith(
      [{ kind: "project", projectId: WORKSPACE_ROOT as ProjectId }],
      "half() returns wrong value",
      2_048,
    );
    expect(onMemoryUsed).toHaveBeenCalledOnce();
    const event = onMemoryUsed.mock.calls[0]?.[0];
    expect(event?.memoryIds).toEqual(["mem-1"]);
    expect(event?.scopes).toEqual([{ kind: "project", projectId: WORKSPACE_ROOT }]);
    expect(event?.reason).toBe("bug-investigation:pre-prompt");
  });

  it("does not fabricate omitted-memory events from the reduced workflow context", async () => {
    const onMemoryOmitted = vi.fn();
    const port = makePort({ onMemoryOmitted });

    await acquireMemoryContext(port, { description: "bug" }, WORKSPACE_ROOT);

    expect(onMemoryOmitted).not.toHaveBeenCalled();
  });

  it("returns context when onMemoryUsed is absent on the port", async () => {
    const port: MemoryWorkflowPort = {
      getContextForWorkflow: vi.fn().mockResolvedValue({
        text: "previous fix: use n / 2",
        includedMemoryIds: ["mem-1" as MemoryId],
      } satisfies MemoryWorkflowContext),
    };
    const result = await acquireMemoryContext(port, { description: "bug" }, WORKSPACE_ROOT);
    expect(result).toBeDefined();
    expect(result?.text).toBe("previous fix: use n / 2");
  });

  it("returns undefined (degrades gracefully) when getContextForWorkflow throws", async () => {
    const port = makePort({
      getContextForWorkflow: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const result = await acquireMemoryContext(port, { description: "bug" }, WORKSPACE_ROOT);
    expect(result).toBeUndefined();
  });
});
