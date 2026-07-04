// Issue #1387 — CommandRunnerManager unit tests. Each test composes a fake SpawnFn so the manager
// exercises the real allowlist + discovery + cwd containment + redaction passthrough without a real
// child process. Route-level coverage lives in command-runner-routes.test.ts.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandDeniedError,
  DEFAULT_SANDBOX_POLICY,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { CommandRunnerEvent } from "@oscharko-dev/keiko-contracts";
import {
  createCommandRunnerManager,
  type CommandRunnerManager,
  type CommandRunnerManagerOptions,
} from "./command-runner.js";
import { CommandRunnerError } from "./command-runner-errors.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

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

// ── Discovery ─────────────────────────────────────────────────────────────────────

describe("CommandRunnerManager — discovery", () => {
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
    void pending;
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
