// Route integration tests for the #446 active-binding routes. Drives the live createUiServer (CSRF +
// host check run for real) against the real lifecycle service composed over the real instance +
// active-pointer stores and a real provisioning service against a disposable git repository, so the
// shared-binding switch / pause / resume / handoff / clear paths are exercised end-to-end over HTTP.

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
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceLifecycleService } from "./lifecycle.js";
import type { WorkspaceLifecycleService, WorkspaceProvisioningService } from "./types.js";

let server: Server;
let staticRoot: string;
let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let port: number;
let deps: UiHandlerDeps;
let provisioning: WorkspaceProvisioningService;
let lifecycle: WorkspaceLifecycleService;

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

function buildServices(): void {
  const store = buildWorkspaceInstanceStoreOverDatabase(db);
  const pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  let n = 0;
  const newId = (): string => `id-${String(n++)}`;
  provisioning = createWorkspaceProvisioningService({
    store,
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: (workspace: WorkspaceInfo) =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } }),
    redactString: (s: string): string => s,
    now: (): number => Date.now(),
    newId,
  });
  lifecycle = createWorkspaceLifecycleService({
    store,
    activePointerStore: pointerStore,
    provisioning,
    evidenceStore: noopEvidence(),
    redactString: (s: string): string => s,
    now: (): number => Date.now(),
    newId,
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
    workspaceProvisioning: provisioning,
    workspaceLifecycle: lifecycle,
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

interface ActiveBody {
  readonly active: {
    readonly instance: WorkspaceInstance;
    readonly binding: WorkspaceBinding;
    readonly pointer: { readonly workspaceId: string };
  } | null;
}

async function getActive(): Promise<ActiveBody> {
  const res = await fetch(`${baseUrl()}/api/task-workspaces/active`);
  expect(res.status).toBe(200);
  return (await res.json()) as ActiveBody;
}

async function setActive(workspaceId: string, headers = csrfHeaders()): Promise<Response> {
  return fetch(`${baseUrl()}/api/task-workspaces/active`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspaceId, requestedBy: "u" }),
  });
}

async function action(
  workspaceId: string,
  verb: "pause" | "resume" | "handoff",
): Promise<Response> {
  return fetch(`${baseUrl()}/api/task-workspaces/${workspaceId}/${verb}`, {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ requestedBy: "u" }),
  });
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-twb-static-"));
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-twb-repo-")));
  managedRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "keiko-twb-mr-"))), "task-workspaces");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@keiko.example"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoRoot });
  db = new DatabaseSync(":memory:");
  runMigrations(db);
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

describe("active binding lifecycle over HTTP", () => {
  it("lists provisioned workspaces for a repository root", async () => {
    await provision("t1");
    await provision("t2");
    const res = await fetch(
      `${baseUrl()}/api/task-workspaces?root=${encodeURIComponent(repoRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instances: readonly WorkspaceInstance[] };
    expect(body.instances).toHaveLength(2);
  });

  it("getActive is null before any switch (unbound mode)", async () => {
    const body = await getActive();
    expect(body.active).toBeNull();
  });

  it("switch sets the active binding; the literal `active` route wins over :workspaceId", async () => {
    const instance = await provision("t1");
    const res = await setActive(instance.workspaceId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { binding: WorkspaceBinding };
    expect(body.binding.activeRoot).toBe(instance.managedWorktreePath);
    const active = await getActive();
    expect(active.active?.pointer.workspaceId).toBe(instance.workspaceId);
  });

  it("pause clears the active pointer, resume re-binds it", async () => {
    const instance = await provision("t1");
    await setActive(instance.workspaceId);
    const paused = await action(instance.workspaceId, "pause");
    expect(paused.status).toBe(200);
    expect((await getActive()).active).toBeNull();
    const resumed = await action(instance.workspaceId, "resume");
    expect(resumed.status).toBe(200);
    expect((await getActive()).active?.pointer.workspaceId).toBe(instance.workspaceId);
  });

  it("handoff moves a clean workspace to handoff-ready and keeps the pointer", async () => {
    const instance = await provision("t1");
    await setActive(instance.workspaceId);
    const res = await action(instance.workspaceId, "handoff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: WorkspaceInstance };
    expect(body.instance.lifecycleState).toBe("handoff-ready");
    expect((await getActive()).active?.pointer.workspaceId).toBe(instance.workspaceId);
  });

  it("DELETE clears the active binding", async () => {
    const instance = await provision("t1");
    await setActive(instance.workspaceId);
    const res = await fetch(`${baseUrl()}/api/task-workspaces/active`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(200);
    expect((await getActive()).active).toBeNull();
  });

  it("rejects a switch without the CSRF guard (403)", async () => {
    const instance = await provision("t1");
    const res = await setActive(instance.workspaceId, { "Content-Type": "application/json" });
    expect(res.status).toBe(403);
  });

  it("returns 503 when the lifecycle service is not configured", async () => {
    await rebuild({ workspaceLifecycle: undefined });
    const raw = await fetch(`${baseUrl()}/api/task-workspaces/active`);
    expect(raw.status).toBe(503);
    const body = (await raw.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_PROVISIONING_UNAVAILABLE");
  });
});
