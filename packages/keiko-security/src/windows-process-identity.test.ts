import { nullSecurityLogSink } from "./log-port.js";
import { describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  boundedPowerShellTimeoutMs,
  WINDOWS_PROGRAM_STARTED_MARKER,
  type WindowsProgramRunner,
} from "./windows-powershell-program.js";
import {
  readWindowsProcessCommandLine,
  WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS,
} from "./windows-process-identity.js";

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const STARTED = `${WINDOWS_PROGRAM_STARTED_MARKER}\n`;
const COMMAND_LINE = String.raw`"C:\Program Files\nodejs\node.exe" C:\keiko\index.js ui --port 1983 --keiko-launch-id ${"a".repeat(32)}`;

type RunnerResult = ReturnType<WindowsProgramRunner>;

function timedOut(): Error {
  return Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
}

function read(
  result: Partial<RunnerResult>,
  seen?: (call: Parameters<WindowsProgramRunner>) => void,
  events: SecurityLogEvent[] = [],
): string | undefined {
  return readWindowsProcessCommandLine(4711, {
    resolvePowerShell: () => POWERSHELL,
    runner: (...call) => {
      seen?.(call);
      return { status: 0, stdout: "", stderr: "", ...result };
    },
    securityLogSink: { write: (event): void => void events.push(event) },
  });
}

describe("readWindowsProcessCommandLine", () => {
  it("returns the command line the fixed program reports for the pid it received on stdin", () => {
    let call: Parameters<WindowsProgramRunner> | undefined;
    const line = read({ stdout: `${STARTED}${COMMAND_LINE}` }, (seen) => {
      call = seen;
    });
    expect(line).toBe(COMMAND_LINE);
    const [command, args, options] = call ?? [];
    expect(command).toBe(POWERSHELL);
    const program = Buffer.from(args?.at(-1) ?? "", "base64").toString("utf16le");
    expect(options?.input).toBe("4711\n");
    // The pid is data, never program text.
    expect(program).not.toContain("4711");
    expect(program).toContain("Get-CimInstance -ClassName Win32_Process");
    expect(program).toContain(`'^[0-9]{1,10}$'`);
  });

  // #4358: one 3 s limit covered the PowerShell host start, which alone needs 6.5 to 20 s under
  // x64 emulation, so `keiko stop` and a second `keiko start` never got an identity.
  it("answers on a host that needs longer to start than the query may take", () => {
    const slowHost: WindowsProgramRunner = (_command, _args, options) =>
      options.timeout < 20_000
        ? { error: timedOut(), status: null, stdout: "", stderr: "" }
        : { status: 0, stdout: `${STARTED}${COMMAND_LINE}`, stderr: "" };
    expect(
      readWindowsProcessCommandLine(4711, {
        securityLogSink: nullSecurityLogSink(),
        resolvePowerShell: () => POWERSHELL,
        runner: slowHost,
      }),
    ).toBe(COMMAND_LINE);
  });

  // #4358, measured on Windows: the host start was waited out, yet every read still timed out,
  // because loading the CIM cmdlets was counted inside the query's 3 s. The host below models that:
  // whatever the program does after its start marker runs under the program's own watchdog.
  function emulatedHost(times: {
    readonly hostStartMs: number;
    readonly moduleLoadMs: number;
    readonly queryMs: number;
  }): WindowsProgramRunner {
    return (_command, args, options) => {
      const program = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
      const marker = program.indexOf(WINDOWS_PROGRAM_STARTED_MARKER);
      const load = program.indexOf("Import-Module CimCmdlets");
      const loadedBeforeMarker = load !== -1 && load < marker;
      const workLimit = Number(/CancellationTokenSource\]::new\((\d+)\)/u.exec(program)?.[1]);
      const beforeMarker = times.hostStartMs + (loadedBeforeMarker ? times.moduleLoadMs : 0);
      const work = times.queryMs + (loadedBeforeMarker ? 0 : times.moduleLoadMs);
      if (options.timeout < beforeMarker) {
        return { error: timedOut(), status: null, stdout: "", stderr: "" };
      }
      if (work > workLimit) return { status: 0xffffffff, stdout: STARTED, stderr: "" };
      return { status: 0, stdout: `${STARTED}${COMMAND_LINE}`, stderr: "" };
    };
  }

  function readOn(runner: WindowsProgramRunner): string | undefined {
    return readWindowsProcessCommandLine(4711, {
      securityLogSink: nullSecurityLogSink(),
      resolvePowerShell: () => POWERSHELL,
      runner,
    });
  }

  it("answers when the module loads slowly and the query is fast", () => {
    expect(readOn(emulatedHost({ hostStartMs: 8_000, moduleLoadMs: 6_000, queryMs: 300 }))).toBe(
      COMMAND_LINE,
    );
  });

  it("stays fail closed when the query itself is slow, whatever the module took", () => {
    const events: SecurityLogEvent[] = [];
    const line = readWindowsProcessCommandLine(4711, {
      resolvePowerShell: () => POWERSHELL,
      runner: emulatedHost({ hostStartMs: 500, moduleLoadMs: 100, queryMs: 5_000 }),
      securityLogSink: { write: (event): void => void events.push(event) },
    });
    expect(line).toBeUndefined();
    expect(events[0]?.extra).toMatchObject({
      program: "process-identity",
      outcome: "work-timeout",
    });
  });

  it("stays fail closed when host start and module load exceed the host start allowance", () => {
    expect(
      readOn(emulatedHost({ hostStartMs: 40_000, moduleLoadMs: 30_000, queryMs: 100 })),
    ).toBeUndefined();
  });

  it("loads the module before the start marker and gives it no input", () => {
    let call: Parameters<WindowsProgramRunner> | undefined;
    read({ stdout: STARTED }, (seen) => {
      call = seen;
    });
    const lines = Buffer.from(call?.[1].at(-1) ?? "", "base64")
      .toString("utf16le")
      .split("\n");
    expect(lines[0]).toBe("Import-Module CimCmdlets -ErrorAction Stop");
    expect(lines[1]).toContain(WINDOWS_PROGRAM_STARTED_MARKER);
    expect(lines[2]).toBe("$keikoWatchdog = [Threading.CancellationTokenSource]::new(3000)");
  });

  it("keeps the query's own 3 s limit inside the program", () => {
    let call: Parameters<WindowsProgramRunner> | undefined;
    read({ stdout: STARTED }, (seen) => {
      call = seen;
    });
    const program = Buffer.from(call?.[1].at(-1) ?? "", "base64").toString("utf16le");
    expect(WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS).toBe(3_000);
    expect(program).toContain("[Threading.CancellationTokenSource]::new(3000)");
    expect(call?.[2].timeout).toBe(boundedPowerShellTimeoutMs(3_000));
  });

  it.each([
    ["a process that does not exist", { stdout: STARTED }],
    ["a failed query", { status: 1, stdout: STARTED }],
    ["a host that never started", { status: null, error: timedOut() }],
    ["a query the watchdog cut off", { status: 0xffffffff, stdout: STARTED }],
    ["an answer without the start marker", { stdout: COMMAND_LINE }],
    ["a spawn failure", { status: null, error: new Error("spawn EACCES") }],
  ])("proves nothing for %s", (_label, result) => {
    expect(read(result)).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 32])(
    "refuses the pid %s without running anything",
    (pid) => {
      const runner: WindowsProgramRunner = () => {
        throw new Error("must not run");
      };
      expect(
        readWindowsProcessCommandLine(pid, {
          securityLogSink: nullSecurityLogSink(),
          resolvePowerShell: () => POWERSHELL,
          runner,
        }),
      ).toBeUndefined();
    },
  );

  it("never throws when PowerShell cannot be resolved, and records that nothing was learned", () => {
    const events: SecurityLogEvent[] = [];
    expect(
      readWindowsProcessCommandLine(4711, {
        resolvePowerShell: () => {
          throw new Error("system directory refused");
        },
        securityLogSink: { write: (event): void => void events.push(event) },
      }),
    ).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "warn",
      errorKind: "unavailable",
      op: "security.windows-program.run",
      extra: { program: "process-identity", outcome: "unavailable" },
    });
  });

  it("records a timed-out read without the command line or the pid", () => {
    const events: SecurityLogEvent[] = [];
    read({ status: null, error: timedOut() }, undefined, events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "security.windows-program.run",
      extra: { program: "process-identity", outcome: "host-start-timeout" },
    });
    expect(JSON.stringify(events)).not.toContain("4711");
  });
});
