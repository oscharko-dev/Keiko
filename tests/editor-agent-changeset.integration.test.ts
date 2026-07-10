import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentEvent,
  type EditorAgentAction,
  type EditorAgentSessionSnapshot,
  type ToolCallResult,
  type ToolPort,
} from "@oscharko-dev/keiko-contracts";
import { buildPatchPreview, type PatchPreviewSource } from "@oscharko-dev/keiko-editor";
import {
  EditorAgentHttpClient,
  EditorAgentToolHost,
  type EditorAgentHttpTransport,
  type EditorAgentHttpTransportRequest,
  type EditorAgentHttpTransportResponse,
  type EditorAgentToolOutput,
} from "@oscharko-dev/keiko-tools";
import { describe, expect, it, vi } from "vitest";

import {
  _resetEditorAgentStateForTests,
  handleEditorAgentActions,
  handleEditorAgentEvents,
  handleEditorAgentSessions,
  handleEditorAgentSnapshot,
} from "../packages/keiko-server/src/editor/agentRoutes.js";
import {
  STREAMING,
  type RouteContext,
  type RouteResult,
} from "../packages/keiko-server/src/routes.js";
const BASE_URL = "http://127.0.0.1:1983";
const EDITOR_AGENT_CHANGESET_MODULE =
  "../packages/keiko-ui/src/app/components/desktop/widgets/cards/editorAgentChangeset.js";
const SESSION_ID = "session-2117";
const ACTION_ID = "action-2117";
const AUTHORITY_REF = { runId: "run-2117", envelopeDigest: "d".repeat(64) } as const;
const FILES = [
  { path: "src/a.txt", before: "A0\n", after: "A1\n" },
  { path: "src/b.txt", before: "B0\n", after: "B1\n" },
] as const;
const PATCH = [
  "--- a/src/a.txt",
  "+++ b/src/a.txt",
  "@@ -1 +1 @@",
  "-A0",
  "+A1",
  "--- a/src/b.txt",
  "+++ b/src/b.txt",
  "@@ -1 +1 @@",
  "-B0",
  "+B1",
].join("\n");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type PreparedChangeset = NonNullable<NonNullable<EditorAgentAction["changeset"]>["prepared"]>;
type ChangesetPatchBuilder = (input: {
  readonly actionId: string;
  readonly prepared: PreparedChangeset;
}) => Parameters<typeof buildPatchPreview>[0]["patch"];

interface EditorAgentChangesetModule {
  readonly buildEditorAgentChangesetPatch: ChangesetPatchBuilder;
}

interface WorkspaceFixture {
  readonly root: string;
  readonly sources: Readonly<Record<string, PatchPreviewSource>>;
}

interface CapturedBridge {
  readonly frames: () => string;
  readonly close: () => void;
}

function importEditorAgentChangesetModule(moduleName: string): Promise<EditorAgentChangesetModule> {
  return import(moduleName) as Promise<EditorAgentChangesetModule>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function source(path: string, text: string): PatchPreviewSource {
  return {
    content: {
      relativePath: path,
      text,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
    },
  };
}

function createWorkspace(): WorkspaceFixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-editor-agent-changeset-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const sources: Record<string, PatchPreviewSource> = {};
  for (const file of FILES) {
    writeFileSync(join(root, file.path), file.before, "utf8");
    sources[file.path] = source(file.path, file.before);
  }
  return { root, sources };
}

function postContext(url: string, body: string): RouteContext {
  const req = Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  req.method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(url),
  };
}

function snapshotFor(workspace: WorkspaceFixture): EditorAgentSessionSnapshot {
  const activeFile = FILES[0];
  const stats = statSync(join(workspace.root, activeFile.path));
  const contentHash = sha256(activeFile.before);
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    windowId: "window-2117",
    workspaceRoot: workspace.root,
    activePaneId: "pane-2117",
    panes: [
      { paneId: "pane-2117", activeFile: activeFile.path, openFiles: FILES.map((f) => f.path) },
    ],
    dirtyFiles: [],
    activeFile: activeFile.path,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    documentVersion: { sizeBytes: stats.size, modifiedAt: stats.mtimeMs, contentHash },
    activeFileContentHash: contentHash,
    textMode: "none",
    updatedAt: 2_117,
  };
}

function registerSnapshot(workspace: WorkspaceFixture): Promise<RouteResult> {
  const body = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    kind: "snapshot",
    snapshot: snapshotFor(workspace),
  };
  return handleEditorAgentSnapshot(
    postContext(`${BASE_URL}/api/editor/agent/snapshot`, JSON.stringify(body)),
  );
}

function connectBridge(bridgeDecisionCapability: string): CapturedBridge {
  const writes: string[] = [];
  const closeHandlers: (() => void)[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string): boolean => {
      writes.push(chunk);
      return true;
    }),
    on: vi.fn((event: string, callback: () => void): void => {
      if (event === "close") closeHandlers.push(callback);
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ServerResponse;
  const req = { on: vi.fn() } as unknown as IncomingMessage;
  const query = new URLSearchParams({
    sessionId: SESSION_ID,
    bridgeDecisionCapability,
  }).toString();
  const outcome = handleEditorAgentEvents({
    req,
    res,
    params: {},
    url: new URL(`${BASE_URL}/api/editor/agent/events?${query}`),
  });
  if (outcome !== STREAMING) throw new Error("expected streaming editor agent bridge");
  return {
    frames: (): string => writes.join(""),
    close: (): void => {
      for (const callback of closeHandlers) callback();
    },
  };
}

async function dispatchRoute(request: EditorAgentHttpTransportRequest): Promise<RouteResult> {
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/api/editor/agent/sessions") {
    return handleEditorAgentSessions();
  }
  if (
    request.method === "POST" &&
    pathname === "/api/editor/agent/actions" &&
    request.body !== undefined
  ) {
    return handleEditorAgentActions(postContext(request.url, request.body));
  }
  throw new Error(`unexpected in-memory editor agent route: ${request.method} ${pathname}`);
}

class InMemoryEditorAgentHttpTransport implements EditorAgentHttpTransport {
  readonly requests: EditorAgentHttpTransportRequest[] = [];

  async request(
    request: EditorAgentHttpTransportRequest,
  ): Promise<EditorAgentHttpTransportResponse> {
    this.requests.push(request);
    const result = await dispatchRoute(request);
    return {
      status: result.status,
      body: encoder.encode(JSON.stringify(result.body)),
      url: request.url,
      redirected: false,
    };
  }
}

function parseToolOutput(result: ToolCallResult): EditorAgentToolOutput {
  return JSON.parse(result.output) as EditorAgentToolOutput;
}

function emittedAction(frames: string): EditorAgentAction {
  const frame = frames
    .split("\n\n")
    .filter((candidate) => candidate.includes("event: editor-agent:action"))
    .at(-1);
  const data = frame?.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("expected an emitted editor agent action");
  const event: unknown = JSON.parse(data.slice("data: ".length));
  if (!isEditorAgentEvent(event) || event.type !== "action") {
    throw new Error("expected a valid editor agent action event");
  }
  return event.action;
}

function createToolPort(client: EditorAgentHttpClient): ToolPort {
  return new EditorAgentToolHost({
    client,
    authorityRef: AUTHORITY_REF,
    nextActionId: () => ACTION_ID,
    now: () => 2_117,
  });
}

function proposeChangeset(toolPort: ToolPort): Promise<ToolCallResult> {
  return toolPort.execute({
    toolCallId: "tool-call-2117",
    toolName: "editor_propose_changeset",
    arguments: {
      sessionId: SESSION_ID,
      idempotencyKey: "idempotency-2117",
      patch: PATCH,
      files: FILES.map((file) => ({
        file: file.path,
        expectedContentHash: sha256(file.before),
      })),
    },
    signal: new AbortController().signal,
  });
}

function requirePrepared(action: EditorAgentAction): PreparedChangeset {
  const prepared = action.changeset?.prepared;
  if (prepared === undefined) throw new Error("expected a server-prepared changeset");
  return prepared;
}

function assertEmittedChangeset(action: EditorAgentAction): PreparedChangeset {
  expect(action).toMatchObject({
    actionId: ACTION_ID,
    sessionId: SESSION_ID,
    type: "applyChangeset",
    authorityRef: AUTHORITY_REF,
    changeset: {
      patch: PATCH,
      files: FILES.map((file) => ({
        file: file.path,
        expectedContentHash: sha256(file.before),
      })),
    },
  });
  const prepared = requirePrepared(action);
  expect(prepared).toEqual({
    files: FILES.map((file) => ({
      file: file.path,
      kind: "modify",
      textEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
          newText: file.after,
        },
      ],
    })),
  });
  return prepared;
}

async function assertReviewModel(
  prepared: PreparedChangeset,
  sources: Readonly<Record<string, PatchPreviewSource>>,
): Promise<void> {
  const { buildEditorAgentChangesetPatch } = await importEditorAgentChangesetModule(
    EDITOR_AGENT_CHANGESET_MODULE,
  );
  const patch = buildEditorAgentChangesetPatch({ actionId: ACTION_ID, prepared });
  const model = buildPatchPreview({ patch, sources });
  expect(model).toMatchObject({
    patchId: `agent-changeset:${ACTION_ID}`,
    fileCount: 2,
    totalFileCount: 2,
    modifiedCount: 2,
    createdCount: 0,
    deletedCount: 0,
    omittedFileCount: 0,
    truncated: false,
  });
  expect(model.files).toHaveLength(FILES.length);
  for (const file of FILES) {
    const reviewed = model.files.find((candidate) => candidate.uri === file.path);
    expect(reviewed).toBeDefined();
    expect(reviewed).toMatchObject({
      uri: file.path,
      displayPath: file.path,
      status: "modified",
      diffable: true,
      original: file.before,
      modified: file.after,
      hasChanges: true,
    });
  }
}

function postFailedBrowserResult(
  transport: EditorAgentHttpTransport,
  action: EditorAgentAction,
  bridgeDecisionCapability: string,
): Promise<EditorAgentHttpTransportResponse> {
  return transport.request({
    method: "POST",
    url: `${BASE_URL}/api/editor/agent/actions`,
    body: JSON.stringify({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "result",
      bridgeDecisionCapability,
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: action.actionId,
        sessionId: action.sessionId,
        status: "failed",
      },
    }),
    signal: new AbortController().signal,
    maxResponseBytes: 256 * 1024,
  });
}

function decodedBody(response: EditorAgentHttpTransportResponse): unknown {
  return JSON.parse(decoder.decode(response.body)) as unknown;
}

function registeredBridgeCapability(result: RouteResult): string {
  const body = result.body;
  if (typeof body !== "object" || body === null) throw new Error("expected registration body");
  const capability = (body as { bridgeDecisionCapability?: unknown }).bridgeDecisionCapability;
  if (typeof capability !== "string") throw new Error("expected bridge decision capability");
  return capability;
}

function assertWorkspaceUnchanged(workspace: WorkspaceFixture): void {
  for (const file of FILES) {
    expect(readFileSync(join(workspace.root, file.path), "utf8")).toBe(file.before);
  }
}

describe("editor agent changeset cross-package integration (#2117)", () => {
  it("reaches a two-file review model without mutating the workspace", async () => {
    _resetEditorAgentStateForTests();
    const workspace = createWorkspace();
    let bridge: CapturedBridge | undefined;
    try {
      const registration = await registerSnapshot(workspace);
      expect(registration.status).toBe(200);
      const bridgeDecisionCapability = registeredBridgeCapability(registration);
      bridge = connectBridge(bridgeDecisionCapability);
      const transport = new InMemoryEditorAgentHttpTransport();
      const client = new EditorAgentHttpClient({ baseUrl: BASE_URL, transport });
      const sessions = await client.listSessions(new AbortController().signal);
      expect(sessions).toMatchObject({
        ok: true,
        value: { sessions: [{ sessionId: SESSION_ID, dirtyFiles: [] }] },
      });

      const result = await proposeChangeset(createToolPort(client));
      expect(parseToolOutput(result)).toMatchObject({
        ok: true,
        kind: "action-result",
        result: { actionId: ACTION_ID, sessionId: SESSION_ID, status: "queued" },
      });
      const action = emittedAction(bridge.frames());
      const prepared = assertEmittedChangeset(action);
      await assertReviewModel(prepared, workspace.sources);
      assertWorkspaceUnchanged(workspace);

      const failed = await postFailedBrowserResult(transport, action, bridgeDecisionCapability);
      expect(failed.status).toBe(200);
      expect(decodedBody(failed)).toMatchObject({ result: { status: "failed" } });
      assertWorkspaceUnchanged(workspace);
      expect(transport.requests.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "GET", url: `${BASE_URL}/api/editor/agent/sessions` },
        { method: "POST", url: `${BASE_URL}/api/editor/agent/actions` },
        { method: "POST", url: `${BASE_URL}/api/editor/agent/actions` },
      ]);
    } finally {
      bridge?.close();
      _resetEditorAgentStateForTests();
      rmSync(workspace.root, { recursive: true, force: true });
    }
  });
});
