import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepairCli, type RepairCliDeps } from "./repair.js";
import { runLauncherCli } from "./launcher.js";
import { loadState } from "./launcher-state.js";
import type { CliIo } from "./runner.js";

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

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-repair-"));
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
