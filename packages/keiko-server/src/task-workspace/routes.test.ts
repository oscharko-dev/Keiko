// Route integration tests for /api/task-workspaces/* (Issue #445). Drives the live createUiServer
// (CSRF guard + host check run for real) against a real service over a disposable git repository, so
// the controlled server-side provisioning + activation path is exercised end-to-end over HTTP.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { createUiServer, UI_HOST } from "../server.js";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import type { WorkspaceProvisioningService } from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";

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

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
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

async function provision(taskId: string, baseBranch = "main"): Promise<Response> {
  return fetch(`${baseUrl()}/api/task-workspaces`, {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ root: repoRoot, taskId, baseBranch, requestedBy: "u" }),
  });
}

describe("POST /api/task-workspaces", () => {
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

  it("maps an invalid base branch to 400 INVALID_BASE_BRANCH", async () => {
    const res = await provision("t1", "does-not-exist");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BASE_BRANCH");
  });

  // #449/#1587 follow-up: the route boundary rejects control/zero-width/bidi code points in the
  // free-form identity fields before they can reach the lock owner / pointer / evidence.
  it("rejects a taskId carrying a bidi-override character (400 INVALID_REQUEST)", async () => {
    const res = await provision(`t${String.fromCodePoint(0x202e)}1`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
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

describe("POST /api/task-workspaces/:workspaceId/activate", () => {
  it("activates a provisioned workspace and returns its binding", async () => {
    const created = (await (await provision("t1")).json()) as ProvisionBody;
    const res = await fetch(
      `${baseUrl()}/api/task-workspaces/${created.instance.workspaceId}/activate`,
      {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ taskId: "t1", requestedBy: "u", acquireLock: false }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: WorkspaceInstance; binding: WorkspaceBinding };
    expect(body.instance.lifecycleState).toBe("active");
    expect(body.binding.activeRoot).toBe(created.instance.managedWorktreePath);
  });
});
