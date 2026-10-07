// Issue #1387 — CommandRunnerManager unit tests. Each test composes a fake SpawnFn so the manager
// exercises the real allowlist + discovery + cwd containment + redaction passthrough without a real
// child process. Route-level coverage lives in command-runner-routes.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCommandTaskRunRequest } from "@oscharko-dev/keiko-contracts/runtime/command-runner";
import {
  CommandDeniedError,
  DEFAULT_SANDBOX_POLICY,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { CommandRunnerEvent, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import {
  createCommandRunnerManager,
  type CommandRunnerManager,
  type CommandRunnerManagerOptions,
  type CommandRunnerWorkspaceTrustDecider,
} from "./command-runner.js";
import { CommandRunnerError } from "./command-runner-errors.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { redactLogFields } from "@oscharko-dev/keiko-activity-log";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  resolveManagedWorkspaceRootAccess,
  type WorkspaceRootAccess,
} from "./task-workspace/workspace-root-access.js";
import { assertManagedRootOwned } from "./task-workspace/managed-root.js";
import { deriveManagedWorktreePath, deriveRepositoryId } from "./task-workspace/naming.js";
import { inspectManagedGitdirIdentity } from "./task-workspace/gitdir-identity.js";
import type { ServerDiagnosticSink } from "./diagnostics-log.js";

// ── Fake spawn helpers (mirrors terminal.test.ts) ────────────────────────────────

interface FakeChildOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly hangs?: boolean;
}

const FAKE_CHILDREN = new Map<number, ChildProcess>();
let nextPid = 200_000;

function fakeChild(opts: FakeChildOptions = {}): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (emitter as unknown as { stdout: EventEmitter }).stdout = stdoutEmitter;
  (emitter as unknown as { stderr: EventEmitter }).stderr = stderrEmitter;
  const pid = nextPid;
  nextPid += 1;
  (emitter as unknown as { pid: number }).pid = pid;
  FAKE_CHILDREN.set(pid, emitter);
  emitter.kill = (): boolean => {
    setImmediate(() => emitter.emit("close", null, "SIGTERM"));
    return true;
  };
  if (opts.hangs === true) {
    return emitter;
  }
  setImmediate(() => {
    if (opts.stdout !== undefined && opts.stdout.length > 0) {
      stdoutEmitter.emit("data", Buffer.from(opts.stdout, "utf8"));
    }
    if (opts.stderr !== undefined && opts.stderr.length > 0) {
      stderrEmitter.emit("data", Buffer.from(opts.stderr, "utf8"));
    }
    setTimeout(() => {
      emitter.emit("close", opts.exitCode ?? 0, null);
      FAKE_CHILDREN.delete(pid);
    }, opts.delayMs ?? 0);
  });
  return emitter;
}

const realProcessKill = process.kill.bind(process);
let processKillPatched = false;
function ensureProcessKillPatched(): void {
  if (processKillPatched) return;
  processKillPatched = true;
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number): true => {
    const positivePid = Math.abs(pid);
    const child = FAKE_CHILDREN.get(positivePid);
    if (child !== undefined) {
      FAKE_CHILDREN.delete(positivePid);
      setImmediate(() => child.emit("close", null, signal ?? "SIGTERM"));
      return true;
    }
    return realProcessKill(pid, signal);
  });
}

function makeSpawn(opts: FakeChildOptions = {}): SpawnFn {
  return () => fakeChild(opts);
}

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  scripts: {
    test: "vitest run",
    "test:unit": "vitest run unit",
    build: "tsc -b",
    "build:web": "vite build",
    lint: "eslint .",
    start: "node server.js",
    "-evil": "rm -rf /",
  },
});
const TEST_SANDBOX_AVAILABILITY = {
  bubblewrap: true,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
} as const;

// ── Fixture ──────────────────────────────────────────────────────────────────────

let workspaceRoot: string;
let store: UiStore;
let evidenceStore: EvidenceStore;

beforeEach(() => {
  ensureProcessKillPatched();
  FAKE_CHILDREN.clear();
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-cmd-"));
  writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "fixture");
  evidenceStore = createInMemoryEvidenceStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  processKillPatched = false;
  store.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function makeManager(
  spawnImpl: SpawnFn = makeSpawn(),
  overrides: Partial<CommandRunnerManagerOptions> = {},
): CommandRunnerManager {
  const { runDeps, ...rest } = overrides;
  return createCommandRunnerManager({
    store,
    evidenceStore,
    processEnv: { PATH: "/usr/bin" },
    diagnostics: { record: (): void => undefined },
    isWorkspaceTrustedForPackageScripts: () => true,
    runDeps: {
      spawn: spawnImpl,
      resolveExecutable: (command: string) => command,
      sandboxAvailability: TEST_SANDBOX_AVAILABILITY,
      platform: "linux",
      ...runDeps,
    },
    ...rest,
  });
}

function collect(manager: CommandRunnerManager): CommandRunnerEvent[] {
  const events: CommandRunnerEvent[] = [];
  manager.subscribe((event) => events.push(event));
  return events;
}

function linkedCommandWorktree(managedRoot: string): WorkspaceInstance {
  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd: workspaceRoot, encoding: "utf8" });
  git(["init", "-q", "-b", "dev"]);
  git(["add", "package.json"]);
  git([
    "-c",
    "user.name=Keiko Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "fixture",
  ]);
  const workspaceId = "ws_0123456789abcdef01234567";
  const repositoryRoot = realpathSync(workspaceRoot);
  const repositoryId = deriveRepositoryId(repositoryRoot);
  assertManagedRootOwned(managedRoot);
  const managedWorktreePath = deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId });
  const taskBranch = "keiko/task/g1-command-runner-01234567";
  mkdirSync(dirname(managedWorktreePath), { recursive: true });
  git(["worktree", "add", "-q", "-b", taskBranch, managedWorktreePath, "HEAD"]);
  const identity = inspectManagedGitdirIdentity(managedWorktreePath, repositoryRoot);
  if (identity === undefined) throw new Error("Linked fixture worktree identity was unavailable.");
  return {
    schemaVersion: "1",
    workspaceId,
    taskId: "command-fixture",
    repositoryId,
    repositoryRoot,
    baseBranch: "dev",
    taskBranch,
    managedWorktreePath,
    gitdirIdentity: identity.identity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "command-fixture-root",
  };
}

// ── Discovery ─────────────────────────────────────────────────────────────────────

describe("CommandRunnerManager — discovery", () => {
  it("uses the production ownership and lifecycle proof for an unregistered linked task root", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-cmd-linked-")));
    const activity: ServerLogEvent[] = [];
    try {
      const managedRoot = join(base, ".keiko", "task-workspaces");
      let instance = linkedCommandWorktree(managedRoot);
      const spawn = vi.fn(makeSpawn());
      const manager = makeManager(spawn, {
        resolveWorkspaceRootAccess: (requested): WorkspaceRootAccess | undefined =>
          resolveManagedWorkspaceRootAccess(
            {
              managedTaskWorkspaceRoot: managedRoot,
              workspaceProvisioning: {
                provision: (): never => {
                  throw new Error("Fixture does not provision.");
                },
                activate: (): never => {
                  throw new Error("Fixture does not activate.");
                },
                getInstance: (id) => (id === instance.workspaceId ? instance : undefined),
              },
            },
            requested,
            {
              activityLog: {
                write: (event): void => {
                  activity.push(event);
                },
              },
            },
          ),
      });
      const input = { projectId: instance.managedWorktreePath, taskId: "npm-script:test" };
      expect(store.listProjects().some((project) => project.path === input.projectId)).toBe(false);
      expect(manager.discover(input.projectId).tasks).not.toHaveLength(0);
      expect((await manager.execute(input)).failureReason).toBe("none");
      expect(spawn).toHaveBeenCalledOnce();
      manager.subscribe((event) => {
        if (event.kind === "run-started") instance = { ...instance, lifecycleState: "archived" };
      });
      expect((await manager.execute(input)).failureReason).toBe("denied");
      expect(spawn).toHaveBeenCalledOnce();
      expect(activity.find((event) => event.op === "workspace.root.denied")?.extra).toMatchObject({
        reason: "managed-root-lifecycle",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("discovers and runs an unregistered root proven to be a managed task", async () => {
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-cmd-unregistered-")));
    try {
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      const spawn = vi.fn(makeSpawn());
      const manager = makeManager(spawn, {
        resolveWorkspaceRootAccess: (requested): WorkspaceRootAccess | undefined =>
          requested === worktreeRoot
            ? {
                kind: "managed-task",
                canonicalRoot: worktreeRoot,
                fs: nodeWorkspaceFs,
                repositoryRoot: workspaceRoot,
              }
            : undefined,
      });
      expect(store.listProjects().some((project) => project.path === worktreeRoot)).toBe(false);
      expect(manager.discover(worktreeRoot).tasks.map((task) => task.id)).toContain(
        "npm-script:test",
      );
      expect(
        (await manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" }))
          .failureReason,
      ).toBe("none");
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("does not resolve an unknown ordinary root through the focused registered project", async () => {
    const spawn = vi.fn(makeSpawn());
    const resolve = vi.fn((): WorkspaceRootAccess => ({
      kind: "ordinary",
      canonicalRoot: workspaceRoot,
      fs: nodeWorkspaceFs,
    }));
    const manager = makeManager(spawn, { resolveWorkspaceRootAccess: resolve });
    expect(() => manager.discover("/unregistered/ordinary")).toThrow(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
    );
    await expect(
      manager.execute({ projectId: "/unregistered/ordinary", taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("records technical managed-root resolver causes without content or paths", () => {
    const record = vi.fn<ServerDiagnosticSink["record"]>();
    const manager = makeManager(makeSpawn(), {
      diagnostics: { record },
      resolveWorkspaceRootAccess: (): never => {
        throw new TypeError(`private-root-marker ${workspaceRoot}`, {
          cause: new RangeError("private-root-cause"),
        });
      },
    });
    expect(() => manager.discover("/unregistered/managed")).toThrow(
      expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
    );
    expect(record).toHaveBeenCalledOnce();
    const diagnostic = record.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      operation: "command.workspace-root",
      code: "command-workspace-root-resolution-failed",
      diagnosticOutcome: "request-failed",
      causeChain: ["RangeError"],
    });
    expect(diagnostic?.frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("private-root-marker");
    expect(JSON.stringify(diagnostic)).not.toContain("private-root-cause");
    expect(JSON.stringify(diagnostic)).not.toContain(workspaceRoot);
  });

  it("uses managed-root access and fails closed when central resolution denies it", () => {
    const access: WorkspaceRootAccess = {
      kind: "managed-task",
      canonicalRoot: workspaceRoot,
      fs: nodeWorkspaceFs,
      // The worktree IS its own repository here, so the ADR-0147 D3 basis comparison is trivially
      // satisfied and this test keeps measuring only the root-access resolution it is about.
      repositoryRoot: workspaceRoot,
    };
    expect(
      makeManager(makeSpawn(), { resolveWorkspaceRootAccess: () => access }).discover(workspaceRoot)
        .tasks,
    ).not.toHaveLength(0);
    expect(() =>
      makeManager(makeSpawn(), { resolveWorkspaceRootAccess: () => undefined }).discover(
        workspaceRoot,
      ),
    ).toThrow(expect.objectContaining({ code: "PROJECT_NOT_FOUND" }));
  });

  // #3382/L-5. Script trust for a MANAGED TASK WORKTREE is the repository's standing grant AND the
  // ADR-0147 D3 basis equality that binds it to the worktree's own `package.json` bytes — the exact
  // rule `verificationRunner.worktreeSharesRepositoryTrustBasis` states, asked here rather than
  // restated. Before this, the decision was keyed on the worktree's OWN root, which a governed run
  // can write to: the runner answered "trusted" for a manifest no human ever approved.
  it("refuses a managed worktree whose package.json differs from its repository's", async () => {
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-cmd-worktree-")));
    try {
      writeFileSync(
        join(worktreeRoot, "package.json"),
        PACKAGE_JSON.replace('"vitest run"', '"vitest run && node ./attacker.js"'),
        "utf8",
      );
      store.createProject(worktreeRoot, "worktree");
      const spawn = vi.fn(makeSpawn());
      const manager = makeManager(spawn, {
        resolveWorkspaceRootAccess: (): WorkspaceRootAccess => ({
          kind: "managed-task",
          canonicalRoot: worktreeRoot,
          fs: nodeWorkspaceFs,
          repositoryRoot: workspaceRoot,
        }),
      });

      expect(
        manager.discover(worktreeRoot).tasks.find((task) => task.id === "npm-script:test")
          ?.trustState,
      ).toBe("approval-required");
      await expect(
        manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" }),
      ).rejects.toThrow(expect.objectContaining({ code: "TASK_REQUIRES_TRUST" }));
      expect(spawn).not.toHaveBeenCalled();

      // Control: the SAME worktree with a byte-identical manifest keeps the repository's grant.
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      await manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // ADR-0147 D3 (2026-09-10): once a governed run has rewritten its worktree manifest, the one basis
  // left is an explicit human grant for the worktree root itself — the same `decideScriptTrust` the
  // verification runner asks, so the command catalog and the at-effect gate agree with it.
  it("admits a drifted managed worktree under the worktree root's own explicit human grant", async () => {
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-cmd-worktree-grant-")));
    try {
      writeFileSync(
        join(worktreeRoot, "package.json"),
        PACKAGE_JSON.replace('"vitest run"', '"vitest run --coverage"'),
        "utf8",
      );
      store.createProject(worktreeRoot, "worktree");
      const spawn = vi.fn(makeSpawn());
      let granted = false;
      const manager = makeManager(spawn, {
        resolveWorkspaceRootAccess: (): WorkspaceRootAccess => ({
          kind: "managed-task",
          canonicalRoot: worktreeRoot,
          fs: nodeWorkspaceFs,
          repositoryRoot: workspaceRoot,
        }),
        isWorktreeTrustedByHumanGrant: (canonicalRoot): boolean =>
          canonicalRoot === worktreeRoot && granted,
      });
      const testTrust = (): string | undefined =>
        manager.discover(worktreeRoot).tasks.find((task) => task.id === "npm-script:test")
          ?.trustState;

      expect(testTrust()).toBe("approval-required");
      await expect(
        manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" }),
      ).rejects.toThrow(expect.objectContaining({ code: "TASK_REQUIRES_TRUST" }));

      granted = true;
      expect(testTrust()).toBe("trusted");
      await manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // The at-effect gate must RE-READ the worktree basis, not replay the comparison discovery took.
  // The manifest here is byte-identical when the catalog is built and is replaced before the run is
  // admitted — the "another process rewrote package.json between the two checks" window. The trust
  // decider is the deterministic clock for it: `trustedForScripts` reads the basis and THEN calls the
  // decider, so a rewrite issued from inside the discovery-time decider call lands strictly between
  // the two basis reads. Every script survives the rewrite, so the refusal can only come from the
  // basis — and `spawn` proves the rewritten bytes never reached a child process.
  it("re-reads the worktree trust basis at the effect boundary and never spawns a rewritten manifest", async () => {
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-cmd-toctou-")));
    try {
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      store.createProject(worktreeRoot, "worktree");
      const spawn = vi.fn(makeSpawn());
      let rewriteOnNextTrustCheck = false;
      let manifestRewritten = false;
      const isWorkspaceTrustedForPackageScripts: CommandRunnerWorkspaceTrustDecider = () => {
        if (rewriteOnNextTrustCheck) {
          rewriteOnNextTrustCheck = false;
          manifestRewritten = true;
          writeFileSync(
            join(worktreeRoot, "package.json"),
            PACKAGE_JSON.replace('"vitest run"', '"vitest run && node ./attacker.js"'),
            "utf8",
          );
        }
        return true;
      };
      const manager = makeManager(spawn, {
        isWorkspaceTrustedForPackageScripts,
        resolveWorkspaceRootAccess: (): WorkspaceRootAccess => ({
          kind: "managed-task",
          canonicalRoot: worktreeRoot,
          fs: nodeWorkspaceFs,
          repositoryRoot: workspaceRoot,
        }),
      });

      // Control: no rewrite, so the repository's standing grant still covers the worktree.
      await manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" });
      expect(spawn).toHaveBeenCalledTimes(1);

      rewriteOnNextTrustCheck = true;
      await expect(
        manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" }),
      ).rejects.toThrow(expect.objectContaining({ code: "TASK_REQUIRES_TRUST" }));
      expect(manifestRewritten).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.inFlightCount()).toBe(0);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  // eslint-disable-next-line complexity -- single discovery assertion covers the command kind/trust matrix.
  it("discovers package.json scripts and classifies kinds", () => {
    const catalog = makeManager().discover(workspaceRoot);
    expect(catalog.projectId).toBe(workspaceRoot);
    const ids = catalog.tasks.map((task) => task.id);
    expect(ids).toContain("npm-script:test");
    expect(ids).toContain("npm-script:build");
    const byId = new Map(catalog.tasks.map((task) => [task.id, task]));
    expect(byId.get("npm-script:test")?.kind).toBe("test");
    expect(byId.get("npm-script:test:unit")?.kind).toBe("test");
    expect(byId.get("npm-script:build")?.kind).toBe("build");
    expect(byId.get("npm-script:build:web")?.kind).toBe("build");
    expect(byId.get("npm-script:lint")?.kind).toBe("run");
    expect(byId.get("npm-script:start")?.kind).toBe("run");
    // Every task maps to a frozen `npm run <script>` argv — never free-form input.
    expect(byId.get("npm-script:test")?.args).toEqual(["run", "test"]);
    expect(byId.get("npm-script:test")?.executable).toBe("npm");
    expect(byId.get("npm-script:test")?.trustState).toBe("trusted");
    expect(byId.get("npm-script:test")?.trustReason).toBe("repository-authored-script");
  });

  it("marks repository-authored scripts approval-required when no server trust predicate approves", () => {
    const catalog = makeManager(makeSpawn(), {
      isWorkspaceTrustedForPackageScripts: undefined,
    }).discover(workspaceRoot);
    expect(catalog.tasks.every((task) => task.trustState === "approval-required")).toBe(true);
    expect(new Set(catalog.tasks.map((task) => task.trustReason))).toEqual(
      new Set(["repository-authored-script"]),
    );
  });

  it("fails closed to approval-required when the server trust predicate throws", () => {
    const catalog = makeManager(makeSpawn(), {
      isWorkspaceTrustedForPackageScripts: () => {
        throw new Error("trust store unavailable");
      },
    }).discover(workspaceRoot);
    expect(catalog.tasks.every((task) => task.trustState === "approval-required")).toBe(true);
  });

  it("skips unsafe script names that could inject a flag", () => {
    const catalog = makeManager().discover(workspaceRoot);
    expect(catalog.tasks.map((task) => task.id)).not.toContain("npm-script:-evil");
  });

  it("returns an empty catalog when the project has no package.json", () => {
    rmSync(join(workspaceRoot, "package.json"));
    expect(makeManager().discover(workspaceRoot).tasks).toEqual([]);
  });

  it("throws PROJECT_NOT_FOUND for an unknown project", () => {
    expect(() => makeManager().discover("/no/such/project")).toThrow(CommandRunnerError);
  });
});

// ── Execution outcomes ─────────────────────────────────────────────────────────────

describe("CommandRunnerManager — execution", () => {
  it("refuses authority revoked by a synchronous run-start subscriber before spawn", async () => {
    const spawn = vi.fn(makeSpawn());
    const manager = makeManager(spawn);
    let authorized = true;
    manager.subscribe((event) => {
      if (event.kind === "run-started") authorized = false;
    });
    const beforeSpawn = vi.fn(() => authorized);
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      beforeSpawn,
    });
    expect(result.failureReason).toBe("denied");
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.inFlightCount()).toBe(0);
  });

  it("refuses manifest trust drift in a run-start subscriber before spawn", async () => {
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-cmd-start-drift-")));
    try {
      writeFileSync(join(worktreeRoot, "package.json"), PACKAGE_JSON, "utf8");
      store.createProject(worktreeRoot, "worktree");
      const spawn = vi.fn(makeSpawn());
      const manager = makeManager(spawn, {
        resolveWorkspaceRootAccess: (): WorkspaceRootAccess => ({
          kind: "managed-task",
          canonicalRoot: worktreeRoot,
          fs: nodeWorkspaceFs,
          repositoryRoot: workspaceRoot,
        }),
      });
      manager.subscribe((event) => {
        if (event.kind === "run-started") {
          writeFileSync(
            join(worktreeRoot, "package.json"),
            PACKAGE_JSON.replace("vitest run", "node attacker.js"),
            "utf8",
          );
        }
      });
      const result = await manager.execute({ projectId: worktreeRoot, taskId: "npm-script:test" });
      expect(result.failureReason).toBe("denied");
      expect(spawn).not.toHaveBeenCalled();
      expect(manager.inFlightCount()).toBe(0);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("refuses a same-path root replacement after a run started", async () => {
    const savedRoot = `${workspaceRoot}-saved`;
    const spawn = vi.fn(makeSpawn());
    const manager = makeManager(spawn);
    try {
      manager.subscribe((event) => {
        if (event.kind !== "run-started") return;
        renameSync(workspaceRoot, savedRoot);
        mkdirSync(workspaceRoot);
        writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
      });
      const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
      expect(result.failureReason).toBe("denied");
      expect(spawn).not.toHaveBeenCalled();
      expect(manager.inFlightCount()).toBe(0);
    } finally {
      rmSync(savedRoot, { recursive: true, force: true });
    }
  });

  it("rechecks caller authority after the final script-trust callback", async () => {
    const spawn = vi.fn(makeSpawn());
    let authorized = true;
    let started = false;
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: (): boolean => {
        if (started) authorized = false;
        return true;
      },
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") started = true;
    });
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      beforeSpawn: () => authorized,
    });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses manifest replacement inside the last caller authority callback", async () => {
    const spawn = vi.fn(makeSpawn());
    const manager = makeManager(spawn);
    let callerChecks = 0;
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      beforeSpawn: (): boolean => {
        callerChecks += 1;
        if (callerChecks === 2) {
          writeFileSync(
            join(workspaceRoot, "package.json"),
            PACKAGE_JSON.replace("vitest run", "node attacker.js"),
            "utf8",
          );
        }
        return true;
      },
    });
    expect(callerChecks).toBe(2);
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses standing trust revoked inside the last caller authority callback", async () => {
    const spawn = vi.fn(makeSpawn());
    let trusted = true;
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: (): boolean => trusted,
    });
    let callerChecks = 0;
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      beforeSpawn: (): boolean => {
        callerChecks += 1;
        if (callerChecks === 2) trusted = false;
        return true;
      },
    });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses manifest replacement inside a script-trust callback that returns allowed", async () => {
    const spawn = vi.fn(makeSpawn());
    let started = false;
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: (): boolean => {
        if (started) {
          writeFileSync(
            join(workspaceRoot, "package.json"),
            PACKAGE_JSON.replace("vitest run", "node attacker.js"),
            "utf8",
          );
        }
        return true;
      },
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") started = true;
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("materializes the manifest after the last script-trust callback", async () => {
    const spawn = vi.fn(makeSpawn());
    let started = false;
    let postStartTrustChecks = 0;
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: (): boolean => {
        if (started && ++postStartTrustChecks === 2) {
          writeFileSync(
            join(workspaceRoot, "package.json"),
            PACKAGE_JSON.replace("vitest run", "node attacker.js"),
            "utf8",
          );
        }
        return true;
      },
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") started = true;
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(postStartTrustChecks).toBe(2);
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("materializes root identity after the last script-trust callback", async () => {
    const savedRoot = `${workspaceRoot}-saved`;
    const spawn = vi.fn(makeSpawn());
    let started = false;
    let postStartTrustChecks = 0;
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: (): boolean => {
        if (started && ++postStartTrustChecks === 2) {
          renameSync(workspaceRoot, savedRoot);
          mkdirSync(workspaceRoot);
          writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
        }
        return true;
      },
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") started = true;
    });
    try {
      const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
      expect(postStartTrustChecks).toBe(2);
      expect(result.failureReason).toBe("denied");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(savedRoot, { recursive: true, force: true });
    }
  });

  it("materializes the manifest after the last central root-resolution callback", async () => {
    const spawn = vi.fn(makeSpawn());
    let started = false;
    let postStartRootChecks = 0;
    const manager = makeManager(spawn, {
      resolveWorkspaceRootAccess: (): WorkspaceRootAccess => {
        if (started && ++postStartRootChecks === 2) {
          writeFileSync(
            join(workspaceRoot, "package.json"),
            PACKAGE_JSON.replace("vitest run", "node attacker.js"),
            "utf8",
          );
        }
        return {
          kind: "ordinary",
          canonicalRoot: realpathSync(workspaceRoot),
          fs: nodeWorkspaceFs,
        };
      },
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") started = true;
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rechecks root identity after the final script-trust callback", async () => {
    const savedRoot = `${workspaceRoot}-saved`;
    const spawn = vi.fn(makeSpawn());
    let started = false;
    let replaced = false;
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: (): boolean => {
        if (started && !replaced) {
          renameSync(workspaceRoot, savedRoot);
          mkdirSync(workspaceRoot);
          writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
          replaced = true;
        }
        return true;
      },
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") started = true;
    });
    try {
      const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
      expect(result.failureReason).toBe("denied");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(savedRoot, { recursive: true, force: true });
    }
  });

  it("refuses root access revoked by a synchronous run-start subscriber", async () => {
    const spawn = vi.fn(makeSpawn());
    let accessLive = true;
    const manager = makeManager(spawn, {
      resolveWorkspaceRootAccess: (): WorkspaceRootAccess | undefined =>
        accessLive
          ? { kind: "ordinary", canonicalRoot: realpathSync(workspaceRoot), fs: nodeWorkspaceFs }
          : undefined,
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") accessLive = false;
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.inFlightCount()).toBe(0);
  });

  it("refuses a managed root rebound to a different repository before spawn", async () => {
    const spawn = vi.fn(makeSpawn());
    let repositoryRoot = workspaceRoot;
    const manager = makeManager(spawn, {
      resolveWorkspaceRootAccess: (): WorkspaceRootAccess => ({
        kind: "managed-task",
        canonicalRoot: realpathSync(workspaceRoot),
        fs: nodeWorkspaceFs,
        repositoryRoot,
      }),
    });
    manager.subscribe((event) => {
      if (event.kind === "run-started") repositoryRoot = "/different/repository";
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports technical caller-check causes without logging their messages or root", async () => {
    const record = vi.fn<ServerDiagnosticSink["record"]>();
    const spawn = vi.fn(makeSpawn());
    const manager = makeManager(spawn, { diagnostics: { record } });
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      beforeSpawn: (): never => {
        throw new TypeError(`private-marker ${workspaceRoot}`, {
          cause: new RangeError("private-cause"),
        });
      },
    });
    expect(result.failureReason).toBe("denied");
    expect(spawn).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    const diagnostic = record.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      operation: "command.before-spawn",
      code: "command-spawn-authority-revoked",
      diagnosticOutcome: "request-refused",
      causeChain: ["TypeError", "RangeError"],
    });
    expect(diagnostic?.frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("private-marker");
    expect(JSON.stringify(diagnostic)).not.toContain(workspaceRoot);
    expect(JSON.stringify(diagnostic)).not.toContain("private-cause");
  });

  it("preserves cancellation raised during the hidden caller check", async () => {
    const controller = new AbortController();
    const spawn = vi.fn(makeSpawn());
    const manager = makeManager(spawn);
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      signal: controller.signal,
      beforeSpawn: (): boolean => {
        controller.abort();
        return true;
      },
    });
    expect(result.failureReason).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.inFlightCount()).toBe(0);
  });

  it("keeps the hidden caller check outside the wire request vocabulary", () => {
    expect(
      parseCommandTaskRunRequest({
        projectId: workspaceRoot,
        taskId: "npm-script:test",
        beforeSpawn: true,
      }),
    ).toMatchObject({ ok: false });
  });

  it("runs normally when a server caller remains authorized through both checks", async () => {
    const spawn = vi.fn(makeSpawn());
    const manager = makeManager(spawn);
    const beforeSpawn = vi.fn(() => true);
    const result = await manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:test",
      beforeSpawn,
    });
    expect(result.failureReason).toBe("none");
    expect(beforeSpawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("denies repository-authored scripts before spawn unless the server trusts the workspace", async () => {
    const spawn = vi.fn<SpawnFn>(makeSpawn({ stdout: "should not run", exitCode: 0 }));
    const manager = makeManager(spawn, { isWorkspaceTrustedForPackageScripts: undefined });
    const events = collect(manager);
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "TASK_REQUIRES_TRUST", status: 403 });
    expect(spawn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("revalidates workspace trust after task derivation and denies drift before spawn", async () => {
    const spawn = vi.fn<SpawnFn>(makeSpawn({ stdout: "should not run", exitCode: 0 }));
    const trust = vi
      .fn<CommandRunnerWorkspaceTrustDecider>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const manager = makeManager(spawn, {
      isWorkspaceTrustedForPackageScripts: trust,
    });
    const events = collect(manager);

    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "TASK_REQUIRES_TRUST", status: 403 });

    expect(trust).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(manager.inFlightCount()).toBe(0);
  });

  it("runs an allowlisted task and reports a clean exit", async () => {
    const manager = makeManager(makeSpawn({ stdout: "all good\n", exitCode: 0 }));
    const events = collect(manager);
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.exitCode).toBe(0);
    expect(result.failureReason).toBe("none");
    expect(result.kind).toBe("test");
    expect(result.stdout).toContain("all good");
    expect(events.map((event) => event.kind)).toEqual(["run-started", "run-completed"]);
  });

  it("runs trusted repository scripts with no-network execution-root isolation by default", async () => {
    const spawn = vi.fn<SpawnFn>(makeSpawn({ stdout: "sandboxed\n", exitCode: 0 }));
    const manager = makeManager(spawn);

    await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });

    expect(spawn).toHaveBeenCalled();
    const [command, args] = spawn.mock.calls[0] ?? [];
    expect(command).toBe("bwrap");
    expect(args).toEqual(
      expect.arrayContaining([
        "--unshare-net",
        "--bind",
        realpathSync(workspaceRoot),
        "/keiko-execution-root",
        "--chdir",
        "/keiko-execution-root",
        "--",
        "npm",
        "run",
        "test",
      ]),
    );
  });

  it("reports a non-zero exit as a failed run, not an error", async () => {
    const manager = makeManager(makeSpawn({ stderr: "1 failing\n", exitCode: 1 }));
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toBe("non-zero-exit");
  });

  it("bounds output and flags truncation without freezing", async () => {
    const manager = makeManager(makeSpawn({ stdout: "x".repeat(50) }), {
      policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:build" });
    expect(result.truncated).toBe(true);
  });

  it("times out a hanging task", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }), {
      policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 20 },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:start" });
    expect(result.timedOut).toBe(true);
    expect(result.failureReason).toBe("timed-out");
  });

  it("cancels an in-flight run", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }));
    const events = collect(manager);
    const pending = manager.execute({
      projectId: workspaceRoot,
      taskId: "npm-script:start",
      requestId: "req-1",
    });
    const started = events.find((event) => event.kind === "run-started");
    expect(started).toBeDefined();
    const runId = started?.runId ?? "";
    expect(manager.abort(runId)).toBe(true);
    const result = await pending;
    expect(result.failureReason).toBe("cancelled");
    expect(events.some((event) => event.kind === "run-cancelled")).toBe(true);
  });

  it("maps a missing executable to a spawn-error result", async () => {
    const manager = makeManager(makeSpawn(), {
      runDeps: {
        resolveExecutable: (): string => {
          throw new CommandDeniedError("executable not found on PATH: npm", "npm");
        },
      },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.failureReason).toBe("spawn-error");
  });

  it("maps a policy denial to a denied result", async () => {
    const manager = makeManager(makeSpawn(), {
      runDeps: {
        resolveExecutable: (): string => {
          throw new CommandDeniedError("executable resolves inside workspace: npm", "npm");
        },
      },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(result.failureReason).toBe("denied");
  });

  it("rejects an unknown task id (only catalog tasks can run)", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: "npm-script:rm-rf" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("rejects execution for an unknown project", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({ projectId: "/no/such/project", taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("keeps fanning out events when one subscriber throws", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok", exitCode: 0 }));
    manager.subscribe(() => {
      throw new Error("subscriber boom");
    });
    const received: string[] = [];
    manager.subscribe((event) => received.push(event.kind));
    await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    expect(received).toEqual(["run-started", "run-completed"]);
  });

  it("enforces the concurrent-run limit", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }));
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i += 1) {
      pending.push(
        manager
          .execute({ projectId: workspaceRoot, taskId: "npm-script:start" })
          .catch(() => undefined),
      );
    }
    expect(manager.inFlightCount()).toBe(8);
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "RUN_LIMIT_EXCEEDED" });
  });
});

// ── runCommand termination evidence (AGENTS.md §8 Rule 1) ──────────────────────────
// A PR reviewer finding: the keiko-tools win32 taskkill.exe tree-kill decision shipped with no
// activity-log evidence anywhere. runCommand's onTerminated seam is wired here to this manager's
// injected activityLog port (defaulting to processServerLogSink() in production); this proves the
// wiring, not the seam itself — the seam's own reason/pid/tree-kill-outcome matrix is covered by
// packages/keiko-tools/src/exec.test.ts.
describe("CommandRunnerManager — runCommand termination evidence (AGENTS.md §8 Rule 1)", () => {
  it("logs command.terminated with the run's own correlationId on timeout", async () => {
    const events: ServerLogEvent[] = [];
    const manager = makeManager(makeSpawn({ hangs: true }), {
      policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 20 },
      activityLog: { write: (event): void => void events.push(event) },
    });
    const collected = collect(manager);
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:start" });
    expect(result.timedOut).toBe(true);
    const runId = collected.find((event) => event.kind === "run-started")?.runId ?? "";
    expect(runId).not.toBe("");
    const terminated = events.find((event) => event.op === "command.terminated");
    expect(terminated).toBeDefined();
    expect(terminated?.category).toBe("diagnostic");
    expect(terminated?.correlationId).toBe(runId);
    const extra = terminated?.extra ?? {};
    expect(extra.reason).toBe("timeout");
    expect(typeof extra.childPid).toBe("number");
    // makeManager pins platform:"linux" (line ~150) — the win32 tree-kill branch never engages.
    expect(extra.windowsTreeKill).toBe("not-attempted");
    // Body-free: exactly the three evidence fields — never the task id, executable, argv, or output.
    expect(Object.keys(extra).sort()).toEqual([
      "childPid",
      "completeness",
      "loss",
      "reason",
      "windowsTreeKill",
    ]);
    // THE REAL REDACTOR, not a fake sink (review 5058571583 finding 1): `pid` is a reserved
    // envelope name and redactLogFields drops it from `extra`, which is exactly how the child
    // identity silently vanished from every command.terminated line while the fake-sink tests
    // stayed green. Running the emitted extra through the shipped redactor pins the whole
    // reserved-name class: every evidence field must SURVIVE redaction.
    const redacted = redactLogFields(extra) ?? {};
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(extra).sort());
    expect(redacted.childPid).toBe(extra.childPid);
  });

  it("still completes a run and never throws when no activityLog is injected", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }), {
      policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 20 },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:start" });
    expect(result.timedOut).toBe(true);
  });
});

// ── Evidence ───────────────────────────────────────────────────────────────────────

describe("CommandRunnerManager — evidence", () => {
  it("persists a content-free run manifest (no args, no output)", async () => {
    const manager = makeManager(makeSpawn({ stdout: "super-secret-output-1234", exitCode: 0 }));
    const result = await manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" });
    const raw = evidenceStore.get(result.runId);
    expect(raw).toBeDefined();
    expect(raw).toContain('"command-run"');
    expect(raw).toContain('"executable": "npm"');
    // Neither the script output nor the run argv may appear in the audit manifest.
    expect(raw).not.toContain("super-secret-output-1234");
    expect(raw).not.toContain("vitest");
  });

  it("fails closed when evidence persistence is unavailable", async () => {
    const failing: EvidenceStore = {
      ...createInMemoryEvidenceStore(),
      put: (): string => {
        throw new Error("evidence write failed");
      },
    };
    const manager = makeManager(makeSpawn({ stdout: "ok", exitCode: 0 }), {
      evidenceStore: failing,
    });
    const events = collect(manager);
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "EVIDENCE_WRITE_FAILED", status: 500 });
    expect(events.map((event) => event.kind)).toEqual(["run-started"]);
  });

  it("fails closed when no evidence store is configured", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok", exitCode: 0 }), {
      evidenceStore: undefined,
    });
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ code: "EVIDENCE_WRITE_FAILED", status: 500 });
  });
});
