import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPortableCli, type PortableSetupDeps } from "./portable.js";

// `keiko portable launch --in-place` starts a portable payload where it was unpacked (ADR-0121 D9):
// a standalone folder package must run without the managed setup, which copies Keiko into a system
// location and registers it. These tests drive the real command against a real payload on disk and
// observe what reaches `keiko start`, and what does not reach the disk.

// The name the server's install-mode detection reads (keiko-server update-portable-install-mode.ts,
// pinned there by update-install-mode.test.ts). A literal on purpose: both sides must keep it.
const PORTABLE_MANAGEMENT_ENV = "KEIKO_PORTABLE_MANAGEMENT";

type Target = "windows-x64" | "macos-arm64";
type LifecycleFn = NonNullable<PortableSetupDeps["lifecycleFn"]>;
type LifecycleCall = Parameters<LifecycleFn>;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const base = join(homedir(), ".keiko-test-roots");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "portable-in-place-"));
  roots.push(root);
  return root;
}

function setupManifest(target: Target): string {
  const windows = target === "windows-x64";
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      platformTarget: target,
      packageName: "@oscharko-dev/keiko",
      packageVersion: "1.2.3",
      stable: true,
      primaryLauncher: windows ? "Keiko.exe" : "Keiko.app",
      bootstrapUpdateEligible: false,
      runtime: windows
        ? { nodePlatform: "win32", nodeArchitecture: "x64" }
        : { nodePlatform: "darwin", nodeArchitecture: "arm64" },
    },
    null,
    2,
  )}\n`;
}

function writeApp(appRoot: string): void {
  mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "@oscharko-dev/keiko", version: "1.2.3" })}\n`,
  );
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "fixture cli\n");
}

/** Writes a portable payload and returns its resource root (where `app` and `runtime` live). */
function writePayload(root: string, target: Target): string {
  if (target === "windows-x64") {
    mkdirSync(join(root, "runtime", "node"), { recursive: true });
    mkdirSync(join(root, ".portable"), { recursive: true });
    writeApp(join(root, "app"));
    writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
    writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
    writeFileSync(join(root, ".portable", "setup-manifest.json"), setupManifest(target));
    return root;
  }
  const app = join(root, "Keiko.app");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
  mkdirSync(join(resources, ".portable"), { recursive: true });
  writeApp(join(resources, "app"));
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(app, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(join(resources, ".portable", "setup-manifest.json"), setupManifest(target));
  return resources;
}

interface Launch {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly calls: LifecycleCall[];
  readonly home: string;
  readonly payload: string;
  readonly resources: string;
  readonly stateDir: string;
}

async function launch(
  target: Target,
  extraArgs: readonly string[] = [],
  env: Record<string, string> = {},
  command = "launch",
): Promise<Launch> {
  const home = tempHome();
  const payload = join(home, "Downloads", "Keiko", "system", "Keiko");
  mkdirSync(payload, { recursive: true });
  const resources = writePayload(payload, target);
  const stateDir = join(home, ".keiko-standalone");
  const calls: LifecycleCall[] = [];
  let out = "";
  let err = "";
  const code = await runPortableCli(
    [
      command,
      "--target",
      target,
      "--portable-root",
      payload,
      "--state-dir",
      stateDir,
      ...extraArgs,
    ],
    { out: (text) => void (out += text), err: (text) => void (err += text) },
    env,
    {
      cwd: home,
      homedir: () => home,
      platform: () => (target === "windows-x64" ? "win32" : "darwin"),
      arch: () => (target === "windows-x64" ? "x64" : "arm64"),
      activateMacosRuntimeFn: () => Promise.resolve("waived-unsigned" as const),
      lifecycleFn: (...call) => {
        calls.push(call);
        return Promise.resolve(0);
      },
      // A managed launch consults update recovery and may relaunch through the managed launcher;
      // an in-place launch must reach neither.
      recoverNormalStartupFn: () => Promise.reject(new Error("recovery must not be consulted")),
      spawnFn: () => {
        throw new Error("the managed launcher must not be spawned");
      },
    },
  );
  return { code, out, err, calls, home, payload, resources, stateDir };
}

describe.each(["macos-arm64", "windows-x64"] as const)(
  "portable launch --in-place on %s",
  (target) => {
    it("starts Keiko from the payload without copying or registering anything", async () => {
      const result = await launch(target, ["--in-place"]);

      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(result.calls).toHaveLength(1);
      const [command, args, , env, deps] = result.calls[0] ?? [];
      expect(command).toBe("start");
      expect(args).toEqual(["--open", "--state-dir", result.stateDir]);
      expect(deps?.cwd).toBe(join(result.resources, "app"));
      // The UI process learns that this install is managed outside the app.
      expect(env?.[PORTABLE_MANAGEMENT_ENV]).toBe("organization-managed");
      // No managed root, no registration: the home holds the unpacked folder and nothing else.
      expect(readdirSync(result.home).sort()).toEqual(["Downloads"]);
      expect(existsSync(join(result.stateDir, "portable-install-state.json"))).toBe(false);
    });

    it("hands the administrator's configuration to keiko start", async () => {
      const result = await launch(target, ["--in-place", "--provisioned-config", "team.json"]);

      expect(result.code).toBe(0);
      const [, args] = result.calls[0] ?? [];
      expect(args).toEqual([
        "--open",
        "--state-dir",
        result.stateDir,
        "--provisioned-config",
        join(result.home, "team.json"),
      ]);
    });

    it("refuses a payload whose setup manifest is missing instead of starting it", async () => {
      const home = tempHome();
      const payload = join(home, "Keiko");
      const resources = writePayload(payload, target);
      rmSync(join(resources, ".portable"), { recursive: true });
      const calls: LifecycleCall[] = [];
      let err = "";

      const code = await runPortableCli(
        ["launch", "--target", target, "--portable-root", payload, "--in-place"],
        { out: () => undefined, err: (text) => void (err += text) },
        {},
        {
          cwd: home,
          homedir: () => home,
          lifecycleFn: (...call) => {
            calls.push(call);
            return Promise.resolve(0);
          },
        },
      );

      expect(code).toBe(1);
      expect(err).toContain("portable setup manifest is unavailable");
      expect(calls).toHaveLength(0);
    });
  },
);

describe("the in-place flags are part of launch only", () => {
  it("does not let a caller's declaration replace the in-place one", async () => {
    const result = await launch("macos-arm64", ["--in-place"], {
      [PORTABLE_MANAGEMENT_ENV]: "user-local",
    });

    const [, , , env] = result.calls[0] ?? [];
    expect(env?.[PORTABLE_MANAGEMENT_ENV]).toBe("organization-managed");
  });

  it("refuses --in-place for setup", async () => {
    const result = await launch("macos-arm64", ["--in-place"], {}, "setup");

    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage:");
    expect(result.calls).toHaveLength(0);
  });

  it("refuses a provisioned configuration without --in-place", async () => {
    const result = await launch("macos-arm64", ["--provisioned-config", "team.json"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage:");
    expect(result.calls).toHaveLength(0);
  });
});
