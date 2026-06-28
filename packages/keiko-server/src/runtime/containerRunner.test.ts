// Issue #1388 — ContainerRunnerManager + buildContainerRunArgv unit tests. Each execution test
// composes a FAKE SpawnFn so the manager exercises the real allowlist + frozen argv + redaction
// passthrough without a real container. The detector outcome is injected via `detect`. NO real
// Docker. Route-level coverage lives in containerRoutes.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandDeniedError,
  DEFAULT_SANDBOX_POLICY,
  isCommandAllowed,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import {
  CONTAINER_TASK_RULES,
  type ContainerCapabilityResponse,
  type ContainerRunnerEvent,
  type ContainerTask,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  buildContainerRunArgv,
  createContainerRunnerManager,
  DEFAULT_CONTAINER_EXECUTION_POLICY,
  DEFAULT_CONTAINER_TASKS,
  type ContainerRunnerManager,
  type ContainerRunnerManagerOptions,
} from "./containerRunner.js";
import { ContainerRunnerError } from "./containerRunner-errors.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";

// ── Fake spawn helpers (mirrors command-runner.test.ts) ──────────────────────────

interface FakeChildOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly hangs?: boolean;
}

const FAKE_CHILDREN = new Map<number, ChildProcess>();
let nextPid = 400_000;
let lastSpawnArgs: readonly string[] = [];

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
  return (_command, args) => {
    lastSpawnArgs = args;
    return fakeChild(opts);
  };
}

const AVAILABLE: ContainerCapabilityResponse = {
  schemaVersion: "1",
  generatedAtMs: 1,
  deadlineMs: 4_000,
  engines: [{ engine: "docker", state: "available", version: "24.0.7" }],
  anyAvailable: true,
};

const UNAVAILABLE: ContainerCapabilityResponse = {
  schemaVersion: "1",
  generatedAtMs: 1,
  deadlineMs: 4_000,
  engines: [{ engine: "docker", state: "missing", unavailableReason: "executable-not-found" }],
  anyAvailable: false,
};

// ── Fixture ────────────────────────────────────────────────────────────────────────

let workspaceRoot: string;
let store: UiStore;
let evidenceStore: EvidenceStore;

beforeEach(() => {
  ensureProcessKillPatched();
  FAKE_CHILDREN.clear();
  lastSpawnArgs = [];
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-ctr-"));
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
  overrides: Partial<ContainerRunnerManagerOptions> = {},
): ContainerRunnerManager {
  return createContainerRunnerManager({
    store,
    evidenceStore,
    processEnv: { PATH: "/usr/bin" },
    detect: () => Promise.resolve(AVAILABLE),
    runDeps: { spawn: spawnImpl, resolveExecutable: (command: string) => command },
    ...overrides,
  });
}

function collect(manager: ContainerRunnerManager): ContainerRunnerEvent[] {
  const events: ContainerRunnerEvent[] = [];
  manager.subscribe((event) => events.push(event));
  return events;
}

const PILOT_ID = "container-pilot:diagnostic";

// ── Policy / argv ────────────────────────────────────────────────────────────────

function pilotTask(): ContainerTask {
  const [task] = DEFAULT_CONTAINER_TASKS;
  if (task === undefined) {
    throw new Error("DEFAULT_CONTAINER_TASKS must ship the pilot task");
  }
  return task;
}

describe("buildContainerRunArgv — frozen hardened argv (LOAD-BEARING)", () => {
  const task = pilotTask();

  it("emits the EXACT frozen docker run argv", () => {
    const argv = buildContainerRunArgv(task, DEFAULT_CONTAINER_EXECUTION_POLICY, "/ws/root");
    expect(argv).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "536870912",
      "--cpus",
      "1",
      "--pull",
      "never",
      "-v",
      "/ws/root:/workspace:ro",
      "docker.io/library/alpine:3.20",
      "echo",
      "keiko-container-pilot ok",
    ]);
  });

  it("does NOT self-deny: the frozen argv PASSES isCommandAllowed(CONTAINER_TASK_RULES) (LOAD-BEARING)", () => {
    const argv = buildContainerRunArgv(task, DEFAULT_CONTAINER_EXECUTION_POLICY, "/ws/root");
    const decision = isCommandAllowed(CONTAINER_TASK_RULES, "docker", argv);
    expect(decision.allowed).toBe(true);
  });

  it("never emits the Docker socket path in the argv", () => {
    const argv = buildContainerRunArgv(task, DEFAULT_CONTAINER_EXECUTION_POLICY, "/ws/root");
    expect(argv.some((token) => token.includes("/var/run/docker.sock"))).toBe(false);
  });

  it("throws IMAGE_NOT_ALLOWED for a task whose image is not allowlisted", () => {
    const rogue: ContainerTask = { ...task, image: "evil/image:latest" };
    expect(() =>
      buildContainerRunArgv(rogue, DEFAULT_CONTAINER_EXECUTION_POLICY, "/ws/root"),
    ).toThrow(ContainerRunnerError);
  });
});

describe("CONTAINER_TASK_RULES — escalation flags denied (deny-list proof)", () => {
  // The server NEVER emits these; the closed catalog + frozen argv stop a client supplying them. The
  // deny list is belt-and-suspenders against a future regression that let one reach the argv.
  const escalations = [
    "--privileged",
    "--volume",
    "--mount",
    "--device",
    "--cap-add",
    "--net",
    "--pid",
    "--ipc",
    "--user",
    "-c",
  ];

  for (const flag of escalations) {
    it(`denies an argv containing ${flag}`, () => {
      const argv = ["run", flag, "x", "docker.io/library/alpine:3.20"];
      const decision = isCommandAllowed(CONTAINER_TASK_RULES, "docker", argv);
      expect(decision.allowed).toBe(false);
    });
  }

  it("denies the --flag=value form too", () => {
    const decision = isCommandAllowed(CONTAINER_TASK_RULES, "docker", [
      "run",
      "--volume=/etc:/etc",
      "docker.io/library/alpine:3.20",
    ]);
    expect(decision.allowed).toBe(false);
  });
});

// ── Execution outcomes (injected fake spawn) ──────────────────────────────────────

describe("ContainerRunnerManager — execution", () => {
  it("runs the catalog task and reports a clean exit", async () => {
    const manager = makeManager(makeSpawn({ stdout: "keiko-container-pilot ok\n", exitCode: 0 }));
    const events = collect(manager);
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.exitCode).toBe(0);
    expect(result.failureReason).toBe("none");
    expect(result.kind).toBe("diagnostic");
    expect(result.engine).toBe("docker");
    expect(result.stdout).toContain("keiko-container-pilot ok");
    expect(events.map((event) => event.kind)).toEqual(["run-started", "run-completed"]);
  });

  it("passes the frozen argv (with the workspace mount) to the spawn boundary", async () => {
    const manager = makeManager(makeSpawn({ exitCode: 0 }));
    await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(lastSpawnArgs[0]).toBe("run");
    expect(lastSpawnArgs).toContain("--network");
    expect(lastSpawnArgs).toContain("none");
    expect(lastSpawnArgs.some((arg) => arg.endsWith(":/workspace:ro"))).toBe(true);
    expect(lastSpawnArgs.some((arg) => arg.includes("/var/run/docker.sock"))).toBe(false);
  });

  it("maps a non-zero exit to non-zero-exit", async () => {
    const manager = makeManager(makeSpawn({ stderr: "boom\n", exitCode: 2 }));
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.exitCode).toBe(2);
    expect(result.failureReason).toBe("non-zero-exit");
  });

  it("maps a missing-image stderr to image-missing", async () => {
    const manager = makeManager(
      makeSpawn({ stderr: "Unable to find image 'alpine' locally: No such image\n", exitCode: 1 }),
    );
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.failureReason).toBe("image-missing");
  });

  it("maps a denied-pull stderr to pull-denied", async () => {
    const manager = makeManager(
      makeSpawn({ stderr: "Error: image must be present with pull policy never\n", exitCode: 1 }),
    );
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.failureReason).toBe("pull-denied");
  });

  it("maps a mount-failure stderr to mount-failure", async () => {
    const manager = makeManager(
      makeSpawn({
        stderr: "docker: Error response from daemon: invalid mount config\n",
        exitCode: 1,
      }),
    );
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.failureReason).toBe("mount-failure");
  });

  it("bounds output and flags output-capped truncation", async () => {
    const manager = makeManager(makeSpawn({ stdout: "x".repeat(50) }), {
      policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 4 },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.truncated).toBe(true);
    expect(result.failureReason).toBe("output-capped");
  });

  it("times out a hanging container run", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }), {
      policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 20 },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.timedOut).toBe(true);
    expect(result.failureReason).toBe("timed-out");
  });

  it("cancels an in-flight run via abort", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }));
    const events = collect(manager);
    const pending = manager.execute({
      projectId: workspaceRoot,
      taskId: PILOT_ID,
      requestId: "req-1",
    });
    // `execute` awaits the injected async capability probe before minting the run id, so the
    // run-started event lands on a later microtask; poll briefly until it fires.
    let started: ContainerRunnerEvent | undefined;
    for (let i = 0; i < 50 && started === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      started = events.find((event) => event.kind === "run-started");
    }
    expect(started).toBeDefined();
    expect(manager.abort(started?.runId ?? "")).toBe(true);
    const result = await pending;
    expect(result.failureReason).toBe("cancelled");
    expect(events.some((event) => event.kind === "run-cancelled")).toBe(true);
  });

  it("maps a policy denial to a denied result", async () => {
    const manager = makeManager(makeSpawn(), {
      runDeps: {
        resolveExecutable: (): string => {
          throw new CommandDeniedError("executable resolves inside workspace: docker", "docker");
        },
      },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.failureReason).toBe("denied");
  });

  it("maps a missing executable to a spawn-error result", async () => {
    const manager = makeManager(makeSpawn(), {
      runDeps: {
        resolveExecutable: (): string => {
          throw new CommandDeniedError("executable not found on PATH: docker", "docker");
        },
      },
    });
    const result = await manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID });
    expect(result.failureReason).toBe("spawn-error");
  });
});

// ── Governance / pilot path ────────────────────────────────────────────────────────

describe("ContainerRunnerManager — governance", () => {
  it("THROWS CONTAINER_ENGINE_UNAVAILABLE before minting a run id when no engine is available", async () => {
    const spawn = vi.fn<SpawnFn>(makeSpawn());
    const manager = makeManager(spawn, {
      detect: () => Promise.resolve(UNAVAILABLE),
    });
    const events = collect(manager);
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID }),
    ).rejects.toMatchObject({ code: "CONTAINER_ENGINE_UNAVAILABLE" });
    expect(spawn).not.toHaveBeenCalled(); // NO spawn attempted
    expect(events).toHaveLength(0); // no run-started; no run was minted
  });

  it("throws TASK_NOT_FOUND for an unknown task id", async () => {
    await expect(
      makeManager().execute({ projectId: workspaceRoot, taskId: "no-such" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("throws PROJECT_NOT_FOUND for an unknown project", async () => {
    await expect(
      makeManager().execute({ projectId: "/no/such/project", taskId: PILOT_ID }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("throws IMAGE_NOT_ALLOWED when a catalog task image is not allowlisted", async () => {
    const manager = makeManager(makeSpawn(), {
      catalog: [
        {
          id: PILOT_ID,
          kind: "diagnostic",
          label: "rogue",
          image: "evil/image:latest",
          args: ["true"],
          engine: "docker",
        },
      ],
    });
    await expect(
      manager.execute({ projectId: workspaceRoot, taskId: PILOT_ID }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_ALLOWED" });
  });

  it("lists the catalog when an engine is available and an empty catalog when not", async () => {
    const available = makeManager();
    const catalog = await available.listCatalog(workspaceRoot);
    expect(catalog.engineAvailable).toBe(true);
    expect(catalog.tasks.map((task) => task.id)).toContain(PILOT_ID);

    const none = makeManager(makeSpawn(), { detect: () => Promise.resolve(UNAVAILABLE) });
    const empty = await none.listCatalog(workspaceRoot);
    expect(empty.engineAvailable).toBe(false);
    expect(empty.tasks).toEqual([]);
  });
});
