import { describe, expect, it } from "vitest";

import {
  WINDOWS_SYSTEM_POWERSHELL,
  windowsPublisherIdentityMatches,
  windowsPublisherIdentityMatchesAsync,
  windowsSignerIdentity,
  type WindowsAuthenticodeCommandRunner,
} from "./windowsPortableAuthenticode.js";

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

describe("Windows portable Authenticode identity", () => {
  it("uses the fixed system verifier and accepts only the trusted launcher's signer", () => {
    const signer = "A".repeat(40);
    const matching = signerRunner(signer, signer);

    expect(windowsPublisherIdentityMatches("Keiko.exe", "helper.exe", matching.run)).toBe(true);
    expect(matching.commands).toEqual([WINDOWS_SYSTEM_POWERSHELL, WINDOWS_SYSTEM_POWERSHELL]);

    const mismatching = signerRunner(signer, "B".repeat(40));
    expect(windowsPublisherIdentityMatches("Keiko.exe", "helper.exe", mismatching.run)).toBe(false);
  });

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])("rejects invalid signer output %#", (result) => {
    expect(windowsSignerIdentity("helper.exe", () => result)).toBeUndefined();
  });

  it("supports the same signer binding through a nonblocking command port", async () => {
    const signer = "A".repeat(40);
    const results = [signer, signer];
    let index = 0;

    await expect(
      windowsPublisherIdentityMatchesAsync("Keiko.exe", "helper.exe", () =>
        Promise.resolve({
          status: 0,
          stderr: "",
          stdout: results[index++] ?? "",
        }),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    { status: 1, stderr: "", stdout: "A".repeat(40) },
    { status: 0, stderr: "failure", stdout: "A".repeat(40) },
    { status: 0, stderr: "", stdout: "not-a-thumbprint" },
  ])("rejects invalid signer output through the nonblocking command port %#", async (result) => {
    await expect(
      windowsPublisherIdentityMatchesAsync("Keiko.exe", "helper.exe", () =>
        Promise.resolve(result),
      ),
    ).resolves.toBe(false);
  });

  it("rejects a nonblocking helper signed by a different publisher", async () => {
    const results = ["A".repeat(40), "B".repeat(40)];
    let index = 0;

    await expect(
      windowsPublisherIdentityMatchesAsync("Keiko.exe", "helper.exe", () =>
        Promise.resolve({
          status: 0,
          stderr: "",
          stdout: results[index++] ?? "",
        }),
      ),
    ).resolves.toBe(false);
  });
});
