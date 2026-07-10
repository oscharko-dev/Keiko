import {
  EDITOR_AGENT_ACTION_ID_MAX_BYTES,
  EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_SESSION_ID_MAX_BYTES,
  EDITOR_AGENT_TARGET_PATH_MAX_BYTES,
  EDITOR_AGENT_WINDOW_ID_MAX_BYTES,
  isEditorAgentAction,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentConflictCode,
  type EditorAgentSessionSnapshot,
  type EditorDocumentVersion,
} from "@oscharko-dev/keiko-contracts";
import { applyPatch as applyUnifiedPatch } from "diff";
import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import {
  CHAT_EDITOR_APPLY_MAX_FILE_BYTES,
  CHAT_EDITOR_APPLY_MAX_TOTAL_CONTENT_BYTES,
  queueChatEditorApply,
  type ChatEditorApplyDependencies,
  type ChatEditorApplyInput,
} from "./chat-editor-apply";

const ROOT = "/workspace";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

type FileResponse = Awaited<ReturnType<ChatEditorApplyDependencies["fetchFileContent"]>>;
type CapturedAction = EditorAgentAction & { readonly origin?: unknown };

interface FakeEnvironment {
  readonly dependencies: ChatEditorApplyDependencies;
  readonly actions: CapturedAction[];
  readonly fileCalls: () => number;
  readonly queueCalls: () => number;
}

interface FakeEnvironmentInput {
  readonly sessions?: readonly EditorAgentSessionSnapshot[] | undefined;
  readonly files?: ReadonlyMap<string, FileResponse> | undefined;
  readonly queue?:
    | ((
        action: EditorAgentAction,
        invocation: number,
      ) => Promise<{ result: EditorAgentActionResult }>)
    | undefined;
}

function version(content: string, contentHash = HASH_A, modifiedAt = 10): EditorDocumentVersion {
  return { sizeBytes: encoder.encode(content).length, modifiedAt, contentHash };
}

function session(
  content = "const answer = 1;\n",
  overrides: Partial<EditorAgentSessionSnapshot> = {},
): EditorAgentSessionSnapshot {
  const documentVersion = version(content);
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot: ROOT,
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: { line: 0, character: 12 },
    selection: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    },
    diagnosticsSummary: null,
    documentVersion,
    activeFileContentHash: documentVersion.contentHash,
    textMode: "none",
    updatedAt: 1,
    ...overrides,
  };
}

function fileResponse(
  path: string,
  content: string,
  contentHash = HASH_A,
  modifiedAt = 10,
  maxBytes = 1_000_000,
): FileResponse {
  const documentVersion = version(content, contentHash, modifiedAt);
  return {
    root: ROOT,
    path,
    name: path.split("/").at(-1) ?? path,
    sizeBytes: documentVersion.sizeBytes,
    modifiedAt,
    extension: path.includes(".") ? `.${path.split(".").at(-1) ?? ""}` : null,
    mime: "text/plain",
    symlink: false,
    content,
    maxBytes,
    session: { schemaVersion: "1", version: documentVersion },
  };
}

function queuedResult(action: EditorAgentAction): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "queued",
  };
}

function fakeEnvironment(input: FakeEnvironmentInput = {}): FakeEnvironment {
  const actions: CapturedAction[] = [];
  let fileCallCount = 0;
  let queueCallCount = 0;
  const defaultContent = "const answer = 1;\n";
  const files = input.files ?? new Map([["src/a.ts", fileResponse("src/a.ts", defaultContent)]]);
  const queue = input.queue ?? (async (action) => ({ result: queuedResult(action) }));
  return {
    actions,
    fileCalls: () => fileCallCount,
    queueCalls: () => queueCallCount,
    dependencies: {
      fetchSessions: async () => ({ sessions: input.sessions ?? [session(defaultContent)] }),
      fetchFileContent: async (_root, path) => {
        fileCallCount += 1;
        const response = files.get(path);
        if (response === undefined) throw new ApiError("NOT_FOUND", "File not found.", 404);
        return response;
      },
      queueAction: async (action) => {
        actions.push(action);
        queueCallCount += 1;
        return queue(action, queueCallCount);
      },
      createNonce: () => "nonce-12345678",
    },
  };
}

function input(
  codeBlockText: string,
  language?: string,
  context: ChatEditorApplyInput["context"] = { workspaceRoot: ROOT },
): ChatEditorApplyInput {
  return { codeBlockText, ...(language === undefined ? {} : { language }), context };
}

type ContextIdentifierField = "sessionId" | "windowId";

function contextWithIdentifier(
  field: ContextIdentifierField,
  value: string,
): ChatEditorApplyInput["context"] {
  return field === "sessionId"
    ? { workspaceRoot: ROOT, sessionId: value }
    : { workspaceRoot: ROOT, windowId: value };
}

function sessionWithIdentifier(
  field: ContextIdentifierField,
  value: string,
): EditorAgentSessionSnapshot {
  return session(undefined, field === "sessionId" ? { sessionId: value } : { windowId: value });
}

function modifyPatch(path = "src/a.ts", before = "const answer = 1;", after = "const answer = 2;") {
  return [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${before}`, `+${after}`, ""].join(
    "\n",
  );
}

function multiModifyPatch(
  changes: readonly { readonly path: string; readonly before: string; readonly after: string }[],
): string {
  return changes
    .map(({ path, before, after }) => modifyPatch(path, before, after).trimEnd())
    .join("\n");
}

function conflictResult(
  action: EditorAgentAction,
  code: EditorAgentConflictCode,
): EditorAgentActionResult {
  const message = `Structured ${code} conflict.`;
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "conflict",
    message,
    conflict: { code, message },
  };
}

describe("queueChatEditorApply", () => {
  it("turns plain code into a selection-scoped applyPatch with complete preconditions", async () => {
    const source = "const answer = 1;\n";
    const environment = fakeEnvironment();

    const outcome = await queueChatEditorApply(
      input("result", "typescript"),
      environment.dependencies,
    );

    expect(outcome.kind).toBe("queued");
    const action = environment.actions[0];
    expect(action).toMatchObject({
      type: "applyPatch",
      origin: "chat",
      sessionId: "session-1",
      target: { file: "src/a.ts", paneId: "pane-1" },
      expectedDocumentVersion: version(source),
      expectedContentHash: HASH_A,
    });
    expect(action?.textEdits).toBeUndefined();
    expect(applyUnifiedPatch(source, action?.patch ?? "")).toBe("const result = 1;\n");
  });

  it("queues an unlabeled multi-file patch as one applyChangeset", async () => {
    const patch = multiModifyPatch([
      { path: "src/a.ts", before: "A0", after: "A1" },
      { path: "src/b.ts", before: "B0", after: "B1" },
    ]);
    const files = new Map([
      ["src/a.ts", fileResponse("src/a.ts", "A0\n", HASH_A, 10)],
      ["src/b.ts", fileResponse("src/b.ts", "B0\n", HASH_B, 20)],
    ]);
    const activeVersion = version("A0\n", HASH_A, 10);
    const environment = fakeEnvironment({
      files,
      sessions: [
        session("A0\n", {
          documentVersion: activeVersion,
          activeFileContentHash: activeVersion.contentHash,
        }),
      ],
    });

    const outcome = await queueChatEditorApply(input(patch), environment.dependencies);

    expect(outcome).toMatchObject({ kind: "queued", actionType: "applyChangeset" });
    expect(environment.actions[0]).toMatchObject({
      type: "applyChangeset",
      origin: "chat",
      changeset: {
        files: [
          {
            file: "src/a.ts",
            expectedDocumentVersion: activeVersion,
            expectedContentHash: HASH_A,
          },
          {
            file: "src/b.ts",
            expectedDocumentVersion: version("B0\n", HASH_B, 20),
            expectedContentHash: HASH_B,
          },
        ],
      },
    });
  });

  it("supports create, modify, and delete members through applyChangeset", async () => {
    const patch = [
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+new",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-A0",
      "+A1",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "",
    ].join("\n");
    const files = new Map([
      ["src/a.ts", fileResponse("src/a.ts", "A0\n", HASH_A, 10)],
      ["src/old.ts", fileResponse("src/old.ts", "old\n", HASH_C, 30)],
    ]);
    const activeVersion = version("A0\n", HASH_A, 10);
    const environment = fakeEnvironment({
      files,
      sessions: [
        session("A0\n", {
          documentVersion: activeVersion,
          activeFileContentHash: activeVersion.contentHash,
        }),
      ],
    });

    const outcome = await queueChatEditorApply(input(patch, "diff"), environment.dependencies);

    expect(outcome.kind).toBe("queued");
    const declarations = environment.actions[0]?.changeset?.files;
    expect(declarations).toEqual([
      { file: "src/new.ts", expectedContentHash: EMPTY_HASH },
      {
        file: "src/a.ts",
        expectedDocumentVersion: activeVersion,
        expectedContentHash: HASH_A,
      },
      {
        file: "src/old.ts",
        expectedDocumentVersion: version("old\n", HASH_C, 30),
        expectedContentHash: HASH_C,
      },
    ]);
  });

  it("accepts a UTF-8 target path at the contract bound and rejects one-byte overflow", async () => {
    const prefix = "src/";
    const remainingBytes = EDITOR_AGENT_TARGET_PATH_MAX_BYTES - encoder.encode(prefix).length;
    const boundaryPath = `${prefix}${"\u00e9".repeat(remainingBytes / 2)}`;
    const content = "A0\n";
    const documentVersion = version(content);
    const accepted = fakeEnvironment({
      files: new Map([[boundaryPath, fileResponse(boundaryPath, content)]]),
      sessions: [
        session(content, {
          activeFile: boundaryPath,
          panes: [{ paneId: "pane-1", activeFile: boundaryPath, openFiles: [boundaryPath] }],
          documentVersion,
          activeFileContentHash: documentVersion.contentHash,
        }),
      ],
    });

    expect(encoder.encode(boundaryPath)).toHaveLength(EDITOR_AGENT_TARGET_PATH_MAX_BYTES);
    await expect(
      queueChatEditorApply(
        input(modifyPatch(boundaryPath, "A0", "A1"), "diff"),
        accepted.dependencies,
      ),
    ).resolves.toMatchObject({ kind: "queued" });
    expect(accepted.actions[0]?.target?.file).toBe(boundaryPath);

    const overflow = fakeEnvironment();
    const overflowPath = `${boundaryPath}x`;
    expect(encoder.encode(overflowPath)).toHaveLength(EDITOR_AGENT_TARGET_PATH_MAX_BYTES + 1);
    await expect(
      queueChatEditorApply(
        input(modifyPatch(overflowPath, "A0", "A1"), "diff"),
        overflow.dependencies,
      ),
    ).resolves.toEqual({
      kind: "rejected",
      code: "INVALID_PATCH",
      message: "The patch target is unsupported.",
    });
    expect(overflow.fileCalls()).toBe(0);
    expect(overflow.queueCalls()).toBe(0);

    const overflowContext = fakeEnvironment();
    await expect(
      queueChatEditorApply(
        input("replacement", undefined, { workspaceRoot: ROOT, activeFile: overflowPath }),
        overflowContext.dependencies,
      ),
    ).resolves.toEqual({
      kind: "rejected",
      code: "AMBIGUOUS_TARGET",
      message: "Active-file context is invalid.",
    });
    expect(overflowContext.fileCalls()).toBe(0);
    expect(overflowContext.queueCalls()).toBe(0);
  });

  it.each([
    ["sessionId", EDITOR_AGENT_SESSION_ID_MAX_BYTES],
    ["windowId", EDITOR_AGENT_WINDOW_ID_MAX_BYTES],
  ] as const)(
    "bounds caller-controlled %s by UTF-8 bytes before file access",
    async (field, maxBytes) => {
      const boundary = "\u00e9".repeat(maxBytes / 2);
      const accepted = fakeEnvironment({ sessions: [sessionWithIdentifier(field, boundary)] });

      expect(encoder.encode(boundary)).toHaveLength(maxBytes);
      await expect(
        queueChatEditorApply(
          input("replacement", undefined, contextWithIdentifier(field, boundary)),
          accepted.dependencies,
        ),
      ).resolves.toMatchObject({ kind: "queued" });

      const overflow = fakeEnvironment();
      await expect(
        queueChatEditorApply(
          input("replacement", undefined, contextWithIdentifier(field, `${boundary}x`)),
          overflow.dependencies,
        ),
      ).resolves.toEqual({
        kind: "rejected",
        code: "AMBIGUOUS_SESSION",
        message: "Session context is invalid.",
      });
      expect(overflow.fileCalls()).toBe(0);
      expect(overflow.queueCalls()).toBe(0);
    },
  );

  it("bounds final prefixed action identities before file access", async () => {
    const maxIdentityBytes = Math.min(
      EDITOR_AGENT_ACTION_ID_MAX_BYTES,
      EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
    const prefixBytes = encoder.encode("chat-apply-").length;
    const boundaryNonce = "n".repeat(maxIdentityBytes - prefixBytes);
    const accepted = fakeEnvironment();

    const outcome = await queueChatEditorApply(input("replacement"), {
      ...accepted.dependencies,
      createNonce: () => boundaryNonce,
    });

    expect(outcome).toMatchObject({ kind: "queued" });
    const action = accepted.actions[0];
    expect(action === undefined ? 0 : encoder.encode(action.actionId).length).toBe(
      maxIdentityBytes,
    );
    expect(action === undefined ? 0 : encoder.encode(action.idempotencyKey).length).toBe(
      maxIdentityBytes,
    );
    expect(action === undefined ? false : isEditorAgentAction(action)).toBe(true);

    const overflow = fakeEnvironment();
    await expect(
      queueChatEditorApply(input("replacement"), {
        ...overflow.dependencies,
        createNonce: () => `${boundaryNonce}x`,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      code: "QUEUE_FAILED",
      message: "Secure action identity is unavailable.",
    });
    expect(overflow.fileCalls()).toBe(0);
    expect(overflow.queueCalls()).toBe(0);
  });

  it.each([
    "../../outside.ts",
    "/etc/passwd",
    "/workspace/src/a.ts",
    "C:\\outside.ts",
    "src/../../outside.ts",
  ])("rejects hostile patch target %s before reading files", async (path) => {
    const environment = fakeEnvironment();

    const outcome = await queueChatEditorApply(
      input(modifyPatch(path, "old", "new"), "diff"),
      environment.dependencies,
    );

    expect(outcome).toMatchObject({ kind: "rejected", code: "INVALID_PATCH" });
    expect(environment.actions).toHaveLength(0);
  });

  it("rejects NUL-bearing patch input without exposing it", async () => {
    const environment = fakeEnvironment();

    const outcome = await queueChatEditorApply(
      input(`${modifyPatch()}\u0000private-body`, "diff"),
      environment.dependencies,
    );

    expect(outcome).toEqual({
      kind: "rejected",
      code: "INVALID_BLOCK",
      message: "The assistant code block contains unsupported data.",
    });
  });

  it("maps a denied file read to the existing OUT_OF_SCOPE conflict", async () => {
    const environment = fakeEnvironment();
    const dependencies: ChatEditorApplyDependencies = {
      ...environment.dependencies,
      fetchFileContent: async () => {
        throw new ApiError("DENIED", "Sensitive path denied.", 403);
      },
    };

    const outcome = await queueChatEditorApply(
      input(modifyPatch(".env", "old", "new"), "diff"),
      dependencies,
    );

    expect(outcome).toEqual({
      kind: "conflict",
      code: "OUT_OF_SCOPE",
      message: "A target file is outside policy.",
    });
    expect(environment.actions).toHaveLength(0);
  });

  it("enforces patch byte, file-count, changed-line, and file-content bounds", async () => {
    const environment = fakeEnvironment();
    const oversized = "x".repeat(65_537);
    const tooManyFiles = multiModifyPatch(
      Array.from({ length: 51 }, (_, index) => ({
        path: `src/f${String(index)}.ts`,
        before: "a",
        after: "b",
      })),
    );
    const changedLines = 2_001;
    const tooManyChangedLines = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      `@@ -1,${String(changedLines)} +1,${String(changedLines)} @@`,
      ...Array.from({ length: changedLines }, () => "-a"),
      ...Array.from({ length: changedLines }, () => "+b"),
      "",
    ].join("\n");
    const largeContent = "x".repeat(CHAT_EDITOR_APPLY_MAX_FILE_BYTES + 1);
    const largeVersion = version(largeContent);
    const largeFileEnvironment = fakeEnvironment({
      files: new Map([
        [
          "src/a.ts",
          fileResponse("src/a.ts", largeContent, HASH_A, 10, CHAT_EDITOR_APPLY_MAX_FILE_BYTES + 1),
        ],
      ]),
      sessions: [
        session(largeContent, {
          documentVersion: largeVersion,
          activeFileContentHash: largeVersion.contentHash,
        }),
      ],
    });

    await expect(
      queueChatEditorApply(input(oversized), environment.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "LIMIT_EXCEEDED" });
    await expect(
      queueChatEditorApply(input(tooManyFiles, "diff"), environment.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "LIMIT_EXCEEDED" });
    await expect(
      queueChatEditorApply(input(tooManyChangedLines, "diff"), environment.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "LIMIT_EXCEEDED" });
    await expect(
      queueChatEditorApply(input("replacement", "typescript"), largeFileEnvironment.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "LIMIT_EXCEEDED" });
  });

  it("bounds aggregate target content across a changeset", async () => {
    const fileCount = 5;
    const content = "x".repeat(Math.floor(CHAT_EDITOR_APPLY_MAX_TOTAL_CONTENT_BYTES / 4));
    const changes = Array.from({ length: fileCount }, (_, index) => ({
      path: `src/f${String(index)}.ts`,
      before: "x",
      after: "y",
    }));
    const files = new Map(
      changes.map(({ path }, index) => [
        path,
        fileResponse(path, content, String(index + 1).repeat(64), 10 + index),
      ]),
    );
    const active = files.get("src/f0.ts")!;
    const environment = fakeEnvironment({
      files,
      sessions: [
        session(content, {
          activeFile: "src/f0.ts",
          panes: [{ paneId: "pane-1", activeFile: "src/f0.ts", openFiles: ["src/f0.ts"] }],
          documentVersion: active.session.version,
          activeFileContentHash: active.session.version.contentHash,
        }),
      ],
    });

    const outcome = await queueChatEditorApply(
      input(multiModifyPatch(changes), "diff"),
      environment.dependencies,
    );

    expect(outcome).toMatchObject({ kind: "rejected", code: "LIMIT_EXCEEDED" });
    expect(environment.actions).toHaveLength(0);
  });

  it("fails closed for missing and ambiguous session context", async () => {
    const missing = fakeEnvironment({ sessions: [] });
    const ambiguous = fakeEnvironment({
      sessions: [session(), session(undefined, { sessionId: "session-2", windowId: "window-2" })],
    });

    await expect(
      queueChatEditorApply(input("replacement"), missing.dependencies),
    ).resolves.toMatchObject({ kind: "conflict", code: "NO_ACTIVE_SESSION" });
    await expect(
      queueChatEditorApply(input("replacement"), ambiguous.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "AMBIGUOUS_SESSION" });
    await expect(
      queueChatEditorApply(
        input("replacement", undefined, { workspaceRoot: ROOT, sessionId: "session-1" }),
        ambiguous.dependencies,
      ),
    ).resolves.toMatchObject({ kind: "queued" });
  });

  it("requires one explicit, non-empty live selection for plain code", async () => {
    const noSelection = fakeEnvironment({ sessions: [session(undefined, { selection: null })] });
    const emptySelection = fakeEnvironment({
      sessions: [
        session(undefined, {
          selection: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 6 },
          },
        }),
      ],
    });

    await expect(
      queueChatEditorApply(input("replacement", "typescript"), noSelection.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "AMBIGUOUS_TARGET" });
    await expect(
      queueChatEditorApply(input("replacement", "typescript"), emptySelection.dependencies),
    ).resolves.toMatchObject({ kind: "rejected", code: "AMBIGUOUS_TARGET" });
  });

  it("fails closed when active version or hash preconditions are incomplete or stale", async () => {
    const missing = fakeEnvironment({
      sessions: [
        session(undefined, { documentVersion: undefined, activeFileContentHash: undefined }),
      ],
    });
    const stale = fakeEnvironment({
      sessions: [
        session(undefined, {
          documentVersion: version("const answer = 1;\n", HASH_A, 99),
        }),
      ],
    });

    await expect(
      queueChatEditorApply(input("replacement"), missing.dependencies),
    ).resolves.toMatchObject({ kind: "conflict", code: "PRECONDITION_REQUIRED" });
    await expect(
      queueChatEditorApply(input("replacement"), stale.dependencies),
    ).resolves.toMatchObject({ kind: "conflict", code: "VERSION_MISMATCH" });
    expect(missing.actions).toHaveLength(0);
    expect(stale.actions).toHaveLength(0);
  });

  it.each<EditorAgentConflictCode>([
    "DIRTY",
    "VERSION_MISMATCH",
    "CONTENT_HASH_MISMATCH",
    "NO_ACTIVE_SESSION",
    "NO_ACTIVE_BRIDGE",
    "PRECONDITION_REQUIRED",
  ])("preserves the structured %s conflict returned by the queue", async (code) => {
    let expected: EditorAgentActionResult | undefined;
    const environment = fakeEnvironment({
      queue: async (action) => {
        expected = conflictResult(action, code);
        return { result: expected };
      },
    });

    const outcome = await queueChatEditorApply(
      input(modifyPatch(), "patch"),
      environment.dependencies,
    );

    expect(outcome).toEqual({
      kind: "conflict",
      code,
      message: `Structured ${code} conflict.`,
      result: expected,
    });
  });

  it.each([409, 429])(
    "uses one idempotent replay to recover the structured body hidden by HTTP %s",
    async (status) => {
      const environment = fakeEnvironment({
        queue: async (action, invocation) => {
          if (invocation === 1) {
            throw new ApiError("INTERNAL", `HTTP ${String(status)}`, status);
          }
          return { result: conflictResult(action, "NO_ACTIVE_BRIDGE") };
        },
      });

      const outcome = await queueChatEditorApply(
        input(modifyPatch(), "diff"),
        environment.dependencies,
      );

      expect(environment.queueCalls()).toBe(2);
      expect(environment.actions[0]).toEqual(environment.actions[1]);
      expect(outcome).toMatchObject({ kind: "conflict", code: "NO_ACTIVE_BRIDGE" });
    },
  );

  it("replays an invalid successful response once with the same action identity", async () => {
    const environment = fakeEnvironment({
      queue: async (action, invocation) => {
        if (invocation === 1) {
          return { accepted: true } as unknown as { result: EditorAgentActionResult };
        }
        return { result: queuedResult(action) };
      },
    });

    const outcome = await queueChatEditorApply(
      input(modifyPatch(), "diff"),
      environment.dependencies,
    );

    expect(outcome).toMatchObject({ kind: "queued" });
    expect(environment.queueCalls()).toBe(2);
    expect(environment.actions[0]).toEqual(environment.actions[1]);
  });

  it.each([
    ["network", () => new TypeError("lost response")],
    ["server", () => new ApiError("INTERNAL", "private server detail", 503)],
  ])("replays one uncertain %s outcome with the same action identity", async (_label, error) => {
    const environment = fakeEnvironment({
      queue: async (action, invocation) => {
        if (invocation === 1) throw error();
        return { result: queuedResult(action) };
      },
    });

    const outcome = await queueChatEditorApply(
      input(modifyPatch(), "diff"),
      environment.dependencies,
    );

    expect(outcome).toMatchObject({ kind: "queued" });
    expect(environment.queueCalls()).toBe(2);
    expect(environment.actions[0]).toEqual(environment.actions[1]);
    expect(environment.actions[0]?.actionId).toBe("chat-apply-nonce-12345678");
    expect(environment.actions[0]?.idempotencyKey).toBe("chat-apply-nonce-12345678");
  });

  it("returns outcome-unknown after one unresolved same-identity replay", async () => {
    const environment = fakeEnvironment({
      queue: async () => {
        throw new TypeError("private network detail");
      },
    });

    const outcome = await queueChatEditorApply(
      input(modifyPatch(), "diff"),
      environment.dependencies,
    );

    expect(outcome).toEqual({
      kind: "outcome-unknown",
      actionType: "applyPatch",
      message: "The editor action outcome is unknown. Check the editor.",
    });
    expect(environment.queueCalls()).toBe(2);
    expect(environment.actions[0]).toEqual(environment.actions[1]);
    expect(JSON.stringify(outcome)).not.toContain("private network detail");
  });

  it("never constructs applyTextEdits for plain, single-patch, or changeset input", async () => {
    const source = "const answer = 1;\n";
    const selectionEnvironment = fakeEnvironment();
    const patchEnvironment = fakeEnvironment();
    const files = new Map([
      ["src/a.ts", fileResponse("src/a.ts", source)],
      ["src/b.ts", fileResponse("src/b.ts", "B0\n", HASH_B, 20)],
    ]);
    const changesetEnvironment = fakeEnvironment({ files });

    await queueChatEditorApply(input("result", "typescript"), selectionEnvironment.dependencies);
    await queueChatEditorApply(input(modifyPatch(), "diff"), patchEnvironment.dependencies);
    await queueChatEditorApply(
      input(
        multiModifyPatch([
          { path: "src/a.ts", before: "const answer = 1;", after: "const answer = 2;" },
          { path: "src/b.ts", before: "B0", after: "B1" },
        ]),
        "diff",
      ),
      changesetEnvironment.dependencies,
    );
    const actions = [
      ...selectionEnvironment.actions,
      ...patchEnvironment.actions,
      ...changesetEnvironment.actions,
    ];

    expect(actions).toHaveLength(3);
    expect(actions.every(isEditorAgentAction)).toBe(true);
    expect(actions.map((action) => action.type)).not.toContain("applyTextEdits");
    expect(actions.every((action) => action.textEdits === undefined)).toBe(true);
  });
});
