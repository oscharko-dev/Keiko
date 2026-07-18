import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  maybeOpenPairedBrowser,
  npmCommand,
  pairedDevBrowserUrl,
  resolveDevPairingSecret,
  resolveExternalOpener,
  run,
  shouldShellNpmCommand,
} from "../dev-start.mjs";

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

// #2478: dev:start is the trusted launcher of the dev BFF (ADR-0141 W1.5 F3).
describe("dev-start app-session pairing launcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors an operator-provisioned launcher secret and mints a fresh one otherwise", () => {
    const provided = "p".repeat(40);
    expect(resolveDevPairingSecret({ KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: provided })).toBe(
      provided,
    );
    const minted = resolveDevPairingSecret({});
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveDevPairingSecret({ KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: "short" })).not.toBe(
      "short",
    );
  });

  it("builds a paired boot URL whose fragment claim verifies against the same secret", async () => {
    const secret = "s".repeat(40);
    const url = await pairedDevBrowserUrl(secret, "http://localhost:1983");
    expect(url.startsWith("http://localhost:1983/#keiko-app-session=")).toBe(true);
    const { decodeCodingAppSessionPairingFragment } =
      await import("../../packages/keiko-contracts/dist/index.js");
    const { computeLauncherPairingClaim } =
      await import("../../packages/keiko-server/dist/index.js");
    const attestation = decodeCodingAppSessionPairingFragment(
      url.slice("http://localhost:1983/".length),
    );
    expect(attestation).toBeDefined();
    expect(attestation.claim).toBe(
      computeLauncherPairingClaim(secret, attestation.requestId, attestation.issuedAtMs),
    );
  });

  it("opens the paired URL only when requested and fails closed on build errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const open = vi.fn();

    await maybeOpenPairedBrowser("secret", { requested: false, open });
    expect(open).not.toHaveBeenCalled();

    await maybeOpenPairedBrowser("secret", {
      requested: true,
      open,
      buildUrl: () => Promise.resolve("http://localhost:1983/#keiko-app-session=x"),
    });
    expect(open).toHaveBeenCalledWith("http://localhost:1983/#keiko-app-session=x");
    expect(log).toHaveBeenCalled();

    await maybeOpenPairedBrowser("secret", {
      requested: true,
      open,
      buildUrl: () => Promise.reject(new Error("dist missing")),
    });
    expect(error).toHaveBeenCalledWith(
      "[dev:start] could not open a paired browser window: dist missing",
    );
  });
});
