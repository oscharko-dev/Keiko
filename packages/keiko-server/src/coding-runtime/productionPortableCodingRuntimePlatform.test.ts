import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readMacosAttestation,
  readWindowsAttestation,
  type PortableRuntimeCommandOptions,
  type PortableRuntimeCommandResult,
  type PortableRuntimeCommandRunner,
} from "./productionPortableCodingRuntime.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function commandResult(
  overrides: Partial<PortableRuntimeCommandResult> = {},
): PortableRuntimeCommandResult {
  return { status: 0, stderr: "", stdout: "", ...overrides };
}

function recordingRunner(...results: readonly PortableRuntimeCommandResult[]): {
  readonly calls: {
    readonly args: readonly string[];
    readonly command: string;
    readonly options: PortableRuntimeCommandOptions;
  }[];
  readonly run: PortableRuntimeCommandRunner;
} {
  const calls: {
    readonly args: readonly string[];
    readonly command: string;
    readonly options: PortableRuntimeCommandOptions;
  }[] = [];
  let index = 0;
  return {
    calls,
    run: (command, args, options): PortableRuntimeCommandResult => {
      calls.push({ args, command, options });
      return results[index++] ?? commandResult();
    },
  };
}

function windowsFixture(): string {
  const resourceRoot = mkdtempSync(join(tmpdir(), "keiko-windows-attestation-"));
  roots.push(resourceRoot);
  const nativeRoot = join(resourceRoot, "runtime", "native");
  mkdirSync(nativeRoot, { recursive: true });
  writeFileSync(join(resourceRoot, "Keiko.exe"), "signed launcher");
  writeFileSync(join(nativeRoot, "keiko-runtime-attestation.exe"), "signed attestation");
  return resourceRoot;
}

function macosFixture(receipt: unknown = { result: "passed" }): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-macos-attestation-"));
  roots.push(root);
  const resourceRoot = join(root, "Keiko.app", "Contents", "Resources");
  mkdirSync(join(resourceRoot, ".portable"), { recursive: true });
  mkdirSync(join(root, "Keiko.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(root, "Keiko.app", "Contents", "MacOS", "KeikoSystemExtensionManager"),
    "signed manager",
  );
  writeFileSync(
    join(resourceRoot, ".portable", "runtime-qualification.json"),
    JSON.stringify(receipt),
  );
  return resourceRoot;
}

describe("production portable runtime platform attestation", () => {
  it("accepts only a signed Windows carrier with a body-free exact receipt", () => {
    const resourceRoot = windowsFixture();
    vi.stubEnv("SystemRoot", String.raw`D:\Attacker`);
    const runner = recordingRunner(
      commandResult({ stdout: "A".repeat(40) }),
      commandResult({ stdout: "A".repeat(40) }),
      commandResult({ stdout: '{"result":"passed"}' }),
    );

    expect(readWindowsAttestation(resourceRoot, runner.run)).toEqual({ result: "passed" });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]?.command).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(runner.calls[0]?.args).toContain("-NoProfile");
    expect(runner.calls[0]?.args).toContain("-NonInteractive");
    expect(runner.calls[0]?.args.at(-1)).toBe(realpathSync(join(resourceRoot, "Keiko.exe")));
    expect(runner.calls[0]?.options).toMatchObject({ timeout: 10_000, windowsHide: true });
    expect(runner.calls[1]?.args.at(-1)).toBe(
      realpathSync(join(resourceRoot, "runtime", "native", "keiko-runtime-attestation.exe")),
    );
    expect(runner.calls[2]).toMatchObject({
      args: ["--emit"],
      options: { maxBuffer: 65_536, timeout: 10_000, windowsHide: true },
    });
  });

  it("fails closed for an invalid or differently signed Windows carrier", () => {
    const resourceRoot = windowsFixture();
    expect(() =>
      readWindowsAttestation(resourceRoot, recordingRunner(commandResult({ status: 1 })).run),
    ).toThrow("runtime-attestation-signature-invalid");
    expect(() =>
      readWindowsAttestation(
        resourceRoot,
        recordingRunner(
          commandResult({ stdout: "A".repeat(40) }),
          commandResult({ stdout: "B".repeat(40) }),
        ).run,
      ),
    ).toThrow("runtime-attestation-signature-invalid");
  });

  it("fails closed for unavailable Windows carrier output", () => {
    const resourceRoot = windowsFixture();
    for (const result of [
      commandResult({ status: 1 }),
      commandResult({ stderr: "redacted failure" }),
      commandResult({ stdout: "" }),
    ]) {
      const runner = recordingRunner(
        commandResult({ stdout: "A".repeat(40) }),
        commandResult({ stdout: "A".repeat(40) }),
        result,
      );
      expect(() => readWindowsAttestation(resourceRoot, runner.run)).toThrow(
        "runtime-attestation-unavailable",
      );
    }
  });

  it("rejects malformed Windows receipt JSON and exercises the fixed default runner", () => {
    const resourceRoot = windowsFixture();
    const runner = recordingRunner(
      commandResult({ stdout: "A".repeat(40) }),
      commandResult({ stdout: "A".repeat(40) }),
      commandResult({ stdout: "{" }),
    );

    expect(() => readWindowsAttestation(resourceRoot, runner.run)).toThrow(SyntaxError);
    expect(() => readWindowsAttestation(resourceRoot)).toThrow(
      "runtime-attestation-signature-invalid",
    );
  });

  it("verifies the sealed macOS app and active system extension before reading the receipt", () => {
    const resourceRoot = macosFixture({ result: "passed", backend: "endpoint-security" });
    const runner = recordingRunner(
      commandResult(),
      commandResult(),
      commandResult({ stdout: "active\n" }),
    );

    expect(readMacosAttestation(resourceRoot, runner.run)).toEqual({
      result: "passed",
      backend: "endpoint-security",
    });
    expect(runner.calls.map(({ command }) => command)).toEqual([
      "/usr/bin/codesign",
      "/usr/sbin/spctl",
      realpathSync(join(resourceRoot, "..", "MacOS", "KeikoSystemExtensionManager")),
    ]);
    expect(runner.calls[0]?.options.env).toEqual({ PATH: "/usr/bin:/usr/sbin" });
  });

  it("fails closed for an invalid app seal or inactive system extension", () => {
    const resourceRoot = macosFixture();
    expect(() =>
      readMacosAttestation(resourceRoot, recordingRunner(commandResult({ status: 1 })).run),
    ).toThrow("runtime-app-seal-invalid");

    for (const managerResult of [
      commandResult({ status: 1, stdout: "active" }),
      commandResult({ stdout: "inactive" }),
      commandResult({ stdout: "active", stderr: "redacted failure" }),
    ]) {
      const runner = recordingRunner(commandResult(), commandResult(), managerResult);
      expect(() => readMacosAttestation(resourceRoot, runner.run)).toThrow(
        "runtime-system-extension-inactive",
      );
    }
  });
});
