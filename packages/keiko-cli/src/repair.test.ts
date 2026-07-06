import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepairCli, type RepairCliDeps } from "./repair.js";
import { runLauncherCli } from "./launcher.js";
import { loadState } from "./launcher-state.js";
import { runPortableCli } from "./portable.js";
import type { CliIo } from "./runner.js";

// Seeds the encrypted credential vault index next to a config so apiKeySecretRef references are not
// flagged as orphaned. The repair check reads only the non-secret reference keys (no decryption), so
// a placeholder sealed value is sufficient to mark a reference as present.
function seedVault(root: string, refs: readonly string[]): void {
  const dir = join(root, "credentials");
  mkdirSync(dir, { recursive: true });
  const entries: Record<string, string> = {};
  for (const ref of refs) {
    entries[ref] = "kv1.placeholder";
  }
  writeFileSync(
    join(dir, "provider-credentials.vault"),
    JSON.stringify({ version: 1, entries }),
    "utf8",
  );
}

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];
const REAL_TMPDIR = realpathSync(tmpdir());
const NOW = new Date("2026-07-06T00:00:00.000Z");

function makeRoot(): string {
  const root = mkdtempSync(join(REAL_TMPDIR, "keiko-repair-"));
  tempRoots.push(root);
  return root;
}

function makePolicyAllowedRoot(prefix: string): string {
  const cwdParent = dirname(process.cwd());
  const parent = cwdParent.startsWith(REAL_TMPDIR) ? homedir() : cwdParent;
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

// A repair deps object whose launch-path probe is clean: a relative argv[1] means the
// doctor cannot classify the running entry as an absolute stale binary.
function healthyDeps(root: string): RepairCliDeps {
  return {
    cwd: root,
    argv: [process.execPath, "keiko"],
    homedir: (): string => root,
    isProcessAlive: (): boolean => false,
  };
}

function portableRepairDeps(root: string, home: string): RepairCliDeps {
  return { ...healthyDeps(root), homedir: (): string => home };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Mirrors the local-install layout doctor.test.ts builds, so `resolvePreferredInstallLayout`
// resolves and the install-layout check reports `ok`.
function seedInstalledLayout(root: string): void {
  const pkgRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
  mkdirSync(join(pkgRoot, "dist", "cli"), { recursive: true });
  mkdirSync(join(pkgRoot, "dist", "ui", "static"), { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), '{"version":"0.2.0-beta.9"}\n', "utf8");
  writeFileSync(join(pkgRoot, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(join(pkgRoot, "dist", "ui", "static", "index.html"), "<html></html>\n", "utf8");
}

function installLauncher(root: string): string {
  const c = makeIo();
  const code = runLauncherCli(
    ["install"],
    c.io,
    {},
    {
      cwd: root,
      homedir: (): string => root,
      platform: (): NodeJS.Platform => "linux",
      resolveExe: (): string => "/usr/local/bin/keiko",
      stateDir: join(root, ".keiko"),
    },
  );
  expect(code).toBe(0);
  return join(root, ".local", "share", "applications", "keiko.desktop");
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
  options: { readonly managedRoot?: string | undefined; readonly home?: string | undefined } = {},
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
  const shortcut = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat");
  writePortableWindowsFixture(source);
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

async function installPortableMacCustom(root: string): Promise<{
  readonly home: string;
  readonly managedRoot: string;
}> {
  const home = makePortableHome();
  const source = join(root, "portable-bootstrap");
  const managedRoot = join(home, "Portable Apps", "Keiko.app");
  writePortableMacFixture(source, "macos-x64");
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

describe("runRepairCli — usage", () => {
  it("prints help and exits 0", () => {
    const c = makeIo();
    expect(runRepairCli(["--help"], c.io, {})).toBe(0);
    expect(c.out()).toContain("keiko repair");
  });

  it("rejects an unknown flag with exit 2", () => {
    const c = makeIo();
    expect(runRepairCli(["--bogus"], c.io, {})).toBe(2);
  });

  it("rejects --config with no value (exit 2)", () => {
    const c = makeIo();
    expect(runRepairCli(["--config"], c.io, {})).toBe(2);
  });
});

describe("runRepairCli — healthy", () => {
  it("reports a healthy system and exits 0", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("system is healthy");
    expect(c.out()).toContain("[ok] Install layout");
  });
});

describe("runRepairCli — stale pid", () => {
  it("removes a stale pid file on apply and exits 0", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "ui.pid"), "4242\n", "utf8");
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("removed stale pid file");
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(false);
  });

  it("reports a stale pid in --dry-run without removing it and exits 1", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "ui.pid"), "4242\n", "utf8");
    const c = makeIo();
    expect(runRepairCli(["--dry-run"], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[would-fix] UI process state");
    expect(existsSync(join(stateDir, "ui.pid"))).toBe(true);
  });

  it("reports a running UI as ok", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "ui.pid"), "4242\n", "utf8");
    const c = makeIo();
    const deps: RepairCliDeps = { ...healthyDeps(root), isProcessAlive: () => true };
    expect(runRepairCli([], c.io, {}, deps)).toBe(0);
    expect(c.out()).toContain("running (pid 4242)");
  });
});

describe("runRepairCli — state directory permissions", () => {
  it("tightens loose permissions to 0o700", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o755);
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("tightened permissions");
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it("reports loose permissions in --dry-run without changing them and exits 1", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o755);
    const c = makeIo();
    expect(runRepairCli(["--dry-run"], c.io, {}, healthyDeps(root))).toBe(1);
    expect(statSync(stateDir).mode & 0o777).toBe(0o755);
  });
});

describe("runRepairCli — launcher records", () => {
  it("verifies an intact shortcut as ok", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    installLauncher(root);
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("shortcut(s) verified");
  });

  it("prunes a dangling record when the shortcut file was deleted", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const shortcut = installLauncher(root);
    rmSync(shortcut, { force: true });
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("pruned 1 dangling record");
    const state = loadState(join(root, ".keiko"), { homedir: root });
    expect(state.entries).toHaveLength(0);
  });

  it("flags a modified shortcut as an action item and exits 1", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const shortcut = installLauncher(root);
    writeFileSync(shortcut, "tampered\n", "utf8");
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[action] Launcher records");
  });
});

describe("runRepairCli — portable managed install", () => {
  it("recreates a missing Windows Start Menu registration for an attested portable install", async () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const { home, shortcut, env } = await installPortableWindows(root);
    rmSync(shortcut, { force: true });
    const c = makeIo();

    expect(runRepairCli([], c.io, env, portableRepairDeps(root, home))).toBe(0);
    expect(c.out()).toContain("Portable registration");
    expect(c.out()).toContain("repaired 1 user-local registration artifact");
    expect(existsSync(shortcut)).toBe(true);
    expect(home).toContain("portable-home");
  });

  it("recreates a missing Windows Start Menu registration for a custom managed root using the local record hint", async () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const home = makePortableHome();
    const customRoot = join(home, "PortableApps", "Keiko");
    const { shortcut, env } = await installPortableWindows(root, {
      home,
      managedRoot: customRoot,
    });
    rmSync(shortcut, { force: true });
    const c = makeIo();

    expect(runRepairCli([], c.io, env, portableRepairDeps(root, home))).toBe(0);
    expect(c.out()).toContain("repaired 1 user-local registration artifact");
    expect(existsSync(shortcut)).toBe(true);
  });

  it("flags a modified Windows Start Menu registration as an action item", async () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const { shortcut, env } = await installPortableWindows(root);
    writeFileSync(shortcut, "tampered content\r\n", "utf8");
    const c = makeIo();

    expect(runRepairCli([], c.io, env, portableRepairDeps(root, join(root, "portable-home")))).toBe(
      1,
    );
    expect(c.out()).toContain("[action] Portable registration");
    expect(c.out()).toContain("modified");
  });

  it("flags a nested unknown portable app file as an action item", async () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const { managedRoot, shortcut, env } = await installPortableWindows(root);
    writeFileSync(join(managedRoot, "app", "rogue.txt"), "rogue\n", "utf8");
    const c = makeIo();

    expect(runRepairCli([], c.io, env, portableRepairDeps(root, join(root, "portable-home")))).toBe(
      1,
    );
    expect(c.out()).toContain("[action] Portable managed install");
    expect(c.out()).toContain("app/rogue.txt");
    expect(existsSync(shortcut)).toBe(true);
  });

  it("attests a macOS custom managed root from the local record hint", async () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const { home } = await installPortableMacCustom(root);
    const c = makeIo();

    expect(runRepairCli([], c.io, {}, portableRepairDeps(root, home))).toBe(0);
    expect(c.out()).toContain(
      "Portable managed install: attested portable-managed install verified",
    );
    expect(c.out()).toContain(
      "Portable registration: 0 user-local registration artifact(s) verified",
    );
    expect(home).toContain("portable-home");
  });

  it("refuses a locator tampered toward a policy-invalid repository root even when hashes match", async () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const home = makePortableHome();
    const customRoot = join(home, "PortableApps", "Keiko");
    const { managedRoot, shortcut, env } = await installPortableWindows(root, {
      home,
      managedRoot: customRoot,
    });
    const invalidRoot = tamperPortableRecordToRepoRoot(managedRoot, shortcut, join(root, ".keiko"));
    const c = makeIo();

    expect(runRepairCli([], c.io, env, portableRepairDeps(root, home))).toBe(1);
    expect(existsSync(invalidRoot)).toBe(true);
    expect(existsSync(managedRoot)).toBe(true);
    expect(c.out()).toContain("[action] Portable managed install");
    expect(c.out()).toContain("could not be attested");
  });
});

describe("runRepairCli — install layout", () => {
  it("flags a missing build as an action item and exits 1", () => {
    const root = makeRoot();
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[action] Install layout");
  });

  it("accepts a global install reachable via KEIKO_UI_STATIC_ROOT", () => {
    const root = makeRoot();
    const staticRoot = join(root, "global-ui", "static");
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(join(staticRoot, "index.html"), "<html></html>\n", "utf8");
    const c = makeIo();
    // No local layout seeded — the install-layout check must resolve via the env var.
    expect(runRepairCli([], c.io, { KEIKO_UI_STATIC_ROOT: staticRoot }, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("UI static export present");
  });
});

describe("runRepairCli — summary message", () => {
  it("tells the user to apply fixes when --dry-run finds only fixable items", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "ui.pid"), "4242\n", "utf8");
    const c = makeIo();
    expect(runRepairCli(["--dry-run"], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("apply the fixes above");
    expect(c.out()).not.toContain("review the items marked");
  });
});

describe("runRepairCli — launch path", () => {
  it("flags a stale launch binary via the doctor report", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const deps: RepairCliDeps = {
      ...healthyDeps(root),
      argv: [process.execPath, join(root, "some", "other", "stale-keiko")],
    };
    const c = makeIo();
    expect(runRepairCli([], c.io, {}, deps)).toBe(1);
    expect(c.out()).toContain("[action] Launch path");
  });
});

describe("runRepairCli — gateway config", () => {
  it("accepts a valid config file via --config", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "gateway.json");
    writeFileSync(cfg, '{"baseUrl":"https://x"}\n', "utf8");
    const c = makeIo();
    expect(runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("Gateway config: valid JSON");
  });

  it("flags a missing config file as an action item", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const c = makeIo();
    expect(runRepairCli(["--config", join(root, "nope.json")], c.io, {}, healthyDeps(root))).toBe(
      1,
    );
    expect(c.out()).toContain("configured file not found");
  });

  it("flags an invalid-JSON config file as an action item", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "bad.json");
    writeFileSync(cfg, "{not json", "utf8");
    const c = makeIo();
    expect(runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("not valid JSON");
  });

  it("resolves a config file from KEIKO_CONFIG_FILE", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "env-gateway.json");
    writeFileSync(cfg, "{}\n", "utf8");
    const c = makeIo();
    expect(runRepairCli([], c.io, { KEIKO_CONFIG_FILE: cfg }, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("valid JSON");
  });
});

describe("runRepairCli — state dir argument", () => {
  it("honors --state-dir when probing the pid file", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const custom = join(root, "alt-state");
    mkdirSync(custom, { recursive: true, mode: 0o700 });
    writeFileSync(join(custom, "ui.pid"), "4242\n", "utf8");
    const c = makeIo();
    expect(runRepairCli(["--state-dir", custom], c.io, {}, healthyDeps(root))).toBe(0);
    expect(existsSync(join(custom, "ui.pid"))).toBe(false);
  });
});

// ─── checkCredentialStorage ───────────────────────────────────────────────────
//
// Each case passes a dedicated temp config file via `--config <path>` so the
// credential-storage check resolves deterministically, independently of any
// ambient KEIKO_CONFIG_FILE in the test environment. `seedInstalledLayout` and
// `healthyDeps` keep the OTHER repair checks quiet (Install layout stays ok,
// stale-pid/state-dir/launcher/launch-path never produce action items) so we
// can assert on the "[action] Credential storage" / "[ok] Credential storage"
// output line unambiguously.

describe("runRepairCli — credential storage", () => {
  it("reports action-required when a provider has a plaintext apiKey", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "plaintext-key.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "gpt-4o", apiKey: "sk-live-verysecret" }],
      }),
      "utf8",
    );

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("plaintext credentials present");
  });

  it("reports action-required when figma.accessToken is a non-empty string", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "figma-token.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "claude-3", apiKeySecretRef: "cred:claude-3" }],
        figma: { accessToken: "figd_very_secret" },
      }),
      "utf8",
    );

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("plaintext credentials present");
  });

  it("reports action-required when reranker.apiKey is a non-empty string", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "reranker-token.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [],
        reranker: { modelId: "rerank", baseUrl: "https://rerank.example/v1", apiKey: "secret" },
      }),
      "utf8",
    );

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("plaintext credentials present");
  });

  it("reports ok when providers use apiKeySecretRef backed by a vault entry and there is no figma block", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "migrated.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "claude-3", apiKeySecretRef: "cred:claude-3" }],
      }),
      "utf8",
    );
    seedVault(root, ["cred:claude-3"]);

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("no plaintext credentials");
  });

  it("reports action-required when a secret reference has no matching vault entry (interrupted migration)", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "orphaned.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "claude-3", apiKeySecretRef: "cred:claude-3" }],
      }),
      "utf8",
    );
    // No vault store written → the reference is orphaned.

    const c = makeIo();
    const code = runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(code).toBe(1);
    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("no encrypted entry");
  });

  it("reports action-required when the credential vault index is unreadable", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "corrupt-vault.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "claude-3", apiKeySecretRef: "cred:claude-3" }],
      }),
      "utf8",
    );
    mkdirSync(join(root, "credentials"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "credentials", "provider-credentials.vault"), "not-json", "utf8");

    const c = makeIo();
    const code = runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(code).toBe(1);
    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("encrypted credential vault is unreadable");
  });

  it("reports action-required when a reranker secret reference has no matching vault entry", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "reranker-orphaned.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [],
        reranker: { apiKeySecretRef: "model-gateway:reranker" },
      }),
      "utf8",
    );

    const c = makeIo();
    const code = runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(code).toBe(1);
    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("no encrypted entry");
  });

  it("reports ok when reranker apiKeySecretRef is backed by a vault entry", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "reranker-migrated.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [],
        reranker: { apiKeySecretRef: "model-gateway:reranker" },
      }),
      "utf8",
    );
    seedVault(root, ["model-gateway:reranker"]);

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("no plaintext credentials");
  });

  it("reports ok when no --config flag and no KEIKO_CONFIG_FILE env variable are set", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    // Deliberately: no --config arg, no KEIKO_CONFIG_FILE, and no default local config file.
    const c = makeIo();
    runRepairCli([], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("no config file to inspect");
  });

  it("inspects the default local config when no explicit config is set", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const localDir = join(root, ".keiko");
    mkdirSync(localDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(localDir, "keiko.config.json"),
      JSON.stringify({
        providers: [{ modelId: "gpt-4o", apiKey: "sk-default-local-secret" }],
      }),
      "utf8",
    );

    const c = makeIo();
    const code = runRepairCli([], c.io, {}, healthyDeps(root));

    expect(code).toBe(1);
    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("plaintext credentials present");
  });

  it("inspects KEIKO_UI_DATA_DIR/keiko.config.json when no explicit config is set", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const dataDir = join(root, "ui-data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dataDir, "keiko.config.json"),
      JSON.stringify({
        providers: [{ modelId: "gpt-4o", apiKey: "sk-ui-data-secret" }],
      }),
      "utf8",
    );

    const c = makeIo();
    const code = runRepairCli([], c.io, { KEIKO_UI_DATA_DIR: dataDir }, healthyDeps(root));

    expect(code).toBe(1);
    expect(c.out()).toContain("[action] Credential storage");
    expect(c.out()).toContain("plaintext credentials present");
  });

  it("reports ok when the configured config file does not exist on disk", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const absent = join(root, "does-not-exist.json");
    // File is intentionally NOT written.

    const c = makeIo();
    runRepairCli(["--config", absent], c.io, {}, healthyDeps(root));

    // checkGatewayConfig will flag the missing file as [action], but
    // checkCredentialStorage must independently report ok "no config file to inspect".
    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("no config file to inspect");
  });

  it("reports ok (not a duplicate action) when the config file contains invalid JSON", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "broken.json");
    writeFileSync(cfg, "{this is: not json!", "utf8");

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    // The gateway-config check already flags the parse error as [action];
    // checkCredentialStorage must NOT add a second action item — it returns ok.
    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("config not parseable");
  });

  it("reports ok when providers array is empty and figma block is absent", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "empty-providers.json");
    writeFileSync(cfg, JSON.stringify({ providers: [] }), "utf8");

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("no plaintext credentials");
  });

  it("reports ok when figma.accessToken is a whitespace-only string", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "figma-empty.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [],
        figma: { accessToken: "   " },
      }),
      "utf8",
    );

    const c = makeIo();
    runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(c.out()).toContain("[ok] Credential storage");
    expect(c.out()).toContain("no plaintext credentials");
  });

  it("exits 0 for a fully migrated config with apiKeySecretRef references backed by the vault", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "fully-migrated.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "gpt-4o", apiKeySecretRef: "cred:gpt-4o" }],
      }),
      "utf8",
    );
    seedVault(root, ["cred:gpt-4o"]);

    const c = makeIo();
    const code = runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(code).toBe(0);
    expect(c.out()).toContain("[ok] Credential storage");
  });

  it("exits 1 when a plaintext apiKey is the only action item in an otherwise healthy system", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    const cfg = join(root, "plaintext-only.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [{ modelId: "gemini", apiKey: "AIzasecret" }],
      }),
      "utf8",
    );

    const c = makeIo();
    const code = runRepairCli(["--config", cfg], c.io, {}, healthyDeps(root));

    expect(code).toBe(1);
    expect(c.out()).toContain("[action] Credential storage");
  });
});

// ─── checkRuntimeStateArtifacts (Issue #1321) ─────────────────────────────────
//
// Seeds known Keiko-owned artifacts under the state dir with loose (group/world-readable)
// permissions and asserts repair tightens exactly those, never touching customer files.

function seedStateDir(root: string): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(join(stateDir, "evidence", "qi"), { recursive: true });
  chmodSync(stateDir, 0o700);
  return stateDir;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("runRepairCli — runtime state artifacts", () => {
  it("tightens loose permissions on Keiko-owned DB, evidence, and QI artifacts", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    const uiDb = join(stateDir, "keiko-ui.db");
    const evidence = join(stateDir, "evidence", "run-1.json");
    const qi = join(stateDir, "evidence", "qi", "run-1.qi.json");
    writeFileSync(uiDb, "x", "utf8");
    writeFileSync(evidence, "x", "utf8");
    writeFileSync(qi, "x", "utf8");
    chmodSync(uiDb, 0o644);
    chmodSync(evidence, 0o644);
    chmodSync(qi, 0o640);
    chmodSync(join(stateDir, "evidence"), 0o755);

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("[fixed] Runtime state artifacts");
    expect(modeOf(uiDb)).toBe(0o600);
    expect(modeOf(evidence)).toBe(0o600);
    expect(modeOf(qi)).toBe(0o600);
    expect(modeOf(join(stateDir, "evidence"))).toBe(0o700);
  });

  it("tightens the sealed credential and Figma vaults", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    mkdirSync(join(stateDir, "credentials"), { recursive: true });
    mkdirSync(join(stateDir, "evidence", "figma"), { recursive: true });
    const providerVault = join(stateDir, "credentials", "provider-credentials.vault");
    const keyfile = join(stateDir, "credentials", "provider-credentials-vault.key");
    const figmaVault = join(stateDir, "evidence", "figma", "figma-token.vault");
    const figmaKeyfile = join(stateDir, "evidence", "figma", "figma-vault.key");
    const vaultFiles = [providerVault, keyfile, figmaVault, figmaKeyfile];
    for (const p of vaultFiles) writeFileSync(p, "x", "utf8");
    for (const p of vaultFiles) chmodSync(p, 0o644);

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toMatch(/\[fixed\] Runtime state artifacts.*credential vault/);
    for (const p of vaultFiles) expect(modeOf(p)).toBe(0o600);
  });

  it("tightens exact producer temp files while leaving customer temp lookalikes untouched", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    mkdirSync(join(stateDir, "credentials"), { recursive: true });
    const ownedTemp = [
      join(stateDir, "evidence", "run-1.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
      join(stateDir, "evidence", "qi", "run-1.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
      join(stateDir, "credentials", ".secret-vault.1234.deadbeefdeadbeef.tmp"),
    ];
    const customerTemp = [
      join(stateDir, "evidence", "manual export.json.123e4567-e89b-12d3-a456-426614174000.tmp"),
      join(
        stateDir,
        "evidence",
        "qi",
        "debug dump.qi.json.123e4567-e89b-12d3-a456-426614174000.tmp",
      ),
      join(stateDir, "credentials", ".secret-vault.abc.deadbeefdeadbeef.tmp"),
    ];
    for (const p of [...ownedTemp, ...customerTemp]) {
      writeFileSync(p, "x", "utf8");
      chmodSync(p, 0o644);
    }

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    for (const p of ownedTemp) expect(modeOf(p)).toBe(0o600);
    for (const p of customerTemp) expect(modeOf(p)).toBe(0o644);
  });

  it("reports loose artifacts in --dry-run without changing them and exits 1", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    const evidence = join(stateDir, "evidence", "run-1.json");
    writeFileSync(evidence, "x", "utf8");
    chmodSync(evidence, 0o644);

    const c = makeIo();
    expect(runRepairCli(["--dry-run"], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[would-fix] Runtime state artifacts");
    expect(modeOf(evidence)).toBe(0o644);
  });

  it("does not modify a customer file that merely lives under .keiko", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    const evidence = join(stateDir, "evidence", "run-1.json");
    const userFile = join(stateDir, "user-notes.txt");
    writeFileSync(evidence, "x", "utf8");
    writeFileSync(userFile, "x", "utf8");
    chmodSync(evidence, 0o644);
    chmodSync(userFile, 0o644);

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(modeOf(evidence)).toBe(0o600);
    expect(modeOf(userFile)).toBe(0o644); // untouched
  });

  it("refuses a symlinked state root without chmodding the target tree", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const target = join(root, "outside-state");
    const stateDir = join(root, ".keiko");
    mkdirSync(target, { recursive: true });
    const outsideDb = join(target, "keiko-ui.db");
    writeFileSync(outsideDb, "x", "utf8");
    chmodSync(target, 0o755);
    chmodSync(outsideDb, 0o644);
    symlinkSync(target, stateDir, "dir");

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[action] State directory");
    expect(c.out()).toContain("refusing to inspect symlinked state directory");
    expect(modeOf(target)).toBe(0o755);
    expect(modeOf(outsideDb)).toBe(0o644);
  });

  it("refuses a non-directory state root without crashing", () => {
    const root = makeRoot();
    seedInstalledLayout(root);
    writeFileSync(join(root, ".keiko"), "not a directory", "utf8");

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[action] State directory");
    expect(c.out()).toContain("refusing to inspect non-directory state path");
  });

  it("does not chmod customer lookalikes in known state subdirectories", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    mkdirSync(join(stateDir, "credentials"), { recursive: true });
    mkdirSync(join(stateDir, "local-knowledge", "notes"), { recursive: true });
    const knownEvidence = join(stateDir, "evidence", "run-1.json");
    const customerEvidence = join(stateDir, "evidence", "manual export.json");
    const customerQi = join(stateDir, "evidence", "qi", "debug dump.json");
    const customerKey = join(stateDir, "credentials", "backup.key");
    const customerNamespace = join(stateDir, "local-knowledge", "notes");
    for (const p of [knownEvidence, customerEvidence, customerQi, customerKey]) {
      writeFileSync(p, "x", "utf8");
      chmodSync(p, 0o644);
    }
    chmodSync(customerNamespace, 0o755);

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(modeOf(knownEvidence)).toBe(0o600);
    expect(modeOf(customerEvidence)).toBe(0o644);
    expect(modeOf(customerQi)).toBe(0o644);
    expect(modeOf(customerKey)).toBe(0o644);
    expect(modeOf(customerNamespace)).toBe(0o755);
  });

  it("flags a symlink occupying a Keiko-owned path as an action item and exits 1", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    writeFileSync(join(stateDir, "outside-target"), "x", "utf8");
    symlinkSync(join(stateDir, "outside-target"), join(stateDir, "keiko-ui.db"));

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[action] Runtime state artifacts");
    expect(c.out()).toContain("symlink occupies a Keiko-owned path");
  });

  it("flags a hardlink occupying a Keiko-owned path without chmodding the outside file", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = seedStateDir(root);
    const outsideDb = join(root, "outside-db");
    writeFileSync(outsideDb, "x", "utf8");
    chmodSync(outsideDb, 0o644);
    linkSync(outsideDb, join(stateDir, "keiko-ui.db"));

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(1);
    expect(c.out()).toContain("[action] Runtime state artifacts");
    expect(c.out()).toContain("hardlink occupies a Keiko-owned path");
    expect(modeOf(outsideDb)).toBe(0o644);
  });

  it("reports owner-only artifacts as healthy", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    seedInstalledLayout(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);
    const uiDb = join(stateDir, "keiko-ui.db");
    writeFileSync(uiDb, "x", "utf8");
    chmodSync(uiDb, 0o600);

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("owner-only permissions");
  });
});
