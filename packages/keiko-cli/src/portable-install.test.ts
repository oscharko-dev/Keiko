import { describe, expect, it } from "vitest";

import {
  attestedExistingPortableInstall,
  portableSourceCanReplaceManaged,
  portableSourceIsNewer,
} from "./portable-install.js";
import type { ValidatedPortableRoot } from "./portable-install.js";

function portable(version: string, target = "windows-x64"): ValidatedPortableRoot {
  return {
    layout: {
      rootKind: "windows-root",
      installRoot: "/user/Keiko",
      resourceRoot: "/user/Keiko",
      appRoot: "/user/Keiko/app",
      packageJsonPath: "/user/Keiko/app/package.json",
      runtimeNodePath: "/user/Keiko/runtime/node/node.exe",
      primaryLauncherPath: "/user/Keiko/Keiko.exe",
      setupManifestPath: "/user/Keiko/.portable/setup-manifest.json",
    },
    manifest: {
      schemaVersion: 1,
      platformTarget: target === "macos-arm64" || target === "macos-x64" ? target : "windows-x64",
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      primaryLauncher: "Keiko.exe",
      bootstrapUpdateEligible: true,
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    },
  };
}

describe("portable install decisions", () => {
  it("fails closed when no target may attest the requested root", () => {
    expect(attestedExistingPortableInstall("/user/.keiko/managed", "/user/.keiko")).toBeUndefined();
  });

  it("accepts only newer or target-corrective portable sources", () => {
    expect(portableSourceIsNewer(portable("0.2.16"), portable("0.2.15"))).toBe(true);
    expect(portableSourceIsNewer(portable("0.2.15"), portable("0.2.15"))).toBe(false);
    expect(
      portableSourceCanReplaceManaged(portable("0.2.15", "macos-arm64"), portable("0.2.15")),
    ).toBe(true);
  });
});
