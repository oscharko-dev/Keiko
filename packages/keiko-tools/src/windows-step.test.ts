import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { WindowsStepSupervisor } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_SANDBOX_POLICY } from "./types.js";
import { makeWorkspace } from "./_support.js";
import { CommandCancelledError, CommandDeniedError } from "./errors.js";
import { runCommand, type RunCommandDeps, type SpawnOptions } from "./exec.js";
import {
  quoteWindowsArgument,
  windowsStepFrames,
  windowsStepGrants,
  WindowsStepResponses,
  type WindowsStepLaunch,
} from "./windows-step.js";

function response(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write("KRS1", 0, "ascii");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(kind, 6);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function reaped(exitCode: number, active = 0): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(exitCode, 0);
  payload.writeUInt32LE(active, 4);
  return response(2, payload);
}

function refused(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16LE(code, 0);
  return response(3, payload);
}

const LAUNCHED = response(1, Buffer.alloc(8));

describe("quoteWindowsArgument", () => {
  it("quotes as the Microsoft C runtime reads it back", () => {
    expect(quoteWindowsArgument("plain")).toBe('"plain"');
    expect(quoteWindowsArgument("")).toBe('""');
    expect(quoteWindowsArgument("two words")).toBe('"two words"');
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArgument(String.raw`C:\dir\ `)).toBe(String.raw`"C:\dir\ "`);
    expect(quoteWindowsArgument(String.raw`C:\dir\\`)).toBe(String.raw`"C:\dir\\\\"`);
    expect(quoteWindowsArgument(String.raw`a\"b`)).toBe(String.raw`"a\\\"b"`);
  });
});

describe("windowsStepGrants", () => {
  const root = String.raw`C:\Users\dev\work\repo`;

  it("grants the execution root for modification and the executable's folder for reading", () => {
    expect(
      windowsStepGrants(
        root,
        String.raw`C:\Users\dev\AppData\Local\Programs\nodejs\node.exe`,
        [String.raw`C:\Users\dev\AppData\Local\Programs\jdk-21`],
        "node",
      ),
    ).toEqual([
      { path: root, access: "modify", principal: "tree" },
      {
        path: String.raw`C:\Users\dev\AppData\Local\Programs\nodejs`,
        access: "read",
        principal: "tree",
      },
      {
        path: String.raw`C:\Users\dev\AppData\Local\Programs\jdk-21`,
        access: "read",
        principal: "tree",
      },
    ]);
  });

  it("adds nothing for a folder an earlier grant already covers", () => {
    expect(
      windowsStepGrants(
        root,
        String.raw`C:\Users\dev\work\repo\node_modules\.bin\tool.exe`,
        [String.raw`C:\Users\dev\work\repo\vendor`],
        "tool",
      ),
    ).toEqual([{ path: root, access: "modify", principal: "tree" }]);
  });

  it("grants a JDK or Maven from its bin folder's parent", () => {
    expect(
      windowsStepGrants(root, String.raw`C:\Users\dev\Programs\maven\bin\mvn.cmd`, [], "mvn"),
    ).toContainEqual({
      path: String.raw`C:\Users\dev\Programs\maven`,
      access: "read",
      principal: "tree",
    });
  });

  it("refuses a grant that holds the whole user profile", () => {
    const profile = String.raw`C:\Users\dev`;
    expect(() =>
      windowsStepGrants(root, String.raw`C:\Users\dev\node.exe`, [], "node", profile),
    ).toThrow(/whole user profile/u);
    expect(() =>
      windowsStepGrants(root, String.raw`C:\t\x.exe`, [String.raw`C:\Users`], "x", profile),
    ).toThrow(/whole user profile/u);
    expect(() => windowsStepGrants(profile, String.raw`C:\t\x.exe`, [], "x", profile)).toThrow(
      /whole user profile/u,
    );
    expect(
      windowsStepGrants(root, String.raw`C:\Users\dev\Programs\node\node.exe`, [], "node", profile),
    ).toHaveLength(2);
  });

  it("refuses a relative read root and more folders than one tree may be granted", () => {
    expect(() => windowsStepGrants(root, String.raw`C:\t\x.exe`, ["relative"], "x")).toThrow(
      CommandDeniedError,
    );
    const many = Array.from({ length: 8 }, (_, index) => `C:\\tools\\t${String(index)}`);
    expect(() => windowsStepGrants(root, String.raw`C:\t\x.exe`, many, "x")).toThrow(
      CommandDeniedError,
    );
  });
});

describe("windowsStepFrames", () => {
  it("sends the launch, then the grants, and leaves out a name the packet cannot carry", () => {
    const launch: WindowsStepLaunch = {
      image: String.raw`C:\tools\node.exe`,
      args: ['"-v"'],
      grants: [{ path: String.raw`C:\work`, access: "modify", principal: "tree" }],
      recoveryHandle: "0123456789abcdef0123456789abcdef",
    };
    const frames = windowsStepFrames(launch, String.raw`C:\work`, {
      PATH: String.raw`C:\tools`,
      "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
    });
    expect(frames.subarray(0, 4).toString("ascii")).toBe("KRP1");
    const grantsAt = 12 + frames.readUInt32LE(8);
    expect(frames.subarray(grantsAt, grantsAt + 4).toString("ascii")).toBe("KGG1");
    const launchText = frames.subarray(0, grantsAt).toString("utf8");
    expect(launchText).toContain("PATH");
    expect(launchText).not.toContain("ProgramFiles(x86)");
  });

  it("lets Node.js resolve through the given path, before the run's own options", () => {
    const launch: WindowsStepLaunch = {
      image: String.raw`C:\tools\node.exe`,
      args: [],
      grants: [],
      recoveryHandle: "0123456789abcdef0123456789abcdef",
    };
    const text = (env: Record<string, string>): string =>
      windowsStepFrames(launch, String.raw`C:\work`, env).toString("utf8");
    expect(text({})).toContain("--preserve-symlinks --preserve-symlinks-main");
    expect(text({ NODE_OPTIONS: "--openssl-legacy-provider" })).toContain(
      "--preserve-symlinks --preserve-symlinks-main --openssl-legacy-provider",
    );
  });
});

describe("WindowsStepResponses", () => {
  it("reads frames split across chunks; the last complete one decides", () => {
    const responses = new WindowsStepResponses();
    const bytes = Buffer.concat([LAUNCHED, reaped(3, 0)]);
    responses.feed(bytes.subarray(0, 5));
    expect(responses.answer()).toEqual({ kind: "pending" });
    responses.feed(bytes.subarray(5, 21));
    expect(responses.answer()).toEqual({ kind: "launched" });
    responses.feed(bytes.subarray(21));
    expect(responses.answer()).toEqual({ kind: "reaped", exitCode: 3, activeProcesses: 0 });
  });

  it("names a refusal and rejects another magic or an oversized payload", () => {
    const refusal = new WindowsStepResponses();
    refusal.feed(refused(8));
    expect(refusal.answer()).toEqual({ kind: "refused", code: 8 });
    const magic = new WindowsStepResponses();
    magic.feed(Buffer.concat([Buffer.from("KRX1"), Buffer.alloc(8)]));
    expect(magic.answer()).toEqual({ kind: "malformed" });
    const oversized = new WindowsStepResponses();
    const header = response(2, Buffer.alloc(0));
    header.writeUInt32LE(65, 8);
    oversized.feed(header);
    expect(oversized.answer()).toEqual({ kind: "malformed" });
  });
});

interface SupervisedChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: (PassThrough | null)[];
  pid: number;
  killed: string[];
  kill: (signal?: string) => boolean;
}

function supervisedChild(): SupervisedChild {
  const child = new EventEmitter() as SupervisedChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  child.pid = 4343;
  child.killed = [];
  child.kill = (signal?: string): boolean => {
    child.killed.push(signal ?? "SIGTERM");
    return true;
  };
  return child;
}

function control(child: SupervisedChild): PassThrough {
  const stream = child.stdio[3];
  if (stream === null || stream === undefined) throw new Error("no control stream");
  return stream;
}

function answers(child: SupervisedChild): PassThrough {
  const stream = child.stdio[4];
  if (stream === null || stream === undefined) throw new Error("no answer stream");
  return stream;
}

interface Harness {
  readonly deps: RunCommandDeps;
  readonly child: SupervisedChild;
  readonly spawned: { command: string; args: readonly string[]; options: SpawnOptions }[];
  readonly released: () => number;
  readonly treeKills: () => number;
  readonly written: () => Buffer;
}

function harness(): Harness {
  const { info } = makeWorkspace();
  const child = supervisedChild();
  const spawned: Harness["spawned"] = [];
  const chunks: Buffer[] = [];
  control(child).on("data", (chunk: Buffer) => chunks.push(chunk));
  let released = 0;
  let treeKills = 0;
  const supervisor: WindowsStepSupervisor = {
    acquire: () => ({
      path: String.raw`C:\Temp\keiko-native-runtime-x\keiko-runtime-supervisor.exe`,
      release: (): void => {
        released++;
      },
    }),
    readRoots: [],
  };
  const deps: RunCommandDeps = {
    workspace: info,
    policy: { ...DEFAULT_SANDBOX_POLICY, network: "none", filesystem: "execution-root" },
    commandRules: [{ executable: "node" }],
    spawn: (command, args, options): ChildProcess => {
      spawned.push({ command, args: [...args], options });
      return child as unknown as ChildProcess;
    },
    resolveExecutable: () => String.raw`C:\tools\node\node.exe`,
    processEnv: { PATH: String.raw`C:\tools\node`, SystemRoot: String.raw`C:\Windows` },
    now: () => 0,
    platform: "win32",
    killWindowsTree: () => {
      treeKills++;
      return "succeeded";
    },
    sandboxAvailability: {
      bubblewrap: false,
      unshare: false,
      seatbelt: false,
      docker: false,
      podman: false,
    },
    windowsStepSupervisor: supervisor,
  };
  return {
    deps,
    child,
    spawned,
    released: () => released,
    treeKills: () => treeKills,
    written: () => Buffer.concat(chunks),
  };
}

function input(signal: AbortSignal): Parameters<typeof runCommand>[0] {
  return { command: "node", args: ["-e", "x"], cwd: undefined, timeoutMs: undefined, signal };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("runCommand on the windows-appcontainer backend (#4496)", () => {
  it("frames the step to the supervisor and reports the exit code it reaped", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.args).toEqual(["--step-supervised"]);
    expect(h.spawned[0]?.options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", "pipe"]);
    expect(h.written().subarray(0, 4).toString("ascii")).toBe("KRP1");
    expect(h.written().includes(Buffer.from("KGG1"))).toBe(true);
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(3)]));
    await settled();
    h.child.emit("close", 0, null);
    const result = await run;
    expect(result.exitCode).toBe(3);
    expect(result.attestation).toEqual({
      backend: "windows-appcontainer",
      networkEnforced: true,
      filesystemEnforced: true,
      platform: "win32",
    });
    expect(h.released()).toBe(1);
  });

  it("refuses a step the supervisor refused, naming the closed reason", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    answers(h.child).write(refused(8));
    await settled();
    h.child.emit("close", 1, null);
    await expect(run).rejects.toThrow(/outside Program Files/u);
    await expect(run).rejects.toBeInstanceOf(CommandDeniedError);
    expect(h.released()).toBe(1);
  });

  it("never calls an error after the launch a refusal: the step ran", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    answers(h.child).write(Buffer.concat([LAUNCHED, refused(10)]));
    await settled();
    h.child.emit("close", 1, null);
    await expect(run).rejects.toThrow(/failed after the step started \(10\)/u);
    await expect(run).rejects.not.toBeInstanceOf(CommandDeniedError);
    expect(h.released()).toBe(1);
  });

  it("fails a supervisor that ended without reporting the step", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    h.child.emit("close", 1, null);
    await expect(run).rejects.toThrow(/without reporting the step's exit/u);
  });

  it("survives a failing answer pipe; the supervisor's answer still decides", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    answers(h.child).emit("error", Object.assign(new Error("read ENOTCONN"), { code: "ENOTCONN" }));
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(0)]));
    await settled();
    h.child.emit("close", 0, null);
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
  });

  it("reports an output flood as truncated even when the supervisor ends before reaping", async () => {
    const h = harness();
    const deps: RunCommandDeps = { ...h.deps, policy: { ...h.deps.policy, maxOutputBytes: 8 } };
    const run = runCommand(input(new AbortController().signal), deps);
    await settled();
    answers(h.child).write(LAUNCHED);
    h.child.stdout.write("x".repeat(64));
    await settled();
    h.child.emit("close", 1, null);
    await expect(run).resolves.toMatchObject({ exitCode: 1, truncated: true });
  });

  it("ends a cancelled step through the supervisor, not by killing it", async () => {
    const h = harness();
    const abort = new AbortController();
    const run = runCommand(input(abort.signal), h.deps);
    await settled();
    const before = h.written().length;
    abort.abort();
    await settled();
    expect(h.written().subarray(before).toString("ascii", 0, 4)).toBe("KRC1");
    expect(h.written().readUInt16LE(before + 6)).toBe(3);
    expect(h.child.killed).toEqual([]);
    expect(h.treeKills()).toBe(0);
    h.child.emit("close", 0, null);
    await expect(run).rejects.toBeInstanceOf(CommandCancelledError);
    expect(h.released()).toBe(1);
  });

  it("starts no supervisor whose frames cannot be encoded, and releases its copy", async () => {
    const h = harness();
    const run = runCommand(
      { ...input(new AbortController().signal), args: ["-e", "x".repeat(5000)] },
      h.deps,
    );
    await expect(run).rejects.toThrow();
    expect(h.spawned).toEqual([]);
    expect(h.released()).toBe(1);
  });

  it("releases the supervisor copy when the spawn itself fails", async () => {
    const h = harness();
    const deps: RunCommandDeps = {
      ...h.deps,
      spawn: (): ChildProcess => {
        throw new Error("spawn refused");
      },
    };
    await expect(runCommand(input(new AbortController().signal), deps)).rejects.toThrow(
      "spawn refused",
    );
    expect(h.released()).toBe(1);
  });

  it("leaves a step to a present container runtime and never takes a supervisor copy", async () => {
    const h = harness();
    const deps: RunCommandDeps = {
      ...h.deps,
      sandboxAvailability: { ...h.deps.sandboxAvailability, docker: true } as NonNullable<
        RunCommandDeps["sandboxAvailability"]
      >,
    };
    await runCommand(input(new AbortController().signal), deps).catch(() => undefined);
    expect(h.spawned.every((call) => !call.command.includes("keiko-runtime-supervisor"))).toBe(
      true,
    );
    expect(h.released()).toBe(0);
  });

  it("keeps the earlier backends when no supervisor is given", async () => {
    const h = harness();
    const { windowsStepSupervisor: _omitted, ...withoutSupervisor } = h.deps;
    const run = runCommand(input(new AbortController().signal), withoutSupervisor).catch(
      () => undefined,
    );
    await settled();
    if (h.spawned.length > 0) h.child.emit("close", 0, null);
    await run;
    expect(h.spawned.every((call) => !call.command.includes("keiko-runtime-supervisor"))).toBe(
      true,
    );
    expect(h.spawned.every((call) => call.options.stdio === undefined)).toBe(true);
    expect(h.released()).toBe(0);
  });
});
