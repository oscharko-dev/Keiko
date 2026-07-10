import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentConflictCode,
  type EditorAgentFailureCode,
  type EditorAgentSessionSnapshot,
  type EditorAgentVerificationResult,
  type ToolCallResult,
} from "@oscharko-dev/keiko-contracts";
import {
  EditorAgentHttpClient,
  type EditorAgentHttpTransport,
  type EditorAgentHttpTransportRequest,
  type EditorAgentHttpTransportResponse,
} from "./editor-agent-client.js";
import { EditorAgentToolHost } from "./editor-agent-tool-host.js";

const HASH = "a".repeat(64);
const encoder = new TextEncoder();

function snapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot: "/repo",
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}

function queued(action: EditorAgentAction): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "queued",
  };
}

interface RecordingRoute {
  readonly requests: EditorAgentHttpTransportRequest[];
  readonly transport: EditorAgentHttpTransport;
}

const COMPLETED_VERIFICATION: EditorAgentVerificationResult = {
  outcome: "completed",
  report: {
    overallStatus: "passed",
    durationMs: 5,
    counts: {
      passed: 1,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
    steps: [{ kind: "typecheck", status: "passed", durationMs: 5 }],
  },
};

function recordingRoute(
  actionResult: (action: EditorAgentAction) => EditorAgentActionResult = queued,
  verificationResult: EditorAgentVerificationResult = COMPLETED_VERIFICATION,
): RecordingRoute {
  const requests: EditorAgentHttpTransportRequest[] = [];
  return {
    requests,
    transport: {
      request: (request): Promise<EditorAgentHttpTransportResponse> => {
        requests.push(request);
        const body = request.body === undefined ? undefined : (JSON.parse(request.body) as unknown);
        const route = new URL(request.url).pathname;
        const response = route.endsWith("/sessions")
          ? { sessions: [snapshot()] }
          : route.endsWith("/snapshot")
            ? { snapshot: snapshot() }
            : route.endsWith("/agent-runs")
              ? { result: verificationResult }
              : { result: actionResult(body as EditorAgentAction) };
        return Promise.resolve({
          status: route.endsWith("/actions") ? 202 : 200,
          body: encoder.encode(JSON.stringify(response)),
          url: request.url,
          redirected: false,
        });
      },
    },
  };
}

function host(route: RecordingRoute): EditorAgentToolHost {
  let id = 0;
  return new EditorAgentToolHost({
    client: new EditorAgentHttpClient({
      baseUrl: "http://127.0.0.1:1983",
      transport: route.transport,
    }),
    authorityRef: { runId: "run-1", envelopeDigest: HASH },
    nextActionId: () => `action-${String((id += 1))}`,
    now: () => 10,
  });
}

async function execute(
  toolHost: EditorAgentToolHost,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return toolHost.execute({
    toolCallId: `call-${toolName}`,
    toolName,
    arguments: args,
    signal: new AbortController().signal,
  });
}

function parseOutput(result: ToolCallResult): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

const VERSION = { sizeBytes: 10, modifiedAt: 20, contentHash: HASH };
const IDEMPOTENCY_KEY = "model-idempotency";
const RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

describe("EditorAgentToolHost route dispatch", () => {
  it("lists sessions with one GET", async () => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_list_sessions", {});
    expect(parseOutput(result)).toMatchObject({ ok: true, kind: "sessions" });
    expect(route.requests).toHaveLength(1);
    expect(route.requests[0]).toMatchObject({ method: "GET" });
  });

  it("requests snapshots with textMode none by default", async () => {
    const route = recordingRoute();
    await execute(host(route), "editor_snapshot", { sessionId: "session-1" });
    expect(JSON.parse(route.requests[0]?.body ?? "null")).toEqual({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      sessionId: "session-1",
      textMode: "none",
    });
  });

  it.each([
    [
      "openFile",
      {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "openFile",
        file: "src/a.ts",
      },
    ],
    [
      "focusTab",
      {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "focusTab",
        file: "src/a.ts",
      },
    ],
    [
      "setSelection",
      {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "setSelection",
        selection: RANGE,
      },
    ],
  ])("posts the %s navigation action shape", async (type, args) => {
    const route = recordingRoute();
    await execute(host(route), "editor_navigate", args);
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action).toMatchObject({ type, sessionId: "session-1" });
    expect(action.target).toEqual(
      type === "setSelection" ? { selection: RANGE } : { file: "src/a.ts" },
    );
  });

  it("queues symbol navigation with a bounded document overlay", async () => {
    const route = recordingRoute();
    await execute(host(route), "editor_navigate_symbol", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      file: "src/a.ts",
      operation: "definition",
      position: { line: 0, character: 3 },
      languageId: "typescript",
      text: "const value = 1;\nvalue;",
    });
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action).toMatchObject({
      type: "navigateSymbol",
      target: { file: "src/a.ts" },
      navigateSymbol: {
        operation: "definition",
        document: { path: "src/a.ts", languageId: "typescript", text: "const value = 1;\nvalue;" },
        position: { line: 0, character: 3 },
      },
    });
  });

  it("queues bounded text and symbol workspace searches", async () => {
    const route = recordingRoute();
    await execute(host(route), "editor_search_workspace", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      query: "parseConfig",
      mode: "symbol",
      maxResults: 3,
      scopePath: "src",
    });
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action).toMatchObject({
      type: "searchWorkspace",
      target: { file: "src" },
      searchWorkspace: {
        mode: "symbol",
        query: "parseConfig",
        maxResults: 3,
        scopePath: "src",
      },
    });
  });

  it.each(["references", "renamePrepare", "signatureHelp"] as const)(
    "queues the %s symbol navigation operation",
    async (operation) => {
      const route = recordingRoute();
      await execute(host(route), "editor_navigate_symbol", {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        file: "src/a.ts",
        operation,
        position: { line: 0, character: 0 },
      });
      expect(JSON.parse(route.requests[0]?.body ?? "null")).toMatchObject({
        type: "navigateSymbol",
        navigateSymbol: { operation },
      });
    },
  );

  it("queues code actions with diagnostics and a range", async () => {
    const route = recordingRoute();
    await execute(host(route), "editor_navigate_symbol", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      file: "src/a.ts",
      operation: "codeActions",
      position: { line: 0, character: 0 },
      range: RANGE,
      diagnostics: [
        { range: RANGE, severity: "error", message: "error", source: "ts", code: "E1" },
        { range: RANGE, severity: "warning", message: "warning", source: "ts" },
        { range: RANGE, severity: "info", message: "info", source: "ts" },
        { range: RANGE, severity: "hint", message: "hint", source: "ts" },
      ],
    });
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action.navigateSymbol).toMatchObject({ operation: "codeActions", range: RANGE });
    expect(action.navigateSymbol?.diagnostics).toHaveLength(4);
  });

  it("queues a fully scoped text search with optional filters", async () => {
    const route = recordingRoute();
    await execute(host(route), "editor_search_workspace", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      query: "parse config",
      mode: "text",
      caseSensitive: true,
      includeGlobs: ["src/**/*.ts"],
      excludeGlobs: ["**/*.test.ts"],
      maxResults: 10,
      scopePath: "src",
    });
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action.searchWorkspace).toMatchObject({
      mode: "text",
      query: "parse config",
      caseSensitive: true,
      includeGlobs: ["src/**/*.ts"],
      excludeGlobs: ["**/*.test.ts"],
      maxResults: 10,
      scopePath: "src",
    });
  });

  it.each([
    [
      "applyTextEdits",
      {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "applyTextEdits",
        file: "src/a.ts",
        expectedDocumentVersion: VERSION,
        textEdits: [{ range: RANGE, newText: "x" }],
      },
    ],
    [
      "applyPatch",
      {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "applyPatch",
        file: "src/a.ts",
        expectedContentHash: HASH,
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      },
    ],
  ])("posts the %s proposal without interpreting mutation content", async (type, args) => {
    const route = recordingRoute();
    await execute(host(route), "editor_propose_edit", args);
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action).toMatchObject({ type, target: { file: "src/a.ts" } });
    expect(route.requests).toHaveLength(1);
  });

  it("posts the applyChangeset contract shape intact", async () => {
    const route = recordingRoute();
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    await execute(host(route), "editor_propose_changeset", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      patch,
      files: [{ file: "src/a.ts", expectedContentHash: HASH }],
      selectedFiles: ["src/a.ts"],
    });
    const action = JSON.parse(route.requests[0]?.body ?? "null") as EditorAgentAction;
    expect(action).toMatchObject({
      type: "applyChangeset",
      changeset: {
        patch,
        files: [{ file: "src/a.ts", expectedContentHash: HASH }],
        selectedFiles: ["src/a.ts"],
      },
    });
  });

  it("attaches injected authority and action ids while preserving model idempotency keys", async () => {
    const route = recordingRoute();
    const toolHost = host(route);
    await execute(toolHost, "editor_navigate", {
      sessionId: "session-1",
      idempotencyKey: "model-key-1",
      type: "openFile",
      file: "src/a.ts",
    });
    await execute(toolHost, "editor_propose_edit", {
      sessionId: "session-1",
      idempotencyKey: "model-key-2",
      type: "applyTextEdits",
      file: "src/a.ts",
      textEdits: [{ range: RANGE, newText: "x" }],
    });
    await execute(toolHost, "editor_propose_changeset", {
      sessionId: "session-1",
      idempotencyKey: "model-key-3",
      patch: "patch",
      files: [{ file: "src/a.ts", expectedContentHash: HASH }],
    });
    const actions = route.requests.map(
      (request) => JSON.parse(request.body ?? "null") as EditorAgentAction,
    );
    expect(actions.map((action) => action.authorityRef)).toEqual([
      { runId: "run-1", envelopeDigest: HASH },
      { runId: "run-1", envelopeDigest: HASH },
      { runId: "run-1", envelopeDigest: HASH },
    ]);
    expect(actions.map((action) => action.actionId)).toEqual(["action-1", "action-2", "action-3"]);
    expect(actions.map((action) => action.idempotencyKey)).toEqual([
      "model-key-1",
      "model-key-2",
      "model-key-3",
    ]);
  });

  it("rejects model-supplied authority instead of widening injected authority", async () => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_navigate", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      type: "openFile",
      file: "src/a.ts",
      authorityRef: { runId: "attacker", envelopeDigest: "b".repeat(64) },
    });
    expect(parseOutput(result)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(route.requests).toHaveLength(0);
  });

  it.each([
    [
      "editor_navigate",
      { sessionId: "session-1", idempotencyKey: IDEMPOTENCY_KEY, type: "openFile" },
    ],
    [
      "editor_propose_edit",
      {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "applyPatch",
        file: "src/a.ts",
      },
    ],
    [
      "editor_propose_changeset",
      { sessionId: "session-1", idempotencyKey: IDEMPOTENCY_KEY, patch: "patch", files: [] },
    ],
  ])("returns an invalid result for missing %s arguments", async (toolName, args) => {
    const route = recordingRoute();
    const result = await execute(host(route), toolName, args);
    expect(parseOutput(result)).toMatchObject({
      ok: false,
      error: { kind: "invalid-arguments", code: "INVALID_ARGUMENTS" },
    });
    expect(route.requests).toHaveLength(0);
  });

  it.each([
    ["editor_navigate", { sessionId: "session-1", type: "openFile", file: "src/a.ts" }],
    [
      "editor_propose_edit",
      { sessionId: "session-1", type: "applyPatch", file: "src/a.ts", patch: "patch" },
    ],
    [
      "editor_propose_changeset",
      {
        sessionId: "session-1",
        patch: "patch",
        files: [{ file: "src/a.ts", expectedContentHash: HASH }],
      },
    ],
  ])("rejects a missing model idempotency key for %s", async (toolName, args) => {
    const route = recordingRoute();
    const result = await execute(host(route), toolName, args);
    expect(parseOutput(result)).toMatchObject({
      ok: false,
      error: { kind: "invalid-arguments", code: "INVALID_ARGUMENTS" },
    });
    expect(route.requests).toHaveLength(0);
  });

  it.each([
    ["invalid operation", { operation: "implementation" }],
    ["missing code-action extras", { operation: "codeActions" }],
    ["unexpected code-action extras", { operation: "definition", range: RANGE }],
  ])("rejects %s for symbol navigation", async (_label, extras) => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_navigate_symbol", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      file: "src/a.ts",
      position: { line: 0, character: 0 },
      ...extras,
    });
    expect(parseOutput(result)).toMatchObject({
      ok: false,
      error: { kind: "invalid-arguments", code: "INVALID_ARGUMENTS" },
    });
    expect(route.requests).toHaveLength(0);
  });

  it.each([
    ["invalid mode", { mode: "regex" }],
    ["invalid caseSensitive", { mode: "text", caseSensitive: "yes" }],
    ["invalid includeGlobs type", { mode: "text", includeGlobs: "src" }],
    ["empty includeGlob", { mode: "text", includeGlobs: [""] }],
    [
      "too many includeGlobs",
      { mode: "text", includeGlobs: Array.from({ length: 33 }, () => "*.ts") },
    ],
  ])("rejects %s for workspace search", async (_label, extras) => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_search_workspace", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      query: "query",
      ...extras,
    });
    expect(parseOutput(result)).toMatchObject({
      ok: false,
      error: { kind: "invalid-arguments", code: "INVALID_ARGUMENTS" },
    });
    expect(route.requests).toHaveLength(0);
  });
});

function conflictResult(
  code: EditorAgentConflictCode,
  action: EditorAgentAction,
): EditorAgentActionResult {
  const message = `redacted ${code}`;
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "conflict",
    message,
    conflict: { code, message },
  };
}

function failureResult(
  code: EditorAgentFailureCode,
  action: EditorAgentAction,
): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "failed",
    failure: { code, message: `redacted ${code}` },
  };
}

describe("EditorAgentToolHost route outcomes", () => {
  it.each(EDITOR_AGENT_CONFLICT_CODES)("preserves the %s route conflict", async (code) => {
    const route = recordingRoute((action) => conflictResult(code, action));
    const result = await execute(host(route), "editor_propose_edit", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      type: "applyTextEdits",
      file: "src/a.ts",
      textEdits: [{ range: RANGE, newText: "x" }],
    });
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      kind: "action-result",
      result: { status: "conflict", conflict: { code } },
    });
  });

  it.each(["NO_ACTIVE_SESSION", "NO_ACTIVE_BRIDGE"] as const)(
    "preserves the navigation %s conflict",
    async (code) => {
      const route = recordingRoute((action) => conflictResult(code, action));
      const result = await execute(host(route), "editor_navigate", {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        type: "focusTab",
        file: "src/a.ts",
      });
      expect(parseOutput(result)).toMatchObject({ result: { conflict: { code } } });
    },
  );

  it("surfaces PRECONDITION_REQUIRED unchanged when the route returns it", async () => {
    const route = recordingRoute((action) => conflictResult("PRECONDITION_REQUIRED", action));
    const result = await execute(host(route), "editor_propose_edit", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      type: "applyPatch",
      file: "src/a.ts",
      patch: "patch",
    });
    expect(parseOutput(result)).toMatchObject({
      result: { conflict: { code: "PRECONDITION_REQUIRED" } },
    });
  });

  it("preserves the server sensitive-path deny mapping as OUT_OF_SCOPE", async () => {
    const route = recordingRoute((action) => conflictResult("OUT_OF_SCOPE", action));
    const result = await execute(host(route), "editor_propose_edit", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      type: "applyTextEdits",
      file: ".env",
      expectedContentHash: HASH,
      textEdits: [{ range: RANGE, newText: "secret" }],
    });
    expect(parseOutput(result)).toMatchObject({
      result: { status: "conflict", conflict: { code: "OUT_OF_SCOPE" } },
    });
  });

  it("preserves typed route failures without throwing", async () => {
    const routeMessage = `SECRET_VALUE ${"x".repeat(4_096)}`;
    const route = recordingRoute((action) => ({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      status: "failed",
      failure: { code: "QUEUE_FULL", message: routeMessage },
    }));
    const result = await execute(host(route), "editor_navigate", {
      sessionId: "session-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      type: "openFile",
      file: "src/a.ts",
    });
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      result: {
        status: "failed",
        failure: { code: "QUEUE_FULL", message: "Editor agent route detail redacted." },
      },
    });
    expect(result.output).not.toContain("SECRET_VALUE");
    expect(result.output.length).toBeLessThan(512);
  });

  // Issue #2116 — editor_propose_changeset had zero conflict/failure pass-through coverage, and
  // the route-returned TIMED_OUT failure was never exercised through any tool at this layer.
  it.each(EDITOR_AGENT_CONFLICT_CODES)(
    "preserves the %s route conflict for a changeset proposal",
    async (code) => {
      const route = recordingRoute((action) => conflictResult(code, action));
      const result = await execute(host(route), "editor_propose_changeset", {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        patch: "patch",
        files: [{ file: "src/a.ts", expectedContentHash: HASH }],
      });
      expect(parseOutput(result)).toMatchObject({
        ok: true,
        kind: "action-result",
        result: { status: "conflict", conflict: { code } },
      });
    },
  );

  it.each(EDITOR_AGENT_FAILURE_CODES)(
    "preserves the %s route failure for a changeset proposal",
    async (code) => {
      const route = recordingRoute((action) => failureResult(code, action));
      const result = await execute(host(route), "editor_propose_changeset", {
        sessionId: "session-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        patch: "patch",
        files: [{ file: "src/a.ts", expectedContentHash: HASH }],
      });
      expect(parseOutput(result)).toMatchObject({
        ok: true,
        kind: "action-result",
        result: {
          status: "failed",
          failure: { code, message: "Editor agent route detail redacted." },
        },
      });
    },
  );
});

describe("EditorAgentToolHost editor_request_verification", () => {
  it("dispatches one verification call with the injected authorityRef and maps the report", async () => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_request_verification", {
      sessionId: "session-1",
      kind: "typecheck",
    });
    const agentRuns = route.requests.filter((request) => request.url.endsWith("/agent-runs"));
    expect(agentRuns).toHaveLength(1);
    const body = JSON.parse(agentRuns[0]?.body ?? "{}") as Record<string, unknown>;
    // The model never supplies authorityRef; the host attaches its constructor-validated reference.
    expect(body).toMatchObject({
      schemaVersion: "1",
      sessionId: "session-1",
      kind: "typecheck",
      authorityRef: { runId: "run-1", envelopeDigest: HASH },
    });
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      kind: "verification",
      result: { outcome: "completed", report: { overallStatus: "passed" } },
    });
  });

  it("forwards the optional targetPath for a targeted-test request", async () => {
    const route = recordingRoute();
    await execute(host(route), "editor_request_verification", {
      sessionId: "session-1",
      kind: "targeted-test",
      targetPath: "src/a.test.ts",
    });
    const body = JSON.parse(
      route.requests.find((request) => request.url.endsWith("/agent-runs"))?.body ?? "{}",
    ) as Record<string, unknown>;
    expect(body.targetPath).toBe("src/a.test.ts");
  });

  it("surfaces a governance not-run disposition as a typed, non-throwing output", async () => {
    const route = recordingRoute(queued, {
      outcome: "not-run",
      disposition: "review-required",
      reason: "mode-approval-required",
    });
    const result = await execute(host(route), "editor_request_verification", {
      sessionId: "session-1",
      kind: "build",
    });
    expect(parseOutput(result)).toMatchObject({
      ok: true,
      kind: "verification",
      result: {
        outcome: "not-run",
        disposition: "review-required",
        reason: "mode-approval-required",
      },
    });
  });

  it("rejects an unsupported verification kind before any route call", async () => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_request_verification", {
      sessionId: "session-1",
      kind: "deploy",
    });
    expect(route.requests).toHaveLength(0);
    expect(parseOutput(result)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
  });

  it("rejects unsupported argument properties", async () => {
    const route = recordingRoute();
    const result = await execute(host(route), "editor_request_verification", {
      sessionId: "session-1",
      kind: "lint",
      authorityRef: { runId: "attacker", envelopeDigest: HASH },
    });
    expect(route.requests).toHaveLength(0);
    expect(parseOutput(result)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });
});
