import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";

import {
  manualReviewPlan,
  prepareManualReview,
  prepareScenarioFixture,
  targetRoot,
} from "../portable-manual-review.mjs";
import { findPortableMetadataRedactionFailures, PORTABLE_TARGETS } from "../portable-runtime.mjs";

const SCENARIO_COUNT = 17;

const tmpRoots = [];

function tmpReviewRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-manual-review-test-"));
  tmpRoots.push(root);
  return root;
}

function jsonAt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function zipEntryNames(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error !== null || zip === undefined) {
        reject(error);
        return;
      }
      const names = [];
      zip.on("entry", (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.once("end", () => resolve(names));
      zip.once("error", reject);
      zip.readEntry();
    });
  });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("portable manual review harness", () => {
  it("is wired as a build-backed package script", () => {
    const scripts = jsonAt("package.json").scripts;

    expect(scripts["portable:manual-review"]).toContain("npm run build:packages");
    expect(scripts["portable:manual-review"]).toContain("npm run build:ui");
    expect(scripts["portable:manual-review"]).toContain("portable-manual-review.mjs");
  });

  it("plans every first-class target and manual matrix scenario", () => {
    const plan = manualReviewPlan();

    // The current root version may be a release-branch prerelease; the simulated TARGET of a
    // portable manual review is always its stable base.
    expect(plan.currentVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    expect(plan.targetVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(plan.targets.map((target) => target.platformTarget)).toEqual(
      PORTABLE_TARGETS.map((target) => target.platformTarget),
    );
    expect(plan.scenarios).toHaveLength(SCENARIO_COUNT);
    expect(plan.scenarios.map((scenario) => scenario.id)).toContain("happy-update");
    expect(plan.scenarios.map((scenario) => scenario.id)).toContain("bad-checksum");
    expect(plan.scenarios.map((scenario) => scenario.id)).toContain("remediation-required");
    expect(plan.scenarios.map((scenario) => scenario.id)).toContain("legacy-package-manager");
    for (const target of plan.targets) {
      expect(target.scripts).toHaveLength(SCENARIO_COUNT);
    }
  });

  it("prepares executable scenario launchers and redacted review evidence", () => {
    const outDir = tmpReviewRoot();
    const { plan } = prepareManualReview(outDir);

    expect(jsonAt(join(outDir, "manual-review-plan.json"))).toEqual(plan);
    expect(readFileSync(join(outDir, "README.md"), "utf8")).toContain("fake stable");

    const shellPath = join(outDir, "scripts", "start-macos-arm64-happy-update.sh");
    const cmdPath = join(outDir, "scripts", "start-windows-x64-bad-checksum.cmd");
    expect(readFileSync(shellPath, "utf8")).toContain(
      "--target macos-arm64 --scenario happy-update --open",
    );
    expect(readFileSync(cmdPath, "utf8")).toContain(
      "--target windows-x64 --scenario bad-checksum --open",
    );
    expect(statSync(shellPath).mode & 0o111).not.toBe(0);

    const evidence = jsonAt(join(outDir, "prepare-evidence.json"));
    expect(findPortableMetadataRedactionFailures(evidence, "prepareEvidence")).toEqual([]);
  });

  it("creates scenario roots under the canonical temp directory", () => {
    const outDir = tmpReviewRoot();
    const root = targetRoot(outDir, "macos-arm64", "current-release");

    expect(root.startsWith(`${realpathSync(tmpdir())}/`)).toBe(true);
  });

  it("creates an artifact slot for each required release target", () => {
    const outDir = tmpReviewRoot();
    prepareManualReview(outDir);

    for (const target of PORTABLE_TARGETS) {
      expect(existsSync(join(outDir, "artifacts", "current", target.platformTarget))).toBe(true);
    }
  });

  it("creates stager-compatible fake release archives", async () => {
    const root = tmpReviewRoot();
    prepareScenarioFixture(root, "macos-arm64", "happy-update");

    const entries = await zipEntryNames(join(root, "release-assets", "keiko-macos-arm64.zip"));
    expect(entries.some((entry) => entry.endsWith("/"))).toBe(false);
    expect(entries).toContain("Keiko/Keiko.app/Contents/Resources/app/package.json");
  });
});
