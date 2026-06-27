// Route integration tests for the #447 reconciliation + repair endpoints. Drives the live
// createUiServer (real CSRF guard + host check) against real services over a disposable git
// repository: GET (read-only report), POST reconciliation (live pass, CSRF-gated), and POST repair
// (controlled, operator-approval-gated). Also proves the 503 degrade-when-unconfigured path.

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
  WorkspaceInfo,
  WorkspaceInstance,
  WorkspaceReconciliationReport,
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
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import { createWorkspaceRepairService } from "./repair.js";
import type {
  WorkspaceProvisioningService,
  WorkspaceReconciliationService,
  WorkspaceRepairService,
} from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";

const __twMutex = createWorkspaceMutexRegistry();

let server: Server;
let staticRoot: string;
let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let port: number;
let deps: UiHandlerDeps;
let store: WorkspaceInstanceStore;
let provisioning: WorkspaceProvisioningService;
let reconciliation: WorkspaceReconciliationService;
let repair: WorkspaceRepairService;

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

let idCounter: number;

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
    mutex: __twMutex,
  };
  provisioning = createWorkspaceProvisioningService(common);
  reconciliation = createWorkspaceReconciliationService(common);
  repair = createWorkspaceRepairService({ ...common, provisioning });
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
    workspaceReconciliation: reconciliation,
    workspaceRepair: repair,
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
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-recon-static-"));
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-recon-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-recon-mr-"))),
    "task-workspaces",
  );
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

describe("GET /api/task-workspaces/reconciliation", () => {
  it("returns a read-only stored-derived report", async () => {
    await provision("t1");
    const res = await fetch(
      `${baseUrl()}/api/task-workspaces/reconciliation?root=${encodeURIComponent(repoRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: WorkspaceReconciliationReport };
    expect(body.report.entries).toHaveLength(1);
    expect(body.report.entries[0]?.status).toBe("healthy");
  });

  it("returns 503 when reconciliation is not configured", async () => {
    await rebuild({ workspaceReconciliation: undefined });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/reconciliation`);
    expect(res.status).toBe(503);
  });
});

describe("POST /api/task-workspaces/reconciliation", () => {
  it("runs a live reconcile and surfaces a deleted worktree as missing", async () => {
    const instance = await provision("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/reconciliation`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ root: repoRoot }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: WorkspaceReconciliationReport };
    const entry = body.report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(entry?.status).toBe("missing");
  });

  it("rejects the live reconcile without the CSRF guard (403)", async () => {
    const res = await fetch(`${baseUrl()}/api/task-workspaces/reconciliation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: repoRoot }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a malformed present optional root instead of reconciling every repository", async () => {
    const res = await fetch(`${baseUrl()}/api/task-workspaces/reconciliation`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ root: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("POST /api/task-workspaces/:workspaceId/repair", () => {
  it("repairs a missing worktree when operator-approved", async () => {
    const instance = await provision("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/${instance.workspaceId}/repair`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        requestedBy: "u",
        strategy: "recreate-worktree",
        operatorApproved: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; status: string };
    expect(body.applied).toBe(true);
    expect(body.status).toBe("healthy");
  });

  it("returns 403 OPERATOR_APPROVAL_REQUIRED without approval", async () => {
    const instance = await provision("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/${instance.workspaceId}/repair`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        requestedBy: "u",
        strategy: "recreate-worktree",
        operatorApproved: false,
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OPERATOR_APPROVAL_REQUIRED");
  });

  it("rejects repair without the CSRF guard (403)", async () => {
    const instance = await provision("t1");
    const res = await fetch(`${baseUrl()}/api/task-workspaces/${instance.workspaceId}/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestedBy: "u",
        strategy: "recreate-worktree",
        operatorApproved: true,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 503 when repair is not configured", async () => {
    await rebuild({ workspaceRepair: undefined });
    const res = await fetch(`${baseUrl()}/api/task-workspaces/ws_x/repair`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        requestedBy: "u",
        strategy: "recreate-worktree",
        operatorApproved: true,
      }),
    });
    expect(res.status).toBe(503);
  });
});
