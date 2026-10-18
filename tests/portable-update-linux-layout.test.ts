import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { layoutFor } from "../packages/keiko-cli/src/portable-shared.js";
import { resolvePortableHandoffLayouts } from "../packages/keiko-server/src/update-portable-activation-files.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function install(
  target: "linux-x64" | "macos-arm64",
  root: string,
  version: string,
): ReturnType<typeof layoutFor> {
  const layout = layoutFor(target, root);
  for (const file of [
    layout.packageJsonPath,
    layout.setupManifestPath,
    layout.primaryLauncherPath,
    layout.runtimeSupervisorPath,
  ])
    mkdirSync(dirname(file), { recursive: true });
  writeFileSync(layout.packageJsonPath, JSON.stringify({ name: "@oscharko-dev/keiko", version }));
  writeFileSync(layout.primaryLauncherPath, `synthetic-launcher-${version}`);
  writeFileSync(layout.runtimeSupervisorPath, `synthetic-supervisor-${version}`);
  writeFileSync(
    layout.setupManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      platformTarget: target,
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      primaryLauncher: target === "linux-x64" ? "Keiko" : "Keiko.app",
      bootstrapUpdateEligible: false,
      runtime: {
        nodePlatform: target === "linux-x64" ? "linux" : "darwin",
        nodeArchitecture: target === "linux-x64" ? "x64" : "arm64",
      },
    }),
  );
  return layout;
}
it.each(["linux-x64", "macos-arm64"] as const)(
  "%s activation resolves the current and candidate launcher layouts",
  (target) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-layout-")));
    roots.push(root);
    const managedRoot = join(root, "install", target === "linux-x64" ? "Keiko" : "Keiko.app");
    const current = install(target, managedRoot, "1.2.2");
    const stageRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1");
    const candidate = install(
      target,
      target === "linux-x64" ? join(stageRoot, "Keiko") : join(stageRoot, "Keiko", "Keiko.app"),
      "1.2.3",
    );
    const resolved = resolvePortableHandoffLayouts({
      currentVersion: "1.2.2",
      activationId: "a".repeat(32),
      activation: {
        sessionId: "synthetic-session",
        targetVersion: "1.2.3",
        runtimeFacts: { packageRoot: current.appRoot, portableStateDir: join(root, "state") },
        stage: {
          stageId: "stage-1",
          status: "staged",
          target,
          packageVersion: "1.2.3",
          assetName: `keiko-${target}.zip`,
          assetId: 1,
          releaseId: 2,
          sizeBytes: 3,
          sha256: "b".repeat(64),
          manifestSha256: "c".repeat(64),
        },
      },
    });
    expect(resolved.current.setupManifestPath).toBe(current.setupManifestPath);
    expect(resolved.candidate.setupManifestPath).toBe(candidate.setupManifestPath);
    expect(resolved.currentSupervisorPath).toBe(current.runtimeSupervisorPath);
    expect(resolved.candidateSupervisorPath).toBe(candidate.runtimeSupervisorPath);
  },
);
