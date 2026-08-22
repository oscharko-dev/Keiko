// The process guards convert a stray async crash into ONE clean, body-free line plus a fail-fast
// exit(1) — never a raw stack, and (since ADR-0173 D3/D11 wired this file into keiko-server's
// content-free classifier) never a raw `.message` either. Handlers are void-returning listeners
// (Node never awaits a listener's return value) that float their async work with `void`, so every
// test here calls the captured listener and then waits for the observable side effect (`err`/
// `exit` being called) rather than awaiting a return value — the same way Node itself never waits.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fatalProcessLine,
  installProcessGuards,
  type FatalDiagnosticsModule,
  type ProcessGuardSink,
} from "./process-guards.js";

type FatalListener = (reason: unknown) => void;

// Installs the guards against a fresh `vi.spyOn(process, "on")` and hands back the two captured
// listeners plus a cleanup callback. Kept as one function so the spy's precise mock type never
// crosses an abstractly-typed parameter boundary (doing so previously widened it to `any`).
function installAndCapture(sink: ProcessGuardSink): {
  readonly uncaught: FatalListener | undefined;
  readonly rejection: FatalListener | undefined;
  readonly cleanup: () => void;
} {
  const onSpy = vi.spyOn(process, "on");
  installProcessGuards(sink);
  const uncaught = onSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1] as
    FatalListener | undefined;
  const rejection = onSpy.mock.calls.find(([event]) => event === "unhandledRejection")?.[1] as
    FatalListener | undefined;
  const cleanup = (): void => {
    if (uncaught !== undefined) process.removeListener("uncaughtException", uncaught as never);
    if (rejection !== undefined) process.removeListener("unhandledRejection", rejection as never);
    onSpy.mockRestore();
  };
  return { uncaught, rejection, cleanup };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("fatalProcessLine", () => {
  it("formats an already-classified, content-free kind — never a message", () => {
    const line = fatalProcessLine("uncaught exception", "TypeError");
    expect(line).toBe("keiko: fatal uncaught exception (TypeError). The process will exit.\n");
    expect(line).not.toContain("    at ");
  });

  it("passes through whatever content-free kind it is given, verbatim", () => {
    expect(fatalProcessLine("unhandled rejection", "string")).toBe(
      "keiko: fatal unhandled rejection (string). The process will exit.\n",
    );
  });
});

describe("installProcessGuards — registration", () => {
  it("registers both catch-alls against process", () => {
    const { uncaught, rejection, cleanup } = installAndCapture({ err: vi.fn(), exit: vi.fn() });
    try {
      expect(uncaught).toBeDefined();
      expect(rejection).toBeDefined();
    } finally {
      cleanup();
    }
  });
});

describe("installProcessGuards — real classifier (no injected loadServer)", () => {
  // This is the regression this work item exists for: before the fix, the stderr line was built
  // from `${reason.name}: ${reason.message}` — a raw, unredacted string. Using the REAL keiko-server
  // dynamic import (not a fake) proves the actual production classifier, not a mock built to agree
  // with the assertion, is what keeps the message off stderr.
  it("never lets a message reach stderr", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", ""); // no activity-log file write in this test
    const err = vi.fn();
    const exit = vi.fn();
    const { uncaught, cleanup } = installAndCapture({ err, exit });
    try {
      expect(uncaught).toBeDefined();
      uncaught?.(new Error("secret-token-123"));
      // The real keiko-server dynamic import is a cold ESM load of a large module graph in this
      // test environment (no prebuilt dist to short-circuit it) — well within FATAL_IMPORT_TIMEOUT_MS
      // for a real crashing process, but slower than vi.waitFor's default 1s poll window here.
      await vi.waitFor(
        () => {
          expect(err).toHaveBeenCalledTimes(1);
        },
        { timeout: 15_000 },
      );
      const [line] = err.mock.calls[0] as [string];
      expect(line).not.toContain("secret-token-123");
      expect(line).toBe("keiko: fatal uncaught exception (Error). The process will exit.\n");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      cleanup();
    }
  });

  it("never lets a rejection reason reach stderr, even a plain string", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    const err = vi.fn();
    const exit = vi.fn();
    const { rejection, cleanup } = installAndCapture({ err, exit });
    try {
      rejection?.("leaked-plain-reason");
      await vi.waitFor(
        () => {
          expect(err).toHaveBeenCalledTimes(1);
        },
        { timeout: 15_000 },
      );
      const [line] = err.mock.calls[0] as [string];
      expect(line).not.toContain("leaked-plain-reason");
      expect(line).toBe("keiko: fatal unhandled rejection (string). The process will exit.\n");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      cleanup();
    }
  });
});

// A fake module satisfying `FatalDiagnosticsModule`, recording every activity-log write it is
// asked to perform so tests can assert on the exact event shape without touching a real file.
function fakeServerModule(described: {
  readonly errorClass: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}): {
  readonly module: FatalDiagnosticsModule;
  readonly writes: unknown[];
  readonly createFileServerLogSink: ReturnType<typeof vi.fn>;
} {
  const writes: unknown[] = [];
  const createFileServerLogSink = vi.fn(() => ({
    write: (event: unknown): void => {
      writes.push(event);
    },
    close: vi.fn(),
  }));
  const module: FatalDiagnosticsModule = {
    createFileServerLogSink,
    describeError: () => described,
  };
  return { module, writes, createFileServerLogSink };
}

describe("installProcessGuards — injected loadServer, KEIKO_STATE_DIR set", () => {
  it("writes one process.fatal activity-log line before stderr, code-first errorKind", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "/fake/state/dir");
    const { module, writes, createFileServerLogSink } = fakeServerModule({
      errorClass: "GatewayError",
      code: "ECONNRESET",
      frames: ["packages/keiko-cli/dist/run.js:12:4"],
      causeChain: ["TypeError"],
    });
    const order: string[] = [];
    const err = vi.fn((): void => {
      order.push("err");
    });
    const exit = vi.fn((): void => {
      order.push("exit");
    });
    const sink: ProcessGuardSink = { err, exit, loadServer: () => Promise.resolve(module) };
    const { rejection, cleanup } = installAndCapture(sink);
    try {
      rejection?.(new Error("boom"));
      await vi.waitFor(() => {
        expect(err).toHaveBeenCalledTimes(1);
      });

      expect(createFileServerLogSink).toHaveBeenCalledWith("/fake/state/dir");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual({
        level: "error",
        category: "process",
        op: "process.fatal",
        errorKind: "ECONNRESET",
        extra: {
          kind: "unhandled-rejection",
          frames: ["packages/keiko-cli/dist/run.js:12:4"],
          causeChain: ["TypeError"],
        },
      });
      // The activity-log write must land before stderr, which must land before exit.
      expect(order).toEqual(["err", "exit"]);
      expect(err).toHaveBeenCalledWith(
        "keiko: fatal unhandled rejection (GatewayError). The process will exit.\n",
      );
    } finally {
      cleanup();
    }
  });

  it("falls back to the error class in errorKind when no code is present", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "/fake/state/dir");
    const { module, writes } = fakeServerModule({ errorClass: "TypeError" });
    const sink: ProcessGuardSink = {
      err: vi.fn(),
      exit: vi.fn(),
      loadServer: () => Promise.resolve(module),
    };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new TypeError("boom"));
      await vi.waitFor(() => {
        expect(writes).toHaveLength(1);
      });
      const [event] = writes as [{ errorKind: string; extra: Record<string, unknown> }];
      expect(event.errorKind).toBe("TypeError");
      expect(event.extra).toEqual({ kind: "uncaught-exception" });
    } finally {
      cleanup();
    }
  });
});

describe("installProcessGuards — injected loadServer, KEIKO_STATE_DIR unset", () => {
  it("stays stderr-only: never constructs a file sink", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    const { module, createFileServerLogSink } = fakeServerModule({ errorClass: "RangeError" });
    const err = vi.fn();
    const sink: ProcessGuardSink = {
      err,
      exit: vi.fn(),
      loadServer: () => Promise.resolve(module),
    };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new RangeError("boom"));
      await vi.waitFor(() => {
        expect(err).toHaveBeenCalledTimes(1);
      });
      expect(createFileServerLogSink).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith(
        "keiko: fatal uncaught exception (RangeError). The process will exit.\n",
      );
    } finally {
      cleanup();
    }
  });
});

describe("installProcessGuards — a hung classifier import never keeps the process alive", () => {
  it("bounds the import at the timeout, still exits once with a safe fallback line", async () => {
    vi.useFakeTimers();
    const err = vi.fn();
    const exit = vi.fn();
    const hangingLoadServer = vi.fn(
      (): Promise<FatalDiagnosticsModule> =>
        new Promise<FatalDiagnosticsModule>(() => {
          // Never settles: exercises the bounded-timeout fallback path below.
        }),
    );
    const sink: ProcessGuardSink = { err, exit, loadServer: hangingLoadServer };
    const { rejection, cleanup } = installAndCapture(sink);
    try {
      rejection?.({ leaked: "secret-token-123" });
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(err).toHaveBeenCalledTimes(1);
      });

      expect(hangingLoadServer).toHaveBeenCalledTimes(1);
      const [line] = err.mock.calls[0] as [string];
      expect(line).not.toContain("secret-token-123");
      expect(line).toBe("keiko: fatal unhandled rejection (object). The process will exit.\n");
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      cleanup();
    }
  });

  it("never calls err/exit twice when the hung import resolves after the timeout already fired", async () => {
    vi.useFakeTimers();
    const err = vi.fn();
    const exit = vi.fn();
    let releaseImport: (() => void) | undefined;
    let describeErrorCalled = false;
    const lateLoadServer = vi.fn(
      (): Promise<FatalDiagnosticsModule> =>
        new Promise<FatalDiagnosticsModule>((resolve) => {
          releaseImport = (): void => {
            resolve({
              createFileServerLogSink: vi.fn(() => ({
                write: (): void => {
                  // No-op: this test only cares that `describeError` ran late, not what it logged.
                },
              })),
              describeError: () => {
                describeErrorCalled = true;
                return { errorClass: "TooLate" };
              },
            });
          };
        }),
    );
    const sink: ProcessGuardSink = { err, exit, loadServer: lateLoadServer };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new Error("late"));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(err).toHaveBeenCalledTimes(1);
      });
      expect(exit).toHaveBeenCalledTimes(1);

      // Release the hung import AFTER the timeout has already finished the handler, and let its
      // `.then/.catch/.finally` chain actually run to completion (a real microtask flush — fake
      // timers only mock macrotasks, so this needs no timer advance) before asserting nothing
      // fired a second time.
      releaseImport?.();
      await vi.waitFor(() => {
        expect(describeErrorCalled).toBe(true);
      });

      expect(err).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});

// `vi.useFakeTimers()` (used throughout the suite above) mocks the timeout callback
// deterministically on `advanceTimersByTimeAsync`, regardless of whether the real timer would be
// ref'd or unref'd — it cannot see event-loop-liveness bugs at all. The only way to prove the
// fatal-crash timeout actually keeps a REAL process alive is to run one: this spawns an isolated
// Node subprocess with nothing else pending (no other timer, no open socket) — exactly the shape
// of a genuine crash whose classifier import hangs forever — and checks the subprocess's actual
// exit code and stderr. An unref'd timeout would let Node's empty-event-loop exit fire first: the
// subprocess would exit 0 near-instantly with no stderr line at all, silently swallowing the
// crash this file exists to report.
const PROCESS_GUARDS_SOURCE_URL = new URL("./process-guards.ts", import.meta.url);

function hungImportCrashScript(): string {
  const modulePath = JSON.stringify(PROCESS_GUARDS_SOURCE_URL.pathname);
  return [
    `import { installProcessGuards } from ${modulePath};`,
    "const sink = {",
    '  err: (text) => { process.stderr.write("ERR:" + text); },',
    '  exit: (code) => { process.stderr.write("EXIT:" + code + "\\n"); process.exit(code); },',
    "  loadServer: () => new Promise(() => {}),",
    "};",
    "installProcessGuards(sink);",
    'Promise.reject(new Error("boom"));',
  ].join("\n");
}

interface HungImportCrashResult {
  readonly stderr: string;
  readonly exitCode: number | null;
}

function runHungImportCrashSubprocess(): Promise<HungImportCrashResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", hungImportCrashScript()], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (exitCode): void => {
      resolve({ stderr, exitCode });
    });
  });
}

describe("installProcessGuards — a hung classifier import against the real event loop", () => {
  it("still exits 1 with the fallback line instead of the empty-loop exit 0", async () => {
    const { stderr, exitCode } = await runHungImportCrashSubprocess();
    expect(stderr).toContain("keiko: fatal unhandled rejection (Error). The process will exit.");
    expect(exitCode).toBe(1);
  }, 10_000);
});
