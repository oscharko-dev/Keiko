import { describe, expect, it, vi } from "vitest";
import { createWindowsTerminationCapacity, windowsTaskkillInvocation } from "./exec.js";
import {
  buildWindowsShellInvocation,
  resolveSystemBinaryPath,
  WindowsSystemDirectoryError,
} from "./windows-shell.js";

const SYSTEM_ROOT =
  process.platform === "win32"
    ? (process.env.SystemRoot ?? String.raw`C:\Windows`)
    : String.raw`D:\Windows`;

describe("Windows command helpers preserve environment aliases (#4408)", () => {
  it("selects the same uppercase SystemRoot for cmd and taskkill", () => {
    const env = { SystemRoot: String.raw`Z:\ignored`, SYSTEMROOT: SYSTEM_ROOT };
    const command = buildWindowsShellInvocation(String.raw`C:\approved-bin\npm.cmd`, [], {
      env,
      platform: "win32",
      existsAsFile: () => true,
      systemDirectoryIdentity: () => true,
    });
    expect(command.command).toBe(`${SYSTEM_ROOT}\\System32\\cmd.exe`);
    expect(windowsTaskkillInvocation(4242, env).command).toBe(
      `${SYSTEM_ROOT}\\System32\\taskkill.exe`,
    );
  });

  it("refuses malformed selected aliases in both wrapper and direct taskkill", () => {
    const env = { SYSTEMROOT: String.raw`\\untrusted\share`, SystemRoot: SYSTEM_ROOT };
    expect(() =>
      buildWindowsShellInvocation(String.raw`C:\approved-bin\npm.cmd`, [], {
        env,
        platform: "win32",
        existsAsFile: () => true,
        systemDirectoryIdentity: () => true,
      }),
    ).toThrow(WindowsSystemDirectoryError);
    expect(() => windowsTaskkillInvocation(4242, env)).toThrow(WindowsSystemDirectoryError);
  });

  it("captures the selected alias at admission and preserves it across later parent mutation", () => {
    const observed = vi.fn((_pid: number, env: NodeJS.ProcessEnv) => ({
      command: resolveSystemBinaryPath(
        "taskkill.exe",
        env,
        () => true,
        () => true,
      ),
      args: [],
    }));
    const run = vi.fn((_command: string) => ({ status: 0 }));
    const capacity = createWindowsTerminationCapacity(1, undefined, observed, run);
    const env = { SYSTEMROOT: String.raw`D:\Windows`, Secret: "private-canary" };
    const reservation = capacity.reserve(env);
    expect(reservation).toBeDefined();
    expect(observed.mock.calls[0]?.[1]).toEqual({ SystemRoot: String.raw`D:\Windows` });
    env.SYSTEMROOT = String.raw`\\untrusted\share`;
    expect(reservation?.kill(4242, env)).toBe("succeeded");
    expect(run.mock.calls[0]?.[0]).toBe(String.raw`D:\Windows\System32\taskkill.exe`);
    reservation?.release();
  });

  it("refuses malformed aliases before reserving termination capacity", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const capacity = createWindowsTerminationCapacity(
      1,
      undefined,
      (_pid, env) => ({
        command: resolveSystemBinaryPath(
          "taskkill.exe",
          env,
          () => true,
          () => true,
        ),
        args: [],
      }),
      run,
    );
    expect(() => capacity.reserve({ SYSTEMROOT: String.raw`\\untrusted\share` })).toThrow(
      WindowsSystemDirectoryError,
    );
    expect(run).not.toHaveBeenCalled();
    const reservation = capacity.reserve({ SYSTEMROOT: String.raw`D:\Windows` });
    expect(reservation).toBeDefined();
    reservation?.release();
  });
});
