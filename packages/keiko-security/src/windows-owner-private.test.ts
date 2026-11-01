import { describe, expect, it } from "vitest";

import {
  inspectWindowsOwnerPrivateFiles,
  protectWindowsOwnerPrivateFile,
  windowsOwnerPrivateVerdict,
  type WindowsOwnerPrivateFacts,
} from "./windows-owner-private.js";
import type { WindowsLocalVolumeRunner } from "./windows-local-volume.js";
import type { SecurityLogEvent, SecurityLogSink } from "./log-port.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const USER = "S-1-5-21-1-2-3-1001";
const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly env: NodeJS.ProcessEnv;
}

function runner(
  stdout: string,
  overrides: { status?: number; stderr?: string; error?: Error } = {},
): { readonly run: WindowsLocalVolumeRunner; readonly calls: Call[] } {
  const calls: Call[] = [];
  const run: WindowsLocalVolumeRunner = (command, args, options) => {
    calls.push({ command, args, input: options.input, env: options.env });
    return {
      status: overrides.status ?? 0,
      stdout,
      stderr: overrides.stderr ?? "",
      error: overrides.error,
    };
  };
  return { run, calls };
}

function recordingSink(): { readonly sink: SecurityLogSink; readonly lines: string[] } {
  const lines: string[] = [];
  return { sink: { write: (event) => lines.push(JSON.stringify(event)) }, lines };
}

// A minimal self-relative descriptor: owner USER, DACL with one FullControl ACE for USER.
function ownerOnlyDescriptor(): string {
  // S-1-5-21-1-2-3-1001: revision 1, five sub-authorities, authority 5 (big endian).
  const sid = Buffer.alloc(8 + 5 * 4);
  sid.set([1, 5, 0, 0, 0, 0, 0, 5]);
  [21, 1, 2, 3, 1001].forEach((value, index) => {
    sid.writeUInt32LE(value, 8 + index * 4);
  });
  const ace = Buffer.concat([Buffer.from([0, 0, 8 + sid.length, 0]), Buffer.alloc(4), sid]);
  ace.writeUInt32LE(0x1f01ff, 4);
  const acl = Buffer.concat([Buffer.from([2, 0, 8 + ace.length, 0, 1, 0, 0, 0]), ace]);
  const header = Buffer.alloc(20);
  header.writeUInt8(1, 0);
  header.writeUInt16LE(0x8004, 2);
  header.writeUInt32LE(20, 4);
  header.writeUInt32LE(20 + sid.length, 16);
  return Buffer.concat([header, sid, acl]).toString("base64");
}

const FILE = String.raw`C:\Users\dev\AppData\Local\Keiko\mcp-servers.json`;

describe("inspecting files through the fixed PowerShell program", () => {
  it("sends paths only as Base64 input lines and parses facts per file in order", () => {
    const { run, calls } = runner(
      `P|${USER}|${USER}\nF|0|32|7|1|1|2|${ownerOnlyDescriptor()}\nE|1\n`,
    );
    const inspection = inspectWindowsOwnerPrivateFiles([FILE, String.raw`D:\missing.json`], {
      runner: run,
      resolvePowerShell: () => POWERSHELL,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(" ")).not.toContain("mcp-servers");
    expect(calls[0]?.input).toBe(
      `${Buffer.from(FILE).toString("base64")}\n${Buffer.from(String.raw`D:\missing.json`).toString("base64")}\n\n`,
    );
    expect(calls[0]?.env).toEqual({
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      SystemDrive: "C:",
    });
    expect(inspection.principal).toEqual({ userSid: USER, tokenOwnerSid: USER });
    expect(inspection.files[0]).toMatchObject({
      kind: "facts",
      attributes: 32,
      volumeSerial: 7n,
      links: 1,
      fileIndex: (1n << 32n) | 2n,
    });
    expect(inspection.files[1]).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["a missing principal line", "F|0|32|7|1|1|2|AA==\n"],
    ["a malformed SID", `P|S-1-x|${USER}\nE|0\n`],
    ["a file line out of order", `P|${USER}|${USER}\nE|1\n`],
    ["an extra file line", `P|${USER}|${USER}\nE|0\nE|1\n`],
    ["a value past 32 bits", `P|${USER}|${USER}\nF|0|32|4294967296|1|1|2|AA==\n`],
    ["a non-Base64 descriptor", `P|${USER}|${USER}\nF|0|32|7|1|1|2|not base64!\n`],
    ["a missing trailing newline", `P|${USER}|${USER}\nE|0`],
  ])("refuses %s in the program output", (_name, stdout) => {
    const { run } = runner(stdout);
    const { sink, lines } = recordingSink();
    expect(() =>
      inspectWindowsOwnerPrivateFiles([FILE], {
        runner: run,
        resolvePowerShell: () => POWERSHELL,
        securityLogSink: sink,
      }),
    ).toThrow("windows-owner-private-output-invalid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("mcp-servers");
  });

  it.each([
    ["a nonzero exit", { status: 1 }],
    ["standard error output", { stderr: "denied" }],
    ["a spawn error", { error: new Error("blocked by AppLocker") }],
  ])("treats %s as an unavailable inspection", (_name, overrides) => {
    const { run } = runner("", overrides);
    expect(() =>
      inspectWindowsOwnerPrivateFiles([FILE], { runner: run, resolvePowerShell: () => POWERSHELL }),
    ).toThrow("windows-owner-private-unavailable");
  });

  it.each([
    ["a UNC share", String.raw`\\server\share\registry.json`],
    ["a device path", String.raw`\\?\C:\registry.json`],
    ["a relative path", "registry.json"],
    ["a POSIX path", "/home/dev/registry.json"],
    ["a line break", "C:\\a\nC:\\b"],
  ])("refuses %s before starting PowerShell", (_name, path) => {
    const { run, calls } = runner("");
    expect(() =>
      inspectWindowsOwnerPrivateFiles([path], { runner: run, resolvePowerShell: () => POWERSHELL }),
    ).toThrow("windows-owner-private-input-invalid");
    expect(calls).toEqual([]);
  });
});

describe("the verdict for an opened file", () => {
  const principal = { userSid: USER, tokenOwnerSid: USER };
  const facts = (patch: Partial<Extract<WindowsOwnerPrivateFacts, { kind: "facts" }>> = {}) =>
    ({
      kind: "facts",
      attributes: 0x20,
      volumeSerial: 7n,
      fileIndex: 9n,
      links: 1,
      descriptor: new Uint8Array(Buffer.from(ownerOnlyDescriptor(), "base64")),
      ...patch,
    }) as const;

  it("accepts the inspected object with an owner-private descriptor", () => {
    expect(windowsOwnerPrivateVerdict(facts(), principal, { dev: 7n, ino: 9n })).toEqual({
      kind: "owner-private",
    });
  });

  it("refuses a file that was replaced after the inspection", () => {
    expect(windowsOwnerPrivateVerdict(facts(), principal, { dev: 7n, ino: 10n })).toEqual({
      kind: "refused",
      reason: "replaced",
    });
    expect(windowsOwnerPrivateVerdict(facts(), principal, { dev: 8n, ino: 9n })).toEqual({
      kind: "refused",
      reason: "replaced",
    });
  });

  it.each([0x400, 0x10, 0x410])("refuses attributes %s as not a regular file", (attributes) => {
    expect(
      windowsOwnerPrivateVerdict(facts({ attributes }), principal, { dev: 7n, ino: 9n }),
    ).toEqual({
      kind: "refused",
      reason: "not-regular-file",
    });
  });

  it("refuses a file the program could not inspect", () => {
    expect(
      windowsOwnerPrivateVerdict({ kind: "unavailable" }, principal, { dev: 7n, ino: 9n }),
    ).toEqual({ kind: "refused", reason: "unavailable" });
  });

  it("refuses a descriptor owned by another user", () => {
    const other = { userSid: "S-1-5-21-1-2-3-1002", tokenOwnerSid: "S-1-5-21-1-2-3-1002" };
    expect(windowsOwnerPrivateVerdict(facts(), other, { dev: 7n, ino: 9n })).toEqual({
      kind: "refused",
      reason: "foreign-owner",
    });
  });
});

describe("protecting a file Keiko writes", () => {
  const binaries = (name: string): string => `${String.raw`C:\Windows\System32`}\\${name}`;

  it("grants only the user, SYSTEM and Administrators through SIDs", () => {
    const calls: Call[] = [];
    const run: WindowsLocalVolumeRunner = (command, args, options) => {
      calls.push({ command, args, input: options.input, env: options.env });
      const stdout = command.endsWith("whoami.exe") ? `"host\\dev","${USER}"\r\n` : "";
      return { status: 0, stdout, stderr: "" };
    };
    protectWindowsOwnerPrivateFile(FILE, { runner: run, resolveSystemBinary: binaries });

    expect(calls.map((call) => call.command)).toEqual([
      binaries("whoami.exe"),
      binaries("icacls.exe"),
    ]);
    expect(calls[1]?.args).toEqual([
      FILE,
      "/inheritance:r",
      "/grant:r",
      `*${USER}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ]);
    expect(calls[1]?.env).toEqual({
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      SystemDrive: "C:",
    });
  });

  it("fails closed when icacls fails or no SID can be read, and logs body-free", () => {
    const { sink, lines } = recordingSink();
    const failing: WindowsLocalVolumeRunner = (command) =>
      command.endsWith("whoami.exe")
        ? { status: 0, stdout: `"host\\dev","${USER}"`, stderr: "" }
        : { status: 5, stdout: "", stderr: "Zugriff verweigert" };
    expect(() => {
      protectWindowsOwnerPrivateFile(FILE, {
        runner: failing,
        resolveSystemBinary: binaries,
        securityLogSink: sink,
      });
    }).toThrow("windows-owner-private-protect-failed");
    const noSid: WindowsLocalVolumeRunner = () => ({ status: 0, stdout: "dev", stderr: "" });
    expect(() => {
      protectWindowsOwnerPrivateFile(FILE, {
        runner: noSid,
        resolveSystemBinary: binaries,
        securityLogSink: sink,
      });
    }).toThrow("windows-owner-private-protect-failed");
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/mcp-servers|Zugriff|S-1-5-21/u);
  });

  it("refuses a path it cannot protect before running anything", () => {
    const { run, calls } = runner("");
    expect(() => {
      protectWindowsOwnerPrivateFile(String.raw`\\server\share\x.json`, {
        runner: run,
        resolveSystemBinary: binaries,
      });
    }).toThrow("windows-owner-private-input-invalid");
    expect(calls).toEqual([]);
  });
});

describe("the body-free refusal event", () => {
  it("persists only the phase and error class of an unavailable inspection", () => {
    const events: SecurityLogEvent[] = [];
    const { run } = runner("", { status: 1, stderr: "private failure detail" });
    expect(() =>
      inspectWindowsOwnerPrivateFiles([FILE], {
        runner: run,
        resolvePowerShell: () => POWERSHELL,
        securityLogSink: {
          write: (event): void => {
            events.push(event);
          },
        },
      }),
    ).toThrow("windows-owner-private-unavailable");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "security",
      level: "error",
      op: "security.windows-owner-private.refused",
      errorKind: "unavailable",
    });
    expect(JSON.stringify(events)).not.toMatch(/mcp-servers|private failure detail/u);
    const persisted = expectActivityLogProof(
      "security.windows-owner-private.refused.phase",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ failureKind: "Error", phase: "inspect" });
  });
});
