// Route tests for the governed commit preview + execute routes (Issue #475, Epic #470).
//
// Proves the #475 commit-quality acceptance criteria at the BFF seam:
//   * AC2 — a message-policy violation BLOCKS the commit before the kernel runs, with typed codes.
//   * AC3 — the read-only preview surfaces mixed-scope / WIP commit-intent warnings.
//   * AC4 — a governed commit records evidence; outcomes are content-free.
//   * AC5 — commit execution cannot bypass the kernel: a policy/preflight block executes nothing.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitDeliveryApprovalClaim,
  GitDeliveryExecutionResult,
  GitDeliveryRepoPolicyPack,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type { GitLocalMutationAdapter, GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import { createEditorSettingsControlService } from "../editor/settings/editorSettingsControl.js";
import { createEditorSettingsStore } from "../editor/settings/editorSettingsStore.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { RouteContext } from "../routes.js";
import {
  createHandleCommitApprove,
  createHandleCommitExecute,
  createHandleCommitPreview,
  type GitDeliveryCommitApproveResponseBody,
  type GitDeliveryCommitPreviewBody,
} from "./commitRoutes.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import type { GitDeliveryExecutionSeams } from "./execution.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "../task-workspace/naming.js";
import { assertManagedRootOwned } from "../task-workspace/managed-root.js";
import { inspectManagedGitdirIdentity } from "../task-workspace/gitdir-identity.js";

const PREVIEW = "/api/git-delivery/commit/preview";
const EXECUTE = "/api/git-delivery/commit/execute";

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feature/x",
  stagedFileCount: 2,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  existingLocalBranchNames: ["feature/x", "main"],
  remoteAliases: ["origin"],
};

const ALLOW_LOCAL_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: {
    decision: "constrained",
    constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
  },
};

const BLOCK_ALL_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: { decision: "blocked" },
};

interface RecordingAdapter {
  readonly adapter: GitLocalMutationAdapter;
  readonly calls: () => readonly string[];
}

function recordingAdapter(): RecordingAdapter {
  const calls: string[] = [];
  const ok: GitDeliveryExecutionResult = {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome: "succeeded",
    durationMs: 2,
  };
  const run = (name: string) => (): Promise<GitDeliveryExecutionResult> => {
    calls.push(name);
    return Promise.resolve(ok);
  };
  return {
    adapter: {
      createBranch: run("createBranch"),
      switchBranch: run("switchBranch"),
      stage: run("stage"),
      unstage: run("unstage"),
      commit: run("commit"),
      abort: run("abort"),
      recover: run("recover"),
    },
    calls: () => calls,
  };
}

function capturingEvidenceStore(): { store: EvidenceStore; count: () => number } {
  const docs = new Map<string, string>();
  return {
    store: {
      put: (runId, json): string => {
        docs.set(runId, json);
        return runId;
      },
      list: () => [...docs.keys()],
      get: (runId) => docs.get(runId),
      delete: (runId) => docs.delete(runId),
    },
    count: (): number => {
      let n = 0;
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: unknown[] };
        n += Array.isArray(doc.records) ? doc.records.length : 0;
      }
      return n;
    },
  };
}

let server: Server;
let port: number;
let staticRoot: string;
let store: UiStore;
let projectId: string;
const settingsStateDirs: string[] = [];

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    gitDeliveryAuthority: permittedGitDeliveryAuthority(() => projectId),
    ...overrides,
  };
}

// #3347 managed-worktree identity: resolveRegisteredOrManagedWorkspaceRoot now composes
// resolveManagedWorkspaceRootAccess, which re-proves a REAL Git linked-worktree pointer
// (gitdir-identity.ts) instead of trusting path shape alone -- a plain mkdir with a placeholder
// gitdirIdentity no longer admits. Builds a genuine `git worktree add` linkage rooted at
// `sourceRepo` at `worktreePath` and returns its real gitdir identity for the fixture instance.
function buildManagedGitWorktree(
  sourceRepo: string,
  worktreePath: string,
  taskBranch: string,
): string {
  execFileSync("git", ["init", "-q"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: sourceRepo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: sourceRepo });
  mkdirSync(dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", taskBranch, worktreePath, "HEAD"], {
    cwd: sourceRepo,
  });
  const inspection = inspectManagedGitdirIdentity(worktreePath, sourceRepo);
  if (inspection === undefined) {
    throw new Error("fixture git worktree did not produce a resolvable gitdir identity");
  }
  return inspection.identity;
}

function managedWorkspaceDeps(taskId = "task-443"): {
  readonly instance: WorkspaceInstance;
  readonly override: Partial<UiHandlerDeps>;
  readonly cleanup: () => void;
} {
  const managedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-commit-managed-")));
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-commit-repo-")));
  // Ownership must be established BEFORE anything creates a directory under the managed root: a
  // recursive mkdir of the worktree parent would materialize the root itself under the ambient
  // umask, and the marker initialization would then see "already exists" and never apply.
  assertManagedRootOwned(managedRoot);
  const repositoryId = deriveRepositoryId(repoRoot);
  const workspaceId = deriveWorkspaceId({ repositoryId, taskId });
  const managedWorktreePath = deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId });
  const taskBranch = deriveTaskBranchName({ taskId });
  const gitdirIdentity = buildManagedGitWorktree(repoRoot, managedWorktreePath, taskBranch);
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId,
    repositoryRoot: repoRoot,
    baseBranch: "main",
    taskBranch,
    managedWorktreePath,
    gitdirIdentity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
  };
  return {
    instance,
    override: {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: {
        getInstance: (id: string) => (id === workspaceId ? instance : undefined),
        provision: () => Promise.reject(new Error("not used")),
        activate: () => Promise.reject(new Error("not used")),
      },
    },
    cleanup: (): void => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(managedRoot, { recursive: true, force: true });
    },
  };
}

function ctxFor(path: string, body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    correlationId: undefined,
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function seams(overrides: Partial<GitDeliveryExecutionSeams> = {}): GitDeliveryExecutionSeams {
  return {
    snapshotReader: () => Promise.resolve(SNAPSHOT),
    stagedPathsReader: () => Promise.resolve(["packages/keiko-ui/a.ts", "docs/b.md"]),
    conflictMarkerReader: () => Promise.resolve(0),
    branchProtectionReader: () => Promise.resolve({ outcome: "unprotected" }),
    now: () => 1_700_000_000_000,
    newActionId: () => "action-test-1",
    policyPacks: { repoPack: ALLOW_LOCAL_PACK },
    ...overrides,
  };
}

async function repositoryNativeSettings(): Promise<
  NonNullable<UiHandlerDeps["editorSettingsControl"]>
> {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-commit-settings-")));
  settingsStateDirs.push(stateDir);
  const control = createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir }),
    mutex: createWorkspaceMutexRegistry(),
  });
  const mutation = await control.mutate({
    action: "set",
    expectedRevision: 0,
    idempotencyKey: "commit-policy-repository-native",
    scope: "user",
    values: { gitCommitMessagePolicy: "repository-native" },
  });
  if (mutation.kind !== "ok") {
    throw new Error(
      `failed to configure commit-message policy fixture: ${JSON.stringify(mutation)}`,
    );
  }
  return control;
}

// #3386: the execute route now binds the consumed claim to the admitted run's identity
// (runId/envelopeDigest), exactly as the merge route already does — a claim minted without them no
// longer matches. "test-run" / "c".repeat(64) are `permittedGitDeliveryAuthority`'s fixed values
// (runBoundAuthority.test-support.ts), the authority every test in this file admits through by
// default.
function issueCommitApproval(
  approvalStore: ReturnType<typeof createInMemoryGitDeliveryApprovalStore>,
  message: string,
  allowEmpty = false,
): GitDeliveryApprovalClaim {
  return approvalStore.issue({
    binding: {
      projectId,
      operation: "commit",
      command: { kind: "commit", message, allowEmpty },
      runId: "test-run",
      envelopeDigest: "c".repeat(64),
    },
    approvedByUserId: "u-1",
    nowMs: 1_700_000_000_000,
    ttlMs: 60_000,
  }).approval;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

async function startBound(overrides: Partial<UiHandlerDeps> = {}): Promise<void> {
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps: deps(overrides),
  });
  server = started.server;
  port = started.port;
}

beforeEach(() => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-commit-static-"));
  store = createInMemoryUiStore();
  projectId = store.createProject(mkdtempSync(join(tmpdir(), "keiko-gd-commit-proj-"))).path;
});

afterEach(() => {
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
  for (const stateDir of settingsStateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("commit routes — central enforcement (real dispatch)", () => {
  beforeEach(async () => {
    await startBound();
  });
  afterEach(async () => {
    await closeServer();
  });

  it("does not require a deployment enable flag before checking the worktree", async () => {
    await closeServer();
    await startBound({ env: {} });
    const cases = [
      { path: PREVIEW, body: { schemaVersion: "1", projectId, messageDraft: "feat: x" } },
      { path: EXECUTE, body: { schemaVersion: "1", projectId, message: "feat: x" } },
    ] as const;
    for (const item of cases) {
      const res = await fetch(`http://${UI_HOST}:${String(port)}${item.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(item.body),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE" },
      });
    }
  });

  it("403s without the central CSRF header", async () => {
    const res = await fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1", projectId, message: "feat: x" }),
    });
    expect(res.status).toBe(403);
  });

  function postExec(body: unknown): Promise<Response> {
    return fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("rejects validation failures before execution", async () => {
    expect(
      (await postExec({ schemaVersion: "1", projectId, message: "feat: x", evil: 1 })).status,
    ).toBe(400);
    // A commit message carrying a credential is refused at the boundary. The sample is a realistic
    // token: the guard matches a credential VALUE, not the bare word "Bearer", so that ordinary
    // messages about authentication stay committable (asserted immediately below).
    expect(
      (
        await postExec({
          schemaVersion: "1",
          projectId,
          message: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij",
        })
      ).status,
    ).toBe(400);
    expect(
      (await postExec({ schemaVersion: "1", projectId: "/no/such", message: "feat: x" })).status,
    ).toBe(404);
    const big = JSON.stringify({ schemaVersion: "1", projectId, message: "x".repeat(70 * 1024) });
    expect((await postExec(big)).status).toBe(413);
    expect((await postExec("{ not json")).status).toBe(400);
  });

  // The complement of the credential guard above. A message that merely NAMES an auth mechanism is
  // ordinary English and must reach the kernel; the fixture project is not a git repository, so
  // reaching the kernel surfaces as the worktree-unavailable 409 rather than the guard's 400.
  it.each([
    "fix(auth): reject a malformed bearer token",
    "docs: describe the api_key rotation runbook",
    "feat: add basic retry to the sync worker",
    "fix(http): drop the set-cookie header on redirect",
  ])("commits a message that merely mentions auth: %s", async (message) => {
    const res = await postExec({ schemaVersion: "1", projectId, message });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE" },
    });
  });
});

describe("commit preview — read-only verification context (AC3)", () => {
  it("accepts a persisted managed task workspace root as projectId", async () => {
    const managed = managedWorkspaceDeps();
    const handler = createHandleCommitPreview({ execution: seams() });
    try {
      const res = await handler(
        ctxFor(PREVIEW, {
          schemaVersion: "1",
          projectId: managed.instance.managedWorktreePath,
          messageDraft: "feat(ui): add governed flow",
        }),
        deps(managed.override),
      );
      expect(res.status).toBe(200);
      expect((res.body as GitDeliveryCommitPreviewBody).policyOutcome).toBe("allowed");
    } finally {
      managed.cleanup();
    }
  });

  it("surfaces mixed-scope and WIP commit-intent warnings + message-policy violations", async () => {
    const handler = createHandleCommitPreview({ execution: seams() });
    const res = await handler(
      ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "WIP not conventional" }),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.summary.areaCount).toBe(2);
    expect(body.intent.warnings).toContain("mixed-scope");
    expect(body.intent.warnings).toContain("wip-marker");
    expect(body.intent.isWip).toBe(true);
    expect(body.messageValidation.ok).toBe(false);
    expect(body.policyOutcome).toBe("allowed");
    expect(body.suggestedMessage).toBe(
      [
        "chore: update selected files and documentation",
        "",
        "Update the staged selected files and documentation.",
        "Keep the commit limited to the selected staged files.",
      ].join("\n"),
    );
  });

  it("builds a repository-neutral commit draft from the selected staged files", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        stagedPathsReader: () =>
          Promise.resolve([
            "apps/checkout/src/cartService.ts",
            "apps/checkout/src/cartService.test.ts",
            "apps/checkout/package.json",
          ]),
      }),
    });
    const res = await handler(
      ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "" }),
      deps(),
    );
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.suggestedMessage).toBe(
      [
        "chore(checkout): update cart service and related changes",
        "",
        "Update the staged cart service, test coverage, and configuration.",
        "Keep the commit limited to the selected staged files.",
        "Includes related test coverage.",
      ].join("\n"),
    );
    expect(body.suggestedMessage).not.toContain("Keiko");
  });

  it("classifies common config files and normalizes a repository scope", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        stagedPathsReader: () =>
          Promise.resolve([
            "services/---Billing Platform---/tsconfig.build.json",
            "services/---Billing Platform---/vite.config.ts",
            "services/---Billing Platform---/settings.yaml",
          ]),
      }),
    });
    const res = await handler(
      ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "" }),
      deps(),
    );

    expect((res.body as GitDeliveryCommitPreviewBody).suggestedMessage).toBe(
      [
        "chore(billing-platform): update configuration",
        "",
        "Update the staged configuration.",
        "Keep the commit limited to the selected staged files.",
      ].join("\n"),
    );
  });

  it("uses the package name rather than the npm namespace as a scoped-package draft scope", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        stagedPathsReader: () =>
          Promise.resolve([
            "packages/@acme/payments/src/invoice.ts",
            "packages/@acme/payments/src/invoice.test.ts",
          ]),
      }),
    });
    const res = await handler(
      ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "" }),
      deps(),
    );

    expect((res.body as GitDeliveryCommitPreviewBody).suggestedMessage).toContain(
      "chore(payments):",
    );
  });

  it("records a content-free preview summary and never the drafted message", async () => {
    const events: ServerLogEvent[] = [];
    const handler = createHandleCommitPreview({
      execution: seams(),
      activityLog: {
        write(event): void {
          events.push(event);
        },
      },
    });

    await handler(
      { ...ctxFor(PREVIEW, { schemaVersion: "1", projectId }), correlationId: "commit-preview-1" },
      deps(),
    );

    expect(events).toContainEqual({
      category: "diagnostic",
      op: "git.commit.preview.completed",
      correlationId: "commit-preview-1",
      status: 200,
      extra: {
        stagedFileCount: 2,
        areaCount: 2,
        touchesTests: false,
        draftSuggested: true,
        policyOutcome: "allowed",
      },
    });
    expect(JSON.stringify(events)).not.toContain("update staged changes");
  });

  it("discloses a trusted signed-commit requirement before commit", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        branchProtectionReader: (_workspace, remoteAlias, branchName) => {
          expect(remoteAlias).toBe("origin");
          expect(branchName).toBe("feature/x");
          return Promise.resolve({
            outcome: "protected",
            protection: {
              deletionAllowed: false,
              forcePushAllowed: false,
              linearHistoryRequired: true,
              signaturesRequired: true,
              requiredReviewCount: 0,
              requiredStatusCheckCount: 1,
            },
          });
        },
      }),
    });
    const res = await handler(
      ctxFor(PREVIEW, {
        schemaVersion: "1",
        projectId,
        messageDraft: "feat(ui): add governed flow",
      }),
      deps(),
    );
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.signatureRequirement).toBe("required");
    expect(body.preflightFindingCodes).toContain("signed-commits-required");
  });

  it("does not treat a failed branch-protection read as no signature requirement", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        branchProtectionReader: () => Promise.resolve({ outcome: "unavailable" }),
      }),
    });
    const res = await handler(
      ctxFor(PREVIEW, {
        schemaVersion: "1",
        projectId,
        messageDraft: "feat(ui): add governed flow",
      }),
      deps(),
    );
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.signatureRequirement).toBe("unavailable");
    expect(body.preflightFindingCodes).toContain("branch-protection-unavailable");
  });

  it("accepts a clean conventional message in the same scope", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({ stagedPathsReader: () => Promise.resolve(["packages/keiko-ui/a.ts"]) }),
    });
    const res = await handler(
      ctxFor(PREVIEW, {
        schemaVersion: "1",
        projectId,
        messageDraft: "feat(ui): add governed flow\n\nbody",
      }),
      deps(),
    );
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.intent.warnings).not.toContain("mixed-scope");
    expect(body.messageValidation.ok).toBe(true);
  });

  it("uses one persisted Repository Native selection for preview and execute", async () => {
    const editorSettingsControl = await repositoryNativeSettings();
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const routeSeams = seams({ adapterFactory: () => adapter.adapter, approvalStore });
    const preview = await createHandleCommitPreview({ execution: routeSeams })(
      ctxFor(PREVIEW, {
        schemaVersion: "1",
        projectId,
        messageDraft: "repository native subject",
      }),
      deps({ editorSettingsControl }),
    );
    expect((preview.body as GitDeliveryCommitPreviewBody).messageValidation).toEqual({ ok: true });

    const message = "repository native subject";
    const execute = await createHandleCommitExecute({ execution: routeSeams })(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps({ editorSettingsControl }),
    );
    expect(execute.body).toMatchObject({ status: "succeeded" });
    expect(adapter.calls()).toEqual(["commit"]);
  });

  it("does not offer a draft when no changes are staged", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, stagedFileCount: 0 }),
        stagedPathsReader: () => Promise.resolve([]),
      }),
    });

    const res = await handler(ctxFor(PREVIEW, { schemaVersion: "1", projectId }), deps());

    expect((res.body as GitDeliveryCommitPreviewBody).suggestedMessage).toBeUndefined();
  });

  it("does not invent a draft when the snapshot and staged path read disagree", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({ stagedPathsReader: () => Promise.resolve([]) }),
    });

    const res = await handler(ctxFor(PREVIEW, { schemaVersion: "1", projectId }), deps());

    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.summary.stagedFileCount).toBe(0);
    expect(body.preflightFindingCodes).toContain("nothing-staged-to-commit");
    expect(body.suggestedMessage).toBeUndefined();
  });
});

describe("commit execute — message policy gate + no-bypass (AC2/AC4/AC5)", () => {
  it("blocks a policy-violating message BEFORE the kernel and never commits (AC2)", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "broken commit message" }),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string; blockReason?: string; messageViolations?: string[] };
    expect(body.status).toBe("blocked");
    expect(body.blockReason).toBe("message-policy");
    expect(body.messageViolations).toContain("missing-conventional-prefix");
    expect(adapter.calls()).toEqual([]); // nothing executed
  });

  it("refuses to commit staged content with an unresolved conflict marker, executing NOTHING (issue #4: silently-committed markers)", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        conflictMarkerReader: () => Promise.resolve(1),
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add governed flow" }),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      status: string;
      blockReason?: string;
      conflictMarkerFileCount?: number;
    };
    expect(body.status).toBe("blocked");
    expect(body.blockReason).toBe("unresolved-conflict-markers");
    expect(body.conflictMarkerFileCount).toBe(1);
    // Before this fix, nothing checked staged CONTENT for leftover markers: a valid conventional
    // message + a mergeable-looking snapshot would have driven the commit adapter unconditionally,
    // baking the literal marker lines into history. Proves it now executes nothing instead.
    expect(adapter.calls()).toEqual([]);
  });

  it("fails closed (409) when the conflict-marker read itself cannot be completed", async () => {
    const adapter = recordingAdapter();
    const records: ServerDiagnosticRecord[] = [];
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        conflictMarkerReader: () => Promise.reject(new Error("not a git repository")),
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add governed flow" }),
      deps({
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(adapter.calls()).toEqual([]);
    expect(records).toEqual([
      expect.objectContaining({
        correlationId: UNKNOWN_CORRELATION_ID,
        operation: "git.commit.execute.conflict-scan",
        source: "git-delivery.commit-routes",
        errorClass: "Error",
      }),
    ]);
  });

  it("executes a valid conventional commit and records evidence (AC4)", async () => {
    const adapter = recordingAdapter();
    const cap = capturingEvidenceStore();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
    });
    const message = "feat(ui): add governed flow";
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps({ evidenceStore: cap.store }),
    );
    expect((res.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["commit"]);
    expect(cap.count()).toBe(1);
  });

  // #3386: proves the mandatory-approval check runs before the message-policy/conflict/branch
  // guards but AFTER those, the kernel's OWN preflight/policy still runs unbypassed — a granted
  // approval is not itself authority to skip preflight, policy, or branch protection.
  it("cannot bypass the kernel: a valid message is still policy-blocked, executing nothing (AC5)", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        policyPacks: { repoPack: BLOCK_ALL_PACK },
        approvalStore,
      }),
    });
    const message = "feat(ui): add governed flow";
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect((res.body as { policyOutcome: string }).policyOutcome).toBe("blocked");
    expect(adapter.calls()).toEqual([]);
  });

  it("cannot bypass preflight: nothing staged blocks the commit (AC5)", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, stagedFileCount: 0 }),
        approvalStore,
      }),
    });
    const message = "feat(ui): add governed flow";
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect((res.body as { preflightFindingCodes?: string[] }).preflightFindingCodes).toContain(
      "nothing-staged-to-commit",
    );
    expect(adapter.calls()).toEqual([]);
  });

  it("blocks direct commits to dev under the default local policy", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, currentBranchName: "dev" }),
        policyPacks: undefined,
        approvalStore,
      }),
    });
    const message = "chore: update staged changes";
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect((res.body as { blockReason?: string }).blockReason).toBe("protected-branch");
    expect(adapter.calls()).toEqual([]);
  });

  // #3386: previously "honoured" `{ required: false }` — a request-supplied claim of NO approval —
  // as sufficient to commit. That was exactly the unapproved-commit bypass this change closes: an
  // active run's commit now requires an actually consumed, server-issued claim, never a
  // browser-asserted "not required".
  it("commits with allowEmpty once a real server-issued claim is consumed", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
    });
    const message = "chore: empty";
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        allowEmpty: true,
        approval: issueCommitApproval(approvalStore, message, true),
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["commit"]);
  });

  // Pins the actual bypass this change closes (#3386, ADR-0138 D2): an accepted autonomous-delivery
  // run plus a direct HTTP commit carrying no approval at all must NOT commit. Before this change,
  // BOTH an entirely absent `approval` field and an explicit `{ required: false }` executed
  // unconditionally.
  it.each([
    ["an absent approval field", undefined],
    ["an explicit { required: false }", { required: false }],
  ] as const)(
    "does not commit an accepted run's direct HTTP request that carries %s",
    async (_label, approval) => {
      const adapter = recordingAdapter();
      const handler = createHandleCommitExecute({
        execution: seams({ adapterFactory: () => adapter.adapter }),
      });
      const res = await handler(
        ctxFor(EXECUTE, {
          schemaVersion: "1",
          projectId,
          message: "chore: empty",
          allowEmpty: true,
          ...(approval === undefined ? {} : { approval }),
        }),
        deps(),
      );
      expect((res.body as { status: string }).status).toBe("approval-required");
      expect(adapter.calls()).toEqual([]);
    },
  );

  it("holds for approval when the trusted pack is approval-gated", async () => {
    const adapter = recordingAdapter();
    const approvalGated: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo",
      rules: [{ actionKind: "commit", decision: "approval-gated", requiredApprovers: ["lead"] }],
      defaultRule: { decision: "blocked" },
    };
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        policyPacks: { repoPack: approvalGated },
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("approval-required");
    expect(adapter.calls()).toEqual([]);
  });

  // What this pins is BINDING integrity: a claim is redeemable only if its recorded binding
  // (project + operation + command) matches the request. The approver IDENTITY is a separate
  // concern, gated by KEIKO-0147 and pinned by the test below — so this rule uses
  // `requiredApprovers: []`, which ADR-0080 D5 defines as "at least one approver of any
  // identity". Previously it named `["lead"]` while the store minted `u-1`, which only passed
  // because nothing checked membership.
  it("executes an approval-gated commit only with a matching server-issued claim", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approvalGated: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo",
      rules: [{ actionKind: "commit", decision: "approval-gated", requiredApprovers: [] }],
      defaultRule: { decision: "blocked" },
    };
    const message = "feat(ui): add flow";
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        policyPacks: { repoPack: approvalGated },
        approvalStore,
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["commit"]);
  });

  // KEIKO-0147: a valid, correctly-bound, server-issued claim is still not authority when the
  // pack names a required-approver set the granting identity is not in. This is fail-closed by
  // design: Keiko mints every claim as the single local principal (`GIT_DELIVERY_LOCAL_OPERATOR_ID`
  // — approvalStore.ts), so a pack naming any other approver describes an authority this product
  // cannot produce, and blocking says so instead of silently proceeding over a policy it did not
  // satisfy. `requiredApprovers: []` remains "any identity" per ADR-0080 D5 (pinned above).
  it("blocks an approval-gated commit when the claim's approver is not in requiredApprovers", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const message = "feat(ui): add flow";
    const namedApprover: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo",
      // The store's helper mints `u-1`; this pack demands `lead`, which it can never be.
      rules: [{ actionKind: "commit", decision: "approval-gated", requiredApprovers: ["lead"] }],
      defaultRule: { decision: "blocked" },
    };
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        policyPacks: { repoPack: namedApprover },
        approvalStore,
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect(adapter.calls()).toEqual([]);
  });

  it("rejects a forged browser-supplied approval object before commit execution", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message: "feat(ui): add flow",
        approval: {
          required: true,
          approvalTokenHash: "a".repeat(64),
          approvedByUserId: "u-1",
          approvedAtMs: 1_700_000_000_000,
        },
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(adapter.calls()).toEqual([]);
  });

  it("returns 409 worktree-unavailable when the live snapshot cannot be read", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandleCommitExecute({
      execution: seams({
        snapshotReader: () => Promise.reject(new Error("not a git repo")),
        approvalStore,
      }),
    });
    const message = "feat(ui): add flow";
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: issueCommitApproval(approvalStore, message),
      }),
      deps({
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(records).toEqual([
      expect.objectContaining({
        correlationId: UNKNOWN_CORRELATION_ID,
        operation: "git.commit.execute.mutation",
        source: "git-delivery.commit-routes",
        errorClass: "Error",
      }),
    ]);
  });

  it("rejects a malformed approval and an oversized/invalid body", async () => {
    const handler = createHandleCommitExecute({ execution: seams() });
    const bad = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message: "feat: x",
        approval: { required: "yes" },
      }),
      deps(),
    );
    expect(bad.status).toBe(400);
  });
});

describe("commit approve (mints the approval execute consumes) — #3386, ADR-0138 D2", () => {
  // Before this route existed, MINTABLE_ACTION_KINDS excluded "commit" and no HTTP surface could
  // ever satisfy a commit's approval requirement — mirrors mergeRoutes.test.ts's own "previously
  // unreachable" framing for the identical gap on merge.
  it("mints a claim that execute accepts for the exact same commit, letting an approval-required commit proceed", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approveHandler = createHandleCommitApprove({
      execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
    });
    const message = "feat(ui): add governed flow";
    const approveRes = await approveHandler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message }),
      deps(),
    );
    expect(approveRes.status).toBe(200);
    const approveBody = approveRes.body as GitDeliveryCommitApproveResponseBody;
    expect(approveBody.approval.approvalId).toBeTruthy();
    expect(approveBody.approval.approvalToken).toBeTruthy();
    expect(new Date(approveBody.expiresAt).getTime()).toBeGreaterThan(1_700_000_000_000);

    const executeHandler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
    });
    const executeRes = await executeHandler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message,
        approval: approveBody.approval,
      }),
      deps(),
    );
    expect((executeRes.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["commit"]);
  });

  it("mints a claim redeemable only for the exact message it was issued against", async () => {
    const adapter = recordingAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approveHandler = createHandleCommitApprove({ execution: seams({ approvalStore }) });
    const approveRes = await approveHandler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
      deps(),
    );
    const approveBody = approveRes.body as GitDeliveryCommitApproveResponseBody;

    const executeHandler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
    });
    const executeRes = await executeHandler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message: "feat(ui): a different message entirely",
        approval: approveBody.approval,
      }),
      deps(),
    );
    expect(executeRes.status).toBe(400);
    expect(adapter.calls()).toEqual([]);
  });

  it("404s for an unknown project instead of minting an approval", async () => {
    const approveHandler = createHandleCommitApprove({ execution: seams() });
    const res = await approveHandler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId: "/no/such/project", message: "feat: x" }),
      deps(),
    );
    expect(res.status).toBe(404);
  });

  it("denies the mint itself when no accepted run authority is active", async () => {
    const approveHandler = createHandleCommitApprove({ execution: seams() });
    const res = await approveHandler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat: x" }),
      deps({ gitDeliveryAuthority: { current: () => undefined } }),
    );
    expect(res.status).toBe(403);
  });
});

// Final-audit F2/#3390 (ADR-0138 D2): before this fix, the coarse admission gate hard-denied both
// commit/approve and commit/execute with "approval-required" below `autonomous-delivery` and no
// production path ever redeemed it — a governed-assist or supervised-coding commit was permanently
// unreachable regardless of the approval this exact describe block already proves works at
// `autonomous-delivery`. FAILING BEFORE THE FIX: `approveHandler` returned 403
// GIT_DELIVERY_AUTHORITY_DENIED at the `gitDeliveryAuthorityGate` call inside
// `createHandleCommitApprove`, never reaching `store.issue()`.
describe("commit approve + execute reachable regardless of mode — final-audit F2/#3390", () => {
  it.each(["governed-assist", "supervised-coding"] as const)(
    "mints and consumes a commit approval end to end at %s",
    async (mode) => {
      const adapter = recordingAdapter();
      const approvalStore = createInMemoryGitDeliveryApprovalStore();
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(() => projectId, () => projectId, mode),
      });
      const message = "feat(ui): add governed flow";
      const approveHandler = createHandleCommitApprove({
        execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
      });
      const approveRes = await approveHandler(
        ctxFor(EXECUTE, { schemaVersion: "1", projectId, message }),
        modeDeps,
      );
      expect(approveRes.status).toBe(200);
      const approveBody = approveRes.body as GitDeliveryCommitApproveResponseBody;

      const executeHandler = createHandleCommitExecute({
        execution: seams({ adapterFactory: () => adapter.adapter, approvalStore }),
      });
      const executeRes = await executeHandler(
        ctxFor(EXECUTE, {
          schemaVersion: "1",
          projectId,
          message,
          approval: approveBody.approval,
        }),
        modeDeps,
      );
      expect((executeRes.body as { status: string }).status).toBe("succeeded");
      expect(adapter.calls()).toEqual(["commit"]);
    },
  );

  it.each(["governed-assist", "supervised-coding"] as const)(
    "still returns approval-required (never mode-denied) at %s when execute carries no approval",
    async (mode) => {
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(() => projectId, () => projectId, mode),
      });
      const executeHandler = createHandleCommitExecute({ execution: seams() });
      const executeRes = await executeHandler(
        ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
        modeDeps,
      );
      expect(executeRes.status).toBe(200);
      expect(executeRes.body).toMatchObject({ status: "approval-required", actionKind: "commit" });
    },
  );
});

describe("commit approval evidence — body-free activity-log lines (#3386)", () => {
  it("logs a body-free line when the mint issues a claim", async () => {
    const events: ServerLogEvent[] = [];
    const approveHandler = createHandleCommitApprove({
      execution: seams({ activityLog: { write: (event) => events.push(event) } }),
    });
    await approveHandler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
      deps(),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "security",
          op: "git.delivery.commit.approval.minted",
          status: 200,
          extra: { operation: "commit", runId: "test-run" },
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("feat(ui): add flow");
  });

  it("logs a body-free line when an active run's commit is refused for lacking a consumed approval", async () => {
    const events: ServerLogEvent[] = [];
    const handler = createHandleCommitExecute({
      execution: seams({ activityLog: { write: (event) => events.push(event) } }),
    });
    await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
      deps(),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "security",
          op: "git.delivery.commit.approval.required",
          status: 200,
          extra: { operation: "commit", runId: "test-run" },
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("feat(ui): add flow");
  });
});

describe("commit preview — default draft, policy block, and worktree failure", () => {
  it("reports a protected-branch block for a default dev-branch commit preview", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, currentBranchName: "dev" }),
        policyPacks: undefined,
      }),
    });
    const res = await handler(
      ctxFor(PREVIEW, {
        schemaVersion: "1",
        projectId,
        messageDraft: "chore: update staged changes",
      }),
      deps(),
    );
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.policyOutcome).toBe("blocked");
    expect(body.policyBlockReason).toBe("protected-branch");
    expect(body.messageValidation.ok).toBe(true);
  });

  it("defaults an absent messageDraft to empty and reports a policy block reason", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({ policyPacks: { repoPack: BLOCK_ALL_PACK } }),
    });
    const res = await handler(ctxFor(PREVIEW, { schemaVersion: "1", projectId }), deps());
    const body = res.body as GitDeliveryCommitPreviewBody & { policyBlockReason?: string };
    expect(body.policyOutcome).toBe("blocked");
    expect(body.policyBlockReason).toBeDefined();
    expect(body.messageValidation.ok).toBe(false); // empty draft → empty-subject
  });

  it("returns 409 when the worktree cannot be read", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const handler = createHandleCommitPreview({
      execution: seams({ snapshotReader: () => Promise.reject(new Error("not a git repo")) }),
    });
    const res = await handler(
      {
        ...ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "feat: x" }),
        correlationId: "123e4567-e89b-12d3-a456-426614174000",
      },
      deps({
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(records).toEqual([
      expect.objectContaining({
        correlationId: "123e4567-e89b-12d3-a456-426614174000",
        operation: "git.commit.preview.worktree",
        source: "git-delivery.commit-routes",
        errorClass: "Error",
      }),
    ]);
  });

  it("degrades branch-protection inspection visibly and records the failure", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const handler = createHandleCommitPreview({
      execution: seams({
        branchProtectionReader: () => Promise.reject(new Error("provider unavailable")),
      }),
    });
    const res = await handler(
      {
        ...ctxFor(PREVIEW, { schemaVersion: "1", projectId }),
        correlationId: "123e4567-e89b-12d3-a456-426614174001",
      },
      deps({
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.body as GitDeliveryCommitPreviewBody).signatureRequirement).toBe("unavailable");
    expect(records).toEqual([
      expect.objectContaining({
        correlationId: "123e4567-e89b-12d3-a456-426614174001",
        operation: "git.commit.preview.branch-protection",
        source: "git-delivery.commit-routes",
        errorClass: "Error",
      }),
    ]);
  });
});
