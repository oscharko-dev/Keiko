import { describe, expect, it } from "vitest";
import { WindowsSystemDirectoryError, type SecurityLogEvent } from "@oscharko-dev/keiko-security";

import {
  resolveWindowsAuthenticodeSystem,
  windowsAuthenticodeIdentityScript,
  windowsPublisherIdentityMatches,
  windowsPublisherIdentityMatchesAsync,
  windowsSignerIdentity,
  type WindowsAuthenticodeCommandRunner,
  type WindowsAuthenticodeSystemOptions,
} from "./windowsPortableAuthenticode.js";

const SYSTEM_OPTIONS: WindowsAuthenticodeSystemOptions = {
  env: { SystemRoot: String.raw`D:\Windows` },
  existsAsFile: () => true,
  identityCheck: () => true,
};

function signerRunner(...identities: readonly string[]): {
  readonly commands: string[];
  readonly run: WindowsAuthenticodeCommandRunner;
} {
  const commands: string[] = [];
  let index = 0;
  return {
    commands,
    run: (command): ReturnType<WindowsAuthenticodeCommandRunner> => {
      commands.push(command);
      return {
        status: 0,
        stderr: "",
        stdout: identities[index++] ?? "",
      };
    },
  };
}

describe("Windows portable Authenticode identity", (): void => {
  it("keeps PowerShell boolean operators separated across script fragments", (): void => {
    const script = windowsAuthenticodeIdentityScript();

    expect(script).toContain("$s.SignerCertificate -or $null");
    expect(script).not.toContain("$s.SignerCertificate-or");
  });

  it("uses the fixed system verifier and accepts only the trusted launcher's signer", (): void => {
    const signer = "A".repeat(40);
    const matching = signerRunner(signer, signer);

    expect(
      windowsPublisherIdentityMatches("Keiko.exe", "helper.exe", matching.run, SYSTEM_OPTIONS),
    ).toBe(true);
    const expectedCommand = resolveWindowsAuthenticodeSystem(SYSTEM_OPTIONS).command;
    expect(matching.commands).toEqual([expectedCommand, expectedCommand]);

    const mismatching = signerRunner(signer, "B".repeat(40));
    expect(
      windowsPublisherIdentityMatches("Keiko.exe", "helper.exe", mismatching.run, SYSTEM_OPTIONS),
    ).toBe(false);
  });

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])("rejects invalid signer output %#", (result): void => {
    expect(
      windowsSignerIdentity(
        "helper.exe",
        (): ReturnType<WindowsAuthenticodeCommandRunner> => result,
        SYSTEM_OPTIONS,
      ),
    ).toBeUndefined();
  });

  it("supports the same signer binding through a nonblocking command port", async (): Promise<void> => {
    const signer = "A".repeat(40);
    const results = [signer, signer];
    let index = 0;

    await expect(
      windowsPublisherIdentityMatchesAsync(
        "Keiko.exe",
        "helper.exe",
        (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> =>
          Promise.resolve({
            status: 0,
            stderr: "",
            stdout: results[index++] ?? "",
          }),
        SYSTEM_OPTIONS,
      ),
    ).resolves.toBe(true);
  });

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])(
    "rejects invalid signer output through the nonblocking command port %#",
    async (result): Promise<void> => {
      await expect(
        windowsPublisherIdentityMatchesAsync(
          "Keiko.exe",
          "helper.exe",
          (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> => Promise.resolve(result),
          SYSTEM_OPTIONS,
        ),
      ).resolves.toBe(false);
    },
  );

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "" },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])(
    "rejects invalid helper output through the nonblocking command port %#",
    async (result): Promise<void> => {
      const results = [{ status: 0, stderr: "", stdout: "A".repeat(40) }, result];
      let index = 0;

      await expect(
        windowsPublisherIdentityMatchesAsync(
          "Keiko.exe",
          "helper.exe",
          (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> =>
            Promise.resolve(results[index++] ?? result),
          SYSTEM_OPTIONS,
        ),
      ).resolves.toBe(false);
    },
  );

  it("rejects a nonblocking helper signed by a different publisher", async (): Promise<void> => {
    const results = ["A".repeat(40), "B".repeat(40)];
    let index = 0;

    await expect(
      windowsPublisherIdentityMatchesAsync(
        "Keiko.exe",
        "helper.exe",
        (): Promise<ReturnType<WindowsAuthenticodeCommandRunner>> =>
          Promise.resolve({
            status: 0,
            stderr: "",
            stdout: results[index++] ?? "",
          }),
        SYSTEM_OPTIONS,
      ),
    ).resolves.toBe(false);
  });

  it("loads lazily and emits body-free evidence when the system root is refused", (): void => {
    const events: SecurityLogEvent[] = [];
    const hostileRoot = String.raw`D:\workspace\planted-windows`;

    expect(() =>
      resolveWindowsAuthenticodeSystem({
        env: { SystemRoot: hostileRoot },
        identityCheck: () => false,
        securityLogSink: {
          write: (event): void => {
            events.push(event);
          },
        },
      }),
    ).toThrow(WindowsSystemDirectoryError);
    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        correlationId: "unknown-correlation-id",
        errorKind: "WindowsSystemDirectoryError",
        level: "warn",
        op: "portable.windows-authenticode.system-binary-refused",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(hostileRoot);
  });
});
