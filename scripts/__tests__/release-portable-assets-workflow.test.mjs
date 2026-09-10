import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  resolvePortableAssetsManifest,
  validatePortableAssetsRunSnapshot,
  writeGithubOutput,
} from "../resolve-release-portable-assets.mjs";
import {
  envValue,
  portableReleaseAuthorityFailures,
} from "../check-release-required-workflow-names.mjs";
import {
  redactedWindowsSigningError,
  validateAzureArtifactSigningConfig,
} from "../windows-portable-signing.mjs";

const portableWorkflow = readFileSync(".github/workflows/portable-assets.yml", "utf8");
const portableWorkflowDocument = parse(portableWorkflow);
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");

function workflowJob(name) {
  return portableWorkflowDocument.jobs[name];
}

function namedStep(job, name) {
  const step = job.steps.find((entry) => entry.name === name);
  if (step === undefined) throw new Error(`missing workflow step: ${name}`);
  return step;
}

describe("portable release-trust workflow", () => {
  it("builds and natively smokes all three stable targets without platform signing", () => {
    const stage = workflowJob("stage");
    expect(stage.strategy.matrix.include).toEqual([
      { platform_target: "windows-x64", runner: "windows-latest" },
      { platform_target: "macos-arm64", runner: "macos-15" },
      { platform_target: "macos-x64", runner: "macos-15-intel" },
    ]);
    expect(stage.if).toContain("github.event_name == 'push'");
    expect(namedStep(stage, "Stage stable unsigned runtime for Keiko release trust").run).toContain(
      "--release",
    );
    expect(namedStep(stage, "Functionally smoke the staged USearch addon")).toBeDefined();
    expect(namedStep(stage, "Smoke test the staged artifact")).toBeDefined();
    expect(namedStep(stage, "Functionally smoke the unsigned secure-read helper").run).toContain(
      "--load",
    );
    expect(namedStep(stage, "Build unsigned Windows setup companion").if).toBe(
      "runner.os == 'Windows'",
    );
  });

  it("keeps native signing optional and out of the release authority path", () => {
    expect(Object.keys(portableWorkflowDocument.jobs)).toEqual(["stage", "assemble"]);
    expect(portableWorkflow).not.toMatch(
      /portable-release-signing|AZURE_|APPLE_|artifact-signing-action|notarytool|codesign/u,
    );
    expect(workflowJob("stage").environment).toBeUndefined();
    expect(workflowJob("stage").permissions).toEqual({
      checks: "read",
      contents: "read",
      statuses: "read",
    });
  });

  it("assembles only a complete stable matrix and keeps attestations supplementary", () => {
    const assemble = workflowJob("assemble");
    expect(assemble.needs).toBe("stage");
    expect(assemble.if).toContain("needs.stage.result == 'success'");
    expect(assemble.if).toContain("!contains(github.ref_name, '-')");
    expect(assemble.permissions).toEqual({
      attestations: "write",
      contents: "read",
      "id-token": "write",
    });
    expect(namedStep(assemble, "Upload release-trust candidate bundle").with.name).toBe(
      "portable-release-assets",
    );
    expect(assemble.steps.filter((step) => step.uses?.startsWith("actions/attest@"))).toHaveLength(
      5,
    );
  });

  it("uses the protected publisher as the sole private-key boundary", () => {
    expect(releaseWorkflow).toContain("environment: npm-publish");
    expect(releaseWorkflow).toContain(
      "KEIKO_PORTABLE_RELEASE_SIGNING_KEY: ${{ secrets.KEIKO_PORTABLE_RELEASE_SIGNING_KEY }}",
    );
    expect(portableWorkflow).not.toContain("KEIKO_PORTABLE_RELEASE_SIGNING_KEY");
  });

  it("retains an explicit dispatch-only evaluation lane", () => {
    const input = portableWorkflowDocument.on.workflow_dispatch.inputs.evaluation_build;
    expect(input).toMatchObject({ default: false, required: false, type: "boolean" });
    const stage = workflowJob("stage");
    const evaluation = namedStep(stage, "Stage unsigned evaluation runtime for manual smoke");
    const ordinary = namedStep(stage, "Stage unsigned runtime for manual smoke");
    expect(evaluation.if).toContain("inputs.evaluation_build");
    expect(evaluation.run).toContain("--evaluation");
    expect(ordinary.if).toContain("!inputs.evaluation_build");
    expect(ordinary.run).not.toContain("--evaluation");
  });

  it("pins portable staging to the release workflow authority", () => {
    expect(portableReleaseAuthorityFailures(releaseWorkflow, portableWorkflow)).toEqual([]);
    const releaseBaseBranch = envValue(releaseWorkflow, "RELEASE_BASE_BRANCH");
    expect(releaseBaseBranch).toMatch(/^release\/\d+\.\d+$/u);
    expect(
      portableReleaseAuthorityFailures(
        releaseWorkflow,
        portableWorkflow.replace(releaseBaseBranch, "release/drift"),
      ),
    ).toEqual(["RELEASE_BASE_BRANCH"]);
    expect(
      portableReleaseAuthorityFailures(
        releaseWorkflow,
        portableWorkflow.replace('"ui"]', '"drift"]'),
      ),
    ).toEqual(["RELEASE_REQUIRED_CHECKS"]);
  });
});

let currentRoot;

function root() {
  currentRoot = mkdtempSync(join(tmpdir(), "keiko-release-portable-assets-"));
  return currentRoot;
}

function writeBundleManifest(cwd, name = "portable-assets.json") {
  const bundleRoot = join(cwd, ".portable-release-assets");
  mkdirSync(bundleRoot, { recursive: true });
  const manifestPath = join(bundleRoot, name);
  writeFileSync(manifestPath, '{"schemaVersion":1,"artifacts":[]}\n');
  return manifestPath;
}

function latestEnv(overrides = {}) {
  return {
    NPM_DIST_TAG: "latest",
    PORTABLE_ASSETS_ARTIFACT_NAME: "portable-release-assets",
    PORTABLE_ASSETS_MANIFEST: "",
    PORTABLE_ASSETS_RUN_ATTEMPT: "2",
    PORTABLE_ASSETS_RUN_ID: "123456789",
    ...overrides,
  };
}

describe("release workflow portable asset manifest resolution", () => {
  afterEach(() => {
    if (currentRoot !== undefined) {
      rmSync(currentRoot, { recursive: true, force: true });
      currentRoot = undefined;
    }
  });

  it("rejects incomplete reviewed artifact bundle inputs", () => {
    expect(() =>
      resolvePortableAssetsManifest(
        latestEnv({ PORTABLE_ASSETS_ARTIFACT_NAME: "", PORTABLE_ASSETS_RUN_ID: "123456789" }),
        root(),
      ),
    ).toThrow("portable_assets_run_id and portable_assets_artifact_name must be provided together");
  });

  it("returns the canonical manifest path inside the downloaded artifact bundle", () => {
    const cwd = root();
    const manifestPath = writeBundleManifest(cwd);
    expect(resolvePortableAssetsManifest(latestEnv(), cwd)).toBe(realpathSync(manifestPath));
  });

  it.each([
    ["../x.json", "must not escape the downloaded artifact"],
    ["/tmp/x.json", "must be relative to the downloaded artifact"],
  ])("rejects unsafe manifest path %s", (path, message) => {
    const cwd = root();
    writeBundleManifest(cwd);
    expect(() =>
      resolvePortableAssetsManifest(latestEnv({ PORTABLE_ASSETS_MANIFEST: path }), cwd),
    ).toThrow(message);
  });

  it("rejects directory and symlink manifest inputs", () => {
    const cwd = root();
    const bundleRoot = join(cwd, ".portable-release-assets");
    mkdirSync(join(bundleRoot, "portable-assets.json"), { recursive: true });
    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow("regular file");
    rmSync(join(bundleRoot, "portable-assets.json"), { recursive: true, force: true });
    const outside = join(cwd, "outside.json");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, join(bundleRoot, "portable-assets.json"));
    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow("symbolic link");
  });

  it("writes the resolved manifest to GITHUB_OUTPUT", () => {
    const cwd = root();
    const outputPath = join(cwd, "github-output.txt");
    writeGithubOutput("portable-assets.json", { GITHUB_OUTPUT: outputPath });
    expect(readFileSync(outputPath, "utf8")).toBe("manifest=portable-assets.json\n");
  });
});

describe("portable asset workflow run resolution", () => {
  const config = {
    artifactName: "portable-release-assets",
    releaseTag: "v0.2.15",
    repository: "oscharko-dev/Keiko",
    runAttempt: "2",
    runId: "123456789",
    sha: "a".repeat(40),
  };
  const run = {
    conclusion: "success",
    event: "push",
    head_branch: "v0.2.15",
    head_sha: "a".repeat(40),
    id: 123456789,
    path: ".github/workflows/portable-assets.yml@refs/tags/v0.2.15",
    repository: { full_name: "oscharko-dev/Keiko" },
    run_attempt: 2,
    status: "completed",
  };
  const artifacts = {
    artifacts: [
      { expired: false, id: 777, name: "portable-release-assets", workflow_run: { id: 123456789 } },
    ],
  };

  it("accepts one canonical artifact from the exact successful stable push", () => {
    expect(validatePortableAssetsRunSnapshot(config, run, artifacts)).toEqual({
      artifactId: 777,
      runAttempt: 2,
    });
  });

  it.each([
    ["workflow", { path: ".github/workflows/ci.yml" }, artifacts, "workflow path"],
    ["event", { event: "workflow_dispatch" }, artifacts, "event"],
    ["conclusion", { conclusion: "failure" }, artifacts, "conclusion"],
    ["SHA", { head_sha: "b".repeat(40) }, artifacts, "head SHA"],
    ["attempt", { run_attempt: 3 }, artifacts, "run attempt"],
    ["expired", {}, { artifacts: [{ ...artifacts.artifacts[0], expired: true }] }, "expired"],
  ])("rejects wrong %s metadata", (_name, runPatch, artifactValue, message) => {
    expect(() =>
      validatePortableAssetsRunSnapshot(config, { ...run, ...runPatch }, artifactValue),
    ).toThrow(message);
  });
});

describe("optional Windows Artifact Signing configuration", () => {
  function config(endpoint = "https://eus.codesigning.azure.net/") {
    return {
      AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
      AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222",
      AZURE_SUBSCRIPTION_ID: "33333333-3333-3333-3333-333333333333",
      AZURE_ARTIFACT_SIGNING_ENDPOINT: endpoint,
      AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME: "account",
      AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
      AZURE_ARTIFACT_SIGNING_IDENTITY_EKU: "1.3.6.1.4.1.311.97.12345",
    };
  }

  it("keeps the dormant provider parser strict", () => {
    expect(() => validateAzureArtifactSigningConfig(config())).not.toThrow();
    for (const endpoint of [
      "http://eus.codesigning.azure.net/",
      "https://eus.codesigning.azure.net:443/",
      "https://eus.codesigning.azure.net/path",
      "https://eus.codesigning.azure.net.evil.example/",
    ]) {
      expect(() => validateAzureArtifactSigningConfig(config(endpoint)), endpoint).toThrow(
        /service endpoint is invalid/u,
      );
    }
  });

  it("redacts dormant provider failures", () => {
    const missing = config();
    delete missing.AZURE_CLIENT_ID;
    expect(() => validateAzureArtifactSigningConfig(missing)).toThrow(
      "configuration is incomplete",
    );
    expect(redactedWindowsSigningError(new Error("/private/path secret"))).toBe(
      "windows-portable-signing: redacted failure",
    );
  });
});
