import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  runPortableLaunchSetupSmoke,
  validatePortableLaunchSetupDocs,
} from "../portable-launch-setup-smoke.mjs";

let currentRoot;

function root() {
  const base = join(homedir(), ".keiko-test-roots");
  mkdirSync(base, { recursive: true });
  currentRoot = mkdtempSync(join(base, "portable-launch-setup-test-"));
  return currentRoot;
}

describe("portable launch/setup smoke", () => {
  afterEach(() => {
    if (currentRoot !== undefined) {
      rmSync(currentRoot, { recursive: true, force: true });
      currentRoot = undefined;
    }
  });

  it("proves managed setup and relaunch for every portable target without path node/npm", async () => {
    const dir = root();
    const evidencePath = join(dir, "evidence", "portable-launch-setup-smoke.json");
    mkdirSync(join(dir, "evidence"), { recursive: true });

    const evidence = await runPortableLaunchSetupSmoke(["--evidence", evidencePath], {
      now: new Date("2026-07-06T00:00:00.000Z"),
      tempRoot: dir,
    });

    expect(evidence.fixtureTargets).toHaveLength(3);
    expect(evidence.fixtureTargets.map((target) => target.platformTarget)).toEqual([
      "windows-x64",
      "macos-arm64",
      "macos-x64",
    ]);
    for (const target of evidence.fixtureTargets) {
      expect(target).toMatchObject({
        pathWithoutNodeOrNpm: true,
        relaunchedFromManagedAppRoot: true,
        setupStatus: "managed",
        spawnedManagedLauncher: true,
        updateEligible: true,
      });
    }
    const rendered = readFileSync(evidencePath, "utf8");
    expect(rendered).toContain('"issue": 1953');
    expect(rendered).not.toContain(dir);
  }, 30_000);

  it("keeps the primary portable user journey free of shell commands", () => {
    expect(validatePortableLaunchSetupDocs()).toEqual({
      primaryJourneyShellFree: true,
      troubleshootingHonest: true,
    });
  });
});
