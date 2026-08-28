import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";

import {
  approvedNodeVersion,
  browserOpenCommand,
  latestManualArtifactRoot,
  manualReviewPlan,
  openBrowserIfRequested,
  portableModeStatus,
  prepareManualReview,
  prepareScenarioFixture,
  targetRoot,
} from "../portable-manual-review.mjs";
import {
  findPortableMetadataRedactionFailures,
  PORTABLE_TARGETS,
  portableTargetByName,
  validatePortablePublishedManifest,
} from "../portable-runtime.mjs";

// Wraps the real spawnSync so every OTHER call in this file (e.g. the manual-review plan's own
// `git rev-parse` lookup) still runs for real; only the "open a browser" test below overrides the
// next call's implementation so this suite never actually launches a real browser process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const SCENARIO_COUNT = 17;
// Deliberately not the committed approval: a manifest carrying this version can only come from the
// approvals document the seam supplied, never from a literal restated in the review script.
const FIXTURE_NODE_VERSION = "26.0.1";
// The cheapest scenario that still writes a full portable manifest — it skips the payload tree and
// zips a single hostile entry instead.
const MANIFEST_ONLY_SCENARIO = "hostile-archive";

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

function committedApprovals() {
  return jsonAt("portable-runtime-approvals.json");
}

function reviewManifest(review, target, scenario) {
  const root = tmpReviewRoot();
  review.prepareScenarioFixture(root, target, scenario);
  return jsonAt(join(root, "release-assets", `${target}-portable-manifest.json`));
}

// Derived from the committed approvals document instead of restating its shape, so this fixture
// cannot keep describing an approvals file that no longer exists. The archive URLs are rewritten
// with it because the shared validator pins every Node archive URL to the version it approves.
function approvalsWithNodeVersion(version) {
  const document = structuredClone(committedApprovals());
  const previous = document.node.version;
  document.node.version = version;
  for (const archive of Object.values(document.node.archives)) {
    archive.url = archive.url.replaceAll(previous, version);
  }
  return document;
}

// Reloads the review script against a substituted approvals document. The seam is the shared
// approvals loader, and the fixture is pushed through the real validator, so this can only supply a
// document the production load path would itself have accepted.
async function importReviewWithApprovals(document) {
  vi.doMock("../portable-runtime-approvals.mjs", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      loadPortableRuntimeApprovals: () => actual.validatePortableRuntimeApprovals(document),
    };
  });
  vi.resetModules();
  return import("../portable-manual-review.mjs");
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
    if (process.platform !== "win32") expect(statSync(shellPath).mode & 0o111).not.toBe(0);

    const evidence = jsonAt(join(outDir, "prepare-evidence.json"));
    expect(findPortableMetadataRedactionFailures(evidence, "prepareEvidence")).toEqual([]);
  });

  it("creates scenario roots under the canonical temp directory", () => {
    const outDir = tmpReviewRoot();
    const root = targetRoot(outDir, "macos-arm64", "current-release");

    expect(root.startsWith(`${realpathSync(tmpdir())}${sep}`)).toBe(true);
  });

  it("creates an artifact slot for each required release target", () => {
    const outDir = tmpReviewRoot();
    prepareManualReview(outDir);

    for (const target of PORTABLE_TARGETS) {
      expect(existsSync(join(outDir, "artifacts", "current", target.platformTarget))).toBe(true);
    }
  });

  it("selects the latest manual artifact root with an explicit stable locale order", () => {
    const runtimeRoot = tmpReviewRoot();
    const earlier = join(runtimeRoot, "manual-2026-07-08T09-00-00Z");
    const later = join(runtimeRoot, "manual-2026-07-10T09-00-00Z");
    mkdirSync(earlier);
    mkdirSync(later);
    mkdirSync(join(runtimeRoot, "unrelated"));

    expect(latestManualArtifactRoot(runtimeRoot)).toBe(later);
  });

  it("creates stager-compatible fake release archives", async () => {
    const root = tmpReviewRoot();
    prepareScenarioFixture(root, "macos-arm64", "happy-update");

    const entries = await zipEntryNames(join(root, "release-assets", "keiko-macos-arm64.zip"));
    expect(entries.some((entry) => entry.endsWith("/"))).toBe(false);
    expect(entries).toContain("Keiko/Keiko.app/Contents/Resources/app/package.json");
    expect(entries).toContain(
      "Keiko/Keiko.app/Contents/Resources/runtime/native/keiko-secure-workspace-read",
    );
  });

  it("generates a valid schema-v2 OpenCode whole-product sidecar manifest", () => {
    const root = tmpReviewRoot();
    prepareScenarioFixture(root, "macos-arm64", "sidecar-present");
    const manifest = jsonAt(join(root, "release-assets", "macos-arm64-portable-manifest.json"));
    const sidecar = manifest.sidecarRuntimes[0];
    const helper = manifest.nativeHelpers[0];

    expect(
      validatePortablePublishedManifest(manifest, {
        releaseId: manifest.release.releaseId,
        assetId: manifest.artifact.assetId,
      }),
    ).toEqual([]);
    expect(sidecar.approvalSchemaVersion).toBe(2);
    expect(sidecar.upstream).toMatchObject({
      owner: "anomalyco",
      repository: "opencode",
      version: "1.17.17",
      commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
    });
    expect(sidecar.protocolSchema.digestInput).toBe("upstream-raw-bytes");
    expect(sidecar.adapterCompatibility.protocolVersion).toBeUndefined();
    expect(sidecar.signing.shippedExecutableTreeSha256).not.toBe(sidecar.executableTreeSha256);
    expect(manifest.releaseImpact.reviewedBinding.sidecarRuntimes).toEqual(
      manifest.sidecarRuntimes,
    );
    expect(helper).toMatchObject({
      name: "keiko-secure-workspace-read",
      platformTarget: "macos-arm64",
      architecture: "arm64",
      executablePath: "runtime/native/keiko-secure-workspace-read",
      sbomBomRef: `pkg:generic/keiko-secure-workspace-read@${manifest.product.packageVersion}?platform=macos-arm64`,
    });
    expect(manifest.releaseImpact.reviewedBinding.nativeHelpers).toEqual(manifest.nativeHelpers);
    expect(manifest.updateEligibility.rollbackSupported).toBe(false);
    expect(JSON.stringify(sidecar)).not.toMatch(/selfUpdate|independentUpdate|rollback/iu);
  });
});

describe("portableModeStatus", () => {
  it("reports bootstrap for an unmanaged-bootstrap install", () => {
    expect(portableModeStatus("unmanaged-bootstrap")).toBe("bootstrap");
  });

  it("reports it-managed for a system-managed install", () => {
    expect(portableModeStatus("system-managed")).toBe("it-managed");
  });

  it("reports managed for every other scenario", () => {
    expect(portableModeStatus("happy-update")).toBe("managed");
  });
});

describe("browserOpenCommand", () => {
  it("uses the macOS opener on darwin", () => {
    expect(browserOpenCommand("darwin")).toBe("/usr/bin/open");
  });

  it("uses the Windows opener on win32", () => {
    expect(browserOpenCommand("win32")).toBe(String.raw`C:\Windows\System32\cmd.exe`);
  });

  it("falls back to xdg-open on every other platform", () => {
    expect(browserOpenCommand("linux")).toBe("/usr/bin/xdg-open");
  });
});

describe("openBrowserIfRequested", () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockClear();
  });

  it("does not spawn anything when open was not requested", () => {
    openBrowserIfRequested("http://127.0.0.1:19830", false);

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("spawns the platform opener with the scenario URL when open was requested", () => {
    vi.mocked(spawnSync).mockImplementationOnce(() => ({ status: 0 }));

    openBrowserIfRequested("http://127.0.0.1:19830", true);

    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [command, args] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe(browserOpenCommand(process.platform));
    expect(args).toContain("http://127.0.0.1:19830");
  });
});

describe("reviewed node runtime", () => {
  afterEach(() => {
    vi.doUnmock("../portable-runtime-approvals.mjs");
    vi.resetModules();
  });

  it("binds review manifests to the node version the approvals document names", async () => {
    const committedVersion = committedApprovals().node.version;
    const review = await importReviewWithApprovals(approvalsWithNodeVersion(FIXTURE_NODE_VERSION));

    const manifest = reviewManifest(review, "macos-arm64", MANIFEST_ONLY_SCENARIO);

    // Guards the de-duplication itself: reintroducing the reviewed node version as a literal in the
    // review script makes both assertions report the committed 24.x patch instead of this fixture.
    expect(FIXTURE_NODE_VERSION).not.toBe(committedVersion);
    expect(manifest.runtime.nodeVersion).toBe(FIXTURE_NODE_VERSION);
    expect(manifest.releaseImpact.reviewedBinding.nodeRuntimeIdentity).toBe(
      `node-v${FIXTURE_NODE_VERSION}-${portableTargetByName("macos-arm64").runtimeTarget}`,
    );
  });

  it("reviews against the committed approval when nothing is substituted", () => {
    const root = tmpReviewRoot();
    prepareScenarioFixture(root, "macos-arm64", MANIFEST_ONLY_SCENARIO);
    const manifest = jsonAt(join(root, "release-assets", "macos-arm64-portable-manifest.json"));

    expect(manifest.runtime.nodeVersion).toBe(committedApprovals().node.version);
  });
});

describe("approvedNodeVersion", () => {
  it("returns the version the approvals document approved", () => {
    expect(approvedNodeVersion({ node: { version: "26.0.1" } })).toBe("26.0.1");
  });

  it("fails closed when the approvals document has no node section", () => {
    expect(() => approvedNodeVersion({})).toThrow(/approved node version is missing/u);
  });

  it("fails closed when there is no approvals document at all", () => {
    expect(() => approvedNodeVersion(undefined)).toThrow(/approved node version is missing/u);
  });

  it("fails closed on an empty approved version instead of reviewing against nothing", () => {
    expect(() => approvedNodeVersion({ node: { version: "" } })).toThrow(
      /approved node version is missing/u,
    );
  });

  it("fails closed when the approved version is not a string", () => {
    expect(() => approvedNodeVersion({ node: { version: 24 } })).toThrow(
      /approved node version is missing/u,
    );
  });
});
