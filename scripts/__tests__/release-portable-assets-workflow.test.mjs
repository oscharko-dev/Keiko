import { spawnSync } from "node:child_process";
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

const hasPowerShell =
  spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;

const portableWorkflow = readFileSync(".github/workflows/portable-assets.yml", "utf8");
const portableWorkflowDocument = parse(portableWorkflow);
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const windowsVerifier = readFileSync("scripts/verify-windows-portable-signing.ps1", "utf8");
const windowsSetupVerifier = readFileSync(
  "scripts/verify-windows-portable-setup-signing.ps1",
  "utf8",
);
const windowsNativePolicy = readFileSync("scripts/windows-portable-native-policy.ps1", "utf8");
const secureReadSmoke = readFileSync("scripts/portable-secure-read-smoke.mjs", "utf8");
const secureReadHarness = readFileSync("native/secure-workspace-read/test-protocol.mjs", "utf8");
const secureReadNative = readFileSync(
  "native/secure-workspace-read/secure_workspace_read.c",
  "utf8",
);

describe("portable secure-read qualification", () => {
  it("functionally smokes unsigned and fresh signed helpers on all three native runners", () => {
    expect(
      portableWorkflow.match(/Functionally smoke the unsigned secure-read helper/gmu),
    ).toHaveLength(3);
    expect(
      portableWorkflow.match(/Functionally requalify the signed secure-read helper/gmu),
    ).toHaveLength(2);
    expect(portableWorkflow.match(/smoke:portable-secure-read -- .* --load/gmu)).toHaveLength(5);
    expect(portableWorkflow).toContain(".qualified-windows-stage/windows-x64 windows-x64");
    expect(portableWorkflow).toContain(
      ".isolated-macos-artifact/${{ matrix.platform_target }} ${{ matrix.platform_target }}",
    );
  });

  it("qualifies the complete Windows denied-name matrix and bounded real-helper load", () => {
    for (const denied of [
      '"CON"',
      '"NUL.txt"',
      '"COM1"',
      '"LPT9.log"',
      '"CLOCK$"',
      '"GLOBALROOT"',
      '"DEVICE"',
      '"??"',
      '"src/safe.txt:stream"',
      '"name?"',
      '"name."',
      '"name "',
      '"PROGRA~1"',
    ]) {
      expect(secureReadSmoke).toContain(denied);
    }
    expect(secureReadSmoke).toContain("index < 1_000");
    expect(secureReadSmoke).toContain("length: 100");
    expect(secureReadSmoke).toContain("await runBounded(");
    expect(secureReadSmoke).toContain("    8,");
    expect(secureReadSmoke).toContain("maxInFlight > 8");
    expect(secureReadSmoke).toContain("assertExactRead(await runDecoded(executable, frame))");
    expect(
      secureReadSmoke.indexOf("assertExactRead(await runDecoded(executable, frame))"),
    ).toBeLessThan(
      secureReadSmoke.indexOf("const before = await stableResourceCount(nodePlatform)"),
    );
    expect(secureReadSmoke).toContain("p95 > 500");
    expect(secureReadSmoke).toContain("after !== before");
    expect(secureReadSmoke).toContain("HandleCount");
    expect(secureReadSmoke).toContain('readdir("/dev/fd")');
  });

  it("runs the executable adversarial harness on unsigned builds and signed native bytes", () => {
    expect(
      portableWorkflow.match(/Run executable secure-read adversarial harness/gmu),
    ).toHaveLength(3);
    expect(
      portableWorkflow.match(/Run signed secure-read executable consistency harness/gmu),
    ).toHaveLength(2);
    expect(portableWorkflow).toContain(
      "test-protocol.mjs --binary .qualified-windows-stage/windows-x64/payload/Keiko/runtime/native/keiko-secure-workspace-read.exe",
    );
    expect(portableWorkflow).toContain(
      "test-protocol.mjs --binary .isolated-macos-artifact/${{ matrix.platform_target }}/payload/Keiko/Keiko.app/Contents/Resources/runtime/native/keiko-secure-workspace-read",
    );
    const windowsStage = workflowJob("  stage-windows-production:", "\n  stage-macos-production:");
    expect(windowsStage.indexOf("Configure MSVC environment")).toBeLessThan(
      windowsStage.indexOf("Run executable secure-read adversarial harness"),
    );
    expect(secureReadHarness).toContain('const compiler = isWindows ? "cl" : "xcrun"');
    expect(secureReadHarness).toContain('argv[0] !== "--binary"');
    expect(secureReadHarness).toContain("spawn(binary, [], { stdio, env: {} })");
    expect(secureReadHarness).toContain('["EACCES", "EBUSY", "EPERM"]');
    expect(secureReadHarness).toContain('isWindows ? "junction" : "file"');
    expect(secureReadHarness).toContain('request(fixture, "nested"))).status, isWindows ? 4 : 5');
    expect(secureReadHarness).toContain(
      "if (pausedBinary !== undefined) await assertAdversarialRaces(pausedBinary, fixture)",
    );
    expect(secureReadHarness).toContain(
      "binaryRoot = externalBinary === undefined ? await mkdtemp",
    );
    expect(secureReadHarness).toContain(
      "if (externalBinary !== undefined) await assertExternalBinaryConsistency(binary, fixture, outside)",
    );
    expect(secureReadHarness).toContain("postSpawnAttempts > 0");
    expect(secureReadHarness).toContain("assertFileGenerationConsistency(binary, fixture)");
    expect(secureReadHarness).toContain("assertAncestorAliasConsistency(binary, fixture, outside)");
    expect(secureReadHarness).toContain("await restoreRename(parent, alias)");
    expect(secureReadHarness).toContain("await restoreRename(parked, parent)");
    expect(secureReadHarness).toContain("harness modified supplied binary");
    expect(secureReadHarness).toContain("[0, 6, 8].includes(decoded.status)");
    expect(secureReadHarness).toContain("failure must be content-free");
    expect(secureReadHarness).toContain(
      "replacement: root mutation before denied target rename must close",
    );
    expect(secureReadHarness).not.toContain(
      "if (result.mutationDenied) assert.equal(decoded.status, 0)",
    );
    for (const denied of [
      "CON",
      "con.txt",
      "PRN",
      "AUX.log",
      "NUL.txt",
      "CONIN$",
      "conin$.txt",
      "CONOUT$",
      "conout$.log",
      "COM1",
      "COM9.log",
      "COM¹",
      "com¹.txt",
      "COM²",
      "com².log",
      "COM³",
      "com³.txt",
      "LPT1",
      "LPT9.log",
      "LPT¹",
      "lpt¹.txt",
      "LPT²",
      "lpt².log",
      "LPT³",
      "lpt³.txt",
      "CLOCK$",
      "GLOBALROOT",
      "GLOBALROOT.txt",
      "DEVICE",
      "DEVICE.log",
      "??",
    ]) {
      expect(secureReadHarness).toContain(JSON.stringify(denied));
    }
    for (const allowed of [
      "GLOBALROOTED",
      "CONSOLE",
      "DEVICEFUL",
      "CLOCK$X",
      "COM10",
      "LPT10",
      "CONIN$X",
      "CONOUT$X",
      "COM¹0",
      "LPT²X",
    ]) {
      expect(secureReadHarness).toContain(JSON.stringify(allowed));
    }
    expect(secureReadHarness).toContain("Windows reserved-name policy mismatch");
    for (const stem of [
      "CON",
      "PRN",
      "AUX",
      "NUL",
      "CONIN$",
      "CONOUT$",
      "COM",
      "LPT",
      "CLOCK$",
      "GLOBALROOT",
      "DEVICE",
      "??",
    ]) {
      expect(secureReadNative).toContain(`"${stem}"`);
    }
    expect(secureReadNative).toMatch(
      /while \(name_length < length && component\[name_length\] != '\.'\)/u,
    );
    expect(secureReadNative).toContain('ascii_name_equals(component, name_length, "GLOBALROOT")');
    expect(secureReadNative).toContain("windows_reserved_port_name(component, name_length)");
    expect(secureReadNative).toContain("bytes[3] == 0xc2");
    expect(secureReadNative).toContain("bytes[4] == 0xb9 || bytes[4] == 0xb2 || bytes[4] == 0xb3");
    expect(secureReadNative).toContain("_Static_assert(sizeof(KSR_SUPERSCRIPT_ONE_UTF8) == 3");
    expect(secureReadNative).not.toContain("char name[10]");
    expect(secureReadHarness).toContain(
      "if (pausedBinary !== undefined) await assertAdversarialRaces",
    );
    expect(secureReadNative).toMatch(/#include <fcntl\.h>.*#include <io\.h>/su);
    expect(secureReadNative).toMatch(
      /_setmode\(_fileno\(stdin\), _O_BINARY\).*_setmode\(_fileno\(stdout\), _O_BINARY\)/su,
    );
    expect(secureReadNative).toMatch(/if \(!binary_standard_io\(\)\) return 1;.*parse_request\(/su);
    expect(secureReadNative).toMatch(/_write\(3, &byte, 1\).*_read\(4, &byte, 1\)/su);
    expect(secureReadNative.match(/pause_after_final_open\(\);/gu)).toHaveLength(2);
  });

  it("carries no workflow-level MSVC configuration step (the stage script owns its toolchain)", () => {
    // The rc/cl toolchain is resolved inside stage-portable-runtime.mjs (resolveWindowsMsvcEnv:
    // vswhere → vcvars64 → per-spawn env). A workflow step that persisted the full PATH through
    // GITHUB_ENV was both a zizmor misfeature finding and an injection-shaped surface, and a
    // developer machine would silently lack it — the script-owned resolution serves both.
    expect(portableWorkflow).not.toContain("Configure MSVC environment");
    expect(portableWorkflow).not.toContain("shell: cmd");
    expect(portableWorkflow).not.toContain("echo PATH=%PATH%>> %GITHUB_ENV%");
    expect(portableWorkflow).not.toContain("vcvars64.bat");
  });
});

function productionStepPolicies() {
  const job = portableWorkflow.slice(
    portableWorkflow.indexOf("  stage-windows-production:"),
    portableWorkflow.indexOf("\n  stage-macos-production:"),
  );
  const matches = [...job.matchAll(/^ {6}- name: (.+)$/gmu)];
  return matches.map((match, index) => {
    const body = job.slice(match.index, matches[index + 1]?.index ?? job.length);
    return { always: body.includes("if: ${{ always() }}"), name: match[1] };
  });
}

function workflowJob(start, end) {
  return portableWorkflow.slice(
    portableWorkflow.indexOf(start),
    end === undefined ? undefined : portableWorkflow.indexOf(end),
  );
}

function stagePortableRuntimeStep(job) {
  const name = "Stage portable runtime from approved inputs";
  const start = job.indexOf(`      - name: ${name}`);
  const end = job.indexOf("\n      - name:", start + 1);
  return job.slice(start, end === -1 ? undefined : end);
}

function simulateProviderRejection() {
  let failed = false;
  return productionStepPolicies().map((step) => {
    const ran = !failed || step.always;
    if (ran && step.name === "Sign the exact inventoried PE set") failed = true;
    return { ...step, ran };
  });
}

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

  it("defers the stable-latest asset requirement to the publisher instead of refusing here", () => {
    // RELOCATED, not relaxed. This pin used to demand a reviewed bundle as a dispatch INPUT.
    // That refused the publish job before release-publish.mjs could look at the release, and it
    // was the weaker question: a well-formed input proves nothing about whether the upload
    // landed. The invariant — a stable latest publish must be backed by reviewed portable
    // assets — now lives in release-publish.mjs, which requires all four downloads to be present
    // on the GitHub Release and, when this run did not upload them, verifies their evaluation
    // manifest and re-downloads every byte before npm learns the dist-tag. Its pins are
    // "refuses a stable latest publish whose GitHub release carries no downloads" and the
    // prepublished-evidence pins in release-publish-pipeline.test.mjs. Assets that ARE handed in
    // still pass the qualified-run binding proven by the tests below.
    expect(
      resolvePortableAssetsManifest(
        {
          NPM_DIST_TAG: "latest",
          PORTABLE_ASSETS_ARTIFACT_NAME: "",
          PORTABLE_ASSETS_MANIFEST: "portable-assets.json",
          PORTABLE_ASSETS_RUN_ID: "",
        },
        root(),
      ),
    ).toBe("portable-assets.json");
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

  it("rejects parent traversal in bundle-relative manifest input", () => {
    const cwd = root();
    writeBundleManifest(cwd);

    expect(() =>
      resolvePortableAssetsManifest(latestEnv({ PORTABLE_ASSETS_MANIFEST: "../x.json" }), cwd),
    ).toThrow("portable_assets_manifest must not escape the downloaded artifact");
  });

  it("rejects absolute manifest input for downloaded bundles", () => {
    const cwd = root();
    const manifestPath = writeBundleManifest(cwd);

    expect(() =>
      resolvePortableAssetsManifest(latestEnv({ PORTABLE_ASSETS_MANIFEST: manifestPath }), cwd),
    ).toThrow("portable_assets_manifest must be relative to the downloaded artifact");
  });

  it("rejects directory manifest input before publish", () => {
    const cwd = root();
    mkdirSync(join(cwd, ".portable-release-assets", "portable-assets.json"), { recursive: true });

    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow(
      "portable_assets_manifest must point to a regular file",
    );
  });

  it("rejects symlinked manifest input before publish", () => {
    const cwd = root();
    const bundleRoot = join(cwd, ".portable-release-assets");
    mkdirSync(bundleRoot, { recursive: true });
    const outsideManifest = join(cwd, "outside-portable-assets.json");
    writeFileSync(outsideManifest, '{"schemaVersion":1,"artifacts":[]}\n');
    symlinkSync(outsideManifest, join(bundleRoot, "portable-assets.json"));

    expect(() => resolvePortableAssetsManifest(latestEnv(), cwd)).toThrow(
      "portable_assets_manifest must not be a symbolic link",
    );
  });

  it("preserves explicit non-latest local manifest inputs", () => {
    expect(
      resolvePortableAssetsManifest(
        {
          NPM_DIST_TAG: "beta",
          PORTABLE_ASSETS_ARTIFACT_NAME: "",
          PORTABLE_ASSETS_MANIFEST: "local-portable-assets.json",
          PORTABLE_ASSETS_RUN_ID: "",
        },
        root(),
      ),
    ).toBe("local-portable-assets.json");
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

  it("accepts one nonexpired canonical artifact from the exact successful stable push", () => {
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
    [
      "duplicate artifact",
      {},
      { artifacts: [...artifacts.artifacts, { ...artifacts.artifacts[0], id: 778 }] },
      "exactly one",
    ],
  ])("rejects wrong %s metadata", (_name, runPatch, artifactValue, message) => {
    expect(() =>
      validatePortableAssetsRunSnapshot(config, { ...run, ...runPatch }, artifactValue),
    ).toThrow(message);
  });
});

/**
 * THE MACHINE-CHECKED PROOF THAT PRODUCTION WAS NOT RELAXED (ADR-0163 D9). The evaluation opt-in
 * exists only on the dispatch-only `stage` job, as two mutually exclusive steps, and the string
 * appears in NO production job slice.
 */
describe("unsigned evaluation staging opt-in", () => {
  it("exposes the opt-in as a typed, default-false workflow_dispatch input", () => {
    const input = portableWorkflowDocument.on.workflow_dispatch.inputs.evaluation_build;
    expect(input.type).toBe("boolean");
    expect(input.default).toBe(false);
    expect(input.description).toContain("UNSIGNED");
  });

  it("splits staging into two mutually exclusive steps rather than interpolating the input", () => {
    const stagingJob = workflowJob("  stage:", "\n  stage-windows-production:");
    expect(stagingJob).toContain("if: ${{ !inputs.evaluation_build }}");
    expect(stagingJob).toContain("if: ${{ inputs.evaluation_build }}");
    // zizmor's template-injection rule fires on `${{ inputs.* }}` inside a `run:` body.
    const runLines = stagingJob
      .split("\n")
      .filter((line) => line.trimStart().startsWith("run:") || line.includes("node scripts/"));
    for (const line of runLines) expect(line).not.toContain("inputs.evaluation_build");
    expect(stagingJob.match(/--evaluation\b/gu)).toHaveLength(1);
    // The downloadable bundle names itself so it cannot be mistaken for plain staging output.
    expect(stagingJob).toContain("-evaluation-unsigned");
  });

  it("keeps the evaluation opt-in out of every production job slice", () => {
    const productionSlices = [
      ["  stage-windows-production:", "\n  stage-macos-production:"],
      ["  stage-macos-production:", "\n  seal-macos-production:"],
      ["  seal-macos-production:", "\n  assemble:"],
      ["  assemble:", undefined],
    ];
    for (const [start, end] of productionSlices) {
      const slice =
        end === undefined
          ? portableWorkflow.slice(portableWorkflow.indexOf(start))
          : workflowJob(start, end);
      expect(slice).not.toContain("--evaluation");
      expect(slice).not.toContain("evaluation_build");
    }
  });
});

describe("Windows portable production signing workflow", () => {
  it("stages Windows archives through the repository ZIP adapter without 7z", () => {
    const stagingJob = workflowJob("  stage:", "\n  stage-windows-production:");
    const productionJob = workflowJob("  stage-windows-production:", "\n  stage-macos-production:");
    const stagingWindows = stagePortableRuntimeStep(stagingJob);
    const productionWindows = stagePortableRuntimeStep(productionJob);

    expect(portableWorkflow).not.toMatch(/Verify preinstalled 7z capability for staging/u);
    expect(portableWorkflow).not.toMatch(/\b7z\b/iu);
    expect(portableWorkflow).not.toMatch(/\bchoco\s+install\b/iu);
    expect(portableWorkflow).not.toMatch(/\b(?:winget|msiexec)\b/iu);

    for (const step of [stagingWindows, productionWindows]) {
      expect(step).toContain("node scripts/run-portable-assets-stage.mjs --target ");
      expect(step).not.toMatch(/\b7z\b/iu);
    }

    expect(productionJob.indexOf("Prepare approved sidecar payloads")).toBeLessThan(
      productionJob.indexOf("Stage portable runtime from approved inputs"),
    );
  });

  it("keeps manual staging outside the protected Windows production job", () => {
    expect(portableWorkflow).toContain("production-signing-preflight:");
    expect(portableWorkflow).toContain("stage-windows-production:");
    expect(portableWorkflow).toContain("environment: portable-release-signing");
    expect(portableWorkflow).toContain("github.event_name == 'push'");
    expect(portableWorkflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(portableWorkflow).toContain("Manual runs remain unsigned staging");
    expect(portableWorkflow).toContain("stage-target ${{ matrix.platform_target }}");
  });

  it("confines OIDC to the protected job and pins the official Azure actions", () => {
    const windowsJob = portableWorkflow.slice(
      portableWorkflow.indexOf("  stage-windows-production:"),
      portableWorkflow.indexOf("\n  stage-macos-production:"),
    );
    expect(portableWorkflow).toContain("permissions: {}");
    // Exactly two jobs request an OIDC token, each for a distinct, minimal, reviewed reason: the
    // Windows job for Azure Artifact Signing federation, and `assemble` for Sigstore-backed GitHub
    // Artifact Attestations (ADR-0121 D8) - never for a job that does not need one.
    expect(portableWorkflow.match(/id-token: write/gu)).toHaveLength(2);
    expect(windowsJob).toContain("id-token: write");
    expect(portableWorkflow).toContain("Azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43");
    expect(portableWorkflow).toContain(
      "Azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82",
    );
    expect(portableWorkflow).toContain("audience: api://AzureADTokenExchange");
    expect(portableWorkflow).toContain("exclude-azure-cli-credential: false");
    expect(portableWorkflow).toContain("exclude-environment-credential: true");
  });

  it("confines the attestation OIDC grant to the assemble job alone", () => {
    const assembleJob = portableWorkflow.slice(portableWorkflow.indexOf("  assemble:"));
    const betweenWindowsAndAssemble = portableWorkflow.slice(
      portableWorkflow.indexOf("\n  stage-macos-production:"),
      portableWorkflow.indexOf("  assemble:"),
    );
    expect(assembleJob).toContain("attestations: write");
    expect(assembleJob).toContain("id-token: write");
    expect(assembleJob).toContain("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6");
    expect(assembleJob).toContain("subject-path: |");
    expect(assembleJob).toContain("portable-release-assets/artifacts/*/keiko-*.zip");
    expect(assembleJob).toContain(
      "portable-release-assets/artifacts/windows-x64/keiko-windows-x64-setup.exe",
    );
    // Together with the total-count and windowsJob assertions above, this proves the two
    // `id-token: write` occurrences are exactly stage-windows-production and assemble - no job
    // in between (macOS staging/signing, Windows/macOS qualification) carries either grant.
    expect(betweenWindowsAndAssemble).not.toContain("id-token: write");
    expect(betweenWindowsAndAssemble).not.toContain("attestations: write");
  });

  it("signs the exact catalog and verifies before rebuilding and uploading", () => {
    const steps = portableWorkflowDocument.jobs["stage-windows-production"].steps;
    const stepIndex = (name) => {
      const indexes = steps.flatMap((step, index) => (step.name === name ? [index] : []));
      expect(indexes, `${name} step name must be unique`).toHaveLength(1);
      return indexes[0] ?? -1;
    };
    const inventory = stepIndex("Inventory the bounded PE signing set");
    const signing = stepIndex("Sign the exact inventoried PE set");
    const nativeVerification = stepIndex(
      "Verify the complete Authenticode chain, identity, and RFC3161 timestamp",
    );
    const finalization = stepIndex("Rebuild, bind, and verify the production archive");
    const setupBuild = stepIndex("Build the Windows setup companion");
    const setupSigning = stepIndex("Sign the Windows setup companion");
    const setupVerification = stepIndex("Verify the signed Windows setup companion");
    const setupScopeProof = stepIndex("Prove the setup companion is the only added stage PE");
    const upload = stepIndex("Upload verified Windows target artifact");
    const setupSigningStep = steps[setupSigning];
    for (const [name, index] of Object.entries({
      inventory,
      signing,
      nativeVerification,
      finalization,
      setupBuild,
      setupSigning,
      setupVerification,
      setupScopeProof,
      upload,
    })) {
      expect(index, `${name} step must exist`).toBeGreaterThan(-1);
    }
    expect(inventory).toBeLessThan(signing);
    expect(signing).toBeLessThan(nativeVerification);
    expect(nativeVerification).toBeLessThan(finalization);
    expect(finalization).toBeLessThan(setupBuild);
    expect(setupBuild).toBeLessThan(setupSigning);
    expect(setupSigning).toBeLessThan(setupVerification);
    expect(setupVerification).toBeLessThan(setupScopeProof);
    expect(setupScopeProof).toBeLessThan(upload);
    const setupScopeStep = steps[setupScopeProof];
    expect(setupScopeStep.run).toContain("windows-portable-signing.mjs verify-setup-scope");
    expect(setupScopeStep.run).toContain(
      '--expected-inventory "$env:RUNNER_TEMP\\windows-pe-verified.json"',
    );
    expect(setupSigningStep.with["files-catalog"]).toBe(
      ".portable-runtime/staging/windows-x64/windows-setup-signing-file.txt",
    );
    expect(setupSigningStep.with["file-digest"]).toBe("SHA256");
    expect(setupSigningStep.with["timestamp-digest"]).toBe("SHA256");
    const serializedSetupSigningInputs = JSON.stringify(setupSigningStep.with);
    expect(serializedSetupSigningInputs).not.toContain("windows-signing-files.txt");
    expect(serializedSetupSigningInputs).not.toContain("windows-attestation-signing-file.txt");
    const setupCleanup = stepIndex("Remove transient setup signing inventory");
    const setupCleanupStep = steps[setupCleanup];
    expect(setupCleanup).toBeGreaterThan(setupVerification);
    expect(setupCleanup).toBeLessThan(upload);
    expect(setupCleanupStep.run).toContain("Test-Path -LiteralPath $catalog -PathType Leaf");
    expect(setupCleanupStep.run).toContain(
      "Remove-Item -LiteralPath $catalog -Force -ErrorAction Stop",
    );
  });

  it("requires native chain, subscriber identity, and timestamp verification without raw output", () => {
    expect(windowsVerifier).toContain("signtool.exe verify /pa /all /tw /v");
    expect(windowsSetupVerifier).toContain("signtool.exe verify /pa /all /tw /v");
    expect(windowsVerifier).toContain("Get-AuthenticodeSignature");
    expect(windowsSetupVerifier).toContain("Get-AuthenticodeSignature");
    expect(windowsSetupVerifier).toContain(
      'GetFileName($setup) -ine "keiko-windows-x64-setup.exe"',
    );
    expect(windowsNativePolicy).toContain('"1.3.6.1.5.5.7.3.3"');
    expect(windowsNativePolicy).toContain("$ExpectedIdentityEku");
    expect(windowsVerifier).toContain("[Keiko.Portable.WindowsPortableRfc3161]::VerifyFile");
    expect(windowsSetupVerifier).toContain("[Keiko.Portable.WindowsPortableRfc3161]::VerifyFile");
    expect(readFileSync("scripts/windows-portable-rfc3161.cs", "utf8")).toContain(
      'found.EnhancedKeyUsages[0].Value == "1.3.6.1.5.5.7.3.8"',
    );
    expect(windowsVerifier).toContain("*> $null");
    expect(windowsVerifier).not.toMatch(/thumbprint|subject/iu);
    expect(windowsVerifier).toContain("peInventorySha256");
    expect(windowsVerifier).toContain("Get-DirectoryTreeSha256");
    expect(windowsVerifier).toContain("payloadSha256 = Get-DirectoryTreeSha256");
    expect(windowsVerifier).toContain("$rootEntry = Get-Item -LiteralPath $canonicalRoot -Force");
    expect(windowsVerifier).toContain("foreach ($entry in Get-ChildItem");
    expect(windowsVerifier).toContain("$entry.Attributes -band");
    expect(portableWorkflow).toContain(
      '--expected-inventory "$env:RUNNER_TEMP\\windows-pe-core-verified.json"',
    );
    expect(portableWorkflow).toContain(
      '--verification-input "$env:RUNNER_TEMP\\windows-core-verification-input.json"',
    );
  });

  it.skipIf(!hasPowerShell)(
    "cryptographically accepts RFC3161 SHA-256 fixtures and rejects legacy or malformed tokens",
    () => {
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          "scripts/__tests__/windows-rfc3161-fixtures.ps1",
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
    },
    120_000,
  );

  it("clears Azure immediately after signing and fails closed before native verification", () => {
    const signing = portableWorkflow.indexOf("Sign the exact inventoried PE set");
    const cleanup = portableWorkflow.indexOf("Clear Azure before runtime qualification");
    const verification = portableWorkflow.indexOf("Prove signing did not change the PE scope");
    expect(signing).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(verification);
    expect(portableWorkflow.slice(cleanup, verification)).toContain("if: ${{ always() }}");
    expect(portableWorkflow.slice(cleanup, verification)).toContain("az logout *> $null");
    expect(portableWorkflow.slice(cleanup, verification)).toContain("az account clear *> $null");
    expect(portableWorkflow.slice(cleanup, verification)).not.toContain("continue-on-error");
  });

  it("propagates provider rejection through the actual step conditions", () => {
    const simulation = simulateProviderRejection();
    expect(simulation.filter((step) => step.always).map((step) => step.name)).toEqual([
      "Clear Azure before runtime qualification",
      "Clear the Azure CLI signing session",
      "Clear Azure after setup companion signing",
    ]);
    expect(
      simulation.find((step) => step.name === "Clear Azure before runtime qualification")?.ran,
    ).toBe(true);
    expect(
      simulation.find((step) => step.name === "Clear the Azure CLI signing session")?.ran,
    ).toBe(true);
    for (const name of [
      "Prove signing did not change the PE scope",
      "Verify the complete Authenticode chain, identity, and RFC3161 timestamp",
      "Rebuild, bind, and verify the production archive",
      "Build the Windows setup companion",
      "Sign the Windows setup companion",
      "Verify the signed Windows setup companion",
      "Upload verified Windows target artifact",
    ]) {
      expect(simulation.find((step) => step.name === name)?.ran, name).toBe(false);
    }
  });

  it.skipIf(!hasPowerShell)(
    "executes the production native reducer against the deterministic failure matrix",
    () => {
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          "scripts/__tests__/windows-native-policy-fixtures.ps1",
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(windowsVerifier).toContain("Invoke-WindowsPortableNativePolicy");
      expect(portableWorkflow).not.toMatch(/fixture|test-mode|VerifySigntool/iu);
    },
  );
});

describe("Windows Artifact Signing protected configuration", () => {
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

  it("accepts only a canonical one-region official provider endpoint", () => {
    expect(() => validateAzureArtifactSigningConfig(config())).not.toThrow();
    for (const endpoint of [
      "http://eus.codesigning.azure.net/",
      "https://eus.codesigning.azure.net:443/",
      "https://eus.codesigning.azure.net/path",
      "https://eus.codesigning.azure.net/?query=1",
      "https://user@eus.codesigning.azure.net/",
      "https://eus.codesigning.azure.net.evil.example/",
      "https://a.b.codesigning.azure.net/",
      "https://codesigning.azure.net/",
      "https://EUS.codesigning.azure.net/",
    ]) {
      expect(() => validateAzureArtifactSigningConfig(config(endpoint)), endpoint).toThrow(
        /service endpoint is invalid/u,
      );
    }
  });

  it("fails boundedly for missing configuration and redacts arbitrary parser/filesystem errors", () => {
    const missing = config();
    delete missing.AZURE_CLIENT_ID;
    expect(() => validateAzureArtifactSigningConfig(missing)).toThrow(
      /configuration is incomplete/u,
    );
    expect(redactedWindowsSigningError(new Error("/private/path secret"))).toBe(
      "windows-portable-signing: redacted failure",
    );
  });

  it("pins portable signing preflight to the exact release workflow authority", () => {
    expect(portableReleaseAuthorityFailures(releaseWorkflow, portableWorkflow)).toEqual([]);
    // Derive the base branch from the production reader rather than restating it: a literal
    // `release/0.x` here stops matching at the next release cut, which would turn the drift
    // mutation below into a no-op and leave this pin green over a real contract drift.
    const releaseBaseBranch = envValue(releaseWorkflow, "RELEASE_BASE_BRANCH");
    expect(releaseBaseBranch).toMatch(/^release\/\d+\.\d+$/);
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

describe("macOS portable production signing workflow", () => {
  const stageMacJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  stage-macos-production:"),
    portableWorkflow.indexOf("\n  qualify-macos-runtime:"),
  );
  const runtimeQualificationJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  qualify-macos-runtime:"),
    portableWorkflow.indexOf("\n  seal-macos-production:"),
  );
  const sealMacJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  seal-macos-production:"),
    portableWorkflow.indexOf("\n  qualify-windows-production:"),
  );
  const macSigningJobs = `${stageMacJob}\n${sealMacJob}`;
  const smokeJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  qualify-macos-production:"),
    portableWorkflow.indexOf("\n  assemble:"),
  );
  const stagingJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  stage:"),
    portableWorkflow.indexOf("\n  stage-windows-production:"),
  );
  const nativeScript = readFileSync("scripts/run-macos-portable-signing.sh", "utf8");
  const architectureCheck = readFileSync("scripts/check-macos-macho-architecture.sh", "utf8");
  const payloadSmokeScript = readFileSync("scripts/run-isolated-macos-payload-smoke.sh", "utf8");
  const emptyEntitlements = readFileSync(
    "native/portable-launcher/macos-entitlements.plist",
    "utf8",
  );
  const nodeEntitlements = readFileSync(
    "native/portable-launcher/macos-node-entitlements.plist",
    "utf8",
  );

  it("uses equal protected native jobs on explicit arm64 and Intel runners", () => {
    for (const signingJob of [stageMacJob, sealMacJob]) {
      expect(signingJob).toContain("environment: portable-release-signing");
      expect(signingJob).toContain("platform_target: macos-arm64");
      expect(signingJob).toContain("runner: macos-15");
      expect(signingJob).toContain("platform_target: macos-x64");
      expect(signingJob).toContain("runner: macos-15-intel");
      expect(signingJob).not.toContain("id-token: write");
    }
  });

  it("binds the reviewed Apple team during protected macOS staging", () => {
    const stageStep = stageMacJob.slice(
      stageMacJob.indexOf("Stage portable runtime from approved inputs"),
      stageMacJob.indexOf("Functionally smoke the unsigned secure-read helper"),
    );
    expect(stageStep).toContain("APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID }}");
    expect(stagingJob).not.toContain("APPLE_TEAM_ID:");
    expect(nativeScript).toContain("MACOS_RELEASE_TEAM_IDENTIFIER");
    expect(nativeScript).toContain("__KEIKO_APPLE_TEAM_ID__");
  });

  it("keeps dispatch staging secret-free and production artifacts out of the staging job", () => {
    expect(stagingJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(stagingJob).toContain("Build unsigned Windows setup companion");
    expect(stagingJob).toContain("build-windows-portable-setup.mjs --stage-root");
    expect(stagingJob).not.toContain("secrets.");
    expect(stagingJob).not.toContain("environment: portable-release-signing");
  });

  it("assembles only a complete stable production set and never a dispatch set", () => {
    const assemble = portableWorkflow.slice(portableWorkflow.indexOf("  assemble:"));
    expect(assemble).not.toContain("github.event_name == 'workflow_dispatch'");
    expect(assemble).toContain("github.event_name == 'push'");
    expect(assemble).toContain("!contains(github.ref_name, '-')");
    expect(assemble).toContain("needs.stage-windows-production.result == 'success'");
    expect(assemble).toContain("needs.stage-macos-production.result == 'success'");
    expect(assemble).toContain("needs.qualify-macos-runtime.result == 'success'");
    expect(assemble).toContain("needs.seal-macos-production.result == 'success'");
    expect(assemble).toContain("needs.qualify-windows-production.result == 'success'");
    expect(assemble).toContain("needs.qualify-macos-production.result == 'success'");
    expect(assemble).not.toMatch(/result == 'success' \|\| needs\.[^.]+\.result == 'skipped'/u);
  });

  it("freshly re-verifies the signed Windows setup companion before payload execution", () => {
    const qualification = portableWorkflow.slice(
      portableWorkflow.indexOf("  qualify-windows-production:"),
      portableWorkflow.indexOf("\n  qualify-macos-production:"),
    );
    const archiveVerification = qualification.indexOf("Re-verify final Authenticode bytes");
    const setupVerification = qualification.indexOf("Re-verify signed Windows setup companion");
    const payloadSmoke = qualification.indexOf(
      "Execute terminal payload smoke without credential or file-command authority",
    );
    expect(archiveVerification).toBeLessThan(setupVerification);
    expect(setupVerification).toBeLessThan(payloadSmoke);
    expect(qualification).toContain("verify-windows-portable-setup-signing.ps1");
    expect(qualification).toContain("build-windows-portable-setup.mjs");
    expect(qualification).toContain("--verify-only");
  });

  it("runs only static verification, cleanup, finalization, and upload in the protected job", () => {
    const provisionalSigning = stageMacJob.indexOf(
      "Sign, notarize, staple, and verify the provisional native artifact",
    );
    const provisionalCleanup = stageMacJob.indexOf("Remove temporary Apple signing material");
    const provisionalUpload = stageMacJob.indexOf("Upload provisional macOS target artifact");
    expect(provisionalSigning).toBeLessThan(provisionalCleanup);
    expect(provisionalCleanup).toBeLessThan(provisionalUpload);

    const signing = sealMacJob.indexOf(
      "Seal, notarize, staple, and verify the qualified native artifact",
    );
    const cleanup = sealMacJob.indexOf("Remove temporary Apple signing material");
    const verificationInput = sealMacJob.indexOf(
      "Derive bounded verification input after credential cleanup",
    );
    const finalize = sealMacJob.indexOf("Bind and verify the production macOS archive");
    const upload = sealMacJob.indexOf("Upload verified macOS target artifact");
    expect(signing).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(verificationInput);
    expect(verificationInput).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(upload);
    expect(sealMacJob.slice(cleanup, verificationInput)).toContain("if: ${{ always() }}");
    expect(sealMacJob.slice(cleanup, verificationInput)).not.toContain("continue-on-error");
    expect(nativeScript).not.toMatch(/codesign\s+--force[^\n]*--deep/u);
    expect(nativeScript).toContain("codesign --verify --deep --strict");
    expect(nativeScript).toContain("xcrun notarytool submit");
    expect(nativeScript).toContain("xcrun stapler validate");
    expect(nativeScript).toContain("spctl -a -t exec");
    expect(nativeScript).toContain("scripts/check-macos-macho-architecture.sh");
    expect(architectureCheck).toContain('lipo -archs "$1" 2>/dev/null');
    expect(nativeScript).toContain('verify_signed_path "$payload/$relative" "$role"');
    expect(nativeScript).toContain('verify_signed_path "$app" host-app');
    expect(nativeScript).toContain('[[ "$phase" == "provisional" ]]');
    expect(nativeScript).toContain("validate-runtime-qualification");
    expect(nativeScript).not.toContain("qualify-macos-runtime-release");
    expect(nativeScript).not.toContain("new Function");
    expect(nativeScript).not.toContain("--version");
    expect(macSigningJobs).not.toContain("smoke:portable-launch-setup");
    expect(macSigningJobs).not.toContain("run-isolated-macos-payload-smoke.sh");
    expect(macSigningJobs).not.toContain("qualify-macos-runtime-release");
  });

  it("uses an empty default entitlement set and Node-only allow-jit", () => {
    expect(emptyEntitlements).toContain("<dict/>");
    expect(emptyEntitlements).not.toContain("com.apple.security");
    expect(nodeEntitlements).toContain("com.apple.security.cs.allow-jit");
    expect(nodeEntitlements).not.toContain("get-task-allow");
    expect(nodeEntitlements).not.toContain("allow-unsigned-executable-memory");
    expect(nodeEntitlements.match(/<key>/gu)).toHaveLength(1);
  });

  it("isolates payload execution in a terminal unprivileged immutable-artifact job", () => {
    expect(macSigningJobs).not.toMatch(
      /KEIKO_NATIVE_(?:DEVELOPER|NOTARIZATION|STAPLE|ASSESSMENT)/u,
    );
    expect(runtimeQualificationJob).toContain(
      'runs-on: [self-hosted, macOS, "${{ matrix.runner_arch }}", keiko-endpoint-security]',
    );
    expect(runtimeQualificationJob).not.toMatch(
      /environment: portable-release-signing|secrets\.|id-token: write/u,
    );
    expect(runtimeQualificationJob).toContain(
      "Prove the qualification runner has no signing credential authority",
    );
    expect(runtimeQualificationJob).toContain("macos-runtime-qualification-transport.mjs snapshot");
    expect(runtimeQualificationJob).toContain("/Applications/KeikoQualification-");
    expect(runtimeQualificationJob).toContain(
      '/usr/bin/find /Applications -maxdepth 1 -type d -name "KeikoQualification-',
    );
    expect(runtimeQualificationJob).toContain("qualify-macos-runtime-release.mjs");
    expect(runtimeQualificationJob).toContain("Prove qualification added only the bounded receipt");
    expect(runtimeQualificationJob).toContain("Upload qualified macOS target artifact");

    expect(smokeJob).toContain("needs: seal-macos-production");
    expect(smokeJob).toContain("platform_target: macos-arm64");
    expect(smokeJob).toContain("runner_arch: ARM64");
    expect(smokeJob).toContain("platform_target: macos-x64");
    expect(smokeJob).toContain("runner_arch: X64");
    expect(smokeJob).toContain("persist-credentials: false");
    expect(smokeJob).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(smokeJob).toContain("environment: portable-release-signing");
    expect(smokeJob).not.toMatch(/secrets\.|id-token: write|upload-artifact/u);
    expect(smokeJob).toContain("Download immutable verified macOS artifact");
    expect(smokeJob).toContain(
      '/usr/bin/find /Applications -maxdepth 1 -type d -name "KeikoQualification-final-',
    );
    const execute = smokeJob.indexOf("Execute bundled runtimes in isolated disposable copy");
    expect(execute).toBeGreaterThan(0);
    expect(smokeJob.slice(execute)).not.toMatch(/\n\s+- name:|\n\s+- uses:/u);
    expect(payloadSmokeScript).toContain("new Function");
    expect(payloadSmokeScript).toContain("--version");
    expect(payloadSmokeScript).toContain("APPLE_DEVELOPER_ID_CERT_P12_BASE64");
    expect(payloadSmokeScript).toContain('unset "$name"');
    expect(payloadSmokeScript).toContain("unset GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT");
    expect(payloadSmokeScript).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(payloadSmokeScript).toContain("ACTIONS_RUNTIME_TOKEN");
    expect(payloadSmokeScript).toContain("trap 'rm -rf");
    expect(portableWorkflow).not.toMatch(/test-mode|fake-provider|native-bypass/iu);
  });

  it("blocks protected upload on native failures and assembly on isolated smoke failure", () => {
    const steps = [
      { always: false, name: "Prepare temporary Developer ID and notary credentials" },
      {
        always: false,
        name: "Seal, notarize, staple, and verify the qualified native artifact",
      },
      { always: true, name: "Remove temporary Apple signing material" },
      { always: false, name: "Derive bounded verification input after credential cleanup" },
      { always: false, name: "Bind and verify the production macOS archive" },
      { always: false, name: "Upload verified macOS target artifact" },
    ];
    const simulate = (failure) => {
      let failed = false;
      return steps.map((step) => {
        const ran = step.always || !failed;
        if (ran && step.name === failure) failed = true;
        return { ...step, ran };
      });
    };
    for (const failure of [
      "Prepare temporary Developer ID and notary credentials",
      "Seal, notarize, staple, and verify the qualified native artifact",
      "Remove temporary Apple signing material",
    ]) {
      const simulation = simulate(failure);
      expect(
        simulation.find((step) => step.name === "Remove temporary Apple signing material")?.ran,
      ).toBe(true);
      for (const name of [
        "Derive bounded verification input after credential cleanup",
        "Bind and verify the production macOS archive",
        "Upload verified macOS target artifact",
      ]) {
        expect(simulation.find((step) => step.name === name)?.ran, `${failure}:${name}`).toBe(
          false,
        );
      }
    }
    const finalizerFailure = simulate("Bind and verify the production macOS archive");
    expect(
      finalizerFailure.find((step) => step.name === "Upload verified macOS target artifact")?.ran,
    ).toBe(false);
    expect(smokeJob).toContain("needs.seal-macos-production.result == 'success'");
    const assemble = portableWorkflow.slice(portableWorkflow.indexOf("  assemble:"));
    expect(assemble).toContain("needs.qualify-macos-runtime.result == 'success'");
    expect(assemble).toContain("needs.seal-macos-production.result == 'success'");
    expect(assemble).toContain("needs.qualify-macos-production.result == 'success'");
  });

  it("accepts only complete stable states and rejects dispatch, prerelease, or qualification failure", () => {
    const assembles = ({ dispatch, prerelease, smoke }) =>
      !dispatch && !prerelease && smoke === "success";
    expect(assembles({ dispatch: true, prerelease: false, smoke: "skipped" })).toBe(false);
    expect(assembles({ dispatch: false, prerelease: false, smoke: "success" })).toBe(true);
    expect(assembles({ dispatch: false, prerelease: true, smoke: "skipped" })).toBe(false);
    expect(assembles({ dispatch: false, prerelease: false, smoke: "failure" })).toBe(false);
  });
});
