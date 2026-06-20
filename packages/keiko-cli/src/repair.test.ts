import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepairCli, type RepairCliDeps } from "./repair.js";
import { runLauncherCli } from "./launcher.js";
import { loadState } from "./launcher-state.js";
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

function makeRoot(): string {
  const root = mkdtempSync(join(REAL_TMPDIR, "keiko-repair-"));
  tempRoots.push(root);
  return root;
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
    for (const p of [providerVault, keyfile, figmaVault]) writeFileSync(p, "x", "utf8");
    for (const p of [providerVault, keyfile, figmaVault]) chmodSync(p, 0o644);

    const c = makeIo();
    expect(runRepairCli([], c.io, {}, healthyDeps(root))).toBe(0);
    expect(c.out()).toContain("credential vault");
    expect(modeOf(providerVault)).toBe(0o600);
    expect(modeOf(keyfile)).toBe(0o600);
    expect(modeOf(figmaVault)).toBe(0o600);
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
