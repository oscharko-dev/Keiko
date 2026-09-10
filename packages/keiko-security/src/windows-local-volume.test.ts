import { describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  assertWindowsLocalVolume,
  WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES,
  WINDOWS_LOCAL_VOLUME_TIMEOUT_MS,
  type WindowsLocalVolumeRunner,
} from "./windows-local-volume.js";

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
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
      return { status: 0, stdout: "KEIKO_LOCAL_VOLUME_OK", stderr: "" };
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
    timeout: WINDOWS_LOCAL_VOLUME_TIMEOUT_MS,
    maxBuffer: WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES,
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
}): WindowsLocalVolumeRunner {
  return (_command, _args, _options) => ({
    error: undefined,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
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
    { status: 1, stdout: "", stderr: "" },
    { status: 0, stdout: "KEIKO_LOCAL_VOLUME_OK\n", stderr: "" },
    { status: 0, stdout: "KEIKO_LOCAL_VOLUME_OK", stderr: "warning" },
  ])("fails closed unless the body-free success token is exact", (result) => {
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
        runner: runner({ status: 1, stderr: "private failure detail" }),
        securityLogSink: { write: (event): void => void events.push(event) },
      });
    }).toThrow("local volume");

    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        level: "error",
        op: "security.windows-local-volume.refused",
        errorKind: "Error",
        extra: { phase: "verify" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(path);
    expect(JSON.stringify(events)).not.toContain("private failure detail");
  });
});
