import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
import type { RouteContext } from "./routes.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import {
  handleGitDiff,
  handleGitStatus,
  type GitProcessResult,
  type GitProcessRunner,
} from "./gitRoutes.js";
import { handleGitHistory, handleGitSummary } from "./gitRepositoryReads.js";
import { deriveManagedWorktreePath } from "./task-workspace/naming.js";
import type { WorkspaceProvisioningService } from "./task-workspace/types.js";

const REPOSITORY_ID = "repo_0123456789abcdef";
const WORKSPACE_ID = "ws_0123456789abcdef01234567";
let root: string;
let managedRoot: string;
let managedWorktree: string;
let instance: WorkspaceInstance;

function ok(stdout: string): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function route(path: string, cookie?: string): RouteContext {
  return {
    req: mockRequest({ headers: cookie === undefined ? {} : { cookie } }),
    res: mockResponse().res,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

function provisioningStub(): WorkspaceProvisioningService {
  return {
    provision: (): never => {
      throw new Error("not used in this test");
    },
    activate: (): never => {
      throw new Error("not used in this test");
    },
    getInstance: (workspaceId): WorkspaceInstance | undefined =>
      workspaceId === WORKSPACE_ID ? instance : undefined,
  };
}

function deps(runner: GitProcessRunner): UiHandlerDeps {
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
    workspaceProvisioning: provisioningStub(),
    codingAppSessionChannel: createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    }),
    gitRouteOptions: { runner, maxDiffBytes: 4_096, maxStatusBytes: 4_096, maxChanges: 20 },
  };
}

function pair(dependencies: UiHandlerDeps): string {
  const paired = dependencies.codingAppSessionChannel?.pair(fakePairingRequestBody());
  if (paired?.paired !== true) throw new Error("pairing failed");
  return `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keiko-managed-git-auth-"));
  const managedStorage = join(root, "managed-storage");
  managedRoot = join(root, "managed");
  managedWorktree = deriveManagedWorktreePath({
    managedRoot,
    repositoryId: REPOSITORY_ID,
    workspaceId: WORKSPACE_ID,
  });
  await mkdir(join(managedStorage, REPOSITORY_ID, WORKSPACE_ID), { recursive: true });
  await symlink(managedStorage, managedRoot, "dir");
  const now = new Date(0).toISOString();
  instance = {
    schemaVersion: "1",
    workspaceId: WORKSPACE_ID,
    taskId: "managed-git-auth",
    repositoryId: REPOSITORY_ID,
    repositoryRoot: root,
    baseBranch: "dev",
    taskBranch: "keiko/task/managed-git-auth-01234567",
    managedWorktreePath: managedWorktree,
    gitdirIdentity: "gitdir-identity",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: now,
    updatedAt: now,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "corr_managed_git_auth",
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("managed task-worktree Git read authorization (#2482)", () => {
  it("returns a content-free status before executing Git for an unpaired managed root", async () => {
    const runner = vi.fn<GitProcessRunner>();
    const dependencies = deps(runner);
    const request = route(`/api/git/status?root=${encodeURIComponent(managedWorktree)}`);

    const result = await handleGitStatus(request, dependencies);
    const history = await handleGitHistory(
      route(`/api/git/history?root=${encodeURIComponent(managedWorktree)}&limit=1`),
      dependencies,
    );

    expect(result).toMatchObject({
      status: 200,
      body: { available: false, changes: [], stagedCount: 0, unstagedCount: 0 },
    });
    expect(history).toMatchObject({ status: 200, body: { available: false, entries: [] } });
    expect(runner).not.toHaveBeenCalled();
  });

  it("answers a NON-EXISTENT managed path exactly like an existing one, so it is no existence oracle", async () => {
    // The gate used to run after path resolution: a missing directory threw a 400 while an existing
    // one returned the content-free projection, letting an unpaired caller probe which managed
    // worktree paths exist. Both must now be indistinguishable.
    const runner = vi.fn<GitProcessRunner>();
    const dependencies = deps(runner);
    const missing = `${managedWorktree}/does-not-exist-${String(Date.now())}`;

    const existing = await handleGitStatus(
      route(`/api/git/status?root=${encodeURIComponent(managedWorktree)}`),
      dependencies,
    );
    const absent = await handleGitStatus(
      route(`/api/git/status?root=${encodeURIComponent(missing)}`),
      dependencies,
    );

    expect(absent.status).toBe(existing.status);
    expect((absent.body as { available?: boolean }).available).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns no diff to forged or revoked sessions and never executes Git", async () => {
    const runner = vi.fn<GitProcessRunner>();
    const dependencies = deps(runner);
    const validCookie = pair(dependencies);
    dependencies.codingAppSessionChannel?.signOut(validCookie.slice(validCookie.indexOf("=") + 1));
    const forgedCookie = `${APP_SESSION_COOKIE_NAME}=sess_000000000000000000000000.forged`;

    for (const cookie of [validCookie, forgedCookie]) {
      const result = await handleGitDiff(
        route(
          `/api/git/diff?root=${encodeURIComponent(managedWorktree)}&path=src%2Fsecret.ts&scope=all`,
          cookie,
        ),
        dependencies,
      );
      expect(result).toMatchObject({ status: 200, body: { available: false, diff: "" } });
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("authorizes a paired managed-root read through the existing bounded Git route", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${managedWorktree}\n`))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("diff --git a/src/value.ts b/src/value.ts\n-old\n+new\n"));
    const dependencies = deps(runner);
    const result = await handleGitDiff(
      route(
        `/api/git/diff?root=${encodeURIComponent(managedWorktree)}&path=src%2Fvalue.ts&scope=all`,
        pair(dependencies),
      ),
      dependencies,
    );

    expect(result).toMatchObject({
      status: 200,
      body: { available: true },
    });
    expect(JSON.stringify(result.body)).toContain("+new");
  });

  it("classifies an outside symlink alias by resolved root so it cannot bypass the gate", async () => {
    const alias = join(root, "managed-alias");
    await symlink(managedWorktree, alias, "dir");
    const runner = vi.fn<GitProcessRunner>();
    const result = await handleGitDiff(
      route(`/api/git/diff?root=${encodeURIComponent(alias)}&scope=all`),
      deps(runner),
    );

    expect(result).toMatchObject({ status: 200, body: { available: false, diff: "" } });
    expect(runner).not.toHaveBeenCalled();
  });

  // Regression harness for issue #2640. The runner dispatches on the git subcommand rather than
  // positional call order so behavior-preserving refactors of handleGitSummary's internal call
  // sequence do not silently break these tests, and it throws on any unexpected argument list so
  // future runner calls fail loudly rather than being fabricated with a silent empty payload.
  function summaryRunner(): ReturnType<typeof vi.fn<GitProcessRunner>> {
    return vi.fn<GitProcessRunner>((args) => {
      if (args.includes("--show-toplevel")) return Promise.resolve(ok(`${managedWorktree}\n`));
      if (args.includes("--porcelain=v2")) {
        return Promise.resolve(ok("# branch.head main\0# branch.ab +0 -0\0"));
      }
      if (args.includes("--git-path")) return Promise.resolve(ok(""));
      if (args.includes("remote")) return Promise.resolve(ok(""));
      throw new Error(`unexpected git argv: ${args.join(" ")}`);
    });
  }

  it("never serves a paired caller's cached /api/git/summary to an unpaired caller (#2640)", async (): Promise<void> => {
    // Regression: the summary response cache used to key only on the raw `root` query value and the
    // runner options, not on the app-session read authority. A paired caller populated the entry
    // and, within the 2s TTL, an unpaired caller received the paired projection instead of the
    // content-free unavailable one. The cache MUST partition by session so cross-session leakage
    // is impossible without weakening the unpaired-caller answer.
    const runner = summaryRunner();
    const dependencies = deps(runner);
    const path = `/api/git/summary?root=${encodeURIComponent(managedWorktree)}`;

    const paired = await handleGitSummary(route(path, pair(dependencies)), dependencies);
    const runnerCallsAfterPaired = runner.mock.calls.length;
    const unpaired = await handleGitSummary(route(path), dependencies);

    expect(paired).toMatchObject({ status: 200, body: { available: true, branch: "main" } });
    expect(unpaired).toMatchObject({
      status: 200,
      body: { available: false, remotes: [], stagedCount: 0, unstagedCount: 0 },
    });
    expect(unpaired.body).not.toHaveProperty("branch");
    // The unpaired call must not have invoked the runner at all (either via cache-hit under the
    // leak, or via resolveRepository's short-circuit under the fix). This bonus signal guards
    // future refactors that might unwire the short-circuit path.
    expect(runner.mock.calls).toHaveLength(runnerCallsAfterPaired);
  });

  it("never lets an unpaired caller's cached content-free summary suppress a paired caller (#2640)", async (): Promise<void> => {
    // Reverse direction of the partitioning invariant: the unpaired cache entry (populated first)
    // must not swallow a paired caller's real projection within the TTL. Under the fix the two
    // sessions occupy separate keys so the paired call computes its own summary; under a bug that
    // ever inverted the partitioning (e.g. an "always-use-empty-session-slot" refactor) the paired
    // caller would receive the unpaired content-free entry and this test would fail.
    const runner = summaryRunner();
    const dependencies = deps(runner);
    const path = `/api/git/summary?root=${encodeURIComponent(managedWorktree)}`;

    const unpaired = await handleGitSummary(route(path), dependencies);
    const runnerCallsAfterUnpaired = runner.mock.calls.length;
    const paired = await handleGitSummary(route(path, pair(dependencies)), dependencies);

    expect(unpaired).toMatchObject({ status: 200, body: { available: false, remotes: [] } });
    expect(paired).toMatchObject({ status: 200, body: { available: true, branch: "main" } });
    expect(runner.mock.calls.length).toBeGreaterThan(runnerCallsAfterUnpaired);
  });

  it("leaves ordinary roots on the existing unauthenticated generic Git posture", async () => {
    const ordinaryRoot = join(root, "ordinary");
    await mkdir(ordinaryRoot);
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${ordinaryRoot}\n`))
      .mockResolvedValueOnce(ok("## main\0 M src/value.ts\0"));
    const result = await handleGitStatus(
      route(`/api/git/status?root=${encodeURIComponent(ordinaryRoot)}`),
      deps(runner),
    );

    expect(result).toMatchObject({ status: 200, body: { available: true, unstagedCount: 1 } });
  });
});
