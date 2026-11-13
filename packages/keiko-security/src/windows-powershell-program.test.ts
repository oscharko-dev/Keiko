import { describe, expect, it } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "./log-port.js";
import {
  boundedPowerShellProgram,
  boundedPowerShellTimeoutMs,
  runBoundedPowerShellProgram,
  WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS,
  WINDOWS_PROGRAM_SLOW_MS,
  WINDOWS_PROGRAM_STARTED_MARKER,
  WindowsProgramHostStartError,
  WindowsProgramWorkTimeoutError,
  type BoundedPowerShellRun,
  type WindowsProgramRunner,
} from "./windows-powershell-program.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const STARTED = `${WINDOWS_PROGRAM_STARTED_MARKER}\n`;
const WATCHDOG_STATUS = 0xffffffff;

type RunnerResult = ReturnType<WindowsProgramRunner>;

function timedOut(): Error {
  return Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
}

function recording(): { readonly sink: SecurityLogSink; readonly events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return { sink: { write: (event): void => void events.push(event) }, events };
}

function run(
  result: Partial<RunnerResult>,
  overrides: Partial<BoundedPowerShellRun> = {},
): ReturnType<typeof runBoundedPowerShellProgram> {
  return runBoundedPowerShellProgram({
    program: "local-volume",
    executable: POWERSHELL,
    source: "exit 0",
    input: "",
    workTimeoutMs: 3_000,
    maxOutputBytes: 64,
    runner: () => ({ status: 0, stdout: "", stderr: "", ...result }),
    ...overrides,
  });
}

/** A clock on which the run lasts `elapsedMs`: read once before the runner and once after. */
function lasting(elapsedMs: number): () => number {
  let reads = 0;
  return (): number => {
    reads += 1;
    return reads === 1 ? 0 : elapsedMs;
  };
}

describe("boundedPowerShellProgram", () => {
  it("announces the first statement, then arms the watchdog, then runs the program", () => {
    const program = boundedPowerShellProgram("PROGRAM-BODY", 10_000);
    const lines = program.split("\n");
    expect(lines[0]).toBe(
      `[Console]::Out.Write('${WINDOWS_PROGRAM_STARTED_MARKER}' + [char]10); [Console]::Out.Flush()`,
    );
    expect(lines[1]).toBe("$keikoWatchdog = [Threading.CancellationTokenSource]::new(10000)");
    expect(lines[2]).toContain("[Diagnostics.Process]::GetCurrentProcess(), 'Kill'");
    expect(lines[3]).toBe("PROGRAM-BODY");
    // No scriptblock delegate: a timer thread has no runspace to run PowerShell code in.
    expect(lines[2]).not.toContain("{");
  });

  it.each([0, -1, 1.5, Number.NaN, 600_001])("refuses the work limit %s", (limit) => {
    expect(() => boundedPowerShellProgram("exit 0", limit)).toThrow(TypeError);
  });
});

describe("runBoundedPowerShellProgram", () => {
  it("runs under the host start allowance plus the work limit, with the trusted environment", () => {
    let seen: Parameters<WindowsProgramRunner> | undefined;
    const result = run(
      {},
      {
        runner: (...call) => {
          seen = call;
          return { status: 0, stdout: `${STARTED}ANSWER`, stderr: "" };
        },
        input: "aW5wdXQ=\n",
        workTimeoutMs: 10_000,
        maxOutputBytes: 256,
      },
    );
    expect(result).toEqual({
      started: true,
      error: undefined,
      status: 0,
      stdout: "ANSWER",
      stderr: "",
    });
    const [command, args, options] = seen ?? [];
    expect(command).toBe(POWERSHELL);
    expect(args?.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(args?.[4] ?? "", "base64").toString("utf16le")).toBe(
      boundedPowerShellProgram("exit 0", 10_000),
    );
    expect(options).toEqual({
      encoding: "utf8",
      env: {
        SystemRoot: String.raw`C:\Windows`,
        WINDIR: String.raw`C:\Windows`,
        SystemDrive: "C:",
      },
      input: "aW5wdXQ=\n",
      maxBuffer: 256 + STARTED.length,
      shell: false,
      timeout: WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS + 10_000,
      windowsHide: true,
    });
    expect(boundedPowerShellTimeoutMs(10_000)).toBe(70_000);
  });

  it("reports a host that never reached the program as a host start failure", () => {
    expect(() => run({ status: null, error: timedOut() })).toThrow(WindowsProgramHostStartError);
  });

  it.each([
    ["the watchdog ended the program", { status: WATCHDOG_STATUS, stdout: STARTED }],
    [
      "the outer limit ended a started program",
      { status: null, stdout: STARTED, error: timedOut() },
    ],
  ])("reports a work timeout when %s", (_label, result) => {
    expect(() => run(result)).toThrow(WindowsProgramWorkTimeoutError);
  });

  it.each([
    ["an answer without the start marker", { stdout: "ANSWER" }],
    ["a blocked host that exits at once", { status: 1, stderr: "blocked" }],
    ["a spawn failure", { status: null, error: new Error("spawn EACCES") }],
  ])("returns %s as a run that never started, for the caller to refuse", (_label, result) => {
    expect(run(result)).toMatchObject({ started: false, stdout: "" });
  });

  it("stays silent for a quick program", () => {
    const { sink, events } = recording();
    run({ stdout: `${STARTED}ANSWER` }, { securityLogSink: sink });
    expect(events).toEqual([]);
  });

  it("records a slow program with its duration and nothing of its input or output", () => {
    const { sink, events } = recording();
    run(
      {},
      {
        program: "owner-private",
        input: "c2VjcmV0LXBhdGg=\n",
        runner: () => ({ status: 0, stdout: `${STARTED}private-answer`, stderr: "" }),
        now: lasting(WINDOWS_PROGRAM_SLOW_MS + 500),
        securityLogSink: sink,
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "diagnostic",
      level: "info",
      op: "security.windows-program.run",
      extra: { program: "owner-private", outcome: "completed" },
    });
    expect(events[0]?.durationMs).toBe(WINDOWS_PROGRAM_SLOW_MS + 500);
    expect(JSON.stringify(events)).not.toContain("private-answer");
    expect(JSON.stringify(events)).not.toContain("c2VjcmV0");
    const persisted = expectActivityLogProof(
      "security.windows-program.run.outcome",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ program: "owner-private", outcome: "completed" });
  });

  it.each([
    ["host-start-timeout", { status: null, error: timedOut() }],
    ["work-timeout", { status: WATCHDOG_STATUS, stdout: STARTED }],
  ] as const)("records %s as a timeout warning before it throws", (outcome, result) => {
    const { sink, events } = recording();
    expect(() => run(result, { securityLogSink: sink })).toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "warn",
      errorKind: "timeout",
      op: "security.windows-program.run",
      extra: { program: "local-volume", outcome },
    });
  });
});
