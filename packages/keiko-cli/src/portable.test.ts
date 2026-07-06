import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runPortableCli } from "./portable.js";
import { readPortableInstallRegistration } from "./portable-registration.js";

type PortableTarget = "windows-x64" | "macos-arm64" | "macos-x64";

const roots: string[] = [];
const NOW = new Date("2026-07-06T00:00:00.000Z");

function tempRoot(): string {
  const base = join(homedir(), ".keiko-test-roots");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "portable-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function capture(): {
  readonly io: { readonly out: (text: string) => void; readonly err: (text: string) => void };
  readonly out: () => string;
  readonly err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      out: (text: string): void => {
        stdout += text;
      },
      err: (text: string): void => {
        stderr += text;
      },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

function setupManifest(target: PortableTarget, version = "0.2.11"): string {
  const runtime =
    target === "windows-x64"
      ? { nodePlatform: "win32", nodeArchitecture: "x64" }
      : {
          nodePlatform: "darwin",
          nodeArchitecture: target === "macos-arm64" ? "arm64" : "x64",
        };
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      platformTarget: target,
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      primaryLauncher: target === "windows-x64" ? "Keiko.exe" : "Keiko.app",
      bootstrapUpdateEligible: false,
      runtime,
    },
    null,
    2,
  )}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeApp(appRoot: string, version = "0.2.11"): void {
  mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "@oscharko-dev/keiko", version }, null, 2)}\n`,
  );
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "fixture cli\n");
}

function writeWindowsFixture(root: string, version = "0.2.11"): void {
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  writeApp(join(root, "app"), version);
  writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
  writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
  writeFileSync(join(root, ".portable", "setup-manifest.json"), setupManifest("windows-x64"));
}

function writeMacFixture(root: string, target: "macos-arm64" | "macos-x64"): string {
  const app = join(root, "Keiko.app");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
  mkdirSync(join(resources, ".portable"), { recursive: true });
  writeApp(join(resources, "app"));
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(app, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(join(resources, ".portable", "setup-manifest.json"), setupManifest(target));
  return app;
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

function registration(stateDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(stateDir, "portable-install-state.json"), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new Error("portable registration is malformed");
  }
  return parsed;
}

describe("runPortableCli", () => {
  it("creates the Windows Start Menu shortcut only during explicit setup and targets the managed install", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const env = windowsPortableEnv(home);
    const managedRoot = join(env.LOCALAPPDATA, "Programs", "Keiko");
    const shortcut = join(
      env.APPDATA,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Keiko.bat",
    );
    writeWindowsFixture(source);
    const c = capture();

    expect(existsSync(shortcut)).toBe(false);

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(existsSync(shortcut)).toBe(true);
    expect(readFileSync(shortcut, "utf8")).toContain(join(managedRoot, "Keiko.exe"));
  });

  it("promotes a Windows bootstrap payload into a managed root and records content-free state", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);
    const c = capture();

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(existsSync(join(managedRoot, "Keiko.exe"))).toBe(true);
    expect(registration(stateDir)).toMatchObject({
      schemaVersion: 1,
      status: "managed",
      updateEligible: true,
      platformTarget: "windows-x64",
      packageVersion: "0.2.11",
      stable: true,
    });
    expect(readFileSync(join(stateDir, "portable-install-state.json"), "utf8")).not.toContain(root);
  });

  it("stores a home-relative managed-root locator for a custom Windows managed root", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "PortableApps", "Keiko");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);

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
        stateDir,
      ],
      capture().io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(readPortableInstallRegistration(stateDir)).toMatchObject({
      status: "managed",
      managedRootLocator: {
        kind: "home-relative",
        path: "PortableApps/Keiko",
      },
    });
  });

  it("ignores hostile managed-root locators when reading portable install state", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    for (const managedRootLocator of [
      { kind: "home-relative", path: "../escape" },
      { kind: "home-relative", path: "/tmp/Keiko" },
      { kind: "absolute-local", path: "PortableApps/Keiko" },
    ]) {
      writeFileSync(
        join(stateDir, "portable-install-state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            status: "managed",
            updateEligible: true,
            platformTarget: "windows-x64",
            packageVersion: "0.2.11",
            stable: true,
            managedRootLocator,
            updatedAt: NOW.toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      const registration = readPortableInstallRegistration(stateDir);
      expect(registration?.status).toBe("managed");
      expect(registration?.status === "managed" ? registration.managedRootLocator : undefined).toBe(
        undefined,
      );
    }
  });

  it("creates the macOS user-local app only during explicit setup", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const managedRoot = join(home, "Applications", "Keiko.app");
    const stateDir = join(root, "state");
    writeMacFixture(source, "macos-x64");
    const c = capture();

    expect(existsSync(managedRoot)).toBe(false);

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
        stateDir,
      ],
      c.io,
      {},
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(0);
    expect(existsSync(join(managedRoot, "Contents", "MacOS", "Keiko"))).toBe(true);
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      platformTarget: "macos-x64",
      updateEligible: true,
    });
  });

  it("records setup-failed as not update eligible when validation fails", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    writeWindowsFixture(source, "0.2.10");
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(root, "managed", "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("portable app package version mismatch");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      platformTarget: "windows-x64",
    });
  });

  it("keeps failed setup registration content-free when filesystem validation fails", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    writeWindowsFixture(source);
    rmSync(join(source, "runtime", "node", "node.exe"), { force: true });
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(root, "managed", "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    const state = readFileSync(join(stateDir, "portable-install-state.json"), "utf8");
    expect(code).toBe(1);
    expect(c.err()).toContain("missing portable bundled Node runtime");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      failureReason: "runtime-invalid",
    });
    expect(state).not.toContain(root);
  });

  it("refuses a symlinked portable install record during setup without overwriting the symlink target", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(env.LOCALAPPDATA, "Programs", "Keiko");
    const stateDir = join(root, "state");
    const outside = join(root, "outside-record.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(outside, "keep-me\n", "utf8");
    symlinkSync(outside, join(stateDir, "portable-install-state.json"));
    writeWindowsFixture(source);
    const c = capture();

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("portable install record refuses symlinked state file");
    expect(readFileSync(outside, "utf8")).toBe("keep-me\n");
  });

  it("refuses to read a symlinked portable install record", () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    const outside = join(root, "outside-record.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(outside, "{}\n", "utf8");
    symlinkSync(outside, join(stateDir, "portable-install-state.json"));

    expect(() => readPortableInstallRegistration(stateDir)).toThrow(
      "portable install record refuses symlinked state file",
    );
  });

  it("classifies an unpromoted macOS app bundle as unmanaged", async () => {
    const root = tempRoot();
    const app = writeMacFixture(join(root, "bootstrap"), "macos-x64");
    const c = capture();

    const code = await runPortableCli(
      [
        "status",
        "--target",
        "macos-x64",
        "--portable-root",
        app,
        "--managed-root",
        join(root, "Applications", "Keiko.app"),
        "--state-dir",
        join(root, "state"),
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({
      status: "unmanaged",
      updateEligible: false,
      platformTarget: "macos-x64",
    });
  });

  it("does not mark a same-path managed root update-eligible before setup attestation", async () => {
    const root = tempRoot();
    const managedRoot = join(root, "managed", "Keiko");
    const c = capture();
    writeWindowsFixture(managedRoot);

    const code = await runPortableCli(
      [
        "status",
        "--target",
        "windows-x64",
        "--portable-root",
        managedRoot,
        "--managed-root",
        managedRoot,
        "--state-dir",
        join(root, "state"),
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({
      status: "unmanaged",
      updateEligible: false,
      platformTarget: "windows-x64",
    });
  });

  it("launches by promoting the bootstrap payload, writing content-free state, and handing off to the managed launcher", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    const c = capture();
    const spawns: {
      command: string;
      args: readonly string[];
      options: SpawnOptions;
    }[] = [];
    writeWindowsFixture(source);

    const code = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      c.io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: (command, args, options) => {
          spawns.push({ command, args, options });
          return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        },
      },
    );

    expect(code).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      command: join(managedRoot, "Keiko.exe"),
      args: [],
      options: { detached: true, stdio: "ignore" },
    });
    expect(registration(stateDir)).toMatchObject({
      status: "managed",
      updateEligible: true,
      platformTarget: "windows-x64",
    });
    expect(readFileSync(join(stateDir, "portable-install-state.json"), "utf8")).not.toContain(root);
  });

  it("launches the existing managed install when the bootstrap launcher is clicked after setup", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(home, "managed", "Keiko");
    const stateDir = join(root, "state");
    const spawns: string[] = [];
    const lifecycleStarts: string[] = [];
    writeWindowsFixture(source);

    const first = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      capture().io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        spawnFn: (command) => {
          spawns.push(command);
          return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        },
      },
    );
    const secondCapture = capture();

    const second = await runPortableCli(
      [
        "launch",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        managedRoot,
        "--state-dir",
        stateDir,
      ],
      secondCapture.io,
      env,
      {
        homedir: () => home,
        now: () => NOW,
        lifecycleFn: (_command, _args, _io, _env, deps) => {
          lifecycleStarts.push(deps.cwd);
          return Promise.resolve(0);
        },
      },
    );

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(spawns).toEqual([join(managedRoot, "Keiko.exe")]);
    expect(lifecycleStarts).toEqual([join(managedRoot, "app")]);
    expect(secondCapture.err()).not.toContain("already exists");
  });

  it("rejects managed roots that pass through a symlinked ancestor before copying", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const symlinkTarget = join(root, "state", ".keiko", "managed-parent");
    const symlinkParent = join(root, "managed-link");
    writeWindowsFixture(source);
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, symlinkParent, "dir");
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(symlinkParent, "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("managed install root must not use symlinked ancestors");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      failureReason: "managed-root-symlink",
    });
    expect(existsSync(join(symlinkTarget, "Keiko"))).toBe(false);
  });

  it("rejects managed roots inside repository directories before copying", async () => {
    const root = tempRoot();
    const source = join(root, "bootstrap");
    const stateDir = join(root, "state");
    const repoRoot = join(root, "customer-repo");
    writeWindowsFixture(source);
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const c = capture();

    const code = await runPortableCli(
      [
        "setup",
        "--target",
        "windows-x64",
        "--portable-root",
        source,
        "--managed-root",
        join(repoRoot, "Keiko"),
        "--state-dir",
        stateDir,
      ],
      c.io,
      {},
      { now: () => NOW },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("managed install root must be outside customer repositories");
    expect(registration(stateDir)).toMatchObject({
      status: "setup-failed",
      updateEligible: false,
      failureReason: "setup-failed",
    });
    expect(existsSync(join(repoRoot, "Keiko"))).toBe(false);
  });

  it("refuses a symlinked Start Menu ancestor during setup without creating outside artifacts", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const home = join(root, "home");
    const source = join(root, "bootstrap");
    const env = windowsPortableEnv(home);
    const managedRoot = join(env.LOCALAPPDATA, "Programs", "Keiko");
    const stateDir = join(root, "state");
    const programsDir = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
    const outsidePrograms = join(root, "outside-programs");
    mkdirSync(outsidePrograms, { recursive: true });
    mkdirSync(join(programsDir, ".."), { recursive: true });
    rmSync(programsDir, { recursive: true, force: true });
    symlinkSync(outsidePrograms, programsDir, "dir");
    writeWindowsFixture(source);
    const c = capture();

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
        stateDir,
      ],
      c.io,
      env,
      { homedir: () => home, now: () => NOW },
    );

    expect(code).toBe(1);
    expect(existsSync(join(outsidePrograms, "Keiko.bat"))).toBe(false);
    expect(existsSync(managedRoot)).toBe(false);
    expect(c.err()).toContain("portable registration refused symlinked ancestor");
  });
});
