import { afterEach, describe, expect, it, vi } from "vitest";

const fsOverrides = vi.hoisted(() => ({
  inaccessiblePath: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: (...args: Parameters<typeof actual.accessSync>): void => {
      if (String(args[0]) === fsOverrides.inaccessiblePath) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      actual.accessSync(...args);
    },
  };
});

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  EditorProcessHardeningError,
  buildCopyOnlyProcessEnv,
  createIsolatedProcessDirectory,
  escalateKill,
  executableExtensions,
  resolveExecutableCandidateOutsideWorkspace,
  resolveExecutableOutsideWorkspace,
  resolveWindowsSpawnInvocation,
  splitProcessPath,
  type KillScheduler,
  type KillableChild,
} from "./processHardening.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

function workspace(root: string): WorkspaceInfo {
  return { root } as WorkspaceInfo;
}

function executable(directory: string, name: string): string {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("editor process executable resolution", () => {
  it("surfaces an exact content-free hardening error", () => {
    expect(new EditorProcessHardeningError()).toMatchObject({
      name: "EditorProcessHardeningError",
      message: "EXECUTABLE_NOT_FOUND",
      code: "EXECUTABLE_NOT_FOUND",
    });
  });

  it("returns lexical and real paths for the first executable external candidate", () => {
    const missing = temporary("keiko-shared-missing-");
    const bin = temporary("keiko-shared-bin-");
    const root = temporary("keiko-shared-workspace-");
    const expected = executable(bin, "adapter");
    const candidate = resolveExecutableCandidateOutsideWorkspace(
      "adapter",
      workspace(root),
      { PATH: [missing, bin].join(delimiter) },
      "linux",
    );
    expect(candidate).toStrictEqual({ path: expected, real: realpathSync(expected) });
    expect(
      resolveExecutableOutsideWorkspace("adapter", workspace(root), { PATH: bin }, "linux"),
    ).toBe(realpathSync(expected));
  });

  it("splits the search path and removes only empty entries", () => {
    expect(splitProcessPath(undefined, ":")).toStrictEqual([]);
    expect(splitProcessPath("", ":")).toStrictEqual([]);
    expect(splitProcessPath(":/one::/two:", ":")).toStrictEqual(["/one", "/two"]);
  });

  it("selects exact platform executable extensions", () => {
    expect(executableExtensions(undefined, "linux")).toStrictEqual([""]);
    expect(executableExtensions(undefined, "win32")).toStrictEqual([
      ".EXE",
      ".CMD",
      ".BAT",
      ".COM",
    ]);
    expect(executableExtensions(";.CMD;;.EXE;", "win32")).toStrictEqual([".CMD", ".EXE"]);
  });

  it.each(["", "with/slash", "with\\backslash", "with space"])(
    "rejects hostile executable name %s before probing",
    (name) => {
      expect(() =>
        resolveExecutableOutsideWorkspace(name, workspace(temporary("keiko-shared-ws-")), {
          PATH: temporary("keiko-shared-bin-"),
        }),
      ).toThrow(EditorProcessHardeningError);
    },
  );

  it.each([undefined, "", delimiter])("rejects an absent executable on PATH %s", (PATH) => {
    expect(() =>
      resolveExecutableOutsideWorkspace("missing", workspace(temporary("keiko-shared-ws-")), {
        PATH,
      }),
    ).toThrow(EditorProcessHardeningError);
  });

  it("uses PATHEXT entries on Windows and ignores empty extension entries", () => {
    const bin = temporary("keiko-shared-win-");
    const root = temporary("keiko-shared-ws-");
    const expected = executable(bin, "adapter.CMD");
    expect(
      resolveExecutableOutsideWorkspace(
        "adapter",
        workspace(root),
        { PATH: bin, PATHEXT: ";.EXE;;.CMD;" },
        "win32",
      ),
    ).toBe(realpathSync(expected));
  });

  it("uses the closed default Windows extension vocabulary", () => {
    const bin = temporary("keiko-shared-win-default-");
    const root = temporary("keiko-shared-ws-");
    const expected = executable(bin, "adapter.EXE");
    expect(
      resolveExecutableOutsideWorkspace("adapter", workspace(root), { PATH: bin }, "win32"),
    ).toBe(realpathSync(expected));
  });

  it("skips an existing non-executable candidate", () => {
    const first = temporary("keiko-shared-nonexec-");
    const second = temporary("keiko-shared-exec-");
    const root = temporary("keiko-shared-ws-");
    writeFileSync(join(first, "adapter"), "plain", "utf8");
    const expected = executable(second, "adapter");
    expect(
      resolveExecutableOutsideWorkspace(
        "adapter",
        workspace(root),
        { PATH: [first, second].join(delimiter) },
        "linux",
      ),
    ).toBe(realpathSync(expected));
  });

  it("skips a candidate whose execute bit is set but is not executable by this uid", () => {
    const first = temporary("keiko-shared-noaccess-");
    const second = temporary("keiko-shared-exec-");
    const root = temporary("keiko-shared-ws-");
    // The mode bits report an execute bit for owner/group/other, but the OS-level
    // accessSync(X_OK) check is what actually governs this uid's ability to execute it
    // (ownership, ACLs, and noexec mounts all live outside the raw mode bitmask).
    const blocked = executable(first, "adapter");
    const expected = executable(second, "adapter");
    fsOverrides.inaccessiblePath = blocked;
    try {
      expect(
        resolveExecutableOutsideWorkspace(
          "adapter",
          workspace(root),
          { PATH: [first, second].join(delimiter) },
          "linux",
        ),
      ).toBe(realpathSync(expected));
    } finally {
      fsOverrides.inaccessiblePath = undefined;
    }
  });

  it("rejects lexical and symlink-resolved workspace candidates", () => {
    const root = temporary("keiko-shared-ws-");
    executable(root, "inside");
    expect(() =>
      resolveExecutableOutsideWorkspace("inside", workspace(root), { PATH: root }, "linux"),
    ).toThrow(EditorProcessHardeningError);

    const bin = temporary("keiko-shared-links-");
    symlinkSync(join(root, "inside"), join(bin, "linked"));
    expect(() =>
      resolveExecutableOutsideWorkspace("linked", workspace(root), { PATH: bin }, "linux"),
    ).toThrow(EditorProcessHardeningError);
  });

  it("falls back to the lexical workspace root when the root does not exist", () => {
    const bin = temporary("keiko-shared-bin-");
    const expected = executable(bin, "adapter");
    const missingRoot = join(temporary("keiko-shared-parent-"), "missing");
    expect(
      resolveExecutableOutsideWorkspace("adapter", workspace(missingRoot), { PATH: bin }, "linux"),
    ).toBe(realpathSync(expected));
  });
});

describe("editor process environment and directory isolation", () => {
  it("copies only explicitly allowlisted defined environment values", () => {
    expect(
      buildCopyOnlyProcessEnv(
        { PATH: "/reviewed", LANG: "en_US", EMPTY: undefined, SECRET: "hidden" },
        ["PATH", "LANG", "EMPTY"],
      ),
    ).toStrictEqual({ PATH: "/reviewed", LANG: "en_US" });
  });

  it("creates an isolated directory and cleans it idempotently", () => {
    const directory = createIsolatedProcessDirectory("keiko-shared-home-");
    expect(existsSync(directory.path)).toBe(true);
    directory.cleanup();
    directory.cleanup();
    expect(existsSync(directory.path)).toBe(false);
  });
});

interface KillTracker extends KillableChild {
  readonly signals: NodeJS.Signals[];
}

function tracker(throwSignals: readonly NodeJS.Signals[] = []): KillTracker {
  const signals: NodeJS.Signals[] = [];
  return {
    pid: 42,
    signals,
    kill: (signal): void => {
      signals.push(signal);
      if (throwSignals.includes(signal)) throw new Error("private");
    },
  };
}

const immediate: KillScheduler = {
  setTimer: (callback, _delayMs): unknown => {
    callback();
    return 1;
  },
};

describe("editor process TERM-to-KILL escalation", () => {
  it("schedules and unrefs the production kill deadline when freshly loaded", async () => {
    const probe = setTimeout((): void => undefined, 1);
    const timeoutPrototype = Object.getPrototypeOf(probe) as { unref(): unknown };
    clearTimeout(probe);
    const unref = vi.spyOn(timeoutPrototype, "unref");
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const callback = vi.fn();
    vi.resetModules();
    const { productionKillScheduler } = await import("./processHardening.js");

    const handle = productionKillScheduler.setTimer(callback, 321) as NodeJS.Timeout;

    expect(Object.isFrozen(productionKillScheduler)).toBe(true);
    expect(scheduled).toHaveBeenCalledWith(callback, 321);
    expect(unref).toHaveBeenCalledTimes(1);
    clearTimeout(handle);
    scheduled.mockRestore();
    unref.mockRestore();
  });

  it("unrefs the production deadline and invokes its callback at the requested grace period", async () => {
    const timer = setTimeout((): void => undefined, 1);
    const timeoutPrototype = Object.getPrototypeOf(timer) as { unref(): unknown };
    clearTimeout(timer);
    const unref = vi.spyOn(timeoutPrototype, "unref");
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const child = tracker();

    await escalateKill(child, 0, () => false);

    expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 0);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(child.signals).toStrictEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stops after TERM when the process has already exited", async () => {
    const child = tracker();
    const scheduler = vi.fn();
    await escalateKill(child, 5_000, () => true, { setTimer: scheduler });
    expect(child.signals).toStrictEqual(["SIGTERM"]);
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("sends KILL at the exact scheduler deadline while the process remains alive", async () => {
    const child = tracker();
    const scheduler = vi.fn((callback: () => void, delayMs: number): unknown => {
      expect(delayMs).toBe(123);
      callback();
      return 1;
    });
    await escalateKill(child, 123, () => false, { setTimer: scheduler });
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(child.signals).toStrictEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not send KILL when exit is observed at the deadline", async () => {
    const child = tracker();
    let exited = false;
    const scheduler: KillScheduler = {
      setTimer: (callback): unknown => {
        exited = true;
        callback();
        return 1;
      },
    };
    await escalateKill(child, 1, () => exited, scheduler);
    expect(child.signals).toStrictEqual(["SIGTERM"]);
  });

  it("settles once on an early exit even when the deadline callback fires later", async () => {
    const child = tracker();
    let timer: (() => void) | undefined;
    let exit: (() => void) | undefined;
    const pending = escalateKill(
      child,
      10,
      () => false,
      {
        setTimer: (callback): unknown => {
          timer = callback;
          return 1;
        },
      },
      (callback) => {
        exit = callback;
      },
    );
    exit?.();
    timer?.();
    await pending;
    expect(child.signals).toStrictEqual(["SIGTERM"]);
  });

  it.each([
    { signals: ["SIGTERM"] as const },
    { signals: ["SIGKILL"] as const },
    { signals: ["SIGTERM", "SIGKILL"] as const },
  ])("swallows already-exited signal failures $signals", async ({ signals }) => {
    const child = tracker(signals);
    await expect(escalateKill(child, 1, () => false, immediate)).resolves.toBeUndefined();
    expect(child.signals).toStrictEqual(["SIGTERM", "SIGKILL"]);
  });
});

// resolveWindowsSpawnInvocation (issue #3350 / Node CVE-2024-27980) delegates to keiko-tools'
// buildWindowsShellInvocation, which is exhaustively golden-vector tested in
// packages/keiko-tools/src/windows-shell.test.ts. This pins the DELEGATION: the wrapper must not
// swallow, transform, or hardcode away the underlying decision. The pass-through cases mirror
// defaultLspSpawnFn's own un-overridden (process.platform) call site on this non-win32 host; the
// final case forces platform:win32 so the actual wrapping branch is exercised too — without it a
// raw pass-through return would pass every other assertion here.
describe("resolveWindowsSpawnInvocation", () => {
  it("passes a resolved .cmd executable through unchanged on a non-win32 host", () => {
    const executable = "/abs/tools/typescript-language-server.cmd";
    const result = resolveWindowsSpawnInvocation(executable, ["--stdio"]);
    expect(result).toStrictEqual({
      command: executable,
      args: ["--stdio"],
      windowsVerbatimArguments: false,
    });
  });

  it("passes a resolved .exe/native executable through unchanged", () => {
    const executable = "/abs/tools/gopls";
    const result = resolveWindowsSpawnInvocation(executable, []);
    expect(result).toStrictEqual({
      command: executable,
      args: [],
      windowsVerbatimArguments: false,
    });
  });

  it("routes a resolved .cmd through the hardened cmd.exe wrapper on win32", () => {
    // Forcing the platform proves the win32 branch is actually reached — a raw pass-through return
    // would fail this even though it passes the non-win32 cases above.
    const executable = String.raw`C:\tools\typescript-language-server.cmd`;
    const result = resolveWindowsSpawnInvocation(executable, ["&"], {
      platform: "win32",
      env: { SystemRoot: String.raw`C:\Windows` },
    });
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(result.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\tools\\typescript-language-server.cmd ^"^&^""',
    ]);
  });

  // The byte-exact golden vectors for the escaping algorithm itself live in windows-shell.test.ts
  // and are deliberately NOT restated here — a fixture that reproduces the production formula stops
  // being able to detect that formula moving. What this call site owns is the property that every
  // shape of argument still reaches cmd.exe as ONE pre-escaped operand with no bare metacharacter
  // left to be reinterpreted as syntax.
  it.each([
    ["an empty argument", ""],
    ["a lone quote", '"'],
    ["a trailing backslash", "trailing\\"],
    ["a command separator", "& echo pwned"],
    ["a pipe into another command", "| whoami"],
    ["a redirect", "> out.txt"],
    ["a caret", "^"],
    ["a long backslash run", "\\".repeat(64)],
  ])("keeps %s inert inside a single cmd.exe operand on win32", (_label, argument) => {
    const invocation = resolveWindowsSpawnInvocation(
      String.raw`C:\tools\typescript-language-server.cmd`,
      [argument],
      { platform: "win32", env: { SystemRoot: String.raw`C:\Windows` } },
    );

    expect(invocation.windowsVerbatimArguments).toBe(true);
    // Exactly one operand after /d /s /c: cmd.exe must never see the argument as its own token.
    expect(invocation.args).toHaveLength(4);
    const line = invocation.args[3] ?? "";
    // Every cmd metacharacter that survives into the line is caret-escaped. Counting carets rather
    // than matching an expected string keeps this independent of the escaping implementation.
    for (const metacharacter of ["&", "|", "<", ">"]) {
      let index = line.indexOf(metacharacter);
      while (index !== -1) {
        expect(line[index - 1]).toBe("^");
        index = line.indexOf(metacharacter, index + 1);
      }
    }
  });

  // CR/LF is the one shape that must NOT be escaped through: cmd.exe treats a bare newline as a
  // command boundary that caret-escaping cannot neutralise (the gap cross-spawn's metacharacter
  // class leaves open, upstream #179), so this call site fails CLOSED rather than wrapping it.
  it.each([
    ["a line feed", "first\nsecond"],
    ["a carriage return", "first\rsecond"],
    // cmd.exe expands %NAME% before caret processing — no literal transport exists, so the wrapper
    // fails closed instead of delivering a different argv (review 5058544058 P1).
    ["a percent expansion", "%PATH%"],
  ])("refuses to wrap %s on win32", (_label, argument) => {
    expect(() =>
      resolveWindowsSpawnInvocation(
        String.raw`C:\tools\typescript-language-server.cmd`,
        [argument],
        {
          platform: "win32",
          env: { SystemRoot: String.raw`C:\Windows` },
        },
      ),
    ).toThrow();
  });
});
