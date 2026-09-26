import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertContainedRegularFile,
  checkWindowsPortableAuthenticodeLoader,
  resolveTrustedLoaderContext,
} from "../check-windows-portable-authenticode-loader.mjs";

const RUNTIME = "packages/keiko-server/dist/coding-runtime/windowsPortableAuthenticode.js";
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Windows Authenticode restricted-token loader check", () => {
  it("accepts only the named regular helper inside its approved temporary root", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-loader-path-test-"));
    roots.push(root);
    const nested = join(root, "native-quality", "restricted-loader.exe");
    mkdirSync(join(nested, ".."), { recursive: true });
    writeFileSync(nested, "helper");

    expect(assertContainedRegularFile(nested, root, "restricted-loader.exe", "helper")).toBe(
      realpathSync(nested),
    );
    expect(() =>
      assertContainedRegularFile(
        join(root, "..", "restricted-loader.exe"),
        root,
        "restricted-loader.exe",
        "helper",
      ),
    ).toThrow(/approved absolute executable path/u);
  });

  it("derives the restricted helper from the runner-owned temporary directory", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-loader-context-test-"));
    roots.push(root);
    const runnerTemp = join(root, "runner-temp");
    const systemRoot = join(root, "Windows");
    const helperPath = join(runnerTemp, "windows-portable-authenticode-standard-token-loader.exe");
    const powershellPath = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    mkdirSync(join(powershellPath, ".."), { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    writeFileSync(helperPath, "helper");
    writeFileSync(powershellPath, "powershell");

    expect(
      resolveTrustedLoaderContext({ RUNNER_TEMP: runnerTemp, SystemRoot: systemRoot }),
    ).toEqual(
      expect.objectContaining({
        helperPath: realpathSync(helperPath),
        powershellPath: realpathSync(powershellPath),
      }),
    );
  });

  it("passes the exact asset and requires both corrupt inputs to be denied", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
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

    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      encoding: "utf8",
      maxBuffer: 16_384,
      timeout: 40_000,
      windowsHide: true,
    });
    expect(run.mock.calls[0]?.[2].input).toBe("keiko-authenticode-stdin-v1");
    expect(run.mock.calls[1]?.[2].input).not.toBe(run.mock.calls[0]?.[2].input);
    expect(run.mock.calls[1]?.[2].input).not.toBe(run.mock.calls[2]?.[2].input);
    expect(run.mock.calls[1]?.[2].input).not.toBe(run.mock.calls[3]?.[2].input);
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
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["the child cannot start", { error: new Error("spawn failed"), status: null, stdout: "" }],
    ["the child writes unexpected output", { status: 0, stderr: "", stdout: "unexpected" }],
  ])(
    "fails before invoking the verifier loader probe when transport is unsafe: %s",
    async (_label, result) => {
      const run = vi.fn().mockReturnValue(result);

      await expect(
        checkWindowsPortableAuthenticodeLoader({
          helperPath: "restricted-loader.exe",
          powershellPath: "powershell.exe",
          run,
          serverRuntimePath: RUNTIME,
          systemRoot: String.raw`C:\Windows`,
        }),
      ).rejects.toThrow(/restricted stdin probe failed/u);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["the child cannot start", { error: new Error("spawn failed"), status: null, stdout: "" }],
    ["the child writes unexpected output", { status: 0, stderr: "", stdout: "unexpected" }],
  ])("fails when the valid loader probe is unsafe because %s", async (_label, result) => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "" })
      .mockReturnValueOnce(result);

    await expect(
      checkWindowsPortableAuthenticodeLoader({
        helperPath: "restricted-loader.exe",
        powershellPath: "powershell.exe",
        run,
        serverRuntimePath: RUNTIME,
        systemRoot: String.raw`C:\Windows`,
      }),
    ).rejects.toThrow(/restricted verifier loader failed/u);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails when a corrupt-input child cannot start", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "" })
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
    expect(run).toHaveBeenCalledTimes(3);
  });
});
