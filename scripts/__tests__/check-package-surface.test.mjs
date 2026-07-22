import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NPM_PACK_STDIO_MAX_BUFFER,
  npmCommand,
  packFiles,
  shouldShellNpmCommand,
} from "../package-surface-pack.mjs";

function validPackJson(extra = {}) {
  return JSON.stringify([
    {
      files: [{ path: "dist/index.js", size: 1, mode: 0o644 }],
      ...extra,
    },
  ]);
}

function capturedError(run) {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected function to throw");
}

describe("package-surface npm pack capture", () => {
  it("captures and parses npm-pack output with the explicit bounded buffer", () => {
    let observed;

    const files = packFiles({
      spawnSyncImpl: (command, args, options) => {
        observed = { command, args, options };
        return {
          status: 0,
          stdout: validPackJson({ padding: "x".repeat(1024 * 1024 + 32) }),
          stderr: "",
        };
      },
      platform: "linux",
      processEnv: {
        PATH: "/bin",
        npm_command: "run-script",
        npm_lifecycle_event: "check:package-surface",
        npm_lifecycle_script: "node scripts/check-package-surface.mjs",
        npm_package_json: "/repo/package.json",
      },
      resolveHostExecutableImpl: () => "/usr/bin/npm",
    });

    expect(files).toEqual([{ path: "dist/index.js", size: 1, mode: 0o644 }]);
    expect(observed).toMatchObject({
      command: "/usr/bin/npm",
      args: ["pack", "--dry-run", "--json", "--ignore-scripts"],
      options: {
        maxBuffer: NPM_PACK_STDIO_MAX_BUFFER,
        shell: false,
      },
    });
    expect(observed.options.env).toEqual({ PATH: "/bin" });
  });

  it("preserves the trusted Windows npm shell launch path", () => {
    let observed;

    packFiles({
      spawnSyncImpl: (command, args, options) => {
        observed = { command, args, options };
        return { status: 0, stdout: validPackJson(), stderr: "" };
      },
      platform: "win32",
      resolveHostExecutableImpl: () => "C:\\Program Files\\nodejs\\npm.cmd",
    });

    expect(
      npmCommand({
        platform: "win32",
        resolveHostExecutableImpl: () => "C:\\Program Files\\nodejs\\npm.cmd",
      }),
    ).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(shouldShellNpmCommand("win32")).toBe(true);
    expect(observed.command).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(observed.options.shell).toBe(true);
  });

  it("reports overflow, invalid JSON, spawn errors, and nonzero exits safely", () => {
    const overflow = new Error("spawnSync npm ENOBUFS");
    overflow.code = "ENOBUFS";
    const sensitiveOutput = "fixture-sensitive-package-output";

    expect(() =>
      packFiles({
        spawnSyncImpl: () => ({ status: null, stdout: "", stderr: "", error: overflow }),
        resolveHostExecutableImpl: () => "/usr/bin/npm",
      }),
    ).toThrow(/output exceeded the bounded 8 MiB capture buffer/);

    const spawnError = new Error("fixture-sensitive-spawn-message");
    spawnError.code = "EACCES";
    expect(() =>
      packFiles({
        spawnSyncImpl: () => ({
          status: null,
          stdout: "",
          stderr: "",
          error: spawnError,
        }),
        resolveHostExecutableImpl: () => "/usr/bin/npm",
      }),
    ).toThrow(/could not spawn \(code: EACCES\)/);

    const invalidJsonError = capturedError(() =>
      packFiles({
        spawnSyncImpl: () => ({ status: 0, stdout: sensitiveOutput, stderr: "" }),
        resolveHostExecutableImpl: () => "/usr/bin/npm",
      }),
    );
    expect(invalidJsonError.message).toBe(
      `npm pack --dry-run emitted invalid JSON (stdout bytes: ${sensitiveOutput.length})`,
    );
    expect(invalidJsonError.message).not.toContain(sensitiveOutput);

    const exitError = capturedError(() =>
      packFiles({
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: sensitiveOutput }),
        resolveHostExecutableImpl: () => "/usr/bin/npm",
      }),
    );
    expect(exitError.message).toBe(
      `npm pack --dry-run failed (exit 1; stdout bytes: 0; stderr bytes: ${sensitiveOutput.length})`,
    );
    expect(exitError.message).not.toContain(sensitiveOutput);
  });

  it("reports signal termination without exposing subprocess output", () => {
    const sensitiveOutput = "fixture-sensitive-signal-output";
    const signalError = capturedError(() =>
      packFiles({
        spawnSyncImpl: () => ({
          status: null,
          signal: "SIGTERM",
          stdout: sensitiveOutput,
          stderr: sensitiveOutput,
        }),
        resolveHostExecutableImpl: () => "/usr/bin/npm",
      }),
    );

    expect(signalError.message).toBe(
      `npm pack --dry-run failed (signal SIGTERM; stdout bytes: ${sensitiveOutput.length}; stderr bytes: ${sensitiveOutput.length})`,
    );
    expect(signalError.message).not.toContain(sensitiveOutput);
  });
});

describe("assembled package-surface command", () => {
  it("assembles and prunes the artifact before the fail-closed checker", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const script = packageJson.scripts["check:package-surface:assembled"];
    const orderedCommands = [
      "npm run build",
      "npm run prepare:bin",
      "npm run build:ui",
      "npm run prune:package-build-artifacts",
      "npm run prune:package-native-optionals",
      "npm run check:package-surface",
    ];

    expect(typeof script).toBe("string");
    let previous = -1;
    for (const command of orderedCommands) {
      const position = script.indexOf(command);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
  });
});
