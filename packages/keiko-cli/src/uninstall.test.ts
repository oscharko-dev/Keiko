import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  gatewayServiceUninstallNotice,
  runUninstallCli,
  type UninstallCliDeps,
} from "./uninstall.js";
import { runLauncherCli } from "./launcher.js";
import { runPortableCli } from "./portable.js";
import { KEIKO_START_SCRIPT, KEIKO_STOP_SCRIPT } from "./init.js";
import { ATLASSIAN_CREDENTIAL_ARTIFACTS, defaultUiDataDir } from "./state-paths.js";
import { makeCapturedIo } from "./test-support/cli-io.js";
import { writePortableRuntimePayload } from "./test-support/portable-runtime-payload.js";
import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
} from "./install-layout.js";

// #2906 round 3 (comment 3865329066): reuses the shared fixture instead of a byte-identical
// local copy (aliased, not just re-exported, so every existing makeIo() call site keeps
// working unchanged).
const makeIo = makeCapturedIo;

function extraOf(event: SecurityLogEvent | undefined): Readonly<Record<string, unknown>> {
  return event?.extra ?? {};
}

const tempRoots: string[] = [];
const NOW = new Date("2026-07-06T00:00:00.000Z");
const REAL_TMPDIR = realpathSync(tmpdir());

function makeRoot(): string {
  const root = mkdtempSync(join(REAL_TMPDIR, "keiko-uninstall-"));
  tempRoots.push(root);
  return root;
}

function pathInsideRepository(path: string): boolean {
  let cursor = path;
  for (;;) {
    if (existsSync(join(cursor, ".git"))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function makePolicyAllowedRoot(prefix: string): string {
  const cwdParent = dirname(process.cwd());
  const parent =
    cwdParent.startsWith(REAL_TMPDIR) || pathInsideRepository(cwdParent) ? homedir() : cwdParent;
  const root = mkdtempSync(join(parent, `.keiko-${prefix}-`));
  tempRoots.push(root);
  return root;
}

function makePortableHome(): string {
  return makePolicyAllowedRoot("portable-home");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const STOP_LAUNCH_ID = "ab".repeat(16);

function seedState(root: string, pid = "2147483646"): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ui.pid"), `${pid}\n${STOP_LAUNCH_ID}\n`, "utf8");
  writeFileSync(join(stateDir, "ui.log"), "log line\n", "utf8");
  return stateDir;
}

function verifiedStopIdentity(): {
  readonly verifyLaunchIdentity: (pid: number, launchId: string) => boolean;
} {
  return { verifyLaunchIdentity: () => true };
}

function seedPackageJson(root: string, extra: Record<string, string> = {}): string {
  const path = join(root, "package.json");
  const scripts = { "keiko:start": KEIKO_START_SCRIPT, "keiko:stop": KEIKO_STOP_SCRIPT, ...extra };
  writeFileSync(path, `${JSON.stringify({ name: "demo", scripts }, null, 2)}\n`, "utf8");
  return path;
}

function readScripts(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

function installLauncher(root: string): { stateDir: string; shortcut: string } {
  const stateDir = join(root, ".keiko");
  const deps = {
    cwd: root,
    homedir: (): string => root,
    platform: (): NodeJS.Platform => "linux",
    resolveExe: (): string => "/usr/local/bin/keiko",
    stateDir,
  };
  const c = makeIo();
  const code = runLauncherCli(["install"], c.io, {}, deps);
  expect(code).toBe(0);
  return { stateDir, shortcut: join(root, ".local", "share", "applications", "keiko.desktop") };
}

function windowsPortableEnv(home: string): {
  readonly APPDATA: string;
  readonly LOCALAPPDATA: string;
} {
  return {
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}

function writePortableApp(appRoot: string, version = "0.2.11"): void {
  mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "@oscharko-dev/keiko", version }, null, 2)}\n`,
  );
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "fixture cli\n");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writePortableWindowsFixture(root: string, version = "0.2.11"): void {
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  writePortableApp(join(root, "app"), version);
  writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
  writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platformTarget: "windows-x64",
        packageName: "@oscharko-dev/keiko",
        packageVersion: version,
        stable: true,
        primaryLauncher: "Keiko.exe",
        bootstrapUpdateEligible: false,
        runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
      },
      null,
      2,
    )}\n`,
  );
}

async function installPortableWindows(
  root: string,
  options: {
    readonly managedRoot?: string | undefined;
    readonly home?: string | undefined;
    // what a real payload carries: the runtime files and the record that names them
    readonly runtimePayload?: boolean | undefined;
  } = {},
): Promise<{
  readonly home: string;
  readonly managedRoot: string;
  readonly shortcut: string;
  readonly env: { readonly APPDATA: string; readonly LOCALAPPDATA: string };
}> {
  const home = options.home ?? makePortableHome();
  const source = join(root, "portable-bootstrap");
  const env = windowsPortableEnv(home);
  const managedRoot = options.managedRoot ?? join(env.LOCALAPPDATA, "Programs", "Keiko");
  const shortcut = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk");
  writePortableWindowsFixture(source);
  if (options.runtimePayload === true) writePortableRuntimePayload(source, "windows-x64");
  const c = makeIo();
  const code = await runPortableCli(
    [
      "setup",
      "--target",
      "windows-x64",
      "--portable-root",
      source,
      "--managed-root",
      managedRoot,
      "--state-dir",
      join(root, ".keiko"),
    ],
    c.io,
    env,
    { homedir: () => home, now: () => NOW },
  );
  expect(code).toBe(0);
  return { home, managedRoot, shortcut, env };
}

function writePortableMacFixture(root: string, target: "macos-arm64" | "macos-x64"): void {
  const app = join(root, "Keiko.app");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
  mkdirSync(join(resources, ".portable"), { recursive: true });
  writePortableApp(join(resources, "app"));
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(app, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(
    join(resources, ".portable", "setup-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platformTarget: target,
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.11",
        stable: true,
        primaryLauncher: "Keiko.app",
        bootstrapUpdateEligible: false,
        runtime: {
          nodePlatform: "darwin",
          nodeArchitecture: target === "macos-arm64" ? "arm64" : "x64",
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function installPortableMacCustom(
  root: string,
  runtimePayload = false,
): Promise<{
  readonly home: string;
  readonly managedRoot: string;
}> {
  const home = makePortableHome();
  const source = join(root, "portable-bootstrap");
  const managedRoot = join(home, "Portable Apps", "Keiko.app");
  writePortableMacFixture(source, "macos-x64");
  if (runtimePayload) {
    writePortableRuntimePayload(join(source, "Keiko.app", "Contents", "Resources"), "macos-x64");
  }
  const c = makeIo();
  const code = await runPortableCli(
    [
      "setup",
      "--target",
      "macos-x64",
      "--portable-root",
      source,
      "--managed-root",
      managedRoot,
      "--state-dir",
      join(root, ".keiko"),
    ],
    c.io,
    {},
    { homedir: () => home, now: () => NOW },
  );
  expect(code).toBe(0);
  return { home, managedRoot };
}

function tamperPortableRecordToRepoRoot(
  managedRoot: string,
  shortcut: string,
  stateDir: string,
): string {
  const invalidBase = mkdtempSync(join(process.cwd(), ".keiko-portable-policy-invalid-"));
  tempRoots.push(invalidBase);
  const invalidRoot = join(invalidBase, "Keiko");
  cpSync(managedRoot, invalidRoot, { recursive: true });
  unlinkSync(shortcut);
  const statePath = join(stateDir, "portable-install-state.json");
  const registration = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  const realInvalidRoot = realpathSync(invalidRoot);
  registration.managedRootLocator = { kind: "absolute-local", path: realInvalidRoot };
  registration.installRootIdentitySha256 = sha256Text(realInvalidRoot);
  registration.setupManifestSha256 = sha256File(
    join(invalidRoot, ".portable", "setup-manifest.json"),
  );
  registration.launcherIdentitySha256 = sha256File(join(invalidRoot, "Keiko.exe"));
  writeFileSync(statePath, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
  return invalidRoot;
}

describe("runUninstallCli — usage", () => {
  it("prints help and exits 0", async () => {
    const c = makeIo();
    await expect(runUninstallCli(["--help"], c.io, {})).resolves.toBe(0);
    expect(c.out()).toContain("keiko uninstall");
  });

  it("rejects an unknown flag with exit 2", async () => {
    const c = makeIo();
    await expect(runUninstallCli(["--bogus"], c.io, {})).resolves.toBe(2);
    expect(c.err()).toContain("Usage:");
  });

  it("rejects a valued flag missing its value with exit 2", async () => {
    const c = makeIo();
    await expect(runUninstallCli(["--state-dir"], c.io, {})).resolves.toBe(2);
  });
});

describe("runUninstallCli — dry run", () => {
  it("records the governed preview externally without mutating selected state", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    seedPackageJson(root, {});
    const c = makeIo();
    const activityStateDir = join(root, "control-state");
    const events: SecurityLogEvent[] = [];
    const sinkRoots: string[] = [];
    const correlationId = "00000000-0000-4000-8000-000000000001";

    await expect(
      runUninstallCli(
        ["--dry-run"],
        c.io,
        {
          [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
          [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
        },
        {
          cwd: root,
          homedir: () => root,
          activityStateDir,
          securityLogSinkFactory: (sinkRoot) => {
            sinkRoots.push(sinkRoot);
            return { write: (event): void => void events.push(event) };
          },
        },
      ),
    ).resolves.toBe(0);
    expect(new Set(sinkRoots)).toEqual(new Set([activityStateDir]));
    expect(events.map(({ op }) => op)).toEqual([
      "cli.install-layout.normalized",
      "cli.uninstall.started",
      "cli.uninstall.completed",
    ]);
    expect(
      events
        .filter(({ op }) => op.startsWith("cli.uninstall."))
        .every((event) => activityLogEventRegistration(event) !== undefined),
    ).toBe(true);
    expect(new Set(events.map(({ correlationId: id }) => id))).toEqual(new Set([correlationId]));
    expect(extraOf(events[2])).toMatchObject({ dryRun: true, stateDisposition: "would-remove" });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it("reports would-remove without changing anything", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root, { custom: "echo hi" });
    const c = makeIo();
    const deps: UninstallCliDeps = { cwd: root, homedir: () => root };
    await expect(runUninstallCli(["--dry-run"], c.io, {}, deps)).resolves.toBe(0);
    expect(c.out()).toContain("would-remove");
    expect(c.out()).toContain("To remove the package itself");
    // Nothing actually removed.
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
    expect(readScripts(pkg)["keiko:start"]).toBe(KEIKO_START_SCRIPT);
  });
});

describe("runUninstallCli — apply", () => {
  it("records normalization only for a state-preserving launcher operation", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const activityStateDir = join(root, "control-state");
    const c = makeIo();
    const sinkRoots: string[] = [];
    const events: SecurityLogEvent[] = [];
    const correlationId = "00000000-0000-4000-8000-000000000001";

    await expect(
      runUninstallCli(
        ["--launchers"],
        c.io,
        {
          [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
          [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
        },
        {
          cwd: root,
          homedir: () => root,
          activityStateDir,
          securityLogSinkFactory: (sinkRoot) => {
            sinkRoots.push(sinkRoot);
            return { write: (event): void => void events.push(event) };
          },
        },
      ),
    ).resolves.toBe(0);
    expect(new Set(sinkRoots)).toEqual(new Set([activityStateDir]));
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ op: "cli.install-layout.normalized", correlationId });
    expect(events[1]).toMatchObject({ op: "cli.uninstall.started", correlationId });
    expect(extraOf(events[1]).targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(events[2]).toMatchObject({ op: "cli.uninstall.completed", correlationId });
    expect(extraOf(events[2]).stateDisposition).toBe("not-selected");
  });

  it("distinguishes uninstall targets by hash without persisting either path", async () => {
    const root = makeRoot();
    const firstStateDir = join(root, "first-state");
    const secondStateDir = join(root, "second-state");
    const events: SecurityLogEvent[] = [];
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      activityStateDir: join(root, "control-state"),
      securityLogSinkFactory: () => ({
        write: (event): void => void events.push(event),
      }),
    };

    await expect(
      runUninstallCli(["--launchers", "--state-dir", firstStateDir], makeIo().io, {}, deps),
    ).resolves.toBe(0);
    await expect(
      runUninstallCli(["--launchers", "--state-dir", secondStateDir], makeIo().io, {}, deps),
    ).resolves.toBe(0);
    const targetHashes = events
      .filter(({ op }) => op === "cli.uninstall.started")
      .map((event) => extraOf(event).targetSha256);
    expect(targetHashes).toHaveLength(2);
    expect(new Set(targetHashes).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain(firstStateDir);
    expect(JSON.stringify(events)).not.toContain(secondStateDir);
  });

  it("persists full-uninstall evidence outside the state it removes", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const activityStateDir = join(root, "control-state");
    seedPackageJson(root);
    const sinkRoots: string[] = [];
    const events: SecurityLogEvent[] = [];

    await expect(
      runUninstallCli(
        [],
        makeIo().io,
        {
          [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
          [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
        },
        {
          cwd: root,
          homedir: () => root,
          activityStateDir,
          securityLogSinkFactory: (sinkRoot) => {
            sinkRoots.push(sinkRoot);
            return { write: (event): void => void events.push(event) };
          },
        },
      ),
    ).resolves.toBe(0);
    expect(new Set(sinkRoots)).toEqual(new Set([activityStateDir]));
    expect(events.map(({ op }) => op)).toEqual([
      "cli.install-layout.normalized",
      "cli.uninstall.started",
      "cli.uninstall.completed",
    ]);
    expect(new Set(events.map(({ correlationId }) => correlationId))).toEqual(
      new Set(["00000000-0000-4000-8000-000000000001"]),
    );
    expect(extraOf(events[2])).toMatchObject({ stateDisposition: "removed", retainedCount: 0 });
    expect(extraOf(events[2]).targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("refuses without opening a sink when state contains the control root", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const sinkRoots: string[] = [];
    const events: SecurityLogEvent[] = [];
    const c = makeIo();

    await expect(
      runUninstallCli(
        ["--state"],
        c.io,
        {
          [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
          [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
        },
        {
          cwd: root,
          homedir: () => root,
          activityStateDir: stateDir,
          securityLogSinkFactory: (sinkRoot) => {
            sinkRoots.push(sinkRoot);
            return { write: (event): void => void events.push(event) };
          },
        },
      ),
    ).resolves.toBe(1);
    expect(existsSync(stateDir)).toBe(true);
    expect(c.err()).toContain("overlaps the selected state tree");
    expect(sinkRoots).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses before opening a control sink that contains the selected state tree", async () => {
    const root = makeRoot();
    const activityStateDir = join(root, "control-state");
    const stateDir = join(activityStateDir, ".keiko");
    mkdirSync(stateDir, { recursive: true });
    const sinkRoots: string[] = [];
    const events: SecurityLogEvent[] = [];

    await expect(
      runUninstallCli(
        ["--state", "--state-dir", stateDir],
        makeIo().io,
        {},
        {
          cwd: root,
          homedir: () => root,
          activityStateDir,
          securityLogSinkFactory: (sinkRoot) => {
            sinkRoots.push(sinkRoot);
            return { write: (event): void => void events.push(event) };
          },
        },
      ),
    ).resolves.toBe(1);
    expect(existsSync(stateDir)).toBe(true);
    expect(sinkRoots).toEqual([]);
    expect(events).toEqual([]);
  });

  it("retries a transient open failure only at the established control log", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const activityStateDir = join(root, "control-state");
    const events: SecurityLogEvent[] = [];
    const layoutEnv = {
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };
    let openAttempts = 0;

    await expect(
      runUninstallCli(["--state"], makeIo().io, layoutEnv, {
        cwd: root,
        homedir: () => root,
        activityStateDir,
        securityLogSinkFactory: (sinkRoot) => {
          expect(sinkRoot).toBe(activityStateDir);
          openAttempts += 1;
          if (openAttempts === 1) throw new Error("primary unavailable");
          return { write: (event): void => void events.push(event) };
        },
      }),
    ).resolves.toBe(1);
    expect(existsSync(stateDir)).toBe(true);
    expect(openAttempts).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "cli.uninstall.failed", errorKind: "internal" });
    expect(extraOf(events[0]).reason).toBe("activity-log-open-failed");
    expect(extraOf(events[0]).failureKind).toBe("Error");
  });

  it("removes state, keiko scripts (keeping custom), and prints guidance", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root, { custom: "echo hi" });
    const c = makeIo();
    const deps: UninstallCliDeps = { cwd: root, homedir: () => root };
    await expect(runUninstallCli([], c.io, {}, deps)).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    const scripts = readScripts(pkg);
    expect(scripts["keiko:start"]).toBeUndefined();
    expect(scripts["keiko:stop"]).toBeUndefined();
    expect(scripts.custom).toBe("echo hi");
  });

  it("with --scripts only, logs the removal and leaves the state directory untouched", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root);
    const c = makeIo();
    const activityStateDir = join(root, "control-state");
    const events: SecurityLogEvent[] = [];
    const correlationId = "00000000-0000-4000-8000-000000000001";
    await expect(
      runUninstallCli(
        ["--scripts"],
        c.io,
        {
          [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
          [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
        },
        {
          cwd: root,
          homedir: () => root,
          activityStateDir,
          securityLogSinkFactory: () => ({
            write: (event): void => void events.push(event),
          }),
        },
      ),
    ).resolves.toBe(0);
    expect(events.map(({ op }) => op)).toEqual([
      "cli.install-layout.normalized",
      "cli.uninstall.started",
      "cli.uninstall.completed",
    ]);
    expect(new Set(events.map(({ correlationId: id }) => id))).toEqual(new Set([correlationId]));
    expect(events[2]?.extra).toEqual(
      expect.objectContaining({ stateDisposition: "not-selected", scriptCount: 2 }),
    );
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
    expect(readScripts(pkg)["keiko:start"]).toBeUndefined();
  });

  it("with --state only, leaves package.json scripts untouched", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const pkg = seedPackageJson(root);
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    expect(readScripts(pkg)["keiko:start"]).toBe(KEIKO_START_SCRIPT);
  });

  it("keeps a customized keiko:start script", async () => {
    const root = makeRoot();
    const pkg = seedPackageJson(root, { "keiko:start": "my custom start" });
    const c = makeIo();
    await expect(
      runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(readScripts(pkg)["keiko:start"]).toBe("my custom start");
    expect(c.out()).toContain("kept: keiko:start");
  });

  it("keeps the state directory when it holds non-Keiko files", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    writeFileSync(join(stateDir, "user-notes.txt"), "keep me\n", "utf8");
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, "user-notes.txt"))).toBe(true);
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(false);
    expect(c.out()).toContain("non-Keiko entr");
  });

  it("sweeps leftover launcher temp dirs that carry the ownership marker", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    const staleTmp = join(stateDir, ".launcher-state-abc123");
    mkdirSync(staleTmp, { recursive: true });
    // The classifier requires the ownership marker before treating a shape-matching directory
    // as launcher-owned (Codex thread 3770922333). Without it a customer-created directory
    // with the same prefix + 6-alphanum suffix would be swept — regression pin above.
    writeFileSync(join(staleTmp, ".keiko-owned"), "", "utf8");
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("leaves a customer directory whose name matches the launcher tmp shape untouched", async () => {
    const root = makeRoot();
    const stateDir = seedState(root);
    // Same prefix + 6-alphanum suffix a customer might create by hand; NO ownership marker
    // inside. The classifier must NOT treat this as launcher-owned or `keiko uninstall --state`
    // recursively deletes user data.
    const customerDir = join(stateDir, ".launcher-state-cust01");
    mkdirSync(customerDir, { recursive: true });
    writeFileSync(join(customerDir, "user-notes.txt"), "keep me\n", "utf8");
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(customerDir)).toBe(true);
    expect(existsSync(join(customerDir, "user-notes.txt"))).toBe(true);
  });
});

describe("runUninstallCli — scripts edge cases", () => {
  it("reports a missing package.json without failing", async () => {
    const root = makeRoot();
    const c = makeIo();
    await expect(
      runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(c.out()).toContain("package.json not found");
  });

  it("fails with structured evidence when package.json is invalid", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "package.json"), "{not json", "utf8");
    const c = makeIo();
    const events: SecurityLogEvent[] = [];
    await expect(
      runUninstallCli(
        ["--scripts"],
        c.io,
        {},
        {
          cwd: root,
          homedir: () => root,
          activityStateDir: join(root, "control-state"),
          securityLogSinkFactory: () => ({
            write: (event): void => void events.push(event),
          }),
        },
      ),
    ).resolves.toBe(1);
    expect(c.err()).toContain("not valid JSON");
    expect(events.map(({ op }) => op)).toEqual(["cli.uninstall.started", "cli.uninstall.failed"]);
    expect(events[1]).toMatchObject({ errorKind: "internal" });
    expect(extraOf(events[1]).reason).toBe("package-parse-failed");
    expect(extraOf(events[1]).failureKind).toBe("UninstallPackageParseError");
  });

  it("validates scripts before a forced stop or launcher removal", async () => {
    const root = makeRoot();
    const { stateDir, shortcut } = installLauncher(root);
    writeFileSync(join(stateDir, "ui.pid"), `555\n${STOP_LAUNCH_ID}\n`, "utf8");
    writeFileSync(join(root, "package.json"), "{not json", "utf8");
    let livenessChecks = 0;
    let killCalls = 0;
    const c = makeIo();

    await expect(
      runUninstallCli(
        ["--state", "--launchers", "--scripts", "--force"],
        c.io,
        {},
        {
          cwd: root,
          homedir: () => root,
          isProcessAlive: () => {
            livenessChecks += 1;
            return true;
          },
          killProcess: () => {
            killCalls += 1;
          },
          ...verifiedStopIdentity(),
        },
      ),
    ).resolves.toBe(1);

    expect(c.err()).toContain("not valid JSON");
    expect(livenessChecks).toBe(0);
    expect(killCalls).toBe(0);
    expect(existsSync(shortcut)).toBe(true);
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
  });

  it("fails with structured evidence when package.json cannot be read", async () => {
    const root = makeRoot();
    const packageDirectory = join(root, "package-directory");
    mkdirSync(packageDirectory);
    const c = makeIo();
    const events: SecurityLogEvent[] = [];

    await expect(
      runUninstallCli(
        ["--scripts", "--package", packageDirectory],
        c.io,
        {},
        {
          cwd: root,
          homedir: () => root,
          activityStateDir: join(root, "control-state"),
          securityLogSinkFactory: () => ({
            write: (event): void => void events.push(event),
          }),
        },
      ),
    ).resolves.toBe(1);
    expect(c.err()).toContain("not readable");
    expect(events.map(({ op }) => op)).toEqual(["cli.uninstall.started", "cli.uninstall.failed"]);
    expect(events[1]).toMatchObject({ errorKind: "internal" });
    expect(extraOf(events[1]).reason).toBe("package-read-failed");
    expect(extraOf(events[1]).failureKind).toBe("UninstallPackageReadError");
  });

  it("reports when there are no keiko scripts to remove", async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "x" }, null, 2)}\n`,
      "utf8",
    );
    const c = makeIo();
    await expect(
      runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(c.out()).toContain("no keiko:start / keiko:stop scripts");
  });

  // KEIKO-0752: previously the writer hardcoded `null, 2` and reformatted a four-space
  // (or tab-indented) package.json whole, even though uninstall's own scope is only the
  // two `keiko:*` scripts. Detect the raw file's indentation before serializing so the
  // surviving lines keep their original indent.
  it("preserves package.json indentation when removing keiko scripts", async () => {
    const root = makeRoot();
    const path = join(root, "package.json");
    const original = {
      name: "keiko-consumer",
      scripts: {
        "keiko:start": KEIKO_START_SCRIPT,
        "keiko:stop": KEIKO_STOP_SCRIPT,
        "build:app": "tsc -b",
      },
    };
    // Four-space indented input with an LF trailing newline.
    writeFileSync(path, `${JSON.stringify(original, null, 4)}\n`, "utf8");

    const c = makeIo();
    const code = await runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root });
    expect(code).toBe(0);

    const rewritten = readFileSync(path, "utf8");
    // The surviving script line must still be four-space indented, not two.
    expect(rewritten).toContain('    "build:app": "tsc -b"');
    // The Keiko scripts are gone.
    expect(rewritten).not.toContain("keiko:start");
    expect(rewritten).not.toContain("keiko:stop");
    // Trailing newline is preserved.
    expect(rewritten.endsWith("\n")).toBe(true);
  });

  // #2906 round 3 (comment 3865273714): removeScriptsStep now reuses init.ts's temp-file-plus-
  // rename writer, which replaces the target via renameSync — that only needs WRITE permission
  // on the containing DIRECTORY, not on the target file itself (a read-only package.json no
  // longer blocks the write the way a direct writeFileSync did). Deny write on the directory
  // instead, so mkdtempSync itself fails before any content is touched — proving both that the
  // command still fails closed AND that a write/rename failure never corrupts the original file.
  it("exits 1 gracefully and leaves the original package.json intact when the write cannot complete", async (ctx) => {
    // Skip where the read-only bit does not block the owner (Windows, or running as root).
    if (process.platform === "win32") ctx.skip();
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = makeRoot();
    const pkg = seedPackageJson(root);
    const original = readFileSync(pkg, "utf8");
    chmodSync(root, 0o555);
    const c = makeIo();
    const code = await runUninstallCli(["--scripts"], c.io, {}, { cwd: root, homedir: () => root });
    chmodSync(root, 0o755); // restore so afterEach cleanup can remove it
    expect(code).toBe(1);
    expect(c.err()).toContain("keiko uninstall:");
    expect(c.out()).not.toContain("removed: package.json script");
    // The original manifest — including the keiko:start/stop scripts the (failed) removal was
    // supposed to prune — survives byte-for-byte.
    expect(readFileSync(pkg, "utf8")).toBe(original);
  });

  it("honors a custom --package path", async () => {
    const root = makeRoot();
    const nested = join(root, "nested");
    mkdirSync(nested, { recursive: true });
    const pkg = seedPackageJson(nested);
    const c = makeIo();
    await expect(
      runUninstallCli(
        ["--scripts", "--package", "nested/package.json"],
        c.io,
        {},
        { cwd: root, homedir: () => root },
      ),
    ).resolves.toBe(0);
    expect(readScripts(pkg)["keiko:start"]).toBeUndefined();
  });
});

describe("runUninstallCli — state directory edge cases", () => {
  it("reports an absent state directory", async () => {
    const root = makeRoot();
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(c.out()).toContain("not found (nothing to remove)");
  });

  it("honors a custom --state-dir", async () => {
    const root = makeRoot();
    const custom = join(root, "custom-state");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "ui.log"), "x\n", "utf8");
    const c = makeIo();
    await expect(
      runUninstallCli(
        ["--state", "--state-dir", "custom-state"],
        c.io,
        {},
        { cwd: root, homedir: () => root },
      ),
    ).resolves.toBe(0);
    expect(existsSync(custom)).toBe(false);
  });

  it("resolves the state directory from KEIKO_STATE_DIR", async () => {
    const root = makeRoot();
    const envDir = join(root, "env-state");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "ui.log"), "x\n", "utf8");
    const c = makeIo();
    await expect(
      runUninstallCli(
        ["--state"],
        c.io,
        { KEIKO_STATE_DIR: envDir },
        { cwd: root, homedir: () => root },
      ),
    ).resolves.toBe(0);
    expect(existsSync(envDir)).toBe(false);
  });
});

describe("runUninstallCli — running server guard", () => {
  it("refuses to remove state while the UI is running", async () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const c = makeIo();
    const deps: UninstallCliDeps = { cwd: root, homedir: () => root, isProcessAlive: () => true };
    await expect(runUninstallCli(["--state"], c.io, {}, deps)).resolves.toBe(1);
    expect(c.err()).toContain("is running");
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
  });

  it("stops the running UI with --force and removes state when the process exits promptly", async () => {
    // #KEIKO-0422: pre-fix this test used `isProcessAlive: () => true` throughout —
    // it expected state removal to succeed even though the fake process never
    // reported as exited, which is precisely the race the finding fixes. Split into
    // the "process exits promptly" branch (here) and the "process never exits"
    // branch (`waits for the UI to exit before removing state`, below).
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    let aliveCalls = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      // Model a SIGTERM-responsive UI: alive at probe time, dead by the first
      // post-SIGTERM liveness poll.
      isProcessAlive: () => {
        aliveCalls += 1;
        return aliveCalls === 1;
      },
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      // POSIX semantics on every host: the assertion is the SIGTERM a POSIX stop sends.
      platform: () => "linux",
      sleep: () => Promise.resolve(),
      ...verifiedStopIdentity(),
    };
    const c = makeIo();
    await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(0);
    expect(killed).toEqual([[555, "SIGTERM"]]);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("persists forced-stop evidence outside state that the uninstall removes", async () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const activityStateDir = join(root, "control-state");
    let aliveCalls = 0;
    const sinkRoots: string[] = [];
    const events: SecurityLogEvent[] = [];
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      activityStateDir,
      isProcessAlive: () => {
        aliveCalls += 1;
        return aliveCalls === 1;
      },
      killProcess: (): void => undefined,
      sleep: () => Promise.resolve(),
      securityLogSinkFactory: (sinkRoot) => {
        sinkRoots.push(sinkRoot);
        return { write: (event): void => void events.push(event) };
      },
      ...verifiedStopIdentity(),
    };
    const layoutEnv = {
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };
    const correlationId = layoutEnv[INSTALL_LAYOUT_CORRELATION_ID_ENV];

    await expect(
      runUninstallCli(["--state", "--force"], makeIo().io, layoutEnv, deps),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    expect(new Set(sinkRoots)).toEqual(new Set([activityStateDir]));
    expect(events.map(({ op }) => op)).toEqual([
      "cli.install-layout.normalized",
      "cli.uninstall.started",
      "cli.lifecycle.stop-requested",
      "cli.uninstall.completed",
    ]);
    expect(new Set(events.map(({ correlationId }) => correlationId))).toEqual(
      new Set([correlationId]),
    );
    expect(events[1]?.extra?.targetSha256).toBe(events[3]?.extra?.targetSha256);
  });

  it("binds launchId from the same pid record classifyPid read", async () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const seen: string[] = [];
    const pidPath = join(stateDir, "ui.pid");
    const killProcess = vi.fn();
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => {
        rmSync(pidPath, { force: true });
        writeFileSync(pidPath, `555\n${"cd".repeat(16)}\n`, "utf8");
        return true;
      },
      killProcess,
      verifyLaunchIdentity: (_pid, launchId) => {
        seen.push(launchId);
        return false;
      },
      sleep: () => Promise.resolve(),
    };
    const c = makeIo();
    await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(1);
    expect(seen).toEqual([STOP_LAUNCH_ID]);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("with --force on Windows writes ui.shutdown instead of SIGTERM", async () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const killWindowsTree = vi.fn(() => "succeeded" as const);
    let probe = true;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      platform: () => "win32",
      isProcessAlive: () => {
        if (probe) {
          probe = false;
          return true;
        }
        expect(readFileSync(join(stateDir, "ui.shutdown"), "utf8")).toBe(
          `555\n${STOP_LAUNCH_ID}\n`,
        );
        return false;
      },
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      killWindowsTree,
      sleep: () => Promise.resolve(),
    };
    const c = makeIo();
    await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(0);
    expect(killed).toEqual([]);
    expect(killWindowsTree).not.toHaveBeenCalled();
    expect(existsSync(stateDir)).toBe(false);
  });

  it("with --force on Windows escalates to tree-kill when the process survives the grace window", async () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const killWindowsTree = vi.fn(() => "failed" as const);
    let now = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      now += 500;
      return now;
    });
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      platform: () => "win32",
      isProcessAlive: () => true,
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      killWindowsTree,
      sleep: () => Promise.resolve(),
      ...verifiedStopIdentity(),
    };
    const c = makeIo();
    try {
      await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(killed).toEqual([[555, "SIGKILL"]]);
    expect(existsSync(stateDir)).toBe(true);
    expect(c.err()).toContain("did not stop within the wait budget");
  });

  it("with --force --dry-run reports would-stop and does not kill", async () => {
    const root = makeRoot();
    seedState(root, "555");
    let killCount = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true,
      killProcess: () => {
        killCount += 1;
      },
    };
    const c = makeIo();
    await expect(
      runUninstallCli(["--state", "--force", "--dry-run"], c.io, {}, deps),
    ).resolves.toBe(0);
    expect(c.out()).toContain("would-stop");
    expect(killCount).toBe(0);
  });

  it("swallows a kill error when the process already exited", async () => {
    // The kill throwing ESRCH means the process is already dead. Model that by
    // returning "alive" at probe time and "dead" once the post-SIGTERM poll runs
    // (matching the OLD test's intent: state removal succeeds).
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    let aliveCalls = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => {
        aliveCalls += 1;
        return aliveCalls === 1;
      },
      killProcess: () => {
        throw new Error("ESRCH");
      },
      sleep: () => Promise.resolve(),
      ...verifiedStopIdentity(),
    };
    const c = makeIo();
    await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("waits for the UI to exit before removing state and refuses when the process never exits", async () => {
    // #KEIKO-0422 must-fail-before-fix: with `isProcessAlive: () => true` forever
    // and a no-op `killProcess`, `runUninstallCli(["--state", "--force"], ...)`
    // used to remove state anyway — SIGTERM was treated as synchronous and the
    // uninstaller unlinked live state under a still-writing UI. After the fix,
    // ensureServerStoppable polls for the process to exit (100ms interval, 10s
    // budget) and refuses when the budget is exhausted; nothing under stateDir is
    // unlinked and the exit code is 1.
    //
    // Drive Date.now via a spy that advances by 500ms per call so the 10s wait
    // budget is exhausted in ~20 loop iterations without spinning a real 10s.
    const { vi } = await import("vitest");
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const uiPid = join(stateDir, "ui.pid");
    const uiLog = join(stateDir, "ui.log");
    let killCount = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true, // never reports as exited
      killProcess: () => {
        killCount += 1;
      },
      sleep: () => Promise.resolve(),
      // POSIX semantics on every host: on Windows the stop path would run a real taskkill.
      platform: () => "linux",
      ...verifiedStopIdentity(),
    };
    const c = makeIo();
    let now = 0;
    // uninstall.waitForProcessExit uses performance.now for its 10-second budget
    // (Codex thread 3771011316); mock it so the deadline exhausts deterministically
    // instead of spinning against real elapsed time.
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      now += 500;
      return now;
    });
    try {
      await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
    expect(killCount).toBe(1); // SIGTERM was sent
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(uiPid)).toBe(true);
    expect(existsSync(uiLog)).toBe(true);
    expect(c.err()).toContain("did not stop within the wait budget");
    expect(c.err()).toContain("state was not removed");
  });

  it("does not invoke the running-server guard when state is out of scope", async () => {
    const root = makeRoot();
    seedPackageJson(root);
    seedState(root, "555");
    let killCount = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      isProcessAlive: () => true,
      killProcess: () => {
        killCount += 1;
      },
    };
    const c = makeIo();
    await expect(runUninstallCli(["--scripts"], c.io, {}, deps)).resolves.toBe(0);
    expect(killCount).toBe(0);
  });

  // #2906 round 3 (comment 3865273699): classifyPid (via state-paths.ts::readPidFile) used to
  // follow a symlinked ui.pid through plain existsSync/readFileSync -- only lifecycle.ts's own
  // start/stop/status/restart went through the descriptor-safe reader. A symlinked ui.pid
  // pointing at a decoy file naming a real, unrelated pid would make `uninstall --force` signal
  // THAT pid instead of refusing the file outright. Deterministic: a pre-planted symlink is
  // followed regardless of timing, so this needs no real race.
  it("refuses a symlinked ui.pid instead of signalling its target (shared reader hardening)", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ui.log"), "log line\n", "utf8");
    const decoyPidFile = join(root, "decoy-target.pid");
    writeFileSync(decoyPidFile, "999999\n", "utf8");
    symlinkSync(decoyPidFile, join(stateDir, "ui.pid"));
    const killed: number[] = [];
    let aliveCalls = 0;
    const deps: UninstallCliDeps = {
      cwd: root,
      homedir: () => root,
      // Alive on any probe — if the symlink were ever followed, classifyPid would report
      // "running" and ensureServerStoppable would signal the decoy's pid.
      isProcessAlive: () => {
        aliveCalls += 1;
        return true;
      },
      killProcess: (pid) => {
        killed.push(pid);
      },
    };
    const c = makeIo();
    await expect(runUninstallCli(["--state", "--force"], c.io, {}, deps)).resolves.toBe(1);
    // Unreadable ownership supplies no terminal proof. Retain state and never signal the target.
    expect(killed).toEqual([]);
    expect(aliveCalls).toBe(0);
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
    expect(readFileSync(decoyPidFile, "utf8")).toBe("999999\n");
  });
});

describe("runUninstallCli — launcher integration", () => {
  it("removes a recorded launcher shortcut", async () => {
    const root = makeRoot();
    const { shortcut } = installLauncher(root);
    expect(existsSync(shortcut)).toBe(true);
    const c = makeIo();
    await expect(
      runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(shortcut)).toBe(false);
  });

  it("refuses to delete a modified shortcut and exits 1", async () => {
    const root = makeRoot();
    const { shortcut } = installLauncher(root);
    writeFileSync(shortcut, "tampered content\n", "utf8");
    const c = makeIo();
    await expect(
      runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(1);
    expect(existsSync(shortcut)).toBe(true);
    expect(c.err()).toContain("refusing");
  });

  it("reports nothing to remove when no shortcuts are recorded", async () => {
    const root = makeRoot();
    const c = makeIo();
    await expect(
      runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(c.out()).toContain("nothing to remove");
  });

  it("surfaces a LauncherError (symlinked state file) as exit 1", async () => {
    const root = makeRoot();
    installLauncher(root);
    const stateFile = join(root, ".keiko", "launcher-state.json");
    rmSync(stateFile, { force: true });
    symlinkSync(join(root, "elsewhere.json"), stateFile);
    const c = makeIo();
    await expect(
      runUninstallCli(["--launchers"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(1);
    expect(c.err()).toContain("symlink");
  });
});

describe("runUninstallCli — portable managed install", () => {
  it("removes the attested managed install and user-local Start Menu registration", async () => {
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(shortcut)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("refuses a modified Start Menu registration and keeps the managed install", async () => {
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(shortcut, "tampered content\r\n", "utf8");
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(c.err()).toContain("portable registration refused unknown artifact");
  });

  it("refuses a symlink inside the managed install and keeps the portable state", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(join(root, "outside.txt"), "keep", "utf8");
    symlinkSync(join(root, "outside.txt"), join(managedRoot, "app", "rogue-link"));
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
    expect(c.err()).toContain("portable managed install refused symlink");
  });

  it("refuses a nested unknown portable app file and preserves the Start Menu registration", async () => {
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(join(managedRoot, "app", "rogue.txt"), "rogue\n", "utf8");
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(c.err()).toContain("app/rogue.txt");
  });

  it("removes a custom-root Windows install even when the Start Menu registration is missing", async () => {
    const root = makeRoot();
    const home = makePortableHome();
    const customRoot = join(home, "PortableApps", "Keiko");
    const { managedRoot, shortcut, env } = await installPortableWindows(root, {
      home,
      managedRoot: customRoot,
    });
    rmSync(shortcut, { force: true });
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("removes a macOS custom managed root using the local record hint", async () => {
    const root = makeRoot();
    const { home, managedRoot } = await installPortableMacCustom(root);
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  // #4358, Windows guest: the uninstall of a real first installation ended with "unknown entry:
  // .portable/runtime-activation.json". A real payload carries that record and the runtime files
  // it names; the fixture above carries neither.
  it("removes a Windows install whose payload carries the runtime record and its files", async () => {
    const root = makeRoot();
    const { home, managedRoot, env } = await installPortableWindows(root, { runtimePayload: true });
    expect(existsSync(join(managedRoot, ".portable", "runtime-activation.json"))).toBe(true);
    expect(existsSync(join(managedRoot, "runtime", "native", "usearch.node"))).toBe(true);
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(c.err()).toBe("");
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("removes a macOS install whose payload carries the runtime record and its files", async () => {
    const root = makeRoot();
    const { home, managedRoot } = await installPortableMacCustom(root, true);
    const resources = join(managedRoot, "Contents", "Resources");
    expect(existsSync(join(resources, ".portable", "runtime-activation.json"))).toBe(true);
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(c.err()).toBe("");
    expect(existsSync(managedRoot)).toBe(false);
  });

  it("refuses a runtime file the record does not name and records the refusal", async () => {
    const root = makeRoot();
    const { home, managedRoot, env } = await installPortableWindows(root, { runtimePayload: true });
    writeFileSync(join(managedRoot, "runtime", "native", "unknown.exe"), "unowned\n", "utf8");
    const c = makeIo();
    const events: SecurityLogEvent[] = [];

    await expect(
      runUninstallCli(["--state"], c.io, env, {
        cwd: root,
        homedir: () => home,
        activityStateDir: join(root, "control-state"),
        securityLogSinkFactory: () => ({
          write: (event): void => void events.push(event),
        }),
      }),
    ).resolves.toBe(1);
    expect(c.err()).toContain("unknown entry: runtime/native/unknown.exe");
    expect(existsSync(managedRoot)).toBe(true);
    const failed = events.filter(({ op }) => op === "cli.uninstall.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorKind: "internal" });
    expect(extraOf(failed[0]).reason).toBe("operation-error");
  });

  it("refuses a locator tampered toward a policy-invalid repository root even when hashes match", async () => {
    const root = makeRoot();
    const home = makePortableHome();
    const customRoot = join(home, "PortableApps", "Keiko");
    const { managedRoot, shortcut, env } = await installPortableWindows(root, {
      home,
      managedRoot: customRoot,
    });
    const invalidRoot = tamperPortableRecordToRepoRoot(managedRoot, shortcut, join(root, ".keiko"));
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(1);
    expect(existsSync(invalidRoot)).toBe(true);
    expect(existsSync(managedRoot)).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
    expect(c.err()).toContain("could not be attested");
  });

  it("refuses a symlinked Start Menu ancestor without deleting outside artifacts", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const { home, managedRoot, shortcut, env } = await installPortableWindows(root);
    const programsDir = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
    const outsidePrograms = join(root, "outside-programs");
    mkdirSync(outsidePrograms, { recursive: true });
    const outsideShortcut = join(outsidePrograms, "Keiko.lnk");
    writeFileSync(outsideShortcut, readFileSync(shortcut, "utf8"), "utf8");
    rmSync(programsDir, { recursive: true, force: true });
    symlinkSync(outsidePrograms, programsDir, "dir");
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(1);
    expect(existsSync(managedRoot)).toBe(true);
    expect(readFileSync(outsideShortcut, "utf8")).toContain("Keiko.exe");
    expect(c.err()).toContain("portable registration refused symlinked ancestor");
  });
});

// ─── uninstall --state runtime-state manifest (Issue #1321) ───────────────────

function seedFullState(root: string, pid = "2147483646"): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(join(stateDir, "credentials"), { recursive: true });
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  mkdirSync(join(stateDir, "local-knowledge", "default"), { recursive: true });
  mkdirSync(join(stateDir, "evidence", "figma"), { recursive: true });
  mkdirSync(join(stateDir, "evidence", "qi", "figma-snapshots", "run-1"), { recursive: true });
  mkdirSync(join(defaultUiDataDir(stateDir), "credentials"), { recursive: true });
  const files: Record<string, string> = {
    "ui.pid": `${pid}\n`,
    "ui.log": "log\n",
    "keiko-ui.db": "db",
    "keiko-ui.db-wal": "wal",
    "keiko-ui.db-shm": "shm",
    "keiko-ui.db.corrupt.2026-06-20T12-00-00-000Z": "quarantine",
    "keiko.config.json": "{}",
    "credentials/provider-credentials.vault": "sealed",
    "credentials/provider-credentials-vault.key": "key",
    "credentials/.secret-vault.1234.deadbeefdeadbeef.tmp": "temp",
    "memory/keiko-memory.db": "db",
    "memory/keiko-memory.db-wal": "wal",
    "memory/keiko-memory.db-wal.corrupt.2026-06-20T12-00-00-000Z": "quarantine",
    "local-knowledge/default/capsules.db": "db",
    "local-knowledge/default/capsules.db-shm": "shm",
    "evidence/run-1.json": "{}",
    "evidence/run-1.json.123e4567-e89b-12d3-a456-426614174000.tmp": "{}",
    "evidence/figma/figma-token.vault": "sealed",
    "evidence/figma/figma-vault.key": "key",
    "evidence/qi/run-1.qi.json": "{}",
    "evidence/qi/run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp": "{}",
    "evidence/qi/run-1.candidates.json": "{}",
    "evidence/qi/run-1.review.json": "{}",
    "evidence/qi/run-1.figma-snapshot.management.json": "{}",
    "evidence/qi/figma-snapshots/run-1/screen.png": "img",
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(stateDir, rel), body, "utf8");
  for (const artifact of ATLASSIAN_CREDENTIAL_ARTIFACTS) {
    writeFileSync(join(defaultUiDataDir(stateDir), "credentials", artifact), "owned", "utf8");
  }
  return stateDir;
}

// #4358, Windows window on build cb59ec31f: `keiko uninstall` run with the installed copy's own
// command stopped at the first file Windows would not let it remove and left the installation half
// removed. A removal now keeps going past an entry that is held open, says what remains, keeps the
// installation registered until its last file is gone, and a second run completes. Run from inside
// the installation on Windows, it first starts a helper outside it and hands over the rest.
describe("runUninstallCli — held-open entries and a run from inside the installation", () => {
  const HELD = join("runtime", "native", "usearch.node");
  const WIN = { SystemRoot: String.raw`D:\Windows` };
  const activityDeps = (
    root: string,
    events: SecurityLogEvent[],
  ): Pick<UninstallCliDeps, "activityStateDir" | "securityLogSinkFactory"> => ({
    activityStateDir: join(root, "control-state"),
    securityLogSinkFactory: () => ({ write: (event): void => void events.push(event) }),
  });
  const heldOpen =
    (suffix: string) =>
    (path: string): void => {
      if (path.endsWith(suffix)) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      unlinkSync(path);
    };

  async function installReal(): Promise<{
    readonly root: string;
    readonly home: string;
    readonly managedRoot: string;
    readonly shortcut: string;
    readonly env: { readonly APPDATA: string; readonly LOCALAPPDATA: string };
  }> {
    const root = makeRoot();
    const installed = await installPortableWindows(root, { runtimePayload: true });
    writeFileSync(join(root, ".keiko", "ui.log"), "log\n", "utf8");
    return { root, ...installed };
  }

  function fileCount(path: string): number {
    return readdirSync(path, { recursive: true }).length;
  }

  it("keeps going past a held-open file, says what remains, stays registered, and a second run completes", async () => {
    const { root, home, managedRoot, shortcut, env } = await installReal();
    const events: SecurityLogEvent[] = [];
    const c = makeIo();

    const code = await runUninstallCli(["--state"], c.io, env, {
      cwd: root,
      homedir: () => home,
      ...activityDeps(root, events),
      managedRemoval: { unlink: heldOpen(HELD) },
    });

    expect(code).toBe(1);
    expect(c.out()).toContain(`remaining: ${join(managedRoot, HELD)}`);
    expect(c.err()).toContain("10 entries of the installation could not be removed");
    expect(c.err()).toContain("run keiko uninstall again");
    expect(existsSync(join(managedRoot, HELD))).toBe(true);
    // never half-removed from the product's point of view: still registered, still resumable
    expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-uninstall-journal.json"))).toBe(true);
    expect(existsSync(join(root, ".keiko", "ui.log"))).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(existsSync(join(managedRoot, ".portable", "setup-manifest.json"))).toBe(true);
    expect(existsSync(join(managedRoot, "runtime", "node", "node.exe"))).toBe(false);
    const handoff = events.filter(({ op }) => op === "cli.uninstall.handoff");
    expect(handoff.map((event) => extraOf(event).outcome)).toEqual(["residue-reported"]);
    expect(extraOf(handoff[0])).toMatchObject({
      residueFileCount: 5,
      residueDirectoryCount: 5,
      refusal: "none",
    });
    expect(extraOf(events.find(({ op }) => op === "cli.uninstall.failed")).reason).toBe(
      "removal-incomplete",
    );

    const second = makeIo();
    await expect(
      runUninstallCli(["--state"], second.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(second.err()).toBe("");
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
    expect(existsSync(shortcut)).toBe(false);
  });

  it("accepts a partly removed installation of its own making and still refuses a foreign entry", async () => {
    const { root, home, managedRoot, env } = await installReal();
    await runUninstallCli(["--state"], makeIo().io, env, {
      cwd: root,
      homedir: () => home,
      managedRemoval: { unlink: heldOpen(HELD) },
    });
    writeFileSync(join(managedRoot, "FOREIGN.txt"), "unowned\n", "utf8");
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(1);
    expect(c.err()).toContain("unknown entry: FOREIGN.txt");
    expect(existsSync(join(managedRoot, "FOREIGN.txt"))).toBe(true);
    expect(existsSync(join(managedRoot, HELD))).toBe(true);
  });

  // The helper stand-in reports ready the way the real one does, by writing the file its caller
  // waits for; what it would delete is the list the command commits.
  function helperSeam(
    root: string,
    reportsReady: boolean,
  ): {
    readonly calls: { readonly command: string; readonly options: Record<string, unknown> }[];
    readonly tempParent: string;
    readonly seam: NonNullable<UninstallCliDeps["managedRemoval"]>["helper"];
  } {
    const calls: { command: string; options: Record<string, unknown> }[] = [];
    const tempParent = join(root, "helper-temp");
    mkdirSync(tempParent);
    return {
      calls,
      tempParent,
      seam: {
        tempParent,
        identityCheck: () => true,
        existsAsFile: () => true,
        readyTimeoutMs: 3,
        pollMs: 1,
        sleep: () => Promise.resolve(),
        spawnFn: (command, _args, options): { on: () => void; unref: () => void } => {
          calls.push({ command, options: { ...options } });
          const directory = options.env.KEIKO_UNINSTALL_DIR ?? "";
          if (reportsReady) writeFileSync(join(directory, "ready"), "ready");
          return { on: (): void => undefined, unref: (): void => undefined };
        },
      },
    };
  }

  function insideCopy(
    managedRoot: string,
  ): Pick<UninstallCliDeps, "platform" | "execPath" | "argv1"> {
    return {
      platform: () => "win32",
      execPath: join(managedRoot, "runtime", "node", "node.exe"),
      argv1: join(managedRoot, "app", "dist", "cli", "index.js"),
    };
  }

  it("started from inside the installation on Windows it hands the last files to a helper and keeps the registration to the end", async () => {
    const { root, home, managedRoot, shortcut, env } = await installReal();
    const helper = helperSeam(root, true);
    const events: SecurityLogEvent[] = [];
    const c = makeIo();

    const code = await runUninstallCli(
      ["--state"],
      c.io,
      { ...env, ...WIN },
      {
        cwd: root,
        homedir: () => home,
        ...activityDeps(root, events),
        ...insideCopy(managedRoot),
        managedRemoval: {
          helper: helper.seam,
          unlink: heldOpen(join("runtime", "node", "node.exe")),
        },
      },
    );

    expect(code).toBe(0);
    // one start, attached with a hidden window like the opener, on the trusted PowerShell
    expect(helper.calls).toHaveLength(1);
    expect(helper.calls[0]?.command).toBe(
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(helper.calls[0]?.options).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    expect(c.out()).toMatch(
      /The last \d+ entries of this copy are removed when this command ends/u,
    );
    // the installation is still registered and resumable until the helper has removed the rest
    expect(existsSync(join(managedRoot, "runtime", "node", "node.exe"))).toBe(true);
    expect(existsSync(join(managedRoot, ".portable", "setup-manifest.json"))).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
    expect(existsSync(join(root, ".keiko", "portable-uninstall-journal.json"))).toBe(true);
    expect(existsSync(shortcut)).toBe(true);
    expect(existsSync(join(root, ".keiko", "ui.log"))).toBe(false);
    // what the helper removes: payload residue, then the identity files, then the registration
    const directory = join(helper.tempParent, readdirSync(helper.tempParent)[0] ?? "");
    const lines = readFileSync(join(directory, "residue.txt"), "utf8").trim().split("\n");
    const kinds = lines.map((line) => line.slice(0, 1)).join("");
    expect(kinds).toMatch(/^F+D+X+S$/u);
    const files = lines.filter((line) => line.startsWith("F\t")).map((line) => line.slice(2));
    expect(files[0]).toBe(join(managedRoot, "runtime", "node", "node.exe"));
    expect(files.slice(-2)).toEqual([
      join(managedRoot, "Keiko.exe"),
      join(managedRoot, ".portable", "setup-manifest.json"),
    ]);
    expect(lines.at(-1)).toBe(`S\t${join(root, ".keiko")}`);
    expect(lines.slice(-4, -1).map((line) => line.slice(2))).toEqual([
      shortcut,
      join(root, ".keiko", "portable-install-state.json"),
      join(root, ".keiko", "portable-uninstall-journal.json"),
    ]);
    const handoff = events.filter(({ op }) => op === "cli.uninstall.handoff");
    expect(handoff.map((event) => extraOf(event).outcome)).toEqual([
      "helper-ready",
      "residue-committed",
    ]);
    const record = expectActivityLogProof(
      "cli.uninstall.handoff.persisted",
      formatActivityLogProofLine(handoff[1] ?? {}),
    );
    expect(record).toMatchObject({ outcome: "residue-committed", refusal: "none" });
    expect(JSON.stringify(events)).not.toContain(managedRoot);

    // a helper that died: the next run, from anywhere, completes the removal
    const second = makeIo();
    await expect(
      runUninstallCli(["--state"], second.io, env, { cwd: root, homedir: () => home }),
    ).resolves.toBe(0);
    expect(existsSync(managedRoot)).toBe(false);
    expect(existsSync(join(root, ".keiko"))).toBe(false);
    expect(existsSync(shortcut)).toBe(false);
  });

  it.each([
    ["reports nothing", false, "not-ready"],
    ["cannot be started", true, "spawn-failed"],
  ] as const)(
    "refuses before the first deletion when the helper %s, with the installation intact",
    async (_name, throws, refusal) => {
      const { root, home, managedRoot, env } = await installReal();
      const helper = helperSeam(root, false);
      const before = fileCount(managedRoot);
      const events: SecurityLogEvent[] = [];
      const c = makeIo();

      const code = await runUninstallCli(
        ["--state"],
        c.io,
        { ...env, ...WIN },
        {
          cwd: root,
          homedir: () => home,
          ...activityDeps(root, events),
          ...insideCopy(managedRoot),
          managedRemoval: {
            helper: {
              ...helper.seam,
              spawnFn: (...args) => {
                if (throws) throw new Error("spawn EACCES");
                return (
                  helper.seam?.spawnFn?.(...args) ?? {
                    on: (): void => undefined,
                    unref: (): void => undefined,
                  }
                );
              },
            },
          },
        },
      );

      expect(code).toBe(1);
      expect(c.err()).toContain("nothing was removed");
      expect(c.err()).toContain("downloaded Keiko release package");
      expect(fileCount(managedRoot)).toBe(before);
      expect(existsSync(join(root, ".keiko", "portable-install-state.json"))).toBe(true);
      expect(existsSync(join(root, ".keiko", "portable-uninstall-journal.json"))).toBe(false);
      expect(existsSync(join(root, ".keiko", "ui.log"))).toBe(true);
      expect(readdirSync(helper.tempParent)).toEqual([]);
      const handoff = events.filter(({ op }) => op === "cli.uninstall.handoff");
      expect(handoff.map((event) => [extraOf(event).outcome, extraOf(event).refusal])).toEqual([
        ["helper-refused", refusal],
      ]);
      expect(extraOf(events.find(({ op }) => op === "cli.uninstall.failed")).reason).toBe(
        "helper-refused",
      );
    },
  );

  it("refuses when PowerShell cannot be resolved", async () => {
    const { root, home, managedRoot, env } = await installReal();
    const helper = helperSeam(root, true);
    const c = makeIo();

    await expect(
      runUninstallCli(
        ["--state"],
        c.io,
        { ...env, ...WIN },
        {
          cwd: root,
          homedir: () => home,
          ...insideCopy(managedRoot),
          managedRemoval: { helper: { ...helper.seam, existsAsFile: () => false } },
        },
      ),
    ).resolves.toBe(1);
    expect(helper.calls).toEqual([]);
    expect(c.err()).toContain("nothing was removed");
    expect(existsSync(join(managedRoot, "Keiko.exe"))).toBe(true);
  });

  it("starts no helper on another platform or on a dry run, and a dry run names the handoff", async () => {
    const { root, home, managedRoot, env } = await installReal();
    const helper = helperSeam(root, true);
    const outside = {
      execPath: join(managedRoot, "runtime", "node", "node.exe"),
      argv1: join(managedRoot, "app", "dist", "cli", "index.js"),
    };

    const dry = makeIo();
    await expect(
      runUninstallCli(
        ["--state", "--dry-run"],
        dry.io,
        { ...env, ...WIN },
        {
          cwd: root,
          homedir: () => home,
          ...insideCopy(managedRoot),
          managedRemoval: { helper: helper.seam },
        },
      ),
    ).resolves.toBe(0);
    expect(dry.out()).toContain("this command runs from inside the installation");
    expect(existsSync(managedRoot)).toBe(true);

    const posix = makeIo();
    await expect(
      runUninstallCli(["--state"], posix.io, env, {
        cwd: root,
        homedir: () => home,
        platform: () => "linux",
        ...outside,
        managedRemoval: { helper: helper.seam },
      }),
    ).resolves.toBe(0);
    expect(helper.calls).toEqual([]);
    expect(existsSync(managedRoot)).toBe(false);
  });
});

describe("runUninstallCli — runtime state manifest", () => {
  it("removes every Keiko-owned sensitive artifact and then the state dir", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("removes Atlassian credential artifacts from the default UI data directory", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const vault = join(
      defaultUiDataDir(stateDir),
      "credentials",
      ATLASSIAN_CREDENTIAL_ARTIFACTS[0],
    );
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(vault)).toBe(false);
    expect(c.out()).toContain(`removed: ${vault}`);
  });

  it("with --state --dry-run lists the sensitive artifacts without removing them", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const c = makeIo();
    await expect(
      runUninstallCli(["--state", "--dry-run"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    const out = c.out();
    expect(out).toContain(join(stateDir, "keiko-ui.db"));
    expect(out).toContain(join(stateDir, "memory", "keiko-memory.db"));
    expect(out).toContain(join(stateDir, "credentials", "provider-credentials.vault"));
    expect(out).toContain(join(stateDir, "credentials", ".secret-vault.1234.deadbeefdeadbeef.tmp"));
    expect(out).toContain(join(stateDir, "credentials", "provider-credentials-vault.key"));
    expect(out).toContain(join(stateDir, "evidence", "figma", "figma-token.vault"));
    expect(out).toContain(join(stateDir, "evidence", "figma", "figma-vault.key"));
    expect(out).toContain(join(stateDir, "evidence", "qi", "run-1.qi.json"));
    expect(out).toContain(
      join(stateDir, "evidence", "qi", "run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
    );
    // Nothing actually removed.
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(true);
    expect(existsSync(stateDir)).toBe(true);
  });

  it("removes WAL/SHM and quarantine sidecars alongside every database", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    for (const rel of [
      "keiko-ui.db-wal",
      "keiko-ui.db-shm",
      "keiko-ui.db.corrupt.2026-06-20T12-00-00-000Z",
      "memory/keiko-memory.db-wal",
      "memory/keiko-memory.db-wal.corrupt.2026-06-20T12-00-00-000Z",
      "local-knowledge/default/capsules.db-shm",
      "evidence/figma/figma-vault.key",
    ]) {
      expect(existsSync(join(stateDir, rel))).toBe(false);
    }
  });

  it("keeps a customer file and the state dir, but still removes Keiko artifacts", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const userFile = join(stateDir, "user-notes.txt");
    writeFileSync(userFile, "keep me\n", "utf8");
    const c = makeIo();
    const events: SecurityLogEvent[] = [];
    await expect(
      runUninstallCli(
        ["--state"],
        c.io,
        {},
        {
          cwd: root,
          homedir: () => root,
          activityStateDir: join(root, "control-state"),
          securityLogSinkFactory: () => ({
            write: (event): void => void events.push(event),
          }),
        },
      ),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(false);
    expect(existsSync(join(stateDir, "credentials", "provider-credentials.vault"))).toBe(false);
    expect(c.out()).toContain("non-Keiko entr");
    expect(events.at(-1)).toMatchObject({ op: "cli.uninstall.completed" });
    expect(extraOf(events.at(-1))).toMatchObject({
      stateDisposition: "retained",
      retainedCount: 1,
    });
  });

  // #3531: `--state` removes the rebuildable segment manifests and retains an operator file there.
  it("removes segment manifests with the state and retains a foreign file beside them", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const manifests = join(stateDir, "activity-log-manifests");
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    const manifest = join(manifests, "manifest-20260918T100000000Z-4242-a1b2c3d4-000001.json");
    const foreign = join(manifests, "operator-notes.txt");
    writeFileSync(manifest, "{}\n", { encoding: "utf8", mode: 0o600 });
    writeFileSync(foreign, "keep me\n", "utf8");
    const c = makeIo();

    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    rmSync(foreign);
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("refuses to follow a symlink and keeps the state dir", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const outsideTarget = join(root, "outside-secret.txt");
    writeFileSync(outsideTarget, "do not delete\n", "utf8");
    symlinkSync(outsideTarget, join(stateDir, "evil-link"));
    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(outsideTarget)).toBe(true); // never followed
    expect(existsSync(join(stateDir, "evil-link"))).toBe(true); // left in place
    expect(existsSync(stateDir)).toBe(true);
    expect(c.out()).toContain("symlink — not followed");
  });

  it("refuses a symlinked state root without deleting the target tree", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const target = join(root, "outside-state");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keiko-ui.db"), "db", "utf8");
    symlinkSync(target, join(root, ".keiko"), "dir");

    const c = makeIo();
    const activityStateDir = join(root, "control-state");
    const sinkRoots: string[] = [];
    const events: SecurityLogEvent[] = [];
    await expect(
      runUninstallCli(
        ["--state"],
        c.io,
        {},
        {
          cwd: root,
          homedir: () => root,
          activityStateDir,
          securityLogSinkFactory: (sinkRoot) => {
            sinkRoots.push(sinkRoot);
            return { write: (event): void => void events.push(event) };
          },
        },
      ),
    ).resolves.toBe(1);
    expect(c.err()).toContain("refusing to use symlinked state directory");
    expect(existsSync(join(target, "keiko-ui.db"))).toBe(true);
    expect(existsSync(join(root, ".keiko"))).toBe(true);
    expect(new Set(sinkRoots)).toEqual(new Set([activityStateDir]));
    expect(events.map(({ op }) => op)).toEqual(["cli.uninstall.started", "cli.uninstall.failed"]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        errorKind: "internal",
      }),
    );
    expect(extraOf(events[1]).reason).toBe("preflight-refused");
    expect(extraOf(events[1]).failureKind).toBe("UninstallPreflightError");
  });

  it("refuses a non-directory state root without crashing", async () => {
    const root = makeRoot();
    writeFileSync(join(root, ".keiko"), "not a directory", "utf8");

    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(1);
    expect(c.err()).toContain("refusing to use non-directory state path");
    expect(existsSync(join(root, ".keiko"))).toBe(true);
  });

  it("keeps customer lookalikes in known state subdirectories", async () => {
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const kept = [
      "evidence/manual export.json",
      "evidence/manual export.lock",
      "evidence/qi/debug dump.json",
      "evidence/qi/run-1.notes.json",
      "credentials/backup.key",
      "credentials/backup.vault",
      "credentials/.secret-vault.abc.deadbeefdeadbeef.tmp",
      "evidence/figma/backup.key",
      "evidence/figma/backup.vault",
      "evidence/manual export.json.123e4567-e89b-12d3-a456-426614174000.tmp",
      "evidence/qi/debug dump.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp",
    ];
    for (const rel of kept) writeFileSync(join(stateDir, rel), "customer", "utf8");
    mkdirSync(join(stateDir, "local-knowledge", "notes"), { recursive: true });

    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(stateDir)).toBe(true);
    for (const rel of kept) expect(existsSync(join(stateDir, rel))).toBe(true);
    expect(existsSync(join(stateDir, "local-knowledge", "notes"))).toBe(true);
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(false);
    expect(existsSync(join(stateDir, "credentials", "provider-credentials.vault"))).toBe(false);
    expect(c.out()).toContain("not a recognized Keiko artifact");
  });

  it("keeps an owned-looking hardlink and reports why the state dir remains", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = makeRoot();
    const stateDir = seedFullState(root);
    const outsideDb = join(root, "outside-db");
    writeFileSync(outsideDb, "db", "utf8");
    rmSync(join(stateDir, "keiko-ui.db"), { force: true });
    linkSync(outsideDb, join(stateDir, "keiko-ui.db"));

    const c = makeIo();
    await expect(
      runUninstallCli(["--state"], c.io, {}, { cwd: root, homedir: () => root }),
    ).resolves.toBe(0);
    expect(existsSync(outsideDb)).toBe(true);
    expect(existsSync(join(stateDir, "keiko-ui.db"))).toBe(true);
    expect(c.out()).toContain("hardlink — not modified or removed");
  });
});

describe("runUninstallCli — package guidance", () => {
  it("lists the local uninstall command first when a local install exists", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "node_modules", "@oscharko-dev", "keiko"), { recursive: true });
    const c = makeIo();
    await expect(runUninstallCli([], c.io, {}, { cwd: root, homedir: () => root })).resolves.toBe(
      0,
    );
    const out = c.out();
    const localIdx = out.indexOf("local install in this project");
    const globalIdx = out.indexOf("if also installed globally");
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeLessThan(globalIdx);
  });

  it("lists the global uninstall command first when no local install exists", async () => {
    const root = makeRoot();
    const c = makeIo();
    await expect(runUninstallCli([], c.io, {}, { cwd: root, homedir: () => root })).resolves.toBe(
      0,
    );
    expect(c.out()).toContain("npm uninstall -g @oscharko-dev/keiko     (global install)");
  });
});

describe("gatewayServiceUninstallNotice", () => {
  it("names the service only on Windows when its folder exists", () => {
    const exists = (): boolean => true;
    const absent = (): boolean => false;
    expect(gatewayServiceUninstallNotice("win32", "C:\\PF", exists)).toContain(
      "keiko gateway-service uninstall",
    );
    expect(gatewayServiceUninstallNotice("win32", "C:\\PF", absent)).toBeUndefined();
    expect(gatewayServiceUninstallNotice("win32", undefined, exists)).toBeUndefined();
    expect(gatewayServiceUninstallNotice("darwin", "/PF", exists)).toBeUndefined();
  });
});
