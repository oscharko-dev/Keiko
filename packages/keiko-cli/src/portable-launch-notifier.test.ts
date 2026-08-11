import { describe, expect, it } from "vitest";
import {
  notifyPortableLaunchFailure,
  runDetachedAlert,
  runDetachedWindowsAlert,
} from "./portable-launch-notifier.js";

const UI_LAUNCH = { KEIKO_PORTABLE_UI_LAUNCH: "1" };

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
  });
});
