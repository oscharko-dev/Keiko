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
    const ready = at(
      "[System.IO.File]::WriteAllText($ready, [string][System.Diagnostics.Process]::GetCurrentProcess().Id)",
    );
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
    // (the start check ends with exit 2 before anything exists: there is nothing to clean up)
    const beforeDeleting = UNINSTALL_HELPER_SCRIPT.slice(
      0,
      UNINSTALL_HELPER_SCRIPT.indexOf("foreach ($line"),
    ).replace(
      "if (-not $sound) { [System.IO.File]::WriteAllText($refused, 'refused'); exit 2 }",
      "",
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

  // Windows PowerShell 5.1 does not enumerate a JSON array the way PowerShell 7 does, so the list of
  // registration paths is a delimited string: a flat string array on every version. The helper checks
  // that it got what the caller sent before it reports ready.
  it("reads the registration paths as a flat string array and checks them before it reports ready", () => {
    expect(UNINSTALL_HELPER_SCRIPT).not.toMatch(/ConvertFrom-Json|ConvertTo-Json/u);
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "$externals = $env:KEIKO_UNINSTALL_EXTERNALS.Split([char]124)",
    );
    const check = UNINSTALL_HELPER_SCRIPT.indexOf("if (-not $sound) {");
    const ready = UNINSTALL_HELPER_SCRIPT.indexOf("WriteAllText($ready,");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(ready);
    // a refusal of its own start check is reported through a file, so the caller need not wait
    expect(UNINSTALL_HELPER_SCRIPT).toContain("WriteAllText($refused, 'refused'); exit 2");
    // the ready file holds the real helper's own process id: what the caller probes at the commit
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "[System.Diagnostics.Process]::GetCurrentProcess().Id",
    );
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "$externals.Length -eq [int]$env:KEIKO_UNINSTALL_EXTERNALS_COUNT",
    );
  });

  it("does not wait for a process id that names a younger process", () => {
    expect(UNINSTALL_HELPER_SCRIPT).toContain(
      "if ($owner.StartTime -gt [System.Diagnostics.Process]::GetCurrentProcess().StartTime) { $owner = $null }",
    );
  });

  it("deletes a registration entry only when it is one of the paths named at start", () => {
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
        isProcessAlive: () => true,
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
      writeFileSync(join(dir, "ready"), "4711");
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
      "KEIKO_STAGE2_ARGS",
      "KEIKO_STAGE2_EXE",
      "KEIKO_STAGE2_SCRIPT",
      "KEIKO_UNINSTALL_DIR",
      "KEIKO_UNINSTALL_EXTERNALS",
      "KEIKO_UNINSTALL_EXTERNALS_COUNT",
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
      writeFileSync(join(dir, "ready"), "4711");
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
      writeFileSync(join(dir, "ready"), "4711");
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

  it("names the exact external paths to the helper and starts it in the system directory", async () => {
    const parent = tempParent();
    const { deps: base, started } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "4711");
    });
    const result = await startUninstallHelper(ROOT, env, base, EXTERNALS);
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    expect((started[0]?.env.KEIKO_UNINSTALL_EXTERNALS ?? "").split("|")).toEqual(EXTERNALS);
    expect(started[0]?.env.KEIKO_UNINSTALL_EXTERNALS_COUNT).toBe(String(EXTERNALS.length));
    // the real helper's text travels in the environment of the second stage, not on a command line
    expect(started[0]?.env.KEIKO_STAGE2_SCRIPT).toBe(UNINSTALL_HELPER_SCRIPT);
    // the working directory is the system directory: never an installation, never the caller's
    expect(started[0]?.cwd).toBe(String.raw`D:\Windows`);
  });

  it("refuses to commit a registration entry that was not named at start", async () => {
    const parent = tempParent();
    const { deps: d } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "4711");
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

  // The exit code of a child is set only when the event loop processes its exit, and the removal
  // between the start and the commit is synchronous: a helper that died meanwhile is found by probing
  // its process id at the moment of the commit.
  // The ready file names the real helper's own process id, because the first stage (the process this
  // command started) ends on purpose, long before the helper does: only the real helper's id says
  // whether anything will carry out the list.
  it("probes the real helper's process id at the commit, whatever became of the first stage", async () => {
    const parent = tempParent();
    const probed: number[] = [];
    let alive = true;
    const { deps: base } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "4711");
    });
    const result = await startUninstallHelper(
      ROOT,
      env,
      {
        ...base,
        isProcessAlive: (pid) => {
          probed.push(pid);
          return alive;
        },
        // the first stage has ended, successfully, as it is meant to
        spawnFn: (command, args, options) => {
          base.spawnFn?.(command, args, options);
          return { on: (): void => undefined, unref: (): void => undefined, exitCode: 0, pid: 99 };
        },
      },
      EXTERNALS,
    );
    if (result.kind !== "ready") throw new Error("expected a ready helper");
    const entries = [{ kind: "external-file", path: EXTERNALS[0] ?? "" }] as const;
    const listFile = join(parent, readdirSync(parent)[0] ?? "", "residue.txt");
    expect(result.handle.commit(entries)).toBe("committed");
    expect(existsSync(listFile)).toBe(true);
    rmSync(listFile);
    alive = false;
    expect(result.handle.commit(entries)).toBe("helper-gone");
    expect(existsSync(listFile)).toBe(false);
    expect(new Set(probed)).toEqual(new Set([4711]));
  });

  it("refuses at once when the first stage fails to start the helper", async () => {
    const parent = tempParent();
    const { deps: base } = deps(parent, () => undefined);
    const started = Date.now();
    const result = await startUninstallHelper(
      ROOT,
      env,
      {
        ...base,
        readyTimeoutMs: 60_000,
        spawnFn: () => ({ on: (): void => undefined, unref: (): void => undefined, exitCode: 1 }),
      },
      EXTERNALS,
    );
    expect(result).toEqual({ kind: "refused", reason: "spawn-failed" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("refuses at once when the helper's own start check refuses, or reports no process id", async () => {
    for (const report of ["refused", "not a number"]) {
      const parent = tempParent();
      const { deps: base } = deps(parent, (_o, dir) => {
        writeFileSync(join(dir, report === "refused" ? "refused" : "ready"), report);
      });
      const started = Date.now();
      const result = await startUninstallHelper(
        ROOT,
        env,
        { ...base, readyTimeoutMs: 60_000 },
        EXTERNALS,
      );
      expect(result).toEqual({ kind: "refused", reason: "not-ready" });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(readdirSync(parent)).toEqual([]);
    }
  });

  it("waits up to two minutes for the helper to report, before anything is deleted", () => {
    expect(
      readFileSync(new URL("./uninstall-windows-helper.ts", import.meta.url), "utf8"),
    ).toContain("const HELPER_READY_TIMEOUT_MS = 120_000;");
  });

  it("refuses a registration path that holds the list delimiter", async () => {
    const parent = tempParent();
    const { deps: base } = deps(parent, () => undefined);
    await expect(startUninstallHelper(ROOT, env, base, ["C:\\a|b"])).rejects.toThrow(
      "not a plain path",
    );
    expect(readdirSync(parent)).toEqual([]);
  });

  it("tells the person once, after a few seconds, that it is preparing the removal", async () => {
    const parent = tempParent();
    let notices = 0;
    let polls = 0;
    const { deps: base } = deps(parent, () => undefined);
    const result = await startUninstallHelper(
      ROOT,
      env,
      {
        ...base,
        readyTimeoutMs: 8000,
        pollMs: 500,
        // the helper reports on the twelfth poll, six seconds in
        sleep: () => {
          polls += 1;
          if (polls === 12) {
            writeFileSync(join(parent, readdirSync(parent)[0] ?? "", "ready"), "4711");
          }
          return Promise.resolve();
        },
        onPreparing: () => {
          notices += 1;
        },
      },
      EXTERNALS,
    );
    expect(result.kind).toBe("ready");
    expect(notices).toBe(1);
  });

  it("says nothing when the helper is quick", async () => {
    const parent = tempParent();
    let notices = 0;
    const { deps: base } = deps(parent, (_o, dir) => {
      writeFileSync(join(dir, "ready"), "4711");
    });
    await startUninstallHelper(
      ROOT,
      env,
      {
        ...base,
        onPreparing: () => {
          notices += 1;
        },
      },
      EXTERNALS,
    );
    expect(notices).toBe(0);
  });
});
