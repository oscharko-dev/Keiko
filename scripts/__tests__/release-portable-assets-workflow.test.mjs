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

import {
  resolvePortableAssetsManifest,
  writeGithubOutput,
} from "../resolve-release-portable-assets.mjs";
import { portableReleaseAuthorityFailures } from "../check-release-required-workflow-names.mjs";
import {
  redactedWindowsSigningError,
  validateAzureArtifactSigningConfig,
} from "../windows-portable-signing.mjs";

const portableWorkflow = readFileSync(".github/workflows/portable-assets.yml", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const windowsVerifier = readFileSync("scripts/verify-windows-portable-signing.ps1", "utf8");
const windowsNativePolicy = readFileSync("scripts/windows-portable-native-policy.ps1", "utf8");

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

  it("requires a reviewed artifact bundle for stable latest publishes", () => {
    expect(() =>
      resolvePortableAssetsManifest(
        {
          NPM_DIST_TAG: "latest",
          PORTABLE_ASSETS_ARTIFACT_NAME: "",
          PORTABLE_ASSETS_MANIFEST: "portable-assets.json",
          PORTABLE_ASSETS_RUN_ID: "",
        },
        root(),
      ),
    ).toThrow("stable latest publishes require a reviewed portable asset bundle");
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

describe("Windows portable production signing workflow", () => {
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
    expect(portableWorkflow).toContain("permissions: {}");
    expect(portableWorkflow.match(/id-token: write/gu)).toHaveLength(1);
    expect(portableWorkflow).toContain("Azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43");
    expect(portableWorkflow).toContain(
      "Azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82",
    );
    expect(portableWorkflow).toContain("audience: api://AzureADTokenExchange");
    expect(portableWorkflow).toContain("exclude-azure-cli-credential: false");
    expect(portableWorkflow).toContain("exclude-environment-credential: true");
  });

  it("signs the exact catalog and verifies before rebuilding and uploading", () => {
    const inventory = portableWorkflow.indexOf("Inventory the bounded PE signing set");
    const signing = portableWorkflow.indexOf("Sign the exact inventoried PE set");
    const nativeVerification = portableWorkflow.indexOf(
      "Verify Authenticode chain, identity, and RFC3161 timestamp",
    );
    const finalization = portableWorkflow.indexOf(
      "Rebuild, bind, and verify the production archive",
    );
    const upload = portableWorkflow.indexOf("Upload verified Windows target artifact");
    expect(inventory).toBeLessThan(signing);
    expect(signing).toBeLessThan(nativeVerification);
    expect(nativeVerification).toBeLessThan(finalization);
    expect(finalization).toBeLessThan(upload);
    expect(portableWorkflow).toContain("files-catalog:");
    expect(portableWorkflow).toContain("file-digest: SHA256");
    expect(portableWorkflow).toContain("timestamp-digest: SHA256");
  });

  it("requires native chain, subscriber identity, and timestamp verification without raw output", () => {
    expect(windowsVerifier).toContain("signtool.exe verify /pa /all /tw /v");
    expect(windowsVerifier).toContain("Get-AuthenticodeSignature");
    expect(windowsNativePolicy).toContain('"1.3.6.1.5.5.7.3.3"');
    expect(windowsNativePolicy).toContain("$ExpectedIdentityEku");
    expect(windowsVerifier).toContain("[WindowsPortableRfc3161]::VerifyFile");
    expect(readFileSync("scripts/windows-portable-rfc3161.cs", "utf8")).toContain(
      'found.EnhancedKeyUsages[0].Value == "1.3.6.1.5.5.7.3.8"',
    );
    expect(windowsVerifier).toContain("*> $null");
    expect(windowsVerifier).not.toMatch(/thumbprint|subject/iu);
  });

  it("cryptographically accepts RFC3161 SHA-256 fixtures and rejects legacy or malformed tokens", () => {
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", "scripts/__tests__/windows-rfc3161-fixtures.ps1"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("clears Azure immediately after signing and fails closed before native verification", () => {
    const signing = portableWorkflow.indexOf("Sign the exact inventoried PE set");
    const cleanup = portableWorkflow.indexOf("Clear the Azure CLI signing session");
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
      "Clear the Azure CLI signing session",
    ]);
    expect(
      simulation.find((step) => step.name === "Clear the Azure CLI signing session")?.ran,
    ).toBe(true);
    for (const name of [
      "Prove signing did not change the PE scope",
      "Verify Authenticode chain, identity, and RFC3161 timestamp",
      "Rebuild, bind, and verify the production archive",
      "Upload verified Windows target artifact",
    ]) {
      expect(simulation.find((step) => step.name === name)?.ran, name).toBe(false);
    }
  });

  it("executes the production native reducer against the deterministic failure matrix", () => {
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
  });
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
    expect(
      portableReleaseAuthorityFailures(
        releaseWorkflow,
        portableWorkflow.replace("release/0.2", "release/drift"),
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
  const macJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  stage-macos-production:"),
    portableWorkflow.indexOf("\n  smoke-macos-production:"),
  );
  const smokeJob = portableWorkflow.slice(
    portableWorkflow.indexOf("  smoke-macos-production:"),
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
    expect(macJob).toContain("environment: portable-release-signing");
    expect(macJob).toContain("platform_target: macos-arm64");
    expect(macJob).toContain("runner: macos-15");
    expect(macJob).toContain("platform_target: macos-x64");
    expect(macJob).toContain("runner: macos-15-intel");
    expect(macJob).not.toContain("id-token: write");
  });

  it("keeps dispatch staging secret-free and production artifacts out of the staging job", () => {
    expect(stagingJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(stagingJob).not.toContain("secrets.");
    expect(stagingJob).not.toContain("environment: portable-release-signing");
  });

  it("assembles only a complete dispatch set or a complete stable production set", () => {
    const assemble = portableWorkflow.slice(portableWorkflow.indexOf("  assemble:"));
    expect(assemble).toContain("github.event_name == 'workflow_dispatch'");
    expect(assemble).toContain("needs.stage.result == 'success'");
    expect(assemble).toContain("needs.stage-macos-production.result == 'skipped'");
    expect(assemble).toContain("needs.smoke-macos-production.result == 'skipped'");
    expect(assemble).toContain("github.event_name == 'push'");
    expect(assemble).toContain("!contains(github.ref_name, '-')");
    expect(assemble).toContain("needs.stage.result == 'skipped'");
    expect(assemble).toContain("needs.stage-macos-production.result == 'success'");
    expect(assemble).toContain("needs.smoke-macos-production.result == 'success'");
    expect(assemble).not.toMatch(/result == 'success' \|\| needs\.[^.]+\.result == 'skipped'/u);
  });

  it("runs only static verification, cleanup, finalization, and upload in the protected job", () => {
    const signing = macJob.indexOf("Sign, notarize, staple, and verify the native artifact");
    const cleanup = macJob.indexOf("Remove temporary Apple signing material");
    const verificationInput = macJob.indexOf(
      "Derive bounded verification input after credential cleanup",
    );
    const finalize = macJob.indexOf("Bind and verify the production macOS archive");
    const upload = macJob.indexOf("Upload verified macOS target artifact");
    expect(signing).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(verificationInput);
    expect(verificationInput).toBeLessThan(finalize);
    expect(finalize).toBeLessThan(upload);
    expect(macJob.slice(cleanup, verificationInput)).toContain("if: ${{ always() }}");
    expect(macJob.slice(cleanup, verificationInput)).not.toContain("continue-on-error");
    expect(nativeScript).not.toMatch(/codesign\s+--force[^\n]*--deep/u);
    expect(nativeScript).toContain("codesign --verify --deep --strict");
    expect(nativeScript).toContain("xcrun notarytool submit");
    expect(nativeScript).toContain("xcrun stapler validate");
    expect(nativeScript).toContain("spctl -a -t exec");
    expect(nativeScript).toContain("scripts/check-macos-macho-architecture.sh");
    expect(architectureCheck).toContain('lipo -archs "$1" 2>/dev/null');
    expect(nativeScript).toContain('verify_signed_path "$payload/$relative" default');
    expect(nativeScript).toContain('verify_signed_path "$app" default');
    expect(nativeScript).not.toContain("new Function");
    expect(nativeScript).not.toContain("--version");
    expect(macJob).not.toContain("smoke:portable-launch-setup");
    expect(macJob).not.toContain("run-isolated-macos-payload-smoke.sh");
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
    expect(macJob).not.toMatch(/KEIKO_NATIVE_(?:DEVELOPER|NOTARIZATION|STAPLE|ASSESSMENT)/u);
    expect(smokeJob).toContain("needs: stage-macos-production");
    expect(smokeJob).toContain("platform_target: macos-arm64");
    expect(smokeJob).toContain("runner: macos-15");
    expect(smokeJob).toContain("platform_target: macos-x64");
    expect(smokeJob).toContain("runner: macos-15-intel");
    expect(smokeJob).toContain("persist-credentials: false");
    expect(smokeJob).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(smokeJob).not.toMatch(/environment:|secrets\.|id-token: write|upload-artifact/u);
    expect(smokeJob).toContain("Download immutable verified macOS artifact");
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
      { always: false, name: "Sign, notarize, staple, and verify the native artifact" },
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
      "Sign, notarize, staple, and verify the native artifact",
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
    expect(smokeJob).toContain("needs.stage-macos-production.result == 'success'");
    expect(portableWorkflow.slice(portableWorkflow.indexOf("  assemble:"))).toContain(
      "needs.smoke-macos-production.result == 'success'",
    );
  });

  it("accepts only complete dispatch or stable states and rejects prerelease or smoke failure", () => {
    const assembles = ({ dispatch, prerelease, smoke }) =>
      dispatch ? smoke === "skipped" : !prerelease && smoke === "success";
    expect(assembles({ dispatch: true, prerelease: false, smoke: "skipped" })).toBe(true);
    expect(assembles({ dispatch: false, prerelease: false, smoke: "success" })).toBe(true);
    expect(assembles({ dispatch: false, prerelease: true, smoke: "skipped" })).toBe(false);
    expect(assembles({ dispatch: false, prerelease: false, smoke: "failure" })).toBe(false);
  });
});
import { spawnSync } from "node:child_process";
