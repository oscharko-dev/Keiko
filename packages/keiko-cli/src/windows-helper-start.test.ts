import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  OUTLIVING_STAGE_ONE_SCRIPT,
  resolveWindowsPowerShellHelper,
  startOutlivingWindowsHelper,
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

  // libuv puts every attached child into one job object that ends it with its parent, and only the
  // processes libuv starts belong to it. A helper that must outlive the keiko process is therefore the
  // grandchild: the first stage, the start proven to run, only starts it. That the grandchild really
  // survives is provable only on Windows; this pins the shape of both stages.
  describe("startOutlivingWindowsHelper", () => {
    const system = {
      command: String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      systemRoot: String.raw`D:\Windows`,
    };

    function start(
      script: string,
      flags?: readonly string[],
    ): { args: readonly string[]; options: VisibleWindowsHelperSpawnOptions; command: string } {
      let captured:
        | { args: readonly string[]; options: VisibleWindowsHelperSpawnOptions; command: string }
        | undefined;
      startOutlivingWindowsHelper(
        {
          system,
          env: { SystemRoot: system.systemRoot, SECRET: "x" },
          script,
          stageTwoFlags: flags,
          extraEnv: { K: "v" },
        },
        (command, args, options) => {
          captured = { command, args, options };
          return { on: (): void => undefined, unref: (): void => undefined };
        },
      );
      if (captured === undefined) throw new Error("the helper was not started");
      return captured;
    }

    it("starts the attached, hidden first stage on the trusted PowerShell with a fixed command", () => {
      const { command, args, options } = start("Show-Something 'text'");
      expect(command).toBe(system.command);
      expect(args).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        OUTLIVING_STAGE_ONE_SCRIPT,
      ]);
      expect(options).toMatchObject({
        detached: false,
        windowsHide: true,
        stdio: "ignore",
        shell: false,
        cwd: system.systemRoot,
      });
    });

    it("lets the first stage do nothing but start the real helper in a hidden window", () => {
      expect(OUTLIVING_STAGE_ONE_SCRIPT).toBe(
        "Start-Process -FilePath $env:KEIKO_STAGE2_EXE -ArgumentList $env:KEIKO_STAGE2_ARGS -WindowStyle Hidden",
      );
      expect(OUTLIVING_STAGE_ONE_SCRIPT).not.toContain('"');
    });

    it("hands the real helper its text, its flags and its inputs through the environment only", () => {
      const text = `Show 'it''s "quoted"'; exit 0`;
      const { args, options } = start(text, ["-Sta"]);
      // the text is on no command line, so no quoting of it can go wrong
      expect(args.join(" ")).not.toContain("quoted");
      expect(options.env).toEqual({
        SystemRoot: system.systemRoot,
        WINDIR: system.systemRoot,
        K: "v",
        KEIKO_STAGE2_EXE: system.command,
        KEIKO_STAGE2_ARGS:
          "-NoLogo -NoProfile -Sta -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command Invoke-Expression $env:KEIKO_STAGE2_SCRIPT",
        KEIKO_STAGE2_SCRIPT: text,
      });
      // nothing of the caller's environment leaks in
      expect(options.env.SECRET).toBeUndefined();
    });
  });
});
