// Route integration tests for /api/task-workspaces/* (Issue #445). Drives the live createUiServer
// (CSRF guard + host check run for real) against a real service over a disposable git repository, so
// the controlled server-side provisioning + activation path is exercised end-to-end over HTTP.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceBinding,
  WorkspaceInfo,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { UI_HOST } from "../server.js";
import { runMigrations } from "../store/schema.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import type { WorkspaceProvisioningService } from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { deriveRepositoryId } from "./naming.js";
import type { CodingWorkbenchIssuePreviewResponseWire } from "@oscharko-dev/keiko-contracts";
import { createProductionCodingRuntimeIssueIntake } from "../coding-context/codingRuntimeIssueIntake.js";

const __twMutex = createWorkspaceMutexRegistry();

let server: Server;
let staticRoot: string;
let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let port: number;
let deps: UiHandlerDeps;
let service: WorkspaceProvisioningService;

function noopEvidence(): EvidenceStore {
  return {
    put: (id: string): string => `/evidence/${id}.json`,
    list: (): readonly string[] => [],
    get: (): string | undefined => undefined,
    delete: (): void => undefined,
  };
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  return startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps,
  });
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

function buildService(): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    store: buildWorkspaceInstanceStoreOverDatabase(db),
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: (workspace: WorkspaceInfo) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } }),
    redactString: (s: string): string => s,
    now: (): number => Date.now(),
    newId: ((): (() => string) => {
      let n = 0;
      return (): string => `id-${String(n++)}`;
    })(),
    mutex: __twMutex,
  });
}

function baseDeps(override: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: noopEvidence(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    workspaceProvisioning: service,
    ...override,
  };
}

async function rebuild(override: Partial<UiHandlerDeps> = {}): Promise<void> {
  await closeServer();
  deps = baseDeps(override);
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-tw-static-"));
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-tw-repo-")));
  managedRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "keiko-tw-mr-"))), "task-workspaces");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@keiko.example"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoRoot });
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  service = buildService();
  deps = baseDeps();
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  resetServerLogger();
  db.close();
  await rm(staticRoot, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

interface ProvisionBody {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly created: boolean;
}

async function provision(
  taskId: string,
  baseBranch = "main",
  correlationId?: string,
): Promise<Response> {
  return fetch(`${baseUrl()}/api/task-workspaces`, {
    method: "POST",
    headers: {
      ...csrfHeaders(),
      ...(correlationId === undefined ? {} : { "X-Keiko-Correlation-Id": correlationId }),
    },
    body: JSON.stringify({ root: repoRoot, taskId, baseBranch, requestedBy: "u" }),
  });
}

describe("POST /api/task-workspaces", () => {
  async function issueHeaders(): Promise<Record<string, string>> {
    execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], {
      cwd: repoRoot,
    });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoRoot });
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: repoRoot,
    });
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    const paired = channel.pair(fakePairingRequestBody());
    if (!paired.paired) throw new Error("test pairing failed");
    await rebuild({
      codingAppSessionChannel: channel,
      env: { PATH: process.env.PATH ?? "" },
      codingContextGitHubPort: {
        readJson: (argv) =>
          Promise.resolve(
            argv[1]?.includes("comments?")
              ? [{ id: "11", body: "A bounded review comment" }]
              : {
                  id: "123",
                  nodeId: "I_issue_42",
                  state: "open",
                  isPullRequest: false,
                  title: "Fix the repository",
                  body: "Untrusted requested work",
                  comments: 1,
                  url: "https://github.com/owner/repo/issues/42",
                },
          ),
      },
    });
    deps.store.createProject(repoRoot, "selected");
    deps.store.updateGitHubIssueReaderAuthorization(deriveRepositoryId(repoRoot), true, 0);
    return { ...csrfHeaders(), Cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}` };
  }

  async function previewIssue(
    headers: Record<string, string>,
  ): Promise<CodingWorkbenchIssuePreviewResponseWire> {
    const response = await fetch(`${baseUrl()}/api/coding-workbench/issue/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repositoryPath: repoRoot, issueRef: "#42" }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as CodingWorkbenchIssuePreviewResponseWire;
  }

  it("uses the mounted preview and server default base to provision and attach issue context", async () => {
    const headers = await issueHeaders();
    const preview = await previewIssue(headers);
    expect(preview.preview.comments).toEqual(["A bounded review comment"]);
    const response = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        root: repoRoot,
        taskId: "issue-42",
        requestedBy: "u",
        source: {
          kind: "github-issue",
          issueRef: "#42",
          expectedBindingDigest: preview.binding.bindingDigest,
        },
      }),
    });
    expect(response.status).toBe(201);
    const provisioned = (await response.json()) as ProvisionBody;
    expect(provisioned.instance.baseBranch).toBe("main");
    const intake = createProductionCodingRuntimeIssueIntake(deps);
    const resolved = await intake.resolve({
      repositoryRoot: repoRoot,
      issueRef: "#42",
      correlationId: "issue-run",
    });
    if (!resolved.ok) throw new Error("expected resolved issue");
    const context = await intake.buildContext({
      repositoryRoot: repoRoot,
      binding: resolved.binding,
      runId: "issue-run",
      correlationId: "issue-run",
      effectiveMode: "supervised-coding",
    });
    expect(context.ok).toBe(true);
    if (context.ok) expect(context.attachment.text).toContain("Untrusted requested work");
  });

  it("refuses stale issue previews and caller-selected bases before provisioning", async () => {
    const headers = await issueHeaders();
    const preview = await previewIssue(headers);
    for (const payload of [
      { source: { kind: "github-issue", issueRef: "#42", expectedBindingDigest: "0".repeat(64) } },
      {
        baseBranch: "main",
        source: {
          kind: "github-issue",
          issueRef: "#42",
          expectedBindingDigest: preview.binding.bindingDigest,
        },
      },
    ]) {
      const response = await fetch(`${baseUrl()}/api/task-workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ root: repoRoot, taskId: "issue-42", requestedBy: "u", ...payload }),
      });
      expect(response.status).toBe(400);
    }
    expect(
      db.prepare("SELECT count(*) AS count FROM task_workspace_instances").get(),
    ).toMatchObject({ count: 0 });
  });

  it("requires a paired session before an issue source can read upstream or create a workspace", async () => {
    await issueHeaders();
    const port = deps.codingContextGitHubPort;
    if (port === undefined) throw new Error("missing issue fixture port");
    const read = vi.spyOn(port, "readJson");
    const response = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        root: repoRoot,
        taskId: "issue-42",
        requestedBy: "u",
        source: { kind: "github-issue", issueRef: "#42", expectedBindingDigest: "0".repeat(64) },
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "AUTHORITY_DENIED" } });
    expect(read).not.toHaveBeenCalled();
    expect(
      db.prepare("SELECT count(*) AS count FROM task_workspace_instances").get(),
    ).toMatchObject({ count: 0 });
  });

  it("preserves the closed stale-issue remedy through the provisioning failure envelope", async () => {
    const headers = await issueHeaders();
    const response = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        root: repoRoot,
        taskId: "issue-42",
        requestedBy: "u",
        source: { kind: "github-issue", issueRef: "#42", expectedBindingDigest: "0".repeat(64) },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issueBindingFailure: "issue-unavailable",
      error: { code: "INVALID_REQUEST" },
    });
    expect(
      db.prepare("SELECT count(*) AS count FROM task_workspace_instances").get(),
    ).toMatchObject({ count: 0 });
  });

  it("provisions a managed worktree and returns 201 with instance + binding", async () => {
    const res = await provision("t1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as ProvisionBody;
    expect(body.instance.lifecycleState).toBe("active");
    expect(body.binding.activeRoot).toBe(body.instance.managedWorktreePath);
    expect(body.binding.gitDeliveryRoot).toBe(body.binding.activeRoot);
  });

  it("rejects a state-changing request without the CSRF guard (403)", async () => {
    const res = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: repoRoot, taskId: "t1", baseBranch: "main", requestedBy: "u" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for a missing required field", async () => {
    const res = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ root: repoRoot, taskId: "t1" }),
    });
    expect(res.status).toBe(400);
  });

  it("logs malformed JSON before provisioning dispatch without retaining its body", async () => {
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
    const correlationId = "route-provision-malformed-json-1";
    const hostileBody = '{"taskId":"Patient Jane private';
    const res = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers: {
        ...csrfHeaders(),
        "X-Keiko-Correlation-Id": correlationId,
      },
      body: hostileBody,
    });

    expect(res.status).toBe(400);
    const events = activityLog.events.filter((event) => event.op === "task-workspace.lifecycle");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId,
      errorKind: "INVALID_REQUEST",
      extra: { operation: "provision" },
    });
    expect(activityLog.lines().join("\n")).not.toContain(hostileBody);
  });

  it("maps an invalid base branch to 400 INVALID_BASE_BRANCH", async () => {
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
    const correlationId = "route-provision-service-rejection-1";
    const res = await provision("t1", "does-not-exist", correlationId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BASE_BRANCH");
    const events = activityLog.events.filter((event) => event.op === "task-workspace.lifecycle");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId,
      errorKind: "INVALID_BASE_BRANCH",
      extra: { operation: "provision" },
    });
  });

  // #449/#1587 follow-up: the route boundary rejects control/zero-width/bidi code points in the
  // free-form identity fields before they can reach the lock owner / pointer / evidence.
  it("rejects a taskId carrying a bidi-override character (400 INVALID_REQUEST)", async () => {
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
    const taskId = `t${String.fromCodePoint(0x202e)}1`;
    const correlationId = "route-provision-invalid-1";
    const res = await provision(taskId, "main", correlationId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
    const events = activityLog.events.filter((event) => event.op === "task-workspace.lifecycle");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId,
      errorKind: "INVALID_REQUEST",
      extra: { operation: "provision" },
    });
    expect(activityLog.lines().join("\n")).not.toContain(taskId);
  });

  it("rejects a requestedBy carrying a zero-width character (400 INVALID_REQUEST)", async () => {
    const res = await fetch(`${baseUrl()}/api/task-workspaces`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        root: repoRoot,
        taskId: "t1",
        baseBranch: "main",
        requestedBy: `u${String.fromCodePoint(0x200b)}`,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 503 when provisioning is not configured", async () => {
    await rebuild({ workspaceProvisioning: undefined });
    const res = await provision("t1");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_PROVISIONING_UNAVAILABLE");
  });
});

describe("GET /api/task-workspaces/:workspaceId", () => {
  it("reads a provisioned instance back, and 404s for an unknown id", async () => {
    const created = (await (await provision("t1")).json()) as ProvisionBody;
    const ok = await fetch(`${baseUrl()}/api/task-workspaces/${created.instance.workspaceId}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { instance: WorkspaceInstance };
    expect(body.instance.workspaceId).toBe(created.instance.workspaceId);

    const missing = await fetch(`${baseUrl()}/api/task-workspaces/ws_missing`);
    expect(missing.status).toBe(404);
  });
});
