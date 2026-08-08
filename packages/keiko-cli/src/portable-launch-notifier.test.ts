import { describe, expect, it } from "vitest";
import { notifyPortableLaunchFailure, runDetachedAlert } from "./portable-launch-notifier.js";

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

    expect(scripts[0]?.length ?? 0).toBeLessThan(600);
  });

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

  it("stays silent on a non-darwin platform", () => {
    let shown = false;

    notifyPortableLaunchFailure("reason", UI_LAUNCH, {
      platform: () => "linux",
      runAlert: () => {
        shown = true;
      },
    });

    expect(shown).toBe(false);
  });

  it("swallows an alert runner failure instead of replacing the diagnosis", () => {
    expect(() => {
      notifyPortableLaunchFailure("reason", UI_LAUNCH, {
        platform: () => "darwin",
        runAlert: () => {
          throw new Error("no WindowServer");
        },
      });
    }).not.toThrow();
  });

  it("reads the host platform when no platform seam is injected", () => {
    // Deterministic per host: the alert seam fires exactly when the real platform is darwin. The
    // runAlert seam keeps the test dialog-free either way.
    let shown = false;

    notifyPortableLaunchFailure("reason", UI_LAUNCH, {
      runAlert: () => {
        shown = true;
      },
    });

    expect(shown).toBe(process.platform === "darwin");
  });
});

describe("runDetachedAlert", () => {
  it("spawns the bounded detached osascript contract and detaches from it", () => {
    const calls: unknown[][] = [];
    let errorHandler: ((error: Error) => void) | undefined;
    let unreferenced = false;

    runDetachedAlert("display alert", (command, args, options) => {
      calls.push([command, args, options]);
      return {
        on: (_event, listener): void => {
          errorHandler = listener;
        },
        unref: (): void => {
          unreferenced = true;
        },
      };
    });

    expect(calls).toEqual([
      [
        "/usr/bin/osascript",
        ["-e", "display alert"],
        { detached: true, env: {}, shell: false, stdio: "ignore" },
      ],
    ]);
    expect(unreferenced).toBe(true);
    // The error listener must exist and must swallow: an unhandled 'error' event would crash the
    // CLI process the alert exists to explain.
    expect(errorHandler).toBeDefined();
    expect(() => {
      errorHandler?.(new Error("spawn ENOENT"));
    }).not.toThrow();
  });
});
