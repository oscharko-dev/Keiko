import { describe, expect, it } from "vitest";

import {
  DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
  DEBUG_EVENT_KINDS,
  DEBUG_SESSION_STATUSES,
  DEBUG_TRUNCATION_MARKER,
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  SOURCE_BREAKPOINT_KINDS,
  buildDebugOutputEvent,
  buildDebugVariableTree,
  buildScopeProjection,
  buildStackPage,
  buildWatchEvaluationResult,
  parseDebugBootstrapRequest,
  parseDebugSessionControlRequest,
  parseDebugSessionStartRequest,
  parseEvaluateWatchRequest,
  parseScopesRequest,
  parseSetBreakpointsRequest,
  parseSetExceptionBreakpointsRequest,
  parseSetVariableRequest,
  parseSetWatchesRequest,
  parseStackTraceRequest,
  parseVariablesRequest,
  projectDebugText,
} from "./dap-debug.js";
import type {
  DebugEvent,
  DebugSession,
  DebugVariableInput,
  ExceptionBreakpointFilter,
  InstrumentationSnapshot,
  Scope,
  SourceBreakpoint,
  StackFrame,
  WatchEvaluationResult,
  WatchExpression,
} from "./dap-debug.js";

const schemaVersion = DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
const opaqueId = "opaque_1";
const workspaceId = "workspace_1";
const fileId = "src/example.ts";

const breakpoint = {
  id: "breakpoint_1",
  fileId,
  line: 1,
  enabled: true,
  kind: "line",
  verification: "pending",
} as const satisfies SourceBreakpoint;

const watch = {
  watchId: "watch_1",
  expression: "state.value",
  enabled: true,
} as const satisfies WatchExpression;

const exceptionFilter = {
  filterId: "uncaught",
  enabled: true,
} as const satisfies ExceptionBreakpointFilter;

const validRequests = [
  [
    "bootstrap",
    parseDebugBootstrapRequest,
    { schemaVersion, workspaceId },
    { schemaVersion, workspaceId: "x".repeat(129) },
  ],
  [
    "session start",
    parseDebugSessionStartRequest,
    {
      schemaVersion,
      workspaceId,
      target: { kind: "catalog", targetId: "target_1" },
      activationRevision: 0,
    },
    {
      schemaVersion,
      workspaceId,
      target: { kind: "catalog", targetId: "x".repeat(129) },
      activationRevision: 0,
    },
  ],
  [
    "session control",
    parseDebugSessionControlRequest,
    { schemaVersion, sessionId: opaqueId, action: "continue", pauseGeneration: 0 },
    {
      schemaVersion,
      sessionId: "x".repeat(129),
      action: "continue",
      pauseGeneration: 0,
    },
  ],
  [
    "set breakpoints",
    parseSetBreakpointsRequest,
    { schemaVersion, workspaceId, expectedRevision: 0, fileId, breakpoints: [breakpoint] },
    {
      schemaVersion,
      workspaceId,
      expectedRevision: 0,
      fileId,
      breakpoints: [
        { ...breakpoint, condition: "é".repeat(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxConditionBytes) },
      ],
    },
  ],
  [
    "set exception breakpoints",
    parseSetExceptionBreakpointsRequest,
    { schemaVersion, workspaceId, expectedRevision: 0, filters: [exceptionFilter] },
    {
      schemaVersion,
      workspaceId,
      expectedRevision: 0,
      filters: Array.from(
        { length: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxExceptionFilters + 1 },
        (_, index) => ({ filterId: `filter_${String(index)}`, enabled: true }),
      ),
    },
  ],
  [
    "stack trace",
    parseStackTraceRequest,
    { schemaVersion, sessionId: opaqueId, pauseGeneration: 0, startFrame: 0, levels: 1 },
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      startFrame: 0,
      levels: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage + 1,
    },
  ],
  [
    "scopes",
    parseScopesRequest,
    { schemaVersion, sessionId: opaqueId, pauseGeneration: 0, frameRef: "frame_1" },
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      frameRef: "x".repeat(129),
    },
  ],
  [
    "variables",
    parseVariablesRequest,
    { schemaVersion, sessionId: opaqueId, pauseGeneration: 0, variableRef: "variable_1" },
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      variableRef: "x".repeat(129),
    },
  ],
  [
    "set variable",
    parseSetVariableRequest,
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      variableRef: "variable_1",
      value: "next",
    },
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      variableRef: "variable_1",
      value: "é".repeat(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxValueBytes),
    },
  ],
  [
    "set watches",
    parseSetWatchesRequest,
    { schemaVersion, workspaceId, expectedRevision: 0, watches: [watch] },
    {
      schemaVersion,
      workspaceId,
      expectedRevision: 0,
      watches: [{ ...watch, expression: "é".repeat(600) }],
    },
  ],
  [
    "evaluate watch",
    parseEvaluateWatchRequest,
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      watchId: "watch_1",
      frameRef: "frame_1",
    },
    {
      schemaVersion,
      sessionId: opaqueId,
      pauseGeneration: 0,
      watchId: "x".repeat(129),
    },
  ],
] as const;

function deepHostileValue(): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < 2_000; index += 1) value = { nested: value };
  return value;
}

function sparseArray(): unknown[] {
  const value = new Array<unknown>(2);
  value[1] = breakpoint;
  return value;
}

describe("DAP debug leaf contracts", () => {
  it("pins schema, closed vocabularies, frozen tables, and exact payload caps", () => {
    expect(schemaVersion).toBe("1");
    expect(DEBUG_SESSION_STATUSES).toEqual([
      "reserved",
      "starting",
      "running",
      "paused",
      "stopping",
      "stopped",
      "failed",
      "revoked",
    ]);
    expect(DEBUG_EVENT_KINDS).toEqual([
      "session-started",
      "session-stopped",
      "stopped",
      "continued",
      "output",
      "exited",
      "breakpoints-changed",
      "projection-truncated",
    ]);
    expect(SOURCE_BREAKPOINT_KINDS).toEqual(["line", "conditional", "logpoint"]);
    expect(Object.isFrozen(DEBUG_SESSION_STATUSES)).toBe(true);
    expect(Object.isFrozen(DEBUG_EVENT_KINDS)).toBe(true);
    expect(Object.isFrozen(SOURCE_BREAKPOINT_KINDS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DEBUG_PAYLOAD_LIMITS)).toBe(true);
    expect(DEFAULT_DEBUG_PAYLOAD_LIMITS).toMatchObject({
      maxBreakpointsPerFile: 64,
      maxBreakpointsPerWorkspace: 200,
      maxConditionBytes: 1_024,
      maxLogMessageBytes: 1_024,
      maxWatchExpressionBytes: 1_024,
      maxWatches: 32,
      maxWatchValueBytes: 4_096,
      maxWatchTypeBytes: 256,
      maxHttpResponseBytes: 256 * 1_024,
      maxSseEventBytes: 64 * 1_024,
      maxFramesPerPage: 64,
      maxRetainedFrames: 128,
      maxScopesPerFrame: 32,
      maxVariablesPerExpansion: 200,
      maxDepth: 4,
      maxGraphNodes: 1_000,
      maxNameBytes: 512,
      maxTypeBytes: 256,
      maxValueBytes: 4_096,
      maxOutputBytes: 16 * 1_024,
      maxChildrenPerNode: 200,
      maxValueChars: 4_096,
      maxFrames: 64,
      maxOutputChars: 16 * 1_024,
    });
  });

  it("keeps exact-optional fixtures assignable under strict contracts", () => {
    const session = {
      schemaVersion,
      sessionId: "session_1",
      workspaceId,
      status: "paused",
      targetKind: "file",
      activationRevision: 1,
      pauseGeneration: 2,
      startedAtMs: 3,
      wallDeadlineMs: 4,
      inactivityDeadlineMs: 5,
      output: { acceptedBytes: 6, truncated: false },
    } as const satisfies DebugSession;
    const frame = {
      frameRef: "frame_1",
      name: projectDebugText("main", DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes),
      line: 1,
      column: 1,
    } as const satisfies StackFrame;
    const scope = {
      scopeRef: "scope_1",
      name: projectDebugText("Local", DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes),
      expensive: false,
    } as const satisfies Scope;
    const result = {
      watchId: "watch_1",
      pauseGeneration: 2,
      state: "value",
      value: projectDebugText("42", DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatchValueBytes),
    } as const satisfies WatchEvaluationResult;
    const snapshot = {
      schemaVersion,
      workspaceId,
      revision: 1,
      etag: "etag_1",
      breakpoints: [breakpoint],
      exceptionFilters: [exceptionFilter],
      watches: [watch],
    } as const satisfies InstrumentationSnapshot;
    expect({ session, frame, scope, result, snapshot }).toBeDefined();
  });

  it.each(validRequests)("accepts a valid %s request", (_name, parser, value) => {
    expect(parser(value)).toMatchObject({ ok: true });
  });

  it.each(validRequests)(
    "rejects empty, wrong, extra, sparse, deep, and oversize %s input",
    (_name, parser, valid, oversize) => {
      const extra = { ...valid, unexpected: true };
      for (const candidate of [{}, null, extra, sparseArray(), deepHostileValue(), oversize]) {
        expect(() => parser(candidate)).not.toThrow();
        expect(parser(candidate)).toMatchObject({ ok: false });
      }
    },
  );

  it("rejects sparse nested request arrays and non-canonical workspace file ids", () => {
    const sparseBreakpoints = {
      schemaVersion,
      workspaceId,
      expectedRevision: 0,
      fileId,
      breakpoints: sparseArray(),
    };
    const sparseWatches = {
      schemaVersion,
      workspaceId,
      expectedRevision: 0,
      watches: new Array<WatchExpression>(1),
    };
    for (const invalidFileId of [
      "/tmp/a.ts",
      "C:/a.ts",
      "../a.ts",
      "src/../a.ts",
      "src\\a.ts",
      "src//a.ts",
      "src/\u0000a.ts",
    ]) {
      expect(
        parseSetBreakpointsRequest({ ...sparseBreakpoints, fileId: invalidFileId }),
      ).toMatchObject({ ok: false });
    }
    expect(parseSetBreakpointsRequest(sparseBreakpoints)).toMatchObject({ ok: false });
    expect(parseSetWatchesRequest(sparseWatches)).toMatchObject({ ok: false });
  });

  it("rejects unsafe numeric bounds, breakpoint shape mismatches, and free evaluate expressions", () => {
    expect(
      parseStackTraceRequest({
        schemaVersion,
        sessionId: opaqueId,
        pauseGeneration: 0,
        cursor: "cursor_1",
        levels: 1,
      }),
    ).toMatchObject({ ok: true });
    for (const candidate of [
      { startFrame: 1, levels: 1 },
      { startFrame: 0, cursor: "cursor_1", levels: 1 },
      { levels: 1 },
    ]) {
      expect(
        parseStackTraceRequest({
          schemaVersion,
          sessionId: opaqueId,
          pauseGeneration: 0,
          ...candidate,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(
      parseDebugSessionControlRequest({
        schemaVersion,
        sessionId: opaqueId,
        action: "continue",
        pauseGeneration: -1,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseSetBreakpointsRequest({
        schemaVersion,
        workspaceId,
        expectedRevision: Number.MAX_VALUE,
        fileId,
        breakpoints: [{ ...breakpoint, line: 0 }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseSetBreakpointsRequest({
        schemaVersion,
        workspaceId,
        expectedRevision: 0,
        fileId,
        breakpoints: [{ ...breakpoint, fileId: "src/other.ts" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEvaluateWatchRequest({
        schemaVersion,
        sessionId: opaqueId,
        pauseGeneration: 0,
        watchId: "watch_1",
        expression: "process.exit()",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseSetVariableRequest({
        schemaVersion,
        sessionId: opaqueId,
        pauseGeneration: 0,
        variableRef: "variable_1",
        value: "next",
        expression: "globalThis.compromised = true",
      }),
    ).toMatchObject({ ok: false });
  });

  it.each(validRequests)("catches a throwing proxy for %s without throwing", (_name, parser) => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile");
        },
      },
    );
    expect(() => parser(hostile)).not.toThrow();
    expect(parser(hostile)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: Error"],
    });
  });
});

describe("UTF-8-safe debug projections", () => {
  it("preserves complete multibyte code points and reports exact omitted bytes", () => {
    const projected = projectDebugText(`ab😀éz12345`, 13);
    expect(projected).toEqual({
      value: `ab${DEBUG_TRUNCATION_MARKER}`,
      truncated: true,
      originalBytes: 14,
      retainedBytes: 13,
      omittedBytes: 12,
    });
    expect(new TextEncoder().encode(projected.value).length).toBeLessThanOrEqual(13);
  });

  it("does not mark already bounded text as truncated", () => {
    expect(projectDebugText("😀", 4)).toEqual({
      value: "😀",
      truncated: false,
      originalBytes: 4,
      retainedBytes: 4,
      omittedBytes: 0,
    });
  });

  it("caps depth, width, and graph nodes with typed sentinels", () => {
    const deep: DebugVariableInput = {
      name: "depth-0",
      value: "0",
      children: [
        {
          name: "depth-1",
          value: "1",
          children: [
            {
              name: "depth-2",
              value: "2",
              children: [
                {
                  name: "depth-3",
                  value: "3",
                  children: [{ name: "depth-4", value: "4" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const wide: DebugVariableInput = {
      name: "wide",
      value: "root",
      children: Array.from(
        { length: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode + 10 },
        (_, index) => ({
          name: `child-${String(index)}`,
          type: "x".repeat(300),
          value: "😀".repeat(2_000),
        }),
      ),
    };
    const graph = Array.from({ length: 10 }, (_, index) => ({
      name: `root-${String(index)}`,
      value: "root",
      children: Array.from({ length: 200 }, (__, child) => ({
        name: `${String(index)}-${String(child)}`,
        value: "value",
      })),
    }));
    const tree = buildDebugVariableTree([deep, wide, ...graph]);
    expect(tree.truncated).toBe(true);
    expect(tree.nodeCount).toBeLessThanOrEqual(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxGraphNodes);
    expect(tree.nodes.length).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxVariablesPerExpansion,
    );

    const visit = (nodes: typeof tree.nodes, depth: number): void => {
      expect(depth).toBeLessThanOrEqual(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxDepth);
      expect(nodes.length).toBeLessThanOrEqual(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode);
      for (const node of nodes) {
        if (node.kind === "truncated") {
          expect(node.truncated).toBe(true);
          expect(node.omittedCount).toBeGreaterThan(0);
          continue;
        }
        expect(node.name.retainedBytes).toBeLessThanOrEqual(
          DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes,
        );
        expect(node.value.retainedBytes).toBeLessThanOrEqual(
          DEFAULT_DEBUG_PAYLOAD_LIMITS.maxValueBytes,
        );
        if (node.type !== undefined) {
          expect(node.type.retainedBytes).toBeLessThanOrEqual(
            DEFAULT_DEBUG_PAYLOAD_LIMITS.maxTypeBytes,
          );
        }
        visit(node.children, depth + 1);
      }
    };
    visit(tree.nodes, 0);
    expect(JSON.stringify(tree)).toContain('"kind":"truncated"');
  });

  it("caps stack, scopes, watches, and output with honest metadata", () => {
    const frames = Array.from({ length: 150 }, (_, index) => ({
      frameRef: `frame_${String(index)}`,
      name: "😀".repeat(300),
      line: 1,
      column: 1,
    }));
    const scopes = Array.from({ length: 40 }, (_, index) => ({
      scopeRef: `scope_${String(index)}`,
      name: "é".repeat(300),
      expensive: false,
    }));
    const stack = buildStackPage(frames, 0);
    const scopeProjection = buildScopeProjection(scopes);
    const watchResult = buildWatchEvaluationResult({
      watchId: "watch_1",
      pauseGeneration: 1,
      state: "value",
      value: "😀".repeat(2_000),
      type: "é".repeat(300),
    });
    const output = buildDebugOutputEvent("session_1", "stdout", "😀".repeat(8_000));
    expect(stack.frames).toHaveLength(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage);
    expect(stack.retainedCount).toBe(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames);
    expect(stack.omittedCount).toBe(22);
    expect(stack.truncated).toBe(true);
    expect(scopeProjection.scopes).toHaveLength(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxScopesPerFrame);
    expect(scopeProjection.omittedCount).toBe(8);
    expect(watchResult.value?.retainedBytes).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatchValueBytes,
    );
    expect(watchResult.type?.retainedBytes).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatchTypeBytes,
    );
    expect(new TextEncoder().encode(output.text).length).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxOutputBytes,
    );
    expect(output.truncated).toBe(true);
    const event = output satisfies DebugEvent;
    expect(event.kind).toBe("output");
  });
});
