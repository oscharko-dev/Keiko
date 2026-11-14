import { describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  assertWindowsLocalVolume,
  assertWindowsLocalVolumeForPassiveRead,
  forgetRememberedWindowsLocalVolumesForTest,
  WindowsLocalVolumeError,
  windowsLocalVolumeVerdict,
  WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES,
  WINDOWS_LOCAL_VOLUME_TIMEOUT_MS,
  type WindowsLocalVolumeRunner,
} from "./windows-local-volume.js";
import {
  boundedPowerShellTimeoutMs,
  WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS,
  WINDOWS_PROGRAM_STARTED_MARKER,
} from "./windows-powershell-program.js";
import { WindowsSystemBinaryMissingError } from "./windows-system-directory.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const STARTED = `${WINDOWS_PROGRAM_STARTED_MARKER}\n`;
const OK = `${STARTED}KEIKO_LOCAL_VOLUME_OK`;
// `Process.Kill()` from the in-program watchdog: exit code -1, reported unsigned.
const WATCHDOG_STATUS = 0xffffffff;
interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Parameters<WindowsLocalVolumeRunner>[2];
}

function capturedInvocation(): {
  readonly capture: WindowsLocalVolumeRunner;
  readonly read: () => Invocation | undefined;
} {
  let invocation: Invocation | undefined;
  return {
    capture: (command, args, options): ReturnType<WindowsLocalVolumeRunner> => {
      invocation = { command, args, options };
      return { status: 0, stdout: OK, stderr: "" };
    },
    read: (): Invocation | undefined => invocation,
  };
}

function queryFrom(call: Invocation | undefined): string {
  return Buffer.from(call?.args[4] ?? "", "base64").toString("utf16le");
}

function assertProcess(call: Invocation | undefined): void {
  expect(call?.command).toBe(POWERSHELL);
  expect(call?.args.slice(0, 4)).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  expect(call?.args).toHaveLength(5);
}

function assertQuery(query: string): void {
  [
    "AssemblyBuilderAccess]::Run",
    "[Reflection.AssemblyName]::new('KeikoLocalVolume')",
    "[Text.StringBuilder]::new(32768)",
    "DefinePInvokeMethod",
    "GetFileInformationByHandleEx",
    "GetFinalPathNameByHandleW",
    "GetVolumePathNameW",
    "GetDriveTypeW",
    "AllocHGlobal(8)",
  ].forEach((needle) => {
    expect(query).toContain(needle);
  });
  expect(query).not.toContain("Add-Type");
  expect(query).not.toContain("New-Object");
  expect(query).not.toContain("TEMP");
}

function assertEnvironment(call: Invocation | undefined): void {
  expect(call?.options).toMatchObject({
    shell: false,
    timeout: boundedPowerShellTimeoutMs(WINDOWS_LOCAL_VOLUME_TIMEOUT_MS),
    maxBuffer: WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES + STARTED.length,
    windowsHide: true,
    env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows`, SystemDrive: "C:" },
  });
  ["TEMP", "TMP", "PATH"].forEach((name) => {
    expect(call?.options.env).not.toHaveProperty(name);
  });
}

function runner(result: {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
}): WindowsLocalVolumeRunner {
  return (_command, _args, _options) => ({
    error: result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

function timedOut(): Error {
  return Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
}

/**
 * A host that needs `hostStartMs` before the program's first statement runs, as `spawnSync` shows
 * it: killed at the caller's limit when that is shorter, otherwise the program's own answer.
 */
function slowHost(hostStartMs: number, answer: string): WindowsLocalVolumeRunner {
  return (_command, _args, options) =>
    options.timeout < hostStartMs
      ? { error: timedOut(), status: null, stdout: "", stderr: "" }
      : { error: undefined, status: 0, stdout: `${STARTED}${answer}`, stderr: "" };
}

function refusal(invoke: (sink: { write: (event: SecurityLogEvent) => void }) => void): {
  readonly message: string;
  readonly events: SecurityLogEvent[];
} {
  const events: SecurityLogEvent[] = [];
  let message = "";
  try {
    invoke({ write: (event): void => void events.push(event) });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  return { message, events };
}

describe("Windows local volume authority", () => {
  it("uses identity-resolved PowerShell, a fixed encoded query, bounded output, and Base64 path data", () => {
    const invocation = capturedInvocation();
    const path = String.raw`D:\Keiko & still-data`;
    assertWindowsLocalVolume(path, {
      platform: "win32",
      resolvePowerShell: () => POWERSHELL,
      runner: invocation.capture,
    });
    const call = invocation.read();
    expect(Buffer.from(call?.options.input.trim() ?? "", "base64").toString("utf8")).toBe(path);
    assertProcess(call);
    assertQuery(queryFrom(call));
    assertEnvironment(call);
  });

  it.each([
    { status: 1, stdout: STARTED, stderr: "" },
    { status: 0, stdout: `${OK}\n`, stderr: "" },
    { status: 0, stdout: OK, stderr: "warning" },
    // The host answered without ever running the program: the bare token proves nothing.
    { status: 0, stdout: "KEIKO_LOCAL_VOLUME_OK", stderr: "" },
  ])("fails closed unless the program started and its success token is exact", (result) => {
    expect(() => {
      assertWindowsLocalVolume(String.raw`D:\Keiko`, {
        platform: "win32",
        resolvePowerShell: () => POWERSHELL,
        runner: runner(result),
      });
    }).toThrow("local volume");
  });

  it("does not invoke Windows tooling on other platforms", () => {
    expect(() => {
      assertWindowsLocalVolume("/tmp/Keiko", {
        platform: "darwin",
        resolvePowerShell: () => {
          throw new Error("called");
        },
      });
    }).not.toThrow();
  });

  it("emits a body-free security refusal before preserving the failure", () => {
    const events: SecurityLogEvent[] = [];
    const path = String.raw`D:\Keiko\private-customer-path`;

    expect(() => {
      assertWindowsLocalVolume(path, {
        platform: "win32",
        resolvePowerShell: () => POWERSHELL,
        runner: runner({ status: 1, stdout: STARTED, stderr: "private failure detail" }),
        securityLogSink: { write: (event): void => void events.push(event) },
      });
    }).toThrow("local volume");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "security",
      level: "error",
      op: "security.windows-local-volume.refused",
      errorKind: "unsafe-target",
    });
    expect(events[0]?.extra).toMatchObject({ failureKind: "Error", phase: "verify" });
    expect(JSON.stringify(events)).not.toContain(path);
    expect(JSON.stringify(events)).not.toContain("private failure detail");
    const persisted = expectActivityLogProof(
      "security.windows-local-volume.refused.phase",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ failureKind: "Error", phase: "verify" });
  });

  it.each([
    {
      expectedErrorKind: "invalid-request",
      invoke: (events: SecurityLogEvent[]): void => {
        assertWindowsLocalVolume("", {
          platform: "win32",
          securityLogSink: { write: (event): void => void events.push(event) },
        });
      },
      phase: "input",
    },
    {
      expectedErrorKind: "unavailable",
      invoke: (events: SecurityLogEvent[]): void => {
        assertWindowsLocalVolume(String.raw`D:\Keiko`, {
          platform: "win32",
          resolvePowerShell: () => {
            throw new WindowsSystemBinaryMissingError();
          },
          securityLogSink: { write: (event): void => void events.push(event) },
        });
      },
      phase: "resolve",
    },
  ] as const)(
    "classifies $phase failures as $expectedErrorKind",
    ({ expectedErrorKind, invoke, phase }) => {
      const events: SecurityLogEvent[] = [];

      expect(() => {
        invoke(events);
      }).toThrow();
      expect(events).toHaveLength(1);
      expect(events[0]?.errorKind).toBe(expectedErrorKind);
      expect(events[0]?.extra).toMatchObject({ phase });
    },
  );

  // #4358: Keiko.exe refused to start on a correct local disk because one 10 s limit covered both
  // the inbox PowerShell host coming up (13 to 20 s under x64 emulation) and the volume query.
  describe("host start and volume query are bounded separately", () => {
    it("accepts a local volume when the host needs longer to start than the query may take", () => {
      expect(() => {
        assertWindowsLocalVolume(String.raw`C:\Keiko`, {
          platform: "win32",
          resolvePowerShell: () => POWERSHELL,
          runner: slowHost(20_000, "KEIKO_LOCAL_VOLUME_OK"),
        });
      }).not.toThrow();
    });

    it("still refuses a volume that is not local however long the host took", () => {
      expect(() => {
        assertWindowsLocalVolume(String.raw`Z:\Keiko`, {
          platform: "win32",
          resolvePowerShell: () => POWERSHELL,
          runner: slowHost(20_000, ""),
        });
      }).toThrow("must be on a local volume");
    });

    it("keeps the query's own limit, armed inside the program at its first statement", () => {
      const invocation = capturedInvocation();
      assertWindowsLocalVolume(String.raw`C:\Keiko`, {
        platform: "win32",
        resolvePowerShell: () => POWERSHELL,
        runner: invocation.capture,
      });
      const program = queryFrom(invocation.read());
      const marker = program.indexOf(`[Console]::Out.Write('${WINDOWS_PROGRAM_STARTED_MARKER}'`);
      const watchdog = program.indexOf(
        `[Threading.CancellationTokenSource]::new(${String(WINDOWS_LOCAL_VOLUME_TIMEOUT_MS)})`,
      );
      const query = program.indexOf("[Console]::In.ReadLine()");
      expect(WINDOWS_LOCAL_VOLUME_TIMEOUT_MS).toBe(10_000);
      expect(marker).toBe(0);
      expect(watchdog).toBeGreaterThan(marker);
      expect(query).toBeGreaterThan(watchdog);
      expect(program).toContain("[Diagnostics.Process]::GetCurrentProcess(), 'Kill'");
      expect(invocation.read()?.options.timeout).toBe(
        WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS + WINDOWS_LOCAL_VOLUME_TIMEOUT_MS,
      );
    });

    it("refuses a query the watchdog cut off, as a timeout in the verify phase", () => {
      const path = String.raw`C:\Keiko\private-customer-path`;
      const { message, events } = refusal((securityLogSink) => {
        assertWindowsLocalVolume(path, {
          platform: "win32",
          resolvePowerShell: () => POWERSHELL,
          runner: runner({ status: WATCHDOG_STATUS, stdout: STARTED }),
          securityLogSink,
        });
      });
      expect(message).toBe("Windows managed root must be on a local volume");
      const refused = events.find((event) => event.op === "security.windows-local-volume.refused");
      expect(refused).toMatchObject({ level: "error", errorKind: "timeout" });
      expect(refused?.extra).toMatchObject({ failureKind: "work-timeout", phase: "verify" });
      expect(JSON.stringify(events)).not.toContain("private-customer-path");
    });

    it("names a host that never started, instead of blaming the volume", () => {
      const { message, events } = refusal((securityLogSink) => {
        assertWindowsLocalVolume(String.raw`C:\Keiko`, {
          platform: "win32",
          resolvePowerShell: () => POWERSHELL,
          runner: runner({ status: null, error: timedOut() }),
          securityLogSink,
        });
      });
      expect(message).toBe(
        "Windows managed root could not be verified as a local volume: Windows PowerShell did not start in time",
      );
      const refused = events.find((event) => event.op === "security.windows-local-volume.refused");
      expect(refused).toMatchObject({ level: "error", errorKind: "timeout" });
      expect(refused?.extra).toMatchObject({
        failureKind: "host-start-timeout",
        phase: "host-start",
      });
      const persisted = expectActivityLogProof(
        "security.windows-local-volume.refused.phase",
        formatActivityLogProofLine(refused ?? {}),
      );
      expect(persisted).toMatchObject({ phase: "host-start" });
    });
  });
});

// A caller must be able to tell "this folder is not on a local volume" from "the check could not
// be made": the first is final for that folder, the second passes a moment later (#4358).
describe("the verdict of a refusal", () => {
  const caught = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const check = (path: string, options: Parameters<typeof assertWindowsLocalVolume>[1]): unknown =>
    caught(() => {
      assertWindowsLocalVolume(path, {
        platform: "win32",
        resolvePowerShell: () => POWERSHELL,
        ...options,
      });
    });

  it.each([
    [
      "a volume that is not local",
      { runner: runner({ status: 1, stdout: STARTED }) },
      "not-local",
      "verify",
    ],
    [
      "a query the watchdog cut off",
      { runner: runner({ status: WATCHDOG_STATUS, stdout: STARTED }) },
      "unverifiable",
      "verify",
    ],
    [
      "a host that never started",
      { runner: runner({ status: null, error: timedOut() }) },
      "unverifiable",
      "host-start",
    ],
    [
      "Windows PowerShell that cannot be resolved",
      {
        resolvePowerShell: (): string => {
          throw new WindowsSystemBinaryMissingError();
        },
      },
      "unverifiable",
      "resolve",
    ],
  ] as const)("names %s", (_name, options, verdict, phase) => {
    const error = check(String.raw`C:\Keiko`, options);
    expect(windowsLocalVolumeVerdict(error)).toBe(verdict);
    if (phase === "resolve") {
      // the resolver's own error keeps its class: the launcher matches it
      expect(error).toBeInstanceOf(WindowsSystemBinaryMissingError);
    } else {
      expect(error).toBeInstanceOf(WindowsLocalVolumeError);
      expect(error).toMatchObject({ verdict, phase });
    }
  });

  // A process that never ran the query learned nothing about the volume: telling a person to
  // "install on a local drive" for it would be wrong.
  it.each([
    ["a host that answered without running the program", { status: 0, stdout: "" }],
    ["a process that could not be started", { status: null, error: new Error("spawn EPERM") }],
    ["a process that was ended", { status: null, stdout: STARTED }],
  ] as const)("reads %s as unverifiable", (_name, result) => {
    const { message, events } = refusal((securityLogSink) => {
      assertWindowsLocalVolume(String.raw`C:\Keiko`, {
        platform: "win32",
        resolvePowerShell: () => POWERSHELL,
        runner: runner(result),
        securityLogSink,
      });
    });
    expect(message).toBe(
      "Windows managed root could not be verified as a local volume: the check did not run",
    );
    const refused = events.find((event) => event.op === "security.windows-local-volume.refused");
    expect(refused).toMatchObject({ level: "error", errorKind: "unavailable" });
    expect(refused?.extra).toMatchObject({
      failureKind: "query-not-run",
      phase: "verify",
      verdict: "unverifiable",
    });
  });

  it("treats an input that can never be accepted as not local, and a foreign error as unverifiable", () => {
    expect(check("", {})).toMatchObject({ verdict: "not-local", phase: "input" });
    expect(windowsLocalVolumeVerdict(new Error("something else"))).toBe("unverifiable");
  });

  it("writes the verdict into the refusal line", () => {
    const { events } = refusal((securityLogSink) => {
      assertWindowsLocalVolume(String.raw`Z:\Keiko`, {
        platform: "win32",
        resolvePowerShell: () => POWERSHELL,
        runner: runner({ status: 1, stdout: STARTED }),
        securityLogSink,
      });
    });
    const refused = events.find((event) => event.op === "security.windows-local-volume.refused");
    expect(refused?.extra).toMatchObject({ phase: "verify", verdict: "not-local" });
  });
});

// One check is one Windows PowerShell run. Passive reads may remember a pass; nothing that acts
// on the verdict may.
describe("a remembered pass is for passive reads only", () => {
  const counting = (
    result: Parameters<typeof runner>[0],
  ): { readonly run: WindowsLocalVolumeRunner; readonly calls: () => number } => {
    let calls = 0;
    const inner = runner(result);
    return {
      run: (command, args, options): ReturnType<WindowsLocalVolumeRunner> => {
        calls += 1;
        return inner(command, args, options);
      },
      calls: (): number => calls,
    };
  };
  const options = (
    run: WindowsLocalVolumeRunner,
  ): Parameters<typeof assertWindowsLocalVolume>[1] => ({
    platform: "win32",
    resolvePowerShell: () => POWERSHELL,
    runner: run,
  });
  const quietly = (run: () => void): void => {
    try {
      run();
    } catch {
      // the refusal is what these tests count around
    }
  };

  it("asks once for a folder that passed, and again for another folder", () => {
    forgetRememberedWindowsLocalVolumesForTest();
    const local = counting({ status: 0, stdout: OK });
    assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(local.run));
    assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(local.run));
    expect(local.calls()).toBe(1);
    assertWindowsLocalVolumeForPassiveRead(String.raw`D:\Keiko`, options(local.run));
    expect(local.calls()).toBe(2);
  });

  it.each([
    ["not local", { status: 1, stdout: STARTED }],
    ["unverifiable", { status: WATCHDOG_STATUS, stdout: STARTED }],
  ] as const)("never remembers a refusal (%s)", (_name, result) => {
    forgetRememberedWindowsLocalVolumesForTest();
    const refusing = counting(result);
    quietly(() => {
      assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(refusing.run));
    });
    quietly(() => {
      assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(refusing.run));
    });
    expect(refusing.calls()).toBe(2);
    // and a later pass is not blocked by the earlier refusals
    const local = counting({ status: 0, stdout: OK });
    assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(local.run));
    expect(local.calls()).toBe(1);
  });

  it("is never consulted or filled by the enforcing check", () => {
    forgetRememberedWindowsLocalVolumesForTest();
    const local = counting({ status: 0, stdout: OK });
    assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(local.run));
    // the enforcing check asks Windows again although the passive read remembers a pass
    assertWindowsLocalVolume(String.raw`C:\Keiko`, options(local.run));
    assertWindowsLocalVolume(String.raw`C:\Keiko`, options(local.run));
    expect(local.calls()).toBe(3);
    // and a pass of the enforcing check is not something a passive read may reuse
    forgetRememberedWindowsLocalVolumesForTest();
    const fresh = counting({ status: 0, stdout: OK });
    assertWindowsLocalVolume(String.raw`C:\Keiko`, options(fresh.run));
    assertWindowsLocalVolumeForPassiveRead(String.raw`C:\Keiko`, options(fresh.run));
    expect(fresh.calls()).toBe(2);
    // a folder that moved to a volume that is not local is refused by the enforcing check at once
    const moved = counting({ status: 1, stdout: STARTED });
    expect(() => {
      assertWindowsLocalVolume(String.raw`C:\Keiko`, options(moved.run));
    }).toThrow("must be on a local volume");
  });
});
