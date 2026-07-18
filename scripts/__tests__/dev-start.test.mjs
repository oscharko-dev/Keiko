import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { npmCommand, resolveExternalOpener, run, shouldShellNpmCommand } from "../dev-start.mjs";

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

  // #2478 (Qodo #2514 finding 1): a percent-encoded pairing fragment must never pass through
  // cmd.exe, whose %...% expansion corrupts the URL and leaves the opened window unpaired.
  it("opens Windows URLs through an encoded PowerShell command, never cmd start", () => {
    const url = "http://localhost:1983/#keiko-app-session=%7B%22requestId%22%3A%22r%22%7D";
    const win = resolveExternalOpener(url, "win32");
    expect(win.command).toBe("powershell.exe");
    expect(win.args).not.toContain(url);
    const encoded = win.args.at(-1) ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(`Start-Process '${url}'`);
    expect(resolveExternalOpener(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(resolveExternalOpener(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
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
