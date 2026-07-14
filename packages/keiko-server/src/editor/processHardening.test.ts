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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  EditorProcessHardeningError,
  buildCopyOnlyProcessEnv,
  createIsolatedProcessDirectory,
  escalateKill,
  executableExtensions,
  resolveExecutableCandidateOutsideWorkspace,
  resolveExecutableOutsideWorkspace,
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
