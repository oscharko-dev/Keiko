import { describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { createCliSecurityLogSink } from "./security-log.js";
import { OUTLIVING_STAGE_ONE_SCRIPT } from "./windows-helper-start.js";
import {
  notifyPortableLaunchFailure,
  runDetachedAlert,
  runDetachedWindowsAlert,
} from "./portable-launch-notifier.js";

const UI_LAUNCH = { KEIKO_PORTABLE_UI_LAUNCH: "1" };

function recordingSecuritySink(): {
  readonly sink: NonNullable<ReturnType<typeof createCliSecurityLogSink>>;
  readonly events: SecurityLogEvent[];
} {
  const events: SecurityLogEvent[] = [];
  const sink = createCliSecurityLogSink("/state", () => ({
    write: (event): void => {
      events.push(event);
    },
  }));
  if (sink === undefined) throw new Error("test security log sink was not created");
  return { sink, events };
}

describe("notifyPortableLaunchFailure", () => {
  it("shows the recorded failure in a quoted alert for a double-click launch", () => {
    const scripts: string[] = [];

    notifyPortableLaunchFailure('keiko portable launch: "quoted" \\ reason\n', UI_LAUNCH, {
      platform: () => "darwin",
      runAlert: (script) => {
        scripts.push(script);
      },
    });

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('message "keiko portable launch: \\"quoted\\" \\\\ reason');
    expect(scripts[0]).toContain('display alert "Keiko could not start"');
    expect(scripts[0]).not.toContain("\n");
  });

  it("bounds an oversized failure message before display", () => {
    const scripts: string[] = [];

    notifyPortableLaunchFailure("x".repeat(5_000), UI_LAUNCH, {
      platform: () => "darwin",
      runAlert: (script) => {
        scripts.push(script);
      },
    });

    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.length ?? Number.POSITIVE_INFINITY).toBeLessThan(600);
  });

  it.each([
    [400, true],
    [401, false],
  ])(
    "truncates exactly at the 400-character display ceiling (%d displayable characters)",
    (length, tailSurvives) => {
      // The exact boundary: the 400th displayable character survives, the 401st is cut. The
      // message ends in "Z", which appears nowhere in the alert's fixed prefix or suffix, so its
      // presence in the script tells exactly which side of the ceiling was kept.
      const scripts: string[] = [];

      notifyPortableLaunchFailure("x".repeat(length - 1) + "Z", UI_LAUNCH, {
        platform: () => "darwin",
        runAlert: (script) => {
          scripts.push(script);
        },
      });

      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.includes("Z")).toBe(tailSurvives);
    },
  );

  it("substitutes a fixed text for an empty failure message", () => {
    const scripts: string[] = [];

    notifyPortableLaunchFailure("  \n", UI_LAUNCH, {
      platform: () => "darwin",
      runAlert: (script) => {
        scripts.push(script);
      },
    });

    expect(scripts[0]).toContain("The portable launch failed without a reason.");
  });

  it("shows the recorded failure in a Windows alert for a double-click launch", () => {
    const messages: string[] = [];
    const env = { KEIKO_PORTABLE_UI_LAUNCH: "1", SystemRoot: String.raw`D:\Windows` };

    notifyPortableLaunchFailure("keiko portable launch: failed\n", env, {
      platform: () => "win32",
      runWindowsAlert: (message) => {
        messages.push(message);
      },
    });

    expect(messages).toEqual(["keiko portable launch: failed\n"]);
  });

  it.each([
    [
      "hostile root",
      String.raw`\\attacker\share`,
      undefined,
      "security",
      "security.windows-portable-alert.system-root-refused",
      "WindowsSystemDirectoryError",
    ],
    [
      "missing PowerShell",
      String.raw`D:\Windows`,
      (): boolean => false,
      "diagnostic",
      "security.windows-portable-alert.system-binary-missing",
      "WINDOWS_SYSTEM_BINARY_MISSING",
    ],
  ] as const)(
    "keeps the notifier best-effort and logs a body-free Windows %s refusal",
    (_label, systemRoot, windowsBinaryExists, category, op, errorKind) => {
      const { sink, events } = recordingSecuritySink();
      const reported: string[] = [];

      expect(() => {
        notifyPortableLaunchFailure(
          "reason",
          { ...UI_LAUNCH, SystemRoot: systemRoot },
          {
            platform: () => "win32",
            securityLogSink: sink,
            ...(windowsBinaryExists === undefined ? {} : { windowsBinaryExists }),
            ...(windowsBinaryExists === undefined
              ? {}
              : { windowsSystemDirectoryIdentity: (): boolean => true }),
            reportAlertFailure: (line) => {
              reported.push(line);
            },
          },
        );
      }).not.toThrow();

      expect(reported).toEqual(["keiko portable launch: the failure alert could not be shown\n"]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category,
        op,
        errorKind: errorKind === "WindowsSystemDirectoryError" ? "unsafe-target" : "unavailable",
        extra: { failureKind: errorKind },
      });
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(events)).not.toContain(systemRoot);
    },
  );

  it.each([[{}], [{ KEIKO_PORTABLE_UI_LAUNCH: "true" }]])(
    "stays silent without the exact double-click marker",
    (env) => {
      // The v0.3.0 lesson that created this gate: a TTY heuristic cannot tell a Finder launch
      // from a test runner, and the first notifier version raised real desktop dialogs from the
      // test suite's failure paths. Only the native launcher's exact marker may raise an alert.
      let shown = false;

      notifyPortableLaunchFailure("reason", env, {
        platform: () => "darwin",
        runAlert: () => {
          shown = true;
        },
      });

      expect(shown).toBe(false);
    },
  );

  it("stays silent on an unsupported platform", () => {
    let shown = false;

    notifyPortableLaunchFailure("reason", UI_LAUNCH, {
      platform: () => "linux",
      runAlert: () => {
        shown = true;
      },
    });

    expect(shown).toBe(false);
  });

  it("records a synchronous alert failure with the fixed line instead of swallowing it", () => {
    const reported: string[] = [];

    expect(() => {
      notifyPortableLaunchFailure("reason", UI_LAUNCH, {
        platform: () => "darwin",
        runAlert: () => {
          throw new Error("no WindowServer");
        },
        reportAlertFailure: (line) => {
          reported.push(line);
        },
      });
    }).not.toThrow();

    expect(reported).toEqual(["keiko portable launch: the failure alert could not be shown\n"]);
  });

  it("reads the host platform when no platform seam is injected", () => {
    // Deterministic per host: the alert seam fires exactly when the real platform supports a
    // native dialog. Both alert seams keep the test dialog-free either way.
    let shown = false;

    notifyPortableLaunchFailure("reason", UI_LAUNCH, {
      runAlert: () => {
        shown = true;
      },
      runWindowsAlert: () => {
        shown = true;
      },
    });

    expect(shown).toBe(process.platform === "darwin" || process.platform === "win32");
  });
});

describe("runDetachedAlert", () => {
  it("spawns the bounded detached osascript contract and detaches from it", () => {
    const calls: unknown[][] = [];
    const reported: string[] = [];
    let errorHandler: ((error: Error) => void) | undefined;
    let unreferenced = false;

    runDetachedAlert(
      "display alert",
      (command, args, options) => {
        calls.push([command, args, options]);
        return {
          on: (_event, listener): void => {
            errorHandler = listener;
          },
          unref: (): void => {
            unreferenced = true;
          },
        };
      },
      (line) => {
        reported.push(line);
      },
    );

    expect(calls).toEqual([
      [
        "/usr/bin/osascript",
        ["-e", "display alert"],
        { detached: true, env: {}, shell: false, stdio: "ignore" },
      ],
    ]);
    expect(unreferenced).toBe(true);
    // The error listener must exist and must not throw — an unhandled 'error' event would crash
    // the CLI process the alert exists to explain — and it must record the fixed failure line.
    expect(errorHandler).toBeDefined();
    expect(() => {
      errorHandler?.(new Error("spawn ENOENT"));
    }).not.toThrow();
    expect(reported).toEqual(["keiko portable launch: the failure alert could not be shown\n"]);
  });
});

describe("runDetachedWindowsAlert", () => {
  it("spawns the bounded attached PowerShell MessageBox contract and does not wait for it", () => {
    const calls: unknown[][] = [];
    const reported: string[] = [];
    const { sink, events } = recordingSecuritySink();
    let errorHandler: ((error: Error) => void) | undefined;
    let unreferenced = false;

    runDetachedWindowsAlert(
      "can't start\r\nbecause",
      { SystemRoot: String.raw`D:\Windows` },
      (command, args, options) => {
        calls.push([command, args, options]);
        return {
          on: (_event, listener): void => {
            errorHandler = listener;
          },
          unref: (): void => {
            unreferenced = true;
          },
        };
      },
      (line) => {
        reported.push(line);
      },
      () => true,
      sink,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    // Two stages (#4358): libuv ends every attached child with the process that started it, and the
    // failure alert is shown just before that process ends. The first stage, the start proven to run,
    // only starts the real box as its own process; the box's text and flags reach it through the
    // environment, never through quoting.
    expect(calls[0]?.[1]).toEqual([
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
    // PowerShell/WPF need the core system variables to initialize; everything else stays
    // withheld from the child (no TEMP/TMP here because the caller env carries none). The child
    // is attached with a hidden console: a detached PowerShell owns no console and exits without
    // showing its box on the Windows guest (#4358). The launcher still never waits for it: the
    // child is unreferenced.
    expect(calls[0]?.[2]).toEqual({
      detached: false,
      env: {
        SystemRoot: String.raw`D:\Windows`,
        WINDIR: String.raw`D:\Windows`,
        KEIKO_STAGE2_EXE: String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
        KEIKO_STAGE2_ARGS:
          "-NoLogo -NoProfile -Sta -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command Invoke-Expression $env:KEIKO_STAGE2_SCRIPT",
        KEIKO_STAGE2_SCRIPT:
          "Add-Type -AssemblyName PresentationFramework; " +
          "[System.Windows.MessageBox]::Show('can''t startbecause', " +
          "'Keiko could not start', 'OK', 'Error') | Out-Null",
      },
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      cwd: String.raw`D:\Windows`,
    });
    expect(unreferenced).toBe(true);
    expect(errorHandler).toBeDefined();
    expect(() => {
      errorHandler?.(new Error("spawn ENOENT"));
    }).not.toThrow();
    expect(reported).toEqual(["keiko portable launch: the failure alert could not be shown\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "diagnostic",
      op: "portable.windows-alert.spawn-failed",
      errorKind: "unavailable",
      extra: { surface: "portable-failure-alert", failureKind: "Error" },
    });
    expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("forwards supplied TEMP and TMP into the detached child environment", () => {
    const calls: unknown[][] = [];
    runDetachedWindowsAlert(
      "boom",
      {
        SystemRoot: String.raw`D:\Windows`,
        TEMP: String.raw`D:\Scratch\Temp`,
        TMP: String.raw`D:\Scratch\Tmp`,
      },
      (command, args, options) => {
        calls.push([command, args, options]);
        return { on: (): void => undefined, unref: (): void => undefined };
      },
      () => undefined,
      () => true,
    );
    // WPF initialization needs a writable temp location when the profile provides one; both
    // variables must reach the child exactly as supplied, and nothing else may leak in.
    const env = (calls[0]?.[2] as { env: Record<string, string> }).env;
    expect(
      Object.keys(env)
        .filter((key) => !key.startsWith("KEIKO_STAGE2_"))
        .sort(),
    ).toEqual(["SystemRoot", "TEMP", "TMP", "WINDIR"]);
    expect({
      SystemRoot: env.SystemRoot,
      WINDIR: env.WINDIR,
      TEMP: env.TEMP,
      TMP: env.TMP,
    }).toEqual({
      SystemRoot: String.raw`D:\Windows`,
      WINDIR: String.raw`D:\Windows`,
      TEMP: String.raw`D:\Scratch\Temp`,
      TMP: String.raw`D:\Scratch\Tmp`,
    });
  });
});

// #4358 v5: the setup notice moved out of this file. A double-click on the downloaded launcher now
// gets its feedback from the native launcher itself (native/portable-launcher), before Node loads;
// the wording, the delay and the single-instance behavior are pinned in
// portable-launcher-feedback.test.ts. What stays here is the failure alert, unchanged.
describe("the failure alert's Windows box", () => {
  const spawned = (): {
    readonly args: (readonly string[])[];
    readonly envs: NodeJS.ProcessEnv[];
    readonly options: { detached: boolean; windowsHide?: boolean; stdio: string; cwd?: string }[];
    readonly unreferenced: boolean[];
    readonly spawnFn: Parameters<typeof runDetachedWindowsAlert>[2];
  } => {
    const args: (readonly string[])[] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const options: { detached: boolean; windowsHide?: boolean; stdio: string; cwd?: string }[] = [];
    const unreferenced: boolean[] = [];
    const spawnFn: Parameters<typeof runDetachedWindowsAlert>[2] = (
      _command,
      argv,
      spawnOptions,
    ) => {
      const index = args.length;
      args.push(argv);
      envs.push(spawnOptions.env);
      options.push({ ...spawnOptions });
      unreferenced.push(false);
      return {
        on: (): void => undefined,
        unref: (): void => {
          unreferenced[index] = true;
        },
      };
    };
    return { args, envs, options, unreferenced, spawnFn };
  };
  const windows = { SystemRoot: String.raw`D:\Windows` };
  const trusted = [(): boolean => true, undefined, (): boolean => true] as const;

  it("shows the recorded reason in an error box that outlives the keiko process", () => {
    const { args, envs, spawnFn } = spawned();

    runDetachedWindowsAlert(
      "can't start\r\nbecause",
      windows,
      spawnFn,
      undefined,
      trusted[0],
      trusted[1],
      trusted[2],
    );

    // the command is the real box's text, handed over in the environment of the second stage
    expect(args[0]?.at(-1)).toBe(OUTLIVING_STAGE_ONE_SCRIPT);
    expect(envs[0]?.KEIKO_STAGE2_SCRIPT).toBe(
      "Add-Type -AssemblyName PresentationFramework; " +
        "[System.Windows.MessageBox]::Show('can''t startbecause', " +
        "'Keiko could not start', 'OK', 'Error') | Out-Null",
    );
  });

  // #4358, Windows window on build cb59ec31f: a box that was requested and logged did not appear.
  // The alert starts through the one visible-helper start the browser opener uses.
  it("starts attached, hidden and unreferenced, from the system directory", () => {
    const { options, unreferenced, spawnFn } = spawned();

    runDetachedWindowsAlert(
      "it failed",
      windows,
      spawnFn,
      undefined,
      trusted[0],
      trusted[1],
      trusted[2],
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
      cwd: String.raw`D:\Windows`,
    });
    expect(unreferenced).toEqual([true]);
  });
});
