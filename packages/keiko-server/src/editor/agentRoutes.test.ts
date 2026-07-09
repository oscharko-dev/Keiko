import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentSessionSnapshot,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentActionStatus,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import { STREAMING, type RouteContext } from "../routes.js";
import { EDITOR_AGENT_ACTION_TIMEOUT_MS, editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  _resetEditorAgentStateForTests,
  _setEditorAgentPatchWriterForTests,
  handleEditorAgentActions,
  handleEditorAgentAudit,
  handleEditorAgentEvents,
  handleEditorAgentSessions,
  handleEditorAgentSnapshot,
} from "./agentRoutes.js";
import type { EditorAgentActionAuditRecord } from "@oscharko-dev/keiko-contracts";

const HASH = "a".repeat(64);
const PREPARED_CHANGESET_WIRE_LIMIT_BYTES = 65_536;
type ChangesetFile = NonNullable<EditorAgentAction["changeset"]>["files"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionResultStatus(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result)) return undefined;
  return typeof body.result.status === "string" ? body.result.status : undefined;
}

function actionConflictCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.conflict)) {
    return undefined;
  }
  return typeof body.result.conflict.code === "string" ? body.result.conflict.code : undefined;
}

function actionResult(body: unknown): EditorAgentActionResult {
  if (!isRecord(body) || !isRecord(body.result)) throw new Error("expected action result");
  return body.result as unknown as EditorAgentActionResult;
}

function responseSnapshot(body: unknown): EditorAgentSessionSnapshot {
  if (!isRecord(body) || !isRecord(body.snapshot)) throw new Error("expected snapshot response");
  return body.snapshot as unknown as EditorAgentSessionSnapshot;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function context(body: unknown = {}, path = "/api/editor/agent/actions"): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

// Build a minimal snapshot for a given workspaceRoot and optional activeFile.
function snapshot(workspaceRoot = "/repo", activeFile = "src/a.ts"): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot,
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile, openFiles: [activeFile] }],
    dirtyFiles: [],
    activeFile,
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

// Connect a session-scoped SSE bridge so the session is "live" (Issue #1392). Returns the captured
// frames plus a close() that drops the bridge. Bridge liveness gates action queueing: without a live
// bridge a queued action is answered NO_ACTIVE_BRIDGE (AC1).
function connectBridge(sessionId: string | readonly string[] | undefined): {
  readonly frames: () => string;
  readonly close: () => void;
} {
  const writes: string[] = [];
  const closeHandlers: (() => void)[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ServerResponse;
  const req = { on: vi.fn() } as unknown as IncomingMessage;
  const sessionIds: readonly string[] =
    sessionId === undefined ? [] : Array.isArray(sessionId) ? sessionId : [sessionId];
  const query =
    sessionIds.length === 0
      ? ""
      : `?${sessionIds.map((id) => `sessionId=${encodeURIComponent(id)}`).join("&")}`;
  handleEditorAgentEvents({
    req,
    res,
    params: {},
    url: new URL(`http://localhost/api/editor/agent/events${query}`),
  });
  return {
    frames: (): string => writes.join(""),
    close: (): void => {
      for (const cb of closeHandlers) cb();
    },
  };
}

function actionFailureCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.failure)) {
    return undefined;
  }
  return typeof body.result.failure.code === "string" ? body.result.failure.code : undefined;
}

// Register a snapshot WITHOUT connecting a bridge, so the session is registered but not live.
async function registerSnapshotOnly(
  overrides: Partial<EditorAgentSessionSnapshot> = {},
): Promise<void> {
  await handleEditorAgentSnapshot(
    context(
      {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "snapshot",
        snapshot: { ...snapshot(), ...overrides },
      },
      "/api/editor/agent/snapshot",
    ),
  );
}

// Register a snapshot AND connect its live bridge, so a following action can be queued. The existing
// preflight-conflict tests reach their structural conflict before the liveness gate regardless, but
// the tests that expect a 202 queue need a live bridge present.
async function registerSnapshot(workspaceRoot?: string, activeFile?: string): Promise<void> {
  await handleEditorAgentSnapshot(
    context(
      {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "snapshot",
        snapshot: snapshot(workspaceRoot, activeFile),
      },
      "/api/editor/agent/snapshot",
    ),
  );
  connectBridge("session-1");
}

function writeWorkspaceFile(root: string, file: string, content: string): void {
  const absolute = join(root, file);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function readWorkspaceFile(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function oneLineModifyPatch(
  changes: readonly { readonly file: string; readonly before: string; readonly after: string }[],
): string {
  return changes
    .flatMap(({ file, before, after }) => [
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      `-${before}`,
      `+${after}`,
    ])
    .join("\n");
}

function changesetActionFor(
  root: string,
  patch: string,
  files: readonly string[],
  selectedFiles?: readonly string[],
  overrides: Partial<EditorAgentAction> = {},
): EditorAgentAction {
  const declared: readonly ChangesetFile[] = files.map((file) => ({
    file,
    expectedContentHash: sha256(readWorkspaceFile(root, file)),
  }));
  return action({
    type: "applyChangeset",
    expectedContentHash: undefined,
    expectedDocumentVersion: undefined,
    changeset: {
      patch,
      files: declared,
      ...(selectedFiles === undefined ? {} : { selectedFiles }),
    },
    ...overrides,
  });
}

async function registerChangesetSnapshot(
  root: string,
  activeFile: string,
  openFiles: readonly string[],
  dirtyFiles: readonly string[] = [],
): Promise<ReturnType<typeof connectBridge>> {
  const content = readWorkspaceFile(root, activeFile);
  const stats = statSync(join(root, activeFile));
  await registerSnapshotOnly({
    workspaceRoot: root,
    activeFile,
    panes: [{ paneId: "pane-1", activeFile, openFiles }],
    dirtyFiles,
    documentVersion: {
      sizeBytes: stats.size,
      modifiedAt: stats.mtimeMs,
      contentHash: sha256(content),
    },
    activeFileContentHash: sha256(content),
  });
  return connectBridge("session-1");
}

async function postActionResult(
  original: EditorAgentAction,
  status: EditorAgentActionStatus,
  sessionId = original.sessionId,
): Promise<Awaited<ReturnType<typeof handleEditorAgentActions>>> {
  return handleEditorAgentActions(
    context({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "result",
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: original.actionId,
        sessionId,
        status,
        ...(status === "conflict"
          ? { conflict: { code: "INVALID_EDITS", message: "Browser reported a conflict." } }
          : {}),
      },
    }),
  );
}

function lastEmittedAction(frames: string): EditorAgentAction {
  const frame = frames
    .split("\n\n")
    .filter((candidate) => candidate.includes("event: editor-agent:action"))
    .at(-1);
  const data = frame?.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("expected emitted action frame");
  const event = JSON.parse(data.slice("data: ".length)) as EditorAgentEvent;
  if (event.type !== "action") throw new Error("expected action event");
  return event.action;
}

afterEach(() => {
  _resetEditorAgentStateForTests();
  vi.useRealTimers();
});

// ─── Original tests (unchanged) ────────────────────────────────────────────────────────────────

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
    await registerSnapshot();
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

describe("editor agent routes diagnostics detail (Issue #2118)", () => {
  const diagnostic = {
    severity: "hint",
    range: { start: { line: 3, character: 5 }, end: { line: 3, character: 11 } },
    message: "Use readonly",
  } as const;

  it("round-trips valid diagnostic detail through ingestion and read projection", async () => {
    const diagnosticsDetail = { items: [diagnostic], truncated: false } as const;
    const posted = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), diagnosticsDetail },
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const read = await handleEditorAgentSnapshot(
      context({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION }, "/api/editor/agent/snapshot"),
    );

    expect(posted.status).toBe(200);
    expect(responseSnapshot(posted.body).diagnosticsDetail).toEqual(diagnosticsDetail);
    expect(responseSnapshot(read.body).diagnosticsDetail).toEqual(diagnosticsDetail);
  });

  it("keeps omitted diagnostic detail absent on ingestion and read", async () => {
    const posted = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: snapshot(),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const read = await handleEditorAgentSnapshot(
      context({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION }, "/api/editor/agent/snapshot"),
    );

    expect(posted.body).not.toHaveProperty("snapshot.diagnosticsDetail");
    expect(read.body).not.toHaveProperty("snapshot.diagnosticsDetail");
  });

  it("preserves an upstream diagnostic truncation marker", async () => {
    editorAgentRegistry.registerSnapshot({
      ...snapshot(),
      diagnosticsDetail: { items: [diagnostic], truncated: true },
    });

    const result = await handleEditorAgentSnapshot(
      context({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION }, "/api/editor/agent/snapshot"),
    );

    expect(responseSnapshot(result.body).diagnosticsDetail).toEqual({
      items: [diagnostic],
      truncated: true,
    });
  });

  it.each([
    [
      "an oversized item list",
      {
        items: Array.from({ length: EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS + 1 }, () => diagnostic),
        truncated: false,
      },
    ],
    [
      "an overlength message",
      {
        items: [
          {
            ...diagnostic,
            message: "x".repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS + 1),
          },
        ],
        truncated: false,
      },
    ],
  ])("rejects %s at ingestion", async (_case, diagnosticsDetail) => {
    const result = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), diagnosticsDetail },
        },
        "/api/editor/agent/snapshot",
      ),
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "INVALID_REQUEST",
          message: "snapshot must be a valid editor agent session snapshot",
        },
      },
    });
  });

  it("re-caps invalid registry detail on a text-free read projection", async () => {
    const unicodeCharacter = "\u{1f600}";
    const diagnosticsSummary = { errors: 1, warnings: 2, infos: 3 };
    const invalidSnapshot = {
      ...snapshot(),
      diagnosticsSummary,
      diagnosticsDetail: {
        items: Array.from({ length: EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS + 1 }, () => ({
          ...diagnostic,
          message: unicodeCharacter.repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS + 1),
        })),
        truncated: false,
      },
    } as unknown as EditorAgentSessionSnapshot;
    editorAgentRegistry.registerSnapshot(invalidSnapshot);

    const result = await handleEditorAgentSnapshot(
      context(
        { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "none" },
        "/api/editor/agent/snapshot",
      ),
    );
    const shaped = responseSnapshot(result.body);
    const detail = shaped.diagnosticsDetail;

    expect(isEditorAgentSessionSnapshot(shaped)).toBe(true);
    expect(shaped.diagnosticsSummary).toEqual(diagnosticsSummary);
    expect(detail?.items).toHaveLength(EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS);
    expect(Array.from(detail?.items[0]?.message ?? "")).toHaveLength(
      EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
    );
    expect(detail?.items[0]?.message).toBe(
      unicodeCharacter.repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    );
    expect(detail?.truncated).toBe(true);
  });
});

// ─── Issue #1394 preflight checks (ADR-0058 D2) ───────────────────────────────────────────────

describe("editor agent routes — Issue #1394 preflight checks", () => {
  // ── Conflict code helper ──────────────────────────────────────────────────────────────────────

  // ── AC1: version / hash mismatch (existing preflight, confirmed with structured codes) ───────

  it("returns 409 VERSION_MISMATCH when expectedDocumentVersion hash mismatches", async () => {
    await registerSnapshot();
    const mismatchedVersion = { sizeBytes: 1, modifiedAt: 1, contentHash: "b".repeat(64) };
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "save",
          idempotencyKey: "ik-vmm",
          actionId: "a-vmm",
          expectedDocumentVersion: mismatchedVersion,
          expectedContentHash: undefined,
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("VERSION_MISMATCH");
  });

  it("returns 409 CONTENT_HASH_MISMATCH when expectedContentHash mismatches", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "save",
          idempotencyKey: "ik-chm",
          actionId: "a-chm",
          expectedDocumentVersion: undefined,
          expectedContentHash: "c".repeat(64),
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("CONTENT_HASH_MISMATCH");
  });

  // ── AC2: structural edit validation (INVALID_EDITS) ─────────────────────────────────────────

  it("returns 409 INVALID_EDITS for an applyTextEdits action with an inverted range", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-inv",
          actionId: "a-inv",
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 5, character: 0 }, end: { line: 2, character: 0 } },
              newText: "bad",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
  });

  it("returns 409 INVALID_EDITS for same-line inverted range (end char before start char)", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-inv2",
          actionId: "a-inv2",
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 2, character: 10 }, end: { line: 2, character: 3 } },
              newText: "bad",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
  });

  it("returns 400 INVALID_REQUEST for an applyTextEdits action with a negative coordinate (fails contract parsing)", async () => {
    // Negative line/character values are rejected by isNonNegativeInteger in the contract parser
    // BEFORE preflight runs, so the response is 400 INVALID_REQUEST not 409.
    // The INVALID_EDITS path for negative coords is covered at the validator unit level in
    // editor-agent.test.ts (validateAgentTextEdits returns an error string for negatives).
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        // This body is intentionally NOT an EditorAgentAction because -1 fails isNonNegativeInteger.
        {
          schemaVersion: "1",
          actionId: "a-neg",
          idempotencyKey: "ik-neg",
          sessionId: "session-1",
          type: "applyTextEdits",
          textEdits: [
            {
              range: { start: { line: -1, character: 0 }, end: { line: 0, character: 5 } },
              newText: "x",
            },
          ],
        },
      ),
    );
    expect(result.status).toBe(400);
  });

  // ── AC5: containment check (OUT_OF_SCOPE) ───────────────────────────────────────────────────

  it("returns 409 OUT_OF_SCOPE for an applyTextEdits action targeting an absolute path", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-abs",
          actionId: "a-abs",
          target: { file: "/abs/x" },
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: "x",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  it("returns 409 OUT_OF_SCOPE for an applyTextEdits action targeting a path with '..'", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-dotdot",
          actionId: "a-dotdot",
          target: { file: "../escape/secret.ts" },
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "x",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  it("returns 409 OUT_OF_SCOPE for an applyTextEdits action targeting a Windows drive path", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-win",
          actionId: "a-win",
          target: { file: "C:/evil.ts" },
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "x",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  // ── applyPatch preflight: OUT_OF_SCOPE scenarios ─────────────────────────────────────────────

  describe("applyPatch preflight — OUT_OF_SCOPE (Issue #1394)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 409 OUT_OF_SCOPE for a multi-file unified diff", async () => {
      await registerSnapshot(tmpDir);

      // Create both files the diff touches so path resolution succeeds.
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n", "utf8");
      writeFileSync(join(tmpDir, "b.ts"), "const b = 2;\n", "utf8");

      const multiFileDiff = [
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "-const a = 1;",
        "+const a = 10;",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +1,1 @@",
        "-const b = 2;",
        "+const b = 20;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-multifile",
            actionId: "a-multifile",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: multiFileDiff,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    });

    it("returns 409 OUT_OF_SCOPE for a binary diff (GIT binary patch marker)", async () => {
      await registerSnapshot(tmpDir);

      const binaryDiff = [
        "diff --git a/img.png b/img.png",
        "index 0000000..1111111 100644",
        "GIT binary patch",
        "literal 10",
        "zcmZQz0MBk=",
        "",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-binary",
            actionId: "a-binary",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: binaryDiff,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    });

    it("returns 409 OUT_OF_SCOPE when patch target.file contains '..'", async () => {
      await registerSnapshot(tmpDir);

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-patchdotdot",
            actionId: "a-patchdotdot",
            target: { file: "../outside.ts" },
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: "--- a/../outside.ts\n+++ b/../outside.ts\n@@ -1 +1 @@\n-old\n+new\n",
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    });
  });

  // ── applyPatch preflight: INVALID_EDITS scenarios ────────────────────────────────────────────

  describe("applyPatch preflight — INVALID_EDITS (Issue #1394)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 409 INVALID_EDITS for a malformed/empty diff", async () => {
      await registerSnapshot(tmpDir);

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-malformed",
            actionId: "a-malformed",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: "this is not a unified diff at all",
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
    });

    it("returns 409 INVALID_EDITS for an empty patch string", async () => {
      await registerSnapshot(tmpDir);

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-empty",
            actionId: "a-empty",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: "",
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
    });
  });

  // ── applyPatch: valid single-file patch — 202 queued + emitted textEdits ─────────────────────

  describe("applyPatch — valid single-file patch (Issue #1394 EMIT INVARIANT)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-valid-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 202 queued for a valid single-file patch against an existing file", async () => {
      // Arrange: write the pre-image to disk so validatePatch + computeFileContent can read it.
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      const filePath = join(srcDir, "widget.ts");
      const preImage = "export const VALUE = 1;\n";
      writeFileSync(filePath, preImage, "utf8");

      // snapshot.activeFile must equal the patch's single file path so deriveAgentPatchTextEdits
      // does not reject the patch as targeting a different file than the open buffer.
      await registerSnapshot(tmpDir, "src/widget.ts");

      const validSingleFileDiff = [
        "--- a/src/widget.ts",
        "+++ b/src/widget.ts",
        "@@ -1,1 +1,1 @@",
        "-export const VALUE = 1;",
        "+export const VALUE = 42;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-valid",
            actionId: "a-valid",
            // #1391 AC2: write actions must pin a revision. The hash matches the registered snapshot,
            // so the precondition is satisfied and the patch queues normally.
            expectedContentHash: HASH,
            patch: validSingleFileDiff,
          }),
        ),
      );

      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });

    it("captures emitted action textEdits via SSE subscriber for a valid patch", async () => {
      // Arrange: write the pre-image to disk.
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      const filePath = join(srcDir, "calc.ts");
      const preImage = "export const X = 1;\n";
      writeFileSync(filePath, preImage, "utf8");

      // snapshot.activeFile must equal the patch's single file path (F3 guard in server).
      await registerSnapshot(tmpDir, "src/calc.ts");

      // Tap the SSE subscriber by setting up a fake response.
      const emittedFrames: string[] = [];
      const fakeRes = {
        writeHead: vi.fn(),
        write: vi.fn((chunk: string) => {
          emittedFrames.push(chunk);
          return true;
        }),
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ServerResponse;
      const fakeReq = { on: vi.fn() } as unknown as IncomingMessage;
      handleEditorAgentEvents({
        req: fakeReq,
        res: fakeRes,
        params: {},
        url: new URL("http://localhost/api/editor/agent/events"),
      });

      const validDiff = [
        "--- a/src/calc.ts",
        "+++ b/src/calc.ts",
        "@@ -1,1 +1,1 @@",
        "-export const X = 1;",
        "+export const X = 99;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-emit",
            actionId: "a-emit",
            // #1391 AC2: pin the revision (hash matches the registered snapshot) so the patch queues.
            expectedContentHash: HASH,
            patch: validDiff,
          }),
        ),
      );

      // The server should have queued the action.
      expect(result.status).toBe(202);

      // Extract and parse the SSE frames.
      const actionFrames = emittedFrames.filter((f) => f.includes("editor-agent:action"));
      expect(actionFrames.length).toBeGreaterThanOrEqual(1);

      const lastActionFrame = actionFrames.at(-1) ?? "";
      const dataLine = lastActionFrame.split("\n").find((line) => line.startsWith("data:"));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse((dataLine ?? "data:{}").slice("data:".length)) as EditorAgentEvent;
      expect(parsed.type).toBe("action");
      if (parsed.type !== "action") throw new Error("unexpected type");

      // The EMIT INVARIANT: the emitted action must have textEdits populated (whole-doc replace).
      expect(parsed.action.textEdits).toBeDefined();
      expect(Array.isArray(parsed.action.textEdits)).toBe(true);
      expect(parsed.action.textEdits?.length ?? 0).toBeGreaterThanOrEqual(1);

      // The textEdits must produce the patched content when applied to the pre-image.
      // We verify this with applyTextEditsToText from @oscharko-dev/keiko-editor.
      const { applyTextEditsToText } = await import("@oscharko-dev/keiko-editor");
      const mappedEdits = (parsed.action.textEdits ?? []).map((edit) => ({
        range: {
          start: { line: edit.range.start.line, column: edit.range.start.character },
          end: { line: edit.range.end.line, column: edit.range.end.character },
        },
        newText: edit.newText,
      }));
      const applied = applyTextEditsToText(preImage, mappedEdits);
      expect(applied).toContain("export const X = 99;");
    });
  });

  // ── DIRTY conflict: 409 conflict code DIRTY emitted on SSE stream (F1/AC3) ─────────────────────

  describe("DIRTY conflict — code DIRTY emitted over SSE (F1/AC3)", () => {
    it("returns 409 DIRTY and emits the conflict result on the SSE stream", async () => {
      // Arrange: register a snapshot that marks the active file as dirty.
      await handleEditorAgentSnapshot(
        context(
          {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            kind: "snapshot",
            snapshot: {
              ...snapshot(),
              dirtyFiles: ["src/a.ts"],
            },
          },
          "/api/editor/agent/snapshot",
        ),
      );

      // Tap the SSE subscriber BEFORE posting the action.
      const emittedFrames: string[] = [];
      const fakeRes = {
        writeHead: vi.fn(),
        write: vi.fn((chunk: string) => {
          emittedFrames.push(chunk);
          return true;
        }),
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ServerResponse;
      const fakeReq = { on: vi.fn() } as unknown as IncomingMessage;
      handleEditorAgentEvents({
        req: fakeReq,
        res: fakeRes,
        params: {},
        url: new URL("http://localhost/api/editor/agent/events"),
      });

      // Act: submit a non-save write action against the dirty buffer.
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "format",
            idempotencyKey: "ik-dirty",
            actionId: "a-dirty",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
          }),
        ),
      );

      // Assert: 409 with conflict code DIRTY.
      expect(result.status).toBe(409);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("DIRTY");

      // Assert: the conflict result was also emitted on the SSE stream (proves F1/AC3).
      const resultFrames = emittedFrames.filter((f) => f.includes("editor-agent:result"));
      expect(resultFrames.length).toBeGreaterThanOrEqual(1);

      const lastResultFrame = resultFrames.at(-1) ?? "";
      const dataLine = lastResultFrame.split("\n").find((line) => line.startsWith("data:"));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse((dataLine ?? "data:{}").slice("data:".length)) as EditorAgentEvent;
      expect(parsed.type).toBe("result");
      if (parsed.type !== "result") throw new Error("unexpected type");
      expect(parsed.result.status).toBe("conflict");
      expect(parsed.result.conflict?.code).toBe("DIRTY");
    });
  });

  // ── F7: server-authoritative overlap check for applyTextEdits ────────────────────────────────

  describe("applyTextEdits preflight — overlapping ranges (F7 server-authoritative)", () => {
    it("returns 409 INVALID_EDITS when two textEdit ranges overlap", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyTextEdits",
            idempotencyKey: "ik-overlap",
            actionId: "a-overlap",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            textEdits: [
              {
                // Edit 0: covers characters 0..10 on line 0
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                newText: "first",
              },
              {
                // Edit 1: starts at character 5 — overlaps with edit 0's [0,10)
                range: { start: { line: 0, character: 5 }, end: { line: 0, character: 15 } },
                newText: "second",
              },
            ],
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
    });
  });

  // ── F3: applyPatch targeting a file other than snapshot.activeFile => failed ─────────────────

  describe("applyPatch — patch targets file other than snapshot.activeFile (F3)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-f3-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 409 failed when the patch file does not match snapshot.activeFile", async () => {
      // Arrange: the snapshot's activeFile is src/a.ts but the patch targets src/b.ts.
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n", "utf8");
      writeFileSync(join(tmpDir, "b.ts"), "const b = 2;\n", "utf8");

      // Register snapshot with activeFile pointing at a.ts; patch targets b.ts.
      await registerSnapshot(tmpDir, "src/a.ts");

      const patchTargetingB = [
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +1,1 @@",
        "-const b = 2;",
        "+const b = 99;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-f3",
            actionId: "a-f3",
            // #1391 AC2: pin the revision so the action clears the precondition gate and reaches the
            // file-mismatch derivation path this test exercises (the patch targets b.ts, not a.ts).
            expectedContentHash: HASH,
            patch: patchTargetingB,
          }),
        ),
      );

      // deriveAgentPatchTextEdits returns null (file mismatch) => queueAndEmitAction returns 409
      // with status "failed" (not a preflight conflict).
      expect(result.status).toBe(409);
      const body = result.body;
      if (
        typeof body === "object" &&
        body !== null &&
        "result" in body &&
        typeof (body as Record<string, unknown>).result === "object"
      ) {
        const res = (body as Record<string, unknown>).result as Record<string, unknown>;
        expect(res.status).toBe("failed");
      }
    });
  });

  // ── Issue #1391 AC2: write actions require a version/hash precondition (PRECONDITION_REQUIRED) ──

  describe("write precondition — PRECONDITION_REQUIRED (Issue #1391 AC2)", () => {
    it("returns 409 PRECONDITION_REQUIRED for a save with neither version nor hash", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "save",
            idempotencyKey: "ik-noprecond",
            actionId: "a-noprecond",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("returns 409 PRECONDITION_REQUIRED for structurally valid applyTextEdits without a precondition", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyTextEdits",
            idempotencyKey: "ik-edits-noprecond",
            actionId: "a-edits-noprecond",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            textEdits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "hello",
              },
            ],
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("accepts a write that pins the revision by document version only (queues 202)", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "save",
            idempotencyKey: "ik-version-only",
            actionId: "a-version-only",
            expectedContentHash: undefined,
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });

    it("requires a verifiable pin when the asserted document version is unavailable", async () => {
      await registerSnapshotOnly({ documentVersion: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-version-unavailable",
            actionId: "a-version-unavailable",
            expectedContentHash: undefined,
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      // Regression: this unverified assertion was previously treated as sufficient and queued.
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("requires a verifiable pin when the asserted content hash is unavailable", async () => {
      await registerSnapshotOnly({ activeFileContentHash: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-hash-unavailable",
            actionId: "a-hash-unavailable",
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      // Regression: an asserted pin with no snapshot counterpart must not authorize a blind write.
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("requires a verifiable pin when both snapshot counterparts are unavailable", async () => {
      await registerSnapshotOnly({
        documentVersion: undefined,
        activeFileContentHash: undefined,
      });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-both-unavailable",
            actionId: "a-both-unavailable",
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("accepts a matching hash when the other asserted snapshot pin is unavailable", async () => {
      await registerSnapshotOnly({ documentVersion: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-hash-match-version-unavailable",
            actionId: "a-hash-match-version-unavailable",
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });

    it("rejects a mismatching hash even when the asserted version matches", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-version-match-hash-mismatch",
            actionId: "a-version-match-hash-mismatch",
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
            expectedContentHash: "b".repeat(64),
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("CONTENT_HASH_MISMATCH");
    });

    it("does not require a precondition for a non-write action (setSelection queues 202)", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "setSelection",
            idempotencyKey: "ik-nav",
            actionId: "a-nav",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });
  });
});

// ─── Issue #1392: bridge liveness, queue timeout/cleanup, bounded queue, scoped fan-out ──────────

function navAction(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return action({
    type: "setSelection",
    expectedContentHash: undefined,
    expectedDocumentVersion: undefined,
    ...overrides,
  });
}

describe("editor agent routes — Issue #1392 liveness and queue lifecycle", () => {
  it("returns NO_ACTIVE_BRIDGE when a snapshot is registered but no bridge is connected (AC1)", async () => {
    await registerSnapshotOnly();
    const result = await handleEditorAgentActions(context(action()));
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("NO_ACTIVE_BRIDGE");
  });

  it("queues for a live bridge, then NO_ACTIVE_BRIDGE once the bridge disconnects (AC1)", async () => {
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");
    const queued = await handleEditorAgentActions(context(action()));
    expect(queued.status).toBe(202);

    bridge.close();
    const afterClose = await handleEditorAgentActions(
      context(action({ idempotencyKey: "ik-after-close", actionId: "a-after-close" })),
    );
    expect(afterClose.status).toBe(409);
    expect(actionConflictCode(afterClose.body)).toBe("NO_ACTIVE_BRIDGE");
  });

  it("treats one multi-session SSE stream as a live bridge for each listed session", async () => {
    await registerSnapshotOnly();
    await registerSnapshotOnly({ sessionId: "session-2" });
    const bridge = connectBridge(["session-1", "session-2"]);

    const queued1 = await handleEditorAgentActions(
      context(navAction({ actionId: "a-mux-1", idempotencyKey: "k-mux-1" })),
    );
    const queued2 = await handleEditorAgentActions(
      context(
        navAction({
          sessionId: "session-2",
          actionId: "a-mux-2",
          idempotencyKey: "k-mux-2",
        }),
      ),
    );

    expect(queued1.status).toBe(202);
    expect(queued2.status).toBe(202);
    expect(bridge.frames()).toContain("a-mux-1");
    expect(bridge.frames()).toContain("a-mux-2");

    bridge.close();
    const afterClose = await handleEditorAgentActions(
      context(
        navAction({
          sessionId: "session-2",
          actionId: "a-mux-after-close",
          idempotencyKey: "k-mux-after-close",
        }),
      ),
    );
    expect(afterClose.status).toBe(409);
    expect(actionConflictCode(afterClose.body)).toBe("NO_ACTIVE_BRIDGE");
  });

  it("times out a queued action, emits TIMED_OUT over SSE, and frees the queue (AC2)", async () => {
    vi.useFakeTimers();
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");

    const queued = await handleEditorAgentActions(context(action()));
    expect(queued.status).toBe(202);

    vi.advanceTimersByTime(EDITOR_AGENT_ACTION_TIMEOUT_MS + 1);

    expect(bridge.frames()).toContain("event: editor-agent:result");
    expect(bridge.frames()).toContain("TIMED_OUT");

    // The freed slot lets the same action id be queued again.
    const requeued = await handleEditorAgentActions(
      context(action({ idempotencyKey: "ik-requeue" })),
    );
    expect(requeued.status).toBe(202);
  });

  it("clears the pending timeout when the bridge reports a result (no late TIMED_OUT)", async () => {
    vi.useFakeTimers();
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");
    await handleEditorAgentActions(context(action()));

    const reported = await handleEditorAgentActions(
      context({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "result",
        result: {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          actionId: "action-1",
          sessionId: "session-1",
          status: "succeeded",
        },
      }),
    );
    expect(reported.status).toBe(200);

    vi.advanceTimersByTime(EDITOR_AGENT_ACTION_TIMEOUT_MS + 1);
    expect(bridge.frames()).toContain("succeeded");
    expect(bridge.frames()).not.toContain("TIMED_OUT");
  });

  it("bounds the per-session queue and answers QUEUE_FULL with 429 (perf)", async () => {
    await registerSnapshotOnly();
    connectBridge("session-1");
    let lastStatus = 0;
    for (let i = 0; i < 64; i += 1) {
      const res = await handleEditorAgentActions(
        context(navAction({ actionId: `a-${String(i)}`, idempotencyKey: `k-${String(i)}` })),
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(202);

    const overflow = await handleEditorAgentActions(
      context(navAction({ actionId: "a-overflow", idempotencyKey: "k-overflow" })),
    );
    expect(overflow.status).toBe(429);
    expect(actionResultStatus(overflow.body)).toBe("failed");
    expect(actionFailureCode(overflow.body)).toBe("QUEUE_FULL");
  });

  it("rejects a second action reusing an in-flight actionId with 409 (distinct idempotency key)", async () => {
    await registerSnapshotOnly();
    connectBridge("session-1");
    const first = await handleEditorAgentActions(
      context(action({ actionId: "dup", idempotencyKey: "k1" })),
    );
    expect(first.status).toBe(202);

    // A distinct idempotency key clears the route-level replay guard, but the registry rejects the
    // re-used in-flight actionId so the first action's deadline is preserved (409, not 429).
    const second = await handleEditorAgentActions(
      context(action({ actionId: "dup", idempotencyKey: "k2" })),
    );
    expect(second.status).toBe(409);
    expect(actionResultStatus(second.body)).toBe("failed");
    expect(actionFailureCode(second.body)).toBeUndefined();
  });

  it("scopes action fan-out to the target session's bridge plus global observers (perf)", async () => {
    await registerSnapshotOnly();
    const bridge1 = connectBridge("session-1");
    const bridge2 = connectBridge("session-2");
    const observer = connectBridge(undefined);

    await handleEditorAgentActions(
      context(navAction({ actionId: "a-fan", idempotencyKey: "k-fan" })),
    );

    expect(bridge1.frames()).toContain("event: editor-agent:action");
    expect(observer.frames()).toContain("event: editor-agent:action");
    expect(bridge2.frames()).not.toContain("event: editor-agent:action");
  });

  it("never writes raw source content to logs", async () => {
    const sink = vi.fn();
    vi.spyOn(console, "log").mockImplementation(sink);
    vi.spyOn(console, "info").mockImplementation(sink);
    vi.spyOn(console, "warn").mockImplementation(sink);
    vi.spyOn(console, "error").mockImplementation(sink);
    vi.spyOn(console, "debug").mockImplementation(sink);

    await registerSnapshotOnly({ text: "TOP_SECRET_SOURCE", textMode: "activeFile" });
    connectBridge("session-1");
    await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          expectedContentHash: HASH,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "TOP_SECRET_EDIT",
            },
          ],
        }),
      ),
    );

    const logged = sink.mock.calls
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join(" ");
    expect(logged).not.toContain("TOP_SECRET_SOURCE");
    expect(logged).not.toContain("TOP_SECRET_EDIT");

    vi.restoreAllMocks();
  });
});

// ─── Issue #1395 (ADR-0062): policy taxonomy + bounded audit ─────────────────────────────────────

function auditRecords(sessionId = "session-1"): readonly EditorAgentActionAuditRecord[] {
  const result = handleEditorAgentAudit({
    req: {} as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(
      `http://localhost/api/editor/agent/audit?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  });
  const body = result.body;
  if (!isRecord(body) || !Array.isArray(body.records)) return [];
  return body.records as readonly EditorAgentActionAuditRecord[];
}

function applyTextEditsAction(newText: string, file?: string): EditorAgentAction {
  return action({
    type: "applyTextEdits",
    expectedContentHash: HASH,
    ...(file === undefined ? {} : { target: { file } }),
    textEdits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText },
    ],
  });
}

describe("applyChangeset server transaction (Issue #2117)", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-agent-changeset-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function arrangeTwoFiles(): { readonly patch: string; readonly action: EditorAgentAction } {
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "A0\n");
    writeWorkspaceFile(workspaceRoot, "src/b.txt", "B0\n");
    const patch = oneLineModifyPatch([
      { file: "src/a.txt", before: "A0", after: "A1" },
      { file: "src/b.txt", before: "B0", after: "B1" },
    ]);
    return {
      patch,
      action: changesetActionFor(workspaceRoot, patch, ["src/a.txt", "src/b.txt"]),
    };
  }

  it("queues a multi-file changeset and an inactive open file with a server-derived preview", async () => {
    const arranged = arrangeTwoFiles();
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
    ]);
    const changeset = arranged.action.changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    const forged = {
      ...arranged.action,
      changeset: {
        ...changeset,
        prepared: {
          files: [
            {
              file: "src/a.txt",
              kind: "modify" as const,
              textEdits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 1, character: 0 },
                  },
                  newText: "FORGED_PREVIEW\n",
                },
              ],
            },
          ],
        },
      },
    };

    const queued = await handleEditorAgentActions(context(forged));

    expect(queued.status).toBe(202);
    expect(actionResultStatus(queued.body)).toBe("queued");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
    const emitted = lastEmittedAction(bridge.frames());
    expect(emitted.changeset?.prepared?.files).toHaveLength(2);
    expect(JSON.stringify(emitted.changeset?.prepared)).not.toContain("FORGED_PREVIEW");
  });

  it("queues a prepared changeset exactly at the wire text limit", async () => {
    const tail = "x".repeat(PREPARED_CHANGESET_WIRE_LIMIT_BYTES - 4);
    writeWorkspaceFile(workspaceRoot, "src/large.txt", `A0\n${tail}\n`);
    const patch = oneLineModifyPatch([{ file: "src/large.txt", before: "A0", after: "A1" }]);
    const proposed = changesetActionFor(workspaceRoot, patch, ["src/large.txt"]);
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/large.txt", [
      "src/large.txt",
    ]);

    const queued = await handleEditorAgentActions(context(proposed));

    expect(queued.status).toBe(202);
    const prepared = lastEmittedAction(bridge.frames()).changeset?.prepared;
    const preparedText = prepared?.files[0]?.textEdits[0]?.newText;
    expect(Buffer.byteLength(preparedText ?? "", "utf8")).toBe(PREPARED_CHANGESET_WIRE_LIMIT_BYTES);
  });

  it("fails closed before emitting a prepared changeset above the wire text limit", async () => {
    const tail = "x".repeat(PREPARED_CHANGESET_WIRE_LIMIT_BYTES - 3);
    writeWorkspaceFile(workspaceRoot, "src/large.txt", `A0\n${tail}\n`);
    const patch = oneLineModifyPatch([{ file: "src/large.txt", before: "A0", after: "A1" }]);
    const proposed = changesetActionFor(workspaceRoot, patch, ["src/large.txt"]);
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/large.txt", [
      "src/large.txt",
    ]);

    const rejected = await handleEditorAgentActions(context(proposed));

    expect(rejected.status).toBe(409);
    expect(actionConflictCode(rejected.body)).toBe("INVALID_EDITS");
    expect(bridge.frames()).not.toContain("event: editor-agent:action");
  });

  it("rejects a safe plus deny-listed full changeset with file attribution and no mutation", async () => {
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "A0\n");
    writeWorkspaceFile(workspaceRoot, ".env", "SECRET=old\n");
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
    const patch = oneLineModifyPatch([
      { file: "src/a.txt", before: "A0", after: "A1" },
      { file: ".env", before: "SECRET=old", after: "SECRET=new" },
    ]);
    const proposed = changesetActionFor(workspaceRoot, patch, ["src/a.txt", ".env"]);

    const rejected = await handleEditorAgentActions(context(proposed));

    expect(rejected.status).toBe(409);
    expect(actionConflictCode(rejected.body)).toBe("OUT_OF_SCOPE");
    expect(actionResult(rejected.body).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/a.txt", status: "failed" }),
        expect.objectContaining({
          file: ".env",
          status: "conflict",
        }),
      ]),
    );
    const deniedFile = actionResult(rejected.body).files?.find((file) => file.file === ".env");
    expect(deniedFile?.conflict).toMatchObject({ code: "OUT_OF_SCOPE", file: ".env" });
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, ".env")).toBe("SECRET=old\n");
  });

  it("attributes one stale member and applies zero changes", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);
    writeWorkspaceFile(workspaceRoot, "src/b.txt", "B-external\n");

    const committed = await postActionResult(arranged.action, "succeeded");

    expect(committed.status).toBe(200);
    expect(actionConflictCode(committed.body)).toBe("CONTENT_HASH_MISMATCH");
    expect(actionResult(committed.body).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/a.txt", status: "failed" }),
        expect.objectContaining({
          file: "src/b.txt",
          status: "conflict",
        }),
      ]),
    );
    const staleFile = actionResult(committed.body).files?.find((file) => file.file === "src/b.txt");
    expect(staleFile?.conflict).toMatchObject({
      code: "CONTENT_HASH_MISMATCH",
      file: "src/b.txt",
    });
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B-external\n");
  });

  it("applies nothing when the browser rejects the queued changeset", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const rejected = await postActionResult(arranged.action, "failed");

    expect(rejected.status).toBe(200);
    expect(actionResultStatus(rejected.body)).toBe("failed");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
  });

  it("atomically commits every selected file once after a succeeded acknowledgment", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const committed = await postActionResult(arranged.action, "succeeded");
    const replay = await postActionResult(arranged.action, "succeeded");

    expect(committed.status).toBe(200);
    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(actionResult(committed.body).files).toEqual([
      { file: "src/a.txt", status: "succeeded" },
      { file: "src/b.txt", status: "succeeded" },
    ]);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A1\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B1\n");
    expect(replay.status).toBe(409);
  });

  it("projects selectedFiles after full validation and reports non-selected members", async () => {
    const arranged = arrangeTwoFiles();
    const changeset = arranged.action.changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    const selected: EditorAgentAction = {
      ...arranged.action,
      changeset: { ...changeset, selectedFiles: ["./src/b.txt"] },
    };
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(selected))).status).toBe(202);

    const committed = await postActionResult(selected, "succeeded");

    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(actionResult(committed.body).files).toEqual([
      { file: "src/a.txt", status: "not-selected" },
      { file: "src/b.txt", status: "succeeded" },
    ]);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B1\n");
  });

  it("rolls back earlier files when the injected writer fails on a later member", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);
    const writer: WorkspaceWriter = {
      writeFileUtf8: (absolutePath, content): void => {
        if (absolutePath.endsWith("b.txt") && content === "B1\n") {
          throw new Error("forced writer failure");
        }
        writeFileSync(absolutePath, content, "utf8");
      },
      mkdirp: (absoluteDir): void => {
        mkdirSync(absoluteDir, { recursive: true });
      },
      remove: (absolutePath): void => {
        rmSync(absolutePath, { force: true });
      },
      rename: (fromAbsolute, toAbsolute): void => {
        renameSync(fromAbsolute, toAbsolute);
      },
    };
    _setEditorAgentPatchWriterForTests(writer);

    const failed = await postActionResult(arranged.action, "succeeded");

    expect(actionResultStatus(failed.body)).toBe("failed");
    expect(actionResult(failed.body).files).toEqual([
      expect.objectContaining({ file: "src/a.txt", status: "failed" }),
      expect.objectContaining({ file: "src/b.txt", status: "failed" }),
    ]);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
  });

  it("does not commit for unsolicited or cross-session forged success results", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const unsolicited = await postActionResult(
      { ...arranged.action, actionId: "not-pending" },
      "succeeded",
    );
    const crossSession = await postActionResult(arranged.action, "succeeded", "session-2");

    expect(unsolicited.status).toBe(409);
    expect(crossSession.status).toBe(409);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
    expect((await postActionResult(arranged.action, "failed")).status).toBe(200);
  });

  it("records bounded content-free queued and terminal accept, reject, and conflict audit", async () => {
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "AUDIT_BASE\n");
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
    const acceptPatch = oneLineModifyPatch([
      { file: "src/a.txt", before: "AUDIT_BASE", after: "AUDIT_SECRET_ACCEPT" },
    ]);
    const accepted = changesetActionFor(workspaceRoot, acceptPatch, ["src/a.txt"], undefined, {
      actionId: "audit-accept",
      idempotencyKey: "audit-accept-key",
    });
    await handleEditorAgentActions(context(accepted));
    await postActionResult(accepted, "succeeded");

    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
    const rejectPatch = oneLineModifyPatch([
      { file: "src/a.txt", before: "AUDIT_SECRET_ACCEPT", after: "AUDIT_SECRET_REJECT" },
    ]);
    const rejected = changesetActionFor(workspaceRoot, rejectPatch, ["src/a.txt"], undefined, {
      actionId: "audit-reject",
      idempotencyKey: "audit-reject-key",
    });
    await handleEditorAgentActions(context(rejected));
    await postActionResult(rejected, "failed");

    const conflictPatch = oneLineModifyPatch([
      { file: "src/a.txt", before: "AUDIT_SECRET_ACCEPT", after: "AUDIT_SECRET_CONFLICT" },
    ]);
    const conflicted = changesetActionFor(workspaceRoot, conflictPatch, ["src/a.txt"], undefined, {
      actionId: "audit-conflict",
      idempotencyKey: "audit-conflict-key",
    });
    await handleEditorAgentActions(context(conflicted));
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "AUDIT_EXTERNAL\n");
    await postActionResult(conflicted, "succeeded");

    const records = auditRecords();
    expect(records.map((record) => record.outcome)).toEqual([
      "queued",
      "succeeded",
      "queued",
      "failed",
      "queued",
      "conflict",
    ]);
    expect(records).toHaveLength(6);
    expect(records.every((record) => (record.patchByteLength ?? 0) > 0)).toBe(true);
    expect(records.every((record) => record.summary.length <= 256)).toBe(true);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("AUDIT_SECRET_ACCEPT");
    expect(serialized).not.toContain("AUDIT_SECRET_REJECT");
    expect(serialized).not.toContain("AUDIT_SECRET_CONFLICT");
    expect(serialized).not.toContain("AUDIT_EXTERNAL");
  });
});

describe("agent editor action policy (Issue #1395 AC2)", () => {
  it("denies a write to a deny-listed sensitive path with OUT_OF_SCOPE", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(context(applyTextEditsAction("x", ".env")));
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  it("admits a contained, non-sensitive write for human review (review-required → queued)", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(result.status).toBe(202);
    expect(actionResultStatus(result.body)).toBe("queued");
  });

  it("denies format and save to a deny-listed sensitive path with OUT_OF_SCOPE", async () => {
    await registerSnapshot();
    for (const type of ["format", "save"] as const) {
      const result = await handleEditorAgentActions(
        context(
          action({
            type,
            target: { file: ".env" },
            actionId: `a-${type}`,
            idempotencyKey: `ik-${type}`,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    }
  });
});

describe("agent editor action audit (Issue #1395 AC1, AC3, AC4)", () => {
  it("records bounded audit metadata for a queued mutating action (AC1)", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    const records = auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.actionType).toBe("applyTextEdits");
    expect(records[0]?.disposition).toBe("review-required");
    expect(records[0]?.outcome).toBe("queued");
    expect(records[0]?.mutating).toBe(true);
    expect(records[0]?.editCount).toBe(1);
  });

  it("records a denied action with its deny reason and conflict code (AC2, AC4)", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(context(applyTextEditsAction("x", ".env")));
    const records = auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.disposition).toBe("denied");
    expect(records[0]?.denyReason).toBe("denied-sensitive-path");
    expect(records[0]?.conflictCode).toBe("OUT_OF_SCOPE");
  });

  it("does not audit an allowed navigation action", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(
      context(
        action({ type: "openFile", target: { file: "src/a.ts" }, expectedContentHash: undefined }),
      ),
    );
    expect(auditRecords()).toHaveLength(0);
  });

  it("never stores raw edit content in the audit feed (AC3)", async () => {
    await registerSnapshotOnly({ text: "AUDIT_SECRET_SOURCE", textMode: "activeFile" });
    connectBridge("session-1");
    await handleEditorAgentActions(context(applyTextEditsAction("AUDIT_SECRET_EDIT")));
    const serialized = JSON.stringify(auditRecords());
    expect(serialized).not.toContain("AUDIT_SECRET_EDIT");
    expect(serialized).not.toContain("AUDIT_SECRET_SOURCE");
    // The record still proves the action happened: it carries the edit COUNT, not the edit content.
    expect(auditRecords()[0]?.editCount).toBe(1);
  });

  it("scopes the audit feed to the requested session", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(auditRecords("session-1")).toHaveLength(1);
    expect(auditRecords("session-2")).toHaveLength(0);
  });

  it("does not duplicate the audit record on idempotent replay (AC1 bounded)", async () => {
    await registerSnapshot();
    const first = await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(first.status).toBe(202);
    // Replaying the identical action returns the cached result and records no second audit entry.
    const replay = await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(replay.status).toBe(200);
    expect(auditRecords()).toHaveLength(1);
  });
});
