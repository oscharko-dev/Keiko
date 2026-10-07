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
import {
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
  EDITOR_AGENT_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import type { CodingRuntimeEditorMutationLeaseRegistration } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingToolMutationGuard, MaterializedPatchCharge } from "./codingToolFacadePorts.js";
import {
  createCodingToolReadEditPorts,
  NO_ACTIVE_SESSION_MESSAGE,
} from "./codingToolReadEditPorts.js";
import { createMaterializedPatchRegistry } from "./materializedPatchRegistry.js";
import type {
  SecureWorkspaceTextReadPort,
  SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";
import { secureWorkspaceTextDigest } from "./secureWorkspaceTextRead.js";
import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "./secureWorkspaceTextReadProtocol.js";
import { WORKSPACE_PATH_ABSENCE_VERDICTS } from "./secureWorkspaceTextReadAbsence.js";

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

type WorkspaceReadFailureFixture =
  "exception" | "oversize" | "postflight" | "preflight" | "secure-refusal";

async function observedWorkspaceReadFailure(kind: WorkspaceReadFailureFixture): Promise<{
  readonly diagnostics: readonly ServerDiagnosticRecord[];
  readonly events: readonly ServerLogEvent[];
  readonly result: unknown;
}> {
  const binding = { ...liveDiscoveryBinding(), runId: "run-read-failure" };
  const diagnostics: ServerDiagnosticRecord[] = [];
  const events: ServerLogEvent[] = [];
  let contextReads = 0;
  const readText = vi.fn((): Promise<SecureWorkspaceTextReadResult> => {
    if (kind === "exception") return Promise.reject(new Error(SENTINEL));
    if (kind === "secure-refusal") {
      return Promise.resolve({ ok: false, reason: "process-failed" });
    }
    return Promise.resolve({
      ok: true,
      text: kind === "oversize" ? "x".repeat(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES + 1) : "safe\n",
    });
  });
  const ports = createCodingToolReadEditPorts({
    secureWorkspaceTextRead: { readText },
    editorAgentClient: { action: vi.fn() },
    resolveEditorActionContext: vi.fn(),
    resolveRepositoryReadContext: () => {
      contextReads += 1;
      return kind === "postflight" && contextReads > 1
        ? { ...binding, workspaceId: "other-workspace" }
        : binding;
    },
    diagnostics: { record: (record): void => void diagnostics.push(record) },
    activityLog: { write: (event): void => void events.push(event) },
    enforceProducerBinding: true,
  });
  const result = await ports.repositoryRead.execute(
    {
      action: "read",
      actionId: "read-failure",
      idempotencyKey: "read-failure-key",
      relativePath: "src/private-name.ts",
    },
    kind === "preflight" ? AbortSignal.abort() : undefined,
    { check: (): true => true, binding },
  );
  return { diagnostics, events, result };
}

function editRefusedLines(events: readonly ServerLogEvent[]): readonly ServerLogEvent[] {
  return events.filter((event) => event.op === "coding-runtime.edit.refused");
}

// #3615: a read the secure read refuses for the model's own request names its closed code, so the
// model can act on it and the catalog settles the call as a refusal; a fault stays a bare failure.
describe("workspace read refusal codes", () => {
  const readWith = async (result: SecureWorkspaceTextReadResult): Promise<unknown> => {
    const binding = { ...liveDiscoveryBinding(), runId: "run-read-refusal" };
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: () => Promise.resolve(result) },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      resolveRepositoryReadContext: () => binding,
      activityLog: { write: (): void => undefined },
      enforceProducerBinding: true,
    });
    return ports.repositoryRead.execute(
      {
        action: "read",
        actionId: "read-refusal",
        idempotencyKey: "read-refusal-key",
        relativePath: "src/example.ts",
      },
      undefined,
      { check: (): true => true, binding },
    );
  };

  it.each([
    ["denied", "workspace-read-denied"],
    ["not-found", "workspace-read-not-found"],
    ["not-text", "workspace-read-not-text"],
    ["too-large", "workspace-read-too-large"],
  ] as const)("names a %s refusal as %s", async (reason, reasonCode) => {
    await expect(readWith({ ok: false, reason })).resolves.toEqual({
      status: "failed",
      reasonCode,
    });
  });

  it.each(["process-failed", "timeout", "artifact-unverified"] as const)(
    "keeps a %s fault a bare failure",
    async (reason) => {
      await expect(readWith({ ok: false, reason })).resolves.toEqual({ status: "failed" });
    },
  );
});

// #3873 review (PR #3876): a creation refused `denied` could not be told apart in the log. The
// secure read refines the helper's single `access-denied` into `not-found` or `denied` and says why
// with the closed verdict of its walk, which the governed read writes on the `coding-runtime.
// workspace-read` line it already writes: one closed word, never the path or an error text.
describe("the walk's verdict on the workspace-read line", () => {
  async function failedReadLine(
    answer: SecureWorkspaceTextReadResult,
  ): Promise<{ readonly event: ServerLogEvent | undefined; readonly result: unknown }> {
    const binding = { ...liveDiscoveryBinding(), runId: "run-read-verdict" };
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: () => Promise.resolve(answer) },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      resolveRepositoryReadContext: () => binding,
      activityLog: { write: (event): void => void events.push(event) },
      enforceProducerBinding: true,
    });
    const result = await ports.repositoryRead.execute(
      {
        action: "read",
        actionId: "read-verdict",
        idempotencyKey: "read-verdict-key",
        relativePath: "build/out/private-name.md",
      },
      undefined,
      { check: (): true => true, binding },
    );
    expect(events).toHaveLength(1);
    return { event: events[0], result };
  }

  it.each(WORKSPACE_PATH_ABSENCE_VERDICTS)(
    "writes the %s verdict of a refined denial on the failed read line, through the registered formatter",
    async (absence) => {
      const reason = absence === "absent" ? "not-found" : "denied";

      const { event, result } = await failedReadLine({ ok: false, reason, absence });

      expect(event).toMatchObject({
        op: "coding-runtime.workspace-read",
        correlationId: "run-read-verdict",
        level: "warn",
        extra: { state: "failed", purpose: "tool-result", reason, absence },
      });
      const persisted = expectActivityLogProof(
        "coding-runtime.workspace-read.emitted-line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(persisted).toMatchObject({ state: "failed", reason, absence });
      // The verdict is evidence for the operator, never for the model: it sees the refusal alone.
      expect(result).toEqual({
        status: "failed",
        reasonCode: reason === "denied" ? "workspace-read-denied" : "workspace-read-not-found",
      });
      expect(JSON.stringify(event)).not.toContain("private-name");
    },
  );

  it("writes no verdict for a failure the walk never ran for", async () => {
    const { event } = await failedReadLine({ ok: false, reason: "process-failed" });

    expect(event?.extra?.reason).toBe("process-failed");
    expect(event?.extra).not.toHaveProperty("absence");
  });
});

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
  it("denies an edit with a closed reason and a correlated refusal line when managed-root authority is revoked before the effect", async () => {
    const root = "/managed/workspace";
    const action = vi.fn();
    const records: ServerDiagnosticRecord[] = [];
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action },
      activityLog: { write: (event): void => void events.push(event) },
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
    // #3610: relocated from the failure diagnostic to the refusal line that now owns it — the same
    // closed reason under the run's own correlation, and no server failure for a governed refusal.
    expect(editRefusedLines(events)).toEqual([
      expect.objectContaining({
        correlationId: "run-revoked",
        errorKind: "authority-denied",
        extra: expect.objectContaining({ reasonCode: "WORKSPACE_ACCESS_LOST" }) as unknown,
      }),
    ]);
    expect(records).toEqual([]);
  });

  // The prepare stage refuses before any editor action exists, so its correlation has to come from
  // the run's own editor context; before this it left no line at all.
  it("emits a correlated prepare refusal when the changeset never reaches the editor route", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const events: ServerLogEvent[] = [];
    const action = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action },
      activityLog: { write: (event): void => void events.push(event) },
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
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "changeset-invalid",
    });
    expect(action).not.toHaveBeenCalled();
    expect(editRefusedLines(events)).toEqual([
      expect.objectContaining({
        correlationId: "run-prepare-1",
        errorKind: "validation-failed",
        extra: expect.objectContaining({
          reasonCode: "EDIT_PREPARE_FAILED",
          prepareCause: "changeset-invalid",
        }) as unknown,
      }),
    ]);
    expect(records).toEqual([]);
  });

  // #3611 review: EDIT_PREPARE_FAILED covers several causes, and not every one is a validation
  // failure. The model still reads the one reason code; the refusal line names the cause and its
  // error kind so the log tells a denied guard from a missing editor context.
  it.each([
    ["guard-denied", "authority-denied", { guardAllows: false }],
    ["editor-context-unavailable", "unavailable", { contextResolves: false }],
    ["workspace-access-lost", "authority-denied", { workspaceAccess: false }],
    ["cancelled", "cancelled", { aborted: true }],
    ["binding-unavailable", "authority-denied", { enforceBinding: true }],
  ] as const)(
    "names the prepare cause %s as %s on the refusal line",
    async (prepareCause, errorKind, setup) => {
      const scenario: {
        readonly guardAllows?: boolean;
        readonly contextResolves?: boolean;
        readonly workspaceAccess?: boolean;
        readonly aborted?: boolean;
        readonly enforceBinding?: boolean;
      } = setup;
      const events: ServerLogEvent[] = [];
      const action = vi.fn();
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action },
        activityLog: { write: (event): void => void events.push(event) },
        // An unavailable editor context surfaces as a throwing resolver.
        resolveEditorActionContext: () => {
          if (scenario.contextResolves === false) throw new Error("no editor context");
          return {
            sessionId: "session-cause",
            authorityRef: { runId: "run-cause", envelopeDigest: DIGEST },
            origin: "agent" as const,
          };
        },
        ...(scenario.workspaceAccess === false
          ? { resolveWorkspaceRootAccess: (): undefined => undefined }
          : {}),
        ...(scenario.enforceBinding === true ? { enforceProducerBinding: true } : {}),
      });

      await expect(
        ports.editorChangeset.execute(
          {
            action: "edit",
            actionId: "edit-cause",
            idempotencyKey: "edit-cause-key",
            changeset: changeset(),
          },
          scenario.aborted === true ? AbortSignal.abort() : undefined,
          { check: (): boolean => scenario.guardAllows !== false },
        ),
        // The cause rides out beside the code, so the run's refusal bound can classify it.
      ).resolves.toEqual({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED", prepareCause });
      expect(action).not.toHaveBeenCalled();
      expect(editRefusedLines(events)).toEqual([
        expect.objectContaining({
          errorKind,
          extra: expect.objectContaining({
            reasonCode: "EDIT_PREPARE_FAILED",
            prepareCause,
          }) as unknown,
        }),
      ]);
    },
  );

  it("counts returned discovery paths independently of lines inside a filename", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-coding-discover-count-"));
    try {
      writeFileSync(join(root, "one\nfilename.ts"), "export {};\n");
      writeFileSync(join(root, "second.ts"), "export {};\n");
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action: vi.fn() },
        resolveEditorActionContext: () => ({
          sessionId: "session-discover-count",
          authorityRef: { runId: "run-discover-count", envelopeDigest: DIGEST },
          origin: "agent",
        }),
        resolveWorkspaceRoot: () => root,
      });
      const result = await ports.repositoryDiscover.execute(
        {
          action: "discover",
          actionId: "discover-count",
          idempotencyKey: "discover-count-key",
          query: "*",
          maxResults: 10,
        },
        undefined,
        { check: (): true => true },
      );
      expect(result).toMatchObject({
        status: "completed",
        read: { returnedPathCount: 2, totalLines: 3 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText },
      editorAgentClient: { action: editorAction },
      activityLog: { write: (event): void => void events.push(event) },
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
    expect(events).toEqual([
      expect.objectContaining({
        op: "coding-runtime.workspace-read",
        extra: {
          completeness: "complete",
          loss: "none",
          state: "completed",
          purpose: "tool-result",
          targetPathSha256: createHash("sha256").update("src/a.ts").digest("hex"),
          startLine: 1,
          maxLines: 0,
        },
      }),
    ]);
    expect(result).toEqual({
      status: "completed",
      read: {
        text: "const value = 1;\n",
        byteCount: Buffer.byteLength("const value = 1;\n", "utf8"),
        digest: "8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d",
        totalLines: 1,
      },
    });
    const persisted = expectActivityLogProof(
      "coding-runtime.workspace-read.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      state: "completed",
      targetPathSha256: createHash("sha256").update("src/a.ts").digest("hex"),
      startLine: 1,
      maxLines: 0,
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

  it("reads a small window from a large file and retains its whole-file precondition", async () => {
    const text = "Repository convention.\n".repeat(4_000);
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: true, text }) },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    });
    const result = await ports.repositoryRead.execute(
      {
        action: "read",
        actionId: "read-large",
        idempotencyKey: "read-large",
        relativePath: "AGENTS.md",
        startLine: 3_001,
        maxLines: 2,
      },
      undefined,
      { check: (): true => true },
    );
    expect(result).toEqual({
      status: "completed",
      read: {
        text: "Repository convention.\n".repeat(2),
        byteCount: 46,
        digest: secureWorkspaceTextDigest(text),
        totalLines: 4_000,
        nextStartLine: 3_003,
      },
    });
    const event = events.find((candidate) => candidate.op === "coding-runtime.workspace-read");
    expect(event?.extra).toMatchObject({ state: "completed", startLine: 3_001, maxLines: 2 });
  });

  it("refuses an oversized model window without returning source text", async () => {
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: {
        readText: () =>
          Promise.resolve({ ok: true, text: "Repository convention.\n".repeat(4_000) }),
      },
      editorAgentClient: { action: vi.fn() },
      resolveEditorActionContext: vi.fn(),
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    });
    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-large",
          idempotencyKey: "read-large",
          relativePath: "AGENTS.md",
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "workspace-read-too-large" });
    const event = events.find((candidate) => candidate.op === "coding-runtime.workspace-read");
    expect(event?.extra).toMatchObject({ state: "failed", reason: "too-large" });
    expect(events.some((candidate) => candidate.extra?.state === "completed")).toBe(false);
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

  it.each([
    ["preflight", "preflight-refused"],
    ["secure-refusal", "process-failed"],
    ["postflight", "postflight-refused"],
    ["oversize", "response-too-large"],
    ["exception", "exception"],
  ] as const)(
    "records a correlated body-free workspace-read failure for the %s boundary",
    async (kind, reason) => {
      const observed = await observedWorkspaceReadFailure(kind);

      expect(observed.result).toEqual({ status: "failed" });
      expect(observed.events).toEqual([
        expect.objectContaining({
          op: "coding-runtime.workspace-read",
          correlationId: "run-read-failure",
          level: "warn",
          extra: expect.objectContaining({
            state: "failed",
            reason,
            targetPathSha256: createHash("sha256").update("src/private-name.ts").digest("hex"),
          }) as unknown,
        }),
      ]);
      expect(JSON.stringify(observed)).not.toContain("src/private-name.ts");
      expect(JSON.stringify(observed)).not.toContain(SENTINEL);
      if (kind === "exception") {
        expect(observed.events[0]?.extra?.frames).toEqual(expect.any(Array));
        expect(observed.events[0]?.extra?.causeChain).toEqual(expect.any(Array));
        expect(observed.diagnostics).toEqual([
          expect.objectContaining({
            operation: "coding-runtime.workspace-read",
            correlationId: "run-read-failure",
            errorClass: "Error",
            message: "workspace-read-failed",
          }),
        ]);
      } else {
        expect(observed.diagnostics).toEqual([]);
      }
    },
  );

  it("fails closed when a compromised read port returns more than 65,536 bytes", async () => {
    const editorAction = vi.fn();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: {
        readText: () =>
          Promise.resolve({ ok: true, text: "x".repeat(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES + 1) }),
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
  it("emits a body-free refusal line when the editor route rejects the changeset", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const events: ServerLogEvent[] = [];
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
      activityLog: { write: (event): void => void events.push(event) },
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
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "OUT_OF_SCOPE",
      // #3390: the route's own sentence rides to the caller so the model can repair the patch; it
      // still never reaches the activity log (asserted below).
      message: "The target escapes the root.",
    });
    const persisted = expectActivityLogProof(
      "coding-runtime.edit.refused.emitted-line",
      formatActivityLogProofLine(editRefusedLines(events)[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      level: "warn",
      correlationId: "run-2332",
      errorKind: "authority-denied",
      reasonCode: "OUT_OF_SCOPE",
    });
    expect(records).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("escapes the root");
  });

  // #3610: the refusal vocabulary is written out as literals for the op catalog; a contract code
  // missing from it would be recorded as EDIT_CLIENT_ERROR, so every one of them must be listed.
  it("lists every editor-agent conflict and failure code as a refusal reason", async () => {
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: { action: vi.fn() },
      activityLog: { write: (event): void => void events.push(event) },
      resolveEditorActionContext: () => ({
        sessionId: "session-vocabulary",
        authorityRef: { runId: "run-vocabulary", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });
    await ports.editorChangeset.execute(
      {
        action: "edit",
        actionId: "edit-vocabulary",
        idempotencyKey: "edit-vocabulary-key",
        changeset: { patch: "x", files: [] },
      },
      undefined,
      { check: (): true => true },
    );
    const refusal = editRefusedLines(events)[0];
    const field =
      refusal === undefined ? undefined : activityLogEventRegistration(refusal)?.fields.reasonCode;
    const listed = field?.type === "string" ? (field.values ?? []) : [];
    expect(listed.length).toBeGreaterThan(0);
    for (const code of [...EDITOR_AGENT_CONFLICT_CODES, ...EDITOR_AGENT_FAILURE_CODES]) {
      expect(listed).toContain(code);
    }
  });

  // #3610 (W21): a changeset built on a stale read is refused with CONTENT_HASH_MISMATCH — an
  // expected conflict the model repairs by re-reading. It was written as server.diagnostic.failure
  // at level error with errorKind internal, which also opened a support incident for every such
  // edit. It is a warn-level conflict now, and no failure diagnostic is written.
  it("records a stale-base refusal as a conflict, never as a server failure", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const events: ServerLogEvent[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: vi.fn() },
      editorAgentClient: {
        action: vi.fn(() =>
          Promise.resolve({
            ok: true as const,
            value: {
              result: {
                schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                actionId: "edit-stale-1",
                sessionId: "session-stale",
                status: "conflict" as const,
                conflict: {
                  code: "CONTENT_HASH_MISMATCH" as const,
                  message: "The changeset file content hash no longer matches.",
                },
              },
            },
          }),
        ),
      },
      diagnostics: { record: (record): void => void records.push(record) },
      activityLog: { write: (event): void => void events.push(event) },
      resolveEditorActionContext: () => ({
        sessionId: "session-stale",
        authorityRef: { runId: "run-stale", envelopeDigest: DIGEST },
        origin: "agent",
      }),
    });

    await expect(
      ports.editorChangeset.execute(
        {
          action: "edit",
          actionId: "edit-stale-1",
          idempotencyKey: "edit-stale-key",
          changeset: changeset(),
        },
        undefined,
        { check: (): true => true },
      ),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "CONTENT_HASH_MISMATCH" });
    expect(editRefusedLines(events)).toEqual([
      expect.objectContaining({
        level: "warn",
        correlationId: "run-stale",
        errorKind: "conflict",
        extra: {
          reasonCode: "CONTENT_HASH_MISMATCH",
          completeness: "complete",
          loss: "none",
          editForm: "unified-diff",
          executionPath: "browser",
        },
      }),
    ]);
    expect(records).toEqual([]);
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
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "changeset-invalid",
    });
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
      const events: ServerLogEvent[] = [];
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
        activityLog: { write: (event): void => void events.push(event) },
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
      const persisted = expectActivityLogProof(
        "coding-runtime.editor-mutation.settled.emitted-line",
        formatActivityLogProofLine(events[0] ?? {}),
      );
      expect(persisted).toMatchObject({ state: "succeeded", actionKind: "edit" });
    },
  );

  // Owner decision 2026-09-26 (ADR-0124 D6): the change review is the only approval an edit asks
  // for. Its "no" read as an internal mutation failure (EDIT_MUTATION_FAILED, errorKind internal),
  // and the model was told its edit had failed. The rejection is the human's decision now.
  it("reports a change rejected in its review as the human's decision", async () => {
    const liveBinding = { ...admittedBinding, expiresAt: "2099-01-01T00:00:00.000Z" };
    const events: ServerLogEvent[] = [];
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
        authorityRef: { runId: liveBinding.runId, envelopeDigest: liveBinding.envelopeDigest },
        origin: "agent",
        workspaceId: liveBinding.workspaceId,
        workspaceRootDigest: liveBinding.workspaceRootDigest,
        expiresAt: liveBinding.expiresAt,
      }),
      requiresEditorReview: () => true,
      mutationLeaseCoordinator: {
        register: vi.fn((): boolean => true),
        discard: vi.fn((): boolean => true),
        waitForMutation: () => Promise.resolve("rejected"),
      },
      activityLog: { write: (event): void => void events.push(event) },
    });

    await expect(
      ports.editorChangeset.execute(
        { action: "edit", actionId: "edit-1", idempotencyKey: "edit-key", changeset: changeset() },
        undefined,
        { check: (): true => true, binding: liveBinding },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "CHANGE_REJECTED" });
    expect(events.map((event) => event.op)).toEqual([
      "coding-runtime.editor-mutation.settled",
      "coding-runtime.edit.refused",
    ]);
    const [settled, refused] = events;
    expect(settled).not.toHaveProperty("errorKind");
    expect(settled?.level).not.toBe("warn");
    expect(
      expectActivityLogProof(
        "coding-runtime.editor-mutation.settled.emitted-line",
        formatActivityLogProofLine(settled ?? {}),
      ),
    ).toMatchObject({ state: "rejected", actionKind: "edit" });
    expect(refused).toMatchObject({
      level: "warn",
      errorKind: "authority-denied",
      extra: { reasonCode: "CHANGE_REJECTED" },
    });
  });

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
  it("names the actual condition in the refused edit's outcome while the refusal line stays reason-code-only", async () => {
    vi.useFakeTimers();
    try {
      const records: ServerDiagnosticRecord[] = [];
      const events: ServerLogEvent[] = [];
      const listSessions = vi.fn(() =>
        Promise.resolve({ ok: true as const, value: { sessions: [] } }),
      );
      const ports = createCodingToolReadEditPorts({
        secureWorkspaceTextRead: { readText: vi.fn() },
        editorAgentClient: { action: vi.fn(), listSessions },
        activityLog: { write: (event): void => void events.push(event) },
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
      expect(editRefusedLines(events)).toEqual([
        expect.objectContaining({
          correlationId: "run-message-1",
          errorKind: "unavailable",
          extra: {
            reasonCode: "NO_ACTIVE_SESSION",
            completeness: "complete",
            loss: "none",
            editForm: "unified-diff",
            executionPath: "browser",
          },
        }),
      ]);
      expect(records).toEqual([]);
      expect(JSON.stringify(events)).not.toContain(NO_ACTIVE_SESSION_MESSAGE);
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
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "guard-denied",
    });
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
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "editor-context-unavailable",
    });
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
        ).resolves.toEqual({
          status: "failed",
          reasonCode: "EDIT_PREPARE_FAILED",
          prepareCause: "binding-unavailable",
        });
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

// #3873 follow-up: a replacement changeset that moves or deletes files records body-free deletion
// and rename counts beside the edit form, on the settled line and on a refusal line, through the
// real registered formatter. A unified-diff changeset records neither count: not measured, not zero.
describe("CodingTool edit evidence for deletions and renames (#3873 follow-up)", () => {
  const liveBinding = { ...admittedBinding, expiresAt: "2099-01-01T00:00:00.000Z" };
  const TEXT = "a\n";
  const TEXT_DIGEST = createHash("sha256").update(TEXT, "utf8").digest("hex");
  const EMPTY_DIGEST = createHash("sha256").update("", "utf8").digest("hex");

  function readText(request: {
    readonly relativePath: string;
  }): Promise<SecureWorkspaceTextReadResult> {
    return Promise.resolve(
      request.relativePath === "src/a.ts" || request.relativePath === "src/d.ts"
        ? { ok: true, text: TEXT }
        : { ok: false, reason: "not-found" },
    );
  }

  function movingChangeset(deletions: readonly string[]): EditorChangesetInput {
    return {
      edits: [],
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      deletions,
      files: [
        { file: "src/a.ts", expectedContentHash: TEXT_DIGEST },
        { file: "src/b.ts", expectedContentHash: EMPTY_DIGEST },
        { file: "src/d.ts", expectedContentHash: TEXT_DIGEST },
      ],
      selectedFiles: ["src/a.ts", "src/b.ts", "src/d.ts"],
    };
  }

  type EditorChangesetInput = Parameters<
    ReturnType<typeof createCodingToolReadEditPorts>["editorChangeset"]["execute"]
  >[0]["changeset"];

  function portsWith(
    events: ServerLogEvent[],
    read: SecureWorkspaceTextReadPort["readText"] = readText,
  ): ReturnType<typeof createCodingToolReadEditPorts> {
    return createCodingToolReadEditPorts({
      secureWorkspaceTextRead: { readText: read },
      // The materialization reads are governed reads: they need the run's read context like the
      // model's own reads do (#3873 review).
      resolveRepositoryReadContext: () => liveBinding,
      editorAgentClient: {
        action: () =>
          Promise.resolve({
            ok: true as const,
            value: {
              result: {
                schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                actionId: "edit-move",
                sessionId: "session-2332",
                status: "queued" as const,
              },
            },
          }),
      },
      resolveEditorActionContext: () => ({
        sessionId: "session-2332",
        authorityRef: { runId: liveBinding.runId, envelopeDigest: liveBinding.envelopeDigest },
        origin: "agent",
        workspaceId: liveBinding.workspaceId,
        workspaceRootDigest: liveBinding.workspaceRootDigest,
        expiresAt: liveBinding.expiresAt,
      }),
      requiresEditorReview: () => true,
      mutationLeaseCoordinator: {
        register: vi.fn((): boolean => true),
        discard: vi.fn((): boolean => true),
        waitForMutation: () => Promise.resolve("succeeded"),
      },
      activityLog: { write: (event): void => void events.push(event) },
    });
  }

  async function settledEdit(
    changeset: EditorChangesetInput,
    options: {
      readonly read?: SecureWorkspaceTextReadPort["readText"];
      readonly guard?: Partial<CodingToolMutationGuard>;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<{ readonly events: readonly ServerLogEvent[]; readonly result: unknown }> {
    const events: ServerLogEvent[] = [];
    const result = await portsWith(events, options.read).editorChangeset.execute(
      { action: "edit", actionId: "edit-move", idempotencyKey: "edit-move-key", changeset },
      options.signal,
      { check: (): true => true, binding: liveBinding, ...options.guard },
    );
    return { events, result };
  }

  function settledLine(events: readonly ServerLogEvent[]): ServerLogEvent | undefined {
    return events.find((event) => event.op === "coding-runtime.editor-mutation.settled");
  }

  it("records the deletion and rename counts of a settled replacement edit, behind its governed reads", async () => {
    const { events, result } = await settledEdit(movingChangeset(["src/d.ts"]));

    expect(result).toEqual({ status: "completed" });
    expect(events.map((event) => event.op)).toEqual([
      "coding-runtime.workspace-read",
      "coding-runtime.workspace-read",
      "coding-runtime.workspace-read",
      "coding-runtime.editor-mutation.settled",
    ]);
    // The rename source, the rename target (absent, as a new path must be) and the deleted file:
    // each read is on the timeline with its purpose and the path's digest, never the path.
    expect(events.slice(0, 3).map((event) => event.extra)).toMatchObject([
      { state: "completed", purpose: "edit-materialization" },
      { state: "absent", purpose: "edit-materialization" },
      { state: "completed", purpose: "edit-materialization" },
    ]);
    for (const event of events.slice(0, 3)) {
      expect(event.correlationId).toBe(liveBinding.runId);
      expect(JSON.stringify(event)).not.toContain("src/");
    }
    const persisted = expectActivityLogProof(
      "coding-runtime.editor-mutation.settled.emitted-line",
      formatActivityLogProofLine(events[3] ?? {}),
    );
    expect(persisted).toMatchObject({
      state: "succeeded",
      actionKind: "edit",
      editForm: "replacements",
      deletionCount: 1,
      renameCount: 1,
    });
  });

  it("records the counts and the refusal class on a refusal the materializer raised before any read", async () => {
    const { events, result } = await settledEdit(movingChangeset(["src/b.ts"]));

    expect(result).toEqual({
      status: "failed",
      reasonCode: "INVALID_EDITS",
      message: "src/b.ts is named more than once in this call.",
    });
    expect(events.map((event) => event.op)).toEqual(["coding-runtime.edit.refused"]);
    const persisted = expectActivityLogProof(
      "coding-runtime.edit.refused.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      reasonCode: "INVALID_EDITS",
      replacementRefusal: "path-conflict",
      editForm: "replacements",
      deletionCount: 1,
      renameCount: 1,
    });
    expect(events[0]).toMatchObject({ level: "warn", errorKind: "validation-failed" });
  });

  it.each([
    ["old-string-not-found", { file: "src/a.ts", oldString: "z", newString: "b" }],
    ["old-string-ambiguous", { file: "src/d.ts", oldString: "a", newString: "b" }],
    ["create-over-content", { file: "src/a.ts", oldString: "", newString: "b" }],
    ["identical-strings", { file: "src/a.ts", oldString: "a", newString: "a" }],
  ] as const)("records %s as the closed class of a refused replacement", async (refusal, edit) => {
    const read: SecureWorkspaceTextReadPort["readText"] = ({ relativePath }) =>
      Promise.resolve({ ok: true, text: relativePath === "src/d.ts" ? "a\na\n" : TEXT });
    const { events, result } = await settledEdit(
      {
        edits: [edit],
        files: [
          { file: "src/a.ts", expectedContentHash: TEXT_DIGEST },
          {
            file: "src/d.ts",
            expectedContentHash: createHash("sha256").update("a\na\n", "utf8").digest("hex"),
          },
        ],
      },
      { read },
    );

    expect(result).toMatchObject({ status: "failed", reasonCode: "INVALID_EDITS" });
    const refused = events.find((event) => event.op === "coding-runtime.edit.refused");
    expect(refused?.extra).toMatchObject({
      reasonCode: "INVALID_EDITS",
      replacementRefusal: refusal,
    });
    expect(JSON.stringify(refused)).not.toContain("src/");
  });

  // #3873 review: every non-`not-found` read failure collapsed into one `replacement-read-failed`
  // with errorKind unavailable; a cancelled run's edit was logged as unavailable. The closed read
  // reason rides the refusal, and the failed read itself is on the timeline with its purpose.
  it("carries the governed read's closed reason into the refusal and logs the failed read", async () => {
    const busy: SecureWorkspaceTextReadPort["readText"] = () =>
      Promise.resolve({ ok: false, reason: "busy" });
    const { events, result } = await settledEdit(movingChangeset(["src/d.ts"]), { read: busy });

    expect(result).toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "replacement-read-failed",
      readReason: "busy",
      affectedRelativePath: "src/a.ts",
    });
    expect(events.map((event) => event.op)).toEqual([
      "coding-runtime.workspace-read",
      "coding-runtime.edit.refused",
    ]);
    expect(events[0]).toMatchObject({
      level: "warn",
      extra: { state: "failed", purpose: "edit-materialization", reason: "busy" },
    });
    const persisted = expectActivityLogProof(
      "coding-runtime.edit.refused.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(persisted).toMatchObject({
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "replacement-read-failed",
      readReason: "busy",
      editForm: "replacements",
    });
    expect(events[1]).toMatchObject({ errorKind: "unavailable" });
    expect(JSON.stringify(events)).not.toContain("src/a.ts");
  });

  it("records a cancelled materialization read as cancelled, not as unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, result } = await settledEdit(movingChangeset(["src/d.ts"]), {
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "cancelled",
      readReason: "cancelled",
      affectedRelativePath: "src/a.ts",
    });
    expect(events[0]).toMatchObject({
      op: "coding-runtime.workspace-read",
      errorKind: "cancelled",
      extra: { state: "failed", purpose: "edit-materialization", reason: "cancelled" },
    });
    const refused = events.find((event) => event.op === "coding-runtime.edit.refused");
    expect(refused).toMatchObject({
      errorKind: "cancelled",
      extra: { prepareCause: "cancelled", readReason: "cancelled" },
    });
  });

  it("refuses a materialization read of a denied path at the governed preflight", async () => {
    const readText = vi.fn();
    const { events, result } = await settledEdit(
      {
        edits: [{ file: ".git/config", oldString: "a", newString: "b" }],
        files: [{ file: ".git/config", expectedContentHash: TEXT_DIGEST }],
      },
      { read: readText },
    );

    expect(result).toEqual({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "replacement-read-failed",
      readReason: "preflight-refused",
    });
    expect(readText).not.toHaveBeenCalled();
    expect(events.map((event) => event.op)).toEqual([
      "coding-runtime.workspace-read",
      "coding-runtime.edit.refused",
    ]);
    expect(events[0]?.extra).toMatchObject({ state: "failed", reason: "preflight-refused" });
  });

  // #3873 review: the digest a replacement edit is checked against is the one the governed read
  // reports. The precondition is taken from a real `keiko_workspace_read` result here, not from a
  // restated formula, so a change to the read's digest cannot leave these edits green over a
  // product that refuses every one of them.
  it("accepts an edit bound to the digest a governed read of the same file reported", async () => {
    const events: ServerLogEvent[] = [];
    const ports = portsWith(events);
    const guard = { check: (): true => true, binding: liveBinding };

    const read = await ports.repositoryRead.execute(
      {
        action: "read",
        actionId: "read-a",
        idempotencyKey: "read-a-key",
        relativePath: "src/a.ts",
      },
      undefined,
      guard,
    );
    if (read.status !== "completed" || read.read === undefined)
      throw new Error(`expected a completed read, got ${read.status}`);
    const result = await ports.editorChangeset.execute(
      {
        action: "edit",
        actionId: "edit-a",
        idempotencyKey: "edit-a-key",
        changeset: {
          edits: [{ file: "src/a.ts", oldString: "a", newString: "b" }],
          files: [{ file: "src/a.ts", expectedContentHash: read.read.digest }],
        },
      },
      undefined,
      guard,
    );

    expect(result).toEqual({ status: "completed" });
    expect(events.map((event) => event.op)).toEqual([
      "coding-runtime.workspace-read",
      "coding-runtime.workspace-read",
      "coding-runtime.editor-mutation.settled",
    ]);
    expect(events[0]?.extra).toMatchObject({ purpose: "tool-result", state: "completed" });
    expect(events[1]?.extra).toMatchObject({ purpose: "edit-materialization", state: "completed" });
  });

  // #3873 review: the materialized diff is charged against the run's patch budget through the
  // guard, by its excess over the request payload admission already reserved; a refused charge
  // refuses the edit before the editor sees it.
  it("charges the materialized diff's excess over the payload through the guard, and refuses when it does not fit", async () => {
    const accepted = vi.fn<(patchBytes: number) => MaterializedPatchCharge>(() => ({ ok: true }));
    const { events, result } = await settledEdit(movingChangeset(["src/d.ts"]), {
      guard: { chargeMaterializedPatch: accepted },
    });
    const refusing = vi.fn<(patchBytes: number) => MaterializedPatchCharge>(() => ({
      ok: false,
      reason: "authority-budget-exceeded",
    }));
    const refused = await settledEdit(movingChangeset(["src/d.ts"]), {
      guard: { chargeMaterializedPatch: refusing },
    });

    expect(result).toEqual({ status: "completed" });
    // The request payload admission reserved: the rename's two paths and the deleted path.
    const payload = Buffer.byteLength("src/a.ts", "utf8") * 2 + Buffer.byteLength("src/d.ts");
    expect(accepted).toHaveBeenCalledOnce();
    const charged = accepted.mock.calls[0]?.[0] ?? 0;
    expect(charged).toBeGreaterThan(0);
    // delete a (2 lines), create b (2 lines), delete d (2 lines): the whole materialized diff.
    expect(charged + payload).toBe(
      Buffer.byteLength(
        "--- a/src/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n" +
          "--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,1 @@\n+a\n" +
          "--- a/src/d.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n",
        "utf8",
      ),
    );
    expect(settledLine(events)?.extra).toMatchObject({ editForm: "replacements" });
    expect(refused.result).toEqual({
      status: "failed",
      reasonCode: "LIMIT_EXCEEDED",
      message:
        "The materialized changeset does not fit the run's remaining patch budget; split it into smaller calls or finish with the changes already applied.",
    });
    expect(refused.events.map((event) => event.op)).not.toContain(
      "coding-runtime.editor-mutation.settled",
    );
    expect(refused.events.at(-1)).toMatchObject({
      op: "coding-runtime.edit.refused",
      errorKind: "validation-failed",
      extra: { reasonCode: "LIMIT_EXCEEDED", replacementRefusal: "patch-budget-exhausted" },
    });
  });

  // #3873 review: the charge also fails for reasons that are not the budget — a run that stopped,
  // an authority that expired, drifted or was replayed. Those are the guard's denial, never an
  // exhausted budget, and the model is not told to split a call that cannot succeed.
  it.each([
    ["authority-resolution-failed", "guard-denied"],
    ["authority-replayed", "guard-denied"],
    ["workspace-drift", "workspace-access-lost"],
  ] as const)(
    "records a charge refused with %s as the guard's %s, never as an exhausted budget",
    async (reason, prepareCause) => {
      const refusing = vi.fn<(patchBytes: number) => MaterializedPatchCharge>(() => ({
        ok: false,
        reason,
      }));
      const refused = await settledEdit(movingChangeset(["src/d.ts"]), {
        guard: { chargeMaterializedPatch: refusing },
      });

      expect(refused.result).toMatchObject({ status: "failed", reasonCode: "EDIT_PREPARE_FAILED" });
      expect(JSON.stringify(refused.result)).not.toContain("split");
      const line = refused.events.at(-1);
      expect(line).toMatchObject({
        op: "coding-runtime.edit.refused",
        extra: { reasonCode: "EDIT_PREPARE_FAILED", prepareCause },
      });
      expect(line?.extra).not.toHaveProperty("replacementRefusal");
    },
  );

  it("records zero counts for a replacement edit that neither moves nor deletes", async () => {
    const { events } = await settledEdit({
      edits: [{ file: "src/a.ts", oldString: "a", newString: "b" }],
      files: [{ file: "src/a.ts", expectedContentHash: TEXT_DIGEST }],
    });

    expect(settledLine(events)?.extra).toMatchObject({
      editForm: "replacements",
      deletionCount: 0,
      renameCount: 0,
    });
  });

  it("records no counts for a unified-diff changeset, where they were not measured", async () => {
    const { events } = await settledEdit(changeset());

    expect(events.map((event) => event.op)).toEqual(["coding-runtime.editor-mutation.settled"]);
    expect(events[0]?.extra).toMatchObject({ editForm: "unified-diff" });
    expect(events[0]?.extra).not.toHaveProperty("deletionCount");
    expect(events[0]?.extra).not.toHaveProperty("renameCount");
  });
});

// PR #3876 review: the editor route lifts keiko-tools' collapsed-diff heuristic only for a diff the
// server rendered itself. This port is the one place that knows it did: it registers the exact patch
// text it posts, once the run's budget is charged, and never the text a caller supplied.
describe("CodingTool materialized patch provenance (#3873)", () => {
  const liveBinding = { ...admittedBinding, expiresAt: "2099-01-01T00:00:00.000Z" };
  const SOURCE =
    'export const header = "Name  Amount\\n----  ------\\n";\nexport const total = 1;\n';
  const SOURCE_DIGEST = createHash("sha256").update(SOURCE, "utf8").digest("hex");

  interface Fixture {
    readonly posted: EditorAgentAction[];
    readonly registry: ReturnType<typeof createMaterializedPatchRegistry>;
    readonly run: (
      changeset: Parameters<
        ReturnType<typeof createCodingToolReadEditPorts>["editorChangeset"]["execute"]
      >[0]["changeset"],
      guard?: Partial<CodingToolMutationGuard>,
    ) => Promise<unknown>;
  }

  function fixture(): Fixture {
    const posted: EditorAgentAction[] = [];
    const registry = createMaterializedPatchRegistry();
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: {
        readText: ({ relativePath }) =>
          Promise.resolve(
            relativePath === "src/table.ts"
              ? { ok: true, text: SOURCE }
              : { ok: false, reason: "not-found" },
          ),
      },
      resolveRepositoryReadContext: () => liveBinding,
      editorAgentClient: {
        action: (action) => {
          posted.push(action);
          return Promise.resolve({
            ok: true as const,
            value: {
              result: {
                schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                actionId: action.actionId,
                sessionId: action.sessionId,
                status: "queued" as const,
              },
            },
          });
        },
      },
      resolveEditorActionContext: () => ({
        sessionId: "session-provenance",
        authorityRef: { runId: liveBinding.runId, envelopeDigest: liveBinding.envelopeDigest },
        origin: "agent",
        workspaceId: liveBinding.workspaceId,
        workspaceRootDigest: liveBinding.workspaceRootDigest,
        expiresAt: liveBinding.expiresAt,
      }),
      requiresEditorReview: () => true,
      mutationLeaseCoordinator: {
        register: vi.fn((): boolean => true),
        discard: vi.fn((): boolean => true),
        waitForMutation: () => Promise.resolve("succeeded"),
      },
      materializedPatches: registry,
      activityLog: { write: vi.fn() },
    });
    return {
      posted,
      registry,
      run: (changesetInput, guard = {}) =>
        ports.editorChangeset.execute(
          {
            action: "edit",
            actionId: "edit-provenance",
            idempotencyKey: "edit-provenance-key",
            changeset: changesetInput,
          },
          undefined,
          { check: (): true => true, binding: liveBinding, ...guard },
        ),
    };
  }

  const replacement = {
    edits: [{ file: "src/table.ts", oldString: "total = 1;", newString: "total = 2;" }],
    files: [{ file: "src/table.ts", expectedContentHash: SOURCE_DIGEST }],
  };

  it("registers the exact patch it posts to the editor route, only after the budget is charged", async () => {
    const { posted, registry, run } = fixture();
    const registeredAtCharge: number[] = [];
    const charge = vi.fn((): MaterializedPatchCharge => {
      registeredAtCharge.push(registry.stats().entries);
      return { ok: true };
    });

    const result = await run(replacement, { chargeMaterializedPatch: charge });

    expect(result).toEqual({ status: "completed" });
    expect(charge).toHaveBeenCalledOnce();
    // A refused charge must leave nothing behind, so the digest is not there while the charge runs.
    expect(registeredAtCharge).toEqual([0]);
    const patch = posted[0]?.changeset?.patch;
    if (patch === undefined) throw new Error("expected the edit to reach the editor route");
    expect(patch).toContain(String.raw`Amount\n----`);
    expect(registry.lookup(patch).registered).toBe(true);
    expect(registry.stats().entries).toBe(1);
  });

  it("registers nothing when the run's budget does not take the diff", async () => {
    const { posted, registry, run } = fixture();
    const refusing = vi.fn((): MaterializedPatchCharge => ({
      ok: false,
      reason: "authority-budget-exceeded",
    }));

    const result = await run(replacement, { chargeMaterializedPatch: refusing });

    expect(result).toMatchObject({ status: "failed", reasonCode: "LIMIT_EXCEEDED" });
    expect(posted).toEqual([]);
    expect(registry.stats().entries).toBe(0);
  });

  it("registers nothing for a replacement the materializer refuses", async () => {
    const { posted, registry, run } = fixture();

    const result = await run({
      edits: [{ file: "src/table.ts", oldString: "missing text", newString: "x" }],
      files: [{ file: "src/table.ts", expectedContentHash: SOURCE_DIGEST }],
    });

    expect(result).toMatchObject({ status: "failed", reasonCode: "INVALID_EDITS" });
    expect(posted).toEqual([]);
    expect(registry.stats().entries).toBe(0);
  });

  // The provenance is the server's own rendering. A diff a caller wrote is model text to the engine,
  // whatever it spells, and must keep meeting the guard that exists for it.
  it("never registers a diff a caller supplied", async () => {
    const { posted, registry, run } = fixture();
    const supplied = {
      patch:
        '--- a/src/table.ts\n+++ b/src/table.ts\n@@ -1,2 +1,2 @@\n export const header = "Name  Amount\\n----  ------\\n";\n-export const total = 1;\n+export const total = 2;\n',
      files: [{ file: "src/table.ts", expectedContentHash: SOURCE_DIGEST }],
    };

    const result = await run(supplied);

    expect(result).toEqual({ status: "completed" });
    expect(posted[0]?.changeset?.patch).toBe(supplied.patch);
    expect(registry.lookup(supplied.patch).registered).toBe(false);
    expect(registry.stats().entries).toBe(0);
  });
});
