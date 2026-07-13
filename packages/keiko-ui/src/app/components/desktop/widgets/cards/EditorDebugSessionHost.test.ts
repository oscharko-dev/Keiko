import { describe, expect, it } from "vitest";
import type { DebugSessionSnapshot } from "./debugSessionStore";
import { derivePausedDebugValues } from "./EditorDebugSessionHost";

function snapshot(sourceFileId = "src/program.ts"): DebugSessionSnapshot {
  const frameRef = "frame-1";
  const scopeRef = "scope-1";
  return {
    instrumentation: null,
    session: {
      schemaVersion: "1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "paused",
      targetKind: "file",
      activationRevision: 1,
      pauseGeneration: 3,
      startedAtMs: 1,
      wallDeadlineMs: 2,
      inactivityDeadlineMs: 3,
      output: { acceptedBytes: 0, truncated: false },
    },
    stack: {
      frames: [
        {
          frameRef,
          name: {
            value: "main",
            truncated: false,
            originalBytes: 4,
            retainedBytes: 4,
            omittedBytes: 0,
          },
          sourceFileId,
          line: 7,
          column: 2,
        },
      ],
      truncated: false,
      omittedCount: 0,
    },
    scopesByFrame: new Map([
      [
        frameRef,
        {
          frameRef,
          scopes: [
            {
              scopeRef,
              name: {
                value: "Local",
                truncated: false,
                originalBytes: 5,
                retainedBytes: 5,
                omittedBytes: 0,
              },
              expensive: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        },
      ],
    ]),
    variablesByParent: new Map([
      [
        scopeRef,
        {
          parentRef: scopeRef,
          nodes: [
            {
              kind: "variable",
              name: {
                value: "count",
                truncated: false,
                originalBytes: 5,
                retainedBytes: 5,
                omittedBytes: 0,
              },
              value: {
                value: "2",
                truncated: false,
                originalBytes: 1,
                retainedBytes: 1,
                omittedBytes: 0,
              },
              presentation: "data",
              children: [],
              retainedCount: 0,
              omittedCount: 0,
              truncated: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        },
      ],
    ]),
    watchResults: new Map(),
    console: { entries: [], evictedEntries: 0, evictedBytes: 0 },
    stopDescription: null,
    sequence: 1,
    streamReady: true,
  };
}

describe("derivePausedDebugValues", () => {
  it("projects bounded local values only for the active paused source frame", () => {
    expect(derivePausedDebugValues(snapshot(), "src/program.ts", "keiko://program")).toMatchObject({
      paused: true,
      pauseGeneration: 3,
      documentUri: "keiko://program",
      values: [{ line: 7, column: 2, value: "count: 2" }],
    });
  });

  it("fails closed when the paused frame belongs to another file", () => {
    expect(
      derivePausedDebugValues(snapshot("src/other.ts"), "src/program.ts", "keiko://program"),
    ).toMatchObject({ paused: false, values: [] });
  });
});
