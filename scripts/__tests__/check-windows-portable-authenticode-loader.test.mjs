import { describe, expect, it, vi } from "vitest";

import { checkWindowsPortableAuthenticodeLoader } from "../check-windows-portable-authenticode-loader.mjs";

const RUNTIME = "packages/keiko-server/dist/coding-runtime/windowsPortableAuthenticode.js";

describe("Windows Authenticode restricted-token loader check", () => {
  it("passes the exact asset and requires both corrupt inputs to be denied", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });

    await checkWindowsPortableAuthenticodeLoader({
      helperPath: "restricted-loader.exe",
      powershellPath: "powershell.exe",
      run,
      serverRuntimePath: RUNTIME,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      encoding: "utf8",
      maxBuffer: 16_384,
      timeout: 40_000,
      windowsHide: true,
    });
    expect(run.mock.calls[0]?.[2].input).not.toBe(run.mock.calls[1]?.[2].input);
    expect(run.mock.calls[0]?.[2].input).not.toBe(run.mock.calls[2]?.[2].input);
  });

  it("fails when corrupt input is accepted", async () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    await expect(
      checkWindowsPortableAuthenticodeLoader({
        helperPath: "restricted-loader.exe",
        powershellPath: "powershell.exe",
        run,
        serverRuntimePath: RUNTIME,
        systemRoot: String.raw`C:\Windows`,
      }),
    ).rejects.toThrow("accepted corrupt assembly input");
  });

  it.each([
    ["the child cannot start", { error: new Error("spawn failed"), status: null, stdout: "" }],
    ["the child writes unexpected output", { status: 0, stderr: "", stdout: "unexpected" }],
  ])("fails when the valid loader probe is unsafe because %s", async (_label, result) => {
    const run = vi.fn().mockReturnValue(result);

    await expect(
      checkWindowsPortableAuthenticodeLoader({
        helperPath: "restricted-loader.exe",
        powershellPath: "powershell.exe",
        run,
        serverRuntimePath: RUNTIME,
        systemRoot: String.raw`C:\Windows`,
      }),
    ).rejects.toThrow(/restricted verifier loader failed/u);
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails when a corrupt-input child cannot start", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "" })
      .mockReturnValueOnce({ error: new Error("spawn failed"), status: null, stdout: "" });

    await expect(
      checkWindowsPortableAuthenticodeLoader({
        helperPath: "restricted-loader.exe",
        powershellPath: "powershell.exe",
        run,
        serverRuntimePath: RUNTIME,
        systemRoot: String.raw`C:\Windows`,
      }),
    ).rejects.toThrow("accepted corrupt assembly input");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
