import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_CALL_HIERARCHY_ACTION_ID,
  registerKeikoCallHierarchyAction,
} from "./call-hierarchy-bridge.js";

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
      documentLanguage: "typescript",
      streamId: "hierarchy",
      newRequestId: () => "request",
      labels: { command: "Show Call Hierarchy" },
      onResult,
    });

    await run?.();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ roots: [] }));
  });
});
