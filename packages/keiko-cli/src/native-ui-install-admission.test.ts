import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveManagedNativeUiRuntime } from "./native-ui-runtime.js";
import { writeManagedRegistration } from "./portable-registration.js";
import {
  PACKAGE_NAME,
  layoutFor,
  primaryLauncherName,
  targetRuntime,
  type PortableLayout,
  type PortableTarget,
} from "./portable-shared.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(target: PortableTarget): {
  readonly home: string;
  readonly stateDir: string;
  readonly layout: PortableLayout;
} {
  const home = mkdtempSync(join(homedir(), ".keiko-native-admission-"));
  roots.push(home);
  const stateDir = join(home, "state");
  const layout = layoutFor(target, join(home, "managed"));
  const manifest = {
    schemaVersion: 1,
    platformTarget: target,
    packageName: PACKAGE_NAME,
    packageVersion: "1.2.5",
    stable: true,
    primaryLauncher: primaryLauncherName(target),
    bootstrapUpdateEligible: false,
    runtime: targetRuntime(target),
  } as const;
  for (const [path, content] of [
    [layout.packageJsonPath, JSON.stringify({ name: PACKAGE_NAME, version: "1.2.5" })],
    [layout.setupManifestPath, JSON.stringify(manifest)],
    [layout.runtimeNodePath, "fixture-node"],
    [layout.primaryLauncherPath, "fixture-launcher"],
    [layout.runtimeSupervisorPath, "fixture-supervisor"],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  writeManagedRegistration({ stateDir, layout, manifest, env: {}, home, now: new Date() });
  return { home, stateDir, layout };
}

it.each([
  ["linux-x64", "linux"],
  ["macos-arm64", "darwin"],
  ["macos-x64", "darwin"],
] as const)("admits the attested %s application on %s", async (target, platform) => {
  const { home, stateDir, layout } = fixture(target);
  await expect(resolveManagedNativeUiRuntime(stateDir, {}, home, platform)).resolves.toMatchObject({
    launcherPath: layout.primaryLauncherPath,
    supervisorPath: layout.runtimeSupervisorPath,
    nodePath: layout.runtimeNodePath,
  });
});

it.each([
  ["linux-x64", "darwin"],
  ["macos-arm64", "linux"],
  ["windows-x64", "linux"],
] as const)("does not adopt a foreign %s application on %s", async (target, platform) => {
  const { home, stateDir } = fixture(target);
  await expect(
    resolveManagedNativeUiRuntime(stateDir, {}, home, platform),
  ).resolves.toBeUndefined();
});

it("refuses a managed registration whose installed launcher has changed", async () => {
  const { home, stateDir, layout } = fixture("macos-arm64");
  writeFileSync(layout.primaryLauncherPath, "changed-launcher");
  await expect(resolveManagedNativeUiRuntime(stateDir, {}, home, "darwin")).rejects.toThrow(
    "native-ui-install-attestation-unavailable",
  );
});

it("does not claim native ownership without a portable registration", async () => {
  const { home, stateDir } = fixture("linux-x64");
  rmSync(join(stateDir, "portable-install-state.json"));
  await expect(resolveManagedNativeUiRuntime(stateDir, {}, home, "linux")).resolves.toBeUndefined();
});

it("does not use POSIX ownership on Windows", async () => {
  const { home, stateDir } = fixture("linux-x64");
  await expect(resolveManagedNativeUiRuntime(stateDir, {}, home, "win32")).resolves.toBeUndefined();
});

it.each(["corrupt", "setup-failed"])("does not adopt a %s registration", async (kind) => {
  const { home, stateDir } = fixture("linux-x64");
  writeFileSync(
    join(stateDir, "portable-install-state.json"),
    kind === "corrupt"
      ? "{"
      : JSON.stringify({
          schemaVersion: 1,
          status: "setup-failed",
          updateEligible: false,
          platformTarget: "linux-x64",
          packageVersion: "1.2.5",
          stable: true,
          updatedAt: new Date().toISOString(),
        }),
  );
  await expect(resolveManagedNativeUiRuntime(stateDir, {}, home, "linux")).resolves.toBeUndefined();
});
