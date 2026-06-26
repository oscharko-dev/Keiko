// Route integration tests for the #448 health + governed-cleanup endpoints. Drives the live
// createUiServer (real CSRF guard + host check) against real services over a disposable git repository:
// GET health (read-only report), POST cleanup (request + complete, CSRF-gated, operator-approval), and
// POST cleanup/orphans. Also proves the 503 degrade-when-unconfigured and 403 CSRF-missing paths.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorkspaceHealthReport,
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
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceHealthService } from "./health.js";
import { createWorkspaceCleanupService } from "./cleanup.js";
import type {
  WorkspaceCleanupService,
  WorkspaceHealthService,
  WorkspaceProvisioningService,
} from "./types.js";

let server: Server;
let staticRoot: string;
let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let port: number;
let deps: UiHandlerDeps;
let store: WorkspaceInstanceStore;
let provisioning: WorkspaceProvisioningService;
let healthService: WorkspaceHealthService;
let cleanupService: WorkspaceCleanupService;
let idCounter: number;

function noopEvidence(): EvidenceStore {
  return {
    put: (id: string): string => `/evidence/${id}.json`,
    list: (): readonly string[] => [],
    get: (): string | undefined => undefined,
    delete: (): void => undefined,
  };
}

function realAdapter(workspace: WorkspaceInfo): ReturnType<typeof createNodeGitWorktreeAdapter> {
  return createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
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

function buildServices(): void {
  store = buildWorkspaceInstanceStoreOverDatabase(db);
  const pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  const common = {
    store,
    activePointerStore: pointerStore,
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => Date.now(),
    newId: (): string => `id-${String(idCounter++)}`,
  };
  provisioning = createWorkspaceProvisioningService(common);
  healthService = createWorkspaceHealthService(common);
  cleanupService = createWorkspaceCleanupService(common);
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
    workspaceProvisioning: provisioning,
    workspaceHealth: healthService,
    workspaceCleanup: cleanupService,
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

async function provision(taskId: string): Promise<WorkspaceInstance> {
  const res = await fetch(`${baseUrl()}/api/task-workspaces`, {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ root: repoRoot, taskId, baseBranch: "main", requestedBy: "u" }),
  });
  const body = (await res.json()) as { instance: WorkspaceInstance };
  return body.instance;
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-hc-static-"));
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-hc-repo-")));
  managedRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "keiko-hc-mr-"))), "task-workspaces");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@keiko.example"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoRoot });
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  idCounter = 0;
  buildServices();
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

describe("GET /api/task-workspaces/health", () => {
  it("returns a content-free operational health report", async () => {
    const instance = await provision("t1");
    const res = await fetch(
      `${baseUrl()}/api/task-workspaces/health?root=${encodeURIComponent(repoRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: WorkspaceHealthReport };
    const entry = body.report.entries.find(
      (e) => e.kind === "instance" && e.workspaceId === instance.workspaceId,
    );
    expect(entry?.classification).toBe("healthy");
    expect(JSON.stringify(body)).not.toContain(repoRoot);
  });

  it("returns 503 when health is not configured", async () => {
    await rebuild({ workspaceHealth: undefined });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/health`);
    expect(res.status).toBe(503);
  });
});

describe("POST /api/task-workspaces/:workspaceId/cleanup", () => {
  it("requests then completes a governed cleanup (CSRF + operator approval)", async () => {
    const instance = await provision("t1");
    // settle to archived so it is cleanup-eligible
    const persisted = store.getById(instance.workspaceId);
    if (persisted === undefined) throw new Error("provisioned instance missing");
    store.upsert({ ...persisted, lifecycleState: "archived" });

    const requested = await fetch(
      `${baseUrl()}/api/task-workspaces/${instance.workspaceId}/cleanup`,
      {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ requestedBy: "u", operatorApproved: true, mode: "request" }),
      },
    );
    expect(requested.status).toBe(200);
    expect(((await requested.json()) as { outcome: string }).outcome).toBe("requested");

    const completed = await fetch(
      `${baseUrl()}/api/task-workspaces/${instance.workspaceId}/cleanup`,
      {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ requestedBy: "u", operatorApproved: true, mode: "complete" }),
      },
    );
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as { outcome: string }).outcome).toBe("completed");
    expect(existsSync(instance.managedWorktreePath)).toBe(false);
    expect(store.getById(instance.workspaceId)).toBeUndefined();
  });

  it("rejects cleanup without the CSRF guard (403)", async () => {
    const instance = await provision("t1");
    const res = await fetch(`${baseUrl()}/api/task-workspaces/${instance.workspaceId}/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedBy: "u", operatorApproved: true, mode: "request" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid mode (400)", async () => {
    const instance = await provision("t1");
    const res = await fetch(`${baseUrl()}/api/task-workspaces/${instance.workspaceId}/cleanup`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ requestedBy: "u", operatorApproved: true, mode: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/task-workspaces/cleanup/orphans", () => {
  it("removes an orphaned managed worktree", async () => {
    const instance = await provision("t1");
    store.delete(instance.workspaceId);
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
    const res = await fetch(`${baseUrl()}/api/task-workspaces/cleanup/orphans`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ root: repoRoot, requestedBy: "u", operatorApproved: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number; refused: unknown[] };
    expect(body.removed).toBe(1);
    expect(existsSync(instance.managedWorktreePath)).toBe(false);
  });

  it("returns 503 when cleanup is not configured", async () => {
    await rebuild({ workspaceCleanup: undefined });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/cleanup/orphans`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ requestedBy: "u", operatorApproved: true }),
    });
    expect(res.status).toBe(503);
  });
});
