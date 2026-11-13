import { describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { createCliSecurityLogSink } from "./security-log.js";
import {
  notifyPortableLaunchFailure,
  notifyPortableSetupStarted,
  PORTABLE_SETUP_NOTICE,
  runDetachedAlert,
  runDetachedWindowsAlert,
  runDetachedWindowsBox,
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
  it("spawns the bounded detached PowerShell MessageBox contract and detaches from it", () => {
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
    expect(calls[0]?.[1]).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-Sta",
      "-WindowStyle",
      "Hidden",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -AssemblyName PresentationFramework; " +
        "[System.Windows.MessageBox]::Show('can''t startbecause', " +
        "'Keiko could not start', 'OK', 'Error') | Out-Null",
    ]);
    // PowerShell/WPF need the core system variables to initialize; everything else stays
    // withheld from the detached child (no TEMP/TMP here because the caller env carries none).
    expect(calls[0]?.[2]).toEqual({
      detached: true,
      env: { SystemRoot: String.raw`D:\Windows`, WINDIR: String.raw`D:\Windows` },
      shell: false,
      stdio: "ignore",
      windowsHide: true,
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
    expect((calls[0]?.[2] as { env: unknown }).env).toEqual({
      SystemRoot: String.raw`D:\Windows`,
      WINDIR: String.raw`D:\Windows`,
      TEMP: String.raw`D:\Scratch\Temp`,
      TMP: String.raw`D:\Scratch\Tmp`,
    });
  });
});

describe("notifyPortableSetupStarted", () => {
  const env = { KEIKO_PORTABLE_UI_LAUNCH: "1", SystemRoot: String.raw`D:\Windows` };

  it("shows the fixed setup notice for a Windows double-click and records that it was requested", () => {
    const shown: [string, unknown][] = [];
    const { sink, events } = recordingSecuritySink();

    notifyPortableSetupStarted(env, {
      platform: () => "win32",
      securityLogSink: sink,
      runWindowsAlert: (message, alertEnv) => {
        shown.push([message, alertEnv]);
      },
    });

    expect(shown).toEqual([[PORTABLE_SETUP_NOTICE, env]]);
    expect(PORTABLE_SETUP_NOTICE).toBe(
      "Keiko is being set up. The first start can take several minutes. Your browser opens when Keiko is ready.",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "portable.setup-notice.requested",
      level: "info",
      extra: { surface: "portable-setup-notice" },
    });
    expect(JSON.stringify(events[0])).not.toContain("being set up");
  });

  it.each([
    ["no double-click marker", {}, "win32"],
    ["macOS", env, "darwin"],
    ["Linux", env, "linux"],
  ] as const)("stays silent with %s", (_name, launchEnv, platform) => {
    let shown = false;
    const { sink, events } = recordingSecuritySink();

    notifyPortableSetupStarted(launchEnv, {
      platform: () => platform,
      securityLogSink: sink,
      runWindowsAlert: () => {
        shown = true;
      },
    });

    expect(shown).toBe(false);
    expect(events).toEqual([]);
  });

  it("never fails the launch when the notice cannot be shown, and does not claim it was requested", () => {
    const reported: string[] = [];
    const { sink, events } = recordingSecuritySink();

    expect(() => {
      notifyPortableSetupStarted(env, {
        platform: () => "win32",
        securityLogSink: sink,
        reportAlertFailure: (line) => {
          reported.push(line);
        },
        runWindowsAlert: () => {
          throw new Error("no PowerShell");
        },
      });
    }).not.toThrow();

    expect(reported).toEqual(["keiko portable launch: the setup notice could not be shown\n"]);
    expect(events).toEqual([]);
  });

  it("logs a body-free refusal under the notice's own surface when Windows cannot be resolved", () => {
    const reported: string[] = [];
    const { sink, events } = recordingSecuritySink();

    notifyPortableSetupStarted(
      { KEIKO_PORTABLE_UI_LAUNCH: "1", SystemRoot: String.raw`\\attacker\share` },
      {
        platform: () => "win32",
        securityLogSink: sink,
        reportAlertFailure: (line) => {
          reported.push(line);
        },
      },
    );

    expect(reported).toEqual(["keiko portable launch: the setup notice could not be shown\n"]);
    // the shared alert path keeps its security refusal line; the second line names the notice
    expect(events.map((event) => [event.op, event.extra?.surface])).toEqual([
      ["security.windows-portable-alert.system-root-refused", "portable-failure-alert"],
      ["portable.windows-alert.spawn-failed", "portable-setup-notice"],
    ]);
    expect(events[1]?.extra?.failureKind).toBe("WindowsSystemDirectoryError");
  });
});

describe("runDetachedWindowsBox as a setup notice", () => {
  it("shows an information box titled Keiko, never the could-not-start error box", () => {
    const commands: string[] = [];

    runDetachedWindowsBox(
      "setup-notice",
      PORTABLE_SETUP_NOTICE,
      { SystemRoot: String.raw`D:\Windows` },
      {
        spawnFn: (_command, args) => {
          commands.push(args.at(-1) ?? "");
          return { on: (): void => undefined, unref: (): void => undefined };
        },
        identityCheck: () => true,
        existsAsFile: () => true,
      },
    );

    expect(commands).toEqual([
      "Add-Type -AssemblyName PresentationFramework; " +
        `[System.Windows.MessageBox]::Show('${PORTABLE_SETUP_NOTICE}', 'Keiko', 'OK', 'Information') | Out-Null`,
    ]);
  });
});
