import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runsInsideInstallation,
  startUninstallHelper,
  UNINSTALL_HELPER_SCRIPT,
  type UninstallHelperDeps,
} from "./uninstall-windows-helper.js";
import type { VisibleWindowsHelperSpawnOptions } from "./windows-helper-start.js";

const ROOT = String.raw`C:\Users\Anna\AppData\Local\Programs\Keiko`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempParent(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-helper-test-"));
  roots.push(root);
  return root;
}

describe("runsInsideInstallation", () => {
  const base = {
    installRoot: ROOT,
    platform: "win32",
    execPath: String.raw`C:\Program Files\nodejs\node.exe`,
    argv1: String.raw`C:\tools\keiko\index.js`,
    cwd: String.raw`C:\Users\Anna`,
  } as const;

  it("is false for a command run from outside the installation", () => {
    expect(runsInsideInstallation(base)).toBe(false);
  });

  it.each([
    [
      "executable",
      { execPath: String.raw`C:\Users\Anna\AppData\Local\Programs\Keiko\runtime\node\node.exe` },
    ],
    [
      "script",
      { argv1: String.raw`C:\Users\Anna\AppData\Local\Programs\Keiko\app\dist\cli\index.js` },
    ],
    ["working directory", { cwd: String.raw`C:\Users\Anna\AppData\Local\Programs\Keiko\app` }],
    ["install root itself", { cwd: ROOT }],
    [
      "path in other letter case",
      { execPath: String.raw`c:\users\ANNA\appdata\local\programs\keiko\runtime\node\node.exe` },
    ],
  ])("is true when the %s lies inside the installation", (_name, patch) => {
    expect(runsInsideInstallation({ ...base, ...patch })).toBe(true);
  });

  it("is false for a sibling folder that only starts with the root's name", () => {
    expect(
      runsInsideInstallation({
        ...base,
        execPath: String.raw`C:\Users\Anna\AppData\Local\Programs\Keiko-old\runtime\node\node.exe`,
      }),
    ).toBe(false);
  });

  it("is false on every platform that can remove a running program's files", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(runsInsideInstallation({ ...base, platform, cwd: ROOT })).toBe(false);
    }
  });

  it("tolerates a missing script path", () => {
    expect(runsInsideInstallation({ ...base, argv1: undefined })).toBe(false);
  });
});

describe("the helper's command", () => {
  it("is one plain line of single-quoted PowerShell that never removes recursively", () => {
    expect(UNINSTALL_HELPER_SCRIPT).not.toMatch(/[\r\n]/u);
    expect(UNINSTALL_HELPER_SCRIPT).not.toContain('"');
    expect(UNINSTALL_HELPER_SCRIPT).not.toMatch(/recurse|Remove-Item/iu);
    expect(UNINSTALL_HELPER_SCRIPT).toContain("[System.IO.Directory]::Delete($path, $false)");
    expect(UNINSTALL_HELPER_SCRIPT.length).toBeLessThan(6000);
  });

  it("reports ready first, waits for this process to end and acts only on a committed list", () => {
    const ready = UNINSTALL_HELPER_SCRIPT.indexOf("'ready'");
    const wait = UNINSTALL_HELPER_SCRIPT.indexOf("WaitForExit(");
    const list = UNINSTALL_HELPER_SCRIPT.indexOf("[System.IO.File]::Exists($list)");
    expect(ready).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(ready);
    expect(list).toBeGreaterThan(wait);
  });

  it("keeps file and folder entries of the installation under its root", () => {
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "if (($kind -eq 'F' -or $kind -eq 'D') -and -not $inside) { continue }",
    );
    expect(UNINSTALL_HELPER_SCRIPT).toContain("[System.IO.Path]::GetFullPath($path) -ne $path");
  });
});

describe("startUninstallHelper", () => {
  function deps(
    parent: string,
    behaviour: (options: VisibleWindowsHelperSpawnOptions, directory: string) => void,
  ): { readonly deps: UninstallHelperDeps; readonly started: VisibleWindowsHelperSpawnOptions[] } {
    const started: VisibleWindowsHelperSpawnOptions[] = [];
    return {
      started,
      deps: {
        pid: 4242,
        tempParent: parent,
        identityCheck: () => true,
        existsAsFile: () => true,
        readyTimeoutMs: 3,
        pollMs: 1,
        sleep: () => Promise.resolve(),
        spawnFn: (_command, _args, options): { on: () => void; unref: () => void } => {
          started.push(options);
          behaviour(options, options.env.KEIKO_UNINSTALL_DIR ?? "");
          return { on: (): void => undefined, unref: (): void => undefined };
        },
      },
    };
  }
  const env = { SystemRoot: String.raw`D:\Windows`, SECRET_TOKEN: "x", PATH: "p", TEMP: "t" };

  it("hands the helper only its own inputs and the system variables", async () => {
    const parent = tempParent();
    const { deps: d, started } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "ready");
    });
    const result = await startUninstallHelper(ROOT, env, d);
    expect(result.kind).toBe("ready");
    expect(started[0]).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    expect(Object.keys(started[0]?.env ?? {}).sort()).toEqual([
      "KEIKO_UNINSTALL_DIR",
      "KEIKO_UNINSTALL_PID",
      "KEIKO_UNINSTALL_ROOT",
      "SystemRoot",
      "TEMP",
      "WINDIR",
    ]);
    expect(started[0]?.env.KEIKO_UNINSTALL_PID).toBe("4242");
    expect(started[0]?.env.KEIKO_UNINSTALL_ROOT).toBe(ROOT);
  });

  it("commits the list atomically, one kind-tagged path per line", async () => {
    const parent = tempParent();
    const { deps: d } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "ready");
    });
    const result = await startUninstallHelper(ROOT, env, d);
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    const directory = join(parent, readdirSync(parent)[0] ?? "");
    expect(existsSync(join(directory, "residue.txt"))).toBe(false);
    result.handle.commit([
      { kind: "file", path: `${ROOT}\\a.dll` },
      { kind: "directory", path: ROOT },
      { kind: "external-file", path: String.raw`C:\Users\Anna\state.json` },
      { kind: "external-directory", path: String.raw`C:\Users\Anna\.keiko` },
    ]);
    expect(readdirSync(directory).sort()).toEqual(["ready", "residue.txt"]);
    expect(readFileSync(join(directory, "residue.txt"), "utf8")).toBe(
      [
        `F\t${ROOT}\\a.dll`,
        `D\t${ROOT}`,
        "X\tC:\\Users\\Anna\\state.json",
        "S\tC:\\Users\\Anna\\.keiko",
        "",
      ].join("\n"),
    );
  });

  it("refuses a path that is not a plain path", async () => {
    const parent = tempParent();
    const { deps: d } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "ready");
    });
    const result = await startUninstallHelper(ROOT, env, d);
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    expect(() => {
      result.handle.commit([{ kind: "file", path: `${ROOT}\\a\nD\t${ROOT}` }]);
    }).toThrow("not a plain path");
  });

  it("refuses, and leaves nothing behind, when the helper never reports ready", async () => {
    const parent = tempParent();
    const { deps: d } = deps(parent, () => undefined);
    await expect(startUninstallHelper(ROOT, env, d)).resolves.toEqual({
      kind: "refused",
      reason: "not-ready",
    });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses when the start throws or reports an error", async () => {
    const parent = tempParent();
    const thrown = deps(parent, () => {
      throw new Error("spawn EACCES");
    });
    await expect(startUninstallHelper(ROOT, env, thrown.deps)).resolves.toEqual({
      kind: "refused",
      reason: "spawn-failed",
      failureKind: "Error",
    });
    const errored = deps(parent, () => undefined);
    await expect(
      startUninstallHelper(ROOT, env, {
        ...errored.deps,
        spawnFn: (_c, _a, _o) => ({
          on: (_event, listener): void => {
            listener(new Error("spawn ENOENT"));
          },
          unref: (): void => undefined,
        }),
      }),
    ).resolves.toEqual({ kind: "refused", reason: "spawn-failed" });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses when PowerShell cannot be resolved, before anything is created", async () => {
    const parent = tempParent();
    const { deps: d, started } = deps(parent, () => undefined);
    await expect(
      startUninstallHelper(ROOT, env, { ...d, existsAsFile: () => false }),
    ).resolves.toMatchObject({ kind: "refused", reason: "powershell-unavailable" });
    expect(started).toEqual([]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses a temp folder that lies inside the installation", async () => {
    const parent = tempParent();
    const inside = join(parent, "Keiko");
    mkdirSync(inside);
    const { deps: d, started } = deps(inside, () => undefined);
    await expect(startUninstallHelper(inside, env, d)).resolves.toEqual({
      kind: "refused",
      reason: "temp-inside-installation",
    });
    expect(started).toEqual([]);
    expect(readdirSync(inside)).toEqual([]);
  });
});
