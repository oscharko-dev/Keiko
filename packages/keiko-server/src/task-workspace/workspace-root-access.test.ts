import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  PathDeniedError,
  resolveExistingAllowedWorkspaceRealRoot,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  retrieveConnectedContextPack,
  runGroundedExploration,
  type GroundedAnswerer,
  type OrchestratorInput,
} from "../grounded-orchestrator.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
} from "../observability/index.js";
import { createInMemoryUiStore } from "../store/index.js";
import { assertManagedRootOwned } from "./managed-root.js";
import { inspectManagedGitdirIdentity, parseGitdirPointerTarget } from "./gitdir-identity.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  MANAGED_ROOT_MARKER_FILENAME,
} from "./naming.js";
import type { WorkspaceProvisioningService } from "./types.js";
import {
  requiresConfiguredManagedWorkspaceAuthority,
  resolveLifecycleManagedWorkspaceRootAccess,
  resolveManagedTaskWorkspaceRoot,
  resolveManagedWorkspaceRootAccess,
  resolveRegisteredOrManagedWorkspaceRoot,
  type WorkspaceRootAccess,
} from "./workspace-root-access.js";

const WORKSPACE_ID = "ws_0123456789abcdef01234567";
const TASK_BRANCH = "keiko/task/owned-root-access-01234567";
const NOW = 1_700_000_000_000;

const ANSWERER_NOT_USED: GroundedAnswerer = {
  answer: (): Promise<string> => Promise.reject(new Error("answerer must not run")),
};

let base: string;
let managedRoot: string;
let workspaceRoot: string;
let repositoryRoot: string;
let repositoryId: string;
let registered: WorkspaceInstance | undefined;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repositoryRoot, encoding: "utf8" });
}

function currentIdentity(root: string): string {
  const inspection = inspectManagedGitdirIdentity(root, repositoryRoot);
  if (inspection === undefined) throw new Error("real linked-worktree identity was not resolved");
  return inspection.identity;
}

function instanceAt(root: string, gitdirIdentity = currentIdentity(root)): WorkspaceInstance {
  const now = new Date(0).toISOString();
  return {
    schemaVersion: "1",
    workspaceId: WORKSPACE_ID,
    taskId: "owned-root-access",
    repositoryId,
    repositoryRoot,
    baseBranch: "dev",
    taskBranch: TASK_BRANCH,
    managedWorktreePath: root,
    gitdirIdentity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: now,
    updatedAt: now,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "corr_owned_root_access",
  };
}

function provisioning(): WorkspaceProvisioningService {
  return {
    provision: (): never => {
      throw new Error("not used in this test");
    },
    activate: (): never => {
      throw new Error("not used in this test");
    },
    getInstance: (workspaceId): WorkspaceInstance | undefined =>
      registered?.workspaceId === workspaceId ? registered : undefined,
  };
}

function resolveAccess(root = workspaceRoot): WorkspaceRootAccess | undefined {
  return resolveManagedWorkspaceRootAccess(
    { managedTaskWorkspaceRoot: managedRoot, workspaceProvisioning: provisioning() },
    root,
  );
}

function resolveAccessLogged(
  activityLog: ServerLogSink,
  correlationId: string,
  root = workspaceRoot,
): WorkspaceRootAccess | undefined {
  return resolveManagedWorkspaceRootAccess(
    { managedTaskWorkspaceRoot: managedRoot, workspaceProvisioning: provisioning() },
    root,
    { activityLog, correlationId },
  );
}

function denialEvents(activityLog: BufferedServerLogSink): readonly ServerLogEvent[] {
  return activityLog.events.filter((event) => event.op === "workspace.root.denied");
}

function groundedInput(fs: WorkspaceFs): OrchestratorInput {
  return {
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "managed-root-direct-orchestrator",
      workspaceRoot,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: NOW,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "find ManagedWorkspaceProbe implementation",
      caseSensitive: false,
      maxResults: 5,
      emittedAtMs: NOW,
    },
    workspaceRoot,
    workspaceFs: fs,
    budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0, excerptBytesMax: 0 },
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-owned-root-access-")));
  repositoryRoot = join(base, "repository");
  mkdirSync(repositoryRoot);
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Keiko Test"]);
  writeFileSync(join(repositoryRoot, "README.md"), "managed root fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "fixture"]);
  repositoryId = deriveRepositoryId(repositoryRoot);
  managedRoot = join(base, ".keiko", "task-workspaces");
  assertManagedRootOwned(managedRoot);
  workspaceRoot = deriveManagedWorktreePath({
    managedRoot,
    repositoryId,
    workspaceId: WORKSPACE_ID,
  });
  mkdirSync(dirname(workspaceRoot), { recursive: true });
  git(["worktree", "add", "-q", "-b", TASK_BRANCH, workspaceRoot, "HEAD"]);
  registered = instanceAt(workspaceRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveManagedWorkspaceRootAccess", () => {
  it("admits only the exact canonical persisted root through an operation-scoped fs", () => {
    const access = resolveAccess();

    expect(access).toMatchObject({ kind: "managed-task", canonicalRoot: workspaceRoot });
    expect(() => resolveExistingAllowedWorkspaceRealRoot(nodeWorkspaceFs, workspaceRoot)).toThrow(
      PathDeniedError,
    );
    expect(
      resolveExistingAllowedWorkspaceRealRoot(access?.fs ?? nodeWorkspaceFs, workspaceRoot),
    ).toBe(workspaceRoot);
  });

  it("rejects an unregistered valid-shaped sibling and cannot reuse another root's capability", () => {
    const sibling = deriveManagedWorktreePath({
      managedRoot,
      repositoryId,
      workspaceId: "ws_ffffffffffffffffffffffff",
    });
    mkdirSync(sibling, { recursive: true });
    const access = resolveAccess();

    expect(resolveAccess(sibling)).toBeUndefined();
    expect(() =>
      resolveExistingAllowedWorkspaceRealRoot(access?.fs ?? nodeWorkspaceFs, sibling),
    ).toThrow(PathDeniedError);
  });

  it("rejects a missing linked-worktree pointer", () => {
    rmSync(join(workspaceRoot, ".git"));

    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects a malformed linked-worktree pointer", () => {
    writeFileSync(join(workspaceRoot, ".git"), "gitdir: relative/admin-dir\n");

    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects an oversized linked-worktree pointer without an unbounded fallback", () => {
    const pointerPath = join(workspaceRoot, ".git");
    const target = parseGitdirPointerTarget(readFileSync(pointerPath, "utf8"));
    if (target === undefined) throw new Error("real Git pointer was not parsed");
    writeFileSync(pointerPath, `gitdir:${" ".repeat(70_000)}${target}\n`);

    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects a Git admin directory whose reciprocal backpointer does not match", () => {
    const rawPointer = readFileSync(join(workspaceRoot, ".git"), "utf8");
    const adminDirectory = parseGitdirPointerTarget(rawPointer);
    if (adminDirectory === undefined) throw new Error("real Git pointer was not parsed");
    writeFileSync(join(adminDirectory, "gitdir"), join(base, "replacement", ".git"));

    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects a valid worktree whose persisted Git identity does not match", () => {
    registered = instanceAt(workspaceRoot, "mismatched-gitdir-identity");

    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects a same-path replacement even when it copies the authentic Git pointer", () => {
    const pointer = readFileSync(join(workspaceRoot, ".git"));
    rmSync(workspaceRoot, { recursive: true, force: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, ".git"), pointer);

    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects replacement of the Git common directory even when the admin inode is preserved", () => {
    const adminDirectory = parseGitdirPointerTarget(
      readFileSync(join(workspaceRoot, ".git"), "utf8"),
    );
    if (adminDirectory === undefined) throw new Error("real Git pointer was not parsed");
    const adminIdentity = nodeWorkspaceFs.stat(adminDirectory).fileIdentity;
    const commonDirectory = join(repositoryRoot, ".git");
    const commonIdentity = nodeWorkspaceFs.stat(commonDirectory).fileIdentity;
    const displacedCommon = join(base, "displaced-common-git");
    const heldAdmin = join(base, "held-worktree-admin");
    renameSync(adminDirectory, heldAdmin);
    renameSync(commonDirectory, displacedCommon);
    mkdirSync(dirname(adminDirectory), { recursive: true });
    renameSync(heldAdmin, adminDirectory);

    expect(nodeWorkspaceFs.stat(adminDirectory).fileIdentity).toBe(adminIdentity);
    expect(nodeWorkspaceFs.stat(commonDirectory).fileIdentity).not.toBe(commonIdentity);
    expect(resolveAccess()).toBeUndefined();
  });

  it("rejects a lexical alias even when it resolves to the registered workspace", () => {
    const aliasParent = join(base, "workspace-aliases");
    const alias = join(aliasParent, WORKSPACE_ID);
    mkdirSync(aliasParent);
    symlinkSync(workspaceRoot, alias, "dir");

    expect(resolveAccess(alias)).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a persisted exact path whose leaf was replaced by an in-root symlink",
    () => {
      const sibling = join(dirname(workspaceRoot), "workspace-storage");
      mkdirSync(sibling);
      rmSync(workspaceRoot, { recursive: true, force: true });
      symlinkSync(sibling, workspaceRoot, "dir");

      expect(resolveAccess()).toBeUndefined();
    },
  );

  it("re-proves persistence and ownership on every operation after revocation", () => {
    const first = resolveAccess();
    const second = resolveAccess();
    registered = undefined;

    expect(first?.fs).not.toBe(second?.fs);
    expect(resolveAccess()).toBeUndefined();
  });

  it("uses direct input authority before default or injected orchestrator filesystems", async () => {
    const access = resolveAccess();
    if (access === undefined) throw new Error("managed workspace authority was not resolved");
    expect(() => resolveExistingAllowedWorkspaceRealRoot(nodeWorkspaceFs, workspaceRoot)).toThrow(
      PathDeniedError,
    );

    const retrieved = await retrieveConnectedContextPack(groundedInput(access.fs), {
      answerer: ANSWERER_NOT_USED,
      correlationId: undefined,
      nowMs: () => NOW,
      activityLog: createBufferedServerLogSink(),
    });
    let fallbackRealPathCalls = 0;
    const fallbackFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (): never => {
        fallbackRealPathCalls += 1;
        throw new Error("the dependency fallback filesystem must not be used");
      },
    };
    const explored = await runGroundedExploration(groundedInput(access.fs), {
      answerer: ANSWERER_NOT_USED,
      correlationId: undefined,
      nowMs: () => NOW,
      activityLog: createBufferedServerLogSink(),
      fs: fallbackFs,
    });

    expect(retrieved.pack.uncertainty).toContainEqual(
      expect.objectContaining({ kind: "budget-clipped" }),
    );
    expect(explored.noEvidence).toBe(true);
    expect(fallbackRealPathCalls).toBe(0);
  });

  it("does not transfer managed authority through an ordinary filesystem clone", async () => {
    const access = resolveAccess();
    if (access === undefined) throw new Error("managed workspace authority was not resolved");
    const clonedFs: WorkspaceFs = { ...access.fs };

    await expect(
      retrieveConnectedContextPack(groundedInput(clonedFs), {
        answerer: ANSWERER_NOT_USED,
        correlationId: undefined,
        nowMs: () => NOW,
        activityLog: createBufferedServerLogSink(),
      }),
    ).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("revokes interactive authority outside bindable lifecycle states", () => {
    registered = { ...instanceAt(workspaceRoot), lifecycleState: "archived" };

    expect(resolveAccess()).toBeUndefined();
    expect(
      resolveLifecycleManagedWorkspaceRootAccess(
        {
          managedRoot,
          store: { getById: (): WorkspaceInstance | undefined => registered },
        },
        workspaceRoot,
      ),
    ).toMatchObject({ kind: "managed-task", canonicalRoot: workspaceRoot });
  });

  // #3347 cursor finding: the empty `catch { return undefined; }` around the managed-root re-proof
  // used to swallow an IO/parse failure with no logged activity event. Every input-driven scenario
  // that could reach this catch is already denied one layer earlier by an existsSync-equivalent
  // check (isManagedRootOwned / managedTargetExists), so the only way this catch actually fires is
  // a genuine race (the managed worktree vanishing between that earlier check and this re-proof) or
  // an exotic IO fault -- neither reproducible deterministically through fixtures alone. This proves
  // the catch itself is wired correctly by forcing exactly that failure through the same WorkspaceFs
  // port the re-proof already depends on, and asserts the correlated, body-free denial event that
  // used to never exist.
  it("logs a correlated workspace.root.denied event when the managed-root re-proof itself throws, instead of silently returning undefined", () => {
    const activityLog = createBufferedServerLogSink();
    const realStat = nodeWorkspaceFs.stat.bind(nodeWorkspaceFs);
    const simulatedRace = new Error("simulated stat failure racing a concurrent cleanup");
    const statSpy = vi.spyOn(nodeWorkspaceFs, "stat").mockImplementation((path: string) => {
      if (path === workspaceRoot) throw simulatedRace;
      return realStat(path);
    });

    let access: WorkspaceRootAccess | undefined;
    try {
      access = resolveManagedWorkspaceRootAccess(
        { managedTaskWorkspaceRoot: managedRoot, workspaceProvisioning: provisioning() },
        workspaceRoot,
        { activityLog, correlationId: "wra-catch-000001" },
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(access).toBeUndefined();
    const denialEvents = activityLog.events.filter((event) => event.op === "workspace.root.denied");
    expect(denialEvents).toHaveLength(1);
    expect(denialEvents[0]).toMatchObject({
      level: "warn",
      category: "security",
      correlationId: "wra-catch-000001",
      extra: { decision: "denied" },
    });
    // Body-free: the simulated failure's own message never enters the logged event.
    expect(JSON.stringify(denialEvents[0])).not.toContain(simulatedRace.message);
  });

  // #3347 cursor finding: run-handlers.ts (apply) and gitDelivery/execution.ts used to authorize
  // through resolveManagedTaskWorkspaceInstanceFromLookup's weaker containment/existence check
  // directly, which never reads lifecycleState -- an archived (or identity-replaced) worktree whose
  // directory still exists could pass apply/git while interactive admission denied it. Both
  // WorkspaceInfo-returning surfaces now compose resolveManagedWorkspaceRootAccess, so this proves
  // they agree with interactive admission on the exact same archived instance, not merely that all
  // three happen to return undefined for unrelated reasons.
  it("rejects an archived worktree through resolveManagedTaskWorkspaceRoot and resolveRegisteredOrManagedWorkspaceRoot the same way interactive admission rejects it", () => {
    registered = { ...instanceAt(workspaceRoot), lifecycleState: "archived" };
    const store = createInMemoryUiStore();
    const deps = {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: provisioning(),
      store,
    };

    try {
      expect(resolveAccess()).toBeUndefined();
      expect(resolveManagedTaskWorkspaceRoot(deps, workspaceRoot)).toBeUndefined();
      expect(resolveRegisteredOrManagedWorkspaceRoot(deps, workspaceRoot)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  // #3347 owner P2 / cursor: the ORDINARY managed-denial cases returned `undefined` with no
  // activity-log line at all -- only a thrown failure reached the catch-based recorder. A route
  // could therefore answer 403 with nothing correlated in the log to reconstruct WHY, which is the
  // one question a managed-authority denial has to answer. Each guard now emits exactly one
  // classified, body-free line on the SAME op/category/redaction vocabulary the catch already used.
  it("logs one correlated lifecycle denial when the managed instance is archived", () => {
    registered = { ...instanceAt(workspaceRoot), lifecycleState: "archived" };
    const activityLog = createBufferedServerLogSink();

    expect(resolveAccessLogged(activityLog, "wra-lifecycle-0001")).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(1);
    expect(denialEvents(activityLog)[0]).toMatchObject({
      level: "warn",
      category: "security",
      correlationId: "wra-lifecycle-0001",
      extra: { decision: "denied", reason: "managed-root-lifecycle" },
    });
    // Body-free: the denial never carries the workspace path or the persisted Git identity.
    expect(JSON.stringify(denialEvents(activityLog)[0])).not.toContain(workspaceRoot);
  });

  it("logs one correlated identity denial when the persisted Git identity drifted", () => {
    registered = instanceAt(workspaceRoot, "mismatched-gitdir-identity");
    const activityLog = createBufferedServerLogSink();

    expect(resolveAccessLogged(activityLog, "wra-identity-0001")).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(1);
    expect(denialEvents(activityLog)[0]).toMatchObject({
      level: "warn",
      category: "security",
      correlationId: "wra-identity-0001",
      extra: { decision: "denied", reason: "managed-root-identity" },
    });
    expect(JSON.stringify(denialEvents(activityLog)[0])).not.toContain(
      "mismatched-gitdir-identity",
    );
  });

  // An identity persisted under the retired v2 composition is still refused — accepting a forgeable
  // identity even once would mint a trusted v3 one from it. What changes is only what the operator
  // is told: this workspace needs re-registration, not an incident response.
  it("names the retired identity schema instead of reporting a replacement", () => {
    const inspection = inspectManagedGitdirIdentity(workspaceRoot, repositoryRoot);
    if (inspection === undefined) throw new Error("real linked-worktree identity was not resolved");
    registered = instanceAt(workspaceRoot, inspection.legacyIdentity);
    const activityLog = createBufferedServerLogSink();

    expect(resolveAccessLogged(activityLog, "wra-schema-0001")).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(1);
    expect(denialEvents(activityLog)[0]).toMatchObject({
      level: "warn",
      category: "security",
      correlationId: "wra-schema-0001",
      extra: { decision: "denied", reason: "managed-root-identity-schema-retired" },
    });
    // The legacy value is a filesystem fingerprint; it must not travel into the log.
    expect(JSON.stringify(denialEvents(activityLog)[0])).not.toContain(inspection.legacyIdentity);
  });

  it("logs one correlated ownership denial when the managed-root marker is gone", () => {
    rmSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME), { force: true });
    const activityLog = createBufferedServerLogSink();

    expect(resolveAccessLogged(activityLog, "wra-ownership-0001")).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(1);
    expect(denialEvents(activityLog)[0]).toMatchObject({
      correlationId: "wra-ownership-0001",
      extra: { decision: "denied", reason: "managed-root-ownership" },
    });
  });

  it("logs one correlated registration denial for an unregistered valid-shaped sibling", () => {
    const sibling = deriveManagedWorktreePath({
      managedRoot,
      repositoryId,
      workspaceId: "ws_ffffffffffffffffffffffff",
    });
    mkdirSync(sibling, { recursive: true });
    const activityLog = createBufferedServerLogSink();

    expect(resolveAccessLogged(activityLog, "wra-registration-01", sibling)).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(1);
    expect(denialEvents(activityLog)[0]).toMatchObject({
      correlationId: "wra-registration-01",
      extra: { decision: "denied", reason: "managed-root-not-registered" },
    });
  });

  // The gate on the emit is load-bearing, not cosmetic: deps.ts asks THIS resolver about every
  // requested root before it falls back to ordinary admission, so an ungated emit would label every
  // ordinary workspace resolution in the product a managed-authority denial and bury the real ones.
  it("stays silent for an ordinary root that never required managed authority", () => {
    const ordinaryRoot = join(base, "ordinary-project");
    mkdirSync(ordinaryRoot);
    const activityLog = createBufferedServerLogSink();

    expect(resolveAccessLogged(activityLog, "wra-ordinary-0001", ordinaryRoot)).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(0);
  });

  // #3347 cursor: resolveLifecycleManagedWorkspaceRootAccess kept the empty `catch { return
  // undefined; }` its interactive twin already lost -- no catalogued op, no errorKind, no
  // correlation. It reuses the same recorder now, with a reason that keeps the maintenance lane
  // distinguishable from an interactive admission failure in one grep.
  it("logs a correlated workspace.root.denied event when the lifecycle-maintenance re-proof throws", () => {
    const activityLog = createBufferedServerLogSink();
    const realStat = nodeWorkspaceFs.stat.bind(nodeWorkspaceFs);
    const simulatedRace = new Error("simulated stat failure racing a concurrent sweep");
    const statSpy = vi.spyOn(nodeWorkspaceFs, "stat").mockImplementation((path: string) => {
      if (path === workspaceRoot) throw simulatedRace;
      return realStat(path);
    });

    let access: WorkspaceRootAccess | undefined;
    try {
      access = resolveLifecycleManagedWorkspaceRootAccess(
        { managedRoot, store: { getById: (): WorkspaceInstance | undefined => registered } },
        workspaceRoot,
        { activityLog, correlationId: "wra-lifecycle-catch" },
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(access).toBeUndefined();
    expect(denialEvents(activityLog)).toHaveLength(1);
    expect(denialEvents(activityLog)[0]).toMatchObject({
      level: "warn",
      category: "security",
      correlationId: "wra-lifecycle-catch",
      extra: { decision: "denied", reason: "managed-root-lifecycle-resolution-failed" },
    });
    expect(JSON.stringify(denialEvents(activityLog)[0])).not.toContain(simulatedRace.message);
  });

  // #3347 owner P1: production registers a managed worktree in UiStore like any other project, so
  // resolveRegisteredOrManagedWorkspaceRoot's store loop used to run FIRST and return a
  // WorkspaceInfo for a path the strong managed prover denies -- the store hit bypassed the
  // lifecycle/gitdir proof entirely. The archived instance below is simultaneously (a) denied by
  // resolveManagedWorkspaceRootAccess and (b) present in store.listProjects(), which is exactly the
  // shape run/apply/git-delivery callers act on after managed authority was revoked.
  it("rejects an archived managed worktree that is ALSO registered as an ordinary project in the store", () => {
    registered = { ...instanceAt(workspaceRoot), lifecycleState: "archived" };
    const store = createInMemoryUiStore();
    const deps = {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: provisioning(),
      store,
    };

    try {
      store.createProject(workspaceRoot, "managed-worktree-also-registered");

      // Guards the pin against vacuity: the bypass only exists while the store really lists it.
      expect(store.listProjects().map((project) => project.path)).toContain(workspaceRoot);
      expect(resolveAccess()).toBeUndefined();
      expect(resolveManagedTaskWorkspaceRoot(deps, workspaceRoot)).toBeUndefined();
      expect(resolveRegisteredOrManagedWorkspaceRoot(deps, workspaceRoot)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects an identity-replaced managed worktree that is ALSO registered as an ordinary project", () => {
    registered = instanceAt(workspaceRoot, "mismatched-gitdir-identity");
    const store = createInMemoryUiStore();
    const deps = {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: provisioning(),
      store,
    };

    try {
      store.createProject(workspaceRoot, "managed-worktree-also-registered");

      expect(store.listProjects().map((project) => project.path)).toContain(workspaceRoot);
      expect(resolveRegisteredOrManagedWorkspaceRoot(deps, workspaceRoot)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("still admits an ordinary registered project that is not classified as managed", () => {
    const ordinaryRoot = join(base, "ordinary-project");
    mkdirSync(ordinaryRoot);
    const store = createInMemoryUiStore();
    const deps = {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: provisioning(),
      store,
    };

    try {
      store.createProject(ordinaryRoot, "ordinary-project");

      expect(resolveRegisteredOrManagedWorkspaceRoot(deps, ordinaryRoot)?.root).toBe(ordinaryRoot);
    } finally {
      store.close();
    }
  });

  // The classify-first order must not over-deny either. A user's ordinary project directory very
  // often CONTAINS Keiko's managed root (`<project>/.keiko/task-workspaces`), and
  // requiresManagedRootAuthority deliberately answers false for that shape because the `.keiko`
  // segment is on the deny list. Losing that would take every such project's routes to 403.
  it("still admits a registered ordinary project that CONTAINS the managed root", () => {
    const store = createInMemoryUiStore();
    const deps = {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: provisioning(),
      store,
    };

    try {
      store.createProject(base, "project-containing-the-managed-root");

      expect(requiresConfiguredManagedWorkspaceAuthority(deps, base)).toBe(false);
      expect(resolveRegisteredOrManagedWorkspaceRoot(deps, base)?.root).toBe(base);
    } finally {
      store.close();
    }
  });

  it("admits an active worktree through resolveManagedTaskWorkspaceRoot and resolveRegisteredOrManagedWorkspaceRoot at the SAME canonical root interactive admission proves", () => {
    const store = createInMemoryUiStore();
    const deps = {
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning: provisioning(),
      store,
    };

    try {
      expect(resolveManagedTaskWorkspaceRoot(deps, workspaceRoot)).toEqual({
        root: workspaceRoot,
        // The managed projection reports the canonical root it just re-proved as BOTH identities:
        // no lexical alias is admitted here, so there is no second path to display.
        selectedRoot: workspaceRoot,
        name: undefined,
        version: undefined,
        testFramework: "unknown",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      });
      expect(resolveRegisteredOrManagedWorkspaceRoot(deps, workspaceRoot)?.root).toBe(
        workspaceRoot,
      );
    } finally {
      store.close();
    }
  });
});

describe("requiresConfiguredManagedWorkspaceAuthority", () => {
  it("classifies exact, descendant, and canonical alias candidates", () => {
    const aliasRoot = join(base, "managed-root-alias");
    symlinkSync(managedRoot, aliasRoot, "dir");

    expect(
      requiresConfiguredManagedWorkspaceAuthority(
        { managedTaskWorkspaceRoot: managedRoot },
        managedRoot,
      ),
    ).toBe(true);
    expect(
      requiresConfiguredManagedWorkspaceAuthority(
        { managedTaskWorkspaceRoot: managedRoot },
        workspaceRoot,
      ),
    ).toBe(true);
    expect(
      requiresConfiguredManagedWorkspaceAuthority(
        { managedTaskWorkspaceRoot: managedRoot },
        join(aliasRoot, repositoryId, WORKSPACE_ID),
      ),
    ).toBe(true);
  });

  it("keeps an unrelated ordinary root ordinary when the configured root is unavailable", () => {
    const unavailableManagedRoot = join(base, "missing-managed-root");
    const ordinaryRoot = join(base, "ordinary-project");
    mkdirSync(ordinaryRoot);

    expect(
      requiresConfiguredManagedWorkspaceAuthority(
        { managedTaskWorkspaceRoot: unavailableManagedRoot },
        ordinaryRoot,
      ),
    ).toBe(false);
    expect(
      requiresConfiguredManagedWorkspaceAuthority(
        { managedTaskWorkspaceRoot: unavailableManagedRoot },
        join(unavailableManagedRoot, repositoryId, WORKSPACE_ID),
      ),
    ).toBe(true);
  });
});
