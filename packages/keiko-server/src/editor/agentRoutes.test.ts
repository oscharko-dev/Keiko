import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { STREAMING, type RouteContext } from "../routes.js";
import {
  _resetEditorAgentStateForTests,
  handleEditorAgentActions,
  handleEditorAgentEvents,
  handleEditorAgentSessions,
  handleEditorAgentSnapshot,
} from "./agentRoutes.js";

const HASH = "a".repeat(64);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionResultStatus(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result)) return undefined;
  return typeof body.result.status === "string" ? body.result.status : undefined;
}

function context(body: unknown = {}, path = "/api/editor/agent/actions"): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

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
    documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
    activeFileContentHash: HASH,
    textMode: "none",
    updatedAt: 1,
  };
}

function action(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "action-1",
    idempotencyKey: "idempotency-1",
    sessionId: "session-1",
    type: "save",
    expectedContentHash: HASH,
    ...overrides,
  };
}

afterEach(() => {
  _resetEditorAgentStateForTests();
});

describe("editor agent routes", () => {
  it("registers browser snapshots and lists sessions", async () => {
    const registered = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: snapshot(),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    expect(registered.status).toBe(200);
    expect(handleEditorAgentSessions().body).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "session-1" })],
    });
  });

  it("requires an active browser bridge before queueing write actions", async () => {
    const result = await handleEditorAgentActions(context(action()));
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
  });

  it("queues actions idempotently and rejects divergent replays", async () => {
    await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: snapshot(),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const first = await handleEditorAgentActions(context(action()));
    const replay = await handleEditorAgentActions(context(action()));
    const divergent = await handleEditorAgentActions(context(action({ type: "format" })));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(divergent.status).toBe(409);
  });

  it("opens an SSE stream with a ready frame", () => {
    const writes: string[] = [];
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const req = {
      on: vi.fn(),
    } as unknown as IncomingMessage;
    const result = handleEditorAgentEvents({
      req,
      res,
      params: {},
      url: new URL("http://localhost/api/editor/agent/events"),
    });
    expect(result).toBe(STREAMING);
    expect(writes.join("")).toContain("event: ready");
  });
});
