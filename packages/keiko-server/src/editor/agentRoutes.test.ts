import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { STREAMING, type RouteContext } from "../routes.js";
import { EDITOR_AGENT_ACTION_TIMEOUT_MS } from "./agentSessionRegistry.js";
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

function actionConflictCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.conflict)) {
    return undefined;
  }
  return typeof body.result.conflict.code === "string" ? body.result.conflict.code : undefined;
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
function connectBridge(sessionId: string | undefined): {
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
  const query = sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
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
