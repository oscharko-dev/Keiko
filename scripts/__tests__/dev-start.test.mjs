import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  codingRuntimeHealth,
  codingRuntimeRequired,
  ensureDevCodingRuntime,
  maybeOpenPairedBrowser,
  npmCommand,
  pairedDevBrowserUrl,
  resolveDevPairingSecret,
  requiredRuntimeHealth,
  resolveExternalOpener,
  run,
  shouldShellNpmCommand,
} from "../dev-start.mjs";

describe("dev-start runtime health gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The gate, not the display string. codingRuntimeHealth reports an available-but-unverified
  // runtime as "ok" followed by its honest evidence detail (ADR-0163 D9); a gate that compared
  // against the bare literal turned every macOS dev:start into a 60s timeout against a healthy
  // server, and the pin on codingRuntimeHealth alone could not fail on it.
  it("passes an available runtime whose evidence class is weaker than platform-qualified", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        runtimeAvailable: true,
        runtimeEvidenceClass: "functional-not-platform-qualified",
      }),
    });

    const health = await requiredRuntimeHealth("http://127.0.0.1:1");

    expect(health.startsWith("ok")).toBe(true);
    expect(health).not.toContain("runtime:");
  });

  it("still fails an unavailable runtime", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        runtimeAvailable: false,
        runtimeUnavailableReason: "runtime-unqualified",
      }),
    });

    const health = await requiredRuntimeHealth("http://127.0.0.1:1");

    expect(health).toBe("runtime: unavailable (runtime-unqualified)");
  });
});

describe("dev-start coding runtime lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires coding-runtime readiness on supported macOS hosts only", () => {
    expect(codingRuntimeRequired("darwin", "arm64")).toBe(true);
    expect(codingRuntimeRequired("darwin", "x64")).toBe(true);
    expect(codingRuntimeRequired("darwin", "ppc64")).toBe(false);
    expect(codingRuntimeRequired("linux", "x64")).toBe(false);
  });

  it("reports the server-owned runtime reason instead of accepting a partial start", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          runtimeAvailable: false,
          runtimeUnavailableReason: "secure-read-unavailable",
        }),
    });

    await expect(codingRuntimeHealth("http://localhost:1983", fetchFn)).resolves.toBe(
      "unavailable (secure-read-unavailable)",
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:1983/api/coding-workbench/runtime/readiness?requestedMode=governed-assist",
      { cache: "no-store" },
    );
  });

  it.each([
    {
      response: { ok: false, status: 503 },
      expected: "HTTP 503",
    },
    // ADR-0163 D9: a bare "ok" is reserved for a platform-qualified runtime. An available runtime
    // whose evidence class is weak — or absent, which fails closed to weak — says so.
    {
      response: {
        ok: true,
        json: () =>
          Promise.resolve({
            runtimeAvailable: true,
            runtimeEvidenceClass: "platform-qualified",
          }),
      },
      expected: "ok",
    },
    {
      response: {
        ok: true,
        json: () =>
          Promise.resolve({
            runtimeAvailable: true,
            runtimeEvidenceClass: "functional-not-platform-qualified",
          }),
      },
      expected: "ok · unverified evaluation runtime (no platform signature)",
    },
    {
      response: {
        ok: true,
        json: () => Promise.resolve({ runtimeAvailable: true }),
      },
      expected: "ok · unverified evaluation runtime (no platform signature)",
    },
    {
      response: {
        ok: true,
        json: () => Promise.resolve({ runtimeAvailable: false }),
      },
      expected: "unavailable (invalid-readiness)",
    },
  ])("classifies coding-runtime health as $expected", async ({ response, expected }) => {
    await expect(
      codingRuntimeHealth("http://localhost:1983", vi.fn().mockResolvedValue(response)),
    ).resolves.toBe(expected);
  });

  it("skips runtime staging on unsupported hosts", async () => {
    const discover = vi.fn();
    const stage = vi.fn();

    await expect(
      ensureDevCodingRuntime({
        platform: "linux",
        arch: "x64",
        discover,
        stage,
      }),
    ).resolves.toBe(false);
    expect(discover).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it("reuses a verified runtime and stages a repair only when production discovery refuses it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const activated = {
      outcome: "activated",
      runtime: { evidenceClass: "functional-not-platform-qualified" },
    };
    const discoverReady = vi.fn().mockResolvedValue(activated);
    const stageReady = vi.fn();
    await expect(
      ensureDevCodingRuntime({
        platform: "darwin",
        arch: "arm64",
        env: {},
        discover: discoverReady,
        stage: stageReady,
      }),
    ).resolves.toBe(true);
    expect(stageReady).not.toHaveBeenCalled();
    expect(discoverReady).toHaveBeenCalledWith({
      env: { KEIKO_CODING_RUNTIME_DEV_LANE: "1" },
      platform: "darwin",
      arch: "arm64",
    });

    const discoverRepair = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "refused", reason: "payload-missing" })
      .mockResolvedValueOnce(activated);
    const stageRepair = vi.fn().mockResolvedValue(undefined);
    await expect(
      ensureDevCodingRuntime({
        platform: "darwin",
        arch: "arm64",
        env: {},
        discover: discoverRepair,
        stage: stageRepair,
      }),
    ).resolves.toBe(true);
    expect(stageRepair).toHaveBeenCalledOnce();
    expect(discoverRepair).toHaveBeenCalledTimes(2);
  });

  it("fails closed when staging cannot produce an activated runtime", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "refused", reason: "payload-tampered" })
      .mockResolvedValueOnce({ outcome: "refused", reason: "payload-tampered" });

    await expect(
      ensureDevCodingRuntime({
        platform: "darwin",
        arch: "arm64",
        env: {},
        discover,
        stage: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("coding runtime did not activate after staging (payload-tampered)");
  });

  it("fails closed when discovery refuses a non-stageable runtime state", async () => {
    await expect(
      ensureDevCodingRuntime({
        platform: "darwin",
        arch: "arm64",
        env: {},
        discover: vi.fn().mockResolvedValue({
          outcome: "refused",
          reason: "unsupported-platform",
        }),
        stage: vi.fn(),
      }),
    ).rejects.toThrow("coding runtime dev lane refused (unsupported-platform)");
  });
});

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
