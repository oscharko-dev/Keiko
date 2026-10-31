import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "../index.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import type { RouteContext } from "../routes.js";
import type { UiStore } from "../store/index.js";
import { assertManagedRootOwned } from "../task-workspace/managed-root.js";
import { deriveManagedWorktreePath } from "../task-workspace/naming.js";
import { handleRuntimeCapabilities } from "./capabilityRoutes.js";
import { type HostExecutableProbe, type HostExecutableProbeResult } from "./capabilityDetector.js";
import {
  activeManagedWorkspaceProvisioning,
  buildManagedGitWorktree,
} from "../gitDelivery/_support.js";

let root: string;
let managedSourceRoot: string | undefined;
let store: UiStore;

class EmptyProbe implements HostExecutableProbe {
  public probe(): HostExecutableProbeResult {
    return { state: "missing" as const, unavailableReason: "executable-not-found" as const };
  }
}

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
    ...overrides,
  };
}

function ctx(path: string, cookie?: string): RouteContext {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.headers = cookie === undefined ? {} : { cookie };
  return {
    correlationId: undefined,
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keiko-runtime-route-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "npm@11.16.0", scripts: { test: "node should-not-run.js" } }),
    "utf8",
  );
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
  managedSourceRoot = undefined;
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
  if (managedSourceRoot !== undefined) {
    await rm(managedSourceRoot, { recursive: true, force: true });
  }
});

describe("GET /api/runtime/capabilities", () => {
  it("returns host capabilities without a root and no absolute workspace path", async () => {
    const result = await handleRuntimeCapabilities(ctx("/api/runtime/capabilities"), deps(), {
      probe: new EmptyProbe(),
      now: () => 0,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ schemaVersion: "1" });
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("returns registered-root command sources with relative paths only", async () => {
    const result = await handleRuntimeCapabilities(
      ctx(`/api/runtime/capabilities?root=${encodeURIComponent(root)}`),
      deps(),
      { probe: new EmptyProbe(), specs: [], now: () => 0 },
    );

    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain('"path":"package.json"');
    expect(serialized).toContain('"scriptName":"test"');
    expect(serialized).not.toContain("should-not-run");
    expect(serialized).not.toContain(root);
  });

  it("rejects unregistered roots through the existing files route error envelope", async () => {
    const other = await mkdtemp(join(tmpdir(), "keiko-runtime-route-other-"));
    try {
      const result = await handleRuntimeCapabilities(
        ctx(`/api/runtime/capabilities?root=${encodeURIComponent(other)}`),
        deps(),
        { probe: new EmptyProbe(), specs: [], now: () => 0 },
      );

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("admits only launcher-paired, persisted managed task worktrees", async (): Promise<void> => {
    // Production managed worktrees live below `.keiko`, which ordinary workspace admission denies.
    // The paired request must therefore carry its request-scoped owned-root filesystem all the way
    // through manifest discovery; a route that falls back to the node filesystem fails this proof.
    const managedRoot = join(root, ".keiko", "managed-task-workspaces");
    assertManagedRootOwned(managedRoot);
    const repositoryId = "repo_0123456789abcdef";
    const workspaceId = "ws_0123456789abcdef01234567";
    const managedWorktree = deriveManagedWorktreePath({
      managedRoot,
      repositoryId,
      workspaceId,
    });
    // #3347 managed-worktree identity: resolveManagedWorkspaceRootAccess re-proves a real Git
    // linked-worktree pointer instead of trusting a path shape, so this fixture needs an actual
    // `git worktree add` linkage -- a dedicated repositoryRoot (tracked in managedSourceRoot and
    // cleaned up by afterEach below), not the shared `root` fixture.
    const repositoryRoot = await mkdtemp(join(tmpdir(), "keiko-runtime-route-managed-source-"));
    managedSourceRoot = repositoryRoot;
    const gitdirIdentity = buildManagedGitWorktree(
      repositoryRoot,
      managedWorktree,
      "keiko/task/runtime-capabilities-01234567",
    );
    await writeFile(join(managedWorktree, "package.json"), '{"name":"managed-fixture"}\n');
    const workspaceProvisioning = activeManagedWorkspaceProvisioning({
      workspaceId,
      taskId: "runtime-capabilities",
      repositoryId,
      repositoryRoot,
      taskBranch: "keiko/task/runtime-capabilities-01234567",
      managedWorktreePath: managedWorktree,
      gitdirIdentity,
      auditCorrelationId: "corr_runtime_capabilities",
    });
    const codingAppSessionChannel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    const paired = codingAppSessionChannel.pair(fakePairingRequestBody());
    if (!paired.paired) throw new Error("pairing failed");
    const managedDeps = deps({
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning,
      codingAppSessionChannel,
    });
    const path = `/api/runtime/capabilities?root=${encodeURIComponent(managedWorktree)}`;

    const unpaired = await handleRuntimeCapabilities(ctx(path), managedDeps, {
      probe: new EmptyProbe(),
      specs: [],
      now: () => 0,
    });
    const pairedResult = await handleRuntimeCapabilities(
      ctx(path, `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`),
      managedDeps,
      { probe: new EmptyProbe(), specs: [], now: () => 0 },
    );

    expect(unpaired).toMatchObject({
      status: 403,
      body: { error: { code: "WORKSPACE_NOT_REGISTERED" } },
    });
    expect(pairedResult.status).toBe(200);
    expect(JSON.stringify(pairedResult.body)).toContain('"path":"package.json"');
  });
});
