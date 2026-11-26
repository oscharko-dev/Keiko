import { describe, expect, it } from "vitest";
import type { WindowsStepNode } from "@oscharko-dev/keiko-contracts";
import {
  planWindowsStepNode,
  type WindowsStepNodeInput,
  type WindowsStepNodeProbe,
} from "./windows-step-node.js";
import { prependWindowsSearchPath, windowsPathContains } from "./windows-step-paths.js";
import { windowsStepFrames, windowsStepLaunch, type WindowsStepLaunch } from "./windows-step.js";

const STEP_NODE_DIRECTORY = String.raw`C:\Program Files\Keiko\runtime\step-node`;
const EXECUTION_ROOT = String.raw`C:\Users\dev\keiko-step-1`;

function stepNode(directory = STEP_NODE_DIRECTORY): WindowsStepNode {
  return { directory, executable: `${directory}\\node.exe`, record: (): void => undefined };
}

/** A probe over an explicit set of files, each with its real path (itself unless linked). */
function probeOf(files: Readonly<Record<string, string>>): WindowsStepNodeProbe {
  const lower = (path: string): string => path.toLowerCase();
  const table = new Map(Object.entries(files).map(([path, real]) => [lower(path), real]));
  return {
    isFile: (path) => table.has(lower(path)),
    realPath: (path) => table.get(lower(path)) ?? path,
  };
}

function plan(
  overrides: Partial<WindowsStepNodeInput> & Pick<WindowsStepNodeInput, "command" | "executable">,
): ReturnType<typeof planWindowsStepNode> {
  return planWindowsStepNode({
    args: ["test"],
    executionRoot: EXECUTION_ROOT,
    stepNode: stepNode(),
    probe: probeOf({}),
    ...overrides,
  });
}

const STANDARD_INSTALL = String.raw`C:\Program Files\nodejs`;
const STANDARD_CLI = `${STANDARD_INSTALL}\\node_modules\\npm\\bin\\npm-cli.js`;

describe("planWindowsStepNode (#4492)", () => {
  it("changes nothing without a verified step Node.js", () => {
    expect(
      plan({ command: "npm", executable: `${STANDARD_INSTALL}\\npm.cmd`, stepNode: undefined }),
    ).toEqual({ kind: "none" });
  });

  it("launches a command named node as the step Node.js, granted through its own folder", () => {
    const result = plan({
      command: "node",
      executable: String.raw`C:\tools\node\node.exe`,
      args: ["--test", "src"],
    });
    expect(result).toMatchObject({
      kind: "applied",
      grantExecutable: `${STEP_NODE_DIRECTORY}\\node.exe`,
      invocation: { command: `${STEP_NODE_DIRECTORY}\\node.exe`, args: ["--test", "src"] },
      decision: {
        image: "step-node",
        npmLaunch: "not-npm",
        npmFallback: "none",
        pathPrefixed: true,
        placement: "applied",
      },
    });
  });

  it("reads node.exe in any case as node", () => {
    for (const command of ["NODE", "Node.EXE"]) {
      expect(plan({ command, executable: String.raw`C:\x\node.exe` })).toMatchObject({
        invocation: { command: `${STEP_NODE_DIRECTORY}\\node.exe` },
      });
    }
  });

  it.each([
    ["standard install", STANDARD_INSTALL, "npm", "npm-cli.js"],
    ["standard install, npx", STANDARD_INSTALL, "npx", "npx-cli.js"],
    ["Scoop junction", String.raw`C:\Users\dev\scoop\apps\nodejs\current`, "npm", "npm-cli.js"],
    ["nvm-windows layout", String.raw`C:\nvm4w\nodejs`, "npm", "npm-cli.js"],
  ])("starts npm or npx of a %s through the step Node.js", (_label, install, tool, cliName) => {
    const cli = `${install}\\node_modules\\npm\\bin\\${cliName}`;
    const result = plan({
      command: tool,
      executable: `${install}\\${tool}.cmd`,
      args: ["run", "build"],
      probe: probeOf({ [cli]: cli }),
    });
    expect(result).toMatchObject({
      kind: "applied",
      // The install folder stays granted through its `.cmd`; the CLI script is read from it.
      grantExecutable: `${install}\\${tool}.cmd`,
      invocation: { command: `${STEP_NODE_DIRECTORY}\\node.exe`, args: [cli, "run", "build"] },
      decision: { image: "step-node", npmLaunch: "step-node", npmFallback: "none" },
    });
  });

  it("follows a junction to the same install folder", () => {
    const junction = String.raw`C:\Users\dev\scoop\apps\nodejs\current`;
    const real = String.raw`C:\Users\dev\scoop\apps\nodejs\26.13.1`;
    const cli = `${junction}\\node_modules\\npm\\bin\\npm-cli.js`;
    const result = plan({
      command: "npm",
      executable: `${junction}\\npm.cmd`,
      probe: {
        isFile: (path) => path.toLowerCase() === cli.toLowerCase(),
        realPath: (path) =>
          path.toLowerCase().startsWith(junction.toLowerCase())
            ? path.replace(junction, real)
            : path,
      },
    });
    expect(result).toMatchObject({ decision: { npmLaunch: "step-node" } });
  });

  it("keeps the install's own npm.cmd and names why when npm-cli.js is missing", () => {
    expect(
      plan({ command: "npm", executable: `${STANDARD_INSTALL}\\npm.cmd`, probe: probeOf({}) }),
    ).toMatchObject({
      kind: "applied",
      invocation: undefined,
      decision: {
        image: "resolved",
        npmLaunch: "install-cmd",
        npmFallback: "cli-missing",
        pathPrefixed: true,
      },
    });
  });

  it("keeps npm.cmd when npm-cli.js resolves outside the folder the step is granted", () => {
    const outside = String.raw`D:\elsewhere\npm-cli.js`;
    expect(
      plan({
        command: "npm",
        executable: `${STANDARD_INSTALL}\\npm.cmd`,
        probe: probeOf({ [STANDARD_CLI]: outside }),
      }),
    ).toMatchObject({
      invocation: undefined,
      decision: { npmLaunch: "install-cmd", npmFallback: "cli-outside-grant" },
    });
  });

  it("keeps npm.cmd when a real path cannot be resolved", () => {
    expect(
      plan({
        command: "npm",
        executable: `${STANDARD_INSTALL}\\npm.cmd`,
        probe: { isFile: () => true, realPath: () => undefined },
      }),
    ).toMatchObject({ decision: { npmLaunch: "install-cmd", npmFallback: "cli-outside-grant" } });
  });

  it("keeps a sibling folder's name from passing for the install folder", () => {
    // `C:\Program Files\nodejs-evil` starts with the install's name but is another folder.
    expect(
      plan({
        command: "npm",
        executable: `${STANDARD_INSTALL}\\npm.cmd`,
        probe: probeOf({ [STANDARD_CLI]: String.raw`C:\Program Files\nodejs-evil\npm-cli.js` }),
      }),
    ).toMatchObject({ decision: { npmFallback: "cli-outside-grant" } });
  });

  it("leaves a launcher inside the execution root alone: it is the workspace's file", () => {
    const executable = `${EXECUTION_ROOT}\\tools\\npm.cmd`;
    const cli = `${EXECUTION_ROOT}\\tools\\node_modules\\npm\\bin\\npm-cli.js`;
    expect(plan({ command: "npm", executable, probe: probeOf({ [cli]: cli }) })).toMatchObject({
      invocation: undefined,
      decision: { image: "resolved", npmLaunch: "not-npm", npmFallback: "none" },
    });
  });

  it("only puts the folder on PATH for every other command", () => {
    expect(plan({ command: "mvn", executable: String.raw`C:\maven\bin\mvn.cmd` })).toMatchObject({
      kind: "applied",
      grantExecutable: String.raw`C:\maven\bin\mvn.cmd`,
      invocation: undefined,
      decision: { image: "resolved", npmLaunch: "not-npm", pathPrefixed: true },
    });
  });

  it("never trusts a step Node.js folder inside the execution root", () => {
    const inside = `${EXECUTION_ROOT}\\step-node`;
    const result = plan({
      command: "node",
      executable: String.raw`C:\tools\node\node.exe`,
      stepNode: stepNode(inside),
    });
    expect(result).toEqual({
      kind: "unused",
      decision: {
        image: "resolved",
        npmLaunch: "not-npm",
        npmFallback: "none",
        pathPrefixed: false,
        placement: "inside-execution-root",
      },
    });
  });
});

describe("prependWindowsSearchPath (#4492)", () => {
  const dir = STEP_NODE_DIRECTORY;

  it("puts the folder first and keeps the others in order", () => {
    expect(prependWindowsSearchPath(String.raw`C:\a;C:\b`, dir)).toBe(`${dir};C:\\a;C:\\b`);
  });

  it("holds only the folder for an empty search path", () => {
    expect(prependWindowsSearchPath("", dir)).toBe(dir);
  });

  it.each([
    ["the folder as written", dir],
    ["the folder quoted", `"${dir}"`],
    ["the folder with a trailing separator", `${dir}\\`],
    ["the folder with forward slashes", dir.replaceAll("\\", "/")],
    ["the folder in another case", dir.toUpperCase()],
  ])("lists the folder once when PATH already names %s", (_label, entry) => {
    expect(prependWindowsSearchPath(`C:\\a;${entry};C:\\b`, dir)).toBe(`${dir};C:\\a;C:\\b`);
  });

  it("drops a trailing or doubled semicolon instead of leaving an empty entry", () => {
    expect(prependWindowsSearchPath(String.raw`C:\a;;C:\b;`, dir)).toBe(`${dir};C:\\a;C:\\b`);
  });

  it("keeps a relative entry exactly as written, behind the folder", () => {
    expect(prependWindowsSearchPath(String.raw`..\bin;.;C:\a`, dir)).toBe(`${dir};..\\bin;.;C:\\a`);
  });

  it("does not treat a sibling that merely starts with the folder's name as the folder", () => {
    const sibling = `${dir}-old`;
    expect(prependWindowsSearchPath(sibling, dir)).toBe(`${dir};${sibling}`);
  });

  it("compares paths by Windows rules", () => {
    expect(windowsPathContains(String.raw`C:\A`, String.raw`c:\a\b`)).toBe(true);
    expect(windowsPathContains(String.raw`C:\A`, String.raw`C:\AB`)).toBe(false);
    expect(windowsPathContains(String.raw`C:\A`, String.raw`D:\A`)).toBe(false);
  });

  // A child whose name merely starts with two dots lies inside the folder; only a real parent
  // step (`..` or `..\`) or another drive leaves it.
  it("keeps a child named like ..step-node inside and every escape outside", () => {
    const root = String.raw`C:\Keiko\runtime`;
    expect(windowsPathContains(root, root)).toBe(true);
    expect(windowsPathContains(root, String.raw`C:\Keiko\runtime\..step-node`)).toBe(true);
    expect(windowsPathContains(root, String.raw`C:\Keiko\runtime\..step-node\node.exe`)).toBe(true);
    expect(windowsPathContains(root, String.raw`C:\Keiko`)).toBe(false);
    expect(windowsPathContains(root, String.raw`C:\Keiko\other`)).toBe(false);
    expect(windowsPathContains(root, String.raw`C:\Keiko\runtime\..\other`)).toBe(false);
    expect(windowsPathContains(root, String.raw`D:\Keiko\runtime\step-node`)).toBe(false);
  });
});

describe("the step Node.js in the launch frames (#4492)", () => {
  const supervisor = {
    acquire: (): never => {
      throw new Error("unused");
    },
    readRoots: [],
    profile: String.raw`C:\Users\dev`,
    admitReadRoot: (directory: string): string => directory,
  };
  const invocation = {
    command: `${STEP_NODE_DIRECTORY}\\node.exe`,
    args: ["--test"],
    windowsVerbatimArguments: false,
  };

  it("grants the step Node.js folder for reading and leads PATH with it through its drive", () => {
    const launch: WindowsStepLaunch = windowsStepLaunch(
      invocation,
      `${STEP_NODE_DIRECTORY}\\node.exe`,
      EXECUTION_ROOT,
      supervisor,
      "node",
      STEP_NODE_DIRECTORY,
    );
    expect(launch.grants).toEqual([
      { path: EXECUTION_ROOT, access: "modify", principal: "tree" },
      { path: STEP_NODE_DIRECTORY, access: "read", principal: "tree" },
    ]);
    expect(launch.pathPrefix).toBe(STEP_NODE_DIRECTORY);
    const text = windowsStepFrames(
      launch,
      EXECUTION_ROOT,
      { PATH: String.raw`C:\Program Files\Java\jdk-21\bin;C:\Windows\system32` },
      [
        { root: EXECUTION_ROOT, drive: "Z:" },
        { root: STEP_NODE_DIRECTORY, drive: "Y:" },
      ],
    ).toString("utf8");
    expect(text).toContain(String.raw`Y:\;C:\Program Files\Java\jdk-21\bin;C:\Windows\system32`);
    expect(text).toContain(String.raw`Y:\node.exe`);
    // The step names the folder only through its drive; the grants keep the real path.
    expect(text.slice(0, text.indexOf("KGG1"))).not.toContain("Keiko");
  });

  it("adds a PATH of its own when the step has none, and keeps its spelling when it has one", () => {
    const launch: WindowsStepLaunch = {
      image: String.raw`Y:\node.exe`,
      args: [],
      grants: [],
      recoveryHandle: "0123456789abcdef0123456789abcdef",
      pathPrefix: STEP_NODE_DIRECTORY,
    };
    const drives = [{ root: STEP_NODE_DIRECTORY, drive: "Y:" }];
    expect(windowsStepFrames(launch, EXECUTION_ROOT, {}, drives).toString("utf8")).toContain(
      String.raw`PATH`,
    );
    const mixed = windowsStepFrames(
      launch,
      EXECUTION_ROOT,
      { Path: String.raw`C:\a` },
      drives,
    ).toString("utf8");
    expect(mixed).toContain("Path");
    expect(mixed).toContain(String.raw`Y:\;C:\a`);
  });

  it("changes neither the grants nor the PATH of a step that has no step Node.js", () => {
    const launch = windowsStepLaunch(
      { ...invocation, command: String.raw`C:\tools\node\node.exe` },
      String.raw`C:\tools\node\node.exe`,
      EXECUTION_ROOT,
      supervisor,
      "node",
    );
    expect(launch.pathPrefix).toBeUndefined();
    expect(launch.grants.map((grant) => grant.path)).toEqual([
      EXECUTION_ROOT,
      String.raw`C:\tools\node`,
    ]);
    const text = windowsStepFrames(launch, EXECUTION_ROOT, { PATH: String.raw`C:\a` }, []).toString(
      "utf8",
    );
    expect(text).toContain(String.raw`C:\a`);
    expect(text).not.toContain("step-node");
  });
});
