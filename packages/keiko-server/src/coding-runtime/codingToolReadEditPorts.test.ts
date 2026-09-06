import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  EditorAgentAction,
  EditorAgentChangeset,
  EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { CodingRuntimeEditorMutationLeaseRegistration } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import {
  createCodingToolReadEditPorts,
  NO_ACTIVE_SESSION_MESSAGE,
} from "./codingToolReadEditPorts.js";

const DIGEST = "a".repeat(64);
const SENTINEL = "RAW_PATH_CONTENT_PATCH_CAPABILITY_SENTINEL";

const admittedBinding = {
  runId: "run-authority-a",
  envelopeDigest: DIGEST,
  workspaceId: "workspace-authority-a",
  workspaceRootDigest: DIGEST,
  expiresAt: "2026-07-12T12:00:00.000Z",
};

// A producer binding whose authority is still live at the moment the test runs, so the discovery
// preflight admits it and the failure diagnostic is filed under this run id rather than the
// no-binding fallback. Derived from the clock, never a fixed future date that silently expires.
function liveDiscoveryBinding(): {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly expiresAt: string;
} {
  return {
    runId: "run-discovery-live",
    envelopeDigest: DIGEST,
    workspaceId: "workspace-discovery-live",
    workspaceRootDigest: DIGEST,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function changeset(): EditorAgentChangeset {
  return {
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
    files: [{ file: "src/a.ts", expectedContentHash: DIGEST }],
  };
}

function editorSession(sessionId: string, workspaceRoot: string): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId,
    windowId: "editor",
    workspaceRoot,
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

function singleUseManagedAccess(root: string): () =>
  | {
      readonly kind: "managed-task";
      readonly canonicalRoot: string;
      readonly fs: typeof nodeWorkspaceFs;
      readonly repositoryRoot: string;
    }
  | undefined {
  let available = true;
  return () => {
    if (!available) return undefined;
    available = false;
    return { kind: "managed-task", canonicalRoot: root, fs: nodeWorkspaceFs, repositoryRoot: root };
  };
}

describe("CodingTool read/edit producer adapters (Issue #2332)", () => {
  it("denies discovery when managed-root authority is revoked before postflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-coding-revoked-discover-"));
    try {
      writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: vi.fn(),
        resolveWorkspaceRoot: () => root,
        resolveWorkspaceRootAccess: singleUseManagedAccess(root),
      });

      await expect(
        ports.repositoryDiscover.execute(
          {
            action: "discover",
            actionId: "discover-revoked",
            idempotencyKey: "discover-revoked-key",
            query: "*",
            maxResults: 10,
          },
          undefined,
          { check: (): true => true },
        ),
      ).resolves.toEqual({ status: "failed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies a read when managed-root authority is revoked before postflight", async () => {
    const root = "/managed/workspace";
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: {
        readText: () => Promise.resolve({ ok: true, text: "must-not-be-returned" }),
      },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      resolveWorkspaceRoot: () => root,
      resolveWorkspaceRootAccess: singleUseManagedAccess(root),
    });

    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-revoked",
          idempotencyKey: "read-revoked-key",
          relativePath: "src/a.ts",
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed" });
  });

  // The revoked-access refusal used to return a bare `{ status: "failed" }` with nothing on the
  // activity log, so the model could not tell it from a retryable editor conflict and kept
  // re-issuing the edit while the workspace authority stayed gone (cursor review, PR #3381). The
  // closed reason code AND the `edit-refused` line under the run's own correlation are the pin.
  it("denies an edit with a closed reason and a correlated diagnostic when managed-root authority is revoked before the effect", async () => {
    const root = "/managed/workspace";
    const action = vi.fn();
    const records: ServerDiagnosticRecord[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action },
      resolveEditorActionContext: () => ({
        sessionId: "session-revoked",
        authorityRef: { runId: "run-revoked", envelopeDigest: DIGEST },
        origin: "agent",
        workspaceRoot: root,
      }),
      resolveWorkspaceRoot: () => root,
      resolveWorkspaceRootAccess: singleUseManagedAccess(root),
      diagnostics: { record: (record): void => void records.push(record) },
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "edit-revoked",
          idempotencyKey: "edit-revoked-key",
          changeset: changeset(),
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "WORKSPACE_ACCESS_LOST" });
    expect(action).not.toHaveBeenCalled();
    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.editor-changeset",
        source: "coding-tool-read-edit-ports.edit",
        message: "edit-refused",
        errorClass: "WORKSPACE_ACCESS_LOST",
        correlationId: "run-revoked",
      }),
    ]);
  });

  // The prepare stage refuses before any editor action exists, so its correlation has to come from
  // the run's own editor context; before this it left no line at all.
  it("emits a correlated prepare refusal when the changeset never reaches the editor route", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const action = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action },
      resolveEditorActionContext: () => ({
        sessionId: "session-prepare",
        authorityRef: { runId: "run-prepare-1", envelopeDigest: DIGEST },
        origin: "agent",
      }),
      diagnostics: { record: (record): void => void records.push(record) },
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "edit-prepare",
          idempotencyKey: "edit-prepare-key",
          changeset: { patch: "x", files: [] },
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED" });
    expect(action).not.toHaveBeenCalled();
    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.editor-changeset",
        message: "edit-refused",
        errorClass: "EDIT_PREPARE_FAILED",
        correlationId: "run-prepare-1",
      }),
    ]);
  });

  it("discovers exact governed file paths without exposing denied or unrelated entries", async (): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), "keiko-coding-discover-"));
    try {
      mkdirSync(join(root, "packages", "ui", "src"), { recursive: true });
      mkdirSync(join(root, "ignored"), { recursive: true });
      writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
      writeFileSync(join(root, ".gitignore"), "ignored/\n");
      writeFileSync(join(root, ".env"), "PRIVATE_SENTINEL=1\n");
      writeFileSync(join(root, "ignored", "safeActivity-secret.ts"), "ignored\n");
      writeFileSync(join(root, "packages", "ui", "src", "useSafeActivity.ts"), "export {};\n");
      writeFileSync(join(root, "packages", "ui", "src", "composer.ts"), "export {};\n");
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: () => ({
          sessionId: "session-discover",
          authorityRef: { runId: "run-discover", envelopeDigest: DIGEST },
          origin: "agent",
        }),
        resolveWorkspaceRoot: () => root,
      });

      const result = await ports.repositoryDiscover.execute(
        {
          action: "discover",
          actionId: "discover-1",
          idempotencyKey: "discover-key",
          query: "safe activity",
          maxResults: 10,
        },
        undefined,
        { check: (): true => true },
      );

      expect(result).toMatchObject({
        status: "completed",
        read: { text: "packages/ui/src/useSafeActivity.ts\n", totalLines: 1 },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
      expect(JSON.stringify(result)).not.toContain("ignored");

      const all = await ports.repositoryDiscover.execute(
        {
          action: "discover",
          actionId: "discover-all",
          idempotencyKey: "discover-all-key",
          query: "*",
          maxResults: 10,
        },
        undefined,
        { check: (): true => true },
      );
      expect(all).toMatchObject({ status: "completed" });
      expect(JSON.stringify(all)).not.toContain(".env");
      expect(JSON.stringify(all)).not.toContain("ignored");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The correlation a discovery failure is filed under is the RUN's, and the only sanctioned
  // stand-in when no producer binding is in scope is UNKNOWN_CORRELATION_ID. The tool action id is
  // never it: the `session:call` shape the sidecar mints is rewritten to "invalid-correlation-id"
  // by the sink, so admitting it made an honestly-absent id indistinguishable from a hostile one
  // (PR #3381 review). Both rows run the same failure through one table so the fallback cannot be
  // fixed by re-adding a second, laxer id shape for one of them.
  it.each([
    ["no producer binding", undefined, "unknown-correlation-id"],
    ["a live producer binding", liveDiscoveryBinding(), "run-discovery-live"],
  ] as const)(
    "emits a redacted diagnostic under the run's correlation when workspace discovery throws (%s)",
    async (_label, binding, expectedCorrelationId): Promise<void> => {
      const records: ServerDiagnosticRecord[] = [];
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: () => ({
          sessionId: "session-discover",
          authorityRef: { runId: "run-discover", envelopeDigest: DIGEST },
          origin: "agent",
        }),
        ...(binding === undefined
          ? {}
          : { resolveRepositoryReadContext: (): typeof binding => binding }),
        resolveWorkspaceRoot: (): never => {
          throw new Error(SENTINEL);
        },
        diagnostics: { record: (record): void => void records.push(record) },
      });

      const result = await ports.repositoryDiscover.execute(
        {
          action: "discover",
          actionId: "discover-failure",
          idempotencyKey: "discover-failure-key",
          query: "*",
          maxResults: 10,
        },
        undefined,
        binding === undefined ? { check: (): true => true } : { check: (): true => true, binding },
      );

      expect(result).toEqual({ status: "failed" });
      expect(records).toEqual([
        expect.objectContaining({
          correlationId: expectedCorrelationId,
          operation: "coding-runtime.workspace-discovery",
          source: "coding-tool-read-edit-ports.discover",
          errorClass: "Error",
          message: "workspace-discovery-failed",
        }),
      ]);
      expect(JSON.stringify(records)).not.toContain("discover-failure");
      expect(JSON.stringify(records)).not.toContain(SENTINEL);
    },
  );

  it("uses only SecureWorkspaceTextReadPort and exposes the sole bounded content-bearing read result", async () => {
    const readText = vi.fn(() =>
      Promise.resolve({ ok: true as const, text: "const value = 1;\n" }),
    );
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    const result = await ports.repositoryRead.execute(
      { action: "read", actionId: "read-1", idempotencyKey: "read-key", relativePath: "src/a.ts" },
      undefined,
      { check: (): true => true },
    );

    expect(readText).toHaveBeenCalledWith({ relativePath: "src/a.ts", signal: undefined });
    expect(editorAction).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "completed",
      read: {
        text: "const value = 1;\n",
        byteCount: Buffer.byteLength("const value = 1;\n", "utf8"),
        digest: "8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d",
        totalLines: 1,
      },
    });
  });

  it("returns the requested line window while keeping the digest anchored to the whole file (#2473)", async () => {
    const fullText = "line one\nline two\nline three\nline four\n";
    const wholeFileDigest = createHash("sha256").update(fullText, "utf8").digest("hex");
    const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: fullText }));
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });
    const execute = (window: {
      readonly startLine?: number;
      readonly maxLines?: number;
    }): ReturnType<typeof ports.repositoryRead.execute> =>
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-1",
          idempotencyKey: "read-key",
          relativePath: "src/a.ts",
          ...window,
        },
        undefined,
        { check: (): true => true },
      );

    await expect(execute({ startLine: 2, maxLines: 2 })).resolves.toEqual({
      status: "completed",
      read: {
        text: "line two\nline three\n",
        byteCount: Buffer.byteLength("line two\nline three\n", "utf8"),
        digest: wholeFileDigest,
        totalLines: 4,
        nextStartLine: 4,
      },
    });
    await expect(execute({ startLine: 4 })).resolves.toEqual({
      status: "completed",
      read: {
        text: "line four\n",
        byteCount: Buffer.byteLength("line four\n", "utf8"),
        digest: wholeFileDigest,
        totalLines: 4,
      },
    });
    // A window past the end stays an honest empty page, never a failure.
    await expect(execute({ startLine: 5 })).resolves.toEqual({
      status: "completed",
      read: { text: "", byteCount: 0, digest: wholeFileDigest, totalLines: 4 },
    });
    await expect(execute({ maxLines: 1 })).resolves.toMatchObject({
      read: { text: "line one\n", totalLines: 4, nextStartLine: 2 },
    });
  });

  it("returns content-free read failures and cancellation without calling a writer", async () => {
    const readText = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: "cancelled" as const }),
    );
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    const result = await ports.repositoryRead.execute(
      { action: "read", actionId: "read-1", idempotencyKey: "read-key", relativePath: "src/a.ts" },
      undefined,
      { check: (): true => true },
    );

    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(editorAction).not.toHaveBeenCalled();
  });

  it("fails closed when a compromised read port returns more than 65,536 bytes", async () => {
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: {
        readText: () => Promise.resolve({ ok: true, text: "x".repeat(65_537) }),
      },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-1",
          idempotencyKey: "read-key",
          relativePath: "src/a.ts",
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it.each([".env", ".ENV", "nested/.env", "nested/.ENV"])(
    "checks canonical sensitive-path denial immediately before the secure reader for %s",
    async (relativePath) => {
      const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: "SECRET" }));
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: () => ({
          sessionId: "session-2332",
          authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
          origin: "agent",
        }),
      });

      await expect(
        ports.repositoryRead.execute(
          { action: "read", actionId: "read-1", idempotencyKey: "read-key", relativePath },
          undefined,
          { check: (): true => true },
        ),
      ).resolves.toEqual({ status: "failed" });
      expect(readText).not.toHaveBeenCalled();
    },
  );

  it("carries the admitted immutable binding to the read producer and denies a cross-wired workspace", async () => {
    const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: "SECRET" }));
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-editor-b", envelopeDigest: "b".repeat(64) },
        origin: "agent",
      }),
      // Issue #2332: the read producer must receive the same trusted binding as its admission.
      resolveRepositoryReadContext: () => ({
        runId: "run-reader-b",
        envelopeDigest: "b".repeat(64),
        workspaceId: "workspace-reader-b",
        workspaceRootDigest: "b".repeat(64),
        expiresAt: "2026-07-12T12:00:00.000Z",
      }),
    } as never);

    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-1",
          idempotencyKey: "read-key",
          relativePath: "src/a.ts",
        },
        undefined,
        { check: (): true => true, binding: admittedBinding },
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(readText).not.toHaveBeenCalled();
  });

  it("sends a validated changeset through the existing editor action client with server-attached identity", async () => {
    let adapterSignal: AbortSignal | undefined;
    const editorAction = vi.fn((_action: EditorAgentAction, signal: AbortSignal) => {
      adapterSignal = signal;
      return Promise.resolve({
        ok: true as const,
        value: {
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: "edit-1",
            sessionId: "session-2332",
            status: "queued" as const,
          },
        },
      });
    });
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await ports.editorChangeset.execute(
      {
        action: "edit",
        actionId: "edit-1",
        idempotencyKey: "edit-key",
        changeset: changeset(),
      },
      undefined,
      { check: (): true => true },
    );

    expect(editorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "edit-1",
        idempotencyKey: "edit-key",
        sessionId: "session-2332",
        type: "applyChangeset",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
        changeset: changeset(),
      }),
      adapterSignal,
    );
    expect(adapterSignal).toBeInstanceOf(AbortSignal);
  });

  // A refused edit used to leave no trace outside the in-memory editor audit feed; the activity
  // log must carry the refusal with its closed-vocabulary reason (end-to-end run, 2026-09-03).
  it("emits a body-free refusal diagnostic when the editor route rejects the changeset", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const editorAction = vi.fn((_action: EditorAgentAction, _signal: AbortSignal) =>
      Promise.resolve({
        ok: true as const,
        value: {
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: "edit-refused-1",
            sessionId: "session-2332",
            status: "conflict" as const,
            conflict: { code: "OUT_OF_SCOPE" as const, message: "The target escapes the root." },
          },
        },
      }),
    );
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      diagnostics: { record: (record): void => void records.push(record) },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "edit-refused-1",
          idempotencyKey: "edit-refused-key",
          changeset: changeset(),
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "OUT_OF_SCOPE" });
    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.editor-changeset",
        source: "coding-tool-read-edit-ports.edit",
        message: "edit-refused",
        errorClass: "OUT_OF_SCOPE",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("escapes the root");
  });

  it("normalizes the real single-file raw-index model patch before editor validation", async () => {
    const editorAction = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: "edit-raw",
            sessionId: "session-2332",
            status: "queued" as const,
          },
        },
      }),
    );
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "edit-raw",
          idempotencyKey: "edit-raw-key",
          changeset: {
            patch:
              ":100644 100644 1d9d46e 0000000 M README.md\n@@ -1 +1,2 @@\n # Keiko\n+Model edit\n",
            files: [{ file: "README.md", expectedContentHash: DIGEST }],
          },
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "completed" });
    expect(editorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changeset: {
          patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Keiko\n+Model edit\n",
          files: [{ file: "README.md", expectedContentHash: DIGEST }],
        },
      }),
      expect.any(AbortSignal),
    );
  });

  it.each([
    ":100644 100644 1d9d46e 0000000 M other.md\n@@ -1 +1 @@\n-old\n+new\n",
    ":100644 100644 1d9d46e 0000000 A README.md\n@@ -1 +1 @@\n-old\n+new\n",
    ":100644 100644 1d9d46e 0000000 M README.md\n-old\n+new\n",
  ])("rejects an unsafe raw-index compatibility patch", async (patch) => {
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "edit-raw",
          idempotencyKey: "edit-raw-key",
          changeset: {
            patch,
            files: [{ file: "README.md", expectedContentHash: DIGEST }],
          },
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "binds the trusted requiresReview=%s decision into the content-free mutation lease",
    async (requiresReview) => {
      const register = vi.fn(
        (_registration: CodingRuntimeEditorMutationLeaseRegistration): boolean => true,
      );
      const liveBinding = {
        ...admittedBinding,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: {
          action: () =>
            Promise.resolve({
              ok: true as const,
              value: {
                result: {
                  schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                  actionId: "edit-1",
                  sessionId: "session-2332",
                  status: "queued" as const,
                },
              },
            }),
        },
        resolveEditorActionContext: () => ({
          sessionId: "session-2332",
          authorityRef: {
            runId: liveBinding.runId,
            envelopeDigest: liveBinding.envelopeDigest,
          },
          origin: "agent",
          workspaceId: liveBinding.workspaceId,
          workspaceRootDigest: liveBinding.workspaceRootDigest,
          expiresAt: liveBinding.expiresAt,
        }),
        requiresEditorReview: () => requiresReview,
        mutationLeaseCoordinator: {
          register,
          discard: vi.fn((): boolean => true),
          waitForMutation: () => Promise.resolve("succeeded"),
        },
      });

      await expect(
        ports.editorChangeset.execute(
          {
            action: "edit",
            actionId: "edit-1",
            idempotencyKey: "edit-key",
            changeset: changeset(),
          },
          undefined,
          { check: (): true => true, binding: liveBinding },
        ),
      ).resolves.toEqual({ status: "completed" });
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "edit-1",
          idempotencyKey: "edit-key",
          requiresReview,
        }),
      );
      expect(register.mock.calls[0]?.[0]).not.toHaveProperty("changeset");
    },
  );

  it("waits boundedly for the live Editor session in the governed workspace", async () => {
    vi.useFakeTimers();
    try {
      const listSessions = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { sessions: [] } })
        .mockResolvedValueOnce({
          ok: true,
          value: { sessions: [editorSession("browser-session", "/managed/repo")] },
        });
      const action = vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: {
            result: {
              schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
              actionId: "edit-1",
              sessionId: "browser-session",
              status: "queued" as const,
            },
          },
        }),
      );
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action, listSessions },
        resolveEditorActionContext: () => ({
          sessionId: "runtime-run-1",
          authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
          origin: "agent",
          workspaceRoot: "/managed/repo",
        }),
      });

      const outcome = ports.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true },
      );
      await vi.advanceTimersByTimeAsync(250);

      await expect(outcome).resolves.toEqual({ status: "completed" });
      expect(listSessions).toHaveBeenCalledTimes(2);
      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "browser-session" }),
        expect.any(AbortSignal),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed after the bounded session window when only another workspace is live", async () => {
    vi.useFakeTimers();
    try {
      const listSessions = vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: { sessions: [editorSession("foreign-session", "/other/repo")] },
        }),
      );
      const action = vi.fn();
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action, listSessions },
        resolveEditorActionContext: () => ({
          sessionId: "runtime-run-1",
          authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
          origin: "agent",
          workspaceRoot: "/managed/repo",
        }),
      });

      const outcome = ports.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true },
      );
      await vi.advanceTimersByTimeAsync(11_750);

      await expect(outcome).resolves.toEqual({
        status: "failed",
        reasonCode: "NO_ACTIVE_SESSION",
        message: NO_ACTIVE_SESSION_MESSAGE,
      });
      expect(listSessions).toHaveBeenCalledTimes(7);
      expect(action).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Epic #3384 cascade: the model used to see the bare "NO_ACTIVE_SESSION" code with no
  // explanation and asked the operator "how would you like to proceed?" instead of being told to
  // reconnect the Workbench. The outcome now carries one actionable sentence — while the
  // activity-log diagnostic (AGENTS.md §8: body-free evidence) stays reason-code-only and never
  // carries that sentence, so it cannot leak into a log a customer might attach unredacted.
  it("names the actual condition in the refused edit's outcome while the diagnostic stays reason-code-only", async () => {
    vi.useFakeTimers();
    try {
      const records: ServerDiagnosticRecord[] = [];
      const listSessions = vi.fn(() =>
        Promise.resolve({ ok: true as const, value: { sessions: [] } }),
      );
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action: vi.fn(), listSessions },
        resolveEditorActionContext: () => ({
          sessionId: "runtime-run-msg",
          authorityRef: { runId: "run-message-1", envelopeDigest: DIGEST },
          origin: "agent",
          workspaceRoot: "/managed/repo",
        }),
        diagnostics: { record: (record): void => void records.push(record) },
      });

      const outcome = ports.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true },
      );
      await vi.advanceTimersByTimeAsync(11_750);

      await expect(outcome).resolves.toEqual({
        status: "failed",
        reasonCode: "NO_ACTIVE_SESSION",
        message:
          "no Coding Workbench is connected for this workspace; keep the Workbench open and retry",
      });
      expect(records).toEqual([
        expect.objectContaining({
          operation: "coding-runtime.editor-changeset",
          source: "coding-tool-read-edit-ports.edit",
          message: "edit-refused",
          errorClass: "NO_ACTIVE_SESSION",
          correlationId: "run-message-1",
        }),
      ]);
      expect(records[0]).not.toHaveProperty("extra.message");
      expect(JSON.stringify(records)).not.toContain(NO_ACTIVE_SESSION_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops session acquisition on a list failure or caller abort", async () => {
    const action = vi.fn();
    const failedList = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: { kind: "route" as const, code: "UNAVAILABLE", message: "redacted" },
      }),
    );
    const failedPorts = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action, listSessions: failedList },
      resolveEditorActionContext: () => ({
        sessionId: "runtime-run-1",
        authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
        origin: "agent",
        workspaceRoot: "/managed/repo",
      }),
    });

    await expect(
      failedPorts.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "NO_ACTIVE_SESSION",
      message: NO_ACTIVE_SESSION_MESSAGE,
    });

    const controller = new AbortController();
    const emptyList = vi.fn(() => Promise.resolve({ ok: true as const, value: { sessions: [] } }));
    const abortedPorts = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action, listSessions: emptyList },
      resolveEditorActionContext: () => ({
        sessionId: "runtime-run-2",
        authorityRef: { runId: "run-2", envelopeDigest: DIGEST },
        origin: "agent",
        workspaceRoot: "/managed/repo",
      }),
    });
    const aborted = abortedPorts.editorChangeset.execute(
      { action: "edit", actionId: "edit-2", idempotencyKey: "edit-key-2", changeset: changeset() },
      controller.signal,
      { check: (): true => true },
    );
    await vi.waitFor(() => {
      expect(emptyList).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(aborted).resolves.toEqual({
      status: "failed",
      reasonCode: "NO_ACTIVE_SESSION",
      message: NO_ACTIVE_SESSION_MESSAGE,
    });
    expect(failedList).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects malformed changesets or a revoked final guard before queueing an editor action", async () => {
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "bad",
          idempotencyKey: "bad",
          changeset: { patch: "x", files: [] },
        },
        undefined,
        { check: (): false => false },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it("carries the admitted immutable binding to the editor producer and denies a cross-wired editor context", async () => {
    const editorAction = vi.fn(() => Promise.resolve({ ok: true, value: { status: "queued" } }));
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: editorAction },
      resolveEditorActionContext: () => ({
        sessionId: "session-cross-wired",
        authorityRef: { runId: "run-editor-b", envelopeDigest: "b".repeat(64) },
        origin: "agent",
        workspaceId: "workspace-editor-b",
        workspaceRootDigest: "b".repeat(64),
        expiresAt: "2026-07-12T12:00:00.000Z",
      }),
    } as never);

    await expect(
      ports.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true, binding: admittedBinding },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED" });
    expect(editorAction).not.toHaveBeenCalled();
  });

  it.each([
    [200, "queued", "completed"],
    [200, "succeeded", "completed"],
    [200, "failed", "failed"],
    [200, "conflict", "failed"],
    [403, "conflict", "failed"],
    [409, "conflict", "failed"],
    [429, "failed", "failed"],
  ] as const)(
    "uses the real EditorAgentHttpClient with an adapter-owned signal and maps HTTP %s/%s to %s",
    async (httpStatus, editorStatus, expectedStatus) => {
      let adapterSignal: AbortSignal | undefined;
      const client = new EditorAgentHttpClient({
        baseUrl: "http://127.0.0.1:1983",
        transport: {
          request: (
            request,
          ): Promise<{
            readonly status: number;
            readonly body: Uint8Array;
            readonly url: string;
            readonly redirected: boolean;
          }> => {
            adapterSignal = request.signal;
            return Promise.resolve({
              status: httpStatus,
              body: Buffer.from(
                JSON.stringify({
                  result: {
                    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                    actionId: "edit-1",
                    sessionId: "session-2332",
                    status: editorStatus,
                  },
                }),
              ),
              url: request.url,
              redirected: false,
            });
          },
        },
      });
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: client,
        resolveEditorActionContext: () => ({
          sessionId: "session-2332",
          authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
          origin: "agent",
        }),
      } as never);

      await expect(
        ports.editorChangeset.execute(
          {
            action: "edit",
            actionId: "edit-1",
            idempotencyKey: "edit-key",
            changeset: changeset(),
          },
          undefined,
          { check: (): true => true },
        ),
      ).resolves.toEqual({ status: expectedStatus });
      expect(adapterSignal).toBeInstanceOf(AbortSignal);
    },
  );

  it("rejects an adapter-owned editor-client timeout without content and without a caller signal", async () => {
    let adapterSignal: AbortSignal | undefined;
    const client = new EditorAgentHttpClient({
      baseUrl: "http://127.0.0.1:1983",
      transport: {
        request: (request): Promise<never> => {
          adapterSignal = request.signal;
          return new Promise(() => undefined);
        },
      },
      scheduler: {
        set: (callback): string => {
          callback();
          return "timeout";
        },
        clear: (): void => undefined,
      },
    });
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: client,
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: "run-2332", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    } as never);

    const result = await ports.editorChangeset.execute(
      { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
      undefined,
      { check: (): true => true },
    );

    expect(result).toEqual({ status: "failed", reasonCode: "TIMED_OUT" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(adapterSignal).toBeInstanceOf(AbortSignal);
    expect(adapterSignal?.aborted).toBe(true);
  });

  // Regression: KEIKO-0469. When `enforceProducerBinding: true` is wired, a mutationGuard that
  // omits `binding` altogether must be denied at the preflight boundary — previously mutationBinding
  // returned `undefined` and readContextMatches/editorContextMatches short-circuited to `true`, so
  // reads/discovers/edits proceeded as if no binding enforcement were required.
  describe("binding-enforcement (KEIKO-0469)", () => {
    it("denies a bindingless mutationGuard for read/discover/edit when enforceProducerBinding is on", async () => {
      const readText = vi.fn(() =>
        Promise.resolve({ ok: true as const, text: "const value = 1;\n" }),
      );
      const editorAction = vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: {
            result: {
              schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
              actionId: "edit-1",
              sessionId: "session-2332",
              status: "queued" as const,
            },
          },
        }),
      );
      const root = mkdtempSync(join(tmpdir(), "keiko-coding-binding-"));
      try {
        writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
        const ports = createCodingToolReadEditPorts({
          secureWorkspaceTextRead: { readText },
          editorAgentClient: { action: editorAction },
          resolveEditorActionContext: () => ({
            sessionId: "session-binding",
            authorityRef: { runId: "run-binding", envelopeDigest: DIGEST },
            origin: "agent",
            workspaceRoot: root,
            workspaceId: admittedBinding.workspaceId,
            workspaceRootDigest: admittedBinding.workspaceRootDigest,
            expiresAt: admittedBinding.expiresAt,
          }),
          resolveRepositoryReadContext: () => admittedBinding,
          resolveWorkspaceRoot: () => root,
          enforceProducerBinding: true,
        });

        const bindingless = { check: (): true => true };

        await expect(
          ports.repositoryRead.execute(
            {
              action: "read",
              actionId: "read-1",
              idempotencyKey: "read-key",
              relativePath: "package.json",
            },
            undefined,
            bindingless,
          ),
        ).resolves.toEqual({ status: "failed" });
        expect(readText).not.toHaveBeenCalled();

        await expect(
          ports.repositoryDiscover.execute(
            {
              action: "discover",
              actionId: "discover-1",
              idempotencyKey: "discover-key",
              query: "package",
              maxResults: 10,
            },
            undefined,
            bindingless,
          ),
        ).resolves.toEqual({ status: "failed" });

        await expect(
          ports.editorChangeset.execute(
            {
              action: "edit",
              actionId: "edit-1",
              idempotencyKey: "edit-key",
              changeset: changeset(),
            },
            undefined,
            bindingless,
          ),
        ).resolves.toEqual({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED" });
        expect(editorAction).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps the pre-existing bindingless behavior when enforceProducerBinding is unset", async () => {
      // A test-focused wiring without `enforceProducerBinding: true` opts out of the new defense
      // and preserves the prior semantics — this is the escape hatch that keeps the ~17 pre-existing
      // tests in this file green without adding binding infrastructure to each of them.
      const readText = vi.fn(() =>
        Promise.resolve({ ok: true as const, text: "const value = 1;\n" }),
      );
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: () => ({
          sessionId: "session-legacy",
          authorityRef: { runId: "run-legacy", envelopeDigest: DIGEST },
          origin: "agent",
        }),
      });
      await expect(
        ports.repositoryRead.execute(
          {
            action: "read",
            actionId: "read-1",
            idempotencyKey: "read-key",
            relativePath: "src/a.ts",
          },
          undefined,
          { check: (): true => true },
        ),
      ).resolves.toMatchObject({ status: "completed" });
    });
  });
});
