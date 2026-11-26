import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import type {
  WindowsStepNode,
  WindowsStepNodeDecision,
  WindowsStepSupervisor,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_SANDBOX_POLICY } from "./types.js";
import { makeWorkspace } from "./_support.js";
import { CommandCancelledError, CommandDeniedError } from "./errors.js";
import {
  realWindowsSearchPathEntry,
  runCommand,
  type RunCommandDeps,
  type SpawnOptions,
} from "./exec.js";
import { buildWindowsShellInvocation } from "./windows-shell.js";
import {
  quoteWindowsArgument,
  throughWindowsStepDrives,
  windowsStepFrames,
  windowsStepGrants,
  windowsStepReadRoots,
  windowsToolchainRoot,
  windowsStepRefusal,
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

const TRUSTED_WINDOWS = {
  env: { SystemRoot: String.raw`C:\Windows` },
  platform: "win32" as const,
  existsAsFile: (): boolean => true,
  systemDirectoryIdentity: (): boolean => true,
};

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
  const profile = String.raw`C:\Users\dev`;
  // The production rule for an executable's folder; the supervisor admits it by its real path.
  const grants = (
    executionRoot: string,
    executable: string,
    readRoots: readonly string[],
    command: string,
    stepProfile: string | undefined = profile,
  ): readonly unknown[] =>
    windowsStepGrants(
      executionRoot,
      windowsToolchainRoot(executable),
      readRoots,
      command,
      stepProfile,
    );

  it("grants the execution root for modification and the executable's folder for reading", () => {
    expect(
      grants(
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
      grants(
        root,
        String.raw`C:\Users\dev\work\repo\node_modules\.bin\tool.exe`,
        [String.raw`C:\Users\dev\work\repo\vendor`],
        "tool",
      ),
    ).toEqual([{ path: root, access: "modify", principal: "tree" }]);
  });

  it("grants a JDK or Maven from its bin folder's parent", () => {
    expect(
      grants(root, String.raw`C:\Users\dev\Programs\maven\bin\mvn.cmd`, [], "mvn"),
    ).toContainEqual({
      path: String.raw`C:\Users\dev\Programs\maven`,
      access: "read",
      principal: "tree",
    });
  });

  it("refuses every step when the user profile folder is unknown or no drive path (#4496)", () => {
    for (const unknown of [
      undefined,
      "",
      String.raw`\\server\share\dev`,
      String.raw`\\?\C:\Users\dev`,
    ]) {
      expect(() => windowsStepGrants(root, String.raw`C:\t`, [], "x", unknown)).toThrow(
        /user profile folder is unknown/u,
      );
    }
  });

  it("refuses a read root that is no drive path (#4496)", () => {
    for (const refused of [String.raw`\\server\share\jdk`, String.raw`\\?\C:\Users\dev\.m2`]) {
      expect(() => grants(root, String.raw`C:\t\x.exe`, [refused], "x")).toThrow(
        /not a drive path/u,
      );
    }
  });

  it("refuses a grant that holds the whole user profile", () => {
    expect(() => grants(root, String.raw`C:\Users\dev\node.exe`, [], "node")).toThrow(
      /whole user profile/u,
    );
    expect(() => grants(root, String.raw`C:\t\x.exe`, [String.raw`C:\Users`], "x")).toThrow(
      /whole user profile/u,
    );
    expect(() => grants(profile, String.raw`C:\t\x.exe`, [], "x")).toThrow(/whole user profile/u);
    expect(grants(root, String.raw`C:\Users\dev\Programs\node\node.exe`, [], "node")).toHaveLength(
      2,
    );
  });

  it("refuses a read root that holds, is, or sits in the profile's .m2, bar its repository", () => {
    const grant = (roots: readonly string[]): readonly unknown[] =>
      grants(root, String.raw`C:\t\x.exe`, roots, "x");
    for (const refused of [
      String.raw`C:\Users\dev\.m2`,
      String.raw`c:\users\DEV\.M2\toolchains`,
      String.raw`C:\Users\dev\.m2\conf`,
    ]) {
      expect(() => grant([refused])).toThrow(/Maven user folder/u);
    }
    expect(grant([String.raw`C:\Users\dev\.m2\repository`])).toHaveLength(3);
    expect(grant([String.raw`C:\Users\dev\.m2\Repository\org`])).toHaveLength(3);
    expect(grant([String.raw`C:\tools\maven`])).toHaveLength(3);
  });

  it("refuses a relative read root and more folders than one tree may be granted", () => {
    expect(() => grants(root, String.raw`C:\t\x.exe`, ["relative"], "x")).toThrow(
      /step read root is not absolute/u,
    );
    const many = Array.from({ length: 8 }, (_, index) => `C:\\tools\\t${String(index)}`);
    expect(() => grants(root, String.raw`C:\t\x.exe`, many, "x")).toThrow(
      /more directories than one tree may be granted/u,
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
    const frames = windowsStepFrames(
      launch,
      String.raw`C:\work`,
      { PATH: String.raw`C:\tools`, "ProgramFiles(x86)": String.raw`C:\Program Files (x86)` },
      [],
    );
    expect(frames.subarray(0, 4).toString("ascii")).toBe("KRP1");
    const grantsAt = 12 + frames.readUInt32LE(8);
    expect(frames.subarray(grantsAt, grantsAt + 4).toString("ascii")).toBe("KGG1");
    const launchText = frames.subarray(0, grantsAt).toString("utf8");
    expect(launchText).toContain("PATH");
    expect(launchText).not.toContain("ProgramFiles(x86)");
  });

  it("names every granted directory through its drive letter, never through C:\\", () => {
    const launch: WindowsStepLaunch = {
      image: String.raw`C:\Program Files\Java\jdk-21\bin\java.exe`,
      args: ['"-Dout=C:\\work\\repo"', "-cp", String.raw`C:\work\repo\target;C:\work\repo2`],
      grants: [],
      recoveryHandle: "0123456789abcdef0123456789abcdef",
    };
    const text = windowsStepFrames(launch, String.raw`C:\work\repo`, DRIVE_ENV, DRIVES).toString(
      "utf8",
    );
    expect(text).toContain(String.raw`J:\bin\java.exe`);
    expect(text).toContain('"-Dout=K:\\."');
    expect(text).toContain(String.raw`K:\target;C:\work\repo2`);
    expect(text).not.toContain(String.raw`C:\Program Files`);
    expect(text).not.toContain("program files");
    expect(text).toContain(String.raw`J:\bin;C:\Windows\System32`);
    expect(text).not.toContain("C:\\work\\repo\\");
    expect(text).not.toContain("--preserve-symlinks");
  });

  // #4492: Scoop puts `apps\nodejs-lts\current`, a junction, on PATH; the executable is granted by
  // its real folder. Through the junction the step found npm but not the `node` its script runs.
  it("names a PATH entry through a junction by its real folder's drive letter", () => {
    const real = String.raw`C:\Users\dev\scoop\apps\nodejs-lts\26.13.1`;
    const link = String.raw`C:\Users\dev\scoop\apps\nodejs-lts\current`;
    const launch: WindowsStepLaunch = {
      image: `${real}\\npm.cmd`,
      args: ["test"],
      grants: [],
      recoveryHandle: "0123456789abcdef0123456789abcdef",
    };
    const asked: string[] = [];
    // As the real resolver does: the junction prefix resolves, the rest of the entry follows it.
    const realPath = (entry: string): string | undefined => {
      asked.push(entry);
      return entry.startsWith(link) ? `${real}${entry.slice(link.length)}` : undefined;
    };
    const text = windowsStepFrames(
      launch,
      String.raw`C:\work\repo`,
      {
        PATH: `${link}\\bin;${link};.;bin;\\\\server\\tools;C:\\Users\\dev\\scoop\\shims;C:\\Windows\\System32`,
      },
      [...DRIVES, { root: real, drive: "N:" }],
      realPath,
    ).toString("utf8");
    expect(text).toContain(
      String.raw`N:\bin;N:\;.;bin;\\server\tools;C:\Users\dev\scoop\shims;C:\Windows\System32`,
    );
    // A relative entry would resolve against Keiko's folder, not the step's, and a share can stall:
    // only a drive-absolute entry is resolved.
    expect(asked).toEqual([
      `${link}\\bin`,
      link,
      String.raw`C:\Users\dev\scoop\shims`,
      String.raw`C:\Windows\System32`,
    ]);
    expect(text).toContain(String.raw`N:\npm.cmd`);
  });

  // #4492: only PATH (in any case Windows writes it) is resolved, and a real folder no grant
  // covers leaves the entry exactly as written.
  it("resolves only the search path, in any case, and keeps an ungranted real folder as written", () => {
    const launch: WindowsStepLaunch = {
      image: String.raw`C:\work\repo\run.cmd`,
      args: [],
      grants: [],
      recoveryHandle: "0123456789abcdef0123456789abcdef",
    };
    const asked: string[] = [];
    const text = windowsStepFrames(
      launch,
      String.raw`C:\work\repo`,
      { Path: String.raw`C:\tools\link`, TOOL_HOME: String.raw`C:\tools\home` },
      DRIVES,
      (entry) => {
        asked.push(entry);
        return String.raw`D:\elsewhere\real`;
      },
    ).toString("utf8");
    expect(asked).toEqual([String.raw`C:\tools\link`]);
    expect(text).toContain(String.raw`C:\tools\link`);
    expect(text).not.toContain("elsewhere");
  });
});

describe("realWindowsSearchPathEntry (#4492)", () => {
  it("names an existing folder's real path and has none for a missing one", () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "keiko-search-path-")));
    try {
      expect(realWindowsSearchPathEntry(folder)).toBe(folder);
      expect(realWindowsSearchPathEntry(join(folder, "missing"))).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

const DRIVES = [
  { root: String.raw`C:\work\repo`, drive: "K:" },
  { root: String.raw`C:\Program Files\Java\jdk-21`, drive: "J:" },
  { root: String.raw`C:\work\repo\node_modules\tool`, drive: "T:" },
];

const DRIVE_ENV = {
  JAVA_HOME: String.raw`C:\Program Files\Java\jdk-21`,
  PATH: String.raw`c:\program files\java\JDK-21\bin;C:\Windows\System32`,
};

describe("windowsStepReadRoots (#4492)", () => {
  const ROOT = String.raw`C:\work\repo`;
  const repository = String.raw`C:\Users\dev\.m2\repository`;
  const supervisor = (mavenRepository?: string): WindowsStepSupervisor => ({
    acquire: (): never => {
      throw new Error("not acquired here");
    },
    readRoots: [String.raw`C:\jdk`],
    profile: String.raw`C:\Users\dev`,
    admitReadRoot: (directory) => directory,
    mavenRepository,
  });

  it("adds the person's Maven repository for Maven's launcher only", () => {
    for (const launcher of ["mvn.cmd", "MVN.CMD", "mvn.bat", "mvn"]) {
      expect(
        windowsStepReadRoots(`C:\\maven\\bin\\${launcher}`, ROOT, supervisor(repository)),
      ).toEqual([String.raw`C:\jdk`, repository]);
    }
    for (const other of [String.raw`C:\node\node.exe`, String.raw`C:\maven\bin\mvnDebug.cmd`]) {
      expect(windowsStepReadRoots(other, ROOT, supervisor(repository))).toEqual([
        String.raw`C:\jdk`,
      ]);
    }
  });

  it("adds nothing for a launcher the workspace itself holds", () => {
    expect(
      windowsStepReadRoots(String.raw`C:\work\repo\bin\mvn.cmd`, ROOT, supervisor(repository)),
    ).toEqual([String.raw`C:\jdk`]);
  });

  it("adds nothing when the person has no Maven repository", () => {
    expect(windowsStepReadRoots(String.raw`C:\maven\bin\mvn.cmd`, ROOT, supervisor())).toEqual([
      String.raw`C:\jdk`,
    ]);
  });

  it("names the repository inside a Maven argument through its drive letter", () => {
    const drives = [{ root: repository, drive: "L:" }];
    expect(throughWindowsStepDrives(`-Dmaven.repo.local.tail=${repository}`, drives)).toBe(
      "-Dmaven.repo.local.tail=L:\\",
    );
  });
});

describe("throughWindowsStepDrives", () => {
  it("replaces a granted root at a path boundary, the longest root first", () => {
    expect(throughWindowsStepDrives(String.raw`C:\work\repo\src\a.js`, DRIVES)).toBe(
      String.raw`K:\src\a.js`,
    );
    expect(throughWindowsStepDrives(String.raw`C:\work\repo\node_modules\tool\x`, DRIVES)).toBe(
      String.raw`T:\x`,
    );
    expect(throughWindowsStepDrives("C:/work/repo/src", DRIVES)).toBe("K:/src");
    expect(throughWindowsStepDrives(String.raw`C:\work\repo`, DRIVES)).toBe("K:\\");
    expect(throughWindowsStepDrives(String.raw`\\?\C:\work\repo\a`, DRIVES)).toBe(
      String.raw`\\?\K:\a`,
    );
  });

  it("leaves a sibling, a longer name, a drive-letter suffix and an unmapped path alone", () => {
    for (const value of [
      String.raw`C:\work\repo2\a`,
      String.raw`C:\work\repository`,
      String.raw`XC:\work\repo\a`,
      String.raw`D:\work\repo\a`,
      "",
      "plain text",
    ]) {
      expect(throughWindowsStepDrives(value, DRIVES)).toBe(value);
    }
    expect(throughWindowsStepDrives(String.raw`C:\work\repo\a`, [])).toBe(
      String.raw`C:\work\repo\a`,
    );
  });

  it("reads a granted root with a trailing separator as its directory", () => {
    const drives = [{ root: "D:\\tools\\", drive: "T:" }];
    expect(throughWindowsStepDrives(String.raw`D:\tools\bin\x.exe`, drives)).toBe(
      String.raw`T:\bin\x.exe`,
    );
    expect(throughWindowsStepDrives(String.raw`D:\tools`, drives)).toBe("T:\\");
  });

  it("ends a path at a list or redirection character, never inside a name", () => {
    expect(throughWindowsStepDrives(String.raw`-cp C:\work\repo,lib`, DRIVES)).toBe(
      String.raw`-cp K:\,lib`,
    );
    expect(throughWindowsStepDrives(String.raw`C:\work\repo>out`, DRIVES)).toBe("K:\\>out");
    expect(throughWindowsStepDrives(String.raw`C:\work\repo.bak\a`, DRIVES)).toBe(
      String.raw`C:\work\repo.bak\a`,
    );
    expect(throughWindowsStepDrives(String.raw`-IC:\work\repo\a`, DRIVES)).toBe(
      String.raw`-IC:\work\repo\a`,
    );
  });

  // #4492: a Maven step runs `mvn.cmd`, whose arguments reach cmd.exe caret-escaped. The repository
  // tail ends its argument, so the escaped closing quote (`^"`) followed the root and the real
  // profile path reached Java, whose `toRealPath` cannot walk `C:\Users` inside the AppContainer.
  it("names a root before a caret-escaped ending in a cmd.exe command line through its letter", () => {
    const repository = String.raw`C:\Users\dev\.m2\repository`;
    const drives = [{ root: repository, drive: "L:" }];
    const wrapped = (command: string): string => {
      const invocation = buildWindowsShellInvocation(
        command,
        ["-o", `-Dmaven.repo.local.tail=${repository}`, `-Dlist=${repository},x`],
        TRUSTED_WINDOWS,
      );
      return throughWindowsStepDrives(invocation.args.at(-1) ?? "", drives);
    };
    const line = wrapped(String.raw`C:\maven\bin\mvn.cmd`);
    expect(line).not.toContain(repository);
    expect(line).toContain(String.raw`^"-Dmaven.repo.local.tail=L:\.^"`);
    expect(line).toContain(String.raw`-Dlist=L:\^,x`);
    const shim = wrapped(String.raw`C:\proj\node_modules\.bin\tool.cmd`);
    expect(shim).not.toContain(repository);
    expect(shim).toContain(String.raw`-Dmaven.repo.local.tail=L:\.^^^"`);
  });

  it("keeps a root followed by a literal caret, a dangling caret or an escaped name character", () => {
    for (const value of [
      String.raw`C:\work\repo^^x`,
      String.raw`C:\work\repo^`,
      String.raw`C:\work\repo^(x`,
    ]) {
      expect(throughWindowsStepDrives(value, DRIVES)).toBe(value);
    }
  });

  it("keeps a quoted root's closing quote: the root before a quote ends in a dot", () => {
    expect(throughWindowsStepDrives('"C:\\work\\repo"', DRIVES)).toBe('"K:\\."');
    expect(throughWindowsStepDrives("a C:\\work\\repo;C:\\work\\repo b", DRIVES)).toBe(
      "a K:\\;K:\\ b",
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
  readonly refusals: readonly { readonly code: number; readonly launched: boolean }[];
  readonly acquired: readonly (readonly string[])[];
  readonly treeKills: () => number;
  readonly written: () => Buffer;
}

interface HarnessOptions {
  readonly stepNode?: WindowsStepNode | undefined;
  readonly commandRules?: RunCommandDeps["commandRules"];
  readonly resolveExecutable?: RunCommandDeps["resolveExecutable"];
  readonly windowsStepNodeProbe?: RunCommandDeps["windowsStepNodeProbe"];
  readonly admitReadRoot?: WindowsStepSupervisor["admitReadRoot"];
  /** The supervisor's real profile folder; `null` for a host whose profile is unknown. */
  readonly profile?: string | null;
}

function harness(options: HarnessOptions = {}): Harness {
  const { info } = makeWorkspace();
  const child = supervisedChild();
  const spawned: Harness["spawned"] = [];
  const chunks: Buffer[] = [];
  control(child).on("data", (chunk: Buffer) => chunks.push(chunk));
  let released = 0;
  let treeKills = 0;
  const acquired: (readonly string[])[] = [];
  const refusals: { code: number; launched: boolean }[] = [];
  const supervisor: WindowsStepSupervisor = {
    acquire: (roots) => {
      acquired.push(roots);
      return {
        path: String.raw`C:\Temp\keiko-native-runtime-x\keiko-runtime-supervisor.exe`,
        drives: roots.map((root, index) => ({ root, drive: `${"KLMN".charAt(index)}:` })),
        release: (): void => {
          released++;
        },
        refused: (code, launched): void => {
          refusals.push({ code, launched });
        },
      };
    },
    readRoots: [],
    profile: options.profile === null ? undefined : (options.profile ?? String.raw`C:\Users\dev`),
    admitReadRoot: options.admitReadRoot ?? ((directory): string => directory),
    ...(options.stepNode === undefined ? {} : { stepNode: options.stepNode }),
  };
  const deps: RunCommandDeps = {
    workspace: info,
    policy: { ...DEFAULT_SANDBOX_POLICY, network: "none", filesystem: "execution-root" },
    commandRules: options.commandRules ?? [{ executable: "node" }],
    spawn: (command, args, spawnOptions): ChildProcess => {
      spawned.push({ command, args: [...args], options: spawnOptions });
      return child as unknown as ChildProcess;
    },
    resolveExecutable:
      options.resolveExecutable ?? ((): string => String.raw`C:\tools\node\node.exe`),
    ...(options.windowsStepNodeProbe === undefined
      ? {}
      : { windowsStepNodeProbe: options.windowsStepNodeProbe }),
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
    refusals,
    acquired,
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

const STEP_NODE_FOLDER = String.raw`C:\Program Files\Keiko\runtime\step-node`;

function recordingStepNode(): {
  readonly node: WindowsStepNode;
  readonly seen: WindowsStepNodeDecision[];
} {
  const seen: WindowsStepNodeDecision[] = [];
  return {
    seen,
    node: {
      directory: STEP_NODE_FOLDER,
      executable: `${STEP_NODE_FOLDER}\\node.exe`,
      record: (decision): void => {
        seen.push(decision);
      },
    },
  };
}

function launchText(h: Harness): string {
  return h.written().subarray(0, h.written().indexOf("KGG1")).toString("utf8");
}

describe("runCommand with the patched step Node.js (#4492)", () => {
  it("runs a command named node as the step Node.js, first on PATH through its drive", async () => {
    const { node, seen } = recordingStepNode();
    const h = harness({ stepNode: node });
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    // The host's own node folder is not granted: the step runs the step Node.js alone.
    expect(h.acquired).toEqual([[realpathSync(h.deps.workspace.root), STEP_NODE_FOLDER]]);
    const launch = launchText(h);
    expect(launch).toContain(String.raw`L:\node.exe`);
    expect(launch).toContain(String.raw`L:\;C:\tools\node`);
    expect(seen).toEqual([
      {
        image: "step-node",
        npmLaunch: "not-npm",
        npmFallback: "none",
        pathPrefixed: true,
        placement: "applied",
      },
    ]);
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(0)]));
    await settled();
    h.child.emit("close", 0, null);
    expect((await run).exitCode).toBe(0);
  });

  it("starts npm through the step Node.js and the install's own npm-cli.js", async () => {
    const { node, seen } = recordingStepNode();
    const install = String.raw`C:\Program Files\nodejs`;
    const cli = `${install}\\node_modules\\npm\\bin\\npm-cli.js`;
    const h = harness({
      stepNode: node,
      commandRules: [{ executable: "npm" }],
      resolveExecutable: () => `${install}\\npm.cmd`,
      windowsStepNodeProbe: { isFile: (path) => path === cli, realPath: (path) => path },
    });
    const run = runCommand(
      { ...input(new AbortController().signal), command: "npm", args: ["test"] },
      h.deps,
    );
    await settled();
    expect(h.acquired).toEqual([[realpathSync(h.deps.workspace.root), install, STEP_NODE_FOLDER]]);
    const launch = launchText(h);
    expect(launch).toContain(String.raw`M:\node.exe`);
    expect(launch).toContain(String.raw`L:\node_modules\npm\bin\npm-cli.js`);
    expect(launch).not.toContain("cmd.exe");
    expect(seen).toEqual([
      {
        image: "step-node",
        npmLaunch: "step-node",
        npmFallback: "none",
        pathPrefixed: true,
        placement: "applied",
      },
    ]);
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(0)]));
    await settled();
    h.child.emit("close", 0, null);
    expect((await run).exitCode).toBe(0);
  });

  it("changes nothing and records nothing when the runtime carries no step Node.js", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    expect(launchText(h)).toContain(String.raw`L:\node.exe`);
    expect(launchText(h)).not.toContain("step-node");
    expect(h.acquired).toEqual([[realpathSync(h.deps.workspace.root), String.raw`C:\tools\node`]]);
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(0)]));
    await settled();
    h.child.emit("close", 0, null);
    expect((await run).exitCode).toBe(0);
  });

  it("records no launch decision for a step whose supervisor copy could not be acquired", async () => {
    const { node, seen } = recordingStepNode();
    const h = harness({ stepNode: node });
    const supervisor = h.deps.windowsStepSupervisor;
    if (supervisor === undefined) throw new Error("the harness carries a supervisor");
    const deps: RunCommandDeps = {
      ...h.deps,
      windowsStepSupervisor: {
        ...supervisor,
        acquire: (): never => {
          throw new CommandDeniedError("no free drive letter", "node");
        },
      },
    };
    await expect(runCommand(input(new AbortController().signal), deps)).rejects.toThrow(
      "no free drive letter",
    );
    expect(seen).toEqual([]);
  });
});

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
    expect(h.acquired).toEqual([[realpathSync(h.deps.workspace.root), String.raw`C:\tools\node`]]);
    const launch = h.written().subarray(0, h.written().indexOf("KGG1")).toString("utf8");
    expect(launch).toContain(String.raw`L:\node.exe`);
    expect(launch).not.toContain(String.raw`C:\tools\node`);
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

  // #4496: the executable's own folder passes the supervisor's admission like the named homes, and
  // the grant names the real folder it answers (a long name for a short one, a junction resolved).
  it("grants the executable's toolchain folder by the real path the supervisor admits", async () => {
    const asked: string[] = [];
    const h = harness({
      admitReadRoot: (directory) => {
        asked.push(directory);
        return String.raw`C:\Program Files\nodejs`;
      },
    });
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    expect(asked).toEqual([String.raw`C:\tools\node`]);
    expect(h.acquired).toEqual([
      [realpathSync(h.deps.workspace.root), String.raw`C:\Program Files\nodejs`],
    ]);
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(0)]));
    await settled();
    h.child.emit("close", 0, null);
    expect((await run).exitCode).toBe(0);
  });

  it("refuses a step whose toolchain folder the supervisor does not admit, before any launch", async () => {
    const h = harness({ admitReadRoot: () => undefined });
    await expect(runCommand(input(new AbortController().signal), h.deps)).rejects.toThrow(
      /toolchain folder holds or sits in the Maven user folder, holds a credential-named entry/u,
    );
    expect(h.acquired).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  it("refuses every step on a host whose profile folder is unknown, before any launch", async () => {
    const h = harness({ profile: null });
    await expect(runCommand(input(new AbortController().signal), h.deps)).rejects.toThrow(
      /user profile folder is unknown/u,
    );
    expect(h.acquired).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  // #4492: the supervisor resolves the user's LocalAppData for its per-user lock; Windows expands
  // that folder through the process's USERPROFILE, so the step's home there refused every step with
  // refusal 12. The step's environment travels in the launch frame, never in the supervisor's own.
  it("starts the supervisor with an empty environment and frames the step's home", async () => {
    const h = harness();
    const run = runCommand(input(new AbortController().signal), h.deps);
    await settled();
    expect(h.spawned[0]?.options.env).toEqual({});
    const launch = h.written().subarray(0, h.written().indexOf("KGG1")).toString("utf8");
    expect(launch).toContain("USERPROFILE");
    expect(launch).toContain("TEMP");
    expect(launch).toContain(".keiko-home-");
    answers(h.child).write(Buffer.concat([LAUNCHED, reaped(0)]));
    await settled();
    h.child.emit("close", 0, null);
    expect((await run).exitCode).toBe(0);
    expect(h.refusals).toEqual([]);
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
    expect(h.refusals).toEqual([{ code: 8, launched: false }]);
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
    expect(h.refusals).toEqual([{ code: 10, launched: true }]);
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

describe("windowsStepRefusal", () => {
  it.each([
    [7, /missing or is a link/u],
    [12, /user environment could not be closed/u],
    [18, /signed-in desktop session/u],
    [19, /path of Keiko's folder is too long/u],
  ])("words supervisor refusal %i in closed terms", (code, words) => {
    expect(windowsStepRefusal(code)).toMatch(words);
    expect(windowsStepRefusal(code)).not.toContain(`(${String(code)})`);
  });

  it("names only the code of a refusal it has no words for", () => {
    expect(windowsStepRefusal(99)).toBe(
      "Windows execution isolation refused the step: the supervisor refused the launch (99)",
    );
  });
});
