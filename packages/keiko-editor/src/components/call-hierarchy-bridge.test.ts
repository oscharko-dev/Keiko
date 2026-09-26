import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_CALL_HIERARCHY_ACTION_ID,
  registerKeikoCallHierarchyAction,
} from "./call-hierarchy-bridge.js";
import type { EditorLanguageIntelligenceEvent } from "./language-intelligence.js";

describe("registerKeikoCallHierarchyAction", () => {
  it("runs the resolver at the live Monaco cursor and publishes the hierarchy tree", async () => {
    const onResult = vi.fn();
    let run: (() => Promise<void>) | undefined;
    registerKeikoCallHierarchyAction({
      editor: {
        addAction: (descriptor) => {
          expect(descriptor.id).toBe(EDITOR_CALL_HIERARCHY_ACTION_ID);
          run = async (): Promise<void> => {
            await descriptor.run({} as never);
          };
          return { dispose: (): void => undefined };
        },
        getPosition: () => ({ lineNumber: 2, column: 4 }),
        getModel: () => ({
          getValue: (): string => "target();",
          uri: { toString: (): string => "keiko-editor://current" },
        }),
      },
      resolve: (query) => {
        expect(query.request.position).toEqual({ line: 1, column: 3 });
        return Promise.resolve({ request: query.request.request, roots: [] });
      },
      isCurrentDocument: () => true,
      documentLanguage: () => "typescript",
      streamId: "hierarchy",
      newRequestId: () => "request",
      labels: { command: "Show Call Hierarchy" },
      onResult,
    });

    await run?.();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ roots: [] }));
  });

  // The server caps the hierarchy at `maxCallHierarchyItems` (128) and `maxCallHierarchyCallSites`
  // (512). A capped tree renders as a complete one — the exact input a user reads to conclude a
  // function has no remaining callers — so the cap must reach the outcome seam as `capped`.
  it("labels a server-capped hierarchy as capped, not as the whole call tree", async () => {
    const events: EditorLanguageIntelligenceEvent[] = [];
    let run: (() => Promise<void>) | undefined;
    registerKeikoCallHierarchyAction({
      editor: {
        addAction: (descriptor) => {
          run = async (): Promise<void> => {
            await descriptor.run({} as never);
          };
          return { dispose: (): void => undefined };
        },
        getPosition: () => ({ lineNumber: 2, column: 4 }),
        getModel: () => ({
          getValue: (): string => "target();",
          uri: { toString: (): string => "keiko-editor://current" },
        }),
      },
      resolve: (query) =>
        Promise.resolve({ request: query.request.request, roots: [], truncated: true }),
      isCurrentDocument: () => true,
      documentLanguage: () => "typescript",
      streamId: "hierarchy",
      newRequestId: () => "request",
      labels: { command: "Show Call Hierarchy" },
      onResult: vi.fn(),
      report: (event) => events.push(event),
    });

    await run?.();
    // A cap that dropped everything still reports `capped`, never `empty`: "no callers found" and
    // "we stopped looking" are opposite conclusions for the user about to delete the function.
    expect(events).toEqual([{ operation: "call-hierarchy", outcome: { status: "capped" } }]);
  });
});
