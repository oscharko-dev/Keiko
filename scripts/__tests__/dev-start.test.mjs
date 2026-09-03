import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { existsSync } from "node:fs";

import {
  codingRuntimeHealth,
  codingRuntimeRequired,
  DEV_START_LOCK_FILE,
  ensureDevCodingRuntime,
  healthyDevServer,
  maybeOpenPairedBrowser,
  npmCommand,
  pairedDevBrowserUrl,
  prepareRunnerCriticalSection,
  resolveDevPairingSecret,
  requiredRuntimeHealth,
  resolveDevGatewayConfigAction,
  resolveExternalOpener,
  run,
  shouldShellNpmCommand,
  withDevStartLock,
} from "../dev-start.mjs";

// KEIKO-0286: a stale KEIKO_CONFIG_FILE inherited from a sourced operator .env used to suppress the
// dev-config seed entirely. The server then started with zero providers and said nothing — the
// "no provisioned config" condition that blocked four prior live-test attempts.
describe("dev-start gateway config resolution (KEIKO-0286)", () => {
  const DEV_CONFIG = "/state/ui/keiko.config.json";
  const SEEDS = [
    "/repo/.keiko/ui/keiko.config.json",
    "/repo/keiko.config.json",
    "/repo/sandbox/.keiko/ui/keiko.config.json",
  ];
  const existsOnly =
    (...present) =>
    (path) =>
      present.includes(path);

  it("leaves a configured path alone when the file is really there", () => {
    const action = resolveDevGatewayConfigAction({
      configuredPath: "/operator/keiko.config.json",
      devConfigFile: DEV_CONFIG,
      seedCandidates: SEEDS,
      fileExists: existsOnly("/operator/keiko.config.json"),
    });
    expect(action).toEqual({ notices: [] });
  });

  it("seeds AND repoints when the configured path does not exist", () => {
    const action = resolveDevGatewayConfigAction({
      configuredPath: "/gone/keiko.config.json",
      devConfigFile: DEV_CONFIG,
      seedCandidates: SEEDS,
      fileExists: existsOnly(SEEDS[0]),
    });
    // Repointing is the half that makes the seed take effect: the development runner inherits this
    // environment, so seeding without repointing leaves the server reading the dead path.
    expect(action.repointTo).toBe(DEV_CONFIG);
    expect(action.seedFrom).toBe(SEEDS[0]);
    expect(action.notices.join("\n")).toContain("does not exist");
  });

  it("uses the repository root config as the fallback seed for local development", () => {
    const action = resolveDevGatewayConfigAction({
      configuredPath: undefined,
      devConfigFile: DEV_CONFIG,
      seedCandidates: SEEDS,
      fileExists: existsOnly(SEEDS[1]),
    });
    expect(action.seedFrom).toBe(SEEDS[1]);
    expect(action.notices.join("\n")).toContain(SEEDS[1]);
  });

  it("repoints without reseeding when a dev config already exists", () => {
    const action = resolveDevGatewayConfigAction({
      configuredPath: "/gone/keiko.config.json",
      devConfigFile: DEV_CONFIG,
      seedCandidates: SEEDS,
      fileExists: existsOnly(DEV_CONFIG),
    });
    expect(action.repointTo).toBe(DEV_CONFIG);
    expect(action.seedFrom).toBeUndefined();
  });

  it("says so out loud when nothing can be seeded, instead of degrading silently", () => {
    const action = resolveDevGatewayConfigAction({
      configuredPath: "/gone/keiko.config.json",
      devConfigFile: DEV_CONFIG,
      seedCandidates: SEEDS,
      fileExists: existsOnly(),
    });
    expect(action.seedFrom).toBeUndefined();
    expect(action.notices.join("\n")).toContain("start unprovisioned");
  });

  it("never puts config file contents in a notice, only paths", () => {
    const action = resolveDevGatewayConfigAction({
      configuredPath: "/gone/keiko.config.json",
      devConfigFile: DEV_CONFIG,
      seedCandidates: SEEDS,
      fileExists: existsOnly(SEEDS[0]),
    });
    for (const notice of action.notices) {
      expect(notice).not.toMatch(/apiKey|secret|token|cred:/iu);
    }
  });
});

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

    const health = await requiredRuntimeHealth("http://127.0.0.1:1", true);

    expect(health.startsWith("ok")).toBe(true);
    expect(health).not.toContain("runtime:");
  });

  it("reuses a running server whose healthy runtime status carries evidence detail", () => {
    expect(healthyDevServer("ok · local runtime integrity verified (no platform signature)")).toBe(
      true,
    );
    expect(healthyDevServer("runtime: unavailable (payload-missing)")).toBe(false);
  });

  it("skips the runtime gate entirely on a host with no dev lane", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await requiredRuntimeHealth("http://127.0.0.1:1", false)).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still fails an unavailable runtime", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        runtimeAvailable: false,
        runtimeUnavailableReason: "runtime-unqualified",
      }),
    });

    const health = await requiredRuntimeHealth("http://127.0.0.1:1", true);

    expect(health).toBe("runtime: unavailable (runtime-unqualified)");
  });
});

describe("dev-start coding runtime lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires coding-runtime readiness on every supported dev host", () => {
    expect(codingRuntimeRequired("darwin", "arm64")).toBe(true);
    expect(codingRuntimeRequired("darwin", "x64")).toBe(true);
    expect(codingRuntimeRequired("win32", "x64")).toBe(true);
    expect(codingRuntimeRequired("win32", "arm64")).toBe(false);
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
      expected: "ok · local runtime integrity verified (no platform signature)",
    },
    {
      response: {
        ok: true,
        json: () => Promise.resolve({ runtimeAvailable: true }),
      },
      expected: "ok · local runtime integrity verified (no platform signature)",
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

  it("refreshes native helpers for a verified runtime and stages a full repair when discovery refuses it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const activated = {
      outcome: "activated",
      runtime: { evidenceClass: "functional-not-platform-qualified" },
    };
    const discoverReady = vi.fn().mockResolvedValue(activated);
    const stageReady = vi.fn();
    const restageReady = vi.fn().mockResolvedValue(undefined);
    await expect(
      ensureDevCodingRuntime({
        platform: "darwin",
        arch: "arm64",
        env: {},
        discover: discoverReady,
        stage: stageReady,
        restageNative: restageReady,
      }),
    ).resolves.toBe(true);
    expect(stageReady).not.toHaveBeenCalled();
    expect(restageReady).toHaveBeenCalledOnce();
    expect(discoverReady).toHaveBeenCalledTimes(2);
    expect(discoverReady).toHaveBeenNthCalledWith(1, {
      env: { KEIKO_CODING_RUNTIME_DEV_LANE: "1" },
      platform: "darwin",
      arch: "arm64",
      admitRuntimeSupervisor: false,
    });
    expect(discoverReady).toHaveBeenLastCalledWith({
      env: { KEIKO_CODING_RUNTIME_DEV_LANE: "1" },
      platform: "darwin",
      arch: "arm64",
      admitRuntimeSupervisor: true,
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

    const discoverWindows = vi.fn().mockResolvedValue(activated);
    const restageWindows = vi.fn().mockResolvedValue(undefined);
    await expect(
      ensureDevCodingRuntime({
        platform: "win32",
        arch: "x64",
        env: {},
        discover: discoverWindows,
        stage: vi.fn(),
        restageNative: restageWindows,
      }),
    ).resolves.toBe(true);
    expect(restageWindows).toHaveBeenCalledOnce();
    expect(discoverWindows).toHaveBeenLastCalledWith({
      env: { KEIKO_CODING_RUNTIME_DEV_LANE: "1" },
      platform: "win32",
      arch: "x64",
      admitRuntimeSupervisor: true,
    });
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

  it("repairs an untrusted native helper directory through complete staging", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const activated = {
      outcome: "activated",
      runtime: { evidenceClass: "functional-not-platform-qualified" },
    };
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "refused", reason: "native-helper-directory-untrusted" })
      .mockResolvedValueOnce(activated);
    const stage = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureDevCodingRuntime({
        platform: "win32",
        arch: "x64",
        env: {},
        discover,
        stage,
      }),
    ).resolves.toBe(true);

    expect(stage).toHaveBeenCalledOnce();
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
      await import("../../packages/keiko-contracts/dist/coding-app-session.js");
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

// KEIKO-0542: the dev-config seed used to copy only the config file. A sibling `credentials/`
// directory next to a seed candidate (mirroring the credentialVault convention on-disk) was
// silently left behind, so a well-configured seed ended up as "not configured" in the running
// gateway with no diagnostic surfaced anywhere. Extend ensureDevGatewayConfig so a
// `credentials/` sibling is copied alongside the seed and the outcome is announced through the
// existing notice channel.
describe("dev-start gateway config credentials seed (KEIKO-0542)", () => {
  it("copies a sibling credentials/ directory when the seed has one", async () => {
    const { ensureDevGatewayConfig } = await import("../dev-start.mjs");
    // The seed candidates ensureDevGatewayConfig checks are hardcoded from module scope; the
    // fileExists seam names them for us. We approve one seed candidate (the first) and its
    // credentials/ sibling; every other path returns false (including the dev-config file, so
    // the seed path is entered).
    const copyCalls = [];
    const notices = [];
    let approvedSeed;
    const seams = {
      fileExists: (path) => {
        // Approve the first seed candidate (repoRoot/.keiko/ui/keiko.config.json) whose exact
        // form we cannot know here — approve the first ".keiko/ui/keiko.config.json" path.
        if (
          typeof path === "string" &&
          path.endsWith("/.keiko/ui/keiko.config.json") &&
          !path.includes("/ui/ui/")
        ) {
          approvedSeed = path;
          return true;
        }
        return false;
      },
      directoryExists: (path) =>
        approvedSeed !== undefined &&
        path === approvedSeed.replace(/keiko\.config\.json$/u, "credentials"),
      mkdir: vi.fn(),
      copyFile: (source, target) => copyCalls.push({ kind: "file", source, target }),
      copyDirectory: (source, target) => copyCalls.push({ kind: "directory", source, target }),
      chmod: vi.fn(),
      notify: (message) => notices.push(message),
      env: {},
    };
    ensureDevGatewayConfig(seams);
    expect(
      copyCalls.some((call) => call.kind === "directory" && /credentials$/u.test(call.target)),
    ).toBe(true);
    expect(notices.join("\n")).toMatch(/seeded credentials\/ from/u);
  });

  it("surfaces a distinct notice when the seed has no credentials/ directory", async () => {
    const { ensureDevGatewayConfig } = await import("../dev-start.mjs");
    const notices = [];
    const seams = {
      // Approve the first .keiko/ui/keiko.config.json seed candidate.
      fileExists: (path) =>
        typeof path === "string" &&
        path.endsWith("/.keiko/ui/keiko.config.json") &&
        !path.includes("/ui/ui/"),
      directoryExists: () => false,
      mkdir: vi.fn(),
      copyFile: vi.fn(),
      copyDirectory: () => {
        throw new Error("credentials/ must not be copied when it does not exist");
      },
      chmod: vi.fn(),
      notify: (message) => notices.push(message),
      env: {},
    };
    ensureDevGatewayConfig(seams);
    expect(notices.join("\n")).toMatch(/no credentials\/ subdirectory next to/u);
  });
});

// KEIKO-0719: `npm run dev:start` acquires a per-stateDir lockfile so two concurrent invocations
// serialise instead of colliding in `npm run build` and racing for the same ports. The lock file
// is an atomic O_EXCL|O_CREAT create at `$stateDir/dev-start.lock`. Regression: prove serialization
// by holding the lock in one call while a second call queues behind it.
describe("dev-start concurrency lock (KEIKO-0719)", () => {
  it("serialises two concurrent withDevStartLock calls in FIFO order", async () => {
    const order = [];
    const first = withDevStartLock(async () => {
      order.push("A-start");
      await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 50));
      order.push("A-end");
    });
    // Give A a tick to acquire the lock and start work.
    await new Promise((resolveTick) => globalThis.setImmediate(resolveTick));
    const second = withDevStartLock(async () => {
      order.push("B-start");
      order.push("B-end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
    // Lock file removed after both settle.
    expect(existsSync(DEV_START_LOCK_FILE)).toBe(false);
  });

  it("releases the lock even when the wrapped work throws", async () => {
    await expect(
      withDevStartLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(DEV_START_LOCK_FILE)).toBe(false);
    // A subsequent call must succeed (proves the lock file was released).
    const marker = { ran: false };
    await withDevStartLock(async () => {
      marker.ran = true;
    });
    expect(marker.ran).toBe(true);
  });
});

// KEIKO-0719 (extended): the two-step "stop any prior runner, then clear pidFile" sequence used
// to live outside the dev-start lock; two concurrent `dev:start` invocations could both clear
// the check and then race to overwrite pidFile. The extracted `prepareRunnerCriticalSection`
// helper runs inside `withDevStartLock` so the sequence executes only once per acquirer.
describe("prepareRunnerCriticalSection (KEIKO-0719 race close)", () => {
  it("runs restartExistingRunnerIfNeeded before removing the pid file", async () => {
    const order = [];
    await prepareRunnerCriticalSection({
      restartExistingRunnerIfNeeded: async () => order.push("restart"),
      removePidFile: () => order.push("remove"),
    });
    expect(order).toEqual(["restart", "remove"]);
  });

  it("propagates a restart failure without removing the pid file", async () => {
    const removePidFile = vi.fn();
    await expect(
      prepareRunnerCriticalSection({
        restartExistingRunnerIfNeeded: async () => {
          throw new Error("restart failed");
        },
        removePidFile,
      }),
    ).rejects.toThrow(/restart failed/);
    expect(removePidFile).not.toHaveBeenCalled();
  });

  it("falls through to the default seams when none are provided", async () => {
    // On a fresh checkout the pidFile does not exist, so the default `restartExistingRunnerIfNeeded`
    // returns immediately and the default `removePidFile` is a no-op force-remove. This exercise
    // covers the nullish-coalescing default paths and asserts the helper accepts an empty seams
    // object (or none at all) without throwing.
    await expect(prepareRunnerCriticalSection({})).resolves.toBeUndefined();
    await expect(prepareRunnerCriticalSection()).resolves.toBeUndefined();
  });
});
