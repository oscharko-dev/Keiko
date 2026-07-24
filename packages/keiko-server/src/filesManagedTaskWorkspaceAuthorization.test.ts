import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { mockRequest, mockResponse } from "./_support.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { handleFilesContent, handleFilesTree, type FilesTreeResponse } from "./files.js";
import type { RouteContext } from "./routes.js";
import { deriveManagedWorktreePath } from "./task-workspace/naming.js";
import type { WorkspaceProvisioningService } from "./task-workspace/types.js";

const REPOSITORY_ID = "repo_0123456789abcdef";
const WORKSPACE_ID = "ws_0123456789abcdef01234567";

let fixtureRoot: string;
let managedRoot: string;
let managedWorktree: string;
let instance: WorkspaceInstance;
let dependencies: UiHandlerDeps;

function route(path: string, cookie?: string): RouteContext {
  return {
    req: mockRequest({ headers: cookie === undefined ? {} : { cookie } }),
    res: mockResponse().res,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

function provisioningStub(
  getInstance: WorkspaceProvisioningService["getInstance"],
): WorkspaceProvisioningService {
  return {
    provision: (): never => {
      throw new Error("not used in this test");
    },
    activate: (): never => {
      throw new Error("not used in this test");
    },
    getInstance,
  };
}

function createDependencies(
  getInstance: WorkspaceProvisioningService["getInstance"] = (workspaceId) =>
    workspaceId === WORKSPACE_ID ? instance : undefined,
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    managedTaskWorkspaceRoot: managedRoot,
    workspaceProvisioning: provisioningStub(getInstance),
    codingAppSessionChannel: createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    }),
  };
}

function pair(): string {
  const paired = dependencies.codingAppSessionChannel?.pair(fakePairingRequestBody());
  if (paired?.paired !== true) throw new Error("pairing failed");
  return `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
}

function treePath(root: string, path = ""): string {
  return `/api/files/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}

function contentPath(path: string): string {
  return `/api/files/content?root=${encodeURIComponent(managedWorktree)}&path=${encodeURIComponent(path)}`;
}

beforeEach(async (): Promise<void> => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "keiko-files-managed-auth-"));
  managedRoot = join(fixtureRoot, "managed", "task-workspaces");
  managedWorktree = deriveManagedWorktreePath({
    managedRoot,
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
  });
  await mkdir(join(managedWorktree, "src"), { recursive: true });
  await writeFile(join(managedWorktree, "src", "app.ts"), 'export const status = "ready";\n');
  await writeFile(join(managedWorktree, ".env"), "TEST_SECRET=must-not-leak\n");
  const now = new Date(0).toISOString();
  instance = {
    schemaVersion: "1",
    workspaceId: WORKSPACE_ID,
    taskId: "files-managed-auth",
    repositoryId: REPOSITORY_ID,
    repositoryRoot: fixtureRoot,
    baseBranch: "dev",
    taskBranch: "keiko/task/files-managed-auth-01234567",
    managedWorktreePath: managedWorktree,
    gitdirIdentity: "gitdir-identity",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: now,
    updatedAt: now,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "corr_files_managed_auth",
  };
  dependencies = createDependencies();
});

afterEach(async (): Promise<void> => {
  dependencies.store.close();
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("managed task-workspace Files authorization", (): void => {
  it("denies existing and absent managed roots identically before consulting persistence", async (): Promise<void> => {
    const getInstance = vi.fn<WorkspaceProvisioningService["getInstance"]>();
    dependencies.store.close();
    dependencies = createDependencies(getInstance);
    const missing = deriveManagedWorktreePath({
      managedRoot,
      repositoryId: REPOSITORY_ID,
      workspaceId: "ws_ffffffffffffffffffffffff",
    });

    const existing = await handleFilesTree(route(treePath(managedWorktree)), dependencies);
    const absent = await handleFilesTree(route(treePath(missing)), dependencies);

    expect(existing).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
    expect(absent).toEqual(existing);
    expect(getInstance).not.toHaveBeenCalled();
  });

  it("denies an unpaired symlink alias that resolves into a managed workspace", async (): Promise<void> => {
    const aliasRoot = join(fixtureRoot, "managed-workspace-alias");
    await symlink(managedWorktree, aliasRoot, "dir");

    const direct = await handleFilesTree(route(treePath(managedWorktree)), dependencies);
    const aliased = await handleFilesTree(route(treePath(aliasRoot)), dependencies);

    expect(aliased).toEqual(direct);
    expect(aliased).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
  });

  it("denies an ordinary root that encloses the managed workspace boundary", async (): Promise<void> => {
    const result = await handleFilesTree(route(treePath(fixtureRoot)), dependencies);

    expect(result).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
  });

  it("fails closed when managed-root containment cannot be canonicalized", async (): Promise<void> => {
    dependencies = {
      ...dependencies,
      managedTaskWorkspaceRoot: join(fixtureRoot, "missing-managed-root"),
    };

    const result = await handleFilesTree(route(treePath(fixtureRoot)), dependencies);

    expect(result).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
  });

  it("allows a paired session to browse and read only its persisted managed workspace", async (): Promise<void> => {
    const cookie = pair();

    const tree = await handleFilesTree(route(treePath(managedWorktree), cookie), dependencies);
    const content = await handleFilesContent(
      route(contentPath("src/app.ts"), cookie),
      dependencies,
    );
    const deniedSecret = await handleFilesContent(route(contentPath(".env"), cookie), dependencies);

    expect(tree.status).toBe(200);
    expect((tree.body as FilesTreeResponse).entries.map((entry) => entry.name)).toContain("src");
    expect((tree.body as FilesTreeResponse).entries.map((entry) => entry.name)).not.toContain(
      ".env",
    );
    expect(content).toMatchObject({
      status: 200,
      body: { path: "src/app.ts", content: 'export const status = "ready";\n' },
    });
    expect(deniedSecret).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
  });

  it("denies a paired session when the workspace path is not backed by persisted identity", async (): Promise<void> => {
    const forged = deriveManagedWorktreePath({
      managedRoot,
      repositoryId: REPOSITORY_ID,
      workspaceId: "ws_ffffffffffffffffffffffff",
    });
    await mkdir(forged, { recursive: true });

    const result = await handleFilesTree(route(treePath(forged), pair()), dependencies);

    expect(result).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
  });
});
