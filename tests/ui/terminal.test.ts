// ADR-0018 — TerminalExecutionManager unit tests. Each test composes a fake SpawnFn so the
// manager exercises the real allowlist + cwd containment + redaction passthrough without a real
// child process. Route-level coverage lives in terminal-routes.test.ts.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEvidence, loadEvidence } from "../../src/audit/index-api.js";
import {
  createTerminalExecutionManager,
  type TerminalEventEnvelope,
  type TerminalExecutionManager,
} from "../../src/ui/terminal.js";
import {
  createInMemoryEvidenceStore,
  type EvidenceStore,
} from "../../src/audit/store.js";
import { createInMemoryUiStore, type UiStore } from "../../src/ui/store/index.js";
import { TerminalToolError } from "../../src/ui/terminal-errors.js";
import type { SpawnFn } from "../../src/tools/exec.js";

// ── Fake spawn helpers ─────────────────────────────────────────────────────────

interface FakeChildOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly hangs?: boolean;
}

// Registry mapping pid → fakeChild emitter so the patched process.kill below can deliver
// SIGTERM/SIGKILL into the fake's `close` emission. The real process.kill on a synthetic pid
// (we never spawn a real process) would always throw ESRCH; this mock makes the abort/timeout
// settle paths in runCommand reach their reject branch.
const FAKE_CHILDREN = new Map<number, ChildProcess>();
let nextPid = 100_000;

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
  const killImpl = (): boolean => {
    setImmediate(() => {
      emitter.emit("close", null, "SIGTERM");
    });
    return true;
  };
  emitter.kill = killImpl;
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
    setTimeout(
      () => {
        emitter.emit("close", opts.exitCode ?? 0, null);
        FAKE_CHILDREN.delete(pid);
      },
      opts.delayMs ?? 0,
    );
  });
  return emitter;
}

// Patch process.kill so killGroup(-pid, sig) on a fake pid emits 'close' on the fake instead of
// throwing ESRCH. Real-process kills (positive pid not in the registry) fall back to the original.
const realProcessKill = process.kill.bind(process);
let processKillPatched = false;
function ensureProcessKillPatched(): void {
  if (processKillPatched) return;
  processKillPatched = true;
  vi.spyOn(process, "kill").mockImplementation(
    ((pid: number, signal?: string | number): true => {
      const positivePid = Math.abs(pid);
      const child = FAKE_CHILDREN.get(positivePid);
      if (child !== undefined) {
        FAKE_CHILDREN.delete(positivePid);
        setImmediate(() => {
          child.emit("close", null, signal ?? "SIGTERM");
        });
        return true;
      }
      return realProcessKill(pid, signal);
    }),
  );
}

function makeSpawn(opts: FakeChildOptions = {}): SpawnFn {
  return (_command, _args, _options) => fakeChild(opts);
}

function makeFailingEvidenceStore(): EvidenceStore {
  return {
    ...createInMemoryEvidenceStore(),
    put: (): string => {
      throw new Error("evidence write failed");
    },
  };
}

// ── Test fixture ───────────────────────────────────────────────────────────────

let workspaceRoot: string;
let store: UiStore;
let evidenceStore: EvidenceStore;
let outsideRoots: string[];

beforeEach(() => {
  ensureProcessKillPatched();
  FAKE_CHILDREN.clear();
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-term-"));
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "test-project");
  evidenceStore = createInMemoryEvidenceStore();
  outsideRoots = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  processKillPatched = false;
  store.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
  for (const root of outsideRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeManager(
  spawnImpl: SpawnFn = makeSpawn(),
  extra: { processEnv?: NodeJS.ProcessEnv } = {},
): TerminalExecutionManager {
  return createTerminalExecutionManager({
    store,
    evidenceStore,
    processEnv: extra.processEnv ?? { PATH: "/usr/bin" },
    runDeps: {
      spawn: spawnImpl,
      resolveExecutable: (command: string) => command,
    },
  });
}

function collect(manager: TerminalExecutionManager): TerminalEventEnvelope[] {
  const events: TerminalEventEnvelope[] = [];
  manager.subscribe((event) => {
    events.push(event);
  });
  return events;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("TerminalExecutionManager — happy path", () => {
  it("runs an allowed command, returns redacted output, emits start+complete events", async () => {
    const manager = makeManager(makeSpawn({ stdout: "hello\n", exitCode: 0 }));
    const events = collect(manager);
    const result = await manager.execute({
      projectId: workspaceRoot,
      command: "ls",
      args: ["-la"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["execution-started", "execution-completed"]);
    expect(evidenceStore.list()).toHaveLength(1);
  });

  it("emits execution-started strictly before execution-completed", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok" }));
    const events = collect(manager);
    await manager.execute({ projectId: workspaceRoot, command: "pwd", args: [] });
    expect(events[0]?.kind).toBe("execution-started");
    expect(events[1]?.kind).toBe("execution-completed");
  });

  it("allows scalar option values for permitted read-only commands", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok" }));
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "head", args: ["-n", "10", "file.txt"] }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "tail", args: ["-n", "5", "file.txt"] }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "tree", args: ["-L", "2"] }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("allows grep exclusion files inside the selected project without consuming the pattern", async () => {
    writeFileSync(join(workspaceRoot, "patterns.txt"), "node_modules\n", "utf8");
    const manager = makeManager(makeSpawn({ stdout: "ok" }));
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "grep",
        args: ["--exclude-from", "patterns.txt", "needle", "."],
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("TerminalExecutionManager — denials and validation", () => {
  it("rejects a command not on the allowlist (COMMAND_DENIED)", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "rm", args: ["-rf", "/"] }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it("rejects cwd outside the project (CWD_OUTSIDE_PROJECT)", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "ls",
        args: [],
        cwd: "/tmp/outside",
      }),
    ).rejects.toMatchObject({ code: "CWD_OUTSIDE_PROJECT" });
  });

  it("rejects an unknown projectId (PROJECT_NOT_FOUND)", async () => {
    const manager = makeManager();
    const rejection = manager.execute({
      projectId: "/no/such/project",
      command: "ls",
      args: [],
    });
    await expect(rejection).rejects.toBeInstanceOf(TerminalToolError);
    await expect(rejection).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("denies find -exec via Layer 2 even though find is on the allowlist", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "find",
        args: [".", "-exec", "rm", "{}", ";"],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it("rejects an absolute file path operand outside the selected project before spawn", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-term-outside-"));
    outsideRoots.push(outside);
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "secret\n", "utf8");
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "cat",
        args: [outsideFile],
      }),
    ).rejects.toMatchObject({ code: "CWD_OUTSIDE_PROJECT" });
  });

  it("rejects a symlink operand whose real target escapes the selected project before spawn", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-term-outside-"));
    outsideRoots.push(outside);
    const outsideFile = join(outside, "secret.txt");
    const symlinkPath = join(workspaceRoot, "leak.txt");
    writeFileSync(outsideFile, "secret\n", "utf8");
    symlinkSync(outsideFile, symlinkPath);
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "cat",
        args: [symlinkPath],
      }),
    ).rejects.toMatchObject({ code: "CWD_OUTSIDE_PROJECT" });
  });

  it("rejects git -C / status even though the subcommand is otherwise read-only", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "git",
        args: ["-C", "/", "status"],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it("rejects npm --prefix outside the selected project before spawn", async () => {
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "npm",
        args: ["--prefix", "/tmp", "ls"],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it("rejects find path-bearing predicates outside the selected project before spawn", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-term-outside-"));
    outsideRoots.push(outside);
    const outsideFile = join(outside, "reference.txt");
    writeFileSync(outsideFile, "secret\n", "utf8");
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "find",
        args: [".", "-newer", outsideFile],
      }),
    ).rejects.toMatchObject({ code: "CWD_OUTSIDE_PROJECT" });
  });

  it("rejects grep file-bearing flags outside the selected project before spawn", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-term-outside-"));
    outsideRoots.push(outside);
    const outsideFile = join(outside, "patterns.txt");
    writeFileSync(outsideFile, "secret\n", "utf8");
    const manager = makeManager();
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "grep",
        args: [`--exclude-from=${outsideFile}`, "secret", "."],
      }),
    ).rejects.toMatchObject({ code: "CWD_OUTSIDE_PROJECT" });
  });
});

describe("TerminalExecutionManager — cancel/timeout/concurrency", () => {
  it("cancels an in-flight execution via abort()", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }));
    const events = collect(manager);
    const pending = manager.execute({ projectId: workspaceRoot, command: "ls", args: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const started = events.find((e) => e.kind === "execution-started");
    expect(started).toBeDefined();
    expect(manager.abort(started?.executionId ?? "")).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(events.some((e) => e.kind === "execution-cancelled")).toBe(true);
  });

  it("times out per the policy ceiling — HTTP throws TIMEOUT, SSE emits execution-completed{timedOut:true} (D7)", async () => {
    const manager = createTerminalExecutionManager({
      store,
      evidenceStore,
      policy: {
        envAllowlist: ["PATH"],
        network: "inherit",
        maxOutputBytes: 1024,
        defaultTimeoutMs: 50,
        terminationGraceMs: 10,
      },
      processEnv: { PATH: "/usr/bin" },
      runDeps: {
        spawn: makeSpawn({ hangs: true }),
        resolveExecutable: (command) => command,
      },
    });
    const events = collect(manager);
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "ls", args: [] }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    // ADR-0018 D7: timeout is "completed with timedOut=true", never "execution-failed".
    expect(events.map((e) => e.kind)).toEqual(["execution-started", "execution-completed"]);
    const completed = events.find((e) => e.kind === "execution-completed");
    const payload = completed?.payload as Record<string, unknown>;
    expect(payload.timedOut).toBe(true);
    expect(payload.exitCode).toBeNull();
    expect(events.some((e) => e.kind === "execution-failed")).toBe(false);
  });

  it("rejects when MAX_CONCURRENT_EXECUTIONS is reached (D9 cap of 8)", async () => {
    const manager = makeManager(makeSpawn({ hangs: true }));
    const events = collect(manager);
    const pendings: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i += 1) {
      pendings.push(
        manager
          .execute({ projectId: workspaceRoot, command: "ls", args: [] })
          .catch(() => undefined),
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "ls", args: [] }),
    ).rejects.toMatchObject({ code: "EXECUTION_LIMIT_EXCEEDED" });
    for (const e of events) {
      if (e.kind === "execution-started") {
        manager.abort(e.executionId);
      }
    }
    await Promise.all(pendings);
  });
});

describe("TerminalExecutionManager — evidence persistence", () => {
  it("fails closed when evidence persistence throws", async () => {
    evidenceStore = makeFailingEvidenceStore();
    const manager = makeManager(makeSpawn({ stdout: "ok\n" }));
    const events = collect(manager);
    await expect(
      manager.execute({
        projectId: workspaceRoot,
        command: "pwd",
        args: [],
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_WRITE_FAILED" });
    expect(events.map((event) => event.kind)).toEqual(["execution-started", "execution-failed"]);
    expect(events[1]?.payload).toMatchObject({ code: "EVIDENCE_WRITE_FAILED" });
  });

  it("emits a terminal SSE failure when evidence persistence fails after command timeout", async () => {
    evidenceStore = makeFailingEvidenceStore();
    const manager = createTerminalExecutionManager({
      store,
      evidenceStore,
      policy: {
        envAllowlist: ["PATH"],
        network: "inherit",
        maxOutputBytes: 1024,
        defaultTimeoutMs: 50,
        terminationGraceMs: 10,
      },
      processEnv: { PATH: "/usr/bin" },
      runDeps: {
        spawn: makeSpawn({ hangs: true }),
        resolveExecutable: (command) => command,
      },
    });
    const events = collect(manager);
    await expect(
      manager.execute({ projectId: workspaceRoot, command: "ls", args: [] }),
    ).rejects.toMatchObject({ code: "EVIDENCE_WRITE_FAILED" });
    expect(events.map((event) => event.kind)).toEqual(["execution-started", "execution-failed"]);
    expect(events[1]?.payload).toMatchObject({ code: "EVIDENCE_WRITE_FAILED" });
  });

  it("writes terminal evidence as a standard manifest parseable by listEvidence/loadEvidence", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok\n" }));
    const result = await manager.execute({
      projectId: workspaceRoot,
      command: "pwd",
      args: [],
    });
    const entries = listEvidence(evidenceStore);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe(result.executionId);
    expect(entries[0]?.taskType).toBe("terminal-execution");
    const manifest = loadEvidence(evidenceStore, result.executionId);
    expect(manifest?.run.runId).toBe(result.executionId);
    expect(manifest?.run.taskType).toBe("terminal-execution");
    expect(manifest?.commandExecutions[0]?.executable).toBe("pwd");
  });
});

describe("TerminalExecutionManager — redaction and evidence", () => {
  it("Layer 1: redacts env values that appear in command output", async () => {
    const manager = makeManager(makeSpawn({ stdout: "secret-token-1234567" }), {
      processEnv: { PATH: "/usr/bin", MY_SECRET: "secret-token-1234567" },
    });
    const result = await manager.execute({
      projectId: workspaceRoot,
      command: "echo",
      args: ["x"],
    });
    expect(result.stdout).not.toContain("secret-token-1234567");
  });

  it("Layer 2: applies the audit redactor to evidence before persist", async () => {
    let redactCalls = 0;
    const recordingRedactor = (input: string): string => {
      redactCalls += 1;
      return input;
    };
    const manager = createTerminalExecutionManager({
      store,
      evidenceStore,
      processEnv: { PATH: "/usr/bin" },
      redactor: recordingRedactor,
      runDeps: {
        spawn: makeSpawn({ stdout: "ok", exitCode: 0 }),
        resolveExecutable: (command) => command,
      },
    });
    await manager.execute({ projectId: workspaceRoot, command: "ls", args: [] });
    expect(redactCalls).toBeGreaterThan(0);
    expect(evidenceStore.list()).toHaveLength(1);
  });

  it("evidence entry never includes args or output bytes", async () => {
    const manager = makeManager(makeSpawn({ stdout: "secret-output", exitCode: 0 }));
    await manager.execute({
      projectId: workspaceRoot,
      command: "grep",
      args: ["secret-pattern", "file.txt"],
    });
    const list = evidenceStore.list();
    expect(list).toHaveLength(1);
    const firstId = list[0] ?? "";
    const json = evidenceStore.get(firstId);
    expect(json).toBeDefined();
    expect(json).not.toContain("secret-output");
    expect(json).not.toContain("secret-pattern");
    expect(json).not.toContain("file.txt");
  });
});

describe("TerminalExecutionManager — SSE event shape (ADR-0018 D7)", () => {
  it("execution-started carries projectId, command, argCount, startedAt — never args", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok" }));
    const events = collect(manager);
    await manager.execute({
      projectId: workspaceRoot,
      command: "grep",
      args: ["pattern", "file.txt"],
    });
    const started = events.find((e) => e.kind === "execution-started");
    expect(started).toBeDefined();
    const payload = started?.payload as Record<string, unknown>;
    expect(payload.projectId).toBe(workspaceRoot);
    expect(payload.command).toBe("grep");
    expect(payload.argCount).toBe(2);
    expect(payload).not.toHaveProperty("args");
    expect(typeof payload.startedAt).toBe("number");
  });

  it("execution-completed carries byte counts, not output bytes", async () => {
    const manager = makeManager(makeSpawn({ stdout: "hello", stderr: "world", exitCode: 0 }));
    const events = collect(manager);
    await manager.execute({ projectId: workspaceRoot, command: "ls", args: [] });
    const done = events.find((e) => e.kind === "execution-completed");
    expect(done).toBeDefined();
    const payload = done?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("stdout");
    expect(payload).not.toHaveProperty("stderr");
    expect(payload.stdoutByteLength).toBe(5);
    expect(payload.stderrByteLength).toBe(5);
    expect(payload.exitCode).toBe(0);
  });
});

describe("TerminalExecutionManager — subscribe lifecycle", () => {
  it("subscribe returns an unsubscribe that stops fan-out", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok" }));
    const received: TerminalEventEnvelope[] = [];
    const unsubscribe = manager.subscribe((event) => {
      received.push(event);
    });
    unsubscribe();
    await manager.execute({ projectId: workspaceRoot, command: "ls", args: [] });
    expect(received).toHaveLength(0);
  });

  it("a throwing subscriber does not break fan-out to others", async () => {
    const manager = makeManager(makeSpawn({ stdout: "ok" }));
    const ok: TerminalEventEnvelope[] = [];
    manager.subscribe(() => {
      throw new Error("boom");
    });
    manager.subscribe((event) => {
      ok.push(event);
    });
    await manager.execute({ projectId: workspaceRoot, command: "ls", args: [] });
    expect(ok.length).toBeGreaterThan(0);
  });
});
