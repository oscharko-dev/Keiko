import { describe, expect, it } from "vitest";

import {
  MAX_EDITOR_AGENT_RECONCILIATION_REQUESTS_PER_PANE,
  completeEditorAgentReconciliation,
  enqueueEditorAgentReconciliation,
  pruneEditorAgentReconciliation,
  type EditorAgentReconciliationQueues,
  type EditorAgentReconciliationRequest,
} from "./editorAgentReconciliationQueue";

const PANES = [
  { id: "pane-1", openFiles: ["src/a.ts"] },
  { id: "pane-2", openFiles: ["src/a.ts", "src/b.ts"] },
  { id: "pane-3", openFiles: ["src/c.ts"] },
] as const;

function request(requestId: number, file = "src/a.ts"): EditorAgentReconciliationRequest {
  return { requestId, entries: [{ file, kind: "modify" }] };
}

describe("editor agent reconciliation queue", () => {
  it("targets only other panes that have a committed file open", () => {
    const queued = enqueueEditorAgentReconciliation({}, PANES, "pane-1", request(1));

    expect(queued).toEqual({ "pane-2": [request(1)] });
  });

  it("serializes requests, completes only the head, and prunes removed panes", () => {
    const first = enqueueEditorAgentReconciliation({}, PANES, "pane-1", request(1));
    const second = enqueueEditorAgentReconciliation(first, PANES, "pane-1", request(2));

    expect(completeEditorAgentReconciliation(second, "pane-2", 2)).toBe(second);
    expect(completeEditorAgentReconciliation(second, "pane-2", 1)).toEqual({
      "pane-2": [request(2)],
    });
    expect(pruneEditorAgentReconciliation(second, new Set(["pane-1"]))).toEqual({});
  });

  it("bounds a busy pane by compacting queued paths to their latest state", () => {
    const files = Array.from(
      { length: MAX_EDITOR_AGENT_RECONCILIATION_REQUESTS_PER_PANE + 1 },
      (_, index) => `src/${String(index + 1)}.ts`,
    );
    const panes = [PANES[0], { id: "pane-2", openFiles: files }];
    let queued: EditorAgentReconciliationQueues = {};
    for (
      let requestId = 1;
      requestId <= MAX_EDITOR_AGENT_RECONCILIATION_REQUESTS_PER_PANE + 1;
      requestId += 1
    ) {
      queued = enqueueEditorAgentReconciliation(
        queued,
        panes,
        "pane-1",
        request(requestId, `src/${String(requestId)}.ts`),
      );
    }

    expect(queued["pane-2"]).toHaveLength(1);
    expect(queued["pane-2"]?.[0]?.entries).toHaveLength(
      MAX_EDITOR_AGENT_RECONCILIATION_REQUESTS_PER_PANE + 1,
    );
  });
});
