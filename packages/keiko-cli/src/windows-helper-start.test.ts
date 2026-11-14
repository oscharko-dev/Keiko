import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveWindowsPowerShellHelper,
  startVisibleWindowsHelper,
  visibleWindowsHelperSpawnOptions,
  windowsHelperEnv,
  type VisibleWindowsHelperSpawnOptions,
} from "./windows-helper-start.js";

// #4358: a helper started detached owns no console, and on the Windows guest such a PowerShell
// exited 0 without doing anything. The one start for every helper the launcher needs to run is
// attached with a hidden window. A unit test sees the options, not the program: that it really runs
// is proven by a screenshot, and by what the helper does, on Windows.
describe("the visible Windows helper start", () => {
  it("is attached, hidden, without a shell and without inherited streams", () => {
    expect(visibleWindowsHelperSpawnOptions({ A: "1" })).toEqual({
      detached: false,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
      env: { A: "1" },
      cwd: tmpdir(),
    });
  });

  // A helper that inherits the caller's working directory holds it for its whole life; the caller
  // may be running from inside an installation it is about to remove (#4358).
  it("starts in the system directory, or the temp folder, never in the caller's directory", () => {
    const system = String.raw`D:\Windows`;
    expect(visibleWindowsHelperSpawnOptions({ SystemRoot: system }).cwd).toBe(system);
    expect(visibleWindowsHelperSpawnOptions({ SystemRoot: "relative" }).cwd).toBe(tmpdir());
    expect(visibleWindowsHelperSpawnOptions({}).cwd).toBe(tmpdir());
    expect(visibleWindowsHelperSpawnOptions({}).cwd).not.toBe(process.cwd());
  });

  it("hands the command, the arguments and exactly those options to the spawn", () => {
    const calls: [string, readonly string[], VisibleWindowsHelperSpawnOptions][] = [];
    const child = startVisibleWindowsHelper(
      "powershell.exe",
      ["-NoLogo"],
      { A: "1" },
      (c, a, o) => {
        calls.push([c, a, o]);
        return { on: (): void => undefined, unref: (): void => undefined };
      },
    );
    expect(calls).toEqual([
      ["powershell.exe", ["-NoLogo"], visibleWindowsHelperSpawnOptions({ A: "1" })],
    ]);
    expect(typeof child.unref).toBe("function");
  });

  it("builds the minimal environment from the system root, the temp folders and named inputs", () => {
    const system = { command: "powershell.exe", systemRoot: String.raw`D:\Windows` };
    expect(
      windowsHelperEnv({ TEMP: "t", TMP: "m", SECRET: "x", PATH: "p" }, system, { K: "v" }),
    ).toEqual({
      SystemRoot: String.raw`D:\Windows`,
      WINDIR: String.raw`D:\Windows`,
      TEMP: "t",
      TMP: "m",
      K: "v",
    });
    expect(windowsHelperEnv({}, system)).toEqual({
      SystemRoot: String.raw`D:\Windows`,
      WINDIR: String.raw`D:\Windows`,
    });
  });

  it("resolves the trusted System32 PowerShell and refuses a missing one", () => {
    const env = { SystemRoot: String.raw`D:\Windows` };
    expect(
      resolveWindowsPowerShellHelper(
        env,
        () => true,
        () => true,
      ),
    ).toEqual({
      systemRoot: String.raw`D:\Windows`,
      command: String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    });
    expect(() =>
      resolveWindowsPowerShellHelper(
        env,
        () => true,
        () => false,
      ),
    ).toThrow();
  });
});
