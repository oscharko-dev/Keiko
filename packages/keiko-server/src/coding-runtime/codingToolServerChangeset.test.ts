import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EditorAgentSessionSnapshot, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import type { WorkspaceRootAccessOutcome } from "../task-workspace/workspace-root-access.js";
import {
  grantedWorkspaceRootAccess,
  resolveLifecycleManagedWorkspaceRootAccess,
} from "../task-workspace/workspace-root-access.js";
import { deriveManagedWorktreePath } from "../task-workspace/naming.js";
import { inspectManagedGitdirIdentity } from "../task-workspace/gitdir-identity.js";
import { assertManagedRootOwned } from "../task-workspace/managed-root.js";
import { editorAgentWorkspaceRootDigest } from "../editor/agentAuthorityRegistry.js";
import { editorAgentRegistry } from "../editor/agentSessionRegistry.js";
import * as editorRoutes from "../editor/agentRoutes.js";
import { createCodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import {
  createCodingToolReadEditPorts,
  type CodingToolReadEditPortDeps,
  type CodingToolReadEditPorts,
} from "./codingToolReadEditPorts.js";
import { secureWorkspaceTextDigest } from "./secureWorkspaceTextRead.js";
import type {
  RuntimeChangesetApplyInput,
  RuntimeChangesetApplyPort,
} from "../editor/agentRoutes.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createContainedNodeWorkspaceWriter } from "@oscharko-dev/keiko-tools/internal/writer";
import { createInMemoryUiStore } from "../store/index.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";

const RUN_ID = "run-server-changeset";
const ENVELOPE_DIGEST = "a".repeat(64);
const roots: string[] = [];
const disposers: (() => void)[] = [];

function git(root: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", root, ...args], { stdio: "ignore" });
}

function managedInstance(root: string, repositoryRoot: string): WorkspaceInstance {
  const identity = inspectManagedGitdirIdentity(root, repositoryRoot)?.identity;
  if (identity === undefined) throw new Error("Managed fixture identity is missing");
  return {
    schemaVersion: "1",
    workspaceId: "ws_0123456789abcdef01234567",
    taskId: "server-changeset",
    repositoryId: "repo_0123456789abcdef",
    repositoryRoot,
    baseBranch: "dev",
    taskBranch: "keiko/task/server-changeset",
    managedWorktreePath: root,
    gitdirIdentity: identity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: RUN_ID,
  };
}

function managedFixture(): {
  readonly root: string;
  readonly resolveAccess: (root: string) => WorkspaceRootAccessOutcome;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-server-changeset-")));
  roots.push(base);
  const repositoryRoot = join(base, "repository");
  mkdirSync(repositoryRoot);
  git(repositoryRoot, ["init", "-q"]);
  git(repositoryRoot, ["config", "user.email", "test@example.invalid"]);
  git(repositoryRoot, ["config", "user.name", "Keiko Test"]);
  writeFileSync(join(repositoryRoot, "README.md"), "fixture\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["commit", "-qm", "fixture"]);
  const managedRoot = join(base, ".keiko", "task-workspaces");
  assertManagedRootOwned(managedRoot);
  const root = deriveManagedWorktreePath({
    managedRoot,
    repositoryId: "repo_0123456789abcdef",
    workspaceId: "ws_0123456789abcdef01234567",
  });
  mkdirSync(join(managedRoot, "repo_0123456789abcdef"), { recursive: true });
  git(repositoryRoot, ["worktree", "add", "-q", "-b", "keiko/task/server-changeset", root, "HEAD"]);
  const instance = managedInstance(root, repositoryRoot);
  writeFileSync(join(root, "component.tsx"), "before\n");
  return {
    root,
    resolveAccess: (requestedRoot): WorkspaceRootAccessOutcome => {
      const access = resolveLifecycleManagedWorkspaceRootAccess(
        { managedRoot, store: { getById: (): WorkspaceInstance => instance } },
        requestedRoot,
      );
      return access === undefined ? { decision: "denied" } : grantedWorkspaceRootAccess(access);
    },
  };
}

type ProducerBinding = NonNullable<CodingToolMutationGuard["binding"]>;
type SessionList = NonNullable<CodingToolReadEditPortDeps["editorAgentClient"]["listSessions"]>;
interface PortFixture extends ReturnType<typeof managedFixture> {
  readonly events: readonly ServerLogEvent[];
  readonly diagnosticRecords: readonly ServerDiagnosticRecord[];
  readonly binding: ProducerBinding;
  readonly coordinator: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  readonly apply: Mock<RuntimeChangesetApplyPort>;
  readonly listSessions: Mock<SessionList>;
  readonly ports: CodingToolReadEditPorts;
}
interface FixtureOptions {
  readonly review?: "allowed" | "required" | "unknown";
  readonly serviceReview?: "required" | "unknown";
  readonly beforeApply?: () => void;
  readonly rewriteInput?: (input: RuntimeChangesetApplyInput) => RuntimeChangesetApplyInput;
}

function portFixture(options: FixtureOptions = {}): PortFixture {
  const fixture = managedFixture();
  const events: ServerLogEvent[] = [];
  const diagnosticRecords: ServerDiagnosticRecord[] = [];
  const binding = {
    runId: RUN_ID,
    envelopeDigest: ENVELOPE_DIGEST,
    workspaceId: "ws_0123456789abcdef01234567",
    workspaceRootDigest: editorAgentWorkspaceRootDigest(fixture.root),
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const coordinator = createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry: { revokeRun: vi.fn() },
    cancelPendingByAuthorityRun: (runId): number =>
      editorAgentRegistry.cancelPendingByAuthorityRun(runId),
  });
  const store = createInMemoryUiStore();
  disposers.push(coordinator.dispose);
  const apply = vi.fn<RuntimeChangesetApplyPort>((input) => {
    options.beforeApply?.();
    return Promise.resolve(
      editorRoutes.applyRuntimeChangeset(options.rewriteInput?.(input) ?? input, {
        runtimeMutationLease: coordinator.lease,
        workspaceRootAccessResolver: fixture.resolveAccess,
        store,
        ...(options.serviceReview === undefined
          ? {}
          : {
              runtimeMutationLease: {
                ...coordinator.lease,
                requiresReview: (): boolean | undefined =>
                  options.serviceReview === "required" ? true : undefined,
              },
            }),
      }),
    );
  });
  const listSessions = vi.fn<SessionList>(() =>
    Promise.resolve({ ok: true as const, value: { sessions: [] } }),
  );
  const ports = createFixturePorts({
    fixture,
    events,
    diagnosticRecords,
    binding,
    coordinator,
    apply,
    listSessions,
    options,
  });
  return {
    ...fixture,
    events,
    diagnosticRecords,
    binding,
    coordinator,
    apply,
    listSessions,
    ports,
  };
}

function createFixturePorts({
  fixture,
  events,
  diagnosticRecords,
  binding,
  coordinator,
  apply,
  listSessions,
  options,
}: {
  readonly fixture: ReturnType<typeof managedFixture>;
  readonly events: ServerLogEvent[];
  readonly diagnosticRecords: ServerDiagnosticRecord[];
  readonly binding: ProducerBinding;
  readonly coordinator: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  readonly apply: RuntimeChangesetApplyPort;
  readonly listSessions: SessionList;
  readonly options: FixtureOptions;
}): CodingToolReadEditPorts {
  return createCodingToolReadEditPorts({
    diagnostics: {
      record: (record): void => {
        diagnosticRecords.push(record);
      },
    },
    activityLog: { write: (event: ServerLogEvent): void => void events.push(event) },
    secureWorkspaceTextRead: { readText: vi.fn() },
    editorAgentClient: { action: vi.fn(), listSessions },
    resolveEditorActionContext: (): ReturnType<
      CodingToolReadEditPortDeps["resolveEditorActionContext"]
    > => ({
      sessionId: "runtime-server-changeset",
      authorityRef: { runId: RUN_ID, envelopeDigest: ENVELOPE_DIGEST },
      origin: "agent" as const,
      workspaceRoot: fixture.root,
      workspaceId: binding.workspaceId,
      workspaceRootDigest: binding.workspaceRootDigest,
      expiresAt: binding.expiresAt,
    }),
    resolveWorkspaceRoot: (): string => fixture.root,
    resolveWorkspaceRootAccess: (): ReturnType<
      NonNullable<CodingToolReadEditPortDeps["resolveWorkspaceRootAccess"]>
    > => {
      const outcome = fixture.resolveAccess(fixture.root);
      return outcome.decision === "granted" ? outcome.access : undefined;
    },
    ...(options.review === "unknown"
      ? {}
      : { requiresEditorReview: (): boolean => options.review === "required" }),
    enforceProducerBinding: true,
    mutationLeaseCoordinator: coordinator,
    serverRuntimeChangeset: apply,
  });
}

function editRequest(): Parameters<CodingToolReadEditPorts["editorChangeset"]["execute"]>[0] {
  return {
    action: "edit" as const,
    actionId: "edit-server-changeset",
    idempotencyKey: "edit-server-changeset-key",
    changeset: {
      patch: "--- a/component.tsx\n+++ b/component.tsx\n@@ -1 +1 @@\n-before\n+after\n",
      files: [
        { file: "component.tsx", expectedContentHash: secureWorkspaceTextDigest("before\n") },
      ],
    },
  };
}

function runEdit(
  fixture: PortFixture,
  signal?: AbortSignal,
  check: () => boolean = (): true => true,
): ReturnType<CodingToolReadEditPorts["editorChangeset"]["execute"]> {
  return fixture.ports.editorChangeset.execute(editRequest(), signal, {
    check,
    binding: fixture.binding,
  });
}

function passiveBuffer(root: string, dirtyFiles: readonly string[]): EditorAgentSessionSnapshot {
  return {
    schemaVersion: "1",
    sessionId: "buffer:manual-editor",
    windowId: "manual-editor",
    workspaceRoot: root,
    activePaneId: null,
    panes: [],
    dirtyFiles,
    activeFile: null,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: Date.now(),
  };
}

function registerDirty(root: string, files: readonly string[]): void {
  expect(
    editorAgentRegistry.registerBufferSnapshot(passiveBuffer(root, files), "b".repeat(64)),
  ).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) dispose();
  editorRoutes._resetEditorAgentStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Coding Workbench allowed edits without a browser bridge", () => {
  it.each(["absent", "disconnected"] as const)(
    "applies an allowed edit with the bridge %s",
    async (bridge) => {
      const fixture = portFixture();
      if (bridge === "disconnected") {
        editorAgentRegistry.registerSnapshot({
          schemaVersion: "1",
          sessionId: "old-browser",
          windowId: "coding-workbench",
          workspaceRoot: fixture.root,
          activePaneId: null,
          panes: [],
          dirtyFiles: [],
          activeFile: null,
          cursor: null,
          selection: null,
          diagnosticsSummary: null,
          textMode: "none",
          updatedAt: Date.now(),
        });
        const disconnect = editorAgentRegistry.connect("old-browser", () => undefined);
        disconnect();
      }
      const retained = editorAgentRegistry.listSessions();
      vi.useFakeTimers();
      const pending = fixture.ports.editorChangeset.execute(editRequest(), undefined, {
        check: () => true,
        binding: fixture.binding,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ status: "completed" });
      expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("after\n");
      expect(fixture.listSessions).not.toHaveBeenCalled();
      expect(fixture.apply).toHaveBeenCalledOnce();
      expect(editorAgentRegistry.listSessions()).toEqual(retained);
    },
  );

  it.each(["required", "unknown"] as const)(
    "keeps %s human review on the browser path",
    async (review) => {
      const fixture = portFixture({ review });
      vi.useFakeTimers();
      const pending = runEdit(fixture);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ status: "failed", reasonCode: "NO_ACTIVE_SESSION" });
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
    },
  );

  it.each(["required", "unknown"] as const)(
    "refuses a lease requiring %s review at the transaction",
    async (serviceReview) => {
      const fixture = portFixture({ serviceReview });
      expect(await runEdit(fixture)).toMatchObject({ status: "failed" });
      expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
    },
  );

  it.each(["authority", "workspace", "root", "action", "idempotency"] as const)(
    "rejects a mismatched %s identity",
    async (field) => {
      const fixture = portFixture({ rewriteInput: (input) => rewriteIdentity(input, field) });
      expect(await runEdit(fixture)).toMatchObject({ status: "failed" });
      expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
    },
  );

  it("rechecks live authority before claiming the write", async () => {
    let live = true;
    const fixture = portFixture({
      beforeApply: (): void => {
        live = false;
      },
    });
    expect(await runEdit(fixture, undefined, (): boolean => live)).toMatchObject({
      status: "failed",
    });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
  });

  it("refuses a replaced managed root before writing", async () => {
    const fixture = portFixture({
      beforeApply: (): void => {
        replaceManagedRoot(fixture.root);
      },
    });
    expect(await runEdit(fixture)).toMatchObject({ status: "failed" });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("replacement-root\n");
    expect(readFileSync(join(`${fixture.root}-original`, "component.tsx"), "utf8")).toBe(
      "before\n",
    );
  });

  it("cancels before the transaction without returning a successful edit", async () => {
    const controller = new AbortController();
    const fixture = portFixture({
      beforeApply: (): void => {
        controller.abort();
      },
    });
    expect(await runEdit(fixture, controller.signal)).toMatchObject({
      status: "failed",
      reasonCode: "CANCELLED",
    });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
  });

  it("protects a retained manual Editor dirty target without activating that Editor", async () => {
    const fixture = portFixture();
    registerDirty(fixture.root, ["component.tsx"]);
    expect(await runEdit(fixture)).toMatchObject({ status: "failed", reasonCode: "DIRTY" });
    expect(editorAgentRegistry.snapshotFor("buffer:manual-editor")).toBeUndefined();
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
  });

  it("allows unrelated dirty targets and retains their safety state", async () => {
    const fixture = portFixture();
    registerDirty(fixture.root, ["unrelated.tsx"]);
    expect(await runEdit(fixture)).toEqual({ status: "completed" });
    expect(editorAgentRegistry.listSessions()).toContainEqual(
      expect.objectContaining({ workspaceRoot: fixture.root, dirtyFiles: ["unrelated.tsx"] }),
    );
  });

  it("fails closed when a dirty buffer root can no longer be resolved", async () => {
    const fixture = portFixture();
    registerDirty(join(fixture.root, "missing-root"), ["component.tsx"]);
    expect(await runEdit(fixture)).toMatchObject({ status: "failed", reasonCode: "DIRTY" });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
  });

  it("does not let an unrelated deleted dirty root block the current workspace", async () => {
    const fixture = portFixture();
    const unrelated = `${fixture.root}-unrelated`;
    mkdirSync(unrelated);
    registerDirty(unrelated, ["component.tsx"]);
    rmSync(unrelated, { recursive: true });
    expect(await runEdit(fixture)).toEqual({ status: "completed" });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("after\n");
  });

  it("preserves a concurrent disk edit instead of overwriting stale input", async () => {
    const fixture = portFixture({
      beforeApply: (): void => {
        writeFileSync(join(fixture.root, "component.tsx"), "concurrent\n");
      },
    });
    expect(await runEdit(fixture)).toMatchObject({
      status: "failed",
      reasonCode: "CONTENT_HASH_MISMATCH",
    });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("concurrent\n");
  });

  it("rejects a creation collision without replacing the existing file", async () => {
    const fixture = portFixture();
    const request = {
      ...editRequest(),
      changeset: {
        patch: "--- /dev/null\n+++ b/component.tsx\n@@ -0,0 +1 @@\n+new\n",
        files: [{ file: "component.tsx", expectedContentHash: secureWorkspaceTextDigest("") }],
      },
    };
    expect(
      await fixture.ports.editorChangeset.execute(request, undefined, {
        check: (): true => true,
        binding: fixture.binding,
      }),
    ).toMatchObject({ status: "failed" });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
  });

  it("consumes the exact mutation lease once", async () => {
    const fixture = portFixture();
    expect(await runEdit(fixture)).toEqual({ status: "completed" });
    const [input] = fixture.apply.mock.calls[0] ?? [];
    if (input === undefined) throw new Error("Production apply input is missing");
    expect(
      editorRoutes.applyRuntimeChangeset(input, {
        runtimeMutationLease: fixture.coordinator.lease,
        workspaceRootAccessResolver: fixture.resolveAccess,
      }),
    ).toMatchObject({ status: "failed" });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("after\n");
  });

  it("rolls back the first write when the second write fails", async () => {
    const fixture = portFixture();
    writeFileSync(join(fixture.root, "second.tsx"), "second-before\n");
    const writer = createContainedNodeWorkspaceWriter(fixture.root);
    const writes: { readonly path: string; readonly content: string }[] = [];
    editorRoutes._setEditorAgentPatchWriterForTests({
      ...writer,
      writeFileUtf8: (path, content): void => {
        writes.push({ path, content });
        if (path === join(fixture.root, "second.tsx"))
          throw new Error("Injected second write failure");
        writer.writeFileUtf8(path, content);
      },
    });
    const request = {
      ...editRequest(),
      changeset: {
        patch:
          "--- a/component.tsx\n+++ b/component.tsx\n@@ -1 +1 @@\n-before\n+after\n--- a/second.tsx\n+++ b/second.tsx\n@@ -1 +1 @@\n-second-before\n+second-after\n",
        files: [
          ...editRequest().changeset.files,
          { file: "second.tsx", expectedContentHash: secureWorkspaceTextDigest("second-before\n") },
        ],
      },
    };
    expect(
      await fixture.ports.editorChangeset.execute(request, undefined, {
        check: (): true => true,
        binding: fixture.binding,
      }),
    ).toMatchObject({ status: "failed" });
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
    expect(readFileSync(join(fixture.root, "second.tsx"), "utf8")).toBe("second-before\n");
    expect(writes).toEqual([
      { path: join(fixture.root, "component.tsx"), content: "after\n" },
      { path: join(fixture.root, "second.tsx"), content: "second-after\n" },
      { path: join(fixture.root, "component.tsx"), content: "before\n" },
    ]);
  });

  it("records the existing settled operation with a body-free server path", async () => {
    const fixture = portFixture();
    expect(await runEdit(fixture)).toEqual({ status: "completed" });
    const event = fixture.events.find(
      (entry) => entry.op === "coding-runtime.editor-mutation.settled",
    );
    const line = formatActivityLogProofLine(event ?? {});
    expect(
      expectActivityLogProof("coding-runtime.editor-mutation.settled.emitted-line", line),
    ).toMatchObject({ state: "succeeded", executionPath: "server" });
    expect(line).not.toContain(fixture.root);
    expect(line).not.toContain("component.tsx");
    expect(line).not.toContain("before\n");
  });

  it("rolls back an earlier write when cancellation arrives between file effects", async () => {
    const controller = new AbortController();
    const fixture = portFixture();
    writeFileSync(join(fixture.root, "second.tsx"), "second-before\n");
    const writer = createContainedNodeWorkspaceWriter(fixture.root);
    const contents: string[] = [];
    editorRoutes._setEditorAgentPatchWriterForTests({
      ...writer,
      writeFileUtf8: (path, content): void => {
        writer.writeFileUtf8(path, content);
        contents.push(content);
        if (content === "after\n") controller.abort();
      },
    });
    const request = {
      ...editRequest(),
      changeset: {
        patch:
          "--- a/component.tsx\n+++ b/component.tsx\n@@ -1 +1 @@\n-before\n+after\n--- a/second.tsx\n+++ b/second.tsx\n@@ -1 +1 @@\n-second-before\n+second-after\n",
        files: [
          ...editRequest().changeset.files,
          { file: "second.tsx", expectedContentHash: secureWorkspaceTextDigest("second-before\n") },
        ],
      },
    };
    expect(
      await fixture.ports.editorChangeset.execute(request, controller.signal, {
        check: (): true => true,
        binding: fixture.binding,
      }),
    ).toMatchObject({ status: "failed", reasonCode: "CANCELLED" });
    expect(contents).toEqual(["after\n", "before\n"]);
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
    expect(readFileSync(join(fixture.root, "second.tsx"), "utf8")).toBe("second-before\n");
  });

  it("records anchored frames and cause classes when the internal apply port throws", async () => {
    const fixture = portFixture({
      beforeApply: (): never => {
        throw new Error("PRIVATE_INPUT_BODY", { cause: new TypeError("PRIVATE_CAUSE_BODY") });
      },
    });
    expect(await runEdit(fixture)).toEqual({
      status: "failed",
      reasonCode: "EDIT_TRANSPORT_ERROR",
    });
    expect(fixture.diagnosticRecords).toHaveLength(1);
    expect(fixture.diagnosticRecords[0]?.frames?.length).toBeGreaterThan(0);
    expect(fixture.diagnosticRecords[0]?.causeChain).toEqual(["TypeError"]);
    expect(JSON.stringify(fixture.diagnosticRecords)).not.toContain("PRIVATE_");
    expect(readFileSync(join(fixture.root, "component.tsx"), "utf8")).toBe("before\n");
    expect(await fixture.coordinator.waitForIdle(new AbortController().signal)).toBe(
      "idle-succeeded",
    );
  });
});

function rewriteIdentity(
  input: RuntimeChangesetApplyInput,
  field: "authority" | "workspace" | "root" | "action" | "idempotency",
): RuntimeChangesetApplyInput {
  const leaseRequest = input.leaseRequest;
  const overrides = {
    authority: { authorityRef: { ...leaseRequest.authorityRef, runId: "another-run" } },
    workspace: { workspaceId: "ws_ffffffffffffffffffffffff" },
    root: { workspaceRootDigest: "c".repeat(64) },
    action: { actionId: "another-action" },
    idempotency: { idempotencyKey: "another-key" },
  };
  return { ...input, leaseRequest: { ...leaseRequest, ...overrides[field] } };
}

function replaceManagedRoot(root: string): void {
  renameSync(root, `${root}-original`);
  mkdirSync(root);
  writeFileSync(join(root, "component.tsx"), "replacement-root\n");
}
