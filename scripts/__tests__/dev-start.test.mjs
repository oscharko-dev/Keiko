import { afterEach, describe, expect, it, vi } from "vitest";

import { npmCommand, run, shouldShellNpmCommand } from "../dev-start.mjs";

describe("dev-start npm process wrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the native npm command shim on Windows", () => {
    expect(npmCommand("win32")).toBe("npm.cmd");
    expect(npmCommand("darwin")).toBe("npm");
    expect(npmCommand("linux")).toBe("npm");
  });

  it("routes only Windows npm shims through a shell", () => {
    expect(shouldShellNpmCommand("npm.cmd", "win32")).toBe(true);
    expect(shouldShellNpmCommand("npm", "win32")).toBe(true);
    expect(shouldShellNpmCommand("node", "win32")).toBe(false);
    expect(shouldShellNpmCommand("npm", "linux")).toBe(false);
    expect(shouldShellNpmCommand("npm.cmd", "linux")).toBe(false);
  });

  it("spawns Windows npm.cmd with shell=true and disables npm audit/fund prompts", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let observed;

    run("npm.cmd", ["ci", "--no-audit", "--no-fund"], "C:\\repo", {
      platform: "win32",
      spawnSyncImpl: (command, args, options) => {
        observed = { command, args, options };
        return { status: 0, signal: null };
      },
    });

    expect(observed).toMatchObject({
      command: "npm.cmd",
      args: ["ci", "--no-audit", "--no-fund"],
      options: {
        cwd: "C:\\repo",
        shell: true,
        stdio: "inherit",
      },
    });
    expect(observed.options.env).toMatchObject({
      npm_config_audit: "false",
      npm_config_fund: "false",
    });
  });

  it("reports spawn errors instead of collapsing them to failed (null)", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() =>
      run("npm.cmd", ["ci"], "C:\\repo", {
        platform: "win32",
        spawnSyncImpl: () => ({
          status: null,
          signal: null,
          error: new Error("spawn EINVAL"),
        }),
      }),
    ).toThrow("npm.cmd ci could not spawn: spawn EINVAL");
  });

  it("reports unknown status without rendering null", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() =>
      run("npm.cmd", ["ci"], "C:\\repo", {
        platform: "win32",
        spawnSyncImpl: () => ({ status: null, signal: null }),
      }),
    ).toThrow("npm.cmd ci failed (unknown)");
  });
});
