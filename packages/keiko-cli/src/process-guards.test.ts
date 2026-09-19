// The process guards convert a stray async crash into ONE clean, body-free line plus a fail-fast
// exit(1) — never a raw stack, and (since ADR-0173 D3/D11 wired this file into keiko-server's
// content-free classifier) never a raw `.message` either. Handlers are void-returning listeners
// (Node never awaits a listener's return value) that float their async work with `void`, so every
// test here calls the captured listener and then waits for the observable side effect (`err`/
// `exit` being called) rather than awaiting a return value — the same way Node itself never waits.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  _resetInstalledProcessGuardsForTests,
  fatalProcessLine,
  installProcessGuards,
  type FatalDiagnosticsModule,
  type ProcessGuardSink,
} from "./process-guards.js";

type FatalListener = (reason: unknown) => void;

// Installs the guards against a fresh `vi.spyOn(process, "on")` and hands back the two captured
// listeners plus a cleanup callback. Kept as one function so the spy's precise mock type never
// crosses an abstractly-typed parameter boundary (doing so previously widened it to `any`).
// `Partial` mirrors `installProcessGuards`'s own signature (#3557) so a test can exercise a
// partial sink — e.g. the dev BFF's real `{ env }`-only call shape — without reconstructing err/exit.
function installAndCapture(sink: Partial<ProcessGuardSink>): {
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
  // KEIKO-0837: reset the module-level idempotency latch so every test starts from a
  // clean slate; production code never calls this helper.
  _resetInstalledProcessGuardsForTests();
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
  // The handler races the classifier import against its 2s crash bound. A cold transform of the
  // server graph inside this test worker can exceed that bound, which would test the fallback path
  // instead of the real one; warming the module cache keeps these tests on the real classifier.
  beforeAll(async () => {
    await import("@oscharko-dev/keiko-server");
  }, 60_000);

  // This is the regression this work item exists for: before the fix, the stderr line was built
  // from `${reason.name}: ${reason.message}` — a raw, unredacted string. Using the REAL keiko-server
  // dynamic import (not a fake) proves the actual production classifier, not a mock built to agree
  // with the assertion, is what keeps the message off stderr.
  // #3532: the fatal lifecycle is ALWAYS persisted — `process.fatal` with safe frames only, then
  // the process end `process.exiting` with reason `fatal-exception` — through the real production
  // sink, and no line of it carries the thrown message.
  it("never lets a message reach stderr or the persisted fatal lifecycle", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-fatal-lifecycle-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
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
      const raw = readPersistedActivityLog(stateDir);
      expect(raw).not.toContain("secret-token-123");
      const [fatal] = persistedActivityLogLines(raw, "process.fatal");
      expect(expectActivityLogProof("process.fatal.body-free", fatal ?? "")).toMatchObject({
        kind: "uncaught-exception",
        failureKind: "Error",
      });
      const [exiting] = persistedActivityLogLines(raw, "process.exiting");
      expect(expectActivityLogProof("process.exiting.reason", exiting ?? "")).toMatchObject({
        level: "error",
        errorKind: "internal",
        reason: "fatal-exception",
      });
      const [summary] = persistedActivityLogLines(raw, "activity-log.loss");
      expect(summary).toBeDefined();
    } finally {
      cleanup();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never lets a rejection reason reach stderr, even a plain string", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-fatal-rejection-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
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
      expect(readPersistedActivityLog(stateDir)).not.toContain("leaked-plain-reason");
    } finally {
      cleanup();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // #3557 review finding 1: the dev BFF calls `installProcessGuards()` before it ever mutates
  // `process.env`, and computes its own effective state directory (default `.keiko/dev`,
  // distinct from the generic CLI default) separately. Before the fix, the fatal path always read
  // bare `process.env` — so on an ordinary launch with no externally set `KEIKO_STATE_DIR`, a crash
  // would land in the WRONG directory even though every other evidence path in that process wrote
  // to the right one. `sink.env` must be consulted instead of `process.env` when the caller
  // supplies it — proven here against the REAL classifier and the REAL persisted file, not a fake.
  it("resolves the fatal-crash state directory from sink.env, never process.env, when both disagree", async () => {
    const wrongStateDir = mkdtempSync(join(tmpdir(), "keiko-fatal-wrong-"));
    const effectiveStateDir = mkdtempSync(join(tmpdir(), "keiko-fatal-effective-"));
    // `process.env.KEIKO_STATE_DIR` names a directory the fatal guard must NEVER write to once
    // `sink.env` is supplied — simulating the dev BFF's own effective/`process.env` divergence.
    vi.stubEnv("KEIKO_STATE_DIR", wrongStateDir);
    const err = vi.fn();
    const exit = vi.fn();
    const sink: ProcessGuardSink = { err, exit, env: { KEIKO_STATE_DIR: effectiveStateDir } };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new Error("secret-token-789"));
      await vi.waitFor(
        () => {
          expect(err).toHaveBeenCalledTimes(1);
        },
        { timeout: 15_000 },
      );
      expect(exit).toHaveBeenCalledWith(1);
      const raw = readPersistedActivityLog(effectiveStateDir);
      expect(raw).not.toContain("secret-token-789");
      const [fatal] = persistedActivityLogLines(raw, "process.fatal");
      expect(expectActivityLogProof("process.fatal.body-free", fatal ?? "")).toMatchObject({
        kind: "uncaught-exception",
        failureKind: "Error",
      });
      // The process.env-derived directory must never receive the fatal lifecycle itself. (It may
      // still receive an UNRELATED `activity-log.loss` exit summary: `persistActivityLogLossSummary`
      // has no `env`/`stateDir` parameter of its own — it always resolves the process-wide singleton
      // logger via bare `process.env`, a separate, pre-existing property this fix does not change.)
      if (existsSync(join(wrongStateDir, "logs"))) {
        const wrongRaw = readPersistedActivityLog(wrongStateDir);
        expect(persistedActivityLogLines(wrongRaw, "process.fatal")).toEqual([]);
      }
    } finally {
      cleanup();
      rmSync(wrongStateDir, { recursive: true, force: true });
      rmSync(effectiveStateDir, { recursive: true, force: true });
    }
  });
});

// A fake module satisfying `FatalDiagnosticsModule`, recording every activity-log write it is
// asked to perform so tests can assert on the exact event shape without touching a real file.
const DEFAULT_RUNTIME_STATE_DIR = "/fake/cwd/.keiko";

function fakeServerModule(described: {
  readonly errorClass: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}): {
  readonly module: FatalDiagnosticsModule;
  readonly writes: unknown[];
  readonly createActivityLogSink: ReturnType<typeof vi.fn>;
  readonly persistActivityLogLossSummary: ReturnType<typeof vi.fn>;
} {
  const writes: unknown[] = [];
  const createActivityLogSink = vi.fn(() => ({
    write: (event: unknown): void => {
      writes.push(event);
    },
    close: vi.fn(),
  }));
  const persistActivityLogLossSummary = vi.fn(() => "persisted" as const);
  const module: FatalDiagnosticsModule = {
    createActivityLogSink,
    describeError: () => described,
    persistActivityLogLossSummary,
    resolveRuntimeStateDir: (env) => {
      const configured = env.KEIKO_STATE_DIR;
      return configured === undefined || configured === "" ? DEFAULT_RUNTIME_STATE_DIR : configured;
    },
  };
  return { module, writes, createActivityLogSink, persistActivityLogLossSummary };
}

describe("installProcessGuards — injected loadServer, KEIKO_STATE_DIR set", () => {
  it("writes the fatal lifecycle before stderr with a classified code-first failureKind", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "/fake/state/dir");
    const { module, writes, createActivityLogSink, persistActivityLogLossSummary } =
      fakeServerModule({
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

      expect(createActivityLogSink).toHaveBeenCalledWith("/fake/state/dir");
      expect(persistActivityLogLossSummary).toHaveBeenCalledWith("exit");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({
        level: "error",
        category: "process",
        op: "process.exiting",
        errorKind: "internal",
        extra: { reason: "fatal-exception" },
      });
      expect(writes[0]).toEqual({
        level: "error",
        category: "process",
        op: "process.fatal",
        errorKind: "unavailable",
        extra: {
          kind: "unhandled-rejection",
          failureKind: "ECONNRESET",
          frames: ["packages/keiko-cli/dist/run.js:12:4"],
          causeChain: ["TypeError"],
          completeness: "complete",
          loss: "none",
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

  it("falls back to the error class in failureKind when no code is present", async () => {
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
        expect(writes).toHaveLength(2);
      });
      const [event] = writes as [{ errorKind: string; extra: Record<string, unknown> }];
      expect(event.errorKind).toBe("internal");
      expect(event.extra).toEqual({
        kind: "uncaught-exception",
        failureKind: "TypeError",
        completeness: "complete",
        loss: "none",
      });
    } finally {
      cleanup();
    }
  });

  it("preserves a closed fatal failureKind in the envelope", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "/fake/state/dir");
    const { module, writes } = fakeServerModule({
      errorClass: "GatewayError",
      code: "timeout",
    });
    const sink: ProcessGuardSink = {
      err: vi.fn(),
      exit: vi.fn(),
      loadServer: () => Promise.resolve(module),
    };
    const { rejection, cleanup } = installAndCapture(sink);
    try {
      rejection?.(new Error("boom"));
      await vi.waitFor(() => {
        expect(writes).toHaveLength(2);
      });
      const [event] = writes as [{ errorKind: string; extra: Record<string, unknown> }];
      expect(event.errorKind).toBe("timeout");
      expect(event.extra.failureKind).toBe("timeout");
    } finally {
      cleanup();
    }
  });
});

// #3557 review finding 1, unit-tested against the wiring itself (see the real-classifier describe
// block above for the end-to-end, real-file proof): `sink.env` — a NEW optional field — must be
// what `resolveRuntimeStateDir` receives, never a hardcoded `process.env` read, and a caller that
// supplies no override must still see today's `process.env`-derived behaviour unchanged.
describe("installProcessGuards — sink.env resolves the fatal state directory (#3557)", () => {
  it("passes sink.env to resolveRuntimeStateDir when the sink supplies one", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "/process-env/state/dir");
    const { module, createActivityLogSink } = fakeServerModule({ errorClass: "Error" });
    const sink: ProcessGuardSink = {
      err: vi.fn(),
      exit: vi.fn(),
      loadServer: () => Promise.resolve(module),
      env: { KEIKO_STATE_DIR: "/effective/state/dir" },
    };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new Error("boom"));
      await vi.waitFor(() => {
        expect(createActivityLogSink).toHaveBeenCalled();
      });
      expect(createActivityLogSink).toHaveBeenCalledWith("/effective/state/dir");
    } finally {
      cleanup();
    }
  });

  it("still falls back to process.env when the sink supplies no env override", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "/process-env/state/dir");
    const { module, createActivityLogSink } = fakeServerModule({ errorClass: "Error" });
    const sink: ProcessGuardSink = {
      err: vi.fn(),
      exit: vi.fn(),
      loadServer: () => Promise.resolve(module),
    };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new Error("boom"));
      await vi.waitFor(() => {
        expect(createActivityLogSink).toHaveBeenCalled();
      });
      expect(createActivityLogSink).toHaveBeenCalledWith("/process-env/state/dir");
    } finally {
      cleanup();
    }
  });

  // The dev BFF's real call site is exactly `installProcessGuards({ env })` — no err/exit. This
  // must register cleanly and keep using `DEFAULT_PROCESS_GUARD_SINK`'s err/exit, never leave them
  // `undefined` (which a naive `{ ...DEFAULT, ...sink }` ordering mistake — or the reverse spread
  // order — would silently do).
  it("registers successfully when the sink supplies only env, the dev BFF's exact call shape", () => {
    const { uncaught, rejection, cleanup } = installAndCapture({
      env: { KEIKO_STATE_DIR: "/effective/state/dir" },
    });
    try {
      expect(uncaught).toBeDefined();
      expect(rejection).toBeDefined();
    } finally {
      cleanup();
    }
  });
});

describe("installProcessGuards — injected loadServer, KEIKO_STATE_DIR unset", () => {
  // #3532: a crash in a process started without KEIKO_STATE_DIR (keiko run, keiko memory, ...) used
  // to stay stderr-only. It now lands in the runtime state directory the CLI itself defaults to.
  it("writes the fatal lifecycle to the default runtime state directory", async () => {
    vi.stubEnv("KEIKO_STATE_DIR", "");
    const { module, writes, createActivityLogSink } = fakeServerModule({
      errorClass: "RangeError",
    });
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
      expect(createActivityLogSink).toHaveBeenCalledWith(DEFAULT_RUNTIME_STATE_DIR);
      expect(writes.map((event) => (event as { op: string }).op)).toEqual([
        "process.fatal",
        "process.exiting",
      ]);
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
              createActivityLogSink: vi.fn(() => ({
                write: (): void => {
                  // No-op: this test only cares that `describeError` ran late, not what it logged.
                },
              })),
              describeError: () => {
                describeErrorCalled = true;
                return { errorClass: "TooLate" };
              },
              persistActivityLogLossSummary: vi.fn(() => "persisted" as const),
              resolveRuntimeStateDir: () => DEFAULT_RUNTIME_STATE_DIR,
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
const PROCESS_GUARDS_SOURCE_URL = new URL("../dist/process-guards.js", import.meta.url);

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

describe("boundedSinkWrite — a never-settling sink must not block sink.exit (comment 3865273680)", () => {
  it("still calls exit(1) after the bounded timeout when sink.err never resolves", async () => {
    vi.useFakeTimers();
    const err = vi.fn(
      (): Promise<void> =>
        new Promise<void>(() => {
          // Never settles: models a sink stuck behind a dead transport.
        }),
    );
    const exit = vi.fn();
    const sink: ProcessGuardSink = {
      err,
      exit,
      loadServer: (): Promise<FatalDiagnosticsModule> =>
        Promise.resolve({
          createActivityLogSink: vi.fn(() => ({ write: (): void => undefined })),
          describeError: (): { readonly errorClass: string } => ({ errorClass: "Error" }),
          persistActivityLogLossSummary: vi.fn(() => "persisted" as const),
          resolveRuntimeStateDir: (): string => DEFAULT_RUNTIME_STATE_DIR,
        } as unknown as FatalDiagnosticsModule),
    };
    const { uncaught, cleanup } = installAndCapture(sink);
    try {
      uncaught?.(new Error("boom"));
      // Let the (fast, in-memory) classifier import settle first so `finish()` reaches the
      // sink write — advancing by the classifier's own 2s bound would race two independent
      // timers, so drive microtasks to completion before advancing the sink-write timeout.
      await vi.advanceTimersByTimeAsync(0);
      expect(err).toHaveBeenCalledTimes(1);
      // Without a bound, this would await sink.err forever and exit would never be called —
      // that is exactly what this test must fail against (pre-fix: hangs, never resolves).
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      cleanup();
    }
  });
});

describe("writeStderrDrained — the default sink actually drains (comment 3865273680)", () => {
  // Uses a REAL child process with a PIPED stderr (not the injected fake `err` the rest of this
  // suite uses) so this pins the production DEFAULT_PROCESS_GUARD_SINK's actual
  // `process.stderr.write` behaviour, not a mock built to agree with the assertion. A payload
  // larger than one pipe buffer (empirically 64KB on this platform) forces the documented
  // async-pipe-write behaviour: a fire-and-forget `process.stderr.write` followed immediately by
  // `process.exit()` reliably truncates to one buffer's worth, while draining through the write's
  // own callback (as `writeStderrDrained` does) reliably delivers every byte.
  it("delivers a full multi-megabyte write to a piped child before resolving", async () => {
    const modulePath = JSON.stringify(PROCESS_GUARDS_SOURCE_URL.pathname);
    const script = [
      `import { writeStderrDrained } from ${modulePath};`,
      "const big = Buffer.alloc(5 * 1024 * 1024, 88);", // 5 MiB of 'X'
      "writeStderrDrained(big.toString()).then(() => { process.exit(1); });",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let received = 0;
    child.stderr.on("data", (chunk: Buffer): void => {
      received += chunk.length;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect(exitCode).toBe(1);
    expect(received).toBe(5 * 1024 * 1024);
  }, 10_000);
});

describe("installProcessGuards — idempotency (KEIKO-0837)", () => {
  it("registers exactly one listener even when called twice", () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    installProcessGuards({ err: vi.fn(), exit: vi.fn() });
    installProcessGuards({ err: vi.fn(), exit: vi.fn() });
    const after = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    // Only ONE additional listener per event, not two.
    expect(after.uncaught - before.uncaught).toBe(1);
    expect(after.rejection - before.rejection).toBe(1);
  });
});

describe("installProcessGuards — flushes the fatal line before exiting (KEIKO-0837)", () => {
  it("awaits an async sink.err before calling sink.exit", async () => {
    let errResolved = false;
    let exitSeenErrResolved: boolean | undefined;
    const err = vi.fn(async (_text: string): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      errResolved = true;
    });
    const exit = vi.fn((_code: number): void => {
      exitSeenErrResolved = errResolved;
    });
    const loadServer = vi.fn((): Promise<FatalDiagnosticsModule> =>
      Promise.resolve({
        createActivityLogSink: (): { write: () => void; close: () => void } => ({
          write: (): void => undefined,
          close: (): void => undefined,
        }),
        persistActivityLogLossSummary: (): "persisted" => "persisted",
        resolveRuntimeStateDir: (): string => DEFAULT_RUNTIME_STATE_DIR,
        describeError: (): {
          readonly errorClass: string;
          readonly code?: string;
          readonly frames?: readonly string[];
          readonly causeChain?: readonly string[];
        } => ({ errorClass: "TypeError" }),
      } as unknown as FatalDiagnosticsModule),
    );

    const { uncaught, cleanup } = installAndCapture({ err, exit, loadServer });
    try {
      // Await a microtask cycle plus the sink.err's 10ms sleep before asserting.
      uncaught?.(new Error("boom"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(err).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
      expect(exitSeenErrResolved).toBe(true);
    } finally {
      cleanup();
    }
  });
});
