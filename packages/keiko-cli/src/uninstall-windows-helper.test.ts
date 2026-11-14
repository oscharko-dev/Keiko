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
const EXTERNALS = [String.raw`C:\Users\Anna\state.json`, String.raw`C:\Users\Anna\.keiko`];
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

  it("acts in this order: ready, the committed list, the end of this process, then deleting", () => {
    const at = (text: string): number => UNINSTALL_HELPER_SCRIPT.indexOf(text);
    const ready = at("[System.IO.File]::WriteAllText($ready, 'ready')");
    const list = at("while (-not [System.IO.File]::Exists($list))");
    const owner = at("$owner.WaitForExit(");
    const deleting = at("foreach ($line in [System.IO.File]::ReadAllLines($list))");
    for (const index of [ready, list, owner, deleting]) expect(index).toBeGreaterThan(-1);
    expect(ready).toBeLessThan(list);
    expect(list).toBeLessThan(owner);
    expect(owner).toBeLessThan(deleting);
  });

  it("bounds the two waits differently: generous for the list, short for this process", () => {
    expect(UNINSTALL_HELPER_SCRIPT).toContain("AddSeconds(1800)");
    expect(UNINSTALL_HELPER_SCRIPT).toContain("WaitForExit(60000)");
  });

  it("ends without deleting, and removes its own folder, when no list ever comes or the wait ends", () => {
    const withoutList =
      "if ($owner -eq $null -or $owner.HasExited) { if ([System.IO.File]::Exists($list)) { break }; Remove-KeikoOwn; exit 0 }";
    expect(UNINSTALL_HELPER_SCRIPT).toContain(withoutList);
    expect(UNINSTALL_HELPER_SCRIPT).toContain("Remove-KeikoOwn; exit 3");
    // every exit before the deleting phase cleans up first
    const beforeDeleting = UNINSTALL_HELPER_SCRIPT.slice(
      0,
      UNINSTALL_HELPER_SCRIPT.indexOf("foreach ($line"),
    );
    for (const exit of beforeDeleting.match(/exit \d/gu) ?? []) {
      expect(beforeDeleting).toContain(`Remove-KeikoOwn; ${exit}`);
    }
  });

  it("keeps file, identity and folder entries of the installation under its root", () => {
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "if (-not (($path + $sep).Equals($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase))) { $failed = $true; continue }",
    );
    expect(UNINSTALL_HELPER_SCRIPT).toContain("[System.IO.Path]::GetFullPath($path) -ne $path");
    // the root is never trimmed: a drive root keeps its separator
    expect(UNINSTALL_HELPER_SCRIPT).not.toContain("TrimEnd");
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "$prefix = if ($root.EndsWith($sep)) { $root } else { $root + $sep }",
    );
  });

  it("deletes a registration entry only when it is one of the paths named at start", () => {
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "$externals = @(ConvertFrom-Json $env:KEIKO_UNINSTALL_EXTERNALS)",
    );
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "if ($path.Equals($e, [System.StringComparison]::OrdinalIgnoreCase)) { $known = $true }",
    );
    expect(UNINSTALL_HELPER_SCRIPT).toContain("if (-not $known) { $failed = $true; continue }");
  });

  it("never deletes through a link, and a failed entry keeps the identity files and the registration", () => {
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "if (([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $failed = $true; continue }",
    );
    expect(UNINSTALL_HELPER_SCRIPT).toContain("if ($kind -eq 'I' -and $failed) { continue }");
    expect(UNINSTALL_HELPER_SCRIPT).toContain("if ($failed) { continue }");
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "if (-not $ok -and $kind -ne 'S') { $failed = $true }",
    );
    expect(
      UNINSTALL_HELPER_SCRIPT.endsWith("Remove-KeikoOwn; if ($failed) { exit 1 } else { exit 0 }"),
    ).toBe(true);
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
    const result = await startUninstallHelper(ROOT, env, d, EXTERNALS);
    expect(result.kind).toBe("ready");
    expect(started[0]).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    expect(Object.keys(started[0]?.env ?? {}).sort()).toEqual([
      "KEIKO_UNINSTALL_DIR",
      "KEIKO_UNINSTALL_EXTERNALS",
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
    const result = await startUninstallHelper(ROOT, env, d, EXTERNALS);
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
    const result = await startUninstallHelper(ROOT, env, d, EXTERNALS);
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    expect(() => {
      result.handle.commit([{ kind: "file", path: `${ROOT}\\a\nD\t${ROOT}` }]);
    }).toThrow("not a plain path");
  });

  it("refuses, and leaves nothing behind, when the helper never reports ready", async () => {
    const parent = tempParent();
    const { deps: d } = deps(parent, () => undefined);
    await expect(startUninstallHelper(ROOT, env, d, EXTERNALS)).resolves.toEqual({
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
    await expect(startUninstallHelper(ROOT, env, thrown.deps, EXTERNALS)).resolves.toEqual({
      kind: "refused",
      reason: "spawn-failed",
      failureKind: "Error",
    });
    const errored = deps(parent, () => undefined);
    await expect(
      startUninstallHelper(
        ROOT,
        env,
        {
          ...errored.deps,
          spawnFn: (_c, _a, _o) => ({
            on: (_event, listener): void => {
              listener(new Error("spawn ENOENT"));
            },
            unref: (): void => undefined,
          }),
        },
        EXTERNALS,
      ),
    ).resolves.toEqual({ kind: "refused", reason: "spawn-failed" });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses when PowerShell cannot be resolved, before anything is created", async () => {
    const parent = tempParent();
    const { deps: d, started } = deps(parent, () => undefined);
    await expect(
      startUninstallHelper(ROOT, env, { ...d, existsAsFile: () => false }, EXTERNALS),
    ).resolves.toMatchObject({ kind: "refused", reason: "powershell-unavailable" });
    expect(started).toEqual([]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses a temp folder that lies inside the installation", async () => {
    const parent = tempParent();
    const inside = join(parent, "Keiko");
    mkdirSync(inside);
    const { deps: d, started } = deps(inside, () => undefined);
    await expect(startUninstallHelper(inside, env, d, EXTERNALS)).resolves.toEqual({
      kind: "refused",
      reason: "temp-inside-installation",
    });
    expect(started).toEqual([]);
    expect(readdirSync(inside)).toEqual([]);
  });

  it("names the exact external paths to the helper, starts it in the system directory and tracks its end", async () => {
    const parent = tempParent();
    const ending: { exitCode: number | null } = { exitCode: null };
    const { deps: base, started } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "ready");
    });
    const result = await startUninstallHelper(
      ROOT,
      env,
      {
        ...base,
        spawnFn: (command, args, options) => {
          base.spawnFn?.(command, args, options);
          return {
            on: (): void => undefined,
            unref: (): void => undefined,
            get exitCode(): number | null {
              return ending.exitCode;
            },
          };
        },
      },
      EXTERNALS,
    );
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    expect(JSON.parse(started[0]?.env.KEIKO_UNINSTALL_EXTERNALS ?? "null")).toEqual(EXTERNALS);
    // the working directory is the system directory: never an installation, never the caller's
    expect(started[0]?.cwd).toBe(String.raw`D:\Windows`);
    const entries = [{ kind: "external-file", path: EXTERNALS[0] ?? "" }] as const;
    const listFile = join(parent, readdirSync(parent)[0] ?? "", "residue.txt");
    expect(result.handle.commit(entries)).toBe("committed");
    expect(existsSync(listFile)).toBe(true);
    // a helper that ended is not handed a list: the caller keeps the installation registered
    rmSync(listFile);
    ending.exitCode = 1;
    expect(result.handle.commit(entries)).toBe("helper-gone");
    expect(existsSync(listFile)).toBe(false);
  });

  it("refuses to commit a registration entry that was not named at start", async () => {
    const parent = tempParent();
    const { deps: d } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "ready");
    });
    const result = await startUninstallHelper(ROOT, env, d, EXTERNALS);
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    expect(() => {
      result.handle.commit([{ kind: "external-file", path: String.raw`C:\Users\Anna\other.json` }]);
    }).toThrow("was not named at start");
    expect(() => {
      result.handle.commit([{ kind: "external-directory", path: String.raw`C:\Windows` }]);
    }).toThrow("was not named at start");
  });
});
